import { Prisma } from '@prisma/client';
import { z } from 'zod';

/////////////////////////////////////////
// ACCOUNTS SCHEMA
/////////////////////////////////////////

export const accountsSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  nickname: z.string(),
  password: z.string(),
  image: z.string(),
  apiToken: z.string(),
  description: z.string(),
  note: z.number().int(),
  role: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type accounts = z.infer<typeof accountsSchema>;

/////////////////////////////////////////
// ATTACHMENTS SCHEMA
/////////////////////////////////////////

export const attachmentsSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  path: z.string(),
  size: z.any(),
  type: z.string(),
  noteId: z.number().int().nullable(),
  accountId: z.number().int().nullable(),
  sortOrder: z.number().int(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  perfixPath: z.string().nullable().optional(),
  depth: z.number().int().nullable().optional(),
  metadata: z.any().nullable().optional(),
});

export type attachments = z.infer<typeof attachmentsSchema>;

/////////////////////////////////////////
// CONFIG SCHEMA
/////////////////////////////////////////

export const configSchema = z.object({
  id: z.number().int(),
  key: z.string(),
  config: z.any().nullable().optional(),
  userId: z.number().int().nullable().optional(),
});

export type config = z.infer<typeof configSchema>;

/////////////////////////////////////////
// NOTES SCHEMA
/////////////////////////////////////////

