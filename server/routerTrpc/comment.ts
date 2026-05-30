import { Prisma } from '@prisma/client';
import { NoteType } from '@shared/lib/types';
import { router, authProcedure, demoAuthMiddleware } from '@server/middleware';
import { prisma } from '@server/prisma';
import { z } from 'zod';

const commentKindSchema = z.enum(['annotation', 'instruction', 'todo-candidate', 'strategy', 'filter']);
const commentStatusSchema = z.enum(['open', 'resolved', 'archived']);

const commentInclude = {
  account: { select: { id: true, name: true, nickname: true, image: true } },
  replies: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { account: { select: { id: true, name: true, nickname: true, image: true } } },
  },
} satisfies Prisma.commentsInclude;

const toJsonObject = (value: Prisma.JsonValue | null | undefined): Prisma.JsonObject => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Prisma.JsonObject;
  return {};
};

const assertOwnedNote = async (noteId: number, accountId: number, workspaceId: number) => {
  const note = await prisma.notes.findFirst({ where: { id: noteId, accountId, workspaceId }, select: { id: true } });
  if (!note) throw new Error('Note not found or access denied');
  return note;
};

const assertOwnedComment = async (id: number, accountId: number, workspaceId: number) => {
  const comment = await prisma.comments.findFirst({
    where: { id, note: { accountId, workspaceId } },
  });
  if (!comment) throw new Error('Annotation not found or access denied');
  return comment;
};

export const commentsRouter = router({
  list: authProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/comments/list', summary: 'List private note annotations', protect: true, tags: ['Comment'] } })
    .input(z.object({ noteId: z.number() }))
    .output(z.any())
    .query(async ({ input, ctx }) => {
      await assertOwnedNote(input.noteId, Number(ctx.id), Number(ctx.workspaceId));
      return prisma.comments.findMany({
        where: { noteId: input.noteId, parentId: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: commentInclude,
      });
    }),

  create: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/comments/create', summary: 'Create private note annotation', protect: true, tags: ['Comment'] } })
    .input(z.object({
      noteId: z.number(),
      content: z.string().min(1),
      kind: commentKindSchema.default('annotation'),
      parentId: z.number().nullable().optional(),
      metadata: z.any().optional(),
    }))
    .output(z.any())
    .mutation(async ({ input, ctx }) => {
      const accountId = Number(ctx.id);
      const workspaceId = Number(ctx.workspaceId);
      await assertOwnedNote(input.noteId, accountId, workspaceId);

      if (input.parentId) {
        const parent = await assertOwnedComment(input.parentId, accountId, workspaceId);
        if (parent.noteId !== input.noteId) throw new Error('Reply parent must belong to the same note');
      }

      return prisma.comments.create({
        data: {
          noteId: input.noteId,
          accountId,
          workspaceId,
          content: input.content.trim(),
          kind: input.kind,
          parentId: input.parentId || null,
          metadata: input.metadata as Prisma.InputJsonValue | undefined,
        },
        include: commentInclude,
      });
    }),

  update: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/comments/update', summary: 'Update private note annotation', protect: true, tags: ['Comment'] } })
    .input(z.object({
      id: z.number(),
      content: z.string().min(1).optional(),
      kind: commentKindSchema.optional(),
      status: commentStatusSchema.optional(),
      metadata: z.any().optional(),
    }))
    .output(z.any())
    .mutation(async ({ input, ctx }) => {
      await assertOwnedComment(input.id, Number(ctx.id), Number(ctx.workspaceId));
      return prisma.comments.update({
        where: { id: input.id },
        data: {
          ...(input.content !== undefined && { content: input.content.trim() }),
          ...(input.kind !== undefined && { kind: input.kind }),
          ...(input.status !== undefined && { status: input.status }),
          ...(input.metadata !== undefined && { metadata: input.metadata as Prisma.InputJsonValue }),
        },
        include: commentInclude,
      });
    }),

  delete: authProcedure
    .use(demoAuthMiddleware)
    .meta({ openapi: { method: 'POST', path: '/v1/comments/delete', summary: 'Delete private note annotation', protect: true, tags: ['Comment'] } })
    .input(z.object({ id: z.number() }))
    .output(z.object({ ok: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      await assertOwnedComment(input.id, Number(ctx.id), Number(ctx.workspaceId));
      await prisma.comments.delete({ where: { id: input.id } });
      return { ok: true };
    }),

  convertToTodo: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/comments/convert-to-todo', summary: 'Convert annotation to TODO', protect: true, tags: ['Comment'] } })
    .input(z.object({ id: z.number(), content: z.string().min(1).optional() }))
    .output(z.any())
    .mutation(async ({ input, ctx }) => {
      const accountId = Number(ctx.id);
      const workspaceId = Number(ctx.workspaceId);
      const comment = await assertOwnedComment(input.id, accountId, workspaceId);
      const now = new Date().toISOString();
      const todo = await prisma.notes.create({
        data: {
          accountId,
          workspaceId,
          type: NoteType.TODO,
          content: input.content?.trim() || comment.content,
          metadata: {
            source: {
              type: 'comment',
              commentId: comment.id,
              noteId: comment.noteId,
              capturedAt: now,
            },
            memory: {
              kind: 'todo',
              status: 'candidate',
              sourceNoteIds: [comment.noteId],
              createdBy: 'user',
            },
            todo: {
              status: 'open',
              convertedFromCommentId: comment.id,
              convertedFromNoteId: comment.noteId,
            },
          },
        },
      });

      await prisma.noteReference.create({
        data: { fromNoteId: todo.id, toNoteId: comment.noteId },
      });

      await prisma.comments.update({
        where: { id: comment.id },
        data: {
          status: 'resolved',
          metadata: {
            ...toJsonObject(comment.metadata),
            convertedToTodoId: todo.id,
            convertedAt: now,
          },
        },
      });

      return todo;
    }),
});
