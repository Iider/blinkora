import { router, authProcedure, publicProcedure } from '../middleware';
import { z } from 'zod';
import { prisma } from '../prisma';
import { GlobalConfig, ZConfigKey, ZConfigSchema, ZUserPerferConfigKey } from '../../shared/lib/types';
import { configSchema } from '@shared/lib/prismaZodType';
import { Context } from '../context';
import { formatS3ValidationError, normalizeS3CustomPath, validateS3StorageConfig } from '../lib/s3Storage';

const S3StorageConfigInput = z.object({
  s3Endpoint: z.string().trim(),
  s3AccessKeyId: z.string().trim(),
  s3AccessKeySecret: z.string().trim(),
  s3Bucket: z.string().trim(),
  s3Region: z.string().trim(),
  s3CustomPath: z.string().trim().optional().default(''),
});

const upsertGlobalConfigValue = async (key: string, value: unknown) => {
  const matchedConfigs = await prisma.config.findMany({ where: { key } });

  if (matchedConfigs.length > 0) {
    const configToKeep = matchedConfigs[0];
    const updateResult = await prisma.config.update({
      where: { id: configToKeep?.id },
      data: { config: { type: typeof value, value } }
    });

    if (matchedConfigs.length > 1) {
      await prisma.config.deleteMany({
        where: {
          key,
          id: { notIn: [configToKeep!.id!] }
        }
      });
    }

    return updateResult;
  }

  return await prisma.config.create({ data: { key, config: { type: typeof value, value } } });
};

const saveS3StorageConfig = async (input: z.infer<typeof S3StorageConfigInput>, objectStorage: 's3' | 'local', forcePathStyle?: boolean) => {
  const normalizedCustomPath = normalizeS3CustomPath(input.s3CustomPath);
  const values = {
    objectStorage,
    s3Endpoint: input.s3Endpoint,
    s3AccessKeyId: input.s3AccessKeyId,
    s3AccessKeySecret: input.s3AccessKeySecret,
    s3Bucket: input.s3Bucket,
    s3Region: input.s3Region,
    s3CustomPath: normalizedCustomPath,
    ...(typeof forcePathStyle === 'boolean' ? { s3ForcePathStyle: forcePathStyle } : {}),
  };

  for (const [key, value] of Object.entries(values)) {
    await upsertGlobalConfigValue(key, value);
  }

  return normalizedCustomPath;
};

export const getGlobalConfig = async ({ ctx, useAdmin = false }: { ctx?: Context, useAdmin?: boolean }) => {
  const userId = Number(ctx?.id ?? 0);
  const workspaceId = Number(ctx?.workspaceId ?? 0);
  const isSuperAdmin = useAdmin ? true : ctx?.role === 'superadmin';

  const configs = await prisma.config.findMany({
    where: {
      OR: [
        { userId: null },
        ...(userId ? [{ userId, workspaceId }] : [])
      ]
    }
  });

  const globalConfig = configs.reduce((acc, item) => {
    const config = item.config as { type: string, value: any };
    //If not login return the frist config
    if (
      item.key == 'isCloseBackgroundAnimation'
      || item.key == 'language'
      || item.key == 'theme'
      || item.key == 'themeColor'
      || item.key == 'themeForegroundColor'
      || item.key == 'fontStyle'
      || item.key == 'maxHomePageWidth'
      || item.key == 'customBackgroundUrl'
      || item.key == 'hidePcEditor'
      || item.key == 'signinFooterEnabled'
      || item.key == 'signinFooterText'
      || item.key == 'customTitle'
    ) {
      //if user not login, then use frist find config
      if (!userId) {
        acc[item.key] = config.value;
        return acc;
      }
    }
    if (!isSuperAdmin && !item.userId) {
      return acc;
    }
    const isUserPreferConfig = ZUserPerferConfigKey.safeParse(item.key).success;
    if (isUserPreferConfig) {
      if (item.userId === userId && item.workspaceId === workspaceId) {
        acc[item.key] = config.value;
      }
    } else {
      acc[item.key] = config.value;
    }
    return acc;
  }, {} as Record<string, any>);

  return globalConfig as GlobalConfig;
};

export const getAiModelConfig = async (type: 'embeddingModel', ctx?: Context) => {
  // Map type to config key
  const configKey = `${type}Id`;

  // Get global config to find the model ID
  const globalConfig = await getGlobalConfig({ ctx });
  const modelId = globalConfig[configKey];

  if (!modelId) {
    return null;
  }

  // Get the model with provider information directly from prisma
  const model = await prisma.aiModels.findUnique({
    where: { id: modelId },
    include: { provider: true }
  });

  if (!model) {
    return null;
  }

  return {
    title: model.title,
    modelKey: model.modelKey,
    capabilities: model.capabilities,
    provider: {
      id: model.provider.id,
      title: model.provider.title,
      provider: model.provider.provider,
      baseURL: model.provider.baseURL,
      apiKey: model.provider.apiKey
    }
  };
};

