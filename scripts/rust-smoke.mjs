#!/usr/bin/env node

import http from 'node:http';
import { execFileSync } from 'node:child_process';

const base = process.env.BLINKORA_BASE_URL || 'http://127.0.0.1:6676';
const user = process.env.BLINKORA_SMOKE_USER || '';
const password = process.env.BLINKORA_SMOKE_PASSWORD || '';
const stamp = Date.now();

if (!user || !password) {
  fail('BLINKORA_SMOKE_USER and BLINKORA_SMOKE_PASSWORD are required for smoke tests');
}
const s3SmokeEndpoint = process.env.BLINKORA_S3_SMOKE_ENDPOINT || '';
const s3SmokeRegion = process.env.BLINKORA_S3_SMOKE_REGION || 'us-east-1';
const s3SmokeBucket = process.env.BLINKORA_S3_SMOKE_BUCKET || '';
const s3SmokeAccessKey = process.env.BLINKORA_S3_SMOKE_ACCESS_KEY || '';
const s3SmokeSecretKey = process.env.BLINKORA_S3_SMOKE_SECRET_KEY || '';
const s3SmokeCustomPath = process.env.BLINKORA_S3_SMOKE_CUSTOM_PATH || `smoke-${stamp}/`;
const mockEmbeddingSmoke = process.env.BLINKORA_MOCK_EMBEDDING_SMOKE === '1';
const mockEmbeddingPort = Number(process.env.BLINKORA_MOCK_EMBEDDING_PORT || 55987);
const mockEmbeddingBaseURL = process.env.BLINKORA_MOCK_EMBEDDING_BASE_URL || `http://host.docker.internal:${mockEmbeddingPort}/v1`;
const realEmbeddingSmoke = process.env.BLINKORA_REAL_EMBEDDING_SMOKE === '1';
const realEmbeddingUseLocalMock = process.env.BLINKORA_REAL_EMBEDDING_USE_LOCAL_MOCK === '1';
const realEmbeddingProvider = process.env.BLINKORA_REAL_EMBEDDING_PROVIDER || 'custom';
const realEmbeddingBaseURL = process.env.BLINKORA_REAL_EMBEDDING_BASE_URL || (realEmbeddingUseLocalMock ? mockEmbeddingBaseURL : '');
const realEmbeddingApiKey = process.env.BLINKORA_REAL_EMBEDDING_API_KEY || (realEmbeddingUseLocalMock ? 'real-smoke-mock-key' : '');
const realEmbeddingModelKey = process.env.BLINKORA_REAL_EMBEDDING_MODEL_KEY || (realEmbeddingUseLocalMock ? `blinkora-real-smoke-mock-${stamp}` : '');
const realEmbeddingApiVersion = process.env.BLINKORA_REAL_EMBEDDING_API_VERSION || '';
const uploadByUrlPort = Number(process.env.BLINKORA_UPLOAD_BY_URL_PORT || 55988);
const uploadByUrlSourceURL = process.env.BLINKORA_UPLOAD_BY_URL_SOURCE_URL || `http://host.docker.internal:${uploadByUrlPort}/upload-by-url-${stamp}.txt`;
const dockerDbContainer = process.env.BLINKORA_DOCKER_DB_CONTAINER || 'blinkora-db';

if (mockEmbeddingSmoke && realEmbeddingSmoke) {
  fail('Only one embedding smoke mode can be enabled at a time', {
    BLINKORA_MOCK_EMBEDDING_SMOKE: mockEmbeddingSmoke,
    BLINKORA_REAL_EMBEDDING_SMOKE: realEmbeddingSmoke,
  });
}

if (realEmbeddingSmoke) {
  assert(realEmbeddingBaseURL, 'BLINKORA_REAL_EMBEDDING_BASE_URL is required for real embedding smoke');
  assert(realEmbeddingModelKey, 'BLINKORA_REAL_EMBEDDING_MODEL_KEY is required for real embedding smoke');
  const needsKey = !['ollama'].includes(realEmbeddingProvider.toLowerCase());
  assert(!needsKey || realEmbeddingApiKey, 'BLINKORA_REAL_EMBEDDING_API_KEY is required for this provider');
}

function fail(message, details) {
  console.error(`\nFAIL: ${message}`);
  if (details !== undefined) {
    console.error(typeof details === 'string' ? details : JSON.stringify(details, null, 2));
  }
  process.exit(1);
}

function assert(condition, message, details) {
  if (!condition) {
    fail(message, details);
  }
}

function isListLike(value) {
  return Array.isArray(value) || Array.isArray(value?.items);
}

function denseVectorForText(text) {
  const lower = String(text || '').toLowerCase();
  let rust = 0;
  let smoke = 0;
  let note = 0;
  let edited = 0;
  let chars = 0;
  for (const token of lower.match(/[a-z0-9]+/g) || []) {
    if (token === 'rust' || token === 'oxidized') rust += 1;
    if (token === 'smoke') smoke += 1;
    if (token === 'note') note += 1;
    if (token === 'edited' || token === 'revised') edited += 1;
    chars += token.length;
  }
  return [rust, smoke, note, edited, chars / 1000];
}

function startMockEmbeddingServer() {
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/embeddings')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requestCount += 1;
      let input = [];
      try {
        const parsed = JSON.parse(body || '{}');
        input = Array.isArray(parsed.input) ? parsed.input : [parsed.input || ''];
      } catch {
        input = [''];
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: input.map((text, index) => ({
          object: 'embedding',
          index,
          embedding: denseVectorForText(text),
        })),
      }));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(mockEmbeddingPort, '0.0.0.0', () => {
      server.off('error', reject);
      resolve({
        close: () => new Promise((done) => server.close(() => done())),
        get requestCount() {
          return requestCount;
        },
      });
    });
  });
}

