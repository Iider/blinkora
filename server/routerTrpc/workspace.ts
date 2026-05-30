import { router, authProcedure, demoAuthMiddleware } from '../middleware';
import { z } from 'zod';
import { prisma } from '../prisma';
import { TRPCError } from '@trpc/server';
import { FileService } from '../lib/files';

const workspaceSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string(),
  icon: z.string(),
  color: z.string(),
  accountId: z.number(),
  isDefault: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

type WorkspaceDatabase = typeof prisma;
type WorkspaceFileService = Pick<typeof FileService, 'deletePhysicalFile'>;

const isRestorableAttachment = (attachment: { path?: string | null; type?: string | null; name?: string | null }) => {
  if (!attachment.path) return false;
  if (attachment.type === 'folder' || attachment.name === '.folder') return false;
  return attachment.path.startsWith('/api/file/') || attachment.path.startsWith('/api/s3file/');
};

async function getWorkspaceOwnedAttachmentPaths(database: WorkspaceDatabase, workspaceId: number) {
  const attachments = await database.attachments.findMany({
    where: { workspaceId },
    select: { path: true, type: true, name: true },
  });

  const paths = Array.from(new Set(
    attachments
      .filter(isRestorableAttachment)
      .map((attachment) => attachment.path)
      .filter((path): path is string => Boolean(path))
  ));
  const ownedPaths: string[] = [];

  for (const path of paths) {
    const [otherAttachmentCount, otherNoteCount] = await Promise.all([
      database.attachments.count({
        where: {
          path,
          OR: [
            { workspaceId: { not: workspaceId } },
            { workspaceId: null },
          ],
        },
      }),
      database.notes.count({
        where: {
          content: { contains: path },
          OR: [
            { workspaceId: { not: workspaceId } },
            { workspaceId: null },
          ],
        },
      }),
    ]);

    if (otherAttachmentCount === 0 && otherNoteCount === 0) {
      ownedPaths.push(path);
    }
  }

  return ownedPaths;
}

export async function deleteWorkspaceForAccount({
  accountId,
  workspaceId,
  database = prisma,
  fileService = FileService,
}: {
  accountId: number;
  workspaceId: number;
  database?: WorkspaceDatabase;
  fileService?: WorkspaceFileService;
}) {
  const ws = await database.workspaces.findFirst({
    where: { id: workspaceId, accountId }
  });
  if (!ws) {
    throw new TRPCError({ code: 'NOT_FOUND', message: '工作区不存在' });
  }
  if (ws.isDefault) {
    throw new TRPCError({ code: 'FORBIDDEN', message: '不能删除默认工作区' });
  }

  const attachmentPaths = await getWorkspaceOwnedAttachmentPaths(database, workspaceId);
  const failedAttachmentDeletes: { path: string; message: string }[] = [];

  for (const path of attachmentPaths) {
    try {
      await fileService.deletePhysicalFile(path);
    } catch (error) {
      failedAttachmentDeletes.push({
        path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failedAttachmentDeletes.length) {
    const detail = failedAttachmentDeletes
      .slice(0, 3)
      .map((item) => `${item.path}: ${item.message}`)
      .join('; ');
    throw new Error(`部分资源文件删除失败，工作区未删除：${detail}`);
  }

  await database.$transaction(async (tx) => {
    await tx.comments.deleteMany({ where: { workspaceId } });
    await tx.noteHistory.deleteMany({ where: { workspaceId } });
    await tx.noteReference.deleteMany({
      where: {
        OR: [
          { fromNote: { workspaceId } },
          { toNote: { workspaceId } }
        ]
      }
    });
    await tx.tagsToNote.deleteMany({
      where: {
        OR: [
          { note: { workspaceId } },
          { tag: { workspaceId } }
        ]
      }
    });
    await tx.attachments.deleteMany({ where: { workspaceId } });
    await tx.tag.deleteMany({ where: { workspaceId } });
    await tx.notes.deleteMany({ where: { workspaceId } });
    await tx.config.deleteMany({ where: { workspaceId } });
    await tx.workspaces.delete({ where: { id: workspaceId } });
  });

  return { success: true };
}

export const workspaceRouter = router({
  list: authProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/workspaces', summary: 'List workspaces', protect: true, tags: ['Workspace'] } })
    .input(z.void())
    .output(z.array(workspaceSchema))
    .query(async ({ ctx }) => {
      return prisma.workspaces.findMany({
        where: { accountId: Number(ctx.id) },
        orderBy: { createdAt: 'asc' }
      });
    }),

  create: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/workspaces', summary: 'Create workspace', protect: true, tags: ['Workspace'] } })
    .input(z.object({
      name: z.string().min(1).max(100),
      description: z.string().max(500).optional(),
      icon: z.string().max(50).optional(),
      color: z.string().max(50).optional(),
    }))
    .output(workspaceSchema)
    .mutation(async ({ input, ctx }) => {
      return prisma.workspaces.create({
        data: {
          name: input.name,
          description: input.description || '',
          icon: input.icon || '',
          color: input.color || '',
          accountId: Number(ctx.id),
        }
      });
    }),

  update: authProcedure
    .meta({ openapi: { method: 'PUT', path: '/v1/workspaces/{id}', summary: 'Update workspace', protect: true, tags: ['Workspace'] } })
    .input(z.object({
      id: z.number(),
      name: z.string().min(1).max(100).optional(),
      description: z.string().max(500).optional(),
      icon: z.string().max(50).optional(),
      color: z.string().max(50).optional(),
    }))
    .output(workspaceSchema)
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      const workspace = await prisma.workspaces.findFirst({
        where: { id, accountId: Number(ctx.id) }
      });
      if (!workspace) {
        throw new TRPCError({ code: 'NOT_FOUND', message: '工作区不存在' });
      }
      return prisma.workspaces.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.icon !== undefined && { icon: data.icon }),
          ...(data.color !== undefined && { color: data.color }),
        }
      });
    }),

  delete: authProcedure.use(demoAuthMiddleware)
    .meta({ openapi: { method: 'DELETE', path: '/v1/workspaces/{id}', summary: 'Delete workspace', protect: true, tags: ['Workspace'] } })
    .input(z.object({ id: z.number() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      return deleteWorkspaceForAccount({
        accountId: Number(ctx.id),
        workspaceId: input.id,
      });
    }),

  setDefault: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/workspaces/{id}/default', summary: 'Set default workspace', protect: true, tags: ['Workspace'] } })
    .input(z.object({ id: z.number() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const ws = await prisma.workspaces.findFirst({
        where: { id: input.id, accountId: Number(ctx.id) }
      });
      if (!ws) {
        throw new TRPCError({ code: 'NOT_FOUND', message: '工作区不存在' });
      }
      await prisma.$transaction([
        prisma.workspaces.updateMany({
          where: { accountId: Number(ctx.id) },
          data: { isDefault: false }
        }),
        prisma.workspaces.update({
          where: { id: input.id },
          data: { isDefault: true }
        })
      ]);
      return { success: true };
    }),

  getDefault: authProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/workspaces/default', summary: 'Get default workspace', protect: true, tags: ['Workspace'] } })
    .input(z.void())
    .output(workspaceSchema.nullable())
    .query(async ({ ctx }) => {
      return prisma.workspaces.findFirst({
        where: { accountId: Number(ctx.id), isDefault: true }
      });
    }),
});
