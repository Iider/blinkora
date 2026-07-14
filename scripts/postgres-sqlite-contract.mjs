#!/usr/bin/env node

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const postgresBase = process.env.BLINKORA_POSTGRES_BASE_URL || '';
const sqliteBase = process.env.BLINKORA_SQLITE_BASE_URL || '';
const user = process.env.BLINKORA_SMOKE_USER || '';
const password = process.env.BLINKORA_SMOKE_PASSWORD || '';
const reportPath = process.env.BLINKORA_CONTRACT_REPORT_PATH || '';
const runId = process.env.BLINKORA_CONTRACT_RUN_ID || String(Date.now());

if (!postgresBase || !sqliteBase || !user || !password) {
  throw new Error(
    'BLINKORA_POSTGRES_BASE_URL, BLINKORA_SQLITE_BASE_URL, BLINKORA_SMOKE_USER and BLINKORA_SMOKE_PASSWORD are required',
  );
}

const readProcedures = new Set([
  'attachments.list',
  'config.list',
  'fonts.list',
  'fonts.getFontData',
  'fonts.getByName',
  'notes.list',
  'notes.listByIds',
  'notes.detail',
  'notes.randomNoteList',
  'notes.deleteImpact',
  'notes.noteReferenceList',
  'notes.getNoteHistory',
  'notes.getNoteVersion',
  'operationLogs.list',
  'system.serverVersion',
  'system.linkPreview',
  'tags.list',
  'tags.fullTagNameById',
  'users.detail',
  'users.canRegister',
  'users.nativeAccountList',
  'workspaces.getDefault',
]);

// The PostgreSQL implementation intentionally had no ORDER BY for these
// lists. They remain value-equivalent sets, not an accidental database-plan
// ordering contract. Explicitly ordered endpoints stay in strictValueProcedures.
const setValueProcedures = new Set([
  'notes.dailyReviewNoteList',
  'notes.listByIds',
  'notes.noteReferenceList',
]);

const strictValueProcedures = new Set([
  'attachments.list',
  'config.list',
  'fonts.list',
  'fonts.getFontData',
  'fonts.getByName',
  'notes.list',
  'notes.listByIds',
  'notes.detail',
  'notes.dailyReviewNoteList',
  'notes.deleteImpact',
  'notes.noteReferenceList',
  'notes.getNoteHistory',
  'notes.getNoteVersion',
  'operationLogs.list',
  'system.serverVersion',
  'system.linkPreview',
  'tags.list',
  'tags.fullTagNameById',
  'users.detail',
  'users.canRegister',
  'users.nativeAccountList',
  'workspaces.getDefault',
]);

const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function fail(message, details) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

async function request(base, route, options = {}) {
  const response = await fetch(`${base}${route}`, options);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // File responses are intentionally left as raw text.
  }
  return { status: response.status, headers: response.headers, text, json };
}

async function login(base) {
  const result = await request(base, '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: user, password }),
  });
  if (result.status !== 200 || !result.json?.token) {
    fail(`login failed for ${base}`, result.json || result.text);
  }
  return result.json.token;
}