function startUploadByUrlServer() {
  const body = `upload-by-url-data-${stamp}`;
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || !req.url.startsWith(`/upload-by-url-${stamp}.txt`)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(uploadByUrlPort, '0.0.0.0', () => {
      server.off('error', reject);
      resolve({
        body,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function runPsql(sql) {
  execFileSync('docker', [
    'exec',
    '-i',
    dockerDbContainer,
    'psql',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    sql,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function configureEmbeddingProvider({
  accountId,
  workspaceId,
  provider,
  baseURL,
  apiKey,
  modelKey,
  providerConfig = {},
  titlePrefix,
}) {
  const providerTitle = `${titlePrefix} provider ${stamp}`;
  const modelTitle = `${titlePrefix} model ${stamp}`;
  runPsql(`
    DELETE FROM config
    WHERE key='embeddingModelId'
      AND "userId"=${Number(accountId)}
      AND "workspaceId"=${Number(workspaceId)};

    WITH provider AS (
      INSERT INTO "aiProviders" (title, provider, "baseURL", "apiKey", config, "createdAt", "updatedAt")
      VALUES (${sqlString(providerTitle)}, ${sqlString(provider)}, ${sqlString(baseURL)}, ${sqlString(apiKey)}, ${sqlString(JSON.stringify(providerConfig))}::json, NOW(), NOW())
      RETURNING id
    ), model AS (
      INSERT INTO "aiModels" ("providerId", title, "modelKey", capabilities, config, "createdAt", "updatedAt")
      SELECT id, ${sqlString(modelTitle)}, ${sqlString(modelKey)}, '["embedding"]'::json, '{}'::json, NOW(), NOW()
      FROM provider
      RETURNING id
    )
    INSERT INTO config (key, config, "userId", "workspaceId")
    SELECT 'embeddingModelId', to_json(id)::json, ${Number(accountId)}, ${Number(workspaceId)}
    FROM model
    RETURNING id;
  `);
}

function configureMockEmbeddingProvider(accountId, workspaceId) {
  configureEmbeddingProvider({
    accountId,
    workspaceId,
    provider: 'custom',
    baseURL: mockEmbeddingBaseURL,
    apiKey: 'mock-key',
    modelKey: `rust-smoke-embedding-${stamp}`,
    titlePrefix: 'Rust smoke mock embedding',
  });
}

function configureRealEmbeddingProvider(accountId, workspaceId) {
  configureEmbeddingProvider({
    accountId,
    workspaceId,
    provider: realEmbeddingProvider,
    baseURL: realEmbeddingBaseURL,
    apiKey: realEmbeddingApiKey,
    modelKey: realEmbeddingModelKey,
    providerConfig: realEmbeddingApiVersion ? { apiVersion: realEmbeddingApiVersion } : {},
    titlePrefix: `Rust smoke real ${realEmbeddingProvider} embedding`,
  });
}

function readVectorKinds(accountId, workspaceId) {
  const output = execFileSync('docker', [
    'exec',
    '-i',
    dockerDbContainer,
    'psql',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-t',
    '-A',
    '-c',
    `SELECT COALESCE(string_agg(DISTINCT vector->>'kind', ',' ORDER BY vector->>'kind'), '') FROM "_blinkora_rust_vectors" WHERE "accountId"=${Number(accountId)} AND "workspaceId"=${Number(workspaceId)};`,
  ], { encoding: 'utf8' });
  return output.trim().split(',').filter(Boolean);
}

function readVectorMetadata(noteId, accountId, workspaceId) {
  const output = execFileSync('docker', [
    'exec',
    '-i',
    dockerDbContainer,
    'psql',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-t',
    '-A',
    '-c',
    `SELECT COALESCE(metadata::text, '{}') FROM "_blinkora_rust_vectors" WHERE "noteId"=${Number(noteId)} AND "accountId"=${Number(accountId)} AND "workspaceId"=${Number(workspaceId)} ORDER BY id DESC LIMIT 1;`,
  ], { encoding: 'utf8' });
  return JSON.parse(output.trim() || '{}');
}

async function request(path, options = {}) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { response, text, json };
}

function trpcData(payload) {
  return payload?.result?.data?.json;
}

async function trpc(path, input, token, method = 'POST', extraHeaders = {}) {
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  Object.assign(headers, extraHeaders);
  let url = `/api/trpc/${path}`;
  const options = { method, headers };

  if (method === 'GET') {
    url += `?input=${encodeURIComponent(JSON.stringify({ json: input ?? null }))}`;
  } else {
    headers['content-type'] = 'application/json';
    options.body = JSON.stringify({ json: input ?? null });
  }

  const result = await request(url, options);
  assert(result.response.ok, `${method} ${path} HTTP ${result.response.status}`, result.json || result.text);
  assert(!result.json?.error, `${method} ${path} tRPC error`, result.json);
  return trpcData(result.json);
}

async function openMcpSession(token) {
  const response = await fetch(base + '/sse', {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(response.ok && response.body, 'MCP SSE open', {
    status: response.status,
    contentType: response.headers.get('content-type'),
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  async function readEvent(predicate, label) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      assert(!done, `MCP SSE closed while waiting for ${label}`);
      buffer += decoder.decode(value, { stream: true });

      let splitAt;
      while ((splitAt = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, splitAt);
        buffer = buffer.slice(splitAt + 2);
        const event = parseSseEvent(raw);
        if (predicate(event)) {
          return event;
        }
      }
    }
    fail(`MCP SSE timeout waiting for ${label}`, { buffer });
  }

  const endpointEvent = await readEvent((event) => event.event === 'endpoint' && event.data, 'endpoint');
  const endpoint = endpointEvent.data.trim();

  async function rpc(method, params) {
    const id = Math.floor(Math.random() * 1_000_000);
    const post = await fetch(base + endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    assert(post.status === 202, `MCP ${method} POST`, { status: post.status, text: await post.text() });
    const event = await readEvent((event) => {
      if (event.event !== 'message') return false;
      const payload = JSON.parse(event.data);
      return payload.id === id;
    }, method);
    return JSON.parse(event.data);
  }

  return {
    endpoint,
    rpc,
    close: () => reader.cancel().catch(() => {}),
  };
}

function parseSseEvent(raw) {
  const event = { event: 'message', data: '' };
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) {
      event.event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      event.data += line.slice(5).trimStart();
    }
  }
  return event;
}

async function login() {
  const loginResult = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: user, password }),
  });
  if (loginResult.response.ok && loginResult.json?.token) {
    return loginResult.json.token;
  }

  const registerResult = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: user, password, nickname: user }),
  });
  assert(registerResult.response.ok, 'register smoke user', registerResult.json || registerResult.text);

  const retry = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: user, password }),
  });
  assert(retry.response.ok && retry.json?.token, 'login smoke user after register', retry.json || retry.text);
  return retry.json.token;
}

const health = await request('/health');
assert(health.response.status === 200 && health.json?.status === 'ok', 'health', health.json || health.text);

const index = await request('/');
assert(index.response.status === 200 && /text\/html/.test(index.response.headers.get('content-type') || ''), 'index html', {
  status: index.response.status,
  contentType: index.response.headers.get('content-type'),
});

const lute = await request('/vditor-assets/dist/js/lute/lute.min.js');
assert(
  lute.response.status === 200
    && /javascript/.test(lute.response.headers.get('content-type') || '')
    && !lute.text.trimStart().startsWith('<'),
  'lute js',
  {
    status: lute.response.status,
    contentType: lute.response.headers.get('content-type'),
    head: lute.text.slice(0, 20),
  },
);

const missing = await request('/vditor-assets/dist/js/missing-smoke.js');
assert(missing.response.status === 404, 'missing js should 404', {
  status: missing.response.status,
  head: missing.text.slice(0, 40),
});

const token = await login();
const trpcLogin = await trpc('users.login', { name: user, password }, null);
assert(trpcLogin?.name === user && trpcLogin?.token, 'users.login tRPC compatibility', trpcLogin);

const userDetail = await trpc('users.detail', {}, token, 'GET');
assert(userDetail?.name === user && userDetail?.id, 'users.detail', userDetail);

const authProfile = await request('/api/auth/profile', {
  headers: { Authorization: `Bearer ${token}` },
});
assert(authProfile.response.ok && authProfile.json?.user?.name === user, 'auth profile', authProfile.json || authProfile.text);

const validToken = await request('/api/auth/validate-token', {
  headers: { Authorization: `Bearer ${token}` },
});
assert(validToken.response.ok && validToken.json?.valid === true && validToken.json?.user?.name === user, 'auth validate-token valid', validToken.json || validToken.text);

const invalidToken = await request('/api/auth/validate-token', {
  headers: { Authorization: 'Bearer invalid-token' },
});
assert(invalidToken.response.status === 401, 'auth validate-token rejects invalid token', {
  status: invalidToken.response.status,
  body: invalidToken.json || invalidToken.text,
});

const logout = await request('/api/auth/logout', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
});
assert(logout.response.ok, 'auth logout', logout.json || logout.text);

const unauthMcp = await request('/sse');
assert(unauthMcp.response.status === 401, 'MCP SSE unauthorized rejects', {
  status: unauthMcp.response.status,
  body: unauthMcp.json || unauthMcp.text,
});

const mcp = await openMcpSession(token);
const initialize = await mcp.rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'blinkora-smoke', version: '1.0.0' },
});
assert(initialize.result?.serverInfo?.name === 'blinkora-mcp-server', 'MCP initialize', initialize);

const mcpTools = await mcp.rpc('tools/list', {});
const mcpToolNames = mcpTools.result?.tools?.map((tool) => tool.name) || [];
assert(
  ['searchBlinkora', 'upsertBlinkora', 'updateBlinkora', 'deleteBlinkora'].every((name) => mcpToolNames.includes(name)),
  'MCP tools/list',
  mcpTools,
);

const mcpCreated = await mcp.rpc('tools/call', {
  name: 'upsertBlinkora',
  arguments: { content: `Rust MCP smoke note ${stamp} #rust-mcp-smoke`, type: 'blinkora' },
});
const mcpCreatedNote = mcpCreated.result?.structuredContent;
assert(mcpCreatedNote?.id && mcpCreatedNote.content.includes(String(stamp)), 'MCP upsertBlinkora', mcpCreated);

