#!/usr/bin/env node

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

// The PostgreSQL implementation either had no ORDER BY or no final stable
// tie-breaker for these lists. They remain value-equivalent sets, not an
// accidental database-plan ordering contract. Explicitly ordered endpoints
// stay in strictValueProcedures.
const setValueProcedures = new Set([
  'notes.list',
  'notes.listByIds',
  'notes.noteReferenceList',
]);

const randomValueProcedures = new Set([
  'notes.dailyReviewNoteList',
  'notes.randomNoteList',
]);

// All persisted rows are compared exactly before the mutation pass. During
// that pass, these endpoints can also surface rows independently created by
// the two test requests, whose generated UTC timestamps are intentionally
// normalized while their remaining values stay exact.
const generatedTimestampProcedures = new Set(['operationLogs.list']);

const strictValueProcedures = new Set([
  'attachments.list',
  'config.list',
  'fonts.list',
  'fonts.getFontData',
  'fonts.getByName',
  'notes.detail',
  'notes.deleteImpact',
  'notes.getNoteHistory',
  'notes.getNoteVersion',
  'system.serverVersion',
  'system.linkPreview',
  'tags.list',
  'tags.fullTagNameById',
  'users.detail',
  'users.canRegister',
  'users.nativeAccountList',
  'workspaces.getDefault',
]);

// The legacy MCP serializer emits milliseconds for values that originated
// with millisecond precision, while tRPC can preserve six digits. Both are
// UTC RFC3339 forms; the cross-backend value comparison below catches any
// precision drift instead of rejecting the established legacy representation.
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/;
const unorderedNestedArrayKeys = new Set(['references', 'referencedBy']);
let randomNoteFixtures = null;

function fail(message, details) {
  const error = new Error(message);
  // Differential fixtures can contain private notes and credentials. Failure
  // reports retain useful counts, IDs and hashes without echoing source data.
  error.details = details === undefined ? null : diagnosticValue(details);
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
  return { token: result.json.token, response: result };
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
  if (Array.isArray(value)) {
    const items = value.map((item) => redactSecrets(item));
    return unorderedNestedArrayKeys.has(key)
      ? items.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
      : items;
  }
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

function diagnosticValue(value, key = '') {
  if (Array.isArray(value)) {
    const ids = value
      .map((item) => item?.id)
      .filter(Number.isInteger);
    if (value.length > 10) {
      return {
        type: 'array',
        count: value.length,
        ids: ids.slice(0, 100),
      };
    }
    return value.map((item) => diagnosticValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([childKey, childValue]) => [childKey, diagnosticValue(childValue, childKey)]),
    );
  }
  if (typeof value === 'string') {
    if (/token|secret|password|accesskey|secretkey/i.test(key)) return '<redacted>';
    return {
      type: 'string',
      length: value.length,
      sha256: createHash('sha256').update(value).digest('hex'),
    };
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
      fail(`timestamp is not UTC RFC3339 with millisecond or microsecond precision: ${key}`, value);
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

function normalizeVolatileValue(value, key = '') {
  if (Array.isArray(value)) {
    const items = value.map((item) => normalizeVolatileValue(item));
    return unorderedNestedArrayKeys.has(key)
      ? items.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
      : items;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([childKey, childValue]) => [childKey, normalizeVolatileValue(childValue, childKey)]),
    );
  }
  if (typeof value === 'string' && /token|secret|password|accesskey|secretkey/i.test(key)) {
    return '<redacted>';
  }
  // MCP mirrors structuredContent into a JSON-formatted text item. Compare
  // that mirror semantically too, otherwise legitimate post-write timestamp
  // differences inside its string representation obscure the same payload.
  if (key === 'text') {
    try {
      return { mcpJsonText: normalizeVolatileValue(JSON.parse(value)) };
    } catch {
      // Plain text tool output is still a contract value and stays literal.
    }
  }
  if (typeof value === 'string' && timestampPattern.test(value)) return '<utc-microsecond-timestamp>';
  return value;
}

