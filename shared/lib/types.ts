import { z } from "zod";

export type JsonMap = Record<string, any>;

export type Tag = {
  id: number;
  name: string;
  icon?: string;
  parent?: number;
  accountId?: number | null;
  workspaceId?: number | null;
  sortOrder?: number;
  metadata?: JsonMap | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  [key: string]: any;
};

export type Attachment = {
  id?: number;
  name: string;
  path: string;
  size: number | string;
  type: string;
  noteId?: number | null;
  accountId?: number | null;
  workspaceId?: number | null;
  sortOrder?: number;
  perfixPath?: string | null;
  depth?: number | null;
  metadata?: JsonMap | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  [key: string]: any;
};

export type NoteReference = {
  id?: number;
  fromNoteId?: number;
  toNoteId?: number;
  fromId?: number;
  toId?: number;
  [key: string]: any;
};

export type Note = {
  id?: number;
  type?: number;
  content?: string;
  isArchived?: boolean;
  isRecycle?: boolean;
  isTop?: boolean;
  isReviewed?: boolean;
  accountId?: number | null;
  workspaceId?: number | null;
  sortOrder?: number;
  metadata?: JsonMap | null;
  attachments?: Attachment[];
  tags?: Tag[];
  references?: NoteReference[];
  referencedBy?: NoteReference[];
  comments?: JsonMap[];
  createdAt?: string | Date;
  updatedAt?: string | Date;
  [key: string]: any;
};

export type Config = Record<string, any>;

export type LinkInfo = {
  url?: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  [key: string]: any;
};

export type ResourceType = Attachment & {
  isFolder?: boolean;
  folderName?: string;
};
export enum NoteType {
  'BLINKORA',
  'NOTE',
  'TODO'
}
export function toNoteTypeEnum(v?: number, fallback: NoteType = NoteType.BLINKORA): NoteType {
  switch (v) {
    case 0:
      return NoteType.BLINKORA;
    case 1:
      return NoteType.NOTE;
    case 2:
      return NoteType.TODO;
    default:
      return fallback;
  }
}

export const ZUserPerferConfigKey = z.union([
  z.literal('textFoldLength'),
  z.literal('smallDeviceCardColumns'),
  z.literal('mediumDeviceCardColumns'),
  z.literal('largeDeviceCardColumns'),
  z.literal('timeFormat'),
  z.literal('isHiddenMobileBar'),
  z.literal('isOrderByCreateTime'),
  z.literal('language'),
  z.literal('theme'),
  z.literal('toolbarVisibility'),
  z.literal('twoFactorEnabled'),
  z.literal('twoFactorSecret'),
  z.literal('themeColor'),
  z.literal('themeForegroundColor'),
  z.literal('fontStyle'),
  z.literal('isCloseDailyReview'),
  z.literal('maxHomePageWidth'),
  z.literal('hidePcEditor'),
  z.literal('defaultHomePage'),
]);

export const ZConfigKey = z.union([
  z.literal('isAutoArchived'),
  z.literal('autoArchivedDays'),
  z.literal('embeddingModelId'),
  z.literal('embeddingDimensions'),
  z.literal('embeddingTopK'),
  z.literal('embeddingScore'),
  z.literal('excludeEmbeddingTagId'),
  z.literal('objectStorage'),
  z.literal('s3AccessKeyId'),
  z.literal('s3AccessKeySecret'),
  z.literal('s3Endpoint'),
  z.literal('s3Bucket'),
  z.literal('s3Region'),
  z.literal('s3CustomPath'),
  z.literal('s3ForcePathStyle'),
  z.literal('localCustomPath'),
  z.literal('isCloseBackgroundAnimation'),
  z.literal('customBackgroundUrl'),
  z.literal('signinFooterEnabled'),
  z.literal('signinFooterText'),
  z.literal('customTitle'),
  ZUserPerferConfigKey,
  z.any()
]);

export type ConfigKey = z.infer<typeof ZConfigKey>;

export const ZConfigSchema = z.object({
  isAutoArchived: z.boolean().optional(),
  autoArchivedDays: z.number().nullable().optional(),
  embeddingModelId: z.number().nullable().optional(),
  isHiddenMobileBar: z.boolean().optional(),
  toolbarVisibility: z.any().optional(),
  isCloseBackgroundAnimation: z.boolean().optional(),
  customBackgroundUrl: z.any().optional(),
  isOrderByCreateTime: z.any().optional(),
  timeFormat: z.any().optional(),
  smallDeviceCardColumns: z.any().optional(),
  mediumDeviceCardColumns: z.any().optional(),
  largeDeviceCardColumns: z.any().optional(),
  textFoldLength: z.number().nullable().optional(),
  objectStorage: z.any().optional(),
  s3AccessKeyId: z.any().optional(),
  s3AccessKeySecret: z.any().optional(),
  s3Endpoint: z.any().optional(),
  s3Bucket: z.any().optional(),
  s3CustomPath: z.any().optional(),
  s3Region: z.any().optional(),
  s3ForcePathStyle: z.any().optional(),
  localCustomPath: z.any().optional(),
  embeddingDimensions: z.number().nullable().optional(),
  embeddingTopK: z.number().nullable().optional(),
  embeddingScore: z.number().nullable().optional(),
  excludeEmbeddingTagId: z.number().nullable().optional(),
  language: z.any().optional(),
  theme: z.any().optional(),
  themeColor: z.any().optional(),
  themeForegroundColor: z.any().optional(),
  twoFactorEnabled: z.boolean().optional(),
  twoFactorSecret: z.string().optional(),
  isCloseDailyReview: z.boolean().optional(),
  maxHomePageWidth: z.number().nullable().optional(),
  hidePcEditor: z.boolean().optional(),
  defaultHomePage: z.string().optional(),
  fontStyle: z.string().optional(),
  signinFooterEnabled: z.boolean().optional(),
  signinFooterText: z.string().optional(),
  customTitle: z.string().optional()
});

export type GlobalConfig = z.infer<typeof ZConfigSchema>;

export type ProgressResult = {
  type: 'success' | 'skip' | 'error' | 'info';
  content?: string;
  error?: unknown;
}