async function trpc(base, procedure, input, token) {
  const method = readProcedures.has(procedure) ? 'GET' : 'POST';
  const headers = { Authorization: `Bearer ${token}` };
  let route = `/api/trpc/${procedure}`;
  const options = { method, headers };
  if (method === 'GET') {
    route += `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  } else {
    headers['content-type'] = 'application/json';
    options.body = JSON.stringify({ json: input });
  }
  return request(base, route, options);
}

function resultData(response) {
  return response.json?.result?.data?.json;
}

function errorEnvelope(response) {
  const json = response.json?.error?.json;
  if (!json) return null;
  return {
    message: json.message,
    code: json.code,
    businessCode: json.data?.code,
    httpStatus: json.data?.httpStatus,
    path: json.data?.path,
  };
}

function redactSecrets(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([childKey, childValue]) => [childKey, redactSecrets(childValue, childKey)]),
    );
  }
  if (typeof value === 'string' && /token|secret|password|accesskey|secretkey/i.test(key)) {
    return '<redacted>';
  }
  return value;
}

function responseShape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return { array: [...new Set(value.map(responseShape).map((item) => JSON.stringify(item)))].sort() };
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, responseShape(item)]),
    );
  }
  return typeof value;
}

function assertUtcFields(value, key = '') {
  if (Array.isArray(value)) {
    value.forEach((item) => assertUtcFields(item));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      assertUtcFields(childValue, childKey);
    }
    return;
  }
  if (typeof value === 'string' && /(?:At|Date)$/.test(key) && value.includes('T')) {
    if (!timestampPattern.test(value)) {
      fail(`timestamp is not UTC microsecond RFC3339: ${key}`, value);
    }
  }
}

async function registeredProcedures() {
  const directory = path.join(process.cwd(), 'server/src/handlers');
  const names = [];
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.rs')) continue;
    const source = await readFile(path.join(directory, file), 'utf8');
    for (const match of source.matchAll(/registry\.insert\("([^"]+)"/g)) {
      names.push(match[1]);
    }
  }
  return [...new Set(names)].sort();
}

function inputFor(procedure, context) {
  const noteId = context.noteId;
  const tagId = context.tagId;
  const workspaceId = context.workspaceId;
  const historyVersion = context.historyVersion;
  const secondaryUser = `contract-${runId}`;
  switch (procedure) {
    case 'agentTokens.create':
      return { workspaceId, name: `contract-agent-${runId}` };
    case 'attachments.list':
      return { page: 1, size: 50 };
    case 'comments.list':
    case 'comments.create':
      return { noteId, content: `contract comment ${runId}` };
    case 'config.update':
      return { key: 'contractProbe', value: { runId, enabled: true } };
    case 'fonts.getFontData':
    case 'fonts.getByName':
      return { name: 'missing-contract-font' };
    case 'notes.list':
      return { page: 1, size: 50 };
    case 'notes.listByIds':
      return { ids: [noteId] };
    case 'notes.detail':
    case 'notes.reviewNote':
      return { id: noteId };
    case 'notes.deleteImpact':
      return { ids: [noteId] };
    case 'notes.addReference':
    case 'notes.removeReference':
      return { fromNoteId: noteId, toNoteId: noteId };
    case 'notes.setReferences':
      return { noteId, referenceIds: [] };
    case 'notes.noteReferenceList':
    case 'notes.getNoteHistory':
      return { noteId };
    case 'notes.getNoteVersion':
      return { noteId, version: historyVersion };
    case 'notes.updateAttachmentsOrder':
    case 'notes.updateNotesOrder':
      return { items: [] };
    case 'operationLogs.list':
      return { page: 1, size: 50 };
    case 'system.linkPreview':
      return { url: '' };
    case 'tags.fullTagNameById':
      return { id: tagId };
    case 'tags.updateTagName':
      return { id: tagId, newName: 'rust-smoke' };
    case 'tags.updateTagIcon':
      return { id: tagId, icon: 'ri:hashtag' };
    case 'tags.updateTagOrder':
      return { id: tagId, sortOrder: 7 };
    case 'users.register':
      return { name: secondaryUser, password: 'contract-secondary-password', nickname: secondaryUser };
    case 'users.login':
      return { name: user, password };
    case 'users.verify2FAToken':
      return { secret: 'INVALID', token: '000000' };
    case 'users.linkAccount':
      return { accountId: 0 };
    case 'workspaces.update':
    case 'workspaces.setDefault':
    case 'workspaces.delete':
      return { id: workspaceId };
    default:
      return {};
  }
}

function sameValue(left, right) {
  return JSON.stringify(redactSecrets(left)) === JSON.stringify(redactSecrets(right));
}

function sameTopLevelSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return sameValue(left, right);
  const canonical = (items) => items.map((item) => JSON.stringify(redactSecrets(item))).sort();
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function compareProcedure(procedure, postgres, sqlite) {
  if (postgres.status !== sqlite.status) {
    fail(`${procedure} HTTP status differs`, { postgres: postgres.status, sqlite: sqlite.status });
  }
  const postgresError = errorEnvelope(postgres);
  const sqliteError = errorEnvelope(sqlite);
  if (postgresError || sqliteError) {
    if (!sameValue(postgresError, sqliteError)) {
      fail(`${procedure} tRPC error differs`, { postgres: postgresError, sqlite: sqliteError });
    }
    return 'error';
  }

  const postgresValue = resultData(postgres);
  const sqliteValue = resultData(sqlite);
  assertUtcFields(postgresValue);
  assertUtcFields(sqliteValue);
  if (setValueProcedures.has(procedure)) {
    if (!sameTopLevelSet(postgresValue, sqliteValue)) {
      fail(`${procedure} unordered result members differ`, {
        postgres: redactSecrets(postgresValue),
        sqlite: redactSecrets(sqliteValue),
      });
    }
    return 'set';
  }
  if (strictValueProcedures.has(procedure)) {
    if (!sameValue(postgresValue, sqliteValue)) {
      fail(`${procedure} deterministic result differs`, {
        postgres: redactSecrets(postgresValue),
        sqlite: redactSecrets(sqliteValue),
      });
    }
    return 'exact';
  }
  if (!sameValue(responseShape(postgresValue), responseShape(sqliteValue))) {
    fail(`${procedure} result shape differs`, {
      postgres: responseShape(postgresValue),
      sqlite: responseShape(sqliteValue),
    });
  }
  return 'shape';
}

async function openMcpTools(base, token) {
  const response = await fetch(`${base}/sse`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok || !response.body) fail(`MCP SSE failed for ${base}`, response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const event = async () => {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) fail(`MCP SSE closed for ${base}`);
      buffer += decoder.decode(chunk.value, { stream: true });
      const boundary = buffer.indexOf('\n\n');
      if (boundary < 0) continue;
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = raw
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('');
      return { name: raw.match(/^event:\s*(.+)$/m)?.[1] || 'message', data };
    }
  };
  const endpoint = (await event()).data.trim();
  const id = 1;
  const accepted = await fetch(`${base}${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} }),
  });
  if (accepted.status !== 202) fail(`MCP tools/list was not accepted for ${base}`, accepted.status);
  while (true) {
    const next = await event();
    if (!next.data) continue;
    const payload = JSON.parse(next.data);
    if (payload.id === id) {
      await reader.cancel();
      return payload.result?.tools || [];
    }
  }
}

