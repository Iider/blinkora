#!/usr/bin/env node

const base = process.env.BLINKORA_BASE_URL || "http://127.0.0.1:6676";
const accountToken = process.env.BLINKORA_ACCOUNT_TOKEN || "";
const stamp = Date.now();

if (!accountToken) {
  console.error("BLINKORA_ACCOUNT_TOKEN is required for workspace agent smoke");
  process.exit(1);
}

const createdWorkspaces = [];
const createdAgentTokenIds = [];

function fail(message, details) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function assert(condition, message, details) {
  if (!condition) {
    fail(message, details);
  }
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      key.toLowerCase().includes("token") ||
      (typeof item === "string" && item.startsWith("bkws_"))
    ) {
      out[key] = "<redacted>";
    } else {
      out[key] = redact(item);
    }
  }
  return out;
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

async function requestBytes(path, options = {}) {
  const response = await fetch(base + path, options);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { response, bytes };
}

function trpcData(payload) {
  return payload?.result?.data?.json;
}

async function trpcRaw(path, input, token, method = "POST", extraHeaders = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  Object.assign(headers, extraHeaders);

  let url = `/api/trpc/${path}`;
  const options = { method, headers };
  if (method === "GET") {
    url += `?input=${encodeURIComponent(JSON.stringify({ json: input ?? null }))}`;
  } else {
    headers["content-type"] = "application/json";
    options.body = JSON.stringify({ json: input ?? null });
  }

  return request(url, options);
}

async function trpc(
  path,
  input,
  token = accountToken,
  method = "POST",
  extraHeaders = {},
) {
  const result = await trpcRaw(path, input, token, method, extraHeaders);
  assert(
    result.response.ok,
    `${method} ${path} HTTP ${result.response.status}`,
    result.json || result.text,
  );
  assert(!result.json?.error, `${method} ${path} tRPC error`, result.json);
  return trpcData(result.json);
}

function parseSseEvent(raw) {
  const event = { event: "message", data: "" };
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) {
      event.event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      event.data += line.slice(5).trimStart();
    }
  }
  return event;
}