const mcpSearch = await mcp.rpc('tools/call', {
  name: 'searchBlinkora',
  arguments: { searchText: `Rust MCP smoke note ${stamp}`, page: 1, size: 10 },
});
assert(
  mcpSearch.result?.structuredContent?.success === true
    && mcpSearch.result.structuredContent.notes.some((item) => item.id === mcpCreatedNote.id),
  'MCP searchBlinkora',
  mcpSearch,
);

const mcpUpdated = await mcp.rpc('tools/call', {
  name: 'updateBlinkora',
  arguments: { id: mcpCreatedNote.id, content: `Rust MCP smoke note updated ${stamp} #rust-mcp-smoke`, type: 'note' },
});
assert(
  mcpUpdated.result?.structuredContent?.id === mcpCreatedNote.id
    && mcpUpdated.result.structuredContent.type === 1,
  'MCP updateBlinkora',
  mcpUpdated,
);

const mcpDeleted = await mcp.rpc('tools/call', {
  name: 'deleteBlinkora',
  arguments: { ids: [mcpCreatedNote.id] },
});
assert(mcpDeleted.result?.structuredContent === true, 'MCP deleteBlinkora', mcpDeleted);
mcp.close();

const nativeAccounts = await trpc('users.nativeAccountList', {}, token, 'GET');
assert(Array.isArray(nativeAccounts), 'users.nativeAccountList', nativeAccounts);

const systemVersion = await trpc('system.serverVersion', {}, token, 'GET');
assert(typeof systemVersion === 'string' && systemVersion.includes('rust'), 'system.serverVersion', systemVersion);

const linkPreview = await trpc('system.linkPreview', { url: 'ftp://invalid-smoke.local' }, token);
assert(linkPreview && typeof linkPreview.title === 'string', 'system.linkPreview safe invalid URL', linkPreview);

const fonts = await trpc('fonts.list', {}, token, 'GET');
assert(Array.isArray(fonts), 'fonts.list', fonts);

const createdFontName = `rust-smoke-font-${stamp}`;
const createdFont = await trpc('fonts.create', {
  name: createdFontName,
  displayName: `Rust Smoke Font ${stamp}`,
  url: `https://example.com/fonts/${createdFontName}.css`,
  isLocal: false,
  weights: [400, 700],
  category: 'sans-serif',
  isSystem: false,
  sortOrder: 999,
}, token);
assert(createdFont?.name === createdFontName && createdFont.fileData === null, 'fonts.create', createdFont);

const fontByName = await trpc('fonts.getByName', { name: createdFontName }, token, 'GET');
assert(fontByName?.id === createdFont.id && fontByName.url?.includes(createdFontName), 'fonts.getByName', fontByName);

const updatedFont = await trpc('fonts.update', {
  id: createdFont.id,
  data: {
    displayName: `Rust Smoke Font Updated ${stamp}`,
    category: 'display',
    sortOrder: 1000,
  },
}, token);
assert(updatedFont?.id === createdFont.id && updatedFont.category === 'display', 'fonts.update', updatedFont);

const uploadedFontName = `rust-smoke-upload-font-${stamp}`;
const uploadedFont = await trpc('fonts.upload', {
  name: uploadedFontName,
  displayName: `Rust Smoke Uploaded Font ${stamp}`,
  fileData: Buffer.from(`rust-smoke-font-data-${stamp}`).toString('base64'),
  category: 'monospace',
}, token);
assert(uploadedFont?.name === uploadedFontName && uploadedFont.isLocal === true, 'fonts.upload', uploadedFont);

const uploadedFontData = await trpc('fonts.getFontData', { name: uploadedFontName }, token, 'GET');
assert(
  uploadedFontData?.fileData && Buffer.from(uploadedFontData.fileData, 'base64').toString('utf8') === `rust-smoke-font-data-${stamp}`,
  'fonts.getFontData uploaded data',
  uploadedFontData,
);

const deleteCreatedFont = await trpc('fonts.delete', { id: createdFont.id }, token);
assert(deleteCreatedFont?.success === true, 'fonts.delete created font', deleteCreatedFont);

const deleteUploadedFont = await trpc('fonts.delete', { id: uploadedFont.id }, token);
assert(deleteUploadedFont?.success === true, 'fonts.delete uploaded font', deleteUploadedFont);

const workspaces = await trpc('workspaces.list', {}, token);
assert(Array.isArray(workspaces) && workspaces.length >= 1, 'workspaces list', workspaces);
const workspaceId = workspaces[0].id;

const defaultWorkspace = await trpc('workspaces.getDefault', {}, token, 'GET');
assert(defaultWorkspace?.id === workspaceId && defaultWorkspace.isDefault === true, 'workspaces.getDefault', defaultWorkspace);

const localEmbeddingServer = (mockEmbeddingSmoke || realEmbeddingUseLocalMock) ? await startMockEmbeddingServer() : null;
if (mockEmbeddingSmoke) {
  configureMockEmbeddingProvider(userDetail.id, workspaceId);
}
if (realEmbeddingSmoke) {
  configureRealEmbeddingProvider(userDetail.id, workspaceId);
}

const smokeWorkspace = await trpc('workspaces.create', {
  name: `Rust smoke workspace ${stamp}`,
  description: 'temporary smoke workspace',
  icon: 'ri:test-tube-line',
  color: '#64748b',
}, token);
assert(smokeWorkspace?.id && smokeWorkspace.name.includes(String(stamp)), 'workspaces.create', smokeWorkspace);

const updatedWorkspace = await trpc('workspaces.update', {
  id: smokeWorkspace.id,
  name: `Rust smoke workspace updated ${stamp}`,
  description: 'updated smoke workspace',
}, token);
assert(updatedWorkspace?.id === smokeWorkspace.id && updatedWorkspace.name.includes('updated'), 'workspaces.update', updatedWorkspace);

const setDefault = await trpc('workspaces.setDefault', { id: smokeWorkspace.id }, token);
assert(setDefault === true || setDefault?.success === true, 'workspaces.setDefault', setDefault);

const smokeDefaultWorkspace = await trpc('workspaces.getDefault', {}, token, 'GET');
assert(smokeDefaultWorkspace?.id === smokeWorkspace.id, 'workspaces.getDefault after setDefault', smokeDefaultWorkspace);

const resetDefault = await trpc('workspaces.setDefault', { id: workspaceId }, token);
assert(resetDefault === true || resetDefault?.success === true, 'workspaces.setDefault original', resetDefault);

const workspaceDelete = await trpc('workspaces.delete', { id: smokeWorkspace.id }, token);
assert(workspaceDelete === true || workspaceDelete?.success === true, 'workspaces.delete', workspaceDelete);

const configUpdate = await trpc('config.update', { key: 'theme', value: 'light' }, token);
assert(configUpdate === true, 'config.update', configUpdate);

const configList = await trpc('config.list', {}, token, 'GET');
assert(configList && typeof configList === 'object', 'config.list', configList);

const aiConfigWithoutModel = await trpc('config.ai', { type: 'embeddingModel' }, token, 'GET');
assert(aiConfigWithoutModel === null || aiConfigWithoutModel?.modelKey, 'config.ai embedding model shape', aiConfigWithoutModel);
if (mockEmbeddingSmoke) {
  assert(aiConfigWithoutModel?.provider?.provider === 'custom', 'config.ai mock embedding provider shape', aiConfigWithoutModel);
}
if (realEmbeddingSmoke) {
  assert(aiConfigWithoutModel?.provider?.provider === realEmbeddingProvider, 'config.ai real embedding provider shape', aiConfigWithoutModel);
  assert(aiConfigWithoutModel?.modelKey === realEmbeddingModelKey, 'config.ai real embedding model shape', aiConfigWithoutModel);
}

const s3Validation = await trpc('config.saveAndValidateS3', {
  s3Endpoint: '',
  s3Region: '',
  s3Bucket: '',
  s3AccessKeyId: '',
  s3AccessKeySecret: '',
  s3CustomPath: '',
}, token);
assert(
  s3Validation?.ok === false && s3Validation?.objectStorage === 'local',
  'config.saveAndValidateS3 invalid config falls back to local',
  s3Validation,
);

