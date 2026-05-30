import { z } from 'zod';
import { prisma } from '../prisma';
import { Prisma } from '@prisma/client';
import { helper, TagTreeNode } from '@shared/lib/helper';
import { _ } from '@shared/lib/lodash';
import { NoteType } from '../../shared/lib/types';
import { getGlobalConfig } from './config';
import { FileService } from '../lib/files';
import { extractAttachmentPathsFromContent } from '../lib/attachmentPaths';
import { AiService } from '@server/aiServer';
import { Context } from '../context';
import { AiModelFactory } from '@server/aiServer/aiModelFactory';
import { authProcedure, demoAuthMiddleware, router } from '@server/middleware';

const extractHashtags = (input: string): string[] => {
  const withoutCodeBlocks = input.replace(/```[\s\S]*?```/g, '');
  const hashtagRegex = /(?<!:\/\/)(?<=\s|^)#[^\s#]+(?=\s|$)/g;
  const matches = withoutCodeBlocks.match(hashtagRegex);
  return matches ? matches : [];
};

const noteInclude = {
  tags: { include: { tag: true } },
  attachments: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
  comments: {
    where: { parentId: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 1,
    include: {
      account: {
        select: { image: true, nickname: true, name: true },
      },
    },
  },
  references: {
    select: {
      toNoteId: true,
      toNote: { select: { content: true, createdAt: true, updatedAt: true } },
    },
  },
  referencedBy: {
    select: {
      fromNoteId: true,
      fromNote: { select: { content: true, createdAt: true, updatedAt: true } },
    },
  },
  _count: { select: { histories: true, comments: true } },
} satisfies Prisma.notesInclude;

const listInput = z.object({
  tagId: z.union([z.number(), z.null()]).default(null),
  page: z.number().default(1),
  size: z.number().default(30),
  orderBy: z.enum(['asc', 'desc']).default('desc'),
  type: z.union([z.nativeEnum(NoteType), z.literal(-1)]).default(-1),
  isArchived: z.union([z.boolean(), z.null()]).default(false).optional(),
  isRecycle: z.boolean().default(false).optional(),
  searchText: z.string().default('').optional(),
  withoutTag: z.boolean().default(false).optional(),
  withFile: z.boolean().default(false).optional(),
  withLink: z.boolean().default(false).optional(),
  isUseAiQuery: z.boolean().default(false).optional(),
  startDate: z.union([z.date(), z.null(), z.string()]).default(null).optional(),
  endDate: z.union([z.date(), z.null(), z.string()]).default(null).optional(),
  hasTodo: z.boolean().default(false).optional(),
});

export const noteRouter = router({
  list: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/note/list', summary: 'Query notes list', protect: true, tags: ['Note'] } })
    .input(listInput)
    .output(z.any())
    .mutation(async ({ input, ctx }) => {
      const { tagId, type, isArchived, isRecycle, searchText, page, size, orderBy, withFile, withoutTag, withLink, isUseAiQuery, startDate, endDate, hasTodo } = input;

      if (isUseAiQuery && searchText?.trim() !== '') {
        const cleanedQuery = searchText.replace(/@/g, '').trim();
        return page === 1 && cleanedQuery ? AiService.enhanceQuery({ query: cleanedQuery, ctx }) : [];
      }

      const and: Prisma.notesWhereInput[] = [{ accountId: Number(ctx.id), workspaceId: Number(ctx.workspaceId), isRecycle }];

      if (!isRecycle && isArchived !== null) and.push({ isArchived });
      if (type !== -1) and.push({ type });
      if (tagId) and.push({ tags: { some: { tagId } } });
      if (withFile) and.push({ attachments: { some: {} } });
      if (withoutTag) and.push({ tags: { none: {} } });
      if (startDate && endDate) and.push({ createdAt: { gte: startDate, lte: endDate } });
      if (searchText) {
        and.push({
          OR: [
            { content: { contains: searchText, mode: 'insensitive' } },
            { attachments: { some: { path: { contains: searchText, mode: 'insensitive' } } } },
          ],
        });
      }
      if (withLink) {
        and.push({ OR: [{ content: { contains: 'http://', mode: 'insensitive' } }, { content: { contains: 'https://', mode: 'insensitive' } }] });
      }
      if (hasTodo) {
        and.push({
          OR: [
            { content: { contains: '- [ ]', mode: 'insensitive' } },
            { content: { contains: '- [x]', mode: 'insensitive' } },
            { content: { contains: '* [ ]', mode: 'insensitive' } },
            { content: { contains: '* [x]', mode: 'insensitive' } },
          ],
        });
      }

      const config = await getGlobalConfig({ ctx });
      const timeOrderBy = config?.isOrderByCreateTime ? { createdAt: orderBy } : { updatedAt: orderBy };

      return prisma.notes.findMany({
        where: { AND: and },
        orderBy: [{ isTop: 'desc' }, { sortOrder: 'asc' }, timeOrderBy],
        skip: (page - 1) * size,
        take: size,
        include: noteInclude,
      });
    }),

  listByIds: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/note/list-by-ids', summary: 'Query notes list by ids', protect: true, tags: ['Note'] } })
    .input(z.object({ ids: z.array(z.number()) }))
    .output(z.any())
    .mutation(({ input, ctx }) => prisma.notes.findMany({ where: { id: { in: input.ids }, accountId: Number(ctx.id), workspaceId: Number(ctx.workspaceId) }, include: noteInclude })),

  detail: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/note/detail', summary: 'Query note detail', protect: true, tags: ['Note'] } })
    .input(z.object({ id: z.number() }))
    .output(z.any())
    .mutation(({ input, ctx }) => prisma.notes.findFirst({ where: { id: input.id, accountId: Number(ctx.id), workspaceId: Number(ctx.workspaceId) }, include: noteInclude })),

  dailyReviewNoteList: authProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/note/daily-review-list', summary: 'Query daily review note list', protect: true, tags: ['Note'] } })
    .input(z.void())
    .output(z.any())
    .query(({ ctx }) => prisma.notes.findMany({
      where: {
        createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        isReviewed: false,
        isArchived: false,
        isRecycle: false,
        accountId: Number(ctx.id),
        workspaceId: Number(ctx.workspaceId),
      },
      orderBy: { id: 'desc' },
      include: { attachments: true },
    })),

  randomNoteList: authProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/note/random-list', summary: 'Query random notes for review', protect: true, tags: ['Note'] } })
    .input(z.object({ limit: z.number().default(30) }))
    .output(z.any())
    .query(async ({ input, ctx }) => {
      const randomNotes = await prisma.$queryRaw<any[]>`
        SELECT n.*
        FROM "notes" n
        WHERE n."isArchived" = false
        AND n."isRecycle" = false
        AND n."accountId" = ${Number(ctx.id)}
        AND n."workspaceId" = ${Number(ctx.workspaceId)}
        ORDER BY RANDOM()
        LIMIT ${input.limit}
      `;
      const noteIds = randomNotes.map((note) => note.id);
      const attachments = await prisma.attachments.findMany({ where: { noteId: { in: noteIds } } });
      return randomNotes.map((note) => ({ ...note, attachments: attachments.filter((attachment) => attachment.noteId === note.id) }));
    }),

  reviewNote: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/note/review', summary: 'Review a note', protect: true, tags: ['Note'] } })
    .input(z.object({ id: z.number() }))
    .output(z.any())
    .mutation(({ input, ctx }) => prisma.notes.update({ where: { id: input.id, accountId: Number(ctx.id), workspaceId: Number(ctx.workspaceId) }, data: { isReviewed: true } })),

  upsert: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/note/upsert', summary: 'Update or create note', protect: true, tags: ['Note'] } })
    .input(z.object({
      content: z.union([z.string(), z.null()]).default(null),
      type: z.union([z.nativeEnum(NoteType), z.literal(-1)]).optional(),
      attachments: z.array(z.object({ name: z.string(), path: z.string(), size: z.union([z.string(), z.number()]), type: z.string() })).default([]),
      id: z.number().optional(),
      isArchived: z.union([z.boolean(), z.null()]).default(null),
      isTop: z.union([z.boolean(), z.null()]).default(null),
      isRecycle: z.union([z.boolean(), z.null()]).default(null),
      references: z.array(z.number()).optional(),
      createdAt: z.date().optional(),
      updatedAt: z.date().optional(),
      metadata: z.any().optional(),
    }))
    .output(z.any())
    .mutation(async ({ input, ctx }) => {
      let { id, isArchived, isRecycle, type, attachments, content, isTop, references } = input;
      const accountId = Number(ctx.id);
      const workspaceId = Number(ctx.workspaceId);
      const config = await getGlobalConfig({ ctx });
      const tagTree = helper.buildHashTagTreeFromHashString(extractHashtags(content?.replace(/\\/g, '') + ' '));
      let newTags: Prisma.tagCreateManyInput[] = [];

      if (id) {
        const existing = await prisma.notes.findFirst({ where: { id, accountId, workspaceId } });
        if (!existing) throw new Error('Note not found or you do not have edit permission');
      }

      const markdownImages = content?.match(/!\[.*?\]\((\/api\/(?:s3)?file\/[^)]+)\)/g)?.map((match) => /!\[.*?\]\((\/api\/(?:s3)?file\/[^)]+)\)/.exec(match)?.[1] || '') || [];
      if (markdownImages.length > 0) {
        const images = await prisma.attachments.findMany({
          where: {
            path: { in: markdownImages },
            OR: [
              { accountId, workspaceId },
              { accountId, workspaceId: null, noteId: null },
              { note: { accountId, workspaceId } },
            ],
          },
        });
        attachments = [...attachments, ...images.map((i) => ({ path: i.path, name: i.name, size: Number(i.size), type: i.type }))];
      }
      attachments = _.uniqBy(attachments.filter((item) => item.path), 'path');

      const handleAddTags = async (tree: TagTreeNode[], parentTag: Prisma.tagCreateManyInput | undefined, noteId?: number) => {
        for (const item of tree) {
          let tag = await prisma.tag.findFirst({ where: { name: item.name, parent: parentTag?.id ?? 0, accountId, workspaceId } });
          if (!tag) tag = await prisma.tag.create({ data: { name: item.name, parent: parentTag?.id ?? 0, accountId, workspaceId } });
          if (noteId) {
            const relation = await prisma.tagsToNote.findFirst({ where: { tagId: tag.id, noteId } });
            if (!relation) await prisma.tagsToNote.create({ data: { tagId: tag.id, noteId } });
          }
          if (item.children) await handleAddTags(item.children, tag, noteId);
          newTags.push(tag);
        }
      };

      const update: Prisma.notesUpdateInput = {
        ...(type !== undefined && type !== -1 && { type }),
        ...(isArchived !== null && { isArchived }),
        ...(isTop !== null && { isTop }),
        ...(isRecycle !== null && { isRecycle }),
        ...(content !== null && { content }),
        ...(input.createdAt && { createdAt: input.createdAt }),
        ...(input.updatedAt && { updatedAt: input.updatedAt }),
      };

      if (input.metadata) {
        const existingNote = id ? await prisma.notes.findFirst({ where: { id, accountId, workspaceId }, select: { metadata: true } }) : null;
        update.metadata = { ...((existingNote?.metadata as object) || {}), ...input.metadata };
      }

      if (id) {
        const existingNote = await prisma.notes.findFirst({ where: { id, accountId, workspaceId }, select: { content: true, type: true, isArchived: true, isTop: true, isRecycle: true, accountId: true, workspaceId: true } });
        if (existingNote && content !== null && content !== existingNote.content) {
          const latestVersion = await prisma.noteHistory.findFirst({ where: { noteId: id, accountId, workspaceId }, orderBy: { version: 'desc' }, select: { version: true } });
          await prisma.noteHistory.create({
            data: {
              noteId: id,
              content: existingNote.content,
              version: (latestVersion?.version || 0) + 1,
              accountId,
              workspaceId,
              metadata: { type: existingNote.type, isArchived: existingNote.isArchived, isTop: existingNote.isTop, isRecycle: existingNote.isRecycle },
            },
          });
        }

        const note = await prisma.notes.update({ where: { id, accountId, workspaceId }, data: update });
        if (content === null) {
          return note;
        }

        const oldTagsInThisNote = await prisma.tagsToNote.findMany({ where: { noteId: note.id }, include: { tag: true } });
        await handleAddTags(tagTree, undefined, note.id);
        const oldTags = oldTagsInThisNote.map((item) => item.tag).filter(Boolean);
        const oldTagsString = oldTags.map((item) => `${item.name}<key>${item.parent}`);
        const newTagsString = newTags.map((item) => `${item.name}<key>${item.parent}`);
        const needToBeDeletedRelationTags = _.difference(oldTagsString, newTagsString);

        if (needToBeDeletedRelationTags.length) {
          await prisma.tagsToNote.deleteMany({
            where: {
              noteId: note.id,
              tagId: {
                in: needToBeDeletedRelationTags
                  .map((item) => {
                    const [name, parent] = item.split('<key>');
                    return oldTags.find((tag) => tag.name === name && tag.parent === Number(parent))?.id;
                  })
                  .filter((item): item is number => !!item),
              },
            },
          });
        }

        if (references !== undefined) {
          const oldReferences = await prisma.noteReference.findMany({ where: { fromNoteId: note.id } });
          const oldReferenceIds = oldReferences.map((ref) => ref.toNoteId);
          const needToBeAddedReferences = _.difference(references || [], oldReferenceIds);
          const needToBeDeletedReferences = _.difference(oldReferenceIds, references || []);
          if (needToBeDeletedReferences.length) await prisma.noteReference.deleteMany({ where: { fromNoteId: note.id, toNoteId: { in: needToBeDeletedReferences } } });
          if (needToBeAddedReferences.length) {
            const validTargets = await prisma.notes.findMany({
              where: { id: { in: needToBeAddedReferences }, accountId, workspaceId },
              select: { id: true },
            });
            if (validTargets.length !== needToBeAddedReferences.length) {
              throw new Error('Some referenced notes are not in the current workspace');
            }
            await prisma.noteReference.createMany({ data: validTargets.map(({ id: toNoteId }) => ({ fromNoteId: note.id, toNoteId })) });
          }
        }

        const oldTagIds = oldTags.map((item) => item.id);
        const usingTags = (await prisma.tagsToNote.findMany({
          where: {
            tagId: { in: oldTagIds },
            note: { accountId, workspaceId },
          }
        })).map((item) => item.tagId).filter(Boolean);
        const unusedTagIds = _.difference(oldTagIds, usingTags);
        if (unusedTagIds.length) await prisma.tag.deleteMany({ where: { id: { in: unusedTagIds }, accountId, workspaceId } });

        if (attachments.length) {
          const oldAttachments = await prisma.attachments.findMany({ where: { noteId: note.id } });
          const needToBeAddedPaths = _.difference(attachments.map((item) => item.path), oldAttachments.map((item) => item.path));
          if (needToBeAddedPaths.length) {
            const attachmentIds = await prisma.attachments.findMany({
              where: {
                path: { in: needToBeAddedPaths },
                OR: [
                  { accountId, workspaceId },
                  { accountId, workspaceId: null, noteId: null },
                  { note: { accountId, workspaceId } },
                ],
              }
            });
            await prisma.attachments.updateMany({ where: { id: { in: attachmentIds.map((item) => item.id) } }, data: { noteId: note.id, workspaceId } });
          }
        }

        if (config?.embeddingModelId) {
          AiService.embeddingUpsert({ id: note.id, content: note.content, type: 'update', createTime: note.createdAt!, updatedAt: note.updatedAt });
          for (const attachment of attachments) await AiService.embeddingInsertAttachments({ id: note.id, updatedAt: note.updatedAt, filePath: attachment.path });
        }

        return note;
      }

      const note = await prisma.notes.create({
        data: {
          content: content ?? '',
          type: type === undefined || type === -1 ? NoteType.BLINKORA : type,
          accountId,
          workspaceId,
          isTop: isTop ? true : false,
          ...(input.createdAt && { createdAt: input.createdAt }),
          ...(input.updatedAt && { updatedAt: input.updatedAt }),
          ...(input.metadata && { metadata: input.metadata }),
        },
      });
      await handleAddTags(tagTree, undefined, note.id);
      const attachmentIds = await prisma.attachments.findMany({
        where: {
          path: { in: attachments.map((item) => item.path) },
          OR: [
            { accountId, workspaceId },
            { accountId, workspaceId: null, noteId: null },
            { note: { accountId, workspaceId } },
          ],
        }
      });
      await prisma.attachments.updateMany({ where: { id: { in: attachmentIds.map((item) => item.id) } }, data: { noteId: note.id, workspaceId } });
      if (references?.length) {
        const validTargets = await prisma.notes.findMany({
          where: { id: { in: references }, accountId, workspaceId },
          select: { id: true },
        });
        if (validTargets.length !== references.length) {
          throw new Error('Some referenced notes are not in the current workspace');
        }
        await prisma.noteReference.createMany({ data: validTargets.map(({ id: toNoteId }) => ({ fromNoteId: note.id, toNoteId })) });
      }

      if (config?.embeddingModelId) {
        AiService.embeddingUpsert({ id: note.id, content: note.content, type: 'insert', createTime: note.createdAt!, updatedAt: note.updatedAt });
        for (const attachment of attachments) await AiService.embeddingInsertAttachments({ id: note.id, updatedAt: note.updatedAt, filePath: attachment.path });
      }

      return note;
    }),

  updateMany: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/note/batch-update', summary: 'Batch update note', protect: true, tags: ['Note'] } })
    .input(z.object({ type: z.union([z.nativeEnum(NoteType), z.literal(-1)]).default(-1), isArchived: z.union([z.boolean(), z.null()]).default(null), isRecycle: z.union([z.boolean(), z.null()]).default(null), ids: z.array(z.number()) }))
    .output(z.any())
    .mutation(({ input, ctx }) => {
      const update: Prisma.notesUpdateInput = {
        ...(input.type !== -1 && { type: input.type }),
        ...(input.isArchived !== null && { isArchived: input.isArchived }),
        ...(input.isRecycle !== null && { isRecycle: input.isRecycle }),
      };
      return prisma.notes.updateMany({ where: { id: { in: input.ids }, accountId: Number(ctx.id), workspaceId: Number(ctx.workspaceId) }, data: update });
    }),

  trashMany: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/note/batch-trash', summary: 'Batch trash note', protect: true, tags: ['Note'] } })
    .input(z.object({ ids: z.array(z.number()) }))
    .output(z.any())
    .mutation(({ input, ctx }) => {
      return prisma.notes.updateMany({ where: { id: { in: input.ids }, accountId: Number(ctx.id), workspaceId: Number(ctx.workspaceId) }, data: { isRecycle: true } });
    }),

  deleteMany: authProcedure
    .use(demoAuthMiddleware)
    .meta({ openapi: { method: 'POST', path: '/v1/note/batch-delete', summary: 'Batch delete note', protect: true, tags: ['Note'] } })
    .input(z.object({ ids: z.array(z.number()), deleteOrphanAttachments: z.boolean().default(false).optional() }))
    .output(z.any())
    .mutation(async ({ input, ctx }) => {
      const notes = await prisma.notes.findMany({ where: { id: { in: input.ids }, accountId: Number(ctx.id), workspaceId: Number(ctx.workspaceId) }, select: { id: true } });
      if (notes.length !== input.ids.length) throw new Error('Some notes cannot be deleted as you are not the owner');
      return deleteNotes(notes.map((note) => note.id), ctx, { deleteOrphanAttachments: input.deleteOrphanAttachments });
    }),

  deleteImpact: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/note/delete-impact', summary: 'Preview note delete impact', protect: true, tags: ['Note'] } })
    .input(z.object({ ids: z.array(z.number()) }))
    .output(z.any())
    .mutation(async ({ input, ctx }) => getDeleteImpact(input.ids, ctx)),

  addReference: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/note/add-reference', summary: 'Add note reference', protect: true, tags: ['Note'] } })
    .input(z.object({ fromNoteId: z.number(), toNoteId: z.number() }))
    .output(z.any())
    .mutation(({ input, ctx }) => insertNoteReference({ ...input, accountId: Number(ctx.id), workspaceId: Number(ctx.workspaceId) })),

  noteReferenceList: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/note/reference-list', summary: 'Query note references', protect: true, tags: ['Note'] } })
    .input(z.object({ noteId: z.number(), type: z.enum(['references', 'referencedBy']).default('references') }))
    .output(z.any())
    .mutation(async ({ input, ctx }) => {
      const accountId = Number(ctx.id);
      const workspaceId = Number(ctx.workspaceId);
      const note = await prisma.notes.findFirst({ where: { id: input.noteId, accountId, workspaceId }, select: { id: true } });
      if (!note) throw new Error('Note not found or access denied');

      if (input.type === 'references') {
        const references = await prisma.noteReference.findMany({
          where: {
            fromNoteId: input.noteId,
            fromNote: { accountId, workspaceId },
            toNote: { accountId, workspaceId },
          },
          include: { toNote: { include: { attachments: true, tags: { include: { tag: true } }, references: { select: { toNoteId: true } }, referencedBy: { select: { fromNoteId: true } } } } },
          orderBy: { createdAt: 'desc' },
        });
        return references.map((ref) => ({ ...ref.toNote, referenceCreatedAt: ref.createdAt }));
      }
      const referencedBy = await prisma.noteReference.findMany({
        where: {
          toNoteId: input.noteId,
          fromNote: { accountId, workspaceId },
          toNote: { accountId, workspaceId },
        },
        include: { fromNote: { include: { attachments: true, tags: { include: { tag: true } }, references: { select: { toNoteId: true } }, referencedBy: { select: { fromNoteId: true } } } } },
        orderBy: { createdAt: 'desc' },
      });
      return referencedBy.map((ref) => ({ ...ref.fromNote, referenceCreatedAt: ref.createdAt }));
    }),

  clearRecycleBin: authProcedure
    .use(demoAuthMiddleware)
    .meta({ openapi: { method: 'POST', path: '/v1/note/clear-recycle-bin', summary: 'Clear recycle bin', protect: true, tags: ['Note'] } })
    .input(z.void())
    .output(z.any())
    .mutation(async ({ ctx }) => {
      const recycleBinNotes = await prisma.notes.findMany({ where: { accountId: Number(ctx.id), workspaceId: Number(ctx.workspaceId), isRecycle: true }, select: { id: true } });
      return recycleBinNotes.length ? deleteNotes(recycleBinNotes.map((note) => note.id), ctx, { deleteOrphanAttachments: true }) : { ok: true };
    }),

  updateAttachmentsOrder: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/note/update-attachments-order', summary: 'Update attachments order', protect: true, tags: ['Note'] } })
    .input(z.object({ attachments: z.array(z.object({ name: z.string(), sortOrder: z.number() })) }))
    .output(z.any())
    .mutation(async ({ input, ctx }) => {
      await Promise.all(input.attachments.map(({ name, sortOrder }) => prisma.attachments.updateMany({ where: { name, note: { accountId: Number(ctx.id), workspaceId: Number(ctx.workspaceId) } }, data: { sortOrder } })));
      return { success: true };
    }),

  getNoteHistory: authProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/note/history', summary: 'Get note history', protect: true, tags: ['Note'] } })
    .input(z.object({ noteId: z.number() }))
    .output(z.any())
    .query(({ input, ctx }) => prisma.noteHistory.findMany({ where: { noteId: input.noteId, accountId: Number(ctx.id), workspaceId: Number(ctx.workspaceId) }, orderBy: { version: 'desc' } })),

  getNoteVersion: authProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/note/version', summary: 'Get specific note version', protect: true, tags: ['Note'] } })
    .input(z.object({ noteId: z.number(), version: z.number().optional() }))
    .output(z.any())
    .query(async ({ input, ctx }) => {
      const note = await prisma.notes.findFirst({ where: { id: input.noteId, accountId: Number(ctx.id), workspaceId: Number(ctx.workspaceId) } });
      if (!note) throw new Error('Note not found or access denied');

      if (input.version !== undefined) {
        const versionRecord = await prisma.noteHistory.findFirst({ where: { noteId: input.noteId, version: input.version, accountId: Number(ctx.id), workspaceId: Number(ctx.workspaceId) }, orderBy: { version: 'desc' } });
        if (!versionRecord) throw new Error('Version not found');
        return { content: versionRecord.content, metadata: versionRecord.metadata, version: versionRecord.version, createdAt: versionRecord.createdAt };
      }

      const latestVersion = await prisma.noteHistory.findFirst({ where: { noteId: input.noteId, accountId: Number(ctx.id), workspaceId: Number(ctx.workspaceId) }, orderBy: { version: 'desc' } });
      if (!latestVersion) {
        return { content: note.content, metadata: { type: note.type, isArchived: note.isArchived, isTop: note.isTop, isRecycle: note.isRecycle }, version: 0, createdAt: note.updatedAt };
      }
      return { content: latestVersion.content, metadata: latestVersion.metadata, version: latestVersion.version, createdAt: latestVersion.createdAt };
    }),

  updateNotesOrder: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/note/update-order', summary: 'Update notes order', protect: true, tags: ['Note'] } })
    .input(z.object({ updates: z.array(z.object({ id: z.number(), sortOrder: z.number() })) }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      await Promise.all(input.updates.map(({ id, sortOrder }) => prisma.notes.updateMany({ where: { id, accountId: Number(ctx.id), workspaceId: Number(ctx.workspaceId) }, data: { sortOrder } })));
      return { success: true };
    }),
});

