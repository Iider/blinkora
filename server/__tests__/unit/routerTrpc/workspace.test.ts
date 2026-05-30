import { describe, expect, mock, test } from 'bun:test';
import { deleteWorkspaceForAccount } from '../../../routerTrpc/workspace';

function createDeleteWorkspaceDatabase(workspace: any) {
  const order: string[] = [];
  const record = (name: string) => mock(async () => {
    order.push(name);
    return { count: 1 };
  });

  const tx = {
    comments: { deleteMany: record('comments') },
    noteHistory: { deleteMany: record('noteHistory') },
    noteReference: { deleteMany: record('noteReference') },
    tagsToNote: { deleteMany: record('tagsToNote') },
    attachments: { deleteMany: record('attachments') },
    tag: { deleteMany: record('tag') },
    notes: { deleteMany: record('notes') },
    config: { deleteMany: record('config') },
    workspaces: {
      delete: mock(async () => {
        order.push('workspaces');
        return workspace;
      }),
    },
  };

  const database: any = {
    workspaces: {
      findFirst: mock(async () => workspace),
    },
    attachments: {
      findMany: mock(async () => [
        { path: '/api/file/private.png', name: 'private.png', type: 'image/png' },
        { path: '/api/file/shared.png', name: 'shared.png', type: 'image/png' },
        { path: '/api/file/folder', name: '.folder', type: 'folder' },
      ]),
      count: mock(async ({ where }: any) => where.path === '/api/file/shared.png' ? 1 : 0),
    },
    notes: {
      count: mock(async () => 0),
    },
    $transaction: mock(async (fn: any) => fn(tx)),
  };

  return { database, order };
}

describe('workspace delete', () => {
  test('deletes a non-default workspace and only removes private attachment files', async () => {
    const { database, order } = createDeleteWorkspaceDatabase({
      id: 2,
      accountId: 1,
      isDefault: false,
    });
    const fileService = {
      deletePhysicalFile: mock(async () => {}),
    };

    const result = await deleteWorkspaceForAccount({
      accountId: 1,
      workspaceId: 2,
      database,
      fileService,
    });

    expect(result).toEqual({ success: true });
    expect(fileService.deletePhysicalFile).toHaveBeenCalledTimes(1);
    expect(fileService.deletePhysicalFile.mock.calls[0][0]).toBe('/api/file/private.png');
    expect(order).toEqual([
      'comments',
      'noteHistory',
      'noteReference',
      'tagsToNote',
      'attachments',
      'tag',
      'notes',
      'config',
      'workspaces',
    ]);
  });

  test('rejects deleting the default workspace', async () => {
    const { database } = createDeleteWorkspaceDatabase({
      id: 1,
      accountId: 1,
      isDefault: true,
    });

    await expect(deleteWorkspaceForAccount({
      accountId: 1,
      workspaceId: 1,
      database,
      fileService: { deletePhysicalFile: mock(async () => {}) },
    })).rejects.toThrow('不能删除默认工作区');

    expect(database.$transaction).not.toHaveBeenCalled();
  });

  test('rejects deleting a workspace outside the current account', async () => {
    const { database } = createDeleteWorkspaceDatabase(null);

    await expect(deleteWorkspaceForAccount({
      accountId: 1,
      workspaceId: 9,
      database,
      fileService: { deletePhysicalFile: mock(async () => {}) },
    })).rejects.toThrow('工作区不存在');

    expect(database.$transaction).not.toHaveBeenCalled();
  });

  test('stops before database deletion when attachment file deletion fails', async () => {
    const { database } = createDeleteWorkspaceDatabase({
      id: 2,
      accountId: 1,
      isDefault: false,
    });
    const fileService = {
      deletePhysicalFile: mock(async () => {
        throw new Error('disk busy');
      }),
    };

    await expect(deleteWorkspaceForAccount({
      accountId: 1,
      workspaceId: 2,
      database,
      fileService,
    })).rejects.toThrow('部分资源文件删除失败，工作区未删除');

    expect(database.$transaction).not.toHaveBeenCalled();
  });
});