async function main() {
  const procedures = await registeredProcedures();
  if (procedures.length !== 74) {
    fail('registered procedure count changed; update the contract fixture first', { count: procedures.length, procedures });
  }

  const [postgresToken, sqliteToken] = await Promise.all([login(postgresBase), login(sqliteBase)]);
  const health = await Promise.all([request(postgresBase, '/health'), request(sqliteBase, '/health')]);
  if (health[0].status !== 200 || health[1].status !== 200 || !sameValue(health[0].json, health[1].json)) {
    fail('health contract differs', health.map((item) => ({ status: item.status, body: item.json || item.text })));
  }

  const [postgresDefault, sqliteDefault] = await Promise.all([
    trpc(postgresBase, 'workspaces.getDefault', {}, postgresToken),
    trpc(sqliteBase, 'workspaces.getDefault', {}, sqliteToken),
  ]);
  const [postgresNotes, sqliteNotes] = await Promise.all([
    trpc(postgresBase, 'notes.list', { page: 1, size: 50 }, postgresToken),
    trpc(sqliteBase, 'notes.list', { page: 1, size: 50 }, sqliteToken),
  ]);
  const [postgresTags, sqliteTags] = await Promise.all([
    trpc(postgresBase, 'tags.list', {}, postgresToken),
    trpc(sqliteBase, 'tags.list', {}, sqliteToken),
  ]);
  const [postgresAttachments, sqliteAttachments] = await Promise.all([
    trpc(postgresBase, 'attachments.list', { page: 1, size: 50 }, postgresToken),
    trpc(sqliteBase, 'attachments.list', { page: 1, size: 50 }, sqliteToken),
  ]);
  if (!sameValue(resultData(postgresDefault), resultData(sqliteDefault)) || !sameValue(resultData(postgresNotes), resultData(sqliteNotes)) || !sameValue(resultData(postgresTags), resultData(sqliteTags)) || !sameValue(resultData(postgresAttachments), resultData(sqliteAttachments))) {
    fail('initial differential fixture is not equivalent');
  }
  const workspaceId = resultData(postgresDefault)?.id;
  const noteId = resultData(postgresNotes)?.[0]?.id;
  const tagId = resultData(postgresTags)?.[0]?.id;
  const history = await trpc(postgresBase, 'notes.getNoteHistory', { noteId }, postgresToken);
  const historyVersion = resultData(history)?.[0]?.version;
  if (![workspaceId, noteId, tagId, historyVersion].every(Number.isInteger)) {
    fail('fixture is missing workspace, note, tag or note history', { workspaceId, noteId, tagId, historyVersion });
  }
  const context = { workspaceId, noteId, tagId, historyVersion };

  const coverage = [];
  for (const procedure of procedures) {
    const input = inputFor(procedure, context);
    const [postgres, sqlite] = await Promise.all([
      trpc(postgresBase, procedure, input, postgresToken),
      trpc(sqliteBase, procedure, input, sqliteToken),
    ]);
    coverage.push({ procedure, comparison: compareProcedure(procedure, postgres, sqlite) });
  }

  const [postgresProfile, sqliteProfile] = await Promise.all([
    request(postgresBase, '/api/auth/profile', { headers: { Authorization: `Bearer ${postgresToken}` } }),
    request(sqliteBase, '/api/auth/profile', { headers: { Authorization: `Bearer ${sqliteToken}` } }),
  ]);
  if (postgresProfile.status !== sqliteProfile.status || !sameValue(postgresProfile.json, sqliteProfile.json)) {
    fail('auth profile contract differs');
  }

  const attachmentResources = Array.isArray(resultData(postgresAttachments))
    ? resultData(postgresAttachments)
    : resultData(postgresAttachments)?.items || [];
  const attachment = attachmentResources.find(
    (item) => item.isFolder !== true && item.path?.startsWith('/api/file/'),
  );
  if (attachment) {
    const [postgresFile, sqliteFile] = await Promise.all([
      request(postgresBase, attachment.path, { headers: { Authorization: `Bearer ${postgresToken}` } }),
      request(sqliteBase, attachment.path, { headers: { Authorization: `Bearer ${sqliteToken}` } }),
    ]);
    if (postgresFile.status !== sqliteFile.status || postgresFile.text !== sqliteFile.text) {
      fail('attachment download contract differs', { path: attachment.path, postgres: postgresFile.status, sqlite: sqliteFile.status });
    }
  }

  const [postgresMcp, sqliteMcp] = await Promise.all([
    openMcpTools(postgresBase, postgresToken),
    openMcpTools(sqliteBase, sqliteToken),
  ]);
  if (!sameValue(postgresMcp, sqliteMcp)) fail('MCP tools/list contract differs');

  const report = {
    ok: true,
    procedures: coverage,
    exactComparisons: coverage.filter((item) => item.comparison === 'exact').length,
    setComparisons: coverage.filter((item) => item.comparison === 'set').length,
    structuralComparisons: coverage.filter((item) => item.comparison === 'shape').length,
    matchingErrors: coverage.filter((item) => item.comparison === 'error').length,
    rest: ['health', 'auth profile', ...(attachment ? ['attachment download'] : [])],
    mcp: ['tools/list'],
  };
  if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report));
}

try {
  await main();
} catch (error) {
  const report = { ok: false, message: error.message, details: error.details || null };
  if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}