const note = await trpc('notes.upsert', { content: `Rust smoke note ${stamp} #rust-smoke`, type: 0 }, token);
assert(note?.id && note?.content?.includes(String(stamp)), 'note upsert', note);

const detail = await trpc('notes.detail', { id: note.id }, token, 'GET');
assert(detail?.id === note.id, 'note detail', detail);

const tags = await trpc('tags.list', {}, token, 'GET');
assert(Array.isArray(tags) && tags.some((tag) => tag.name === 'rust-smoke'), 'tags list hashtag', tags);
const rustSmokeTag = tags.find((tag) => tag.name === 'rust-smoke');
assert(rustSmokeTag?.id, 'rust-smoke tag id', tags);

const fullTagName = await trpc('tags.fullTagNameById', { id: rustSmokeTag.id }, token, 'GET');
assert(fullTagName === '#rust-smoke', 'tags.fullTagNameById', fullTagName);

const tagIcon = await trpc('tags.updateTagIcon', { id: rustSmokeTag.id, icon: 'ri:hashtag' }, token);
assert(tagIcon?.id === rustSmokeTag.id && tagIcon.icon === 'ri:hashtag', 'tags.updateTagIcon', tagIcon);

const tagOrder = await trpc('tags.updateTagOrder', { id: rustSmokeTag.id, sortOrder: 7 }, token);
assert(tagOrder?.id === rustSmokeTag.id && tagOrder.sortOrder === 7, 'tags.updateTagOrder', tagOrder);

const tagRename = await trpc('tags.updateTagName', { id: rustSmokeTag.id, newName: 'rust-smoke' }, token);
assert(tagRename === true, 'tags.updateTagName', tagRename);

const list = await trpc('notes.list', { page: 1, size: 20 }, token, 'GET');
assert(Array.isArray(list) && list.some((item) => item.id === note.id), 'notes list contains note', list);

const listByIds = await trpc('notes.listByIds', { ids: [note.id] }, token, 'GET');
assert(Array.isArray(listByIds) && listByIds.some((item) => item.id === note.id), 'notes.listByIds', listByIds);

const editedNote = await trpc('notes.upsert', { id: note.id, content: `Rust smoke note edited ${stamp} #rust-smoke`, type: 0 }, token);
assert(editedNote?.id === note.id && editedNote.content.includes('edited'), 'notes.upsert edit', editedNote);

const history = await trpc('notes.getNoteHistory', { noteId: note.id }, token, 'GET');
assert(Array.isArray(history) && history.length >= 1, 'notes.getNoteHistory', history);

const version = await trpc('notes.getNoteVersion', { noteId: note.id, version: history[0].version }, token, 'GET');
assert(version?.noteId === note.id, 'notes.getNoteVersion', version);

const reviewList = await trpc('notes.dailyReviewNoteList', {}, token, 'GET');
assert(Array.isArray(reviewList), 'notes.dailyReviewNoteList', reviewList);

const randomList = await trpc('notes.randomNoteList', {}, token, 'GET');
assert(Array.isArray(randomList), 'notes.randomNoteList', randomList);

const reviewResult = await trpc('notes.reviewNote', { id: note.id }, token);
assert(reviewResult === true, 'notes.reviewNote', reviewResult);

const referencedNote = await trpc('notes.upsert', { content: `Rust smoke reference ${stamp}`, type: 0 }, token);
assert(referencedNote?.id && referencedNote.content.includes(String(stamp)), 'notes.upsert reference', referencedNote);

const addReferenceResult = await trpc('notes.addReference', { fromNoteId: note.id, toNoteId: referencedNote.id }, token);
assert(addReferenceResult === true, 'notes.addReference', addReferenceResult);

const references = await trpc('notes.noteReferenceList', { noteId: note.id }, token, 'GET');
assert(Array.isArray(references) && references.some((item) => item.toNoteId === referencedNote.id), 'notes.noteReferenceList', references);

const noteOrder = await trpc('notes.updateNotesOrder', { items: [{ id: note.id, sortOrder: 11 }] }, token);
assert(noteOrder === true, 'notes.updateNotesOrder', noteOrder);

const filterTagList = await trpc('notes.list', { page: 1, size: 20, tagId: rustSmokeTag.id }, token);
assert(Array.isArray(filterTagList) && filterTagList.some((item) => item.id === note.id), 'notes.list tagId filter', filterTagList);

const linkNote = await trpc('notes.upsert', { content: `Rust smoke link ${stamp} https://example.com/rust-${stamp}`, type: 0 }, token);
assert(linkNote?.id && linkNote.content.includes('https://'), 'notes.upsert link note', linkNote);

const todoPatternNote = await trpc('notes.upsert', { content: `Rust smoke checklist ${stamp}\n- [ ] follow up`, type: 0 }, token);
assert(todoPatternNote?.id && todoPatternNote.content.includes('- [ ]'), 'notes.upsert todo-pattern note', todoPatternNote);

const archivedAiDecoy = await trpc('notes.upsert', { content: `Rust smoke note edited ${stamp} archived decoy`, type: 0 }, token);
assert(archivedAiDecoy?.id, 'notes.upsert archived AI decoy', archivedAiDecoy);

const archiveAiDecoyResult = await trpc('notes.updateMany', { ids: [archivedAiDecoy.id], isArchived: true }, token);
assert(archiveAiDecoyResult === true, 'notes.updateMany archived AI decoy', archiveAiDecoyResult);

const recycledAiDecoy = await trpc('notes.upsert', { content: `Rust smoke note edited ${stamp} recycled decoy`, type: 0 }, token);
assert(recycledAiDecoy?.id, 'notes.upsert recycled AI decoy', recycledAiDecoy);

const recycleAiDecoyResult = await trpc('notes.trashMany', { ids: [recycledAiDecoy.id] }, token);
assert(recycleAiDecoyResult === true, 'notes.trashMany recycled AI decoy', recycleAiDecoyResult);

const withLinkList = await trpc('notes.list', { page: 1, size: 20, withLink: true, searchText: `Rust smoke link ${stamp}` }, token);
assert(Array.isArray(withLinkList) && withLinkList.some((item) => item.id === linkNote.id), 'notes.list withLink filter', withLinkList);

const hasTodoList = await trpc('notes.list', { page: 1, size: 20, hasTodo: true, searchText: `Rust smoke checklist ${stamp}` }, token);
assert(Array.isArray(hasTodoList) && hasTodoList.some((item) => item.id === todoPatternNote.id), 'notes.list hasTodo filter', hasTodoList);

const startDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const endDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const dateList = await trpc('notes.list', { page: 1, size: 20, startDate, endDate, searchText: `Rust smoke note edited ${stamp}` }, token);
assert(Array.isArray(dateList) && dateList.some((item) => item.id === note.id), 'notes.list date filter', dateList);

const aiFallbackList = await trpc('notes.list', { page: 1, size: 20, isUseAiQuery: true, searchText: `Rust smoke note edited ${stamp}` }, token);
assert(
  Array.isArray(aiFallbackList)
    && aiFallbackList.some((item) => item.id === note.id)
    && !aiFallbackList.some((item) => item.id === archivedAiDecoy.id || item.id === recycledAiDecoy.id),
  'notes.list AI query local fallback finds note',
  aiFallbackList,
);

const aiHybridFallbackList = await trpc('notes.list', { page: 1, size: 20, isUseAiQuery: true, searchText: `@edited ${stamp}` }, token);
assert(
  Array.isArray(aiHybridFallbackList) && aiHybridFallbackList.some((item) => item.id === note.id),
  'notes.list AI query local fallback token search finds note',
  aiHybridFallbackList,
);

const aiTagFilterList = await trpc('notes.list', { page: 1, size: 20, isUseAiQuery: true, tagId: rustSmokeTag.id, searchText: `Rust smoke note edited ${stamp}` }, token);
assert(
  Array.isArray(aiTagFilterList) && aiTagFilterList.some((item) => item.id === note.id),
  'notes.list AI query respects tagId filter positive',
  aiTagFilterList,
);

