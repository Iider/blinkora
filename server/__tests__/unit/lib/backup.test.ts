import { afterEach, describe, expect, mock, test } from 'bun:test';
import AdmZip from 'adm-zip';
import fs from 'fs/promises';
import {
  BACKUP_MANIFEST,
  BACKUP_SCHEMA,
  exportBackupArchive,
  importBackupArchive,
} from '../../../lib/backup';

const date = new Date('2026-05-22T00:00:00.000Z');
const writtenZipFiles: string[] = [];

afterEach(async () => {
  for (const file of writtenZipFiles.splice(0)) {
    await fs.rm(file, { force: true }).catch(() => {});
  }
});

describe('backup export', () => {
  test('creates a full backup manifest with workspaces and attachment files', async () => {
    const fileService = {
      getFileBuffer: mock(async () => Buffer.from('image-bytes')),
      uploadFile: mock(),
      deleteFile: mock(),
    };
    const database = {
      workspaces: {
        findMany: mock(async () => [
          { id: 1, name: '默认工作区', description: '', icon: '', color: '', isDefault: true, createdAt: date, updatedAt: date },
          { id: 2, name: '资料库', description: '', icon: '', color: '', isDefault: false, createdAt: date, updatedAt: date },
        ]),
      },
      notes: {
        findMany: mock(async ({ where }: any) => where.workspaceId === 1
          ? [{
              id: 10,
              type: 0,
              content: 'hello #tag',
              isArchived: false,
              isRecycle: false,
              isTop: false,
              isReviewed: false,
              metadata: { source: 'test' },
              sortOrder: 0,
              createdAt: date,
              updatedAt: date,
              tags: [{ tagId: 20, tag: { id: 20, name: 'tag', parent: 0, icon: '' } }],
              attachments: [{ id: 30 }],
              references: [],
              referencedBy: [],
              comments: [],
            }]
          : []),
      },
      tag: {
        findMany: mock(async ({ where }: any) => where.workspaceId === 1
          ? [{ id: 20, name: 'tag', icon: '', parent: 0, sortOrder: 0, createdAt: date, updatedAt: date }]
          : []),
      },
      attachments: {
        findMany: mock(async ({ where }: any) => where.workspaceId === 1
          ? [{
              id: 30,
              name: 'photo.png',
              path: '/api/file/photo.png',
              size: { toString: () => '11' },
              type: 'image/png',
              noteId: 10,
              sortOrder: 0,
              perfixPath: '',
              depth: 0,
              metadata: null,
              createdAt: date,
              updatedAt: date,
            }]
          : []),
      },
      config: { findMany: mock(async () => []) },
      noteReference: { findMany: mock(async () => []) },
      comments: { findMany: mock(async () => []) },
      noteHistory: { findMany: mock(async () => []) },
    };

    const result = await exportBackupArchive({
      accountId: 1,
      scope: 'full',
      format: 'json',
      cleanupDelayMs: null,
      database,
      fileService,
    });
    writtenZipFiles.push(result.zipFilePath);

    const zip = new AdmZip(result.zipFilePath);
    const manifest = JSON.parse(zip.getEntry(BACKUP_MANIFEST)!.getData().toString('utf-8'));

    expect(manifest.schema).toBe(BACKUP_SCHEMA);
    expect(manifest.scope).toBe('full');
    expect(manifest.workspaceCount).toBe(2);
    expect(manifest.noteCount).toBe(1);
    expect(manifest.workspaces[0].attachments[0].fileRef).toBe('files/workspace-1/attachment-30/photo.png');
    expect(zip.getEntry('files/workspace-1/attachment-30/photo.png')!.getData().toString()).toBe('image-bytes');
  });
});

