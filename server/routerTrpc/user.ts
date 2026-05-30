import { router, publicProcedure, authProcedure, demoAuthMiddleware } from '../middleware';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { prisma } from '../prisma';
import { Prisma } from '@prisma/client';
import { hashPassword, verifyPassword } from '@prisma/seed';
import { generateTOTP, generateTOTPQRCode, verifyTOTP, generateApiToken } from '@server/lib/helper';
import { createSeed } from '@prisma/seedData';

export const userRouter = router({
  detail: authProcedure
    .meta({
      openapi: {
        method: 'GET', path: '/v1/user/detail', summary: 'Find current user detail',
        description: 'Find current local user detail, need login.', tags: ['User']
      }
    })
    .input(z.object({ id: z.number().optional() }))
    .output(z.object({
      id: z.number(),
      name: z.string(),
      nickName: z.string(),
      token: z.string(),
      image: z.string().nullable(),
      role: z.string()
    }))
    .query(async ({ ctx }) => {
      const user = await prisma.accounts.findFirst({ where: { id: Number(ctx.id) } });

      if (!user) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      return {
        id: user.id,
        name: user.name ?? '',
        nickName: user.nickname ?? '',
        token: user.apiToken ?? '',
        image: user.image ?? null,
        role: user.role ?? ''
      };
    }),

  canRegister: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/user/can-register', summary: 'Check if first local account can be created', tags: ['User'] } })
    .input(z.void())
    .output(z.boolean())
    .mutation(async () => {
      return (await prisma.accounts.count()) === 0;
    }),

  register: publicProcedure
    .meta({
      openapi: {
        method: 'POST', path: '/v1/user/register', summary: 'Register first local user',
        description: 'Register the first and only local user account.', tags: ['User']
      }
    })
    .input(z.object({
      name: z.string(),
      password: z.string()
    }))
    .output(z.union([z.boolean(), z.any()]))
    .mutation(async ({ input }) => {
      return prisma.$transaction(async () => {
        const count = await prisma.accounts.count();
        if (count > 0) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Registration is closed for single-account mode' });
        }

        const { name, password } = input;
        const passwordHash = await hashPassword(password);
        const user = await prisma.accounts.create({
          data: {
            name,
            password: passwordHash,
            nickname: name,
            role: 'superadmin'
          }
        });

        await prisma.accounts.update({
          where: { id: user.id },
          data: {
            apiToken: await generateApiToken({ id: user.id, name, role: 'superadmin' })
          }
        });

        const defaultWorkspace = await prisma.workspaces.create({
          data: {
            name: '默认工作区',
            accountId: user.id,
            isDefault: true
          }
        });

        await prisma.config.create({
          data: {
            key: 'theme',
            config: { value: 'system' },
            userId: user.id,
            workspaceId: defaultWorkspace.id
          }
        });

        await prisma.config.create({
          data: {
            key: 'language',
            config: { type: 'string', value: 'zh' },
            userId: user.id,
            workspaceId: defaultWorkspace.id
          }
        });

        await createSeed(user.id, defaultWorkspace.id);
        return true;
      });
    }),

  regenToken: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/user/regen-token', summary: 'Regenerate API token', tags: ['User'] } })
    .input(z.void())
    .output(z.boolean())
    .mutation(async ({ ctx }) => {
      const user = await prisma.accounts.findFirst({ where: { id: Number(ctx.id) } });
      if (!user) return false;

      const token = await generateApiToken({ id: user.id, name: user.name ?? '', role: user.role });
      await prisma.accounts.update({ where: { id: user.id }, data: { apiToken: token } });
      return true;
    }),

  upsertUser: authProcedure.use(demoAuthMiddleware)
    .meta({
      openapi: {
        method: 'POST', path: '/v1/user/upsert', summary: 'Update current user',
        description: 'Update current local account profile or password.', tags: ['User']
      }
    })
    .input(z.object({
      id: z.number().optional(),
      name: z.string().optional(),
      originalPassword: z.string().optional(),
      password: z.string().optional(),
      nickname: z.string().optional(),
      image: z.string().optional()
    }))
    .output(z.union([z.boolean(), z.any()]))
    .mutation(async ({ input, ctx }) => {
      return prisma.$transaction(async () => {
        const currentUserId = Number(ctx.id);
        const targetId = input.id ?? currentUserId;

        if (targetId !== currentUserId) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'You can only update your own account' });
        }

        const user = await prisma.accounts.findFirst({ where: { id: currentUserId } });
        if (!user) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
        }

        const update: Prisma.accountsUpdateInput = {};

        if (input.password) {
          if (!input.originalPassword) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'Original password is required when changing password' });
          }
          if (!(await verifyPassword(input.originalPassword, user.password ?? ''))) {
            throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Original password is incorrect' });
          }
          update.password = await hashPassword(input.password);
        }

        if (input.name && input.name !== user.name) {
          const hasSameUser = await prisma.accounts.findFirst({ where: { name: input.name } });
          if (hasSameUser) {
            throw new TRPCError({ code: 'CONFLICT', message: 'Username already exists' });
          }
          update.name = input.name;
        }
        if (input.nickname) update.nickname = input.nickname;
        if (input.image) update.image = input.image;

        await prisma.accounts.update({ where: { id: currentUserId }, data: update });
        return true;
      });
    }),

  generate2FASecret: authProcedure.use(demoAuthMiddleware)
    .input(z.object({ name: z.string() }))
    .mutation(async ({ input }) => {
      const secret = generateTOTP();
      const qrCode = generateTOTPQRCode(input.name, secret);
      return { secret, qrCode };
    }),

  verify2FAToken: authProcedure.use(demoAuthMiddleware)
    .input(z.object({ token: z.string(), secret: z.string() }))
    .mutation(async ({ input }) => {
      const isValid = verifyTOTP(input.token, input.secret);
      if (!isValid) {
        throw new Error('Invalid verification code');
      }
      return true;
    }),

  login: publicProcedure
    .meta({
      openapi: {
        method: 'POST', path: '/v1/user/login', summary: 'User login',
        description: 'Local user login, return user basic info and token', tags: ['User']
      }
    })
    .input(z.object({
      name: z.string(),
      password: z.string()
    }))
    .output(z.object({
      id: z.number(),
      name: z.string(),
      nickname: z.string(),
      role: z.string(),
      token: z.string(),
      image: z.string().nullable()
    }))
    .mutation(async ({ input }) => {
      const user = await prisma.accounts.findFirst({ where: { name: input.name } });
      if (!user) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'user not found' });
      }

      const isPasswordValid = await verifyPassword(input.password, user.password ?? '');
      if (!isPasswordValid) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'password is incorrect' });
      }

      const token = await generateApiToken({ id: user.id, name: user.name ?? '', role: user.role });
      await prisma.accounts.update({ where: { id: user.id }, data: { apiToken: token } });

      return {
        id: user.id,
        name: user.name ?? '',
        nickname: user.nickname ?? '',
        role: user.role,
        token,
        image: user.image
      };
    }),
});