const aiTagFilterNegativeList = await trpc('notes.list', { page: 1, size: 20, isUseAiQuery: true, tagId: rustSmokeTag.id, searchText: `Rust smoke link ${stamp}` }, token);
assert(
  Array.isArray(aiTagFilterNegativeList) && !aiTagFilterNegativeList.some((item) => item.id === linkNote.id),
  'notes.list AI query respects tagId filter negative',
  aiTagFilterNegativeList,
);

const aiWithoutTagList = await trpc('notes.list', { page: 1, size: 20, isUseAiQuery: true, withoutTag: true, searchText: `Rust smoke link ${stamp}` }, token);
assert(
  Array.isArray(aiWithoutTagList) && aiWithoutTagList.some((item) => item.id === linkNote.id),
  'notes.list AI query respects withoutTag filter positive',
  aiWithoutTagList,
);

const aiWithoutTagNegativeList = await trpc('notes.list', { page: 1, size: 20, isUseAiQuery: true, withoutTag: true, searchText: `Rust smoke note edited ${stamp}` }, token);
assert(
  Array.isArray(aiWithoutTagNegativeList) && !aiWithoutTagNegativeList.some((item) => item.id === note.id),
  'notes.list AI query respects withoutTag filter negative',
  aiWithoutTagNegativeList,
);

const aiWithLinkList = await trpc('notes.list', { page: 1, size: 20, isUseAiQuery: true, withLink: true, searchText: `Rust smoke link ${stamp}` }, token);
assert(
  Array.isArray(aiWithLinkList) && aiWithLinkList.some((item) => item.id === linkNote.id),
  'notes.list AI query respects withLink filter positive',
  aiWithLinkList,
);

const aiWithLinkNegativeList = await trpc('notes.list', { page: 1, size: 20, isUseAiQuery: true, withLink: true, searchText: `Rust smoke note edited ${stamp}` }, token);
assert(
  Array.isArray(aiWithLinkNegativeList) && !aiWithLinkNegativeList.some((item) => item.id === note.id),
  'notes.list AI query respects withLink filter negative',
  aiWithLinkNegativeList,
);

const aiHasTodoList = await trpc('notes.list', { page: 1, size: 20, isUseAiQuery: true, hasTodo: true, searchText: `Rust smoke checklist ${stamp}` }, token);
assert(
  Array.isArray(aiHasTodoList) && aiHasTodoList.some((item) => item.id === todoPatternNote.id),
  'notes.list AI query respects hasTodo filter positive',
  aiHasTodoList,
);

const aiHasTodoNegativeList = await trpc('notes.list', { page: 1, size: 20, isUseAiQuery: true, hasTodo: true, searchText: `Rust smoke note edited ${stamp}` }, token);
assert(
  Array.isArray(aiHasTodoNegativeList) && !aiHasTodoNegativeList.some((item) => item.id === note.id),
  'notes.list AI query respects hasTodo filter negative',
  aiHasTodoNegativeList,
);

const aiDateList = await trpc('notes.list', { page: 1, size: 20, isUseAiQuery: true, startDate, endDate, searchText: `Rust smoke note edited ${stamp}` }, token);
assert(
  Array.isArray(aiDateList) && aiDateList.some((item) => item.id === note.id),
  'notes.list AI query respects date filter positive',
  aiDateList,
);

const embeddingBefore = await trpc('task.embeddingProgress', {}, token, 'GET');
assert(embeddingBefore && typeof embeddingBefore.isRunning === 'boolean', 'task.embeddingProgress before rebuild', embeddingBefore);

const embeddingRebuild = await trpc('task.rebuildEmbedding', { force: true }, token);
assert(
  embeddingRebuild?.isRunning === false
    && typeof embeddingRebuild.total === 'number'
    && Array.isArray(embeddingRebuild.results),
  'task.rebuildEmbedding completes with progress shape',
  embeddingRebuild,
);

const embeddingAfter = await trpc('task.embeddingProgress', {}, token, 'GET');
assert(
  embeddingAfter?.isRunning === false
    && embeddingAfter.lastUpdate === embeddingRebuild.lastUpdate
    && Array.isArray(embeddingAfter.processedNoteIds)
    && Array.isArray(embeddingAfter.skippedNoteIds),
  'task.embeddingProgress after rebuild',
  embeddingAfter,
);

const indexedDetail = await trpc('notes.detail', { id: note.id }, token, 'GET');
const wasProcessedOrSkipped = embeddingAfter.processedNoteIds.includes(note.id) || embeddingAfter.skippedNoteIds.includes(note.id);
assert(wasProcessedOrSkipped, 'task.rebuildEmbedding tracks smoke note id', embeddingAfter);
if (embeddingAfter.processedNoteIds.includes(note.id)) {
  assert(indexedDetail?.metadata?.isIndexed === true, 'task.rebuildEmbedding marks note metadata indexed', indexedDetail);
}

const vectorMetadata = readVectorMetadata(note.id, userDetail.id, workspaceId);
assert(
  vectorMetadata.noteId === note.id
    && vectorMetadata.accountId === userDetail.id
    && vectorMetadata.workspaceId === workspaceId
    && vectorMetadata.type === 0
    && vectorMetadata.isArchived === false
    && vectorMetadata.isRecycle === false
    && Array.isArray(vectorMetadata.tagIds)
    && vectorMetadata.tagIds.includes(rustSmokeTag.id)
    && Array.isArray(vectorMetadata.tags)
    && vectorMetadata.tags.includes('rust-smoke')
    && typeof vectorMetadata.updatedAt === 'string'
    && vectorMetadata.updatedAt.length > 0,
  'rust vector metadata includes note filters and workspace fields',
  vectorMetadata,
);

const vectorAiList = await trpc('notes.list', { page: 1, size: 20, isUseAiQuery: true, searchText: `Rust smoke note edited ${stamp}` }, token);
const vectorAiNote = Array.isArray(vectorAiList) ? vectorAiList.find((item) => item.id === note.id) : null;
assert(
  vectorAiNote && typeof vectorAiNote.score === 'number' && vectorAiNote.score > 0,
  'notes.list AI query uses rebuilt rust vector index',
  vectorAiList,
);
assert(
  Array.isArray(vectorAiList)
    && vectorAiList[0]?.id === note.id
    && !vectorAiList.some((item) => item.id === archivedAiDecoy.id || item.id === recycledAiDecoy.id),
  'notes.list AI query hybrid ranking excludes archived and recycled decoys',
  vectorAiList,
);
let mockEmbeddingRequestCount = null;
let vectorKinds = null;
if (mockEmbeddingSmoke) {
  mockEmbeddingRequestCount = localEmbeddingServer.requestCount;
  vectorKinds = readVectorKinds(userDetail.id, workspaceId);
  assert(mockEmbeddingRequestCount > 0, 'mock embedding provider was called', { mockEmbeddingRequestCount });
  assert(vectorKinds.includes('dense'), 'mock embedding smoke stores dense vectors', { vectorKinds });
  const vectorOnlyAiList = await trpc('notes.list', { page: 1, size: 20, isUseAiQuery: true, searchText: 'revised' }, token);
  const vectorOnlyNote = Array.isArray(vectorOnlyAiList) ? vectorOnlyAiList.find((item) => item.id === note.id) : null;
  assert(
    vectorOnlyNote
      && typeof vectorOnlyNote.score === 'number'
      && vectorOnlyNote.score > 0
      && !String(vectorOnlyNote.content || '').toLowerCase().includes('revised'),
    'notes.list AI query can recall via dense vector without keyword match',
    vectorOnlyAiList,
  );
}
if (realEmbeddingSmoke) {
  const realEmbeddingRequestCount = localEmbeddingServer?.requestCount ?? null;
  vectorKinds = readVectorKinds(userDetail.id, workspaceId);
  if (realEmbeddingUseLocalMock) {
    assert(realEmbeddingRequestCount > 0, 'real embedding local mock provider was called', { realEmbeddingRequestCount });
  }
  assert(vectorKinds.includes('dense'), 'real embedding smoke stores dense vectors', { provider: realEmbeddingProvider, vectorKinds });
}