let insertNoteReference = async ({ fromNoteId, toNoteId, accountId, workspaceId }: { fromNoteId: number, toNoteId: number, accountId: number, workspaceId: number }) => {
  const [fromNote, toNote] = await Promise.all([
    prisma.notes.findFirst({ where: { id: fromNoteId, accountId, workspaceId } }),
    prisma.notes.findFirst({ where: { id: toNoteId, accountId, workspaceId } }),
  ]);

  if (!fromNote || !toNote) throw new Error('Note not found');
  return prisma.noteReference.create({ data: { fromNoteId, toNoteId } });
};

type NoteWithAttachments = Prisma.notesGetPayload<{ include: { attachments: true } }>;

const getAttachmentDeleteCandidates = async (notes: NoteWithAttachments[], accountId: number, workspaceId: number) => {
  const directAttachments = notes.flatMap((note) => note.attachments || []);
  const contentPaths = Array.from(new Set(notes.flatMap((note) => extractAttachmentPathsFromContent(note.content))));
  const contentAttachments = contentPaths.length
    ? await prisma.attachments.findMany({
      where: {
        path: { in: contentPaths },
        OR: [
          { accountId, workspaceId },
          { note: { accountId, workspaceId } },
        ],
      },
    })
    : [];

  return Array.from(
    new Map(
      [...directAttachments, ...contentAttachments]
        .filter((attachment) => attachment.path)
        .map((attachment) => [attachment.id, attachment])
    ).values()
  );
};

