#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const base = process.env.BLINKORA_BASE_URL || 'http://127.0.0.1:6676';
const sqlitePath = process.env.BLINKORA_SQLITE_PATH || '';
const user = process.env.BLINKORA_SMOKE_USER || '';
const password = process.env.BLINKORA_SMOKE_PASSWORD || '';
const count = Math.max(2_000, Number(process.env.BLINKORA_BULK_COUNT || 2_100));
const stamp = Date.now();

if (!sqlitePath || !user || !password) {
  throw new Error('BLINKORA_SQLITE_PATH, BLINKORA_SMOKE_USER and BLINKORA_SMOKE_PASSWORD are required');
}

function sqliteScalar(sql) {
  return execFileSync('sqlite3', [sqlitePath, sql], { encoding: 'utf8' }).trim();
}

function expectCount(label, sql, expected) {
  const actual = Number(sqliteScalar(sql));
  if (actual !== expected) {
    throw new Error(`${label} count mismatch: expected ${expected}, got ${actual}`);
  }
}

async function request(path, options = {}) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { response, text, json };
}

function data(payload) {
  return payload?.result?.data?.json;
}

async function trpc(path, input, token, { method = 'POST', headers = {} } = {}) {
  const requestHeaders = { Authorization: `Bearer ${token}`, ...headers };
  let url = `/api/trpc/${path}`;
  const options = { method, headers: requestHeaders };
  if (method === 'GET') {
    url += `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  } else {
    requestHeaders['content-type'] = 'application/json';
    options.body = JSON.stringify({ json: input });
  }
  const result = await request(url, options);
  if (!result.response.ok || result.json?.error) {
    throw new Error(`tRPC ${path} failed: ${JSON.stringify(result.json || result.text)}`);
  }
  return data(result.json);
}

const login = await request('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: user, password }),
});
if (!login.response.ok || !login.json?.token) throw new Error('login failed');
const token = login.json.token;
const account = await trpc('users.detail', {}, token, { method: 'GET' });
const sourceWorkspace = await trpc('workspaces.getDefault', {}, token, { method: 'GET' });
if (!account?.id || !sourceWorkspace?.id) throw new Error('could not resolve test account/workspace');

const firstId = Number(sqliteScalar('SELECT COALESCE(MAX(id), 0) + 1 FROM notes;'));
const lastId = firstId + count - 1;
const timestamp = new Date().toISOString();
const sql = `WITH RECURSIVE seed(id) AS (
  SELECT ${firstId} UNION ALL SELECT id + 1 FROM seed WHERE id < ${lastId}
)
INSERT INTO notes (id, type, content, "isArchived", "isRecycle", "isTop", "isReviewed", "accountId", "workspaceId", "sortOrder", "createdAt", "updatedAt")
SELECT id, 0, 'SQLite bulk ${stamp} #' || id, 0, 0, 0, 0, ${Number(account.id)}, ${Number(sourceWorkspace.id)}, 0, '${timestamp}', '${timestamp}' FROM seed;`;
execFileSync('sqlite3', [sqlitePath, sql], { stdio: 'inherit' });
const ids = Array.from({ length: count }, (_, index) => firstId + index);
expectCount(
  'bulk fixture insert',
  `SELECT COUNT(*) FROM notes WHERE id BETWEEN ${firstId} AND ${lastId};`,
  count,
);

await trpc('notes.updateMany', { ids, isTop: true }, token);
expectCount(
  'bulk update',
  `SELECT COUNT(*) FROM notes WHERE id BETWEEN ${firstId} AND ${lastId} AND "isTop" = 1;`,
  count,
);
const targetWorkspace = await trpc('workspaces.create', {
  name: `SQLite bulk target ${stamp}`,
  description: 'temporary bulk validation workspace',
}, token);
if (!targetWorkspace?.id) throw new Error('could not create target workspace');
const moved = await trpc('notes.moveToWorkspace', { ids, targetWorkspaceId: targetWorkspace.id }, token);
if (moved?.count !== count) throw new Error(`bulk move count mismatch: ${moved?.count}`);
expectCount(
  'bulk target workspace move',
  `SELECT COUNT(*) FROM notes WHERE id BETWEEN ${firstId} AND ${lastId} AND "workspaceId" = ${Number(targetWorkspace.id)};`,
  count,
);
expectCount(
  'bulk source workspace cleanup',
  `SELECT COUNT(*) FROM notes WHERE id BETWEEN ${firstId} AND ${lastId} AND "workspaceId" = ${Number(sourceWorkspace.id)};`,
  0,
);

const targetHeaders = { 'x-workspace-id': String(targetWorkspace.id) };
await trpc('notes.updateMany', { ids, isArchived: true }, token, { headers: targetHeaders });
expectCount(
  'bulk archive update',
  `SELECT COUNT(*) FROM notes WHERE id BETWEEN ${firstId} AND ${lastId} AND "isArchived" = 1;`,
  count,
);
const exported = await trpc('task.exportMarkdown', { format: 'markdown' }, token, { headers: targetHeaders });
if (
  !exported?.success
  || Number(exported.fileCount) !== count
  || Number(exported.workspaceCount) !== 1
  || typeof exported.downloadUrl !== 'string'
) {
  throw new Error(`bulk export result mismatch: ${JSON.stringify(exported)}`);
}
const exportedArchive = await fetch(base + exported.downloadUrl, {
  headers: { Authorization: `Bearer ${token}`, ...targetHeaders },
});
const exportedArchiveBytes = await exportedArchive.arrayBuffer();
if (!exportedArchive.ok || exportedArchiveBytes.byteLength < count) {
  throw new Error(`bulk export archive download failed: HTTP ${exportedArchive.status}`);
}
const deleted = await trpc('notes.deleteMany', { ids, deleteOrphanAttachments: false }, token, { headers: targetHeaders });
if (deleted !== true) throw new Error(`bulk delete returned ${JSON.stringify(deleted)}`);

expectCount(
  'bulk delete',
  `SELECT COUNT(*) FROM notes WHERE id BETWEEN ${firstId} AND ${lastId};`,
  0,
);
const removedWorkspace = await trpc('workspaces.delete', { id: targetWorkspace.id }, token);
if (removedWorkspace !== true && removedWorkspace?.success !== true) {
  throw new Error(`bulk workspace cleanup returned ${JSON.stringify(removedWorkspace)}`);
}
console.log(JSON.stringify({ ok: true, count, firstId, lastId, targetWorkspaceId: targetWorkspace.id }));