function sameNormalizedValue(left, right) {
  return JSON.stringify(normalizeVolatileValue(left)) === JSON.stringify(normalizeVolatileValue(right));
}

function compareRestResponse(label, postgres, sqlite, { normalizeTimestamps = false } = {}) {
  if (postgres.status !== sqlite.status) {
    fail(`${label} HTTP status differs`, { postgres: postgres.status, sqlite: sqlite.status });
  }
  const postgresBody = postgres.json ?? postgres.text;
  const sqliteBody = sqlite.json ?? sqlite.text;
  const matches = normalizeTimestamps
    ? sameNormalizedValue(postgresBody, sqliteBody)
    : sameValue(postgresBody, sqliteBody);
  if (!matches) {
    fail(`${label} response body differs`, {
      postgres: normalizeTimestamps ? normalizeVolatileValue(postgresBody) : redactSecrets(postgresBody),
      sqlite: normalizeTimestamps ? normalizeVolatileValue(sqliteBody) : redactSecrets(sqliteBody),
    });
  }
}

function sameTopLevelSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return sameValue(left, right);
  const canonical = (items) => items.map((item) => JSON.stringify(redactSecrets(item))).sort();
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function compareRandomProcedure(procedure, postgresValue, sqliteValue) {
  if (!randomNoteFixtures) {
    fail(`${procedure} random-note fixture was not initialized`);
  }

  const dailyReview = procedure === 'notes.dailyReviewNoteList';
  const backends = [
    ['postgres', postgresValue, randomNoteFixtures.postgres],
    ['sqlite', sqliteValue, randomNoteFixtures.sqlite],
  ];

  for (const [backend, value, fixture] of backends) {
    if (!Array.isArray(value)) {
      fail(`${procedure} must return an array`, { backend, value });
    }
    const eligible = new Map(
      [...fixture].filter(([, note]) => !dailyReview || note.isReviewed === false),
    );
    const expectedCount = Math.min(20, eligible.size);
    if (value.length !== expectedCount) {
      fail(`${procedure} returned the wrong number of notes`, {
        backend,
        expectedCount,
        actualCount: value.length,
      });
    }

    const seen = new Set();
    for (const note of value) {
      const id = note?.id;
      const expected = eligible.get(id);
      if (!Number.isInteger(id) || seen.has(id) || !expected) {
        fail(`${procedure} returned an ineligible or duplicate note`, { backend, id });
      }
      if (
        note.isArchived !== false
        || note.isRecycle !== false
        || (dailyReview && note.isReviewed !== false)
        || !sameValue(note, expected)
      ) {
        fail(`${procedure} returned an invalid note value`, {
          backend,
          id,
          expected,
          actual: note,
        });
      }
      seen.add(id);
    }
  }
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
  if (randomValueProcedures.has(procedure)) {
    compareRandomProcedure(procedure, postgresValue, sqliteValue);
    return 'random';
  }
  if (setValueProcedures.has(procedure)) {
    if (!sameTopLevelSet(postgresValue, sqliteValue)) {
      fail(`${procedure} unordered result members differ`, {
        postgres: redactSecrets(postgresValue),
        sqlite: redactSecrets(sqliteValue),
      });
    }
    return 'set';
  }
  if (generatedTimestampProcedures.has(procedure)) {
    if (!sameNormalizedValue(postgresValue, sqliteValue)) {
      fail(`${procedure} generated-value result differs`, {
        postgres: postgresValue,
        sqlite: sqliteValue,
      });
    }
    return 'generated-time';
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

async function openMcpSession(base, token) {
  const response = await fetch(`${base}/sse`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok || !response.body) fail(`MCP SSE failed for ${base}`, response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let nextId = 1;
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
  const endpointEvent = await event();
  if (endpointEvent.name !== 'endpoint' || !endpointEvent.data.trim()) {
    fail(`MCP endpoint event is invalid for ${base}`, endpointEvent);
  }
  const endpoint = endpointEvent.data.trim();

  return {
    async rpc(method, params) {
      const id = nextId;
      nextId += 1;
      const accepted = await fetch(`${base}${endpoint}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      if (accepted.status !== 202) {
        fail(`MCP ${method} was not accepted for ${base}`, {
          status: accepted.status,
          body: await accepted.text(),
        });
      }
      while (true) {
        const next = await event();
        if (!next.data) continue;
        const payload = JSON.parse(next.data);
        if (payload.id === id) return payload;
      }
    },
    close: () => reader.cancel().catch(() => {}),
  };
}

function notesFrom(response, label) {
  if (response.status !== 200) {
    fail(`${label} returned ${response.status}`, response.json || response.text);
  }
  const notes = resultData(response);
  if (!Array.isArray(notes)) {
    fail(`${label} did not return a note array`, response.json || response.text);
  }
  return notes;
}

async function loadActiveNoteFixture(base, token, label) {
  const size = 200;
  const notes = [];
  let total;

  for (let page = 1; ; page += 1) {
    const response = await trpc(
      base,
      'notes.list',
      { page, size, includePageInfo: true },
      token,
    );
    if (response.status !== 200) {
      fail(`${label} fixture page ${page} returned ${response.status}`, response.json || response.text);
    }
    const payload = resultData(response);
    if (!Array.isArray(payload?.items) || !Number.isInteger(payload?.total)) {
      fail(`${label} fixture page ${page} is malformed`, payload);
    }
    if (total === undefined) total = payload.total;
    if (payload.total !== total) {
      fail(`${label} fixture total changed while paging`, {
        page,
        initialTotal: total,
        currentTotal: payload.total,
      });
    }
    notes.push(...payload.items);
    if (notes.length >= total) break;
    if (payload.items.length === 0 || page > 10_000) {
      fail(`${label} fixture pagination did not reach its declared total`, {
        page,
        total,
        collected: notes.length,
      });
    }
  }

  const ids = notes.map((note) => note?.id);
  if (notes.length !== total || ids.some((id) => !Number.isInteger(id)) || new Set(ids).size !== ids.length) {
    fail(`${label} fixture pagination returned missing or duplicate notes`, {
      total,
      collected: notes.length,
      ids,
    });
  }
  return notes;
}

function searchMembership(response, ids, label) {
  const matches = new Set(notesFrom(response, label).map((note) => note.id));
  return {
    matching: matches.has(ids.matching),
    decoy: matches.has(ids.decoy),
  };
}

async function createSearchBoundaryFixture(base, token) {
  let matchingId;
  try {
    const matching = await trpc(
      base,
      'notes.upsert',
      {
        content: `Search boundary MiXeDCaSe-${runId} 中文-${runId} 🔥-${runId} @mention-${runId} percent-%${runId} _under-${runId}`,
        type: 0,
      },
      token,
    );
    matchingId = resultData(matching)?.id;
    const decoy = await trpc(
      base,
      'notes.upsert',
      { content: `Search boundary decoy ${runId}`, type: 0 },
      token,
    );
    const decoyId = resultData(decoy)?.id;
    if (!Number.isInteger(matchingId) || !Number.isInteger(decoyId)) {
      fail(`could not create search boundary fixture for ${base}`, {
        matching: matching.json || matching.text,
        decoy: decoy.json || decoy.text,
      });
    }
    return { matching: matchingId, decoy: decoyId };
  } catch (error) {
    if (Number.isInteger(matchingId)) {
      await deleteNotes(base, token, [matchingId]);
    }
    throw error;
  }
}

async function deleteNotes(base, token, ids) {
  const response = await trpc(base, 'notes.deleteMany', { ids }, token);
  if (response.status !== 200 || resultData(response) !== true) {
    fail(`could not delete temporary contract notes for ${base}`, response.json || response.text);
  }
}

async function deleteSearchBoundaryFixture(base, token, ids) {
  if (ids) await deleteNotes(base, token, [ids.matching, ids.decoy]);
}

async function compareSearchBoundaries(postgresToken, sqliteToken) {
  let postgresIds;
  let sqliteIds;

  const probes = [
    ['ASCII case-insensitive', `mixedcase-${runId}`],
    ['Chinese substring', `中文-${runId}`],
    ['Emoji substring', `🔥-${runId}`],
    ['at-sign', `@mention-${runId}`],
    ['percent wildcard', `percent-%${runId}`],
    ['underscore wildcard', `_under-${runId}`],
  ];

  try {
    postgresIds = await createSearchBoundaryFixture(postgresBase, postgresToken);
    sqliteIds = await createSearchBoundaryFixture(sqliteBase, sqliteToken);

    const comparisons = [];
    for (const [name, searchText] of probes) {
      const [postgres, sqlite] = await Promise.all([
        trpc(postgresBase, 'notes.list', { page: 1, size: 50, searchText }, postgresToken),
        trpc(sqliteBase, 'notes.list', { page: 1, size: 50, searchText }, sqliteToken),
      ]);
      const postgresMembership = searchMembership(postgres, postgresIds, `PostgreSQL ${name} search`);
      const sqliteMembership = searchMembership(sqlite, sqliteIds, `SQLite ${name} search`);
      if (!sameValue(postgresMembership, sqliteMembership)) {
        fail(`${name} search membership differs`, { searchText, postgresMembership, sqliteMembership });
      }
      comparisons.push({ name, searchText, membership: postgresMembership });
    }

    for (const comparison of comparisons) {
      if (!comparison.membership.matching || comparison.membership.decoy) {
        fail(`${comparison.name} search no longer matches only the intended note`, comparison);
      }
    }
    return comparisons;
  } finally {
    await Promise.all([
      deleteSearchBoundaryFixture(postgresBase, postgresToken, postgresIds),
      deleteSearchBoundaryFixture(sqliteBase, sqliteToken, sqliteIds),
    ]);
  }
}

function uploadSummary(response, label) {
  if (response.status !== 200 || !response.json) {
    fail(`${label} failed`, response.json || response.text);
  }
  const body = response.json;
  if (
    body.Message !== 'Success'
    || body.status !== 200
    || body.filePath !== body.path
    || !body.path?.startsWith('/api/file/')
  ) {
    fail(`${label} response is malformed`, body);
  }
  return {
    keys: Object.keys(body).sort(),
    message: body.Message,
    status: body.status,
    filePathMatchesPath: body.filePath === body.path,
    pathPrefix: body.path.slice(0, '/api/file/'.length),
    fileName: body.fileName,
    name: body.name,
    type: body.type,
    size: body.size,
  };
}

function uploadForm(fileName, content) {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/plain' }), fileName);
  return form;
}

async function compareRestContracts({ postgresToken, sqliteToken, postgresLogin, sqliteLogin }) {
  const checks = [];
  compareRestResponse('auth login', postgresLogin.response, sqliteLogin.response);
  checks.push('auth login');

  const invalidPassword = `not-the-password-${runId}`;
  const [postgresInvalidLogin, sqliteInvalidLogin] = await Promise.all([
    request(postgresBase, '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: user, password: invalidPassword }),
    }),
    request(sqliteBase, '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: user, password: invalidPassword }),
    }),
  ]);
  compareRestResponse('auth login invalid password', postgresInvalidLogin, sqliteInvalidLogin);
  if (postgresInvalidLogin.status !== 401) {
    fail('auth login invalid password must return 401', postgresInvalidLogin.json || postgresInvalidLogin.text);
  }
  checks.push('auth login invalid password');

  const [postgresProfile, sqliteProfile] = await Promise.all([
    request(postgresBase, '/api/auth/profile', { headers: { Authorization: `Bearer ${postgresToken}` } }),
    request(sqliteBase, '/api/auth/profile', { headers: { Authorization: `Bearer ${sqliteToken}` } }),
  ]);
  compareRestResponse('auth profile', postgresProfile, sqliteProfile);
  checks.push('auth profile');

  const [postgresUnauthorizedProfile, sqliteUnauthorizedProfile] = await Promise.all([
    request(postgresBase, '/api/auth/profile'),
    request(sqliteBase, '/api/auth/profile'),
  ]);
  compareRestResponse('auth profile unauthorized', postgresUnauthorizedProfile, sqliteUnauthorizedProfile);
  if (postgresUnauthorizedProfile.status !== 401) {
    fail('auth profile without a token must return 401', postgresUnauthorizedProfile.json || postgresUnauthorizedProfile.text);
  }
  checks.push('auth profile unauthorized');

  const [postgresValidatedToken, sqliteValidatedToken] = await Promise.all([
    request(postgresBase, '/api/auth/validate-token', { headers: { Authorization: `Bearer ${postgresToken}` } }),
    request(sqliteBase, '/api/auth/validate-token', { headers: { Authorization: `Bearer ${sqliteToken}` } }),
  ]);
  compareRestResponse('auth validate-token valid', postgresValidatedToken, sqliteValidatedToken);
  if (postgresValidatedToken.json?.valid !== true) {
    fail('auth validate-token valid response is malformed', postgresValidatedToken.json || postgresValidatedToken.text);
  }
  checks.push('auth validate-token valid');

  const [postgresInvalidToken, sqliteInvalidToken] = await Promise.all([
    request(postgresBase, '/api/auth/validate-token', { headers: { Authorization: 'Bearer invalid-contract-token' } }),
    request(sqliteBase, '/api/auth/validate-token', { headers: { Authorization: 'Bearer invalid-contract-token' } }),
  ]);
  compareRestResponse('auth validate-token invalid', postgresInvalidToken, sqliteInvalidToken);
  if (postgresInvalidToken.status !== 401) {
    fail('auth validate-token invalid must return 401', postgresInvalidToken.json || postgresInvalidToken.text);
  }
  checks.push('auth validate-token invalid');

  const [postgresLogout, sqliteLogout] = await Promise.all([
    request(postgresBase, '/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${postgresToken}` } }),
    request(sqliteBase, '/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${sqliteToken}` } }),
  ]);
  compareRestResponse('auth logout', postgresLogout, sqliteLogout);
  checks.push('auth logout');

  const restAccount = `contract-rest-${runId}`;
  const restPassword = 'contract-rest-password';
  const [postgresRegister, sqliteRegister] = await Promise.all([
    request(postgresBase, '/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: restAccount, password: restPassword, nickname: restAccount }),
    }),
    request(sqliteBase, '/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: restAccount, password: restPassword, nickname: restAccount }),
    }),
  ]);
  compareRestResponse('auth register', postgresRegister, sqliteRegister);
  // A migrated instance already has its one allowed native account. Keep the
  // legacy single-account rejection as part of the REST error contract; empty
  // database registration is exercised by the isolated smoke fixture.
  if (postgresRegister.status !== 400 || !postgresRegister.json?.error) {
    fail('auth register must preserve the single-account rejection', postgresRegister.json || postgresRegister.text);
  }
  checks.push('auth register closed-mode error');

  const [postgresSseUnauthorized, sqliteSseUnauthorized, postgresMessagesUnauthorized, sqliteMessagesUnauthorized] = await Promise.all([
    request(postgresBase, '/sse'),
    request(sqliteBase, '/sse'),
    request(postgresBase, '/messages?sessionId=missing-contract-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }),
    request(sqliteBase, '/messages?sessionId=missing-contract-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }),
  ]);
  compareRestResponse('MCP SSE unauthorized', postgresSseUnauthorized, sqliteSseUnauthorized);
  compareRestResponse('MCP messages unauthorized', postgresMessagesUnauthorized, sqliteMessagesUnauthorized);
  if (postgresSseUnauthorized.status !== 401 || postgresMessagesUnauthorized.status !== 401) {
    fail('unauthorized MCP endpoints must return 401', {
      sse: postgresSseUnauthorized.status,
      messages: postgresMessagesUnauthorized.status,
    });
  }
  checks.push('MCP unauthorized routes');

  const [postgresEmptyUpload, sqliteEmptyUpload, postgresUploadByUrl, sqliteUploadByUrl, postgresDeleteMissing, sqliteDeleteMissing] = await Promise.all([
    request(postgresBase, '/api/file/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${postgresToken}` },
      body: new FormData(),
    }),
    request(sqliteBase, '/api/file/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sqliteToken}` },
      body: new FormData(),
    }),
    request(postgresBase, '/api/file/upload-by-url', {
      method: 'POST',
      headers: { Authorization: `Bearer ${postgresToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url: '' }),
    }),
    request(sqliteBase, '/api/file/upload-by-url', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sqliteToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url: '' }),
    }),
    request(postgresBase, '/api/file/delete', {
      method: 'POST',
      headers: { Authorization: `Bearer ${postgresToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ attachment_path: '' }),
    }),
    request(sqliteBase, '/api/file/delete', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sqliteToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ attachment_path: '' }),
    }),
  ]);
  compareRestResponse('file upload without file', postgresEmptyUpload, sqliteEmptyUpload);
  compareRestResponse('file upload-by-url without URL', postgresUploadByUrl, sqliteUploadByUrl);
  compareRestResponse('file delete without path', postgresDeleteMissing, sqliteDeleteMissing);
  if ([postgresEmptyUpload, postgresUploadByUrl, postgresDeleteMissing].some((response) => response.status !== 400)) {
    fail('invalid file REST requests must return 400');
  }
  checks.push('file REST errors');

  const fileName = `contract-rest-${runId}.txt`;
  const fileContent = `contract file content ${runId}`;
  const [postgresUpload, sqliteUpload] = await Promise.all([
    request(postgresBase, '/api/file/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${postgresToken}` },
      body: uploadForm(fileName, fileContent),
    }),
    request(sqliteBase, '/api/file/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sqliteToken}` },
      body: uploadForm(fileName, fileContent),
    }),
  ]);
  if (!sameValue(uploadSummary(postgresUpload, 'PostgreSQL file upload'), uploadSummary(sqliteUpload, 'SQLite file upload'))) {
    fail('file upload response semantics differ', {
      postgres: uploadSummary(postgresUpload, 'PostgreSQL file upload'),
      sqlite: uploadSummary(sqliteUpload, 'SQLite file upload'),
    });
  }
  checks.push('file upload');

  const [postgresFile, sqliteFile] = await Promise.all([
    request(postgresBase, postgresUpload.json.path, { headers: { Authorization: `Bearer ${postgresToken}` } }),
    request(sqliteBase, sqliteUpload.json.path, { headers: { Authorization: `Bearer ${sqliteToken}` } }),
  ]);
  if (
    postgresFile.status !== 200
    || sqliteFile.status !== 200
    || postgresFile.text !== fileContent
    || sqliteFile.text !== fileContent
  ) {
    fail('uploaded file bytes differ', {
      postgres: { status: postgresFile.status, text: postgresFile.text },
      sqlite: { status: sqliteFile.status, text: sqliteFile.text },
    });
  }
  checks.push('file download');

  const [postgresDelete, sqliteDelete] = await Promise.all([
    request(postgresBase, '/api/file/delete', {
      method: 'POST',
      headers: { Authorization: `Bearer ${postgresToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ attachment_path: postgresUpload.json.path }),
    }),
    request(sqliteBase, '/api/file/delete', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sqliteToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ attachment_path: sqliteUpload.json.path }),
    }),
  ]);
  compareRestResponse('file delete', postgresDelete, sqliteDelete);
  checks.push('file delete');

  const [postgresMissingBackup, sqliteMissingBackup, postgresUnsupportedMode, sqliteUnsupportedMode] = await Promise.all([
    request(postgresBase, '/api/backup/import', {
      method: 'POST',
      headers: { Authorization: `Bearer ${postgresToken}` },
      body: new FormData(),
    }),
    request(sqliteBase, '/api/backup/import', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sqliteToken}` },
      body: new FormData(),
    }),
    request(postgresBase, '/api/backup/import', {
      method: 'POST',
      headers: { Authorization: `Bearer ${postgresToken}` },
      body: (() => {
        const form = new FormData();
        form.append('mode', 'unsupported-contract-mode');
        form.append('file', new Blob(['contract backup bytes']), 'contract.bko');
        return form;
      })(),
    }),
    request(sqliteBase, '/api/backup/import', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sqliteToken}` },
      body: (() => {
        const form = new FormData();
        form.append('mode', 'unsupported-contract-mode');
        form.append('file', new Blob(['contract backup bytes']), 'contract.bko');
        return form;
      })(),
    }),
  ]);
  compareRestResponse('backup import without file', postgresMissingBackup, sqliteMissingBackup);
  compareRestResponse('backup import unsupported mode', postgresUnsupportedMode, sqliteUnsupportedMode);
  if (postgresMissingBackup.status !== 400 || postgresUnsupportedMode.status !== 400) {
    fail('invalid backup imports must return 400', {
      missingFile: postgresMissingBackup.status,
      unsupportedMode: postgresUnsupportedMode.status,
    });
  }
  checks.push('backup import errors');

  return checks;
}

async function compareMcpContracts(postgresToken, sqliteToken, context) {
  const [postgres, sqlite] = await Promise.all([
    openMcpSession(postgresBase, postgresToken),
    openMcpSession(sqliteBase, sqliteToken),
  ]);
  const calls = [
    ['initialize', 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'postgres-sqlite-contract', version: '1.0.0' },
    }],
    ['tools/list', 'tools/list', {}],
    ['getWorkspaceContext', 'tools/call', { name: 'getWorkspaceContext', arguments: {} }],
    ['getBlinkora', 'tools/call', { name: 'getBlinkora', arguments: { id: context.noteId } }],
    ['searchBlinkora', 'tools/call', { name: 'searchBlinkora', arguments: { page: 1, size: 10 } }],
    ['listTagTree', 'tools/call', { name: 'listTagTree', arguments: {} }],
    ['listOperationLogs', 'tools/call', { name: 'listOperationLogs', arguments: { page: 1, size: 20 } }],
  ];

  try {
    for (const [label, method, params] of calls) {
      const [postgresPayload, sqlitePayload] = await Promise.all([
        postgres.rpc(method, params),
        sqlite.rpc(method, params),
      ]);
      if (postgresPayload.error || sqlitePayload.error) {
        fail(`MCP ${label} returned an error`, { postgres: postgresPayload, sqlite: sqlitePayload });
      }
      assertUtcFields(postgresPayload.result);
      assertUtcFields(sqlitePayload.result);
      if (!sameNormalizedValue(postgresPayload.result, sqlitePayload.result)) {
        fail(`MCP ${label} result differs`, {
          postgres: normalizeVolatileValue(postgresPayload.result),
          sqlite: normalizeVolatileValue(sqlitePayload.result),
        });
      }
    }
  } finally {
    await Promise.all([postgres.close(), sqlite.close()]);
  }
  return calls.map(([label]) => label);
}

async function main() {
  const procedures = await registeredProcedures();
  if (procedures.length !== 74) {
    fail('registered procedure count changed; update the contract fixture first', { count: procedures.length, procedures });
  }

  const [postgresLogin, sqliteLogin] = await Promise.all([login(postgresBase), login(sqliteBase)]);
  const postgresToken = postgresLogin.token;
  const sqliteToken = sqliteLogin.token;
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
  const [postgresExistingLogs, sqliteExistingLogs] = await Promise.all([
    trpc(postgresBase, 'operationLogs.list', { page: 1, size: 50 }, postgresToken),
    trpc(sqliteBase, 'operationLogs.list', { page: 1, size: 50 }, sqliteToken),
  ]);
  if (
    !sameValue(resultData(postgresDefault), resultData(sqliteDefault))
    || !sameTopLevelSet(resultData(postgresNotes), resultData(sqliteNotes))
    || !sameValue(resultData(postgresTags), resultData(sqliteTags))
    || !sameValue(resultData(postgresAttachments), resultData(sqliteAttachments))
    || postgresExistingLogs.status !== sqliteExistingLogs.status
    || !sameValue(postgresExistingLogs.json, sqliteExistingLogs.json)
  ) {
    fail('initial differential fixture is not equivalent');
  }
  assertUtcFields(resultData(postgresExistingLogs));
  assertUtcFields(resultData(sqliteExistingLogs));
  const [postgresActiveNotes, sqliteActiveNotes] = await Promise.all([
    loadActiveNoteFixture(postgresBase, postgresToken, 'PostgreSQL active-note'),
    loadActiveNoteFixture(sqliteBase, sqliteToken, 'SQLite active-note'),
  ]);
  if (!sameTopLevelSet(postgresActiveNotes, sqliteActiveNotes)) {
    fail('complete active-note fixtures are not equivalent', {
      postgres: postgresActiveNotes,
      sqlite: sqliteActiveNotes,
    });
  }
  randomNoteFixtures = {
    postgres: new Map(postgresActiveNotes.map((note) => [note.id, note])),
    sqlite: new Map(sqliteActiveNotes.map((note) => [note.id, note])),
  };
  const workspaceId = resultData(postgresDefault)?.id;
  const tagId = resultData(postgresTags)?.[0]?.id;
  let noteId;
  let historyVersion;
  for (const candidate of postgresActiveNotes) {
    const candidateId = candidate?.id;
    if (!Number.isInteger(candidateId)) continue;
    const [postgresHistory, sqliteHistory] = await Promise.all([
      trpc(postgresBase, 'notes.getNoteHistory', { noteId: candidateId }, postgresToken),
      trpc(sqliteBase, 'notes.getNoteHistory', { noteId: candidateId }, sqliteToken),
    ]);
    if (!sameValue(resultData(postgresHistory), resultData(sqliteHistory))) {
      fail('fixture note history differs', { noteId: candidateId });
    }
    const candidateVersion = resultData(postgresHistory)?.[0]?.version;
    if (Number.isInteger(candidateVersion)) {
      noteId = candidateId;
      historyVersion = candidateVersion;
      break;
    }
  }
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

  const rest = await compareRestContracts({ postgresToken, sqliteToken, postgresLogin, sqliteLogin });
  const mcp = await compareMcpContracts(postgresToken, sqliteToken, context);
  const searchBoundaries = await compareSearchBoundaries(postgresToken, sqliteToken);

  const report = {
    ok: true,
    procedures: coverage,
    exactComparisons: coverage.filter((item) => item.comparison === 'exact').length,
    setComparisons: coverage.filter((item) => item.comparison === 'set').length,
    randomComparisons: coverage.filter((item) => item.comparison === 'random').length,
    generatedTimestampComparisons: coverage.filter((item) => item.comparison === 'generated-time').length,
    structuralComparisons: coverage.filter((item) => item.comparison === 'shape').length,
    matchingErrors: coverage.filter((item) => item.comparison === 'error').length,
    preMutationExact: ['operationLogs.list'],
    rest: ['health', ...(attachment ? ['attachment download'] : []), ...rest],
    mcp,
    searchBoundaries,
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
