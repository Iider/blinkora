import AdmZip from 'adm-zip';
import path from 'path';
import fs from 'fs/promises';
import { prisma } from '../prisma';
import { TEMP_PATH, UPLOAD_FILE_PATH } from '@shared/lib/pathConstant';
import { FileService } from './files';

export const BACKUP_SCHEMA = 'blinkora.backup.v1';
export const BACKUP_MANIFEST = 'manifest.json';

export type BackupScope = 'workspace' | 'full';
export type BackupFormat = 'markdown' | 'json';
export type ImportMode = 'workspace' | 'full';

type BackupDatabase = any;
type BackupFileService = Pick<typeof FileService, 'getFileBuffer' | 'uploadFile' | 'deleteFile'>;

export type ExportBackupOptions = {
  accountId: number;
  workspaceId?: number;
  scope: BackupScope;
  format: BackupFormat;
  startDate?: Date;
  endDate?: Date;
  cleanupDelayMs?: number | null;
  database?: BackupDatabase;
  fileService?: BackupFileService;
};

export type ImportBackupOptions = {
  accountId: number;
  mode: ImportMode;
  archiveBuffer: Buffer;
  database?: BackupDatabase;
  fileService?: BackupFileService;
};

const safeFilePart = (value: string) => value
  .replace(/[\\/:*?"<>|#\n\r\t]/g, '-')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 80) || 'untitled';

const typeLabel = (type: number) => {
  if (type === 1) return 'note';
  if (type === 2) return 'todo';
  return 'blinkora';
};

const toIsoString = (value?: Date | string | null) => {
  if (!value) return null;
  return new Date(value).toISOString();
};

const toDateOrUndefined = (value?: Date | string | null) => {
  if (!value) return undefined;
  return new Date(value);
};

const normalizeId = (value: unknown) => Number(value || 0);

const isRestorableFileAttachment = (attachment: any) => {
  if (!attachment?.path) return false;
  if (attachment.type === 'folder' || attachment.name === '.folder') return false;
  return attachment.path.startsWith('/api/file/') || attachment.path.startsWith('/api/s3file/');
};

const makeDownloadUrl = (zipFilePath: string) => {
  const relative = zipFilePath.replace(UPLOAD_FILE_PATH, '').replace(/\\/g, '/');
  return `/api/file${relative.startsWith('/') ? relative : `/${relative}`}`;
};

const replaceAttachmentPaths = (content: string, pathMap: Map<string, string>) => {
  let nextContent = content;
  for (const [oldPath, newPath] of pathMap.entries()) {
    nextContent = nextContent.split(oldPath).join(newPath);
  }
  return nextContent;
};

const buildImportedWorkspaceName = (name?: string) => {
  const baseName = (name || '导入工作区').trim() || '导入工作区';
  const suffix = new Date().toISOString().replace('T', ' ').slice(0, 16);
  return `${baseName}（导入 ${suffix}）`.slice(0, 100);
};

async function collectWorkspaceBackup({
  accountId,
  workspace,
  startDate,
  endDate,
  database,
}: {
  accountId: number;
  workspace: any;
  startDate?: Date;
  endDate?: Date;
  database: BackupDatabase;
}) {
  const noteWhere = {
    accountId,
    workspaceId: workspace.id,
    ...(startDate || endDate
      ? {
          createdAt: {
            ...(startDate && { gte: startDate }),
            ...(endDate && { lte: endDate }),
          },
        }
      : {}),
  };

  const notes = await database.notes.findMany({
    where: noteWhere,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: {
      tags: { include: { tag: true } },
      attachments: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
      references: true,
      referencedBy: true,
      comments: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    },
  });
  const noteIds = notes.map((note: any) => note.id);

  const [tags, attachments, configs, noteReferences, comments, noteHistory] = await Promise.all([
    database.tag.findMany({
      where: { accountId, workspaceId: workspace.id },
      orderBy: [{ parent: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
    }),
    database.attachments.findMany({
      where: { accountId, workspaceId: workspace.id },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    }),
    database.config.findMany({
      where: { userId: accountId, workspaceId: workspace.id },
      orderBy: [{ id: 'asc' }],
    }),
    noteIds.length
      ? database.noteReference.findMany({
          where: { fromNoteId: { in: noteIds }, toNoteId: { in: noteIds } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      : [],
    noteIds.length
      ? database.comments.findMany({
          where: { noteId: { in: noteIds }, workspaceId: workspace.id },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      : [],
    noteIds.length
      ? database.noteHistory.findMany({
          where: { noteId: { in: noteIds }, accountId, workspaceId: workspace.id },
          orderBy: [{ noteId: 'asc' }, { version: 'asc' }, { id: 'asc' }],
        })
      : [],
  ]);

  const selectedNoteIdSet = new Set(noteIds);
  const noteReferencePairs = new Set(noteReferences.map((reference: any) => `${reference.fromNoteId}:${reference.toNoteId}`));

  return {
    id: workspace.id,
    name: workspace.name,
    description: workspace.description,
    icon: workspace.icon,
    color: workspace.color,
    isDefault: workspace.isDefault,
    createdAt: toIsoString(workspace.createdAt),
    updatedAt: toIsoString(workspace.updatedAt),
    configs: configs.map((item: any) => ({
      id: item.id,
      key: item.key,
      config: item.config,
    })),
    tags: tags.map((tag: any) => ({
      id: tag.id,
      name: tag.name,
      icon: tag.icon,
      parent: tag.parent,
      sortOrder: tag.sortOrder,
      createdAt: toIsoString(tag.createdAt),
      updatedAt: toIsoString(tag.updatedAt),
    })),
    notes: notes.map((note: any) => ({
      id: note.id,
      type: note.type,
      typeLabel: typeLabel(note.type),
      content: note.content,
      isArchived: note.isArchived,
      isRecycle: note.isRecycle,
      isTop: note.isTop,
      isReviewed: note.isReviewed,
      metadata: note.metadata,
      sortOrder: note.sortOrder,
      createdAt: toIsoString(note.createdAt),
      updatedAt: toIsoString(note.updatedAt),
      tagIds: note.tags.map((item: any) => item.tagId ?? item.tag?.id).filter(Boolean),
      tags: note.tags.map((item: any) => ({
        id: item.tag?.id ?? item.tagId,
        name: item.tag?.name,
        parent: item.tag?.parent ?? 0,
        icon: item.tag?.icon ?? '',
      })),
      attachmentIds: note.attachments.map((attachment: any) => attachment.id),
      references: note.references
        .filter((reference: any) => selectedNoteIdSet.has(reference.toNoteId) && noteReferencePairs.has(`${note.id}:${reference.toNoteId}`))
        .map((reference: any) => reference.toNoteId),
      referencedBy: note.referencedBy
        .filter((reference: any) => selectedNoteIdSet.has(reference.fromNoteId) && noteReferencePairs.has(`${reference.fromNoteId}:${note.id}`))
        .map((reference: any) => reference.fromNoteId),
    })),
    attachments: attachments.map((attachment: any) => ({
      id: attachment.id,
      name: attachment.name,
      path: attachment.path,
      size: attachment.size?.toString?.() ?? String(attachment.size ?? 0),
      type: attachment.type,
      noteId: attachment.noteId,
      sortOrder: attachment.sortOrder,
      perfixPath: attachment.perfixPath,
      depth: attachment.depth,
      metadata: attachment.metadata,
      createdAt: toIsoString(attachment.createdAt),
      updatedAt: toIsoString(attachment.updatedAt),
    })),
    comments: comments.map((comment: any) => ({
      id: comment.id,
      noteId: comment.noteId,
      content: comment.content,
      kind: comment.kind,
      status: comment.status,
      metadata: comment.metadata,
      parentId: comment.parentId,
      createdAt: toIsoString(comment.createdAt),
      updatedAt: toIsoString(comment.updatedAt),
    })),
    noteReferences: noteReferences.map((reference: any) => ({
      id: reference.id,
      fromNoteId: reference.fromNoteId,
      toNoteId: reference.toNoteId,
      createdAt: toIsoString(reference.createdAt),
    })),
    noteHistory: noteHistory.map((history: any) => ({
      id: history.id,
      noteId: history.noteId,
      content: history.content,
      metadata: history.metadata,
      version: history.version,
      createdAt: toIsoString(history.createdAt),
    })),
  };
}

function addMarkdownFiles(zip: AdmZip, workspace: any) {
  const workspaceDir = safeFilePart(workspace.name || `workspace-${workspace.id}`);
  const tagMap = new Map((workspace.tags || []).map((tag: any) => [tag.id, tag]));
  const attachmentMap = new Map((workspace.attachments || []).map((attachment: any) => [attachment.id, attachment]));
  const commentsByNoteId = new Map<number, any[]>();

  for (const comment of workspace.comments || []) {
    const list = commentsByNoteId.get(comment.noteId) || [];
    list.push(comment);
    commentsByNoteId.set(comment.noteId, list);
  }

  for (const note of workspace.notes || []) {
    const title = safeFilePart(note.content.split('\n').find(Boolean) || `${note.typeLabel}-${note.id}`);
    const fileName = `${String(note.id).padStart(6, '0')}-${title}.md`;
    const tags = (note.tagIds || []).map((id: number) => tagMap.get(id)).filter(Boolean);
    const attachments = (note.attachmentIds || []).map((id: number) => attachmentMap.get(id)).filter(Boolean);
    const comments = commentsByNoteId.get(note.id) || [];
    const lines = [
      '---',
      `id: ${note.id}`,
      `type: ${note.typeLabel}`,
      `createdAt: ${note.createdAt}`,
      `updatedAt: ${note.updatedAt}`,
      `archived: ${note.isArchived}`,
      `reviewed: ${note.isReviewed}`,
      `tags: [${tags.map((tag: any) => JSON.stringify(tag.name)).join(', ')}]`,
      `references: [${(note.references || []).join(', ')}]`,
      '---',
      '',
      note.content,
      '',
    ];

    if (attachments.length) {
      lines.push('## Attachments', '');
      for (const attachment of attachments) {
        lines.push(`- ${attachment.name} (${attachment.type || 'file'}): ${attachment.path}`);
      }
      lines.push('');
    }

    if (comments.length) {
      lines.push('## Annotations', '');
      for (const comment of comments) {
        lines.push(`- [${comment.kind}/${comment.status}] ${comment.content.replace(/\n/g, ' ')}`);
      }
      lines.push('');
    }

    if (note.metadata && Object.keys(note.metadata).length > 0) {
      lines.push('## Metadata', '', '```json', JSON.stringify(note.metadata, null, 2), '```', '');
    }

    zip.addFile(`notes/${workspaceDir}/${fileName}`, Buffer.from(lines.join('\n')));
  }
}

async function addAttachmentFiles(zip: AdmZip, manifest: any, fileService: BackupFileService) {
  let missingFileCount = 0;
  let attachmentFileCount = 0;

  for (const workspace of manifest.workspaces) {
    for (const attachment of workspace.attachments || []) {
      if (!isRestorableFileAttachment(attachment)) continue;

      const fileName = safeFilePart(attachment.name || path.basename(attachment.path));
      const fileRef = `files/workspace-${workspace.id}/attachment-${attachment.id}/${fileName}`;
      try {
        const buffer = await fileService.getFileBuffer(attachment.path);
        zip.addFile(fileRef, buffer);
        attachment.fileRef = fileRef;
        attachmentFileCount += 1;
      } catch (error) {
        attachment.fileMissing = true;
        attachment.fileError = error instanceof Error ? error.message : String(error);
        missingFileCount += 1;
      }
    }
  }

  manifest.attachmentFileCount = attachmentFileCount;
  manifest.missingFileCount = missingFileCount;
}

export async function exportBackupArchive(options: ExportBackupOptions) {
  const database = options.database || prisma;
  const fileService = options.fileService || FileService;
  const cleanupDelayMs = options.cleanupDelayMs === undefined ? 5 * 60 * 1000 : options.cleanupDelayMs;
  const accountId = Number(options.accountId);

  const workspaces = options.scope === 'workspace'
    ? await database.workspaces.findMany({
        where: { id: Number(options.workspaceId), accountId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
    : await database.workspaces.findMany({
        where: { accountId },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });

  if (options.scope === 'workspace' && !workspaces.length) {
    throw new Error('工作区不存在或无权导出');
  }

  if (options.scope === 'full' && !workspaces.length) {
    throw new Error('没有可导出的工作区');
  }

  const backupWorkspaces: any[] = [];
  for (const workspace of workspaces) {
    backupWorkspaces.push(await collectWorkspaceBackup({
      accountId,
      workspace,
      startDate: options.startDate,
      endDate: options.endDate,
      database,
    }));
  }

  const manifest = {
    schema: BACKUP_SCHEMA,
    app: 'blinkora',
    version: 1,
    exportedAt: new Date().toISOString(),
    scope: options.scope,
    format: options.format,
    dateRange: {
      startDate: toIsoString(options.startDate),
      endDate: toIsoString(options.endDate),
    },
    count: backupWorkspaces.reduce((count, workspace) => count + (workspace.notes?.length || 0), 0),
    workspaceCount: backupWorkspaces.length,
    noteCount: backupWorkspaces.reduce((count, workspace) => count + (workspace.notes?.length || 0), 0),
    attachmentCount: backupWorkspaces.reduce((count, workspace) => count + (workspace.attachments?.length || 0), 0),
    attachmentFileCount: 0,
    missingFileCount: 0,
    workspaces: backupWorkspaces,
  };

  const zip = new AdmZip();
  await addAttachmentFiles(zip, manifest, fileService);
  zip.addFile(BACKUP_MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2)));

  if (options.format === 'json') {
    zip.addFile('backup.json', Buffer.from(JSON.stringify(manifest, null, 2)));
    if (options.scope === 'workspace' && manifest.workspaces.length === 1) {
      zip.addFile('notes.json', Buffer.from(JSON.stringify(manifest.workspaces[0].notes, null, 2)));
    }
  } else {
    for (const workspace of manifest.workspaces) {
      addMarkdownFiles(zip, workspace);
    }
  }

  await fs.mkdir(TEMP_PATH, { recursive: true });
  const exportId = Date.now();
  const filePrefix = options.scope === 'full' ? 'blinkora_full_backup' : 'blinkora_workspace_export';
  const zipFilePath = path.join(TEMP_PATH, `${filePrefix}_${exportId}.zip`);
  zip.writeZip(zipFilePath);

  if (cleanupDelayMs !== null) {
    setTimeout(() => {
      fs.rm(zipFilePath, { force: true }).catch(() => {});
    }, cleanupDelayMs);
  }

  return {
    success: true,
    downloadUrl: makeDownloadUrl(zipFilePath),
    zipFilePath,
    fileCount: manifest.noteCount,
    workspaceCount: manifest.workspaceCount,
    attachmentCount: manifest.attachmentCount,
    missingFileCount: manifest.missingFileCount,
    scope: options.scope,
  };
}

function normalizeLegacyWorkspaceManifest(manifest: any) {
  if (manifest?.schema === BACKUP_SCHEMA && Array.isArray(manifest.workspaces)) {
    return manifest;
  }

  if (!Array.isArray(manifest?.notes)) {
    throw new Error('不是有效的 Blinkora 备份文件');
  }

  const tags = new Map<number, any>();
  const attachments = new Map<number, any>();
  const comments: any[] = [];

  for (const note of manifest.notes) {
    for (const tag of note.tags || []) {
      if (tag.id) tags.set(tag.id, { ...tag, sortOrder: 0 });
    }
    for (const attachment of note.attachments || []) {
      if (attachment.id) attachments.set(attachment.id, { ...attachment, noteId: note.id, sortOrder: 0 });
    }
    for (const comment of note.comments || []) {
      comments.push({ ...comment, noteId: note.id });
    }
  }

  return {
    schema: BACKUP_SCHEMA,
    app: 'blinkora',
    version: 1,
    exportedAt: manifest.exportedAt,
    scope: 'workspace',
    format: manifest.format || 'json',
    workspaceCount: 1,
    noteCount: manifest.notes.length,
    attachmentCount: attachments.size,
    missingFileCount: 0,
    workspaces: [{
      id: 0,
      name: '导入工作区',
      description: '',
      icon: '',
      color: '',
      isDefault: false,
      configs: [],
      tags: Array.from(tags.values()),
      notes: manifest.notes.map((note: any) => ({
        ...note,
        type: typeof note.type === 'number'
          ? note.type
          : note.type === 'note'
            ? 1
            : note.type === 'todo'
              ? 2
              : 0,
        tagIds: (note.tags || []).map((tag: any) => tag.id).filter(Boolean),
        attachmentIds: (note.attachments || []).map((attachment: any) => attachment.id).filter(Boolean),
      })),
      attachments: Array.from(attachments.values()),
      comments,
      noteReferences: manifest.notes.flatMap((note: any) =>
        (note.references || []).map((toNoteId: number) => ({ fromNoteId: note.id, toNoteId }))
      ),
      noteHistory: [],
    }],
  };
}

export function readBackupManifest(zip: AdmZip) {
  const manifestEntry = zip.getEntry(BACKUP_MANIFEST);
  if (!manifestEntry) {
    throw new Error('备份文件缺少 manifest.json');
  }

  return normalizeLegacyWorkspaceManifest(JSON.parse(manifestEntry.getData().toString('utf-8')));
}

function assertImportModeMatches(mode: ImportMode, manifest: any) {
  if (mode === 'workspace' && manifest.scope === 'full') {
    throw new Error('该文件是全量备份，请选择全量恢复');
  }

  if (mode === 'full' && manifest.scope !== 'full') {
    throw new Error('该文件是当前工作区导出，请选择导入工作区');
  }
}

async function uploadWorkspaceAttachmentFiles({
  zip,
  workspace,
  accountId,
  fileService,
}: {
  zip: AdmZip;
  workspace: any;
  accountId: number;
  fileService: BackupFileService;
}) {
  const pathMap = new Map<string, string>();
  const uploadedPaths: string[] = [];
  let restoredAttachmentFiles = 0;
  let missingAttachmentFiles = 0;

  for (const attachment of workspace.attachments || []) {
    if (!attachment.path || !attachment.fileRef) {
      if (isRestorableFileAttachment(attachment)) missingAttachmentFiles += 1;
      continue;
    }

    const fileEntry = zip.getEntry(attachment.fileRef);
    if (!fileEntry) {
      missingAttachmentFiles += 1;
      continue;
    }

    const result = await fileService.uploadFile({
      buffer: fileEntry.getData(),
      originalName: attachment.name || path.basename(attachment.path),
      type: attachment.type || 'application/octet-stream',
      withOutAttachment: true,
      accountId,
      metadata: attachment.metadata,
    } as any);

    pathMap.set(attachment.path, result.filePath);
    uploadedPaths.push(result.filePath);
    restoredAttachmentFiles += 1;
  }

  return { pathMap, uploadedPaths, restoredAttachmentFiles, missingAttachmentFiles };
}

async function restoreWorkspace({
  tx,
  accountId,
  workspace,
  pathMap,
}: {
  tx: BackupDatabase;
  accountId: number;
  workspace: any;
  pathMap: Map<string, string>;
}) {
  const newWorkspace = await tx.workspaces.create({
    data: {
      name: buildImportedWorkspaceName(workspace.name),
      description: workspace.description || '',
      icon: workspace.icon || '',
      color: workspace.color || '',
      accountId,
      isDefault: false,
    },
  });

  const tagIdMap = new Map<number, number>();
  for (const tag of workspace.tags || []) {
    const created = await tx.tag.create({
      data: {
        name: tag.name || '',
        icon: tag.icon || '',
        parent: 0,
        accountId,
        workspaceId: newWorkspace.id,
        sortOrder: Number(tag.sortOrder || 0),
        ...(toDateOrUndefined(tag.createdAt) && { createdAt: toDateOrUndefined(tag.createdAt) }),
        ...(toDateOrUndefined(tag.updatedAt) && { updatedAt: toDateOrUndefined(tag.updatedAt) }),
      },
    });
    tagIdMap.set(normalizeId(tag.id), created.id);
  }

  for (const tag of workspace.tags || []) {
    const mappedParent = tagIdMap.get(normalizeId(tag.parent));
    if (mappedParent) {
      await tx.tag.update({
        where: { id: tagIdMap.get(normalizeId(tag.id)) },
        data: {
          parent: mappedParent,
          ...(toDateOrUndefined(tag.updatedAt) && { updatedAt: toDateOrUndefined(tag.updatedAt) }),
        },
      });
    }
  }

  const noteIdMap = new Map<number, number>();
  for (const note of workspace.notes || []) {
    const created = await tx.notes.create({
      data: {
        content: replaceAttachmentPaths(note.content || '', pathMap),
        type: Number(note.type || 0),
        isArchived: Boolean(note.isArchived),
        isRecycle: Boolean(note.isRecycle),
        isTop: Boolean(note.isTop),
        isReviewed: Boolean(note.isReviewed),
        metadata: note.metadata,
        sortOrder: Number(note.sortOrder || 0),
        accountId,
        workspaceId: newWorkspace.id,
        ...(toDateOrUndefined(note.createdAt) && { createdAt: toDateOrUndefined(note.createdAt) }),
        ...(toDateOrUndefined(note.updatedAt) && { updatedAt: toDateOrUndefined(note.updatedAt) }),
      },
    });
    noteIdMap.set(normalizeId(note.id), created.id);
  }

  const tagRelations = (workspace.notes || []).flatMap((note: any) => {
    const noteId = noteIdMap.get(normalizeId(note.id));
    if (!noteId) return [];
    return (note.tagIds || [])
      .map((tagId: number) => tagIdMap.get(normalizeId(tagId)))
      .filter(Boolean)
      .map((tagId: number) => ({ noteId, tagId }));
  });
  if (tagRelations.length) {
    await tx.tagsToNote.createMany({ data: tagRelations, skipDuplicates: true });
  }

  const attachmentCreateData = (workspace.attachments || []).map((attachment: any) => {
    const nextPath = pathMap.get(attachment.path) || attachment.path;
    const pathParts = String(nextPath || '')
      .replace('/api/file/', '')
      .replace('/api/s3file/', '')
      .split('/');
    return {
      name: attachment.name || path.basename(nextPath || 'attachment'),
      path: nextPath || '',
      size: attachment.size || 0,
      type: attachment.type || '',
      noteId: noteIdMap.get(normalizeId(attachment.noteId)) || null,
      accountId,
      workspaceId: newWorkspace.id,
      sortOrder: Number(attachment.sortOrder || 0),
      perfixPath: attachment.perfixPath ?? pathParts.slice(0, -1).join(','),
      depth: attachment.depth ?? Math.max(pathParts.length - 1, 0),
      metadata: attachment.metadata,
      ...(toDateOrUndefined(attachment.createdAt) && { createdAt: toDateOrUndefined(attachment.createdAt) }),
      ...(toDateOrUndefined(attachment.updatedAt) && { updatedAt: toDateOrUndefined(attachment.updatedAt) }),
    };
  });

  for (const data of attachmentCreateData) {
    await tx.attachments.create({ data });
  }

  const references = (workspace.noteReferences || [])
    .map((reference: any) => ({
      fromNoteId: noteIdMap.get(normalizeId(reference.fromNoteId)),
      toNoteId: noteIdMap.get(normalizeId(reference.toNoteId)),
      createdAt: toDateOrUndefined(reference.createdAt),
    }))
    .filter((reference: any) => reference.fromNoteId && reference.toNoteId)
    .map((reference: any) => ({
      fromNoteId: reference.fromNoteId,
      toNoteId: reference.toNoteId,
      ...(reference.createdAt && { createdAt: reference.createdAt }),
    }));
  if (references.length) {
    await tx.noteReference.createMany({ data: references, skipDuplicates: true });
  }

  const commentIdMap = new Map<number, number>();
  for (const comment of workspace.comments || []) {
    const mappedNoteId = noteIdMap.get(normalizeId(comment.noteId));
    if (!mappedNoteId) continue;
    const created = await tx.comments.create({
      data: {
        content: comment.content || '',
        kind: comment.kind || 'annotation',
        status: comment.status || 'open',
        metadata: comment.metadata,
        accountId,
        noteId: mappedNoteId,
        workspaceId: newWorkspace.id,
        parentId: null,
        ...(toDateOrUndefined(comment.createdAt) && { createdAt: toDateOrUndefined(comment.createdAt) }),
        ...(toDateOrUndefined(comment.updatedAt) && { updatedAt: toDateOrUndefined(comment.updatedAt) }),
      },
    });
    commentIdMap.set(normalizeId(comment.id), created.id);
  }

  for (const comment of workspace.comments || []) {
    const mappedParentId = commentIdMap.get(normalizeId(comment.parentId));
    const mappedCommentId = commentIdMap.get(normalizeId(comment.id));
    if (mappedParentId && mappedCommentId) {
      await tx.comments.update({
        where: { id: mappedCommentId },
        data: {
          parentId: mappedParentId,
          ...(toDateOrUndefined(comment.updatedAt) && { updatedAt: toDateOrUndefined(comment.updatedAt) }),
        },
      });
    }
  }

  const historyData = (workspace.noteHistory || [])
    .map((history: any) => ({
      noteId: noteIdMap.get(normalizeId(history.noteId)),
      content: history.content || '',
      metadata: history.metadata,
      version: Number(history.version || 1),
      accountId,
      workspaceId: newWorkspace.id,
      ...(toDateOrUndefined(history.createdAt) && { createdAt: toDateOrUndefined(history.createdAt) }),
    }))
    .filter((history: any) => history.noteId);
  if (historyData.length) {
    await tx.noteHistory.createMany({ data: historyData });
  }

  const configData = (workspace.configs || []).map((config: any) => ({
    key: config.key || '',
    config: config.config,
    userId: accountId,
    workspaceId: newWorkspace.id,
  }));
  if (configData.length) {
    await tx.config.createMany({ data: configData });
  }

  return {
    sourceWorkspaceId: workspace.id,
    workspaceId: newWorkspace.id,
    name: newWorkspace.name,
    noteCount: noteIdMap.size,
    attachmentCount: attachmentCreateData.length,
  };
}

export async function importBackupArchive(options: ImportBackupOptions) {
  const database = options.database || prisma;
  const fileService = options.fileService || FileService;
  const zip = new AdmZip(options.archiveBuffer);
  const manifest = readBackupManifest(zip);
  assertImportModeMatches(options.mode, manifest);

  const sourceWorkspaces = options.mode === 'workspace'
    ? [manifest.workspaces[0]].filter(Boolean)
    : manifest.workspaces;

  if (!sourceWorkspaces.length) {
    throw new Error('备份文件中没有可导入的工作区');
  }

  const uploadedPaths: string[] = [];
  const prepared: Array<{ workspace: any; pathMap: Map<string, string> }> = [];
  let restoredAttachmentFiles = 0;
  let missingAttachmentFiles = 0;

  try {
    for (const workspace of sourceWorkspaces) {
      const uploadResult = await uploadWorkspaceAttachmentFiles({
        zip,
        workspace,
        accountId: Number(options.accountId),
        fileService,
      });
      uploadedPaths.push(...uploadResult.uploadedPaths);
      restoredAttachmentFiles += uploadResult.restoredAttachmentFiles;
      missingAttachmentFiles += uploadResult.missingAttachmentFiles;
      prepared.push({ workspace, pathMap: uploadResult.pathMap });
    }

    const importedWorkspaces = await database.$transaction(async (tx: BackupDatabase) => {
      const results: any[] = [];
      for (const item of prepared) {
        results.push(await restoreWorkspace({
          tx,
          accountId: Number(options.accountId),
          workspace: item.workspace,
          pathMap: item.pathMap,
        }));
      }
      return results;
    });

    return {
      success: true,
      mode: options.mode,
      workspaceCount: importedWorkspaces.length,
      noteCount: importedWorkspaces.reduce((count: number, item: any) => count + item.noteCount, 0),
      attachmentCount: importedWorkspaces.reduce((count: number, item: any) => count + item.attachmentCount, 0),
      restoredAttachmentFiles,
      missingAttachmentFiles,
      importedWorkspaces,
    };
  } catch (error) {
    await Promise.all(uploadedPaths.map((filePath) => fileService.deleteFile(filePath).catch(() => {})));
    throw error;
  }
}