const getDeleteImpact = async (ids: number[], ctx: Context) => {
  const accountId = Number(ctx.id);
  const workspaceId = Number(ctx.workspaceId);
  const uniqueIds = Array.from(new Set(ids));
  const notes = await prisma.notes.findMany({
    where: { id: { in: uniqueIds }, accountId, workspaceId },
    include: { tags: { include: { tag: true } }, attachments: true, references: true, referencedBy: true },
  });
  if (notes.length !== uniqueIds.length) throw new Error('Some notes cannot be deleted as you are not the owner');

  const attachments = await getAttachmentDeleteCandidates(notes, accountId, workspaceId);

  const orphanAttachments = (
    await Promise.all(
      attachments.map(async (attachment) => {
        const otherReferenceCount = await prisma.notes.count({
          where: {
            id: { notIn: uniqueIds },
            accountId,
            workspaceId,
            OR: [
              { content: { contains: attachment.path } },
              { attachments: { some: { path: attachment.path } } },
            ],
          },
        });

        return otherReferenceCount === 0 ? {
          id: attachment.id,
          name: attachment.name,
          path: attachment.path,
          type: attachment.type,
        } : null;
      })
    )
  ).filter(Boolean);

  return {
    noteIds: uniqueIds,
    totalAttachments: attachments.length,
    orphanAttachments,
  };
};

