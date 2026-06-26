#!/usr/bin/env node

import http from 'node:http';

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
const uploadByUrlPort = Number(process.env.BLINKORA_UPLOAD_BY_URL_PORT || 55988);
const uploadByUrlSourceURL = process.env.BLINKORA_UPLOAD_BY_URL_SOURCE_URL || `http://host.docker.internal:${uploadByUrlPort}/upload-by-url-${stamp}.txt`;

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

async function trpcRaw(path, input, token, method = 'POST', extraHeaders = {}) {
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

  return request(url, options);
}

async function trpc(path, input, token, method = 'POST', extraHeaders = {}) {
  const result = await trpcRaw(path, input, token, method, extraHeaders);
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

function flattenTagTree(tags) {
  const out = [];
  for (const tag of tags || []) {
    out.push(tag);
    out.push(...flattenTagTree(tag.children || []));
  }
  return out;
}

function redactAgentToken(value) {
  if (!value || typeof value !== 'object') return value;
  return {
    ...value,
    token: value.token ? '<redacted>' : value.token,
  };
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
  [
    'getWorkspaceContext',
    'searchBlinkora',
    'getBlinkora',
    'upsertBlinkora',
    'updateBlinkora',
    'deleteBlinkora',
    'listReferences',
    'addReference',
    'removeReference',
    'setReferences',
    'listComments',
    'createComment',
    'updateComment',
    'listTagTree',
  ].every((name) => mcpToolNames.includes(name)),
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

const agentWorkspaceA = await trpc('workspaces.create', {
  name: `Rust agent workspace A ${stamp}`,
  description: 'temporary agent token smoke workspace A',
  icon: 'tabler:robot',
  color: '#0f766e',
}, token);
assert(agentWorkspaceA?.id, 'agent workspace A create', agentWorkspaceA);

const agentWorkspaceB = await trpc('workspaces.create', {
  name: `Rust agent workspace B ${stamp}`,
  description: 'temporary agent token smoke workspace B',
  icon: 'tabler:robot-off',
  color: '#7f1d1d',
}, token);
assert(agentWorkspaceB?.id, 'agent workspace B create', agentWorkspaceB);

const workspaceAHeaders = { 'x-workspace-id': String(agentWorkspaceA.id) };
const workspaceBHeaders = { 'x-workspace-id': String(agentWorkspaceB.id) };
const agentSeedA = await trpc('notes.upsert', {
  content: `Rust agent workspace A seed ${stamp} #rust-agent-ws-smoke`,
  type: 0,
}, token, 'POST', workspaceAHeaders);
assert(agentSeedA?.id && agentSeedA.workspaceId === agentWorkspaceA.id, 'agent workspace A seed note', agentSeedA);

const agentSeedB = await trpc('notes.upsert', {
  content: `Rust agent workspace B private ${stamp}`,
  type: 0,
}, token, 'POST', workspaceBHeaders);
assert(agentSeedB?.id && agentSeedB.workspaceId === agentWorkspaceB.id, 'agent workspace B seed note', agentSeedB);

const createdAgentToken = await trpc('agentTokens.create', {
  workspaceId: agentWorkspaceA.id,
  name: `Rust smoke agent token ${stamp}`,
}, token);
assert(
  createdAgentToken?.id
    && createdAgentToken.token?.startsWith('bkws_')
    && createdAgentToken.workspaceId === agentWorkspaceA.id,
  'agentTokens.create returns one-time workspace token',
  redactAgentToken(createdAgentToken),
);
const workspaceAgentToken = createdAgentToken.token;

const listedAgentTokens = await trpc('agentTokens.list', { workspaceId: agentWorkspaceA.id }, token);
assert(
  Array.isArray(listedAgentTokens)
    && listedAgentTokens.some((item) => item.id === createdAgentToken.id)
    && listedAgentTokens.some((item) => item.id === createdAgentToken.id && item.token === workspaceAgentToken)
    && listedAgentTokens.every((item) => item.tokenHash === undefined),
  'agentTokens.list returns display token but omits tokenHash',
  listedAgentTokens.map(redactAgentToken),
);

const agentMcpGuide = await request('/api/agent/mcp-guide.md', {
  headers: { Authorization: `Bearer ${workspaceAgentToken}` },
});
assert(
  agentMcpGuide.response.ok
    && agentMcpGuide.text.includes('Blinkora MCP / Skill')
    && agentMcpGuide.text.includes('searchBlinkora'),
  'workspace agent can read MCP guide resource',
  { status: agentMcpGuide.response.status, body: agentMcpGuide.text.slice(0, 200) },
);

const agentSkillMd = await request('/api/agent/blinkora-workspace/SKILL.md', {
  headers: { Authorization: `Bearer ${workspaceAgentToken}` },
});
assert(
  agentSkillMd.response.ok
    && agentSkillMd.text.includes('name: blinkora-workspace')
    && agentSkillMd.text.includes('BLINKORA_AGENT_TOKEN'),
  'workspace agent can download skill markdown',
  { status: agentSkillMd.response.status, body: agentSkillMd.text.slice(0, 200) },
);

const agentSkillZip = await request('/api/agent/blinkora-workspace.zip', {
  headers: { Authorization: `Bearer ${workspaceAgentToken}` },
});
assert(
  agentSkillZip.response.ok
    && (agentSkillZip.response.headers.get('content-type') || '').includes('application/zip'),
  'workspace agent can download skill zip',
  {
    status: agentSkillZip.response.status,
    contentType: agentSkillZip.response.headers.get('content-type'),
  },
);

const wrongWorkspaceHeader = await trpcRaw('notes.list', { page: 1, size: 10 }, workspaceAgentToken, 'GET', workspaceBHeaders);
assert(wrongWorkspaceHeader.response.status === 401, 'workspace agent rejects mismatched x-workspace-id', {
  status: wrongWorkspaceHeader.response.status,
  body: wrongWorkspaceHeader.json || wrongWorkspaceHeader.text,
});

const scopedWorkspacesList = await trpcRaw('workspaces.list', {}, workspaceAgentToken);
assert(
  scopedWorkspacesList.json?.error?.json?.data?.httpStatus === 403,
  'workspace agent cannot call workspaces.list',
  scopedWorkspacesList.json || scopedWorkspacesList.text,
);

const scopedConfigList = await trpcRaw('config.list', {}, workspaceAgentToken, 'GET');
assert(
  scopedConfigList.json?.error?.json?.data?.httpStatus === 403,
  'workspace agent cannot call config.list',
  scopedConfigList.json || scopedConfigList.text,
);

const scopedAgentTokenList = await trpcRaw('agentTokens.list', { workspaceId: agentWorkspaceA.id }, workspaceAgentToken);
assert(
  scopedAgentTokenList.json?.error?.json?.data?.httpStatus === 403,
  'workspace agent cannot manage agent tokens',
  scopedAgentTokenList.json || scopedAgentTokenList.text,
);

const agentMcp = await openMcpSession(workspaceAgentToken);
const agentTools = await agentMcp.rpc('tools/list', {});
const agentToolNames = agentTools.result?.tools?.map((tool) => tool.name) || [];
assert(
  [
    'getWorkspaceContext',
    'searchBlinkora',
    'getBlinkora',
    'upsertBlinkora',
    'updateBlinkora',
    'deleteBlinkora',
    'listReferences',
    'addReference',
    'removeReference',
    'setReferences',
    'listComments',
    'createComment',
    'updateComment',
    'listTagTree',
  ].every((name) => agentToolNames.includes(name))
    && !agentToolNames.includes('workspaces.list'),
  'workspace agent MCP tools/list scoped tools',
  agentTools,
);

const agentFlash = await agentMcp.rpc('tools/call', {
  name: 'upsertBlinkora',
  arguments: { content: `Agent flash ${stamp} #rust-agent-ws-smoke`, type: 'blinkora' },
});
const agentFlashNote = agentFlash.result?.structuredContent;
assert(agentFlashNote?.id && agentFlashNote.type === 0 && agentFlashNote.workspaceId === agentWorkspaceA.id, 'workspace agent upsert blinkora', agentFlash);

const agentNote = await agentMcp.rpc('tools/call', {
  name: 'upsertBlinkora',
  arguments: { content: `Agent note ${stamp} #rust-agent-ws-smoke`, type: 'note' },
});
const agentNoteValue = agentNote.result?.structuredContent;
assert(agentNoteValue?.id && agentNoteValue.type === 1 && agentNoteValue.workspaceId === agentWorkspaceA.id, 'workspace agent upsert note', agentNote);

const agentTodo = await agentMcp.rpc('tools/call', {
  name: 'upsertBlinkora',
  arguments: { content: `Agent todo ${stamp}`, type: 'todo' },
});
const agentTodoValue = agentTodo.result?.structuredContent;
assert(agentTodoValue?.id && agentTodoValue.type === 2 && agentTodoValue.workspaceId === agentWorkspaceA.id, 'workspace agent upsert todo', agentTodo);

const agentGet = await agentMcp.rpc('tools/call', {
  name: 'getBlinkora',
  arguments: { id: agentNoteValue.id },
});
assert(agentGet.result?.structuredContent?.id === agentNoteValue.id, 'workspace agent getBlinkora', agentGet);

const agentNoteUpdated = await agentMcp.rpc('tools/call', {
  name: 'updateBlinkora',
  arguments: { id: agentNoteValue.id, content: `Agent note updated ${stamp} #rust-agent-ws-smoke`, type: 1 },
});
assert(
  agentNoteUpdated.result?.structuredContent?.id === agentNoteValue.id
    && agentNoteUpdated.result.structuredContent.content.includes('updated'),
  'workspace agent updateBlinkora',
  agentNoteUpdated,
);

const agentComment = await agentMcp.rpc('tools/call', {
  name: 'createComment',
  arguments: { noteId: agentNoteValue.id, content: `Agent comment ${stamp}`, kind: 'annotation' },
});
const agentCommentValue = agentComment.result?.structuredContent;
assert(agentCommentValue?.id && agentCommentValue.noteId === agentNoteValue.id, 'workspace agent createComment', agentComment);

const agentCommentUpdated = await agentMcp.rpc('tools/call', {
  name: 'updateComment',
  arguments: { id: agentCommentValue.id, content: `Agent comment updated ${stamp}`, status: 'open' },
});
assert(
  agentCommentUpdated.result?.structuredContent?.id === agentCommentValue.id
    && agentCommentUpdated.result.structuredContent.content.includes('updated'),
  'workspace agent updateComment',
  agentCommentUpdated,
);

const agentComments = await agentMcp.rpc('tools/call', {
  name: 'listComments',
  arguments: { noteId: agentNoteValue.id },
});
assert(
  Array.isArray(agentComments.result?.structuredContent)
    && agentComments.result.structuredContent.some((item) => item.id === agentCommentValue.id),
  'workspace agent listComments',
  agentComments,
);

const agentTagTree = await agentMcp.rpc('tools/call', {
  name: 'listTagTree',
  arguments: {},
});
const agentTags = flattenTagTree(agentTagTree.result?.structuredContent?.tags || []);
assert(
  agentTagTree.result?.structuredContent?.success === true
    && agentTags.some((tag) => tag.name === 'rust-agent-ws-smoke'),
  'workspace agent listTagTree',
  agentTagTree,
);

const agentWorkspaceASearch = await agentMcp.rpc('tools/call', {
  name: 'searchBlinkora',
  arguments: { searchText: `Rust agent workspace A seed ${stamp}`, page: 1, size: 20 },
});
assert(
  agentWorkspaceASearch.result?.structuredContent?.notes?.some((item) => item.id === agentSeedA.id),
  'workspace agent can search bound workspace',
  agentWorkspaceASearch,
);

const agentWorkspaceBSearch = await agentMcp.rpc('tools/call', {
  name: 'searchBlinkora',
  arguments: { searchText: `Rust agent workspace B private ${stamp}`, page: 1, size: 20 },
});
assert(
  !agentWorkspaceBSearch.result?.structuredContent?.notes?.some((item) => item.id === agentSeedB.id),
  'workspace agent cannot search other workspace',
  agentWorkspaceBSearch,
);
agentMcp.close();

const revokedAgentToken = await trpc('agentTokens.revoke', { id: createdAgentToken.id }, token);
assert(revokedAgentToken?.id === createdAgentToken.id && revokedAgentToken.revokedAt, 'agentTokens.revoke', revokedAgentToken);

const revokedAgentSse = await request('/sse', {
  headers: { Authorization: `Bearer ${workspaceAgentToken}` },
});
assert(revokedAgentSse.response.status === 401, 'revoked workspace agent token rejects MCP SSE', {
  status: revokedAgentSse.response.status,
  body: revokedAgentSse.json || revokedAgentSse.text,
});

const revokedAgentTrpc = await trpcRaw('notes.list', { page: 1, size: 10 }, workspaceAgentToken, 'GET');
assert(revokedAgentTrpc.response.status === 401, 'revoked workspace agent token rejects tRPC', {
  status: revokedAgentTrpc.response.status,
  body: revokedAgentTrpc.json || revokedAgentTrpc.text,
});

const deleteAgentWorkspaceA = await trpc('workspaces.delete', { id: agentWorkspaceA.id }, token);
assert(deleteAgentWorkspaceA === true || deleteAgentWorkspaceA?.success === true, 'agent workspace A delete', deleteAgentWorkspaceA);

const deleteAgentWorkspaceB = await trpc('workspaces.delete', { id: agentWorkspaceB.id }, token);
assert(deleteAgentWorkspaceB === true || deleteAgentWorkspaceB?.success === true, 'agent workspace B delete', deleteAgentWorkspaceB);

const configUpdate = await trpc('config.update', { key: 'theme', value: 'light' }, token);
assert(configUpdate === true, 'config.update', configUpdate);

const configList = await trpc('config.list', {}, token, 'GET');
assert(configList && typeof configList === 'object', 'config.list', configList);

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

const convertedNote = await trpc('notes.upsert', { id: note.id, content: null, type: 1 }, token);
assert(
  convertedNote?.id === note.id && convertedNote.type === 1 && convertedNote.content === editedNote.content,
  'notes.upsert type-only update keeps content',
  convertedNote,
);

const restoredTypeNote = await trpc('notes.upsert', { id: note.id, type: 0 }, token);
assert(
  restoredTypeNote?.id === note.id && restoredTypeNote.type === 0 && restoredTypeNote.content === editedNote.content,
  'notes.upsert omitted-content type update keeps content',
  restoredTypeNote,
);

const archivedViaUpsert = await trpc('notes.upsert', { id: note.id, isArchived: true }, token);
assert(
  archivedViaUpsert?.id === note.id && archivedViaUpsert.isArchived === true,
  'notes.upsert archive flag update',
  archivedViaUpsert,
);

const archivedListViaUpsert = await trpc(
  'notes.list',
  { page: 1, size: 20, isArchived: true, searchText: `Rust smoke note edited ${stamp}` },
  token,
  'GET',
);
assert(
  Array.isArray(archivedListViaUpsert) && archivedListViaUpsert.some((item) => item.id === note.id),
  'notes.list archived note after upsert flag update',
  archivedListViaUpsert,
);

const restoredViaUpsert = await trpc('notes.upsert', { id: note.id, isArchived: false, isTop: true }, token);
assert(
  restoredViaUpsert?.id === note.id && restoredViaUpsert.isArchived === false && restoredViaUpsert.isTop === true,
  'notes.upsert restore and top flag update',
  restoredViaUpsert,
);

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

const archivedSearchDecoy = await trpc('notes.upsert', { content: `Rust smoke note edited ${stamp} archived decoy`, type: 0 }, token);
assert(archivedSearchDecoy?.id, 'notes.upsert archived search decoy', archivedSearchDecoy);

const archiveSearchDecoyResult = await trpc('notes.updateMany', { ids: [archivedSearchDecoy.id], isArchived: true }, token);
assert(archiveSearchDecoyResult === true, 'notes.updateMany archived search decoy', archiveSearchDecoyResult);

const recycledSearchDecoy = await trpc('notes.upsert', { content: `Rust smoke note edited ${stamp} recycled decoy`, type: 0 }, token);
assert(recycledSearchDecoy?.id, 'notes.upsert recycled search decoy', recycledSearchDecoy);

const recycleSearchDecoyResult = await trpc('notes.trashMany', { ids: [recycledSearchDecoy.id] }, token);
assert(recycleSearchDecoyResult === true, 'notes.trashMany recycled search decoy', recycleSearchDecoyResult);

const withLinkList = await trpc('notes.list', { page: 1, size: 20, withLink: true, searchText: `Rust smoke link ${stamp}` }, token);
assert(Array.isArray(withLinkList) && withLinkList.some((item) => item.id === linkNote.id), 'notes.list withLink filter', withLinkList);

const hasTodoList = await trpc('notes.list', { page: 1, size: 20, hasTodo: true, searchText: `Rust smoke checklist ${stamp}` }, token);
assert(Array.isArray(hasTodoList) && hasTodoList.some((item) => item.id === todoPatternNote.id), 'notes.list hasTodo filter', hasTodoList);

const startDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const endDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const dateList = await trpc('notes.list', { page: 1, size: 20, startDate, endDate, searchText: `Rust smoke note edited ${stamp}` }, token);
assert(Array.isArray(dateList) && dateList.some((item) => item.id === note.id), 'notes.list date filter', dateList);

const keywordList = await trpc('notes.list', { page: 1, size: 20, searchText: `Rust smoke note edited ${stamp}` }, token);
assert(
  Array.isArray(keywordList)
    && keywordList.some((item) => item.id === note.id)
    && !keywordList.some((item) => item.id === archivedSearchDecoy.id || item.id === recycledSearchDecoy.id),
  'notes.list keyword search finds active note only',
  keywordList,
);

const atLiteralNote = await trpc('notes.upsert', { content: `Rust smoke @literal ${stamp}`, type: 0 }, token);
assert(atLiteralNote?.id, 'notes.upsert at-literal note', atLiteralNote);

const atLiteralList = await trpc('notes.list', { page: 1, size: 20, searchText: `@literal ${stamp}` }, token);
assert(
  Array.isArray(atLiteralList) && atLiteralList.some((item) => item.id === atLiteralNote.id),
  'notes.list treats @ as an ordinary search character',
  atLiteralList,
);

const tagFilterSearchList = await trpc('notes.list', { page: 1, size: 20, tagId: rustSmokeTag.id, searchText: `Rust smoke note edited ${stamp}` }, token);
assert(
  Array.isArray(tagFilterSearchList) && tagFilterSearchList.some((item) => item.id === note.id),
  'notes.list keyword search respects tagId filter positive',
  tagFilterSearchList,
);

const tagFilterNegativeList = await trpc('notes.list', { page: 1, size: 20, tagId: rustSmokeTag.id, searchText: `Rust smoke link ${stamp}` }, token);
assert(
  Array.isArray(tagFilterNegativeList) && !tagFilterNegativeList.some((item) => item.id === linkNote.id),
  'notes.list keyword search respects tagId filter negative',
  tagFilterNegativeList,
);

const withoutTagList = await trpc('notes.list', { page: 1, size: 20, withoutTag: true, searchText: `Rust smoke link ${stamp}` }, token);
assert(
  Array.isArray(withoutTagList) && withoutTagList.some((item) => item.id === linkNote.id),
  'notes.list keyword search respects withoutTag filter positive',
  withoutTagList,
);

const withoutTagNegativeList = await trpc('notes.list', { page: 1, size: 20, withoutTag: true, searchText: `Rust smoke note edited ${stamp}` }, token);
assert(
  Array.isArray(withoutTagNegativeList) && !withoutTagNegativeList.some((item) => item.id === note.id),
  'notes.list keyword search respects withoutTag filter negative',
  withoutTagNegativeList,
);

const withLinkNegativeList = await trpc('notes.list', { page: 1, size: 20, withLink: true, searchText: `Rust smoke note edited ${stamp}` }, token);
assert(
  Array.isArray(withLinkNegativeList) && !withLinkNegativeList.some((item) => item.id === note.id),
  'notes.list keyword search respects withLink filter negative',
  withLinkNegativeList,
);

const hasTodoNegativeList = await trpc('notes.list', { page: 1, size: 20, hasTodo: true, searchText: `Rust smoke note edited ${stamp}` }, token);
assert(
  Array.isArray(hasTodoNegativeList) && !hasTodoNegativeList.some((item) => item.id === note.id),
  'notes.list keyword search respects hasTodo filter negative',
  hasTodoNegativeList,
);

const dateFilterSearchList = await trpc('notes.list', { page: 1, size: 20, startDate, endDate, searchText: `Rust smoke note edited ${stamp}` }, token);
assert(
  Array.isArray(dateFilterSearchList) && dateFilterSearchList.some((item) => item.id === note.id),
  'notes.list keyword search respects date filter positive',
  dateFilterSearchList,
);

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

const withFileNegativeList = await trpc('notes.list', { page: 1, size: 20, withFile: true, searchText: `Rust smoke note edited ${stamp}` }, token);
assert(
  Array.isArray(withFileNegativeList) && !withFileNegativeList.some((item) => item.id === note.id),
  'notes.list withFile filter negative',
  withFileNegativeList,
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
  exportPath,
}, null, 2));

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