export const notesSchema = z.object({
  id: z.number().int(),
  type: z.number().int(),
  content: z.string(),
  isArchived: z.boolean(),
  isRecycle: z.boolean(),
  isTop: z.boolean(),
  isReviewed: z.boolean(),
  metadata: z.any().nullable().optional(),
  sortOrder: z.number().int(),
  accountId: z.number().int().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type notes = z.infer<typeof notesSchema>;

/////////////////////////////////////////
// COMMENTS SCHEMA
/////////////////////////////////////////

export const commentsSchema = z.object({
  id: z.number().int(),
  content: z.string(),
  kind: z.string(),
  status: z.string(),
  metadata: z.any().nullable().optional(),
  accountId: z.number().int().nullable(),
  noteId: z.number().int(),
  parentId: z.number().int().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type comments = z.infer<typeof commentsSchema>;

/////////////////////////////////////////
// TAG SCHEMA
/////////////////////////////////////////

export const tagSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  icon: z.string(),
  parent: z.number().int(),
  accountId: z.number().int().nullable().optional(),
  sortOrder: z.number().int(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type tag = z.infer<typeof tagSchema>;

/////////////////////////////////////////
// TAGS TO NOTE SCHEMA
/////////////////////////////////////////

export const tagsToNoteSchema = z.object({
  id: z.number().int(),
  noteId: z.number().int(),
  tagId: z.number().int(),
});

export type tagsToNote = z.infer<typeof tagsToNoteSchema>;

/////////////////////////////////////////
// SELECT & INCLUDE
/////////////////////////////////////////

export const accountsSelectSchema: z.ZodType<Prisma.accountsSelect> = z.object({
  id: z.boolean().optional(),
  name: z.boolean().optional(),
  nickname: z.boolean().optional(),
  password: z.boolean().optional(),
  image: z.boolean().optional(),
  apiToken: z.boolean().optional(),
  description: z.boolean().optional(),
  note: z.boolean().optional(),
  role: z.boolean().optional(),
  createdAt: z.boolean().optional(),
  updatedAt: z.boolean().optional(),
}).strict();

export const configSelectSchema: z.ZodType<Prisma.configSelect> = z.object({
  id: z.boolean().optional(),
  key: z.boolean().optional(),
  config: z.boolean().optional(),
  userId: z.boolean().optional(),
}).strict();

export const commentsSelectSchema: z.ZodType<Prisma.commentsSelect> = z.object({
  id: z.boolean().optional(),
  content: z.boolean().optional(),
  kind: z.boolean().optional(),
  status: z.boolean().optional(),
  metadata: z.boolean().optional(),
  accountId: z.boolean().optional(),
  noteId: z.boolean().optional(),
  parentId: z.boolean().optional(),
  createdAt: z.boolean().optional(),
  updatedAt: z.boolean().optional(),
  account: z.boolean().optional(),
  note: z.boolean().optional(),
  parent: z.boolean().optional(),
  replies: z.boolean().optional(),
}).strict();

export const commentsIncludeSchema: z.ZodType<Prisma.commentsInclude> = z.object({
  account: z.boolean().optional(),
  note: z.boolean().optional(),
  parent: z.boolean().optional(),
  replies: z.boolean().optional(),
}).strict();

export const aiProvidersSelectSchema: z.ZodType<Prisma.aiProvidersSelect> = z.object({
  id: z.boolean().optional(),
  title: z.boolean().optional(),
  provider: z.boolean().optional(),
  baseURL: z.boolean().optional(),
  apiKey: z.boolean().optional(),
  config: z.boolean().optional(),
  sortOrder: z.boolean().optional(),
  createdAt: z.boolean().optional(),
  updatedAt: z.boolean().optional(),
  models: z.boolean().optional(),
}).strict();

export const aiProvidersIncludeSchema: z.ZodType<Prisma.aiProvidersInclude> = z.object({
  models: z.boolean().optional(),
}).strict();

export const aiModelsSelectSchema: z.ZodType<Prisma.aiModelsSelect> = z.object({
  id: z.boolean().optional(),
  providerId: z.boolean().optional(),
  title: z.boolean().optional(),
  modelKey: z.boolean().optional(),
  capabilities: z.boolean().optional(),
  config: z.boolean().optional(),
  sortOrder: z.boolean().optional(),
  createdAt: z.boolean().optional(),
  updatedAt: z.boolean().optional(),
  provider: z.boolean().optional(),
}).strict();

export const aiModelsIncludeSchema: z.ZodType<Prisma.aiModelsInclude> = z.object({
  provider: z.boolean().optional(),
}).strict();

/////////////////////////////////////////
// NOTE REFERENCE
/////////////////////////////////////////

export const noteReferenceSchema = z.object({
  id: z.number().int(),
  fromNoteId: z.number().int(),
  toNoteId: z.number().int(),
  createdAt: z.coerce.date(),
});

export type noteReference = z.infer<typeof noteReferenceSchema>;

/////////////////////////////////////////
// CACHE SCHEMA
/////////////////////////////////////////

export const cacheSchema = z.object({
  id: z.number().int(),
  key: z.string(),
  value: z.any(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type cache = z.infer<typeof cacheSchema>;

/////////////////////////////////////////
// HISTORY SCHEMA
/////////////////////////////////////////

export const historySchema = z.object({
  id: z.number().int(),
  content: z.string(),
  metadata: z.any().nullable().optional(),
  noteId: z.number().int(),
  createdAt: z.coerce.date(),
  version: z.number().int(),
  accountId: z.number().int().nullable(),
});

export type history = z.infer<typeof historySchema>;

/////////////////////////////////////////
// AI PROVIDERS SCHEMA
/////////////////////////////////////////

export const aiProvidersSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  provider: z.string(),
  baseURL: z.string().nullable().optional(),
  apiKey: z.string().nullable().optional(),
  config: z.any().nullable().optional(),
  sortOrder: z.number().int(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type aiProviders = z.infer<typeof aiProvidersSchema>;

/////////////////////////////////////////
// AI MODELS SCHEMA
/////////////////////////////////////////

export const aiModelsSchema = z.object({
  id: z.number().int(),
  providerId: z.number().int(),
  title: z.string(),
  modelKey: z.string(),
  capabilities: z.any(),
  config: z.any().nullable().optional(),
  sortOrder: z.number().int(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type aiModels = z.infer<typeof aiModelsSchema>;