const comment = await trpc('comments.create', {
  noteId: note.id,
  content: `Rust smoke annotation ${stamp}`,
  kind: 'todo',
}, token);
assert(comment?.id && comment.status === 'open', 'comment create', comment);

const reply = await trpc('comments.create', {
  noteId: note.id,
  content: `Rust smoke reply ${stamp}`,
  kind: 'annotation',
  parentId: comment.id,
}, token);
assert(reply?.id && reply.parentId === comment.id, 'comments.create reply', reply);

const updatedComment = await trpc('comments.update', {
  id: comment.id,
  content: `Rust smoke annotation updated ${stamp}`,
  kind: 'strategy',
  status: 'open',
  metadata: { smoke: true },
}, token);
assert(updatedComment?.id === comment.id && updatedComment.kind === 'strategy', 'comments.update', updatedComment);

const todo = await trpc('comments.convertToTodo', { id: comment.id }, token);
assert(todo?.id && todo.type === 2 && todo.content.includes(String(stamp)), 'comments.convertToTodo', todo);

const comments = await trpc('comments.list', { noteId: note.id }, token, 'GET');
assert(
  Array.isArray(comments)
    && comments.some((item) => item.id === comment.id
      && item.status === 'resolved'
      && item.metadata?.convertedToTodoId === todo.id),
  'comments list resolved metadata',
  comments,
);

const foldersBefore = await trpc('attachments.list', {}, token, 'GET');
assert(isListLike(foldersBefore), 'attachments list before upload', foldersBefore);

const resourceFolderName = `Rust smoke folder ${stamp}`;
const renamedResourceFolderName = `Rust smoke folder renamed ${stamp}`;
const folder = await trpc('attachments.createFolder', { folderName: resourceFolderName }, token);
assert(folder?.success === true && folder.folderName === resourceFolderName, 'attachments.createFolder resource folder', folder);

const rootResourcesWithFolder = await trpc('attachments.list', {}, token, 'GET');
assert(
  Array.isArray(rootResourcesWithFolder)
    && rootResourcesWithFolder.some((item) => item.isFolder === true && item.folderName === resourceFolderName),
  'attachments.list root folder item',
  rootResourcesWithFolder,
);

const renameFolder = await trpc('attachments.rename', {
  isFolder: true,
  oldFolderPath: resourceFolderName,
  newName: renamedResourceFolderName,
}, token);
assert(renameFolder?.success === true || renameFolder === true, 'attachments.rename folder', renameFolder);

const rootResourcesWithRenamedFolder = await trpc('attachments.list', {}, token, 'GET');
assert(
  Array.isArray(rootResourcesWithRenamedFolder)
    && rootResourcesWithRenamedFolder.some((item) => item.isFolder === true && item.folderName === renamedResourceFolderName),
  'attachments.list renamed folder item',
  rootResourcesWithRenamedFolder,
);

const formData = new FormData();
formData.append('file', new Blob([`hello rust upload ${stamp}`], { type: 'text/plain' }), `rust-smoke-${stamp}.txt`);
const upload = await fetch(base + '/api/file/upload', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'x-workspace-id': String(workspaceId) },
  body: formData,
});
const uploadJson = await upload.json().catch(() => null);
assert(
  upload.ok
    && uploadJson?.path
    && uploadJson?.filePath === uploadJson.path
    && uploadJson?.fileName
    && uploadJson?.Message === 'Success',
  'file upload',
  uploadJson,
);

const uploadByUrlServer = await startUploadByUrlServer();
const uploadByUrl = await request('/api/file/upload-by-url', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'x-workspace-id': String(workspaceId),
    'content-type': 'application/json',
  },
  body: JSON.stringify({ url: uploadByUrlSourceURL }),
});
await uploadByUrlServer.close();
assert(
  uploadByUrl.response.ok
    && uploadByUrl.json?.path
    && uploadByUrl.json?.filePath === uploadByUrl.json.path
    && uploadByUrl.json?.fileName
    && uploadByUrl.json?.originalURL === uploadByUrlSourceURL
    && uploadByUrl.json?.Message === 'Success',
  'file upload-by-url',
  uploadByUrl.json || uploadByUrl.text,
);

const uploadByUrlGet = await request(uploadByUrl.json.path, { headers: { Authorization: `Bearer ${token}` } });
assert(uploadByUrlGet.response.status === 200 && uploadByUrlGet.text === uploadByUrlServer.body, 'file upload-by-url get', {
  status: uploadByUrlGet.response.status,
  text: uploadByUrlGet.text,
});

const fileGet = await request(uploadJson.path, { headers: { Authorization: `Bearer ${token}` } });
assert(fileGet.response.status === 200 && fileGet.text.includes(String(stamp)), 'file get', {
  status: fileGet.response.status,
  text: fileGet.text,
});

const orphanContent = `hello rust orphan resource ${stamp}`;
const orphanFormData = new FormData();
orphanFormData.append('file', new Blob([orphanContent], { type: 'text/plain' }), `rust-orphan-${stamp}.txt`);
const orphanUpload = await fetch(base + '/api/file/upload', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'x-workspace-id': String(workspaceId) },
  body: orphanFormData,
});
const orphanUploadJson = await orphanUpload.json().catch(() => null);
assert(orphanUpload.ok && orphanUploadJson?.path && orphanUploadJson?.Message === 'Success', 'orphan resource upload', orphanUploadJson);

const orphanTagName = `rust-orphan-resource-${stamp}`;
const orphanNote = await trpc('notes.upsert', {
  content: `Rust orphan resource note ${stamp} #${orphanTagName}

[orphan file](${orphanUploadJson.path})`,
  type: 0,
}, token);
assert(orphanNote?.id && orphanNote.content.includes(orphanUploadJson.path), 'orphan resource note', orphanNote);

const orphanTagsBeforeDelete = await trpc('tags.list', {}, token, 'GET');
assert(
  Array.isArray(orphanTagsBeforeDelete) && orphanTagsBeforeDelete.some((tag) => tag.name === orphanTagName),
  'orphan resource tag exists before note delete',
  orphanTagsBeforeDelete,
);

const orphanImpact = await trpc('notes.deleteImpact', { ids: [orphanNote.id] }, token, 'GET');
assert(
  Array.isArray(orphanImpact?.orphanAttachments)
    && orphanImpact.orphanAttachments.some((item) => item.path === orphanUploadJson.path),
  'notes.deleteImpact returns orphan attachments',
  orphanImpact,
);

const orphanDelete = await trpc('notes.deleteMany', { ids: [orphanNote.id], deleteOrphanAttachments: true }, token);
assert(orphanDelete === true || orphanDelete?.ok === true, 'notes.deleteMany deletes orphan resource', orphanDelete);

const orphanDeletedGet = await request(orphanUploadJson.path, { headers: { Authorization: `Bearer ${token}` } });
assert(orphanDeletedGet.response.status === 404, 'orphan resource physical file deleted', {
  status: orphanDeletedGet.response.status,
  body: orphanDeletedGet.json || orphanDeletedGet.text,
});

const orphanTagsAfterDelete = await trpc('tags.list', {}, token, 'GET');
assert(
  Array.isArray(orphanTagsAfterDelete) && !orphanTagsAfterDelete.some((tag) => tag.name === orphanTagName),
  'orphan resource tag removed after note delete',
  orphanTagsAfterDelete,
);

const attachments = await trpc('attachments.list', {}, token, 'GET');
assert(isListLike(attachments), 'attachments list after upload', attachments);
const uploadedAttachment = (attachments.items || attachments).find((item) => item.path === uploadJson.path);
if (uploadedAttachment?.id) {
  const attachmentOrder = await trpc('notes.updateAttachmentsOrder', { items: [{ id: uploadedAttachment.id, sortOrder: 13 }] }, token);
  assert(attachmentOrder === true, 'notes.updateAttachmentsOrder', attachmentOrder);
}