export async function deleteNotes(ids: number[], ctx: Context, options: { deleteOrphanAttachments?: boolean } = {}) {
  const accountId = Number(ctx.id);
  const workspaceId = Number(ctx.workspaceId);
  const notes = await prisma.notes.findMany({
    where: { id: { in: ids }, accountId, workspaceId },
    include: { tags: { include: { tag: true } }, attachments: true, references: true, referencedBy: true },
  });
  const impact = await getDeleteImpact(ids, ctx);
  const orphanAttachmentIds = new Set(impact.orphanAttachments.map((attachment: any) => attachment.id));
  const attachmentCandidates = await getAttachmentDeleteCandidates(notes, accountId, workspaceId);
  const attachmentsToDelete = options.deleteOrphanAttachments
    ? attachmentCandidates.filter((attachment) => orphanAttachmentIds.has(attachment.id))
    : [];
  const attachmentIdsToDelete = new Set(attachmentsToDelete.map((attachment) => attachment.id));
  const uniqueAttachmentsToDelete = Array.from(new Map(attachmentsToDelete.map((attachment) => [attachment.path, attachment])).values());
  const failedAttachmentDeletes: { path: string; message: string }[] = [];

  for (const attachment of uniqueAttachmentsToDelete) {
    try {
      await FileService.deleteFile(attachment.path);
    } catch (error) {
      failedAttachmentDeletes.push({
        path: attachment.path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failedAttachmentDeletes.length) {
    const detail = failedAttachmentDeletes
      .slice(0, 3)
      .map((item) => `${item.path}: ${item.message}`)
      .join('; ');
    throw new Error(`部分资源文件删除失败，卡片未删除：${detail}`);
  }

  for (const note of notes) {
    await prisma.tagsToNote.deleteMany({ where: { noteId: note.id } });
    await prisma.noteReference.deleteMany({ where: { OR: [{ fromNoteId: note.id }, { toNoteId: note.id }] } });
    await prisma.comments.deleteMany({ where: { noteId: note.id } });

    const oldTagIds = note.tags.map((item) => item.tag?.id).filter((item): item is number => !!item);
    const usingTagIds = (await prisma.tagsToNote.findMany({
      where: {
        tagId: { in: oldTagIds },
        note: { accountId, workspaceId }
      }
    })).map((item) => item.tagId).filter(Boolean);
    const unusedTagIds = _.difference(oldTagIds, usingTagIds);
    if (unusedTagIds.length) await prisma.tag.deleteMany({ where: { id: { in: unusedTagIds }, accountId, workspaceId } });

    const attachmentsToKeep = (note.attachments || []).filter((attachment) => !attachmentIdsToDelete.has(attachment.id));
    if (attachmentsToKeep.length) await prisma.attachments.updateMany({ where: { id: { in: attachmentsToKeep.map((item) => item.id) } }, data: { noteId: null } });

    AiModelFactory.queryAndDeleteVectorById(note.id);
  }

  if (attachmentsToDelete.length) await prisma.attachments.deleteMany({ where: { id: { in: attachmentsToDelete.map((item) => item.id) } } });

  await prisma.noteHistory.deleteMany({ where: { noteId: { in: ids }, accountId, workspaceId } });
  await prisma.notes.deleteMany({ where: { id: { in: ids }, accountId, workspaceId } });
  return { ok: true };
}