export const configRouter = router({
  list: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/config/list', summary: 'Query user config list', protect: true, tags: ['Config'] } })
    .input(z.void())
    .output(ZConfigSchema)
    .query(async function ({ ctx }) {
      return await getGlobalConfig({ ctx })
    }),
  update: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/config/update', summary: 'Update user config', protect: true, tags: ['Config'] } })
    .input(z.object({
      key: ZConfigKey,
      value: z.any()
    }))
    .output(configSchema)
    .mutation(async function ({ input, ctx }) {
      const userId = Number(ctx.id)
      const { key, value } = input
      const isUserPreferConfig = ZUserPerferConfigKey.safeParse(key).success;
      let updateResult;
      
      if (isUserPreferConfig) {
        const workspaceId = Number(ctx.workspaceId);
        const matchedConfigs = await prisma.config.findMany({ where: { userId, key, workspaceId } });

        if (matchedConfigs.length > 0) {
          const configToKeep = matchedConfigs[0];
          updateResult = await prisma.config.update({
            where: { id: configToKeep?.id },
            data: { config: { type: typeof value, value } }
          });

          if (matchedConfigs.length > 1) {
            await prisma.config.deleteMany({
              where: {
                userId,
                key,
                workspaceId,
                id: { notIn: [configToKeep!.id!] }
              }
            });
          }
        } else {
          updateResult = await prisma.config.create({ data: { userId, key, workspaceId, config: { type: typeof value, value } } });
        }
      } else {
        if (ctx.role !== 'superadmin') {
          throw new Error('You are not allowed to update global config')
        }
        const matchedConfigs = await prisma.config.findMany({ where: { key } });
        
        if (matchedConfigs.length > 0) {
          const configToKeep = matchedConfigs[0];
          updateResult = await prisma.config.update({ 
            where: { id: configToKeep?.id }, 
            data: { config: { type: typeof value, value } } 
          });
          
          if (matchedConfigs.length > 1) {
            await prisma.config.deleteMany({
              where: {
                key,
                id: { notIn: [configToKeep!.id!] }
              }
            });
          }
        } else {
          updateResult = await prisma.config.create({ data: { key, config: { type: typeof value, value } } });
        }
      }

      return updateResult;
    }),

  saveAndValidateS3: authProcedure
    .input(S3StorageConfigInput)
    .output(z.object({
      ok: z.boolean(),
      objectStorage: z.enum(['s3', 'local']),
      message: z.string().optional(),
      normalizedCustomPath: z.string(),
      validationKey: z.string().optional(),
      forcePathStyle: z.boolean().optional(),
    }))
    .mutation(async function ({ input, ctx }) {
      if (ctx.role !== 'superadmin') {
        throw new Error('You are not allowed to update global config')
      }

      try {
        const validationResult = await validateS3StorageConfig(input);
        const normalizedCustomPath = await saveS3StorageConfig(input, 's3', validationResult.forcePathStyle);

        return {
          ok: true,
          objectStorage: 's3' as const,
          normalizedCustomPath,
          validationKey: validationResult.validationKey,
          forcePathStyle: validationResult.forcePathStyle,
        };
      } catch (error) {
        console.error('S3 validation failed:', formatS3ValidationError(error));
        try {
          const normalizedCustomPath = await saveS3StorageConfig(input, 'local');

          return {
            ok: false,
            objectStorage: 'local' as const,
            normalizedCustomPath,
            message: formatS3ValidationError(error),
          };
        } catch (saveError) {
          await upsertGlobalConfigValue('objectStorage', 'local');

          return {
            ok: false,
            objectStorage: 'local' as const,
            normalizedCustomPath: '',
            message: formatS3ValidationError(saveError),
          };
        }
      }
    }),

  ai: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/config/ai', summary: 'Get AI model configuration by type', protect: true, tags: ['Config'] } })
    .input(z.object({
      type: z.enum(['embeddingModel'])
    }))
    .output(z.object({
      title: z.string(),
      modelKey: z.string(),
      capabilities: z.any(),
      provider: z.object({
        id: z.number(),
        title: z.string(),
        provider: z.string(),
        baseURL: z.string().nullable(),
        apiKey: z.string().nullable()
      })
    }).nullable())
    .query(async function ({ input, ctx }) {
      const { type } = input;

      const model = await getAiModelConfig(type, ctx);
      return model;
    })
})