const withFileList = await trpc('notes.list', { page: 1, size: 20, withFile: true, searchText: uploadJson.path.split('/').pop() }, token);
assert(Array.isArray(withFileList), 'notes.list withFile filter', withFileList);

const retainedContent = `hello rust retained upload ${stamp}`;
const retainedFormData = new FormData();
retainedFormData.append('file', new Blob([retainedContent], { type: 'text/plain' }), `rust-retained-${stamp}.txt`);
const retainedUpload = await fetch(base + '/api/file/upload', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'x-workspace-id': String(workspaceId) },
  body: retainedFormData,
});
const retainedUploadJson = await retainedUpload.json().catch(() => null);
assert(retainedUpload.ok && retainedUploadJson?.path && retainedUploadJson?.Message === 'Success', 'retained file upload', retainedUploadJson);

const retainedNote = await trpc('notes.upsert', {
  content: `Rust retained attachment ${stamp}\n\n[retained file](${retainedUploadJson.path})`,
  type: 0,
}, token);
assert(retainedNote?.id && retainedNote.content.includes(retainedUploadJson.path), 'retained attachment note', retainedNote);

const retainedWithFileList = await trpc('notes.list', { page: 1, size: 20, withFile: true, searchText: retainedUploadJson.path.split('/').pop() }, token);
assert(
  Array.isArray(retainedWithFileList) && retainedWithFileList.some((item) => item.id === retainedNote.id),
  'notes.list withFile filter finds note attachment',
  retainedWithFileList,
);

const aiWithFileList = await trpc('notes.list', { page: 1, size: 20, isUseAiQuery: true, withFile: true, searchText: retainedUploadJson.path.split('/').pop() }, token);
assert(
  Array.isArray(aiWithFileList) && aiWithFileList.some((item) => item.id === retainedNote.id),
  'notes.list AI query respects withFile filter positive',
  aiWithFileList,
);

const aiWithFileNegativeList = await trpc('notes.list', { page: 1, size: 20, isUseAiQuery: true, withFile: true, searchText: `Rust smoke note edited ${stamp}` }, token);
assert(
  Array.isArray(aiWithFileNegativeList) && !aiWithFileNegativeList.some((item) => item.id === note.id),
  'notes.list AI query respects withFile filter negative',
  aiWithFileNegativeList,
);

const movableContent = `hello rust movable upload ${stamp}`;
const movableFormData = new FormData();
movableFormData.append('file', new Blob([movableContent], { type: 'text/plain' }), `rust-movable-${stamp}.txt`);
const movableUpload = await fetch(base + '/api/file/upload', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'x-workspace-id': String(workspaceId) },
  body: movableFormData,
});
const movableUploadJson = await movableUpload.json().catch(() => null);
assert(movableUpload.ok && movableUploadJson?.path && movableUploadJson?.Message === 'Success', 'movable file upload', movableUploadJson);

const moveResourcesBefore = await trpc('attachments.list', { searchText: movableUploadJson.name || `rust-movable-${stamp}` }, token, 'GET');
const movableAttachment = moveResourcesBefore.find((item) => item.path === movableUploadJson.path);
assert(movableAttachment?.id, 'resource movable attachment for move', moveResourcesBefore);

const moveToFolder = await trpc('attachments.move', {
  sourceIds: [movableAttachment.id],
  targetFolder: renamedResourceFolderName,
}, token);
assert(moveToFolder?.success === true || moveToFolder === true, 'attachments.move into folder', moveToFolder);

const folderResources = await trpc('attachments.list', { folder: renamedResourceFolderName }, token, 'GET');
assert(
  Array.isArray(folderResources)
    && folderResources.some((item) => item.id === movableAttachment.id),
  'attachments.list folder contains moved file',
  folderResources,
);
const movedResourceAttachment = folderResources.find((item) => item.id === movableAttachment.id);
assert(
  movedResourceAttachment?.path?.includes(`${renamedResourceFolderName}/`),
  'moved resource attachment path',
  movedResourceAttachment,
);

const moveToRoot = await trpc('attachments.move', {
  sourceIds: [movableAttachment.id],
  targetFolder: '',
}, token);
assert(moveToRoot?.success === true || moveToRoot === true, 'attachments.move to root', moveToRoot);

const deleteResult = await request('/api/file/delete', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ attachment_path: uploadJson.path }),
});
assert(deleteResult.response.ok && (deleteResult.json?.Message === 'Success' || deleteResult.json?.status === 200), 'file delete', deleteResult.json || deleteResult.text);

const siblingFolderName = `${renamedResourceFolderName} sibling`;
const siblingFolder = await trpc('attachments.createFolder', { folderName: siblingFolderName }, token);
assert(siblingFolder?.success === true, 'attachments.createFolder sibling folder', siblingFolder);

const deleteFolder = await trpc('attachments.delete', {
  isFolder: true,
  folderPath: renamedResourceFolderName,
}, token);
assert(deleteFolder?.success === true || deleteFolder === true, 'attachments.delete folder', deleteFolder);

const rootResourcesAfterFolderDelete = await trpc('attachments.list', {}, token, 'GET');
assert(
  Array.isArray(rootResourcesAfterFolderDelete)
    && rootResourcesAfterFolderDelete.some((item) => item.isFolder === true && item.folderName === siblingFolderName)
    && !rootResourcesAfterFolderDelete.some((item) => item.isFolder === true && item.folderName === renamedResourceFolderName),
  'attachments.delete folder should not delete sibling prefix folder',
  rootResourcesAfterFolderDelete,
);

const deleteSiblingFolder = await trpc('attachments.delete', {
  isFolder: true,
  folderPath: siblingFolderName,
}, token);
assert(deleteSiblingFolder?.success === true || deleteSiblingFolder === true, 'attachments.delete sibling folder', deleteSiblingFolder);

let s3Smoke = null;
if (s3SmokeEndpoint && s3SmokeBucket && s3SmokeAccessKey && s3SmokeSecretKey) {
  s3Smoke = await runS3Smoke(token, workspaceId);
}

const exportResult = await trpc('task.exportMarkdown', { format: 'markdown' }, token);
const exportPath = exportResult?.filePath || exportResult?.downloadUrl;
assert(exportResult?.success && exportPath, 'task.exportMarkdown', exportResult);

const zip = await fetch(base + exportPath, { headers: { Authorization: `Bearer ${token}` } });
assert(zip.status === 200 && /zip/.test(zip.headers.get('content-type') || ''), 'export zip download', {
  status: zip.status,
  contentType: zip.headers.get('content-type'),
});

const exportBytes = await zip.arrayBuffer();
const importForm = new FormData();
importForm.append('mode', 'workspace');
importForm.append('file', new Blob([exportBytes], { type: 'application/zip' }), `rust-smoke-import-${stamp}.zip`);
const importResult = await fetch(base + '/api/backup/import', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
  body: importForm,
});
const importJson = await importResult.json().catch(() => null);
assert(importResult.ok && importJson?.success === true && importJson.workspaceCount >= 1, 'backup import', importJson);
const importedWorkspaceId = importJson.workspaceIds?.[0];
assert(importedWorkspaceId, 'backup import workspace id', importJson);

const wrongWorkspaceRead = await request(retainedUploadJson.path, {
  headers: { Authorization: `Bearer ${token}`, 'x-workspace-id': String(importedWorkspaceId) },
});
assert(
  wrongWorkspaceRead.response.status === 401,
  'file read rejects wrong workspace header',
  { status: wrongWorkspaceRead.response.status, body: wrongWorkspaceRead.json || wrongWorkspaceRead.text },
);

const wrongWorkspaceDelete = await request('/api/file/delete', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'x-workspace-id': String(importedWorkspaceId),
    'content-type': 'application/json',
  },
  body: JSON.stringify({ attachment_path: retainedUploadJson.path }),
});
assert(
  wrongWorkspaceDelete.response.status === 403,
  'file delete rejects wrong workspace header',
  { status: wrongWorkspaceDelete.response.status, body: wrongWorkspaceDelete.json || wrongWorkspaceDelete.text },
);

