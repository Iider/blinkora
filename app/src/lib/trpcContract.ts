import type { GlobalConfig, LinkInfo, Note, ResourceType, Tag } from '@shared/lib/types';

/**
 * 前端只消费 Rust 实现的 tRPC 兼容接口，无法再从 TypeScript 服务端路由推导类型。
 * 这里显式维护 procedure 名称、调用方式和返回值；输入仍由 Rust 在运行时校验。
 */
export type TrpcProcedureOptions = {
  context?: Record<string, unknown>;
  signal?: AbortSignal;
};

type QueryProcedure<TOutput = unknown, TInput = unknown> = {
  query(input?: TInput, options?: TrpcProcedureOptions): Promise<TOutput>;
};

type MutationProcedure<TOutput = unknown, TInput = unknown> = {
  mutate(input?: TInput, options?: TrpcProcedureOptions): Promise<TOutput>;
};

type ProcedureSpec = {
  kind: 'query' | 'mutation';
  output: unknown;
  input: unknown;
};

type Query<TOutput = unknown, TInput = unknown> = {
  kind: 'query';
  output: TOutput;
  input: TInput;
};

type Mutation<TOutput = unknown, TInput = unknown> = {
  kind: 'mutation';
  output: TOutput;
  input: TInput;
};

type ProcedureMap<T extends Record<string, ProcedureSpec>> = {
  [K in keyof T]: T[K] extends ProcedureSpec
    ? T[K]['kind'] extends 'query'
      ? QueryProcedure<T[K]['output'], T[K]['input']>
      : MutationProcedure<T[K]['output'], T[K]['input']>
    : never;
};

export type ApiAccount = {
  id: number;
  name: string;
  nickname: string;
  image: string;
  role: string;
  token?: string;
  requiresTwoFactor?: boolean;
};

export type ApiAnnotation = {
  id: number;
  content: string;
  createdAt: string;
  account?: Pick<ApiAccount, 'image' | 'name' | 'nickname'> | null;
  replies?: ApiAnnotation[];
};

export type ApiFont = {
  id: number;
  name: string;
  displayName: string;
  url: string | null;
  isLocal: boolean;
  weights: number[];
  category: string;
  isSystem: boolean;
  sortOrder: number;
};

export type ApiHistoryItem = {
  id: number;
  version: number;
  content: string;
  createdAt: Date;
  metadata: Record<string, unknown> | null;
};

export type ApiWorkspace = {
  id: number;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  accountId: number;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type ApiAgentToken = {
  id: number;
  name: string;
  workspaceId: number;
  workspaceName: string;
  expiresAt?: string | null;
  revokedAt?: string | null;
  lastUsedAt?: string | null;
  createdAt?: string | null;
  token?: string;
};

type NoteListResponse = Note[] | {
  items: Note[];
  total: number;
  page: number;
  size: number;
};

type SuccessResult = {
  success: boolean;
};

export type BlinkoraTrpcClient = {
  agentTokens: ProcedureMap<{
    list: Query<ApiAgentToken[]>;
    create: Mutation<ApiAgentToken>;
    revoke: Mutation<ApiAgentToken>;
  }>;
  attachments: ProcedureMap<{
    list: Query<ResourceType[]>;
    createFolder: Mutation<SuccessResult & { folderName: string; folderPath: string }>;
    rename: Mutation<SuccessResult>;
    move: Mutation<SuccessResult>;
    delete: Mutation<SuccessResult>;
    deleteMany: Mutation<SuccessResult>;
  }>;
  comments: ProcedureMap<{
    list: Query<ApiAnnotation[]>;
    create: Mutation<ApiAnnotation>;
    update: Mutation<ApiAnnotation>;
    delete: Mutation<{ ok: boolean }>;
    convertToTodo: Mutation<Note>;
  }>;
  config: ProcedureMap<{
    list: Query<GlobalConfig>;
    update: Mutation<GlobalConfig>;
    saveAndValidateS3: Mutation<SuccessResult & {
      message?: string;
      objectStorage: 'local' | 's3';
      normalizedCustomPath: string;
    }>;
  }>;
  fonts: ProcedureMap<{
    list: Query<ApiFont[]>;
    getByName: Query<ApiFont | null>;
    getFontData: Query<{ name: string; fileData: string | null }>;
    create: Mutation<ApiFont>;
    update: Mutation<ApiFont>;
    delete: Mutation<SuccessResult>;
    upload: Mutation<ApiFont>;
  }>;
  notes: ProcedureMap<{
    list: Mutation<NoteListResponse>;
    listByIds: Mutation<Note[]>;
    detail: Mutation<Note | null>;
    dailyReviewNoteList: Query<Note[]>;
    randomNoteList: Query<Note[]>;
    reviewNote: Mutation<Note>;
    upsert: Mutation<Note>;
    moveToWorkspace: Mutation<Note[]>;
    updateMany: Mutation<Note[]>;
    trashMany: Mutation<Note[]>;
    deleteMany: Mutation<SuccessResult>;
    deleteImpact: Mutation<{ orphanAttachments: ResourceType[] }>;
    getNoteHistory: Query<ApiHistoryItem[]>;
    getNoteVersion: Query<ApiHistoryItem | null>;
    noteReferenceList: Mutation<Note[]>;
    addReference: Mutation<SuccessResult>;
    removeReference: Mutation<SuccessResult>;
    setReferences: Mutation<SuccessResult>;
    clearRecycleBin: Mutation<SuccessResult>;
    updateAttachmentsOrder: Mutation<SuccessResult>;
    updateNotesOrder: Mutation<SuccessResult>;
  }>;
  operationLogs: ProcedureMap<{
    list: Query<{ items: Record<string, unknown>[]; total: number }>;
  }>;
  system: ProcedureMap<{
    linkPreview: Query<LinkInfo>;
    serverVersion: Query<string>;
  }>;
  tags: ProcedureMap<{
    list: Query<Tag[]>;
    fullTagNameById: Query<string>;
    cleanupOrphanTags: Mutation<SuccessResult>;
    updateTagMany: Mutation<Tag[]>;
    updateTagName: Mutation<Tag>;
    updateTagIcon: Mutation<Tag>;
    deleteOnlyTag: Mutation<SuccessResult>;
    deleteTagWithAllNote: Mutation<SuccessResult>;
    updateTagOrder: Mutation<Tag[]>;
  }>;
  task: ProcedureMap<{
    exportMarkdown: Mutation<{ downloadUrl: string }>;
  }>;
  users: ProcedureMap<{
    detail: Query<ApiAccount>;
    nativeAccountList: Query<ApiAccount[]>;
    canRegister: Mutation<boolean>;
    login: Mutation<ApiAccount>;
    register: Mutation<ApiAccount & SuccessResult>;
    regenToken: Mutation<{ token: string }>;
    upsertUser: Mutation<ApiAccount>;
    linkAccount: Mutation<SuccessResult>;
    generate2FASecret: Mutation<{ qrCode: string; secret: string }>;
    verify2FAToken: Mutation<SuccessResult>;
  }>;
  workspaces: ProcedureMap<{
    list: Query<ApiWorkspace[]>;
    getDefault: Query<ApiWorkspace>;
    create: Mutation<ApiWorkspace>;
    update: Mutation<ApiWorkspace>;
    delete: Mutation<SuccessResult & { deletedAttachmentFiles: number }>;
    setDefault: Mutation<SuccessResult>;
  }>;
};