describe('backup import', () => {
  function createImportDatabase() {
    const state = {
      workspaces: [] as any[],
      tags: [] as any[],
      notes: [] as any[],
      tagRelations: [] as any[],
      attachments: [] as any[],
      references: [] as any[],
      comments: [] as any[],
      histories: [] as any[],
      configs: [] as any[],
    };
    let workspaceId = 100;
    let tagId = 200;
    let noteId = 300;
    let commentId = 400;

    const database: any = {
      $transaction: mock(async (fn: any) => fn(database)),
      workspaces: {
        create: mock(async ({ data }: any) => {
          const row = { id: workspaceId++, ...data };
          state.workspaces.push(row);
          return row;
        }),
      },
      tag: {
        create: mock(async ({ data }: any) => {
          const row = { id: tagId++, ...data };
          state.tags.push(row);
          return row;
        }),
        update: mock(async ({ where, data }: any) => {
          const row = state.tags.find((item) => item.id === where.id);
          Object.assign(row, data);
          return row;
        }),
      },
      notes: {
        create: mock(async ({ data }: any) => {
          const row = { id: noteId++, ...data };
          state.notes.push(row);
          return row;
        }),
      },
      tagsToNote: {
        createMany: mock(async ({ data }: any) => {
          state.tagRelations.push(...data);
          return { count: data.length };
        }),
      },
      attachments: {
        create: mock(async ({ data }: any) => {
          const row = { id: state.attachments.length + 1, ...data };
          state.attachments.push(row);
          return row;
        }),
      },
      noteReference: {
        createMany: mock(async ({ data }: any) => {
          state.references.push(...data);
          return { count: data.length };
        }),
      },
      comments: {
        create: mock(async ({ data }: any) => {
          const row = { id: commentId++, ...data };
          state.comments.push(row);
          return row;
        }),
        update: mock(async ({ where, data }: any) => {
          const row = state.comments.find((item) => item.id === where.id);
          Object.assign(row, data);
          return row;
        }),
      },
      noteHistory: {
        createMany: mock(async ({ data }: any) => {
          state.histories.push(...data);
          return { count: data.length };
        }),
      },
      config: {
        createMany: mock(async ({ data }: any) => {
          state.configs.push(...data);
          return { count: data.length };
        }),
      },
    };

    return { database, state };
  }

  function createBackupZip(scope: 'workspace' | 'full' = 'workspace') {
    const manifest = {
      schema: BACKUP_SCHEMA,
      app: 'blinkora',
      version: 1,
      exportedAt: date.toISOString(),
      scope,
      format: 'json',
      workspaceCount: 1,
      noteCount: 1,
      attachmentCount: 1,
      workspaces: [{
        id: 1,
        name: '来源工作区',
        description: '',
        icon: '',
        color: '',
        isDefault: true,
        configs: [{ id: 1, key: 'pageSize', config: { value: 30 } }],
        tags: [{ id: 2, name: 'parent', icon: '', parent: 0, sortOrder: 0 }],
        notes: [{
          id: 3,
          type: 0,
          content: 'restored ![](/api/file/original.png)',
          isArchived: false,
          isRecycle: false,
          isTop: true,
          isReviewed: false,
          metadata: null,
          sortOrder: 0,
          tagIds: [2],
          attachmentIds: [4],
          references: [],
          referencedBy: [],
        }],
        attachments: [{
          id: 4,
          name: 'original.png',
          path: '/api/file/original.png',
          size: '12',
          type: 'image/png',
          noteId: 3,
          sortOrder: 0,
          metadata: { alt: 'image' },
          fileRef: 'files/workspace-1/attachment-4/original.png',
        }],
        comments: [{
          id: 5,
          noteId: 3,
          content: 'private annotation',
          kind: 'annotation',
          status: 'open',
          parentId: null,
        }],
        noteReferences: [],
        noteHistory: [{ id: 6, noteId: 3, content: 'old content', metadata: null, version: 1 }],
      }],
    };
    const zip = new AdmZip();
    zip.addFile(BACKUP_MANIFEST, Buffer.from(JSON.stringify(manifest)));
    zip.addFile('files/workspace-1/attachment-4/original.png', Buffer.from('file'));
    return zip.toBuffer();
  }

  test('imports a workspace as a new workspace and remaps attachment paths', async () => {
    const { database, state } = createImportDatabase();
    const fileService = {
      getFileBuffer: mock(),
      uploadFile: mock(async () => ({ filePath: '/api/file/restored.png', fileName: 'restored.png' })),
      deleteFile: mock(async () => {}),
    };

    const result = await importBackupArchive({
      accountId: 9,
      mode: 'workspace',
      archiveBuffer: createBackupZip(),
      database,
      fileService,
    });

    expect(result.workspaceCount).toBe(1);
    expect(state.workspaces).toHaveLength(1);
    expect(state.workspaces[0].name).toContain('来源工作区');
    expect(state.workspaces[0].isDefault).toBe(false);
    expect(state.notes[0].content).toBe('restored ![](/api/file/restored.png)');
    expect(state.notes[0].workspaceId).toBe(state.workspaces[0].id);
    expect(state.attachments[0].path).toBe('/api/file/restored.png');
    expect(state.attachments[0].noteId).toBe(state.notes[0].id);
    expect(state.tagRelations[0]).toEqual({ noteId: state.notes[0].id, tagId: state.tags[0].id });
    expect(state.comments[0].noteId).toBe(state.notes[0].id);
    expect(state.histories[0].noteId).toBe(state.notes[0].id);
  });

  test('requires full restore mode for full backups', async () => {
    const { database } = createImportDatabase();
    await expect(importBackupArchive({
      accountId: 9,
      mode: 'workspace',
      archiveBuffer: createBackupZip('full'),
      database,
      fileService: {
        getFileBuffer: mock(),
        uploadFile: mock(),
        deleteFile: mock(),
      },
    })).rejects.toThrow('该文件是全量备份，请选择全量恢复');
  });
});