const importedNotes = await trpc(
  'notes.list',
  { page: 1, size: 50, searchText: `Rust retained attachment ${stamp}` },
  token,
  'GET',
  { 'x-workspace-id': String(importedWorkspaceId) },
);
assert(Array.isArray(importedNotes), 'imported workspace notes.list', importedNotes);
const importedRetainedNote = importedNotes.find((item) => item.content?.includes(`Rust retained attachment ${stamp}`));
assert(importedRetainedNote?.content, 'imported retained note found', importedNotes);
assert(!importedRetainedNote.content.includes(retainedUploadJson.path), 'imported retained note should not keep old attachment path', importedRetainedNote);
const restoredPath = importedRetainedNote.content.match(/\/api\/file\/[^\s)"]+/)?.[0];
assert(restoredPath && restoredPath !== retainedUploadJson.path, 'imported retained note restored attachment path', importedRetainedNote);

const restoredFile = await request(restoredPath, {
  headers: { Authorization: `Bearer ${token}`, 'x-workspace-id': String(importedWorkspaceId) },
});
assert(restoredFile.response.status === 200 && restoredFile.text === retainedContent, 'restored attachment file content', {
  status: restoredFile.response.status,
  text: restoredFile.text,
  restoredPath,
});

const impact = await trpc('notes.deleteImpact', { ids: [todo.id] }, token, 'GET');
assert(typeof impact?.attachmentCount === 'number' && typeof impact?.commentCount === 'number', 'notes.deleteImpact', impact);

const trashResult = await trpc('notes.trashMany', { ids: [todo.id] }, token);
assert(trashResult === true, 'notes.trashMany', trashResult);

const restoreResult = await trpc('notes.updateMany', { ids: [todo.id], isArchived: false, isTop: false, isReviewed: false }, token);
assert(restoreResult === true, 'notes.updateMany', restoreResult);

const deleteManyResult = await trpc('notes.deleteMany', { ids: [todo.id] }, token);
assert(deleteManyResult === true, 'notes.deleteMany', deleteManyResult);

const deleteReplyResult = await trpc('comments.delete', { id: reply.id }, token);
assert(deleteReplyResult?.ok === true, 'comments.delete', deleteReplyResult);

const trashReference = await trpc('notes.trashMany', { ids: [referencedNote.id] }, token);
assert(trashReference === true, 'notes.trashMany referenced note', trashReference);

const clearRecycle = await trpc('notes.clearRecycleBin', {}, token);
assert(clearRecycle === true, 'notes.clearRecycleBin', clearRecycle);

console.log(JSON.stringify({
  ok: true,
  base,
  user,
  workspaceId,
  noteId: note.id,
  todoId: todo.id,
  importedWorkspaceId,
  restoredPath,
  uploadPath: uploadJson.path,
  retainedUploadPath: retainedUploadJson.path,
  s3Smoke,
  mockEmbeddingSmoke: mockEmbeddingSmoke ? {
    requestCount: mockEmbeddingRequestCount,
    vectorKinds,
  } : null,
  realEmbeddingSmoke: realEmbeddingSmoke ? {
    provider: realEmbeddingProvider,
    modelKey: realEmbeddingModelKey,
    localMock: realEmbeddingUseLocalMock,
    requestCount: localEmbeddingServer?.requestCount ?? null,
    vectorKinds,
  } : null,
  exportPath,
}, null, 2));
if (localEmbeddingServer) {
  await localEmbeddingServer.close();
}

async function runS3Smoke(token, workspaceId) {
  const s3Config = await trpc('config.saveAndValidateS3', {
    s3Endpoint: s3SmokeEndpoint,
    s3Region: s3SmokeRegion,
    s3Bucket: s3SmokeBucket,
    s3AccessKeyId: s3SmokeAccessKey,
    s3AccessKeySecret: s3SmokeSecretKey,
    s3CustomPath: s3SmokeCustomPath,
  }, token);
  assert(s3Config?.ok === true && s3Config?.objectStorage === 's3', 'config.saveAndValidateS3 real S3', s3Config);

  const s3Content = `hello rust s3 upload ${stamp}`;
  const s3FormData = new FormData();
  s3FormData.append('file', new Blob([s3Content], { type: 'text/plain' }), `rust-s3-${stamp}.txt`);
  const s3Upload = await fetch(base + '/api/file/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'x-workspace-id': String(workspaceId) },
    body: s3FormData,
  });
  const s3UploadJson = await s3Upload.json().catch(() => null);
  assert(
    s3Upload.ok
      && s3UploadJson?.path?.startsWith('/api/s3file/')
      && s3UploadJson?.filePath === s3UploadJson.path
      && s3UploadJson?.fileName
      && s3UploadJson?.Message === 'Success',
    's3 file upload',
    s3UploadJson,
  );

  const s3FileGet = await request(s3UploadJson.path, { headers: { Authorization: `Bearer ${token}` } });
  assert(s3FileGet.response.status === 200 && s3FileGet.text === s3Content, 's3 file get', {
    status: s3FileGet.response.status,
    text: s3FileGet.text,
  });

  const s3FolderName = `Rust S3 folder ${stamp}`;
  const s3Folder = await trpc('attachments.createFolder', { folderName: s3FolderName }, token);
  assert(s3Folder?.success === true, 's3 attachments.createFolder', s3Folder);

  const s3Search = await trpc('attachments.list', { searchText: s3UploadJson.name || `rust-s3-${stamp}` }, token, 'GET');
  const s3Attachment = s3Search.find((item) => item.path === s3UploadJson.path);
  assert(s3Attachment?.id, 's3 attachment listed', s3Search);

  const s3Move = await trpc('attachments.move', {
    sourceIds: [s3Attachment.id],
    targetFolder: s3FolderName,
  }, token);
  assert(s3Move?.success === true || s3Move === true, 's3 attachments.move', s3Move);

  const s3MovedList = await trpc('attachments.list', { folder: s3FolderName }, token, 'GET');
  const s3Moved = s3MovedList.find((item) => item.id === s3Attachment.id);
  assert(s3Moved?.path?.startsWith(`/api/s3file/${s3FolderName}/`), 's3 moved path', s3Moved);

  const s3MovedGet = await request(s3Moved.path, { headers: { Authorization: `Bearer ${token}` } });
  assert(s3MovedGet.response.status === 200 && s3MovedGet.text === s3Content, 's3 moved file get', {
    status: s3MovedGet.response.status,
    text: s3MovedGet.text,
  });

  const s3Delete = await request('/api/file/delete', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ attachment_path: s3Moved.path }),
  });
  assert(s3Delete.response.ok && (s3Delete.json?.Message === 'Success' || s3Delete.json?.status === 200), 's3 file delete', s3Delete.json || s3Delete.text);

  const s3DeletedGet = await request(s3Moved.path, { headers: { Authorization: `Bearer ${token}` } });
  assert(s3DeletedGet.response.status === 404, 's3 deleted file should 404', {
    status: s3DeletedGet.response.status,
    body: s3DeletedGet.json || s3DeletedGet.text,
  });

  const s3DeleteFolder = await trpc('attachments.delete', {
    isFolder: true,
    folderPath: s3FolderName,
  }, token);
  assert(s3DeleteFolder?.success === true || s3DeleteFolder === true, 's3 attachments.delete folder', s3DeleteFolder);

  const resetStorage = await trpc('config.saveAndValidateS3', {
    s3Endpoint: '',
    s3Region: '',
    s3Bucket: '',
    s3AccessKeyId: '',
    s3AccessKeySecret: '',
    s3CustomPath: '',
  }, token);
  assert(resetStorage?.ok === false && resetStorage?.objectStorage === 'local', 'reset objectStorage local after s3 smoke', resetStorage);

  return {
    uploadPath: s3UploadJson.path,
    movedPath: s3Moved.path,
    validationKey: s3Config.validationKey,
    forcePathStyle: s3Config.forcePathStyle,
  };
}