async function openMcpSession(token) {
  const response = await fetch(base + "/sse", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(response.ok && response.body, "MCP SSE open", {
    status: response.status,
    contentType: response.headers.get("content-type"),
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  async function readEvent(predicate, label) {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      assert(!done, `MCP SSE closed while waiting for ${label}`);
      buffer += decoder.decode(value, { stream: true });
      let splitAt;
      while ((splitAt = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, splitAt);
        buffer = buffer.slice(splitAt + 2);
        const event = parseSseEvent(raw);
        if (predicate(event)) return event;
      }
    }
    fail(`MCP SSE timeout waiting for ${label}`, { buffer });
  }

  const endpointEvent = await readEvent(
    (event) => event.event === "endpoint" && event.data,
    "endpoint",
  );
  const endpoint = endpointEvent.data.trim();

  async function rpc(method, params) {
    const id = Math.floor(Math.random() * 1_000_000);
    const post = await fetch(base + endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    assert(post.status === 202, `MCP ${method} POST`, {
      status: post.status,
      text: await post.text(),
    });
    const event = await readEvent((item) => {
      if (item.event !== "message") return false;
      const payload = JSON.parse(item.data);
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

function flattenTagTree(tags) {
  const out = [];
  for (const tag of tags || []) {
    out.push(tag);
    out.push(...flattenTagTree(tag.children || []));
  }
  return out;
}

async function expectForbidden(path, input, token, method = "POST") {
  const result = await trpcRaw(path, input, token, method);
  assert(
    result.json?.error?.json?.data?.httpStatus === 403,
    `workspace token forbids ${path}`,
    result.json || result.text,
  );
}

async function cleanup() {
  for (const id of createdAgentTokenIds.reverse()) {
    try {
      await trpc("agentTokens.revoke", { id }, accountToken);
    } catch {
      // Best effort cleanup only.
    }
  }
  for (const id of createdWorkspaces.reverse()) {
    try {
      await trpc("workspaces.delete", { id }, accountToken);
    } catch {
      // Best effort cleanup only.
    }
  }
}

async function main() {
  const health = await request("/health");
  assert(
    health.response.ok && health.json?.status === "ok",
    "health",
    health.json || health.text,
  );
  pass("health");

  const unauthGuide = await request("/api/agent/mcp-guide.md");
  assert(
    unauthGuide.response.status === 401,
    "agent resource rejects missing token",
    {
      status: unauthGuide.response.status,
      body: unauthGuide.json || unauthGuide.text,
    },
  );
  pass("agent resource unauthorized");

  const workspaceA = await trpc("workspaces.create", {
    name: `Agent smoke A ${stamp}`,
    description: "temporary workspace agent smoke A",
    icon: "tabler:robot",
    color: "#0f766e",
  });
  createdWorkspaces.push(workspaceA.id);

  const workspaceB = await trpc("workspaces.create", {
    name: `Agent smoke B ${stamp}`,
    description: "temporary workspace agent smoke B",
    icon: "tabler:robot-off",
    color: "#7f1d1d",
  });
  createdWorkspaces.push(workspaceB.id);
  pass("workspace setup");

  const headersA = { "x-workspace-id": String(workspaceA.id) };
  const headersB = { "x-workspace-id": String(workspaceB.id) };

  const seedA = await trpc(
    "notes.upsert",
    {
      content: `Agent smoke A seed ${stamp} #agent-smoke-${stamp}`,
      type: 0,
    },
    accountToken,
    "POST",
    headersA,
  );
  const seedB = await trpc(
    "notes.upsert",
    {
      content: `Agent smoke B private ${stamp}`,
      type: 0,
    },
    accountToken,
    "POST",
    headersB,
  );
  assert(
    seedA.workspaceId === workspaceA.id && seedB.workspaceId === workspaceB.id,
    "seed workspace ids",
    { seedA, seedB },
  );
  pass("seed notes");

  const createdToken = await trpc("agentTokens.create", {
    workspaceId: workspaceA.id,
    name: `Agent smoke token ${stamp}`,
  });
  assert(
    createdToken?.id &&
      createdToken?.token?.startsWith("bkws_") &&
      createdToken.workspaceId === workspaceA.id,
    "agent token create returns token",
    createdToken,
  );
  createdAgentTokenIds.push(createdToken.id);
  const agentToken = createdToken.token;

  const listedTokens = await trpc("agentTokens.list", {
    workspaceId: workspaceA.id,
  });
  assert(
    Array.isArray(listedTokens) &&
      listedTokens.some(
        (item) => item.id === createdToken.id && item.token === agentToken,
      ) &&
      listedTokens.every((item) => item.tokenHash === undefined),
    "agent token list returns display token and hides hash",
    listedTokens,
  );
  pass("agent token create/list display");

  const guide = await request("/api/agent/mcp-guide.md", {
    headers: { Authorization: `Bearer ${agentToken}` },
  });
  assert(
    guide.response.ok &&
      guide.text.includes("Blinkora MCP / Skill") &&
      guide.text.includes("searchBlinkora") &&
      guide.text.includes("cleanupOrphanTags") &&
      guide.text.includes("卡片讨论交接"),
    "agent token can read mcp guide",
    { status: guide.response.status, body: guide.text.slice(0, 200) },
  );
  const skill = await request("/api/agent/blinkora-workspace/SKILL.md", {
    headers: { Authorization: `Bearer ${agentToken}` },
  });
  assert(
    skill.response.ok &&
      skill.text.includes("name: blinkora-workspace") &&
      skill.text.includes("BLINKORA_AGENT_TOKEN") &&
      skill.text.includes("Card Discussion Handoffs") &&
      skill.text.includes("references/mcp-sse-python-client.md"),
    "agent token can read skill markdown",
    { status: skill.response.status, body: skill.text.slice(0, 200) },
  );
  const zip = await requestBytes("/api/agent/blinkora-workspace.zip", {
    headers: { Authorization: `Bearer ${agentToken}` },
  });
  assert(
    zip.response.ok &&
      (zip.response.headers.get("content-type") || "").includes(
        "application/zip",
      ) &&
      zip.bytes.length > 200 &&
      zip.bytes[0] === 0x50 &&
      zip.bytes[1] === 0x4b,
    "agent token can download skill zip",
    {
      status: zip.response.status,
      contentType: zip.response.headers.get("content-type"),
      size: zip.bytes.length,
    },
  );
  pass("agent resources");

  const readableAttachmentBody = `agent-readable-attachment-${stamp}`;
  const readableAttachmentForm = new FormData();
  readableAttachmentForm.append(
    "file",
    new Blob([readableAttachmentBody], { type: "text/plain" }),
    `agent-readable-${stamp}.txt`,
  );
  const readableAttachmentUpload = await fetch(base + "/api/file/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accountToken}`,
      "x-workspace-id": String(workspaceA.id),
    },
    body: readableAttachmentForm,
  });
  const readableAttachment = await readableAttachmentUpload
    .json()
    .catch(() => null);
  assert(
    readableAttachmentUpload.ok && readableAttachment?.path,
    "account can seed readable attachment",
    readableAttachment,
  );

  const agentAttachmentRead = await request(readableAttachment.path, {
    headers: { Authorization: `Bearer ${agentToken}` },
  });
  assert(
    agentAttachmentRead.response.status === 200 &&
      agentAttachmentRead.text === readableAttachmentBody,
    "workspace token can read bound attachment file",
    {
      status: agentAttachmentRead.response.status,
      body: agentAttachmentRead.text,
    },
  );

  const agentAttachmentWrongWorkspaceRead = await request(
    readableAttachment.path,
    {
      headers: {
        Authorization: `Bearer ${agentToken}`,
        "x-workspace-id": String(workspaceB.id),
      },
    },
  );
  assert(
    agentAttachmentWrongWorkspaceRead.response.status === 401,
    "workspace token cannot read attachment with mismatched workspace header",
    {
      status: agentAttachmentWrongWorkspaceRead.response.status,
      body:
        agentAttachmentWrongWorkspaceRead.json ||
        agentAttachmentWrongWorkspaceRead.text,
    },
  );

  const deniedAttachmentForm = new FormData();
  deniedAttachmentForm.append(
    "file",
    new Blob(["denied"], { type: "text/plain" }),
    `agent-denied-${stamp}.txt`,
  );
  const agentAttachmentUpload = await fetch(base + "/api/file/upload", {
    method: "POST",
    headers: { Authorization: `Bearer ${agentToken}` },
    body: deniedAttachmentForm,
  });
  assert(
    agentAttachmentUpload.status === 401,
    "workspace token cannot upload attachment files",
    {
      status: agentAttachmentUpload.status,
      body: await agentAttachmentUpload.text(),
    },
  );

  const agentAttachmentDelete = await request("/api/file/delete", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${agentToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ attachment_path: readableAttachment.path }),
  });
  assert(
    agentAttachmentDelete.response.status === 401,
    "workspace token cannot delete attachment files",
    {
      status: agentAttachmentDelete.response.status,
      body: agentAttachmentDelete.json || agentAttachmentDelete.text,
    },
  );
  await expectForbidden("attachments.list", {}, agentToken, "GET");
  pass("attachment read boundary");

  const wrongWorkspaceHeader = await trpcRaw(
    "notes.list",
    { page: 1, size: 10 },
    agentToken,
    "GET",
    headersB,
  );
  assert(
    wrongWorkspaceHeader.response.status === 401,
    "workspace token rejects mismatched x-workspace-id",
    {
      status: wrongWorkspaceHeader.response.status,
      body: wrongWorkspaceHeader.json || wrongWorkspaceHeader.text,
    },
  );
  await expectForbidden("workspaces.list", {}, agentToken);
  await expectForbidden("config.list", {}, agentToken, "GET");
  await expectForbidden(
    "agentTokens.list",
    { workspaceId: workspaceA.id },
    agentToken,
  );
  pass("authorization boundaries");

  const mcp = await openMcpSession(agentToken);
  const tools = await mcp.rpc("tools/list", {});
  const toolNames = tools.result?.tools?.map((tool) => tool.name) || [];
  const expectedTools = [
    "getWorkspaceContext",
    "searchBlinkora",
    "getBlinkora",
    "upsertBlinkora",
    "updateBlinkora",
    "deleteBlinkora",
    "listReferences",
    "addReference",
    "removeReference",
    "setReferences",
    "listComments",
    "createComment",
    "updateComment",
    "listTagTree",
    "cleanupOrphanTags",
    "listOperationLogs",
  ];
  assert(
    expectedTools.every((name) => toolNames.includes(name)) &&
      !toolNames.includes("workspaces.list"),
    "workspace MCP tools/list",
    tools,
  );

  const context = await mcp.rpc("tools/call", {
    name: "getWorkspaceContext",
    arguments: {},
  });
  assert(
    context.result?.structuredContent?.workspace?.id === workspaceA.id,
    "MCP getWorkspaceContext",
    context,
  );

  const flash = await mcp.rpc("tools/call", {
    name: "upsertBlinkora",
    arguments: {
      content: `Agent smoke flash ${stamp} #agent-smoke-${stamp}`,
      type: "blinkora",
    },
  });
  const flashNote = flash.result?.structuredContent;
  assert(
    flashNote?.type === 0 && flashNote.workspaceId === workspaceA.id,
    "MCP upsert blinkora",
    flash,
  );

  const note = await mcp.rpc("tools/call", {
    name: "upsertBlinkora",
    arguments: {
      content: `Agent smoke note ${stamp} #agent-smoke-${stamp}`,
      type: "note",
      metadata: { smokeKey: stamp, kind: "source" },
    },
  });
  const noteValue = note.result?.structuredContent;
  assert(
    noteValue?.type === 1 &&
      noteValue.workspaceId === workspaceA.id &&
      noteValue.metadata?.smokeKey === stamp,
    "MCP upsert note",
    note,
  );

  const todo = await mcp.rpc("tools/call", {
    name: "upsertBlinkora",
    arguments: { content: `Agent smoke todo ${stamp}`, type: "todo" },
  });
  const todoValue = todo.result?.structuredContent;
  assert(
    todoValue?.type === 2 && todoValue.workspaceId === workspaceA.id,
    "MCP upsert todo",
    todo,
  );

  const got = await mcp.rpc("tools/call", {
    name: "getBlinkora",
    arguments: { id: noteValue.id },
  });
  assert(
    got.result?.structuredContent?.id === noteValue.id,
    "MCP getBlinkora",
    got,
  );

  const contentOnlyUpdate = await mcp.rpc("tools/call", {
    name: "updateBlinkora",
    arguments: {
      id: noteValue.id,
      content: `Agent smoke content-only note ${stamp} #agent-smoke-${stamp}`,
    },
  });
  assert(
    contentOnlyUpdate.result?.structuredContent?.type === 1 &&
      contentOnlyUpdate.result?.structuredContent?.content.includes(
        "content-only",
      ),
    "MCP updateBlinkora preserves omitted type",
    contentOnlyUpdate,
  );

  const updated = await mcp.rpc("tools/call", {
    name: "updateBlinkora",
    arguments: {
      id: noteValue.id,
      content: `Agent smoke updated note ${stamp} #agent-smoke-${stamp}`,
      type: 1,
      metadata: { smokeKey: stamp, kind: "updated" },
    },
  });
  assert(
    updated.result?.structuredContent?.content.includes("updated") &&
      updated.result?.structuredContent?.metadata?.kind === "updated",
    "MCP updateBlinkora",
    updated,
  );

  const operationLogs = await mcp.rpc("tools/call", {
    name: "listOperationLogs",
    arguments: {
      afterId: 0,
      actorType: "agent",
      noteTypes: [1],
      orderBy: "asc",
      size: 20,
    },
  });
  assert(
    operationLogs.result?.structuredContent?.items?.some?.(
      (item) =>
        item.target?.noteId === noteValue.id &&
        item.actor?.type === "agent" &&
        !JSON.stringify(item.details || {}).includes("Agent smoke updated"),
    ),
    "MCP listOperationLogs cursor query",
    operationLogs,
  );

  const propertyUpdate = await mcp.rpc("tools/call", {
    name: "updateBlinkora",
    arguments: {
      id: noteValue.id,
      metadata: {
        smokeKey: stamp,
        kind: "updated",
        properties: {
          status: "open",
          rating: 4,
          labels: ["agent-smoke"],
        },
      },
    },
  });
  assert(
    propertyUpdate.result?.structuredContent?.type === 1 &&
      propertyUpdate.result?.structuredContent?.metadata?.properties?.status ===
        "open",
    "MCP updateBlinkora writes custom properties",
    propertyUpdate,
  );

  const metadataSearch = await mcp.rpc("tools/call", {
    name: "searchBlinkora",
    arguments: {
      metadata: { smokeKey: stamp },
      page: 1,
      size: 20,
      type: "note",
    },
  });
  assert(
    metadataSearch.result?.structuredContent?.notes?.some(
      (item) => item.id === noteValue.id,
    ),
    "MCP metadata search",
    metadataSearch,
  );

  const propertySearch = await mcp.rpc("tools/call", {
    name: "searchBlinkora",
    arguments: {
      metadata: { properties: { status: "open" } },
      includePageInfo: true,
      page: 1,
      size: 20,
      type: "note",
    },
  });
  assert(
    propertySearch.result?.structuredContent?.notes?.some(
      (item) => item.id === noteValue.id,
    ) && propertySearch.result?.structuredContent?.pageInfo?.page === 1,
    "MCP metadata.properties search with page info",
    propertySearch,
  );

  const addedReference = await mcp.rpc("tools/call", {
    name: "addReference",
    arguments: { fromNoteId: noteValue.id, toNoteId: flashNote.id },
  });
  assert(
    addedReference.result?.structuredContent?.success === true,
    "MCP addReference",
    addedReference,
  );

  const listedReferences = await mcp.rpc("tools/call", {
    name: "listReferences",
    arguments: { noteId: noteValue.id },
  });
  assert(
    listedReferences.result?.structuredContent?.some?.(
      (item) =>
        item.fromNoteId === noteValue.id && item.toNoteId === flashNote.id,
    ),
    "MCP listReferences",
    listedReferences,
  );

  const setReferences = await mcp.rpc("tools/call", {
    name: "setReferences",
    arguments: { fromNoteId: noteValue.id, toNoteIds: [todoValue.id] },
  });
  assert(
    setReferences.result?.structuredContent?.references?.some?.(
      (item) =>
        item.fromNoteId === noteValue.id && item.toNoteId === todoValue.id,
    ),
    "MCP setReferences",
    setReferences,
  );

  const removedReference = await mcp.rpc("tools/call", {
    name: "removeReference",
    arguments: { fromNoteId: noteValue.id, toNoteId: todoValue.id },
  });
  assert(
    removedReference.result?.structuredContent?.deleted >= 1,
    "MCP removeReference",
    removedReference,
  );

  const comment = await mcp.rpc("tools/call", {
    name: "createComment",
    arguments: {
      noteId: noteValue.id,
      content: `Agent smoke comment ${stamp}`,
      kind: "annotation",
    },
  });
  const commentValue = comment.result?.structuredContent;
  assert(
    commentValue?.id && commentValue.noteId === noteValue.id,
    "MCP createComment",
    comment,
  );

  const commentUpdate = await mcp.rpc("tools/call", {
    name: "updateComment",
    arguments: {
      id: commentValue.id,
      content: `Agent smoke comment updated ${stamp}`,
      status: "open",
    },
  });
  assert(
    commentUpdate.result?.structuredContent?.content.includes("updated"),
    "MCP updateComment",
    commentUpdate,
  );

  const comments = await mcp.rpc("tools/call", {
    name: "listComments",
    arguments: { noteId: noteValue.id },
  });
  assert(
    comments.result?.structuredContent?.some?.(
      (item) => item.id === commentValue.id,
    ),
    "MCP listComments",
    comments,
  );

  const tags = await mcp.rpc("tools/call", {
    name: "listTagTree",
    arguments: {},
  });
  const flatTags = flattenTagTree(tags.result?.structuredContent?.tags || []);
  assert(
    tags.result?.structuredContent?.success === true &&
      flatTags.some((tag) => tag.name === `agent-smoke-${stamp}`),
    "MCP listTagTree",
    tags,
  );

  const searchA = await mcp.rpc("tools/call", {
    name: "searchBlinkora",
    arguments: { searchText: `Agent smoke A seed ${stamp}`, page: 1, size: 20 },
  });
  assert(
    searchA.result?.structuredContent?.notes?.some(
      (item) => item.id === seedA.id,
    ),
    "MCP search bound workspace",
    searchA,
  );
  const searchB = await mcp.rpc("tools/call", {
    name: "searchBlinkora",
    arguments: {
      searchText: `Agent smoke B private ${stamp}`,
      page: 1,
      size: 20,
    },
  });
  assert(
    !searchB.result?.structuredContent?.notes?.some(
      (item) => item.id === seedB.id,
    ),
    "MCP does not search other workspace",
    searchB,
  );
  mcp.close();
  pass("MCP tools and workspace isolation");

  const revokedFirst = await trpc("agentTokens.revoke", {
    id: createdToken.id,
  });
  assert(revokedFirst?.revokedAt, "revoke first token", revokedFirst);
  const revokedUse = await trpcRaw(
    "notes.list",
    { page: 1, size: 10 },
    agentToken,
    "GET",
  );
  assert(
    revokedUse.response.status === 401,
    "revoked first token rejects tRPC",
    {
      status: revokedUse.response.status,
      body: revokedUse.json || revokedUse.text,
    },
  );

  const refreshedToken = await trpc("agentTokens.create", {
    workspaceId: workspaceA.id,
    name: `Agent smoke refreshed token ${stamp}`,
  });
  assert(
    refreshedToken?.id && refreshedToken?.token?.startsWith("bkws_"),
    "refreshed token create",
    refreshedToken,
  );
  createdAgentTokenIds.push(refreshedToken.id);
  const refreshedGuide = await request("/api/agent/mcp-guide.md", {
    headers: { Authorization: `Bearer ${refreshedToken.token}` },
  });
  assert(refreshedGuide.response.ok, "refreshed token can read agent guide", {
    status: refreshedGuide.response.status,
  });

  const refreshedMcp = await openMcpSession(refreshedToken.token);
  const refreshedTools = await refreshedMcp.rpc("tools/list", {});
  assert(
    refreshedTools.result?.tools?.some(
      (tool) => tool.name === "searchBlinkora",
    ),
    "refreshed token MCP works",
    refreshedTools,
  );
  refreshedMcp.close();
  pass("refresh/revoke behavior");
}

try {
  await main();
  await cleanup();
  pass("cleanup");
  console.log("Workspace Agent smoke passed");
} catch (error) {
  await cleanup();
  console.error(`\nFAIL: ${error.message}`);
  if (error.details !== undefined) {
    console.error(
      typeof error.details === "string"
        ? error.details
        : JSON.stringify(redact(error.details), null, 2),
    );
  }
  process.exit(1);
}
