#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { chromium } from 'playwright';

const base = new URL(process.env.BLINKORA_BASE_URL || 'http://127.0.0.1:6676');
const browserExecutable = process.env.BLINKORA_BROWSER_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const user = process.env.BLINKORA_BROWSER_SMOKE_USER || `browser_smoke_${stamp}`;
const password = process.env.BLINKORA_BROWSER_SMOKE_PASSWORD || 'BrowserSmoke!local';
const accountToken = process.env.BLINKORA_BROWSER_SMOKE_ACCOUNT_TOKEN?.trim() || '';
const scenario = process.env.BLINKORA_BROWSER_SMOKE_SCENARIO?.trim() || 'full';
const m1ArtifactsDir = process.env.BLINKORA_M1_REVIEW_ARTIFACTS_DIR?.trim() || '';
const FONT_FIXTURE_PATH = '/System/Library/Fonts/Symbol.ttf';
const NOTE_TYPE_LABELS = ['闪念', '笔记', '待办'];

function fail(message, details) {
  console.error(`\nFAIL: ${message}`);
  if (details !== undefined) {
    console.error(typeof details === 'string' ? details : JSON.stringify(details, null, 2));
  }
  process.exit(1);
}

function assert(condition, message, details) {
  if (!condition) fail(message, details);
}

function assertJsonEqual(actual, expected, message) {
  assert(
    isDeepStrictEqual(actual, expected),
    message,
    { actual, expected },
  );
}

async function captureM1Artifact(page, name, target = page) {
  if (!m1ArtifactsDir) return;
  mkdirSync(m1ArtifactsDir, { recursive: true, mode: 0o700 });
  await target.screenshot({
    path: join(m1ArtifactsDir, name),
    animations: 'disabled',
  });
}

function requireIsolatedTarget() {
  assert(process.env.BLINKORA_BROWSER_SMOKE_ISOLATED === '1',
    'Browser smoke only runs against a disposable isolated service. Set BLINKORA_BROWSER_SMOKE_ISOLATED=1.');
  assert(['127.0.0.1', 'localhost', '::1'].includes(base.hostname),
    'Browser smoke only accepts a loopback BLINKORA_BASE_URL.', { base: base.toString() });
  assert(base.port && base.port !== '6676',
    'Browser smoke refuses the persistent local service port. Use an isolated port.', { base: base.toString() });
  assert(existsSync(browserExecutable),
    'A local Chrome executable is required. Set BLINKORA_BROWSER_EXECUTABLE when it is not installed at the macOS default path.',
    { browserExecutable });
}

function createDiagnostics(page, label) {
  const failures = [];
  page.__blinkoraDiagnostics = failures;

  page.on('console', message => {
    if (message.type() === 'error') {
      failures.push({ label, kind: 'console', message: message.text() });
    }
  });
  page.on('pageerror', error => {
    failures.push({ label, kind: 'pageerror', message: error.message });
  });
  page.on('response', response => {
    const responseUrl = new URL(response.url());
    if (responseUrl.origin === base.origin && response.status() >= 400) {
      responseUrl.searchParams.delete('token');
      failures.push({
        label,
        kind: 'http',
        status: response.status(),
        path: `${responseUrl.pathname}${responseUrl.search}`,
      });
    }
  });

  return failures;
}

async function waitForApp(page) {
  await page.locator('#global-editor').waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('#vditor-create .vditor-ir [contenteditable="true"]').waitFor({ state: 'visible', timeout: 15_000 });
}

function waitForNoteUpsert(page) {
  return page.waitForResponse(
    response => response.request().method() === 'POST' && trpcProcedureIndex(response, 'notes.upsert') >= 0,
    { timeout: 15_000 },
  );
}

function waitForTrpcMutation(page, procedure) {
  return page.waitForResponse(
    response => response.request().method() === 'POST' && trpcProcedureIndex(response, procedure) >= 0,
    { timeout: 15_000 },
  );
}

function waitForTrpcQuery(page, procedure) {
  return page.waitForResponse(
    response => trpcProcedureIndex(response, procedure) >= 0,
    { timeout: 15_000 },
  );
}

function trpcProcedureIndex(response, procedure) {
  const pathname = new URL(response.url()).pathname;
  const prefix = '/api/trpc/';
  if (!pathname.startsWith(prefix)) return -1;
  return pathname.slice(prefix.length).split(',').indexOf(procedure);
}

function trpcRequestJsonInput(response, procedure) {
  const body = JSON.parse(response.request().postData() || '{}');
  if (body?.json !== undefined) return body.json;

  const values = Array.isArray(body) ? body : Object.values(body || {});
  const procedureIndex = procedure ? trpcProcedureIndex(response, procedure) : -1;
  if (procedureIndex >= 0 && values[procedureIndex]?.json !== undefined) {
    return values[procedureIndex].json;
  }
  for (const value of values) {
    if (value && typeof value === 'object' && value.json !== undefined) {
      return value.json;
    }
  }
  return undefined;
}

async function trpcResponseJson(response, procedure) {
  const payload = await response.json();
  const procedureIndex = trpcProcedureIndex(response, procedure);
  const result = Array.isArray(payload) ? payload[procedureIndex] : payload;
  return result?.result?.data?.json;
}

async function runTrpcFixtureMutation(page, procedure, input) {
  const result = await page.evaluate(async ({ procedure, input }) => {
    const storedToken = window.localStorage.getItem('blinkoraToken');
    const token = storedToken ? JSON.parse(storedToken)?.token : null;
    const storedWorkspaceId = window.localStorage.getItem('blinkoraCurrentWorkspaceId');
    const workspaceId = storedWorkspaceId ? JSON.parse(storedWorkspaceId) : null;
    const response = await fetch(`/api/trpc/${procedure}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(workspaceId ? { 'x-workspace-id': String(workspaceId) } : {}),
      },
      body: JSON.stringify({ json: input }),
    });
    const payload = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, payload };
  }, { procedure, input });

  assert(result.ok, `Fixture mutation ${procedure} failed.`, { status: result.status });
  const payload = Array.isArray(result.payload) ? result.payload[0] : result.payload;
  const data = payload?.result?.data?.json;
  assert(data !== undefined, `Fixture mutation ${procedure} returned a tRPC error.`, payload);
  return data;
}

async function registerAndSignIn(page) {
  await page.goto(new URL('/signup', base).toString(), { waitUntil: 'networkidle' });
  await page.locator('input[name="username"]').fill(user);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('input[name="confirmPassword"]').fill(password);
  await Promise.all([
    page.waitForURL('**/signin', { timeout: 10_000 }),
    page.locator('form button[type="submit"]').click(),
  ]);

  await page.locator('input[type="text"]').fill(user);
  await page.locator('input[name="password"]').fill(password);
  await Promise.all([
    page.waitForURL(new URL('/', base).toString(), { timeout: 10_000 }),
    page.locator('form button').filter({ hasText: '登录' }).click(),
  ]);
  await waitForApp(page);
}

async function accountTrpc(procedure, input) {
  const response = await fetch(new URL(`/api/trpc/${procedure}`, base), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accountToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ json: input }),
  });
  const payload = await response.json().catch(() => null);
  assert(response.ok && !payload?.error, `Account API token could not call ${procedure}.`, {
    status: response.status,
  });
  return payload?.result?.data?.json;
}

async function signInWithAccountToken(page, workspaceId) {
  assert(accountToken, 'M2 clone browser smoke requires an account API token.');
  const response = await fetch(new URL('/api/auth/profile', base), {
    headers: { Authorization: `Bearer ${accountToken}` },
  });
  assert(response.ok, 'Account API token could not read the migrated profile.', {
    status: response.status,
  });
  const payload = await response.json();
  const profile = payload?.user;
  assert(Number.isInteger(profile?.id), 'Migrated profile omitted its account id.');

  await page.addInitScript(({ token, userProfile, initialWorkspaceId }) => {
    window.localStorage.setItem('blinkoraToken', JSON.stringify({
      token,
      expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      user: {
        id: String(userProfile.id),
        name: userProfile.name,
        nickname: userProfile.nickname ?? userProfile.nickName,
        image: userProfile.image,
        role: userProfile.role,
      },
    }));
    window.localStorage.setItem('blinkoraCurrentWorkspaceId', JSON.stringify(initialWorkspaceId));
  }, { token: accountToken, userProfile: profile, initialWorkspaceId: workspaceId });

  await page.goto(new URL('/', base).toString(), { waitUntil: 'networkidle' });
  await waitForApp(page);
}

async function verifyM2CloneReview(page, diagnostics) {
  const workspaces = await accountTrpc('workspaces.list', {});
  const defaultWorkspace = workspaces.find(item => item.isDefault === true);
  assert(Number.isInteger(defaultWorkspace?.id), 'M2 clone has no default Workspace.');

  const workspaceName = `M2 clone workspace ${stamp}`;
  const workspace = await accountTrpc('workspaces.create', {
    name: workspaceName,
    description: 'Disposable M2 clone browser smoke Workspace',
    icon: 'tabler:database-check',
    color: '#2563eb',
  });
  assert(Number.isInteger(workspace?.id), 'M2 clone Workspace creation failed.');

  try {
    await signInWithAccountToken(page, workspace.id);

    const tagParent = `m2_clone_${stamp.replace(/[^a-zA-Z0-9]/g, '')}`;
    const tagChild = `${tagParent}_child`;
    const blinkora = `M2 clone Blinkora ${stamp}`;
    const note = `M2 clone Note ${stamp} #${tagParent}/${tagChild}`;
    const todo = `M2 clone Todo ${stamp}`;
    const updatedNote = `${note} (edited)`;
    const attachmentName = `m2-clone-${stamp}.txt`;
    const comment = `M2 clone comment ${stamp}`;

    await createNote(page, '闪念', blinkora, '');
    const createdNote = await createNote(page, '笔记', note, 'path=notes');
    await createNote(page, '待办', todo, 'path=todo');
    await editNote(page, note, updatedNote, async () => {
      await attachFileToEditedNote(page, attachmentName);
    });
    await verifyTodoCompletion(page, todo);
    await verifyGlobalSearch(page, blinkora);
    await verifyTagTreeFilter(page, tagParent, tagChild, updatedNote);
    await verifyAttachmentFilter(page, updatedNote);
    await verifyTaggedAttachmentFilter(page, tagChild, updatedNote);
    await verifyCommentTree(page, updatedNote, comment);
    await verifyOperationLogSettings(page, updatedNote);
    await verifyWorkspaceTokenGuide(page);
    const archive = await verifyBackupExport(page);
    const archivePath = await archive.path();
    assert(archivePath && statSync(archivePath).size > 0,
      'M2 clone Workspace export did not produce a non-empty archive.');
    assert(createdNote.id > 0, 'M2 clone Note omitted its stable id.');
    assert(diagnostics.length === 0,
      'M2 clone browser review observed console or local HTTP errors.', diagnostics);
  } finally {
    const deleted = await accountTrpc('workspaces.delete', { id: workspace.id });
    assert(deleted?.success === true && deleted.deletedAttachmentFiles === 1,
      'M2 clone Workspace cleanup returned an unexpected cascade summary.', deleted);
  }
}

async function createAndSelectWorkspace(page, name) {
  await page.goto(new URL('/', base).toString(), { waitUntil: 'networkidle' });
  await waitForApp(page);
  const currentWorkspace = page.locator('button').filter({ hasText: '默认工作区' }).first();
  await currentWorkspace.waitFor({ state: 'visible', timeout: 10_000 });
  await currentWorkspace.click();
  const manageWorkspace = page.locator('[role="menuitemradio"]').filter({ hasText: '管理工作区' });
  await manageWorkspace.waitFor({ state: 'visible', timeout: 10_000 });
  await manageWorkspace.focus();
  await page.keyboard.press('Enter');

  const manageDialog = page.getByRole('dialog', { name: '管理工作区' });
  await manageDialog.waitFor({ state: 'visible', timeout: 10_000 });
  await manageDialog.getByRole('button', { name: '创建工作区', exact: true }).click();

  const createDialog = page.getByRole('dialog', { name: '创建工作区' });
  await createDialog.waitFor({ state: 'visible', timeout: 10_000 });
  const inputs = createDialog.locator('input');
  await inputs.nth(0).fill(name);
  await inputs.nth(1).fill('temporary isolated browser smoke workspace');

  const created = waitForTrpcMutation(page, 'workspaces.create');
  await createDialog.getByRole('button', { name: '创建', exact: true }).click();
  const response = await created;
  assert(response.ok(), 'Create workspace request failed.', { status: response.status() });
  const createdWorkspace = await trpcResponseJson(response, 'workspaces.create');
  assert(Number.isInteger(createdWorkspace?.id), 'Create workspace response omitted its stable id.', {
    workspace: name,
    returnedId: createdWorkspace?.id,
  });
  await createDialog.waitFor({ state: 'hidden', timeout: 10_000 });

  const workspaceRadio = manageDialog.locator(`input[type="radio"][aria-label="切换工作区: ${name}"]`);
  await workspaceRadio.waitFor({ state: 'attached', timeout: 10_000 });
  await page.waitForFunction((label) => {
    const input = document.querySelector(`input[type="radio"][aria-label="${label}"]`);
    return input instanceof HTMLInputElement && input.checked;
  }, `切换工作区: ${name}`, { timeout: 10_000 });

  await manageDialog.getByRole('button', { name: '取消', exact: true }).click();
  await manageDialog.waitFor({ state: 'hidden', timeout: 10_000 });
  await page.locator('button').filter({ hasText: name }).first().waitFor({ state: 'visible', timeout: 10_000 });
  await page.reload({ waitUntil: 'networkidle' });
  await waitForApp(page);
  await page.locator('button').filter({ hasText: name }).first().waitFor({ state: 'visible', timeout: 10_000 });
  return createdWorkspace;
}

async function createNote(page, targetType, content, expectedPath, visibleContent = content) {
  await page.waitForFunction((labels) => labels.some(label => {
    const button = document.querySelector(`#global-editor button[aria-label="${label}"]`);
    return button instanceof HTMLElement && button.offsetParent !== null;
  }), NOTE_TYPE_LABELS, { timeout: 10_000 });

  const typeButtons = NOTE_TYPE_LABELS
    .map(label => `#global-editor button[aria-label="${label}"]`)
    .join(', ');
  const currentType = await page.locator(typeButtons).evaluateAll(buttons => {
    const visibleButton = buttons.find(button => button instanceof HTMLElement && button.offsetParent !== null);
    return visibleButton?.getAttribute('aria-label') ?? null;
  });
  assert(NOTE_TYPE_LABELS.includes(currentType), 'Global editor did not expose a selected note type.', {
    currentType,
    url: page.url(),
  });

  if (currentType !== targetType) {
    const typeButton = page.locator(`#global-editor button[aria-label="${currentType}"]`);
    await typeButton.click();
    await page.locator('[data-note-type-picker-content] button').filter({ hasText: targetType }).click();
    await page.locator(`#global-editor button[aria-label="${targetType}"]`).waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(600);
  }

  const editorShell = page.locator('#global-editor');
  await editorShell.scrollIntoViewIfNeeded();
  await editorShell.click({ position: { x: 8, y: 8 } });
  const editor = page.locator('#vditor-create .vditor-ir [contenteditable="true"]:visible');
  await editor.waitFor({ state: 'visible', timeout: 10_000 });
  await editor.click();
  await page.keyboard.insertText(content);
  const saved = waitForNoteUpsert(page);
  await page.locator('#global-editor div[class*="w-[60px]"]').click();
  const response = await saved;
  assert(response.ok(), 'Create note request failed.', { status: response.status() });
  const createdNote = await trpcResponseJson(response, 'notes.upsert');
  assert(Number.isInteger(createdNote?.id), 'Create note response omitted its stable id.', {
    targetType,
    returnedId: createdNote?.id,
  });

  if (expectedPath) {
    await page.waitForFunction(path => window.location.search.includes(path), expectedPath, { timeout: 10_000 });
  }
  const noteText = page.getByText(visibleContent, { exact: true }).first();
  try {
    await noteText.waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    fail('Created note did not render in the active list.', {
      url: page.url(),
      cards: await page.locator('.blinkora-flip-card').allTextContents(),
      body: (await page.locator('body').innerText()).slice(0, 1_000),
      rootHtmlSize: await page.locator('#root').evaluate(element => element.innerHTML.length),
      diagnostics: page.__blinkoraDiagnostics,
    });
  }
  return createdNote;
}

async function verifyDailyReview(page, content) {
  await page.goto(new URL('/review', base).toString(), { waitUntil: 'networkidle' });
  await page.getByText(content, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });

  const reviewed = waitForTrpcMutation(page, 'notes.reviewNote');
  await page.getByRole('button', { name: '已回顾', exact: true }).click();
  const response = await reviewed;
  assert(response.ok(), 'Daily review request failed.', { status: response.status() });
  await page.getByText(content, { exact: true }).waitFor({ state: 'hidden', timeout: 10_000 });
}

async function editNote(page, originalContent, updatedContent, beforeSave, path = 'notes') {
  const url = new URL('/', base);
  if (path) url.searchParams.set('path', path);
  await page.goto(url.toString(), { waitUntil: 'commit' });
  await page.waitForFunction((expectedPath) => {
    const currentPath = new URLSearchParams(window.location.search).get('path') ?? '';
    return currentPath === expectedPath;
  }, path, { timeout: 10_000 });
  const card = page.locator('.blinkora-flip-card').filter({ hasText: originalContent });
  await card.waitFor({ state: 'visible', timeout: 10_000 });

  if (path === 'notes') {
    await card.click({ position: { x: 200, y: 80 } });
    await page.waitForTimeout(250);
    const fullscreen = page.locator('div.fixed.inset-0').filter({ hasText: originalContent }).last();
    if (await fullscreen.isVisible()) {
      await fullscreen.getByRole('button', { name: '编辑', exact: true }).click();
    } else {
      await card.dblclick({ position: { x: 200, y: 80 } });
    }
  } else {
    await openCardMenu(page, originalContent);
    const edit = page.locator('[data-key="EditItem"]').last();
    await edit.waitFor({ state: 'visible', timeout: 10_000 });
    await edit.click();
  }

  const editEditor = await visibleElement(
    page,
    page.locator('#vditor-edit [contenteditable="true"]'),
    'Edit Note content area',
  );
  await editEditor.click();
  await page.keyboard.press('End');
  const appendedContent = updatedContent.slice(originalContent.length);
  if (appendedContent) {
    await page.keyboard.insertText(appendedContent);
  }
  await beforeSave?.();
  const response = await saveEditedNote(page);
  await noteCard(page, updatedContent).waitFor({ state: 'visible', timeout: 10_000 });
  return response;
}

async function attachFileToEditedNote(page, fileName, {
  mimeType = 'text/plain',
  buffer = Buffer.from(`temporary browser smoke attachment ${stamp}`),
  previewSelector = '',
} = {}) {
  const editorRoot = page.locator('#vditor-edit').locator('xpath=ancestor::*[.//input[@type="file"]][1]');
  const fileInput = editorRoot.locator('input[type="file"]');
  const previews = previewSelector ? editorRoot.locator(`.attachment-container ${previewSelector}`) : null;
  const previewCountBeforeUpload = previews ? await previews.count() : 0;
  await fileInput.waitFor({ state: 'attached', timeout: 10_000 });
  const uploaded = page.waitForResponse(
    response => response.request().method() === 'POST' && response.url().includes('/api/file/upload'),
    { timeout: 15_000 },
  );
  await fileInput.setInputFiles({
    name: fileName,
    mimeType,
    buffer,
  });
  const response = await uploaded;
  assert(response.ok(), 'Upload attachment request failed.', { status: response.status() });
  const uploadedFile = await response.json();
  if (previews) {
    await previews.nth(previewCountBeforeUpload).waitFor({ state: 'visible', timeout: 10_000 });
  } else {
    await page.getByText(fileName, { exact: true }).last().waitFor({ state: 'visible', timeout: 10_000 });
  }
  return uploadedFile;
}

async function addReferenceToEditedNote(page, targetContent) {
  const editorRoot = page.locator('#vditor-edit').locator('xpath=ancestor::*[.//*[@role="button" and @aria-label="引用"]][1]');
  const reference = editorRoot.getByRole('button', { name: '引用', exact: true });
  await reference.waitFor({ state: 'visible', timeout: 10_000 });
  await reference.click();

  const target = await visibleElement(
    page,
    page.locator('[data-reference-option="true"]').filter({ hasText: targetContent }),
    'Reference target',
  );
  await target.click();
  await page.locator('.reference-container').getByText(targetContent, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
}

async function saveEditedNote(page) {
  const sendButtons = page.locator('div[class*="w-[60px]"]');
  assert(await sendButtons.count() >= 2, 'Edit mode did not expose its save action.');
  const saved = waitForNoteUpsert(page);
  await sendButtons.last().click();
  const response = await saved;
  assert(response.ok(), 'Save edited note request failed.', { status: response.status() });
  return response;
}

async function removeAttachmentFromCurrentEditor(page) {
  const editor = page.locator('#vditor-edit');
  const attachment = editor.locator(
    'xpath=following-sibling::div[contains(concat(" ", normalize-space(@class), " "), " attachment-container ")]',
  );
  const standaloneDeleteRequests = [];
  const recordStandaloneDelete = request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/file/delete') {
      standaloneDeleteRequests.push(request.url());
    }
  };
  page.on('request', recordStandaloneDelete);
  try {
    const deleteButton = attachment.getByRole('button', { name: '删除', exact: true });
    await deleteButton.waitFor({ state: 'visible', timeout: 10_000 });
    await deleteButton.click();
    const confirmation = page.getByText('该操作将删除资源，你确定吗？', { exact: true });
    await confirmation.waitFor({ state: 'visible', timeout: 10_000 });
    const confirmationPanel = confirmation.locator(
      'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " px-1 ")][1]',
    );
    const confirmButton = confirmationPanel.getByRole('button', { name: '确认', exact: true });
    await confirmButton.click();
    try {
      await attachment.waitFor({ state: 'hidden', timeout: 2_000 });
    } catch {
      const editorState = await editor.evaluate(element => {
        let current = element;
        while (current && !current.__storeInstance) current = current.parentElement;
        const store = current?.__storeInstance;
        return store ? {
          mode: store.mode,
          editingNoteId: store.editingNoteId,
          deletedAttachmentPaths: [...store.deletedAttachmentPaths],
          files: store.files.map(file => ({
            name: file.name,
            attachedToNote: file.attachedToNote,
            path: file.uploadPromise?.value || file.preview,
          })),
        } : { storeFound: false };
      });
      fail('Confirmed editor attachment deletion did not remove the attachment from the editor.', {
        editorState,
        confirmationVisible: await confirmation.isVisible().catch(() => false),
        standaloneDeleteRequests,
        attachmentText: (await attachment.innerText()).slice(0, 500),
      });
    }
    await page.waitForTimeout(200);
  } finally {
    page.off('request', recordStandaloneDelete);
  }
  assert(standaloneDeleteRequests.length === 0,
    'Editor attachment removal called the standalone delete endpoint before Note save.',
    standaloneDeleteRequests);
}

async function verifyNoteProperties(page, content, noteId, {
  expectedAttachmentNames,
  expectedReferenceId,
}) {
  const properties = {
    browser_boolean: true,
    browser_link: 'GitHub：[browser-use/browser-harness](https://github.com/browser-use/browser-harness)',
    browser_list: ['alpha', '中文', '🙂'],
    browser_null: null,
    browser_number: 42.5,
    browser_string: `property value ${stamp}`,
  };
  const serializedValues = {
    browser_boolean: 'true',
    browser_link: properties.browser_link,
    browser_list: JSON.stringify(properties.browser_list),
    browser_null: 'null',
    browser_number: String(properties.browser_number),
    browser_string: properties.browser_string,
  };

  await page.goto(listUrl('notes').toString(), { waitUntil: 'networkidle' });
  const card = noteCard(page, content);
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await card.click({ position: { x: 200, y: 80 } });

  const editProperties = page.getByRole('button', { name: '编辑属性', exact: true });
  await editProperties.waitFor({ state: 'visible', timeout: 10_000 });
  await editProperties.click();

  for (const [index, [key, value]] of Object.entries(serializedValues).entries()) {
    const keyInputs = page.getByRole('textbox', { name: '属性', exact: true });
    const valueInputs = page.getByRole('textbox', { name: '内容', exact: true });
    await keyInputs.nth(index).fill(key);
    await valueInputs.nth(index).fill(value);
  }

  const saved = waitForTrpcMutation(page, 'notes.upsert');
  await page.getByRole('button', { name: '保存属性', exact: true }).click();
  const response = await saved;
  assert(response.ok(), 'Save Note properties request failed.', { status: response.status() });
  const requestInput = trpcRequestJsonInput(response, 'notes.upsert');
  assert(requestInput?.id === noteId, 'Save Note properties targeted an unexpected Note.', requestInput);
  assertJsonEqual(Object.keys(requestInput).sort(), ['id', 'metadata'],
    'Metadata-only Note update submitted unrelated replacement fields.');
  assertJsonEqual(requestInput?.metadata?.properties, properties,
    'Save Note properties changed a property value or JSON type.');

  const returnedNote = await trpcResponseJson(response, 'notes.upsert');
  assert(returnedNote?.id === noteId, 'Save Note properties returned an unexpected Note.', returnedNote);
  assertJsonEqual(returnedNote?.metadata?.properties, properties,
    'Save Note properties response changed a property value or JSON type.');
  assertJsonEqual(
    returnedNote?.attachments?.map(attachment => attachment.name).sort(),
    [...expectedAttachmentNames].sort(),
    'Metadata-only Note update changed its attachments.',
  );
  assert(
    returnedNote?.references?.some(reference => reference.toNoteId === expectedReferenceId),
    'Metadata-only Note update removed its outgoing reference.',
    returnedNote?.references,
  );

  for (const key of Object.keys(properties)) {
    await page.getByText(key, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  }

  const propertyLink = page.getByRole('link', { name: 'browser-use/browser-harness', exact: true });
  await propertyLink.waitFor({ state: 'visible', timeout: 10_000 });
  assert(
    await propertyLink.getAttribute('href') === 'https://github.com/browser-use/browser-harness',
    'Markdown Note property link changed its destination.',
  );
  assert(await propertyLink.getAttribute('target') === '_blank',
    'Markdown Note property link did not retain its new-tab behavior.');
  const openedLink = page.context().waitForEvent('page', { timeout: 10_000 });
  await propertyLink.click();
  const linkedPage = await openedLink;
  await linkedPage.waitForURL(
    url => url.href.startsWith('https://github.com/browser-use/browser-harness'),
    { timeout: 10_000 },
  );
  await linkedPage.close();

  await page.keyboard.press('Escape');
  await editProperties.waitFor({ state: 'hidden', timeout: 10_000 });

  await page.reload({ waitUntil: 'networkidle' });
  const reloadedCard = noteCard(page, content);
  await reloadedCard.waitFor({ state: 'visible', timeout: 10_000 });
  const cardMarker = `properties-${stamp}`;
  await reloadedCard.evaluate((element, marker) => {
    element.setAttribute('data-browser-smoke-card', marker);
  }, cardMarker);
  const stableCard = page.locator(`[data-browser-smoke-card="${cardMarker}"]`);
  assert(await stableCard.getByText('browser_boolean', { exact: true }).count() === 0,
    'Note properties unexpectedly appeared on the card front.');
  await flipCard(page, stableCard);
  await stableCard.locator('[title="翻回正面"]').waitFor({ state: 'visible', timeout: 10_000 });
  await stableCard.getByText('browser_boolean', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await stableCard.getByText('笔记', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await page.reload({ waitUntil: 'networkidle' });
  const frontCard = noteCard(page, content);
  await frontCard.waitFor({ state: 'visible', timeout: 10_000 });
  await frontCard.getByText(content, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  assert(await frontCard.getByText('browser_boolean', { exact: true }).count() === 0,
    'Reloaded Note card did not return to its property-free front face.');
  return { note: returnedNote, properties };
}

async function verifyNoteTypeConversions(page, visibleContent, expectedNote, expectedProperties) {
  const conversions = [
    { targetType: 0, path: '', label: 'Blinkora' },
    { targetType: 2, path: 'todo', label: 'Todo' },
    { targetType: 1, path: 'notes', label: 'Note' },
  ];

  for (const conversion of conversions) {
    await openCardMenu(page, visibleContent);
    const action = page.locator(`[data-key="ConvertItem-${conversion.targetType}"]`).last();
    await action.waitFor({ state: 'visible', timeout: 10_000 });
    const converted = waitForTrpcMutation(page, 'notes.upsert');
    await action.click();
    const response = await converted;
    assert(response.ok(), `Convert Note to ${conversion.label} request failed.`, {
      status: response.status(),
    });

    const requestInput = trpcRequestJsonInput(response, 'notes.upsert');
    assert(
      requestInput?.id === expectedNote.id && requestInput?.type === conversion.targetType,
      `Convert Note to ${conversion.label} submitted an unexpected payload.`,
      requestInput,
    );
    assert(
      !['attachments', 'content', 'metadata', 'references'].some(key => Object.hasOwn(requestInput, key)),
      `Convert Note to ${conversion.label} unexpectedly submitted unrelated replacement fields.`,
      requestInput,
    );
    const returnedNote = await trpcResponseJson(response, 'notes.upsert');
    assert(
      returnedNote?.id === expectedNote.id
        && returnedNote?.type === conversion.targetType
        && returnedNote?.content === expectedNote.content,
      `Convert Note to ${conversion.label} changed its identity or content.`,
      returnedNote,
    );
    assertJsonEqual(returnedNote?.metadata?.properties, expectedProperties,
      `Convert Note to ${conversion.label} changed its custom properties.`);
    assertJsonEqual(
      returnedNote?.attachments?.map(attachment => attachment.id).sort((left, right) => left - right),
      expectedNote.attachments.map(attachment => attachment.id).sort((left, right) => left - right),
      `Convert Note to ${conversion.label} changed its attachments.`,
    );
    assertJsonEqual(
      returnedNote?.references?.map(reference => reference.toNoteId).sort((left, right) => left - right),
      expectedNote.references.map(reference => reference.toNoteId).sort((left, right) => left - right),
      `Convert Note to ${conversion.label} changed its references.`,
    );

    await page.goto(listUrl(conversion.path).toString(), { waitUntil: 'networkidle' });
    await noteCard(page, visibleContent).waitFor({ state: 'visible', timeout: 10_000 });
  }
}

function serializePropertyValue(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value === null) return 'null';
  return String(value);
}

async function verifyPropertyValidationAndClear(page, content, expectedNote, expectedProperties) {
  const preservedMetadataValue = `preserved metadata ${stamp}`;
  const preparedNote = await runTrpcFixtureMutation(page, 'notes.upsert', {
    id: expectedNote.id,
    metadata: {
      ...(expectedNote.metadata ?? {}),
      browser_preserved: preservedMetadataValue,
    },
  });
  assert(preparedNote?.metadata?.browser_preserved === preservedMetadataValue,
    'Property validation fixture did not preserve its unrelated metadata field.', preparedNote);

  await page.goto(listUrl('notes').toString(), { waitUntil: 'networkidle' });
  const card = noteCard(page, content);
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await card.click({ position: { x: 200, y: 80 } });
  const editProperties = page.getByRole('button', { name: '编辑属性', exact: true });
  const saveProperties = page.getByRole('button', { name: '保存属性', exact: true });
  await editProperties.waitFor({ state: 'visible', timeout: 10_000 });
  await editProperties.click();

  const propertyKeys = Object.keys(expectedProperties).sort((left, right) => left.localeCompare(right));
  let keyInputs = page.getByRole('textbox', { name: '属性', exact: true });
  let valueInputs = page.getByRole('textbox', { name: '内容', exact: true });
  assert(await keyInputs.count() === propertyKeys.length,
    'Property editor did not render every saved property row.');

  await keyInputs.nth(1).fill(propertyKeys[0]);
  await saveProperties.click();
  await page.getByText(`属性「${propertyKeys[0]}」重复了。`, { exact: true })
    .waitFor({ state: 'visible', timeout: 10_000 });
  await keyInputs.nth(1).fill(propertyKeys[1]);

  await keyInputs.nth(0).fill('');
  await saveProperties.click();
  await page.getByText('请先填写属性名。', { exact: true })
    .waitFor({ state: 'visible', timeout: 10_000 });
  await keyInputs.nth(0).fill(propertyKeys[0]);

  await valueInputs.nth(0).fill('{ nested: true }');
  await saveProperties.click();
  await page.getByText(`属性「${propertyKeys[0]}」的内容格式不对`, { exact: false })
    .waitFor({ state: 'visible', timeout: 10_000 });
  await valueInputs.nth(0).fill(serializePropertyValue(expectedProperties[propertyKeys[0]]));

  keyInputs = page.getByRole('textbox', { name: '属性', exact: true });
  valueInputs = page.getByRole('textbox', { name: '内容', exact: true });
  for (let index = 0; index < propertyKeys.length; index += 1) {
    await keyInputs.nth(index).fill('');
    await valueInputs.nth(index).fill('');
  }
  const cleared = waitForTrpcMutation(page, 'notes.upsert');
  await saveProperties.click();
  const clearResponse = await cleared;
  assert(clearResponse.ok(), 'Clearing Note properties failed.', { status: clearResponse.status() });
  const clearInput = trpcRequestJsonInput(clearResponse, 'notes.upsert');
  assertJsonEqual(Object.keys(clearInput).sort(), ['id', 'metadata'],
    'Clear Note properties submitted unrelated replacement fields.');
  assert(clearInput?.metadata?.browser_preserved === preservedMetadataValue,
    'Clearing Note properties removed an unrelated metadata field.', clearInput?.metadata);
  assert(!Object.hasOwn(clearInput?.metadata ?? {}, 'properties'),
    'Clearing Note properties retained an empty properties object.', clearInput?.metadata);
  const clearedNote = await trpcResponseJson(clearResponse, 'notes.upsert');
  assert(
    clearedNote?.content === expectedNote.content
      && clearedNote?.attachments?.length === expectedNote.attachments.length
      && clearedNote?.references?.length === expectedNote.references.length,
    'Clearing Note properties changed content, attachments, or references.', clearedNote,
  );

  await editProperties.waitFor({ state: 'visible', timeout: 10_000 });
  await editProperties.click();
  for (const [index, key] of propertyKeys.entries()) {
    keyInputs = page.getByRole('textbox', { name: '属性', exact: true });
    valueInputs = page.getByRole('textbox', { name: '内容', exact: true });
    await keyInputs.nth(index).fill(key);
    await valueInputs.nth(index).fill(serializePropertyValue(expectedProperties[key]));
  }
  const restored = waitForTrpcMutation(page, 'notes.upsert');
  await saveProperties.click();
  const restoreResponse = await restored;
  assert(restoreResponse.ok(), 'Restoring Note properties failed.', { status: restoreResponse.status() });
  const restoredNote = await trpcResponseJson(restoreResponse, 'notes.upsert');
  assertJsonEqual(restoredNote?.metadata?.properties, expectedProperties,
    'Restoring Note properties changed a JSON type or value.');
  assert(restoredNote?.metadata?.browser_preserved === preservedMetadataValue,
    'Restoring Note properties removed an unrelated metadata field.', restoredNote?.metadata);
  await page.keyboard.press('Escape');
  return restoredNote;
}

async function verifyGlobalSearch(page, content) {
  await page.getByRole('button', { name: /搜索/ }).click();
  const search = page.locator('[aria-label="global-search"]');
  await search.waitFor({ state: 'visible', timeout: 10_000 });
  await search.fill(content);
  await page.getByRole('dialog').getByText(content, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await page.keyboard.press('Escape');
}

async function verifyGlobalResourceSearch(page, resourceName) {
  await page.getByRole('button', { name: /搜索/ }).click();
  const search = page.locator('[aria-label="global-search"]');
  await search.waitFor({ state: 'visible', timeout: 10_000 });
  await search.fill(resourceName);
  const dialog = page.getByRole('dialog');
  const resourceSection = dialog.getByRole('heading', { name: '资源', exact: true }).locator('xpath=../../..');
  await resourceSection.waitFor({ state: 'visible', timeout: 10_000 });
  const displayName = resourceName.replace(/\.[^.]+$/, '');
  await resourceSection.getByText(displayName, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await page.keyboard.press('Escape');
}

async function openNoteFilters(page) {
  const trigger = page.locator('[data-filter-trigger="true"]');
  const apply = page.getByRole('button', { name: '应用筛选', exact: true });
  await trigger.waitFor({ state: 'visible', timeout: 10_000 });
  await trigger.click();
  try {
    await apply.waitFor({ state: 'visible', timeout: 5_000 });
  } catch {
    await trigger.click();
    await apply.waitFor({ state: 'visible', timeout: 10_000 });
  }
  return apply;
}

async function selectSelectOption(page, triggerSelector, optionName) {
  const trigger = page.locator(triggerSelector);
  await trigger.waitFor({ state: 'visible', timeout: 10_000 });
  await trigger.click();

  const option = page.getByRole('option', { name: optionName, exact: true });
  await option.waitFor({ state: 'visible', timeout: 10_000 });
  await option.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(({ selector, optionName }) => (
    document.querySelector(selector)?.textContent?.includes(optionName)
  ), { selector: triggerSelector, optionName }, { timeout: 10_000 });
}

async function selectFontOption(page, fontName) {
  const option = page.locator(`[data-font-switcher-option="${fontName}"]`);
  await option.waitFor({ state: 'visible', timeout: 10_000 });
  await option.focus();
  await page.keyboard.press('Enter');
}

async function verifyAttachmentFilter(page, content) {
  await page.goto(new URL('/?path=all', base).toString(), { waitUntil: 'networkidle' });
  const apply = await openNoteFilters(page);
  await page.getByRole('radio', { name: '包含文件', exact: true }).click();
  await apply.click();
  await page.waitForFunction(() => new URLSearchParams(window.location.search).get('withFile') === 'true', undefined, { timeout: 10_000 });
  await noteCard(page, content).waitFor({ state: 'visible', timeout: 10_000 });
  assert(await page.locator('.blinkora-flip-card').count() === 1,
    'Attachment filter did not reduce the list to the attached Note.');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => new URLSearchParams(window.location.search).get('withFile') === 'true', undefined, { timeout: 10_000 });
  await noteCard(page, content).waitFor({ state: 'visible', timeout: 10_000 });
  assert(await page.locator('.blinkora-flip-card').count() === 1,
    'Attachment filter changed after a reload.');

  const reset = page.getByRole('button', { name: '重置', exact: true });
  await reset.waitFor({ state: 'hidden', timeout: 10_000 });
  await openNoteFilters(page);
  await reset.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(200);
  await reset.click();
  await page.waitForFunction(() => !new URLSearchParams(window.location.search).has('withFile'), undefined, { timeout: 10_000 });
}

async function verifyLinkFilter(page, content) {
  await page.goto(new URL('/?path=all', base).toString(), { waitUntil: 'networkidle' });
  const apply = await openNoteFilters(page);
  await page.getByRole('radio', { name: '包含链接', exact: true }).click();
  await apply.click();
  await page.waitForFunction(() => new URLSearchParams(window.location.search).get('withLink') === 'true', undefined, { timeout: 10_000 });
  await noteCard(page, content).waitFor({ state: 'visible', timeout: 10_000 });
  assert(await page.locator('.blinkora-flip-card').count() === 1,
    'Link filter did not reduce the list to the linked Note.');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => new URLSearchParams(window.location.search).get('withLink') === 'true', undefined, { timeout: 10_000 });
  await noteCard(page, content).waitFor({ state: 'visible', timeout: 10_000 });
  assert(await page.locator('.blinkora-flip-card').count() === 1,
    'Link filter changed after a reload.');
}

async function verifyTodoContentFilter(page, content) {
  await page.goto(new URL('/?path=all', base).toString(), { waitUntil: 'networkidle' });
  const apply = await openNoteFilters(page);
  await page.getByRole('radio', { name: '有待完成', exact: true }).click();
  await apply.click();
  await page.waitForFunction(() => new URLSearchParams(window.location.search).get('hasTodo') === 'true', undefined, { timeout: 10_000 });
  await noteCard(page, content).waitFor({ state: 'visible', timeout: 10_000 });
  assert(await page.locator('.blinkora-flip-card').count() === 1,
    'Todo-content filter did not reduce the list to the checked Todo.');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => new URLSearchParams(window.location.search).get('hasTodo') === 'true', undefined, { timeout: 10_000 });
  await noteCard(page, content).waitFor({ state: 'visible', timeout: 10_000 });
  assert(await page.locator('.blinkora-flip-card').count() === 1,
    'Todo-content filter changed after a reload.');

  await openNoteFilters(page);
  await page.getByRole('button', { name: '重置', exact: true }).click();
  await page.waitForFunction(() => !new URLSearchParams(window.location.search).has('hasTodo'), undefined, { timeout: 10_000 });
}

async function verifyWithoutTagFilter(page, content) {
  await page.goto(new URL('/?path=all', base).toString(), { waitUntil: 'networkidle' });
  const apply = await openNoteFilters(page);
  await page.locator('[data-filter-tag-status-trigger="true"]').click();
  await page.getByRole('option', { name: '不包含标签', exact: true }).click();
  await apply.click();
  await page.waitForFunction(() => new URLSearchParams(window.location.search).get('withoutTag') === 'true', undefined, { timeout: 10_000 });
  await noteCard(page, content).waitFor({ state: 'visible', timeout: 10_000 });
  assert(await page.locator('.blinkora-flip-card').count() === 1,
    'Without-tag filter did not reduce the list to the untagged fixture.');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => new URLSearchParams(window.location.search).get('withoutTag') === 'true', undefined, { timeout: 10_000 });
  await noteCard(page, content).waitFor({ state: 'visible', timeout: 10_000 });
  assert(await page.locator('.blinkora-flip-card').count() === 1,
    'Without-tag filter changed after a reload.');

  await openNoteFilters(page);
  await page.getByRole('button', { name: '重置', exact: true }).click();
  await page.waitForFunction(() => !new URLSearchParams(window.location.search).has('withoutTag'), undefined, { timeout: 10_000 });
}

async function verifyTaggedAttachmentFilter(page, tagName, content) {
  await page.goto(new URL('/?path=all', base).toString(), { waitUntil: 'networkidle' });
  const apply = await openNoteFilters(page);
  await page.locator('[data-filter-tag-status-trigger="true"]').click();
  await page.getByRole('option', { name: '包含标签', exact: true }).click();

  const tagSelector = page.getByPlaceholder('选择标签');
  await tagSelector.waitFor({ state: 'visible', timeout: 10_000 });
  await tagSelector.fill(tagName);
  const tagOption = page.getByRole('option', { name: tagName, exact: true });
  await tagOption.waitFor({ state: 'visible', timeout: 10_000 });
  await tagOption.click();
  await page.getByRole('radio', { name: '包含文件', exact: true }).click();

  const filtered = waitForTrpcQuery(page, 'notes.list');
  await apply.click();
  const response = await filtered;
  assert(response.ok(), 'Combined tag and attachment filter request failed.', { status: response.status() });
  const requestInput = trpcRequestJsonInput(response, 'notes.list');
  assert(Number.isInteger(requestInput?.tagId) && requestInput?.withFile === true,
    'Combined tag and attachment filter omitted one of its conditions.', requestInput);
  await page.waitForFunction(() => {
    const params = new URLSearchParams(window.location.search);
    return !!params.get('tagId') && params.get('withFile') === 'true';
  }, undefined, { timeout: 10_000 });
  await noteCard(page, content).waitFor({ state: 'visible', timeout: 10_000 });
  assert(await page.locator('.blinkora-flip-card').count() === 1,
    'Combined tag and attachment filter returned an unrelated card.');

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => {
    const params = new URLSearchParams(window.location.search);
    return !!params.get('tagId') && params.get('withFile') === 'true';
  }, undefined, { timeout: 10_000 });
  await noteCard(page, content).waitFor({ state: 'visible', timeout: 10_000 });
  assert(await page.locator('.blinkora-flip-card').count() === 1,
    'Combined tag and attachment filter changed after a reload.');

  await openNoteFilters(page);
  await page.getByRole('button', { name: '重置', exact: true }).click();
  await page.waitForFunction(() => {
    const params = new URLSearchParams(window.location.search);
    return !params.has('tagId') && !params.has('withFile');
  }, undefined, { timeout: 10_000 });
}

async function verifyDateRangeFilter(page, content, expectedNoteId) {
  await page.goto(new URL('/?path=all', base).toString(), { waitUntil: 'networkidle' });
  const apply = await openNoteFilters(page);
  await page.locator('[data-filter-date-trigger="true"]').click();
  const calendar = page.getByRole('grid').last();
  await calendar.waitFor({ state: 'visible', timeout: 10_000 });
  const focusedDate = calendar.locator('[tabindex="0"]').first();
  await focusedDate.focus();

  // CalendarDate values are serialized through the existing API contract as UTC
  // midnights. Select a range around the browser's local date so the fixture is
  // covered even when the smoke runs near midnight or in an extreme time zone.
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  for (let offset = 0; offset < 4; offset += 1) {
    await page.keyboard.press('ArrowRight');
  }
  await page.keyboard.press('Enter');

  const filteredLoad = waitForTrpcQuery(page, 'notes.list');
  await apply.click();
  const filteredResponse = await filteredLoad;
  assert(filteredResponse.ok(), 'Date-range filter request failed.', { status: filteredResponse.status() });
  const filteredInput = trpcRequestJsonInput(filteredResponse, 'notes.list');
  const startDate = filteredInput?.startDate;
  const endDate = filteredInput?.endDate;
  assert(
    typeof startDate === 'string'
      && typeof endDate === 'string'
      && Number.isFinite(Date.parse(startDate))
      && Number.isFinite(Date.parse(endDate))
      && Date.parse(startDate) < Date.parse(endDate),
    'Date-range filter sent an invalid range.',
    { startDate, endDate },
  );
  const filteredData = await trpcResponseJson(filteredResponse, 'notes.list');
  const filteredNotes = Array.isArray(filteredData) ? filteredData : filteredData?.items;
  assert(
    Array.isArray(filteredNotes)
      && filteredNotes.some(note => note?.id === expectedNoteId),
    'Date-range filter response omitted the in-range fixture.',
    { expectedNoteId, startDate, endDate, returnedNoteIds: filteredNotes?.map(note => note?.id) },
  );
  await noteCard(page, content).waitFor({ state: 'visible', timeout: 10_000 });

  await openNoteFilters(page);
  await page.getByRole('button', { name: '重置', exact: true }).click();
  await noteCard(page, content).waitFor({ state: 'visible', timeout: 10_000 });
}

async function createFontFixture(page) {
  assert(existsSync(FONT_FIXTURE_PATH), 'macOS system font fixture is missing.', { path: FONT_FIXTURE_PATH });
  const fileSize = statSync(FONT_FIXTURE_PATH).size;
  assert(fileSize > 0 && fileSize <= 10 * 1024 * 1024,
    'macOS system font fixture has an unsupported size.', { path: FONT_FIXTURE_PATH, fileSize });

  const name = `browser-smoke-font-${stamp}`;
  const displayName = `Browser Smoke Font ${stamp}`;
  const font = await runTrpcFixtureMutation(page, 'fonts.upload', {
    name,
    displayName,
    fileData: readFileSync(FONT_FIXTURE_PATH).toString('base64'),
    category: 'sans-serif',
  });
  assert(font?.id && font.name === name && font.isLocal === true,
    'Creating local font fixture returned an invalid font.', { id: font?.id, name: font?.name, isLocal: font?.isLocal });
  return { id: font.id, name, displayName };
}

async function openPreferenceSettings(page) {
  const url = new URL('/settings', base);
  url.searchParams.set('section', 'prefer');
  await page.goto(url.toString(), { waitUntil: 'networkidle' });
  const marker = page.getByText('卡片加载方式', { exact: true });
  try {
    await marker.waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    fail('Preference settings did not render from its section URL.', {
      url: page.url(),
      buttons: await page.getByRole('button').allTextContents(),
      body: (await page.locator('body').innerText()).slice(0, 1_500),
      diagnostics: page.__blinkoraDiagnostics,
    });
  }
}

async function verifyFontSelection(page, font) {
  await openPreferenceSettings(page);
  const fontButton = page.locator('[data-font-switcher-ready="true"]');
  await fontButton.waitFor({ state: 'visible', timeout: 10_000 });

  const updateFont = waitForTrpcMutation(page, 'config.update');
  await fontButton.click();
  await selectFontOption(page, font.name);
  const selected = await updateFont;
  assert(selected.ok(), 'Selecting local font did not update config.', { status: selected.status() });
  await page.waitForFunction(name => document.body.style.fontFamily.includes(name), font.name, { timeout: 10_000 });

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('卡片加载方式', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
  await fontButton.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForFunction(({ selector, displayName }) => (
    document.querySelector(selector)?.textContent?.includes(displayName)
  ), { selector: '[data-font-switcher-ready="true"]', displayName: font.displayName }, { timeout: 10_000 });
  await page.waitForFunction(name => document.body.style.fontFamily.includes(name), font.name, { timeout: 10_000 });

  const resetFont = waitForTrpcMutation(page, 'config.update');
  await fontButton.click();
  await selectFontOption(page, 'default');
  const reset = await resetFont;
  assert(reset.ok(), 'Resetting local font did not update config.', { status: reset.status() });
  await page.waitForFunction(() => document.body.style.fontFamily === '', undefined, { timeout: 10_000 });
}

async function verifyTagTreeFilter(page, parentTag, childTag, content) {
  await page.goto(new URL('/?path=notes', base).toString(), { waitUntil: 'networkidle' });
  const tree = page.getByRole('tree', { name: 'directory tree' });
  const parent = tree.locator(`[title="${parentTag}"]`);
  await parent.waitFor({ state: 'visible', timeout: 10_000 });
  await parent.click();
  await page.waitForFunction(() => new URLSearchParams(window.location.search).has('tagId'), undefined, { timeout: 10_000 });
  const parentTagId = await page.evaluate(() => new URLSearchParams(window.location.search).get('tagId'));
  assert(parentTagId, 'Selecting the parent tag did not set a tagId.');
  await noteCard(page, content).waitFor({ state: 'visible', timeout: 10_000 });

  const child = tree.locator(`[title="${childTag}"]`);
  await child.waitFor({ state: 'visible', timeout: 10_000 });
  await child.click();
  await page.waitForFunction(() => new URLSearchParams(window.location.search).has('tagId'), undefined, { timeout: 10_000 });
  const childTagId = await page.evaluate(() => new URLSearchParams(window.location.search).get('tagId'));
  assert(childTagId && childTagId !== parentTagId, 'Selecting the child tag did not replace the parent tagId.');
  await noteCard(page, content).waitFor({ state: 'visible', timeout: 10_000 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction((tagId) => new URLSearchParams(window.location.search).get('tagId') === tagId, childTagId, { timeout: 10_000 });
  await noteCard(page, content).waitFor({ state: 'visible', timeout: 10_000 });
  assert(await page.locator('.blinkora-flip-card').count() === 1,
    'Child tag filter changed after a reload.');
}

function listUrl(path = '', pageNumber) {
  const url = new URL('/', base);
  if (path) url.searchParams.set('path', path);
  if (pageNumber) url.searchParams.set('page', String(pageNumber));
  return url;
}

async function createPaginationFixtures(page, {
  targetType,
  path,
  fixtureName,
  count,
}) {
  await page.goto(listUrl(path).toString(), { waitUntil: 'networkidle' });
  const contents = [];
  for (let index = 1; index <= count; index += 1) {
    const content = `browser UI pagination ${fixtureName} ${String(index).padStart(2, '0')} ${stamp}`;
    await createNote(page, targetType, content, path && `path=${path}`);
    contents.push(content);
  }
  return contents;
}

async function configurePagination(page) {
  await openPreferenceSettings(page);

  const loadModeItem = page.getByText('卡片加载方式', { exact: true }).locator('xpath=../../..');
  await loadModeItem.getByRole('button').click();
  const paginationOption = page.getByRole('menuitem').filter({ hasText: '页码分页' });
  await paginationOption.waitFor({ state: 'visible', timeout: 10_000 });
  await paginationOption.click({ force: true });
  await page.waitForFunction(() => localStorage.getItem('noteLoadMode') === '"pagination"', undefined, { timeout: 10_000 });

  const pageSizeItem = page.getByText('每页加载数', { exact: true }).locator('xpath=..');
  const pageSize = pageSizeItem.locator('input[type="number"][min="10"][max="100"]');
  await pageSize.fill('10');
  await page.waitForFunction(() => localStorage.getItem('pageSize') === '10', undefined, { timeout: 10_000 });
}

async function renderedFixtureContents(page, paginationContents) {
  const cardTexts = await page.locator('.blinkora-flip-card').allTextContents();
  return cardTexts
    .map(cardText => paginationContents.find(content => cardText.includes(content)))
    .filter(content => content !== undefined);
}

async function verifyPagination(page, {
  path,
  fixtureName,
  paginationContents,
  expectedSecondPageCardCount = 2,
}) {
  await page.goto(listUrl(path).toString(), { waitUntil: 'networkidle' });
  const pagination = page.locator('[data-note-pagination="true"]');
  await pagination.waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('.blinkora-flip-card').first().waitFor({ state: 'visible', timeout: 10_000 });
  assert(await page.locator('.blinkora-flip-card').count() === 10,
    `The first pagination page did not render exactly ten ${fixtureName} cards.`);

  const pageTwo = pagination.locator('[data-slot="item"]').filter({ hasText: '2' });
  assert(await pageTwo.count() === 1, 'Pagination did not render exactly one page-two button.', {
    controls: await pagination.locator('[data-slot="item"]').allTextContents(),
  });
  await pageTwo.click();
  await page.waitForFunction(() => new URLSearchParams(window.location.search).get('page') === '2', undefined, { timeout: 10_000 });
  await page.waitForFunction(
    (expectedCount) => document.querySelectorAll('.blinkora-flip-card').length === expectedCount,
    expectedSecondPageCardCount,
    { timeout: 10_000 },
  );
  const secondPageContents = await renderedFixtureContents(page, paginationContents);
  assert(secondPageContents.length === expectedSecondPageCardCount,
    `Pagination page two did not contain exactly ${expectedSecondPageCardCount} known ${fixtureName} fixtures.`, { secondPageContents });

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => new URLSearchParams(window.location.search).get('page') === '2', undefined, { timeout: 10_000 });
  await page.waitForFunction(
    (expectedCount) => document.querySelectorAll('.blinkora-flip-card').length === expectedCount,
    expectedSecondPageCardCount,
    { timeout: 10_000 },
  );
  const reloadedSecondPageContents = await renderedFixtureContents(page, paginationContents);
  assert(JSON.stringify(reloadedSecondPageContents) === JSON.stringify(secondPageContents),
    `Pagination page two changed order after reloading ${fixtureName}.`, {
      beforeReload: secondPageContents,
      afterReload: reloadedSecondPageContents,
    });

  await page.goto(listUrl(path, 999).toString(), { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !new URLSearchParams(window.location.search).has('page'), undefined, { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelectorAll('.blinkora-flip-card').length === 10, undefined, { timeout: 10_000 });

  const currentFirstPageContents = await renderedFixtureContents(page, paginationContents);
  assert(currentFirstPageContents.length === 10,
    `Pagination page one did not contain exactly ten known ${fixtureName} fixtures after out-of-range reset.`, { currentFirstPageContents });
  return { firstPageContents: currentFirstPageContents, secondPageContents };
}

async function verifyPaginationAfterDeletion(page, {
  path,
  fixtureName,
  deletedContent,
  remainingContent,
  expectedRemainingCardCount = 1,
}) {
  await page.goto(listUrl(path, 2).toString(), { waitUntil: 'networkidle' });
  await page.waitForFunction(() => new URLSearchParams(window.location.search).get('page') === '2', undefined, { timeout: 10_000 });
  const deletedCard = noteCard(page, deletedContent);
  await deletedCard.waitFor({ state: 'visible', timeout: 10_000 });
  await deletedCard.hover();
  const trashed = waitForTrpcMutation(page, 'notes.trashMany');
  await deletedCard.getByRole('button', { name: '回收站', exact: true }).click();
  const response = await trashed;
  assert(response.ok(), `Delete second-page ${fixtureName} request failed.`, { status: response.status() });
  await deletedCard.waitFor({ state: 'hidden', timeout: 10_000 });
  await page.waitForFunction(() => new URLSearchParams(window.location.search).get('page') === '2', undefined, { timeout: 10_000 });
  if (remainingContent) {
    await noteCard(page, remainingContent).waitFor({ state: 'visible', timeout: 10_000 });
  }
  assert(await page.locator('.blinkora-flip-card').count() === expectedRemainingCardCount,
    `Deleting a second-page ${fixtureName} did not keep the expected card count on page two.`);

  await page.goto(listUrl('trash').toString(), { waitUntil: 'networkidle' });
  await invokeCardMenuAction(page, deletedContent, 'ArchivedItem');
  await noteCard(page, deletedContent).waitFor({ state: 'hidden', timeout: 10_000 });
}

async function archiveCards(page, contents) {
  await page.goto(listUrl().toString(), { waitUntil: 'networkidle' });
  for (const content of contents) {
    await invokeCardMenuAction(page, content, 'ArchivedItem');
    await noteCard(page, content).waitFor({ state: 'hidden', timeout: 10_000 });
  }
}

async function restoreArchivedCards(page, contents) {
  await page.goto(listUrl('archived').toString(), { waitUntil: 'networkidle' });
  for (const content of contents) {
    const card = noteCard(page, content);
    await invokeCardMenuAction(page, content, 'ArchivedItem');
    await card.waitFor({ state: 'hidden', timeout: 10_000 });
  }
}

async function trashCards(page, contents) {
  await page.goto(listUrl().toString(), { waitUntil: 'networkidle' });
  for (const content of contents) {
    await invokeCardMenuAction(page, content, 'TrashItem', 'notes.trashMany');
    await noteCard(page, content).waitFor({ state: 'hidden', timeout: 10_000 });
  }
}

async function deleteRecycledCard(page, content) {
  await page.goto(listUrl('trash', 2).toString(), { waitUntil: 'networkidle' });
  const card = await openCardMenu(page, content);
  const deleteItem = page.locator('[data-key="DeleteItem"]').last();
  await deleteItem.waitFor({ state: 'visible', timeout: 10_000 });

  const impactRequested = waitForTrpcMutation(page, 'notes.deleteImpact');
  await deleteItem.click();
  const impactResponse = await impactRequested;
  assert(impactResponse.ok(), 'Permanent delete impact request failed.', { status: impactResponse.status() });

  const dialog = page.getByRole('dialog').filter({ hasText: '此操作会彻底删除卡片' });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  const deleted = waitForTrpcMutation(page, 'notes.deleteMany');
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  const deleteResponse = await deleted;
  assert(deleteResponse.ok(), 'Permanent delete request failed.', { status: deleteResponse.status() });
  await card.waitFor({ state: 'hidden', timeout: 10_000 });
}

async function authenticatedResourceStatus(page, resourcePath) {
  const auth = await page.evaluate(() => {
    const stored = window.localStorage.getItem('blinkoraToken');
    const storedWorkspaceId = window.localStorage.getItem('blinkoraCurrentWorkspaceId');
    return {
      token: stored ? JSON.parse(stored)?.token ?? '' : '',
      workspaceId: storedWorkspaceId ? JSON.parse(storedWorkspaceId) : null,
    };
  });
  assert(auth.token, 'Browser session did not expose its account token for resource verification.');
  const response = await page.request.get(new URL(resourcePath, base).toString(), {
    headers: {
      Authorization: `Bearer ${auth.token}`,
      ...(auth.workspaceId ? { 'x-workspace-id': String(auth.workspaceId) } : {}),
    },
    failOnStatusCode: false,
  });
  return response.status();
}

async function permanentlyDeleteCard(page, content, {
  expectedOrphanAttachmentName,
  deleteOrphanAttachments,
}) {
  await page.goto(listUrl('trash').toString(), { waitUntil: 'networkidle' });
  const card = await openCardMenu(page, content);
  const deleteItem = page.locator('[data-key="DeleteItem"]').last();
  await deleteItem.waitFor({ state: 'visible', timeout: 10_000 });

  const impactRequested = waitForTrpcMutation(page, 'notes.deleteImpact');
  await deleteItem.click();
  const impactResponse = await impactRequested;
  assert(impactResponse.ok(), 'Shared-resource delete impact request failed.', {
    status: impactResponse.status(),
  });
  const impact = await trpcResponseJson(impactResponse, 'notes.deleteImpact');
  const orphanAttachments = impact?.orphanAttachments ?? [];
  if (expectedOrphanAttachmentName) {
    assert(
      orphanAttachments.some(attachment => attachment.name === expectedOrphanAttachmentName),
      'Delete impact did not identify the expected unreferenced attachment.',
      orphanAttachments,
    );
  } else {
    assert(orphanAttachments.length === 0,
      'Delete impact incorrectly classified a shared attachment as unreferenced.', orphanAttachments);
  }

  const dialog = page.getByRole('dialog').filter({ hasText: '此操作会彻底删除卡片' }).last();
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  const deleted = waitForTrpcMutation(page, 'notes.deleteMany');
  if (expectedOrphanAttachmentName) {
    await dialog.getByText(expectedOrphanAttachmentName, { exact: true })
      .waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.getByRole('button', { name: '仅删除卡片', exact: true })
      .waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.getByRole('button', { name: '连同资源删除', exact: true }).click();
  } else {
    assert(await dialog.getByRole('button', { name: '连同资源删除', exact: true }).count() === 0,
      'Shared attachment unexpectedly exposed the destructive resource-delete choice.');
    await dialog.getByRole('button', { name: '确认', exact: true }).click();
  }
  const deleteResponse = await deleted;
  assert(deleteResponse.ok(), 'Permanent shared-resource fixture deletion failed.', {
    status: deleteResponse.status(),
  });
  const requestInput = trpcRequestJsonInput(deleteResponse, 'notes.deleteMany');
  assert(requestInput?.deleteOrphanAttachments === deleteOrphanAttachments,
    'Permanent deletion submitted an unexpected resource-deletion choice.', requestInput);
  await card.waitFor({ state: 'hidden', timeout: 10_000 });
}

async function verifySharedAttachmentProtection(page) {
  const owner = `browser shared attachment owner ${stamp}`;
  const updatedOwner = `${owner} (edited)`;
  const attachmentName = `browser-shared-attachment-${stamp}.txt`;
  const attachmentBody = `shared browser attachment ${stamp}`;

  await page.goto(listUrl('notes').toString(), { waitUntil: 'networkidle' });
  await createNote(page, '笔记', owner, 'path=notes');
  let uploadedFile;
  await editNote(page, owner, updatedOwner, async () => {
    uploadedFile = await attachFileToEditedNote(page, attachmentName, {
      buffer: Buffer.from(attachmentBody),
    });
  });
  const attachmentPath = uploadedFile?.filePath ?? uploadedFile?.path;
  assert(
    typeof attachmentPath === 'string'
      && attachmentPath.startsWith('/api/file/')
      && uploadedFile?.filePath === uploadedFile?.path,
    'Local shared attachment upload returned an invalid compatibility path.',
    { filePath: uploadedFile?.filePath, path: uploadedFile?.path },
  );

  const consumer = `browser shared attachment consumer ${stamp} ${attachmentPath}`;
  await createNote(page, '笔记', consumer, 'path=notes');
  await invokeCardMenuAction(page, updatedOwner, 'TrashItem', 'notes.trashMany');
  await permanentlyDeleteCard(page, updatedOwner, {
    deleteOrphanAttachments: false,
  });
  assert(await authenticatedResourceStatus(page, attachmentPath) === 200,
    'Deleting one card removed an attachment still referenced by another card.');

  await page.goto(listUrl('notes').toString(), { waitUntil: 'networkidle' });
  await invokeCardMenuAction(page, consumer, 'TrashItem', 'notes.trashMany');
  await permanentlyDeleteCard(page, consumer, {
    expectedOrphanAttachmentName: attachmentName,
    deleteOrphanAttachments: true,
  });
  assert(await authenticatedResourceStatus(page, attachmentPath) === 404,
    'Deleting the final referencing card did not remove its selected unused attachment.');
}

async function verifyTransactionalEditorAttachmentDeletion(page) {
  const original = `browser transactional attachment ${stamp}`;
  const withAttachment = `${original} (attached)`;
  const withoutAttachment = `${withAttachment} (removed)`;
  const attachmentName = `browser-transactional-attachment-${stamp}.txt`;
  let uploadedFile;

  await page.goto(listUrl('notes').toString(), { waitUntil: 'networkidle' });
  await createNote(page, '笔记', original, 'path=notes');
  await editNote(page, original, withAttachment, async () => {
    uploadedFile = await attachFileToEditedNote(page, attachmentName);
  });
  const attachmentPath = uploadedFile?.filePath ?? uploadedFile?.path;
  assert(
    typeof attachmentPath === 'string' && attachmentPath.startsWith('/api/file/'),
    'Transactional attachment fixture returned an invalid local path.',
    uploadedFile,
  );

  const saveResponse = await editNote(page, withAttachment, withoutAttachment, async () => {
    await removeAttachmentFromCurrentEditor(page);
  });
  const saveInput = trpcRequestJsonInput(saveResponse, 'notes.upsert');
  assert(
    saveInput?.deletedAttachmentPaths?.length === 1
      && saveInput.deletedAttachmentPaths[0] === attachmentPath
      && Array.isArray(saveInput.attachments)
      && saveInput.attachments.length === 0,
    'Editor did not submit local attachment deletion in the Note transaction.',
    saveInput,
  );
  const updatedNote = await trpcResponseJson(saveResponse, 'notes.upsert');
  assert(updatedNote?.attachments?.length === 0,
    'Updated Note still returned the transactionally deleted local attachment.',
    updatedNote?.attachments);
  assert(await authenticatedResourceStatus(page, attachmentPath) === 404,
    'Transactionally deleted local attachment remained readable.');

  await invokeCardMenuAction(page, withoutAttachment, 'TrashItem', 'notes.trashMany');
  await permanentlyDeleteCard(page, withoutAttachment, {
    deleteOrphanAttachments: false,
  });
}

async function restoreRecycledCards(page, contents) {
  await page.goto(listUrl('trash').toString(), { waitUntil: 'networkidle' });
  for (const content of contents) {
    const card = noteCard(page, content);
    await invokeCardMenuAction(page, content, 'ArchivedItem');
    await card.waitFor({ state: 'hidden', timeout: 10_000 });
  }
}

async function verifyWorkspaceTokenGuide(page) {
  const url = new URL('/settings', base);
  url.searchParams.set('section', 'basic');
  await page.goto(url.toString(), { waitUntil: 'networkidle' });
  const refreshToken = page.getByRole('button', { name: '刷新当前工作区令牌', exact: true });
  const basicSection = page.locator('[data-settings-section="basic"]');
  try {
    await basicSection.waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    fail('Basic settings did not render from its section URL.', {
      url: page.url(),
      body: (await page.locator('body').innerText()).slice(0, 1_500),
      diagnostics: page.__blinkoraDiagnostics,
    });
  }
  if (await basicSection.getByText('工作区令牌', { exact: true }).count() === 0) {
    await basicSection.getByRole('button').first().click();
  }
  try {
    await refreshToken.waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    fail('Workspace Agent token setting did not render.', {
      url: page.url(),
      sectionText: (await basicSection.innerText()).slice(0, 1_000),
      buttons: await page.getByRole('button').allTextContents(),
      diagnostics: page.__blinkoraDiagnostics,
    });
  }
  const created = waitForTrpcMutation(page, 'agentTokens.create');
  await refreshToken.click();
  const response = await created;
  assert(response.ok(), 'Create Workspace Agent token request failed.', { status: response.status() });
  await page.waitForFunction(() => Array.from(document.querySelectorAll('pre')).some((guide) => {
    const content = guide.textContent ?? '';
    return content.includes('BLINKORA_AGENT_TOKEN=')
      && !content.includes('<点击右侧刷新按钮生成工作区令牌>')
      && content.includes('/sse');
  }), undefined, { timeout: 10_000 });
}

async function verifyStorageSettings(page) {
  const url = new URL('/settings', base);
  url.searchParams.set('section', 'storage');
  await page.goto(url.toString(), { waitUntil: 'networkidle' });
  const localStorage = page.getByRole('button', { name: '本地文件系统', exact: true });
  await localStorage.waitFor({ state: 'visible', timeout: 10_000 });
  await localStorage.click();
  const s3Option = page.locator('[data-key="s3"]').last();
  await s3Option.waitFor({ state: 'visible', timeout: 10_000 });
  await s3Option.focus();
  await page.keyboard.press('Enter');

  await page.locator('input[name="s3AccessKeyId"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('input[name="s3AccessKeySecret"]').waitFor({ state: 'visible', timeout: 10_000 });
  const validate = page.getByRole('button', { name: '保存并验证', exact: true });
  assert(await validate.isDisabled(), 'Empty S3 configuration unexpectedly enabled validation.');

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '本地文件系统', exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
}

async function verifyBackupExport(page) {
  const url = new URL('/settings', base);
  url.searchParams.set('section', 'export');
  await page.goto(url.toString(), { waitUntil: 'networkidle' });
  const exported = waitForTrpcMutation(page, 'task.exportMarkdown');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const response = await exported;
  assert(response.ok(), 'Workspace backup export request failed.', { status: response.status() });
  const archive = await download;
  assert(archive.suggestedFilename().toLowerCase().endsWith('.zip'), 'Workspace export did not download a ZIP archive.');
  return archive;
}

async function verifyFullJsonBackupExport(page) {
  const url = new URL('/settings', base);
  url.searchParams.set('section', 'export');
  await page.goto(url.toString(), { waitUntil: 'networkidle' });
  await selectSelectOption(page, '[data-backup-export-scope-trigger="true"]', '全量备份导出');
  await selectSelectOption(page, '[data-backup-export-format-trigger="true"]', 'JSON 备份包（.zip）');

  const exported = waitForTrpcMutation(page, 'task.exportMarkdown');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const response = await exported;
  assert(response.ok(), 'Full JSON backup export request failed.', { status: response.status() });
  const requestInput = trpcRequestJsonInput(response, 'task.exportMarkdown');
  assert(requestInput?.scope === 'full' && requestInput.format === 'json',
    'Full JSON export request did not preserve the selected scope and format.', requestInput);
  const archive = await download;
  assert(archive.suggestedFilename().toLowerCase().endsWith('.zip'), 'Full JSON export did not download a ZIP archive.');
  return archive;
}

function backupArchiveUpload(archive, archivePath) {
  const name = archive.suggestedFilename();
  assert(name.toLowerCase().endsWith('.zip'), 'Backup archive did not retain its ZIP filename.');
  return {
    name,
    mimeType: 'application/zip',
    buffer: readFileSync(archivePath),
  };
}

async function verifyFullJsonBackupImport(page, archive) {
  const archivePath = await archive.path();
  assert(archivePath, 'Full JSON export archive was not available for import.');
  const archiveUpload = backupArchiveUpload(archive, archivePath);
  await selectSelectOption(page, '[data-backup-import-mode-trigger="true"]', '全量恢复');
  const importInput = page.locator('[data-backup-import-input="true"]');
  await importInput.waitFor({ state: 'attached', timeout: 10_000 });
  const importRequested = page.waitForRequest(
    request => request.method() === 'POST' && request.url().includes('/api/backup/import'),
    { timeout: 10_000 },
  );
  const imported = page.waitForResponse(
    response => response.request().method() === 'POST' && response.url().includes('/api/backup/import'),
    { timeout: 60_000 },
  );
  const fileChooser = page.waitForEvent('filechooser');
  await page.locator('[data-backup-import-trigger="true"]').click();
  await (await fileChooser).setFiles(archiveUpload);
  const [, response] = await Promise.all([importRequested, imported]);
  assert(response.ok(), 'Full JSON backup import request failed.', { status: response.status() });
  const result = await response.json();
  assert(result?.success === true && result.mode === 'full' && result.workspaceCount > 1,
    'Full JSON backup import did not create every exported workspace.', result);

  const workspaces = await runTrpcFixtureMutation(page, 'workspaces.list', {});
  const importedWorkspaceIds = workspaces
    .filter(workspace => typeof workspace.name === 'string' && workspace.name.startsWith('Imported - '))
    .map(workspace => workspace.id);
  assert(importedWorkspaceIds.length === result.workspaceCount,
    'Full JSON import did not expose every imported workspace for cleanup.', {
      expected: result.workspaceCount,
      actual: importedWorkspaceIds.length,
    });
  for (const id of importedWorkspaceIds) {
    const deleted = await runTrpcFixtureMutation(page, 'workspaces.delete', { id });
    assert(deleted?.success === true, 'Cleaning up an imported full-backup workspace failed.', { id });
  }
}

async function openOperationLogSettings(page, content) {
  const url = new URL('/settings', base);
  url.searchParams.set('section', 'operationLog');
  await page.goto(url.toString(), { waitUntil: 'networkidle' });
  await page.locator('[data-operation-log-field-trigger="true"]').waitFor({ state: 'visible', timeout: 10_000 });
  const contentPrefix = content.slice(0, 48);
  await page.getByText(contentPrefix, { exact: false }).first().waitFor({ state: 'visible', timeout: 10_000 });
}

async function verifyOperationLogFilter(page, content, {
  triggerSelector,
  optionName,
  errorMessage,
  matches,
}) {
  await openOperationLogSettings(page, content);

  const filteredLoad = waitForTrpcQuery(page, 'operationLogs.list');
  await selectSelectOption(page, triggerSelector, optionName);
  const filteredResponse = await filteredLoad;
  assert(filteredResponse.ok(), errorMessage, { status: filteredResponse.status() });
  const result = await trpcResponseJson(filteredResponse, 'operationLogs.list');
  assert(result?.items?.length > 0 && result.items.every(matches), errorMessage, result);
}

async function verifyOperationLogSettings(page, content) {
  await verifyOperationLogFilter(page, content, {
    triggerSelector: '[data-operation-log-field-trigger="true"]',
    optionName: '正文',
    errorMessage: 'Operation log content-field filter returned an unrelated record.',
    matches: item => item.changedFields?.includes('content'),
  });
  await verifyOperationLogFilter(page, content, {
    triggerSelector: '[data-operation-log-actor-trigger="true"]',
    optionName: '用户',
    errorMessage: 'Operation log user filter returned a non-user record.',
    matches: item => item.actor?.type === 'user',
  });
  await verifyOperationLogFilter(page, content, {
    triggerSelector: '[data-operation-log-note-type-trigger="true"]',
    optionName: '笔记',
    errorMessage: 'Operation log note-type filter returned a non-note record.',
    matches: item => item.target?.noteType === 1,
  });
  await verifyOperationLogFilter(page, content, {
    triggerSelector: '[data-operation-log-action-trigger="true"]',
    optionName: '更新',
    errorMessage: 'Operation log action filter returned a non-update record.',
    matches: item => item.action === 'update',
  });
}

async function verifyBackupImport(page, archive) {
  const archivePath = await archive.path();
  assert(archivePath, 'Workspace export archive was not available for import.');
  const archiveUpload = backupArchiveUpload(archive, archivePath);
  await selectSelectOption(page, '[data-backup-import-mode-trigger="true"]', '导入工作区');
  const importInput = page.locator('[data-backup-import-input="true"]');
  await importInput.waitFor({ state: 'attached', timeout: 10_000 });
  const imported = page.waitForResponse(
    response => response.request().method() === 'POST' && response.url().includes('/api/backup/import'),
    { timeout: 15_000 },
  );
  const fileChooser = page.waitForEvent('filechooser');
  await page.locator('[data-backup-import-trigger="true"]').click();
  await (await fileChooser).setFiles(archiveUpload);
  const response = await imported;
  assert(response.ok(), 'Workspace backup import request failed.', { status: response.status() });
  const result = await response.json();
  assert(result?.success === true && result.workspaceCount === 1 && result.noteCount === 0,
    'Workspace backup import did not restore the temporary empty workspace.', result);
}

function noteCard(page, content) {
  return page.locator('.blinkora-flip-card').filter({ hasText: content });
}

async function flipCard(page, card) {
  await card.hover();
  const cardElement = await card.elementHandle();
  assert(cardElement, 'Card flip target was detached before interaction.');
  const point = await card.evaluate(element => {
    const interactiveSelector = [
      '[data-drag-ignore="true"]',
      'a',
      'button',
      'input',
      'textarea',
      'select',
      '[contenteditable="true"]',
      '[role="button"]',
    ].join(',');
    const rect = element.getBoundingClientRect();
    const y = rect.top + Math.min(20, rect.height / 2);
    for (let x = rect.right - 8; x >= rect.left + 8; x -= 8) {
      const target = document.elementFromPoint(x, y);
      if (target && element.contains(target) && !target.closest(interactiveSelector)) {
        return { x, y };
      }
    }
    return null;
  });
  assert(point, 'Card header did not expose a non-interactive flip target.');
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(350);
  await page.waitForFunction(
    element => !element.querySelector('.blinkora-card-flip-out, .blinkora-card-flip-in'),
    cardElement,
    { timeout: 5_000 },
  );
}

async function visibleElement(page, locator, description) {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const index = await locator.evaluateAll(elements => elements.findIndex((element) => {
      const styles = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return styles.display !== 'none'
        && styles.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    }));
    if (index >= 0) return locator.nth(index);
    await page.waitForTimeout(200);
  }

  fail(`${description} did not become visible.`, {
    count: await locator.count(),
    diagnostics: page.__blinkoraDiagnostics,
  });
}

async function openCardMenu(page, content) {
  let card = noteCard(page, content);
  if (await card.count() === 0) {
    const currentUrl = new URL(page.url());
    for (const pageNumber of [undefined, 2]) {
      const candidateUrl = new URL(currentUrl);
      if (pageNumber) {
        candidateUrl.searchParams.set('page', String(pageNumber));
      } else {
        candidateUrl.searchParams.delete('page');
      }
      if (candidateUrl.toString() === page.url()) continue;
      await page.goto(candidateUrl.toString(), { waitUntil: 'networkidle' });
      card = noteCard(page, content);
      if (await card.count()) break;
    }
  }
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await card.hover();
  await card.getByRole('button', { name: '更多信息', exact: true }).click();
  return card;
}

async function invokeCardMenuAction(page, content, key, procedure = 'notes.upsert') {
  await openCardMenu(page, content);
  const action = page.locator(`[data-key="${key}"]`).last();
  await action.waitFor({ state: 'visible', timeout: 10_000 });
  const mutated = waitForTrpcMutation(page, procedure);
  await action.click();
  const response = await mutated;
  assert(response.ok(), `Card action ${key} request failed.`, { status: response.status() });
}

async function verifyTodoCompletion(page, todo) {
  await page.goto(new URL('/?path=todo', base).toString(), { waitUntil: 'networkidle' });
  const activeCard = noteCard(page, todo);
  await activeCard.waitFor({ state: 'visible', timeout: 10_000 });
  const completed = waitForNoteUpsert(page);
  await activeCard.getByRole('button', { name: '完成', exact: true }).click();
  const completeResponse = await completed;
  assert(completeResponse.ok(), 'Complete Todo request failed.', { status: completeResponse.status() });
  await activeCard.waitFor({ state: 'hidden', timeout: 10_000 });

  await page.goto(new URL('/?path=archived', base).toString(), { waitUntil: 'networkidle' });
  const archivedCard = noteCard(page, todo);
  await archivedCard.waitFor({ state: 'visible', timeout: 10_000 });
  const restored = waitForNoteUpsert(page);
  await archivedCard.getByRole('button', { name: '恢复', exact: true }).click();
  const restoreResponse = await restored;
  assert(restoreResponse.ok(), 'Restore completed Todo request failed.', { status: restoreResponse.status() });
  await archivedCard.waitFor({ state: 'hidden', timeout: 10_000 });

  await page.goto(new URL('/?path=todo', base).toString(), { waitUntil: 'networkidle' });
  await noteCard(page, todo).waitFor({ state: 'visible', timeout: 10_000 });
}

async function verifyCardStateActions(page, note, blinkora) {
  await page.goto(new URL('/?path=notes', base).toString(), { waitUntil: 'networkidle' });
  await invokeCardMenuAction(page, note, 'TopItem');
  await invokeCardMenuAction(page, note, 'ArchivedItem');
  await noteCard(page, note).waitFor({ state: 'hidden', timeout: 10_000 });

  await page.goto(new URL('/?path=archived', base).toString(), { waitUntil: 'networkidle' });
  await invokeCardMenuAction(page, note, 'ArchivedItem');
  await noteCard(page, note).waitFor({ state: 'hidden', timeout: 10_000 });

  await page.goto(new URL('/?path=notes', base).toString(), { waitUntil: 'networkidle' });
  await noteCard(page, note).waitFor({ state: 'visible', timeout: 10_000 });

  await page.goto(new URL('/', base).toString(), { waitUntil: 'networkidle' });
  const activeCard = noteCard(page, blinkora);
  await activeCard.waitFor({ state: 'visible', timeout: 10_000 });
  await activeCard.hover();
  const trashed = waitForTrpcMutation(page, 'notes.trashMany');
  await activeCard.getByRole('button', { name: '回收站', exact: true }).click();
  const trashResponse = await trashed;
  assert(trashResponse.ok(), 'Move Blinkora to recycle bin request failed.', { status: trashResponse.status() });
  await activeCard.waitFor({ state: 'hidden', timeout: 10_000 });

  await page.goto(new URL('/?path=trash', base).toString(), { waitUntil: 'networkidle' });
  await invokeCardMenuAction(page, blinkora, 'ArchivedItem');
  await noteCard(page, blinkora).waitFor({ state: 'hidden', timeout: 10_000 });

  await page.goto(new URL('/', base).toString(), { waitUntil: 'networkidle' });
  await noteCard(page, blinkora).waitFor({ state: 'visible', timeout: 10_000 });
}

async function openCommentDialog(page, note) {
  await page.goto(new URL('/?path=notes', base).toString(), { waitUntil: 'networkidle' });
  const card = noteCard(page, note);
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await card.hover();
  const annotation = card.getByRole('button', { name: '添加评论', exact: true });
  await annotation.click();

  const dialog = page.getByRole('dialog').filter({ hasText: '评论' }).last();
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  return dialog;
}

function commentEntry(dialog, content) {
  return dialog
    .getByText(content, { exact: true })
    .locator('xpath=ancestor::*[@data-comment-id][1]');
}

async function submitComment(page, dialog, content, procedure) {
  const editor = await visibleElement(
    page,
    dialog.locator('#vditor-comment [contenteditable="true"]'),
    'Annotation editor',
  );
  await editor.click();
  await page.keyboard.insertText(content);
  const created = waitForTrpcMutation(page, procedure);
  const submit = await visibleElement(
    page,
    dialog.locator('[role="button"][aria-label="提交"]'),
    'Annotation submit action',
  );
  await submit.click();
  const response = await created;
  assert(response.ok(), `${procedure} request failed.`, { status: response.status() });
  await dialog.getByText(content, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
}

async function verifyCommentTree(page, note, content) {
  const dialog = await openCommentDialog(page, note);
  await submitComment(page, dialog, content, 'comments.create');

  const root = commentEntry(dialog, content);
  await root.getByRole('button', { name: '回复', exact: true }).click();
  await dialog.locator('[data-comment-composer-context="true"]').waitFor({ state: 'visible', timeout: 10_000 });

  const reply = `${content} reply`;
  await submitComment(page, dialog, reply, 'comments.create');
  const replyEntry = commentEntry(dialog, reply);
  const rootId = await root.getAttribute('data-comment-id');
  assert(rootId, 'Root comment id is missing.');
  const thread = dialog.locator(`[data-comment-thread-id="${rootId}"]`);
  assert(await thread.locator('[data-comment-id]').count() === 2, 'Comment reply was not rendered in its root thread.');
  await replyEntry.getByRole('button', { name: '编辑', exact: true }).click();
  await dialog.locator('[data-comment-composer-context="true"]').getByText('编辑', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });

  const replyEditor = await visibleElement(
    page,
    dialog.locator('#vditor-comment [contenteditable="true"]'),
    'Reply editor',
  );
  await replyEditor.click();
  const updatedReply = `${reply} (edited)`;
  await page.keyboard.press('Meta+A');
  await page.keyboard.insertText(updatedReply);
  const updated = waitForTrpcMutation(page, 'comments.update');
  const submit = await visibleElement(
    page,
    dialog.locator('[role="button"][aria-label="提交"]'),
    'Comment update submit action',
  );
  await submit.click();
  const response = await updated;
  assert(response.ok(), 'Update comment reply request failed.', { status: response.status() });
  await dialog.getByText(updatedReply, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await page.keyboard.press('Escape');
  return { root: content, reply: updatedReply };
}

async function moveCardToDefaultWorkspace(page, content) {
  await openCardMenu(page, content);
  const moveAction = page.locator('[data-key="MoveWorkspaceItem"]').last();
  await moveAction.waitFor({ state: 'visible', timeout: 10_000 });
  await moveAction.click();

  const dialog = page.getByRole('dialog').filter({ hasText: '移动卡片到工作区' }).last();
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });

  const moved = waitForTrpcMutation(page, 'notes.moveToWorkspace');
  await dialog.getByRole('button', { name: '移动到工作区', exact: true }).click();
  const response = await moved;
  assert(response.ok(), 'Move card to default workspace request failed.', { status: response.status() });
  await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
  await noteCard(page, content).waitFor({ state: 'hidden', timeout: 10_000 });
}

async function switchWorkspace(page, currentWorkspace, targetWorkspace) {
  const current = page.locator('button').filter({ hasText: currentWorkspace }).first();
  await current.waitFor({ state: 'visible', timeout: 10_000 });
  await current.click();
  const target = page.locator('[role="menuitemradio"]').filter({ hasText: targetWorkspace }).last();
  await target.waitFor({ state: 'visible', timeout: 10_000 });
  await target.click();
  await page.locator('button').filter({ hasText: targetWorkspace }).first().waitFor({ state: 'visible', timeout: 10_000 });
}

async function openWorkspaceManager(page, currentWorkspace) {
  const current = page.locator('button').filter({ hasText: currentWorkspace }).first();
  await current.waitFor({ state: 'visible', timeout: 10_000 });
  await current.click();
  const manageWorkspace = page.locator('[role="menuitemradio"]').filter({ hasText: '管理工作区' });
  await manageWorkspace.waitFor({ state: 'visible', timeout: 10_000 });
  await manageWorkspace.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '管理工作区' });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  return dialog;
}

function workspaceRow(dialog, workspaceName) {
  return dialog
    .getByRole('radio', { name: `切换工作区: ${workspaceName}`, exact: true })
    .locator('xpath=../..');
}

async function verifyWorkspaceLifecycle(page, {
  workspaceName,
  renamedWorkspaceName,
  defaultWorkspaceName,
  expectedDeletedAttachmentFiles,
}) {
  const dialog = await openWorkspaceManager(page, workspaceName);
  const defaultDelete = dialog.getByRole('button', { name: '不能删除默认工作区', exact: true });
  await defaultDelete.waitFor({ state: 'visible', timeout: 10_000 });
  assert(await defaultDelete.isDisabled(), 'Default Workspace delete protection was not disabled.');

  let disposableRow = workspaceRow(dialog, workspaceName);
  await disposableRow.waitFor({ state: 'visible', timeout: 10_000 });
  await disposableRow.getByRole('button', { name: '重命名工作区', exact: true }).click();
  const renameInput = disposableRow.getByRole('textbox', { name: '重命名工作区', exact: true });
  await renameInput.fill(renamedWorkspaceName);
  const renamed = waitForTrpcMutation(page, 'workspaces.update');
  await disposableRow.getByRole('button', { name: '保存', exact: true }).click();
  const renameResponse = await renamed;
  assert(renameResponse.ok(), 'Rename disposable Workspace request failed.', {
    status: renameResponse.status(),
  });
  const renameInputPayload = trpcRequestJsonInput(renameResponse, 'workspaces.update');
  assert(renameInputPayload?.name === renamedWorkspaceName,
    'Rename disposable Workspace submitted an unexpected name.', renameInputPayload);

  disposableRow = workspaceRow(dialog, renamedWorkspaceName);
  await disposableRow.waitFor({ state: 'visible', timeout: 10_000 });
  const setDisposableDefault = waitForTrpcMutation(page, 'workspaces.setDefault');
  await disposableRow.getByRole('button', { name: '设为默认', exact: true }).click();
  const setDisposableDefaultResponse = await setDisposableDefault;
  assert(setDisposableDefaultResponse.ok(), 'Set disposable Workspace as default failed.', {
    status: setDisposableDefaultResponse.status(),
  });
  await disposableRow.getByText('默认', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  const protectedDisposableDelete = disposableRow.getByRole('button', {
    name: '不能删除默认工作区',
    exact: true,
  });
  assert(await protectedDisposableDelete.isDisabled(),
    'New default Workspace unexpectedly allowed deletion.');

  const originalDefaultRow = workspaceRow(dialog, defaultWorkspaceName);
  const restoredDefault = waitForTrpcMutation(page, 'workspaces.setDefault');
  await originalDefaultRow.getByRole('button', { name: '设为默认', exact: true }).click();
  const restoredDefaultResponse = await restoredDefault;
  assert(restoredDefaultResponse.ok(), 'Restore original default Workspace request failed.', {
    status: restoredDefaultResponse.status(),
  });
  await originalDefaultRow.getByText('默认', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });

  await disposableRow.getByRole('button', { name: '删除工作区', exact: true }).click();
  const confirmDialog = page.getByRole('dialog', { name: '删除工作区' }).last();
  await confirmDialog.waitFor({ state: 'visible', timeout: 10_000 });
  await confirmDialog.getByText(renamedWorkspaceName, { exact: false }).first()
    .waitFor({ state: 'visible', timeout: 10_000 });
  const deleted = waitForTrpcMutation(page, 'workspaces.delete');
  await confirmDialog.getByRole('button', { name: '确认', exact: true }).click();
  const deleteResponse = await deleted;
  assert(deleteResponse.ok(), 'Delete disposable Workspace request failed.', {
    status: deleteResponse.status(),
  });
  const deleteResult = await trpcResponseJson(deleteResponse, 'workspaces.delete');
  assert(
    deleteResult?.success === true
      && deleteResult?.deletedAttachmentFiles === expectedDeletedAttachmentFiles,
    'Delete disposable Workspace returned an unexpected cascade summary.',
    deleteResult,
  );
  await confirmDialog.waitFor({ state: 'hidden', timeout: 10_000 });
  await disposableRow.waitFor({ state: 'hidden', timeout: 10_000 });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
  await page.locator('button').filter({ hasText: defaultWorkspaceName }).first()
    .waitFor({ state: 'visible', timeout: 10_000 });
}

async function verifyMultiSelectMove(page, {
  currentWorkspace,
  sourceWorkspace,
  targetWorkspace,
  targetWorkspaceIsDefault = false,
  candidateContents,
}) {
  const workspaces = await runTrpcFixtureMutation(page, 'workspaces.list', {});
  assert(Array.isArray(workspaces), 'Workspace list returned an invalid payload.', workspaces);
  const targetWorkspaceRecord = workspaces.find(workspace => (
    targetWorkspaceIsDefault ? workspace.isDefault === true : workspace.name === targetWorkspace
  ));
  assert(Number.isInteger(targetWorkspaceRecord?.id),
    'Multi-select move could not resolve its target Workspace.', { targetWorkspace });

  await switchWorkspace(page, currentWorkspace, sourceWorkspace);
  await page.goto(listUrl('notes').toString(), { waitUntil: 'networkidle' });
  await page.locator('.blinkora-flip-card').first().waitFor({ state: 'visible', timeout: 10_000 });
  const visibleCandidates = await renderedFixtureContents(page, candidateContents);
  assert(visibleCandidates.length >= 2,
    'Multi-select move did not find two visible Note fixtures on the same page.', visibleCandidates);
  const selectedContents = visibleCandidates.slice(0, 2);

  await openCardMenu(page, selectedContents[0]);
  const multiSelect = page.locator('[data-key="MutiSelectItem"]').last();
  await multiSelect.waitFor({ state: 'visible', timeout: 10_000 });
  await multiSelect.click();
  const moveSelected = page.getByRole('button', { name: '移动到', exact: true });
  await moveSelected.waitFor({ state: 'visible', timeout: 10_000 });
  await noteCard(page, selectedContents[1]).click({ position: { x: 200, y: 80 } });
  await moveSelected.click();

  const moveDialog = page.getByRole('dialog').filter({ hasText: '移动卡片到工作区' }).last();
  await moveDialog.waitFor({ state: 'visible', timeout: 10_000 });
  const targetSelect = moveDialog.locator('[aria-label="选择目标工作区"]:visible').first();
  await targetSelect.waitFor({ state: 'visible', timeout: 10_000 });

  const moved = waitForTrpcMutation(page, 'notes.moveToWorkspace');
  await moveDialog.getByRole('button', { name: '移动到工作区', exact: true }).click();
  const response = await moved;
  assert(response.ok(), 'Multi-select Workspace move request failed.', { status: response.status() });
  const requestInput = trpcRequestJsonInput(response, 'notes.moveToWorkspace');
  assert(
    Array.isArray(requestInput?.ids)
      && requestInput.ids.length === 2
      && new Set(requestInput.ids).size === 2
      && requestInput?.targetWorkspaceId === targetWorkspaceRecord.id,
    'Multi-select Workspace move did not submit two distinct IDs and the expected target Workspace.',
    requestInput,
  );
  await moveDialog.waitFor({ state: 'hidden', timeout: 10_000 });
  for (const content of selectedContents) {
    await noteCard(page, content).waitFor({ state: 'hidden', timeout: 10_000 });
  }

  await switchWorkspace(page, sourceWorkspace, targetWorkspace);
  await page.goto(listUrl('notes').toString(), { waitUntil: 'networkidle' });
  for (const content of selectedContents) {
    await noteCard(page, content).waitFor({ state: 'visible', timeout: 10_000 });
  }
  return { ids: requestInput.ids, contents: selectedContents };
}

async function verifyMovedCardData(page, note, comments) {
  await page.goto(new URL('/?path=notes', base).toString(), { waitUntil: 'networkidle' });
  await noteCard(page, note).waitFor({ state: 'visible', timeout: 10_000 });

  const card = noteCard(page, note);
  await card.hover();
  await card.locator('button[data-drag-ignore="true"][aria-label*="评论"]').click();
  const dialog = page.getByRole('dialog').filter({ hasText: '评论' }).last();
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  for (const content of comments) {
    await dialog.getByText(content, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  }
  await page.keyboard.press('Escape');
}

async function deleteComment(page, note, content) {
  const dialog = await openCommentDialog(page, note);
  const entry = commentEntry(dialog, content);
  await entry.waitFor({ state: 'visible', timeout: 10_000 });
  const deleted = waitForTrpcMutation(page, 'comments.delete');
  await entry.getByRole('button', { name: '删除', exact: true }).click();
  const response = await deleted;
  assert(response.ok(), 'Delete annotation request failed.', { status: response.status() });
  await entry.waitFor({ state: 'hidden', timeout: 10_000 });
  await page.keyboard.press('Escape');
}

async function createFolder(page, folderName) {
  await page.getByRole('button', { name: '新建文件夹', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建文件夹' });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await dialog.locator('input').fill(folderName);

  const created = waitForTrpcMutation(page, 'attachments.createFolder');
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  const response = await created;
  assert(response.ok(), 'Create resource folder request failed.', { status: response.status() });
  await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
  await page.getByText(folderName, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
}

function resourceDisplayName(resourceName) {
  return resourceName.replace(/\.[^.]+$/, '');
}

function resourceEntry(page, resourceName) {
  return page
    .getByText(resourceDisplayName(resourceName), { exact: true })
    .locator("xpath=ancestor::*[.//button[@aria-label='更多信息']][1]");
}

async function openResourceMenu(page, resourceName) {
  const entry = resourceEntry(page, resourceName);
  await entry.waitFor({ state: 'visible', timeout: 10_000 });
  const more = entry.getByRole('button', { name: '更多信息', exact: true });
  await more.waitFor({ state: 'visible', timeout: 10_000 });
  await more.click();
}

async function verifyResourceDownload(page, resourceName, expectedBody) {
  await openResourceMenu(page, resourceName);
  const downloadStarted = page.waitForEvent('download', { timeout: 15_000 });
  const downloadAction = page.locator('[data-key="download"]').last();
  await downloadAction.waitFor({ state: 'visible', timeout: 10_000 });
  await downloadAction.click();
  const download = await downloadStarted;
  const failure = await download.failure();
  assert(failure === null, 'Resource download failed in the browser.', { resourceName, failure });
  const downloadPath = await download.path();
  assert(downloadPath, 'Resource download did not create a readable temporary file.', { resourceName });
  assert(readFileSync(downloadPath, 'utf8') === expectedBody,
    'Resource download changed the attachment bytes.', { resourceName });
}

async function renameFolder(page, folderName, renamedFolderName) {
  await openResourceMenu(page, folderName);
  const rename = page.locator('[data-key="rename"]').last();
  await rename.waitFor({ state: 'visible', timeout: 10_000 });
  await rename.click();

  const dialog = page.getByRole('dialog', { name: '重命名' });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await dialog.locator('input').fill(renamedFolderName);
  const renamed = waitForTrpcMutation(page, 'attachments.rename');
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  const response = await renamed;
  assert(response.ok(), 'Rename resource folder request failed.', { status: response.status() });
  await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
  await page.getByText(renamedFolderName, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
}

async function renameResource(page, resourceName, renamedResourceName) {
  await openResourceMenu(page, resourceName);
  const rename = page.locator('[data-key="rename"]').last();
  await rename.waitFor({ state: 'visible', timeout: 10_000 });
  await rename.click();

  const dialog = page.getByRole('dialog', { name: '重命名' });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await dialog.locator('input').fill(resourceDisplayName(renamedResourceName));
  const renamed = waitForTrpcMutation(page, 'attachments.rename');
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  const response = await renamed;
  assert(response.ok(), 'Rename resource request failed.', { status: response.status() });
  await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
  await resourceEntry(page, resourceName).waitFor({ state: 'hidden', timeout: 10_000 });
  await resourceEntry(page, renamedResourceName).waitFor({ state: 'visible', timeout: 10_000 });
}

async function deleteResource(page, resourceName) {
  await openResourceMenu(page, resourceName);
  const remove = page.locator('[data-key="delete"]').last();
  await remove.waitFor({ state: 'visible', timeout: 10_000 });
  await remove.click();

  const dialog = page.getByRole('dialog', { name: '确认删除' });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  const deleted = waitForTrpcMutation(page, 'attachments.delete');
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  const response = await deleted;
  assert(response.ok(), 'Delete resource request failed.', { status: response.status() });
  await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
  await resourceEntry(page, resourceName).waitFor({ state: 'hidden', timeout: 10_000 });
}

async function deleteSelectedResources(page, resourceNames) {
  for (const resourceName of resourceNames) {
    const checkbox = resourceEntry(page, resourceName).getByRole('checkbox');
    await checkbox.waitFor({ state: 'visible', timeout: 10_000 });
    await checkbox.click();
  }

  const deleted = waitForTrpcMutation(page, 'attachments.deleteMany');
  await page.getByRole('button', { name: '删除', exact: true }).last().click();
  const dialog = page.getByRole('dialog', { name: '确认删除' });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  const response = await deleted;
  assert(response.ok(), 'Delete selected resources request failed.', { status: response.status() });
  const requestInput = trpcRequestJsonInput(response, 'attachments.deleteMany');
  assert(Array.isArray(requestInput?.ids) && requestInput.ids.length === resourceNames.length,
    'Resource multi-select delete did not submit every selected resource ID.', requestInput);
  await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
  for (const resourceName of resourceNames) {
    await resourceEntry(page, resourceName).waitFor({ state: 'hidden', timeout: 10_000 });
  }
}

async function cutResource(page, resourceName) {
  await openResourceMenu(page, resourceName);
  const cut = page.locator('[data-key="cut"]').last();
  await cut.waitFor({ state: 'visible', timeout: 10_000 });
  await cut.click();
}

async function pasteResourceIntoFolder(page, folderName) {
  await openResourceMenu(page, folderName);
  const paste = page.locator('[data-key="paste"]').last();
  await paste.waitFor({ state: 'visible', timeout: 10_000 });
  const moved = waitForTrpcMutation(page, 'attachments.move');
  await paste.click();
  const response = await moved;
  assert(response.ok(), 'Move resource into folder request failed.', { status: response.status() });
}

async function moveResourceToParent(page, resourceName) {
  await openResourceMenu(page, resourceName);
  const moveToParent = page.locator('[data-key="moveToParent"]').last();
  await moveToParent.waitFor({ state: 'visible', timeout: 10_000 });
  const moved = waitForTrpcMutation(page, 'attachments.move');
  await moveToParent.click();
  const response = await moved;
  assert(response.ok(), 'Move resource to parent request failed.', { status: response.status() });
}

async function verifyResourceFolders(page, {
  attachmentName,
  renamedAttachmentName,
  disposableAttachmentNames,
  rootFolder,
  renamedRootFolder,
  nestedFolder,
  disposableFolder,
  siblingFolder,
  siblingFolderWithPrefix,
}) {
  await page.goto(new URL('/resources', base).toString(), { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '新建文件夹', exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await createFolder(page, rootFolder);
  await renameFolder(page, rootFolder, renamedRootFolder);

  await cutResource(page, attachmentName);
  await pasteResourceIntoFolder(page, renamedRootFolder);
  await resourceEntry(page, attachmentName).waitFor({ state: 'hidden', timeout: 10_000 });

  await page.getByText(renamedRootFolder, { exact: true }).click();
  await page.waitForFunction(
    (folder) => new URLSearchParams(window.location.search).get('folder') === folder,
    renamedRootFolder,
    { timeout: 10_000 },
  );
  await page.getByText('根目录', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await resourceEntry(page, attachmentName).waitFor({ state: 'visible', timeout: 10_000 });
  await moveResourceToParent(page, attachmentName);
  await resourceEntry(page, attachmentName).waitFor({ state: 'hidden', timeout: 10_000 });
  await createFolder(page, nestedFolder);

  await page.getByText('根目录', { exact: true }).click();
  await page.waitForFunction(() => !new URLSearchParams(window.location.search).has('folder'), undefined, { timeout: 10_000 });
  await resourceEntry(page, attachmentName).waitFor({ state: 'visible', timeout: 10_000 });
  await renameResource(page, attachmentName, renamedAttachmentName);
  await verifyResourceDownload(
    page,
    renamedAttachmentName,
    `temporary browser smoke attachment ${stamp}`,
  );
  await createFolder(page, siblingFolder);
  await createFolder(page, siblingFolderWithPrefix);
  await deleteResource(page, siblingFolder);
  await page.getByText(siblingFolderWithPrefix, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await createFolder(page, disposableFolder);
  await deleteResource(page, disposableFolder);
  await deleteSelectedResources(page, disposableAttachmentNames);
}

function createSyntheticWav() {
  const sampleRate = 8_000;
  const sampleCount = Math.floor(sampleRate / 4);
  const dataLength = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataLength);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataLength, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataLength, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 4_000);
    wav.writeInt16LE(sample, 44 + index * 2);
  }
  return wav;
}

async function createSyntheticWebm(page) {
  const bytes = await page.evaluate(async () => {
    if (typeof MediaRecorder === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;
    const drawing = canvas.getContext('2d');
    const stream = canvas.captureStream?.(12);
    if (!drawing || !stream) return null;

    const mimeType = ['video/webm;codecs=vp8', 'video/webm']
      .find(candidate => MediaRecorder.isTypeSupported(candidate));
    if (!mimeType) return null;

    const chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType });
    recorder.addEventListener('dataavailable', event => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    const stopped = new Promise(resolve => recorder.addEventListener('stop', resolve, { once: true }));
    recorder.start(50);
    for (let frame = 0; frame < 6; frame += 1) {
      drawing.fillStyle = frame % 2 === 0 ? '#2563eb' : '#14b8a6';
      drawing.fillRect(0, 0, canvas.width, canvas.height);
      drawing.fillStyle = '#ffffff';
      drawing.font = '20px sans-serif';
      drawing.fillText(`M1 ${frame + 1}`, 45, 52);
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    recorder.stop();
    await stopped;
    stream.getTracks().forEach(track => track.stop());
    const blob = new Blob(chunks, { type: mimeType });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  assert(Array.isArray(bytes) && bytes.length > 100,
    'Chrome could not create the isolated synthetic video fixture.');
  return Buffer.from(bytes);
}

async function waitForMediaMetadata(media, description) {
  await media.waitFor({ state: 'visible', timeout: 10_000 });
  await media.evaluate(element => new Promise((resolve, reject) => {
    if (!(element instanceof HTMLMediaElement)) {
      reject(new Error('target is not media'));
      return;
    }
    if (element.readyState >= HTMLMediaElement.HAVE_METADATA) {
      resolve(undefined);
      return;
    }
    const timer = window.setTimeout(() => reject(new Error('metadata timeout')), 10_000);
    element.addEventListener('loadedmetadata', () => {
      window.clearTimeout(timer);
      resolve(undefined);
    }, { once: true });
    element.addEventListener('error', () => {
      window.clearTimeout(timer);
      reject(new Error(element.error?.message || 'media error'));
    }, { once: true });
    element.load();
  })).catch(async error => {
    const details = await media.evaluate(async element => {
      const source = element.querySelector('source');
      const sourceUrl = source?.src || element.currentSrc || element.src;
      const parsedUrl = sourceUrl ? new URL(sourceUrl, window.location.href) : null;
      let resource = null;
      if (sourceUrl) {
        try {
          const response = await fetch(sourceUrl, { headers: { Range: 'bytes=0-99' } });
          const bytes = new Uint8Array(await response.arrayBuffer());
          resource = {
            status: response.status,
            contentType: response.headers.get('content-type'),
            contentLength: response.headers.get('content-length'),
            contentRange: response.headers.get('content-range'),
            byteLength: bytes.length,
            firstBytes: Array.from(bytes.slice(0, 16)),
          };
        } catch (fetchError) {
          resource = { error: fetchError instanceof Error ? fetchError.message : String(fetchError) };
        }
      }
      return {
        tagName: element.tagName,
        readyState: element.readyState,
        networkState: element.networkState,
        mediaError: element.error ? { code: element.error.code, message: element.error.message } : null,
        sourcePath: parsedUrl?.pathname ?? null,
        sourceQueryKeys: parsedUrl ? [...parsedUrl.searchParams.keys()] : [],
        wavSupport: element.canPlayType?.('audio/wav') ?? '',
        webmSupport: element.canPlayType?.('video/webm') ?? '',
        resource,
      };
    });
    fail(`${description} did not load metadata.`, {
      error: error instanceof Error ? error.message : String(error),
      ...details,
    });
  });
}

async function selectTheme(page, label, expectedClass) {
  const avatarTrigger = page.getByText(user, { exact: true }).first();
  await avatarTrigger.waitFor({ state: 'visible', timeout: 10_000 });
  await avatarTrigger.click();
  const option = page.getByText(label, { exact: true }).last();
  await option.waitFor({ state: 'visible', timeout: 10_000 });
  const updated = waitForTrpcMutation(page, 'config.update');
  await option.click();
  const response = await updated;
  assert(response.ok(), `Switching to ${label} failed.`, { status: response.status() });
  await option.waitFor({ state: 'hidden', timeout: 10_000 });
  await page.waitForFunction(theme => document.documentElement.classList.contains(theme), expectedClass, {
    timeout: 10_000,
  });
}

async function openFullscreenCard(page, content) {
  const card = noteCard(page, content);
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await card.click({ position: { x: 200, y: 80 } });
  const overlay = page.locator('div.fixed.inset-0').filter({ hasText: content }).last();
  await overlay.waitFor({ state: 'visible', timeout: 10_000 });
  return overlay;
}

async function verifyM1MobileReview(browser, workspace, content, diagnostics) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
  });
  const page = await context.newPage();
  const mobileDiagnostics = createDiagnostics(page, 'm1-mobile');
  await page.goto(new URL('/signin', base).toString(), { waitUntil: 'networkidle' });
  await page.locator('input[type="text"]').fill(user);
  await page.locator('input[name="password"]').fill(password);
  await Promise.all([
    page.waitForURL(new URL('/', base).toString(), { timeout: 10_000 }),
    page.locator('form button').filter({ hasText: '登录' }).click(),
  ]);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => document.body.innerText.includes('待办'), undefined, {
    timeout: 10_000,
  });
  const workspaces = await runTrpcFixtureMutation(page, 'workspaces.list', {});
  assert(Array.isArray(workspaces), 'M1 mobile review received an invalid Workspace list.');
  const targetWorkspace = workspaces.find(item => item.name === workspace);
  assert(Number.isInteger(targetWorkspace?.id), 'M1 mobile review could not resolve its isolated Workspace.', {
    workspace,
  });
  await page.evaluate(workspaceId => {
    window.localStorage.setItem('blinkoraCurrentWorkspaceId', JSON.stringify(workspaceId));
  }, targetWorkspace.id);
  await page.goto(listUrl('notes').toString(), { waitUntil: 'networkidle' });
  await noteCard(page, content).waitFor({ state: 'visible', timeout: 10_000 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    'M1 mobile Note list introduced horizontal overflow.');
  await captureM1Artifact(page, '08-mobile-list.png');

  const overlay = await openFullscreenCard(page, content);
  await captureM1Artifact(page, '09-mobile-fullscreen.png');
  await page.goBack();
  await overlay.waitFor({ state: 'hidden', timeout: 10_000 });
  diagnostics.push(...mobileDiagnostics);
  await context.close();
}

async function verifyM1VisualReview(page, browser, diagnostics) {
  const workspace = `M1 visual workspace ${stamp}`;
  const longMarker = `M1 长文排版 ${stamp}`;
  const longContent = `# ${longMarker}\n\n普通正文不应被意外加粗，并保留 **重点**。\n\n## 二级标题\n\n- 第一项\n- 第二项\n\n> 引用内容\n\n\`inline code\`\n\n收尾段落用于检查全屏滚动和摘要。`;
  const shortContent = `M1 短卡片 ${stamp}`;
  const referenceA = `M1 多引用 A ${stamp}`;
  const referenceB = `M1 多引用 B ${stamp}`;
  const referenceC = `M1 多引用 C ${stamp}`;
  const mediaContent = `M1 音视频 ${stamp}`;

  await registerAndSignIn(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: base.origin,
  });
  await createAndSelectWorkspace(page, workspace);
  const longNote = await createNote(page, '笔记', longContent, 'path=notes', longMarker);
  const otherNotes = [
    await createNote(page, '笔记', shortContent, 'path=notes'),
    await createNote(page, '笔记', referenceA, 'path=notes'),
    await createNote(page, '笔记', referenceB, 'path=notes'),
    await createNote(page, '笔记', referenceC, 'path=notes'),
    await createNote(page, '笔记', mediaContent, 'path=notes'),
  ];

  for (const note of otherNotes) {
    await runTrpcFixtureMutation(page, 'notes.reviewNote', { id: note.id });
  }
  await page.goto(new URL('/review', base).toString(), { waitUntil: 'networkidle' });
  await page.getByText(longMarker, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  const reviewParagraph = page.locator('.blinkora-review-card-markdown .markdown-body p').first();
  await reviewParagraph.waitFor({ state: 'visible', timeout: 10_000 });
  const reviewFontWeight = Number.parseInt(await reviewParagraph.evaluate(element => getComputedStyle(element).fontWeight), 10);
  assert(reviewFontWeight < 600, 'Daily review ordinary paragraph was rendered as bold text.', {
    fontWeight: reviewFontWeight,
  });
  await captureM1Artifact(page, '00-daily-review.png');
  assert(longNote.id > 0, 'M1 daily review fixture omitted its stable note id.');

  await page.goto(listUrl('notes').toString(), { waitUntil: 'networkidle' });
  await captureM1Artifact(page, '01-light-list.png');
  await page.mouse.wheel(0, 500);
  await page.waitForFunction(() => document.documentElement.classList.contains('scrollbar-active'), undefined, {
    timeout: 5_000,
  });
  await page.waitForFunction(() => !document.documentElement.classList.contains('scrollbar-active'), undefined, {
    timeout: 3_000,
  });

  const shortCard = noteCard(page, shortContent);
  const shortCardMarker = `m1-short-card-${stamp}`;
  await shortCard.evaluate((element, marker) => {
    element.setAttribute('data-browser-smoke-card', marker);
  }, shortCardMarker);
  const stableShortCard = page.locator(`[data-browser-smoke-card="${shortCardMarker}"]`);
  await flipCard(page, stableShortCard);
  await stableShortCard.locator('[title="翻回正面"]').waitFor({ state: 'visible', timeout: 10_000 });
  await captureM1Artifact(page, '02-card-back.png', stableShortCard);
  await flipCard(page, stableShortCard);
  await stableShortCard.getByText(shortContent, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });

  await openCardMenu(page, shortContent);
  const multiSelect = page.locator('[data-key="MutiSelectItem"]').last();
  await multiSelect.waitFor({ state: 'visible', timeout: 10_000 });
  await multiSelect.click();
  const longCard = noteCard(page, longMarker);
  await longCard.click({ position: { x: 300, y: 20 } });
  await page.waitForTimeout(350);
  assert((await longCard.locator('.blinkora-flip-face').getAttribute('class'))?.includes('ring-2'),
    'Clicking the card header in multi-select mode did not select the card.');
  assert(await longCard.locator('[title="翻回正面"]').count() === 0,
    'Clicking the card header in multi-select mode unexpectedly flipped it.');
  await captureM1Artifact(page, '03-multi-select.png');
  await page.getByRole('button', { name: '关闭', exact: true }).last().click();

  const fullscreen = await openFullscreenCard(page, longMarker);
  await captureM1Artifact(page, '04-fullscreen-preview.png');
  await fullscreen.getByRole('button', { name: '复制', exact: true }).click();
  await page.getByText('已复制', { exact: true }).last().waitFor({ state: 'visible', timeout: 10_000 });
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  assert(clipboard.includes(longMarker), 'Fullscreen copy action omitted the Note content.');

  await fullscreen.getByRole('button', { name: '添加评论', exact: true }).click();
  const commentDialog = page.getByRole('dialog').filter({ hasText: '暂无评论' }).last();
  await commentDialog.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(800);
  await captureM1Artifact(page, '05-fullscreen-comment.png');
  await commentDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await commentDialog.waitFor({ state: 'hidden', timeout: 10_000 });
  await fullscreen.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('#vditor-edit').waitFor({ state: 'visible', timeout: 10_000 });
  await fullscreen.getByRole('button', { name: '预览', exact: true }).click();
  await page.locator('#vditor-edit').waitFor({ state: 'hidden', timeout: 10_000 });
  await page.keyboard.press('Escape');
  await fullscreen.waitFor({ state: 'hidden', timeout: 10_000 });

  await editNote(page, referenceA, referenceA, async () => {
    await addReferenceToEditedNote(page, referenceB);
    await addReferenceToEditedNote(page, referenceC);
  });
  await editNote(page, referenceB, referenceB, async () => {
    await addReferenceToEditedNote(page, referenceA);
  });
  await page.goto(listUrl('notes').toString(), { waitUntil: 'networkidle' });
  const referenceOverlay = await openFullscreenCard(page, referenceA);
  const referenceCards = referenceOverlay.locator('.blinkora-reference');
  assert(await referenceCards.count() === 2,
    'The multi-reference fixture did not render exactly two distinct references.');
  const mutualReferenceIcon = referenceCards.locator('svg:has(path[fill="currentColor"])');
  assert(await mutualReferenceIcon.count() === 1,
    'The reciprocal pair did not render exactly one mutual-reference icon.');
  await captureM1Artifact(page, '06-multiple-references.png');
  await page.keyboard.press('Escape');
  await referenceOverlay.waitFor({ state: 'hidden', timeout: 10_000 });

  const videoBytes = await createSyntheticWebm(page);
  await editNote(page, mediaContent, mediaContent, async () => {
    await attachFileToEditedNote(page, `m1-audio-${stamp}.wav`, {
      mimeType: 'audio/wav',
      buffer: createSyntheticWav(),
      previewSelector: 'audio',
    });
    await attachFileToEditedNote(page, `m1-video-${stamp}.webm`, {
      mimeType: 'video/webm',
      buffer: videoBytes,
      previewSelector: 'video',
    });
  });
  const mediaCard = noteCard(page, mediaContent);
  await waitForMediaMetadata(mediaCard.locator('audio').first(), 'Synthetic audio preview');
  await waitForMediaMetadata(mediaCard.locator('video').first(), 'Synthetic video preview');
  await captureM1Artifact(page, '07-audio-video.png');

  await selectTheme(page, '深色模式', 'dark');
  await captureM1Artifact(page, '10-dark-theme.png');
  await selectTheme(page, '浅色模式', 'light');

  await verifyM1MobileReview(browser, workspace, longMarker, diagnostics);
  await page.goto(new URL('/review', base).toString(), { waitUntil: 'networkidle' });
  await page.getByText(longMarker, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  const reviewed = waitForTrpcMutation(page, 'notes.reviewNote');
  await page.getByRole('button', { name: '已回顾', exact: true }).click();
  const reviewedResponse = await reviewed;
  assert(reviewedResponse.ok(), 'M1 daily review request failed.', { status: reviewedResponse.status() });
  await page.getByText(longMarker, { exact: true }).waitFor({ state: 'hidden', timeout: 10_000 });
  assert(diagnostics.length === 0,
    'M1 focused browser review observed console, page, or local HTTP errors.', diagnostics);
}

async function verifyMobile(browser, diagnostics) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const mobileDiagnostics = createDiagnostics(page, 'mobile');

  await page.goto(new URL('/signin', base).toString(), { waitUntil: 'networkidle' });
  await page.locator('input[type="text"]').fill(user);
  await page.locator('input[name="password"]').fill(password);
  await Promise.all([
    page.waitForURL(new URL('/', base).toString(), { timeout: 10_000 }),
    page.locator('form button').filter({ hasText: '登录' }).click(),
  ]);
  await page.locator('body').waitFor({ state: 'visible', timeout: 10_000 });
  assert(await page.locator('body').innerText().then(text => text.includes('待办')),
    'Mobile home page did not render its navigation.');

  await page.goto(new URL('/resources', base).toString(), { waitUntil: 'networkidle' });
  assert(await page.locator('#root').evaluate(element => element.getBoundingClientRect().height > 0),
    'Mobile resources route rendered a blank root.');
  diagnostics.push(...mobileDiagnostics);
  await context.close();
}

requireIsolatedTarget();

const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable,
});
const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await desktop.newPage();
const diagnostics = createDiagnostics(page, 'desktop');

try {
  if (scenario === 'm2-clone') {
    await verifyM2CloneReview(page, diagnostics);
    console.log('focused M2 clone browser smoke passed: migrated account token, isolated Workspace writes, local attachment, comments, tags, history, operation logs, Workspace token, backup, and cascade cleanup');
  } else if (scenario === 'attachment-transaction') {
    const workspace = `browser attachment transaction workspace ${stamp}`;
    await registerAndSignIn(page);
    await createAndSelectWorkspace(page, workspace);
    await verifyTransactionalEditorAttachmentDeletion(page);
    assert(diagnostics.length === 0,
      'Focused attachment transaction smoke reported an error response or console error.', diagnostics);
    console.log('focused browser smoke passed: transactional editor attachment deletion');
  } else if (scenario === 'settings-review') {
    await registerAndSignIn(page);
    await createAndSelectWorkspace(page, `settings review workspace ${stamp}`);
    const fontFixture = await createFontFixture(page);
    await verifyFontSelection(page, fontFixture);
    const deletedFont = await runTrpcFixtureMutation(page, 'fonts.delete', { id: fontFixture.id });
    assert(deletedFont?.success === true, 'Deleting focused settings-review font fixture failed.');
    await verifyWorkspaceTokenGuide(page);
    await verifyStorageSettings(page);
    assert(diagnostics.length === 0,
      'Focused settings review reported an error response or console error.', diagnostics);
    console.log('focused browser smoke passed: settings sections, local font, Workspace Agent token, and S3 form protection');
  } else if (scenario === 'm1-review') {
    await verifyM1VisualReview(page, browser, diagnostics);
    console.log(`focused M1 browser review passed${m1ArtifactsDir ? `; artifacts: ${m1ArtifactsDir}` : ''}`);
  } else {
  const blinkora = `browser UI blinkora ${stamp}`;
  const tagParent = `browser_smoke_tag_${stamp.replace(/[^a-zA-Z0-9]/g, '')}`;
  const tagChild = `${tagParent}_child`;
  const externalLink = `https://example.com/${stamp}`;
  const note = `browser UI note ${stamp} #${tagParent}/${tagChild} ${externalLink}`;
  const todo = `browser UI todo ${stamp}`;
  const updatedNote = `${note} (edited)`;
  const workspace = `browser UI workspace ${stamp}`;
  const rootFolder = `browser UI folder ${stamp}`;
  const renamedRootFolder = `browser UI folder renamed ${stamp}`;
  const nestedFolder = `browser UI nested folder ${stamp}`;
  const disposableFolder = `browser UI disposable folder ${stamp}`;
  const siblingFolder = `browser UI sibling folder ${stamp}`;
  const siblingFolderWithPrefix = `${siblingFolder} preserved`;
  const comment = `browser UI comment ${stamp}`;
  const disposableWorkspace = `browser disposable workspace ${stamp}`;
  const renamedDisposableWorkspace = `${disposableWorkspace} renamed`;
  const disposableWorkspaceNote = `browser disposable cascade note ${stamp} #browser_disposable_${stamp.replace(/[^a-zA-Z0-9]/g, '')}`;
  const updatedDisposableWorkspaceNote = `${disposableWorkspaceNote} — workspace cascade fixture`;
  const disposableWorkspaceComment = `browser disposable cascade comment ${stamp}`;
  const disposableWorkspaceAttachment = `browser-disposable-workspace-${stamp}.txt`;
  const attachmentName = `browser-ui-attachment-${stamp}.txt`;
  const renamedAttachmentName = `browser-ui-attachment-renamed-${stamp}.txt`;
  const disposableAttachmentNames = [
    `browser-ui-attachment-batch-a-${stamp}.txt`,
    `browser-ui-attachment-batch-b-${stamp}.txt`,
  ];

  await registerAndSignIn(page);
  await createAndSelectWorkspace(page, workspace);
  const createdBlinkora = await createNote(page, '闪念', blinkora, '');
  await verifyDailyReview(page, blinkora);
  await page.goto(new URL('/', base).toString(), { waitUntil: 'networkidle' });
  await waitForApp(page);
  const createdNote = await createNote(page, '笔记', note, 'path=notes');
  await createNote(page, '待办', todo, 'path=todo');
  const updatedBlinkora = `${blinkora} (edited)`;
  await editNote(page, blinkora, updatedBlinkora, undefined, '');
  await editNote(page, note, updatedNote, async () => {
    await attachFileToEditedNote(page, attachmentName);
    for (const disposableAttachmentName of disposableAttachmentNames) {
      await attachFileToEditedNote(page, disposableAttachmentName);
    }
    await addReferenceToEditedNote(page, updatedBlinkora);
  });
  const updatedTodo = `${todo} (edited)`;
  await editNote(page, todo, updatedTodo, undefined, 'todo');
  const propertyFixture = await verifyNoteProperties(page, updatedNote, createdNote.id, {
    expectedAttachmentNames: [attachmentName, ...disposableAttachmentNames],
    expectedReferenceId: createdBlinkora.id,
  });
  await verifyNoteTypeConversions(
    page,
    updatedNote,
    propertyFixture.note,
    propertyFixture.properties,
  );
  propertyFixture.note = await verifyPropertyValidationAndClear(
    page,
    updatedNote,
    propertyFixture.note,
    propertyFixture.properties,
  );
  await verifyTodoCompletion(page, updatedTodo);
  await verifyCardStateActions(page, updatedNote, updatedBlinkora);
  await verifyGlobalSearch(page, updatedBlinkora);
  const commentTree = await verifyCommentTree(page, updatedNote, comment);
  await verifyAttachmentFilter(page, updatedNote);
  await verifyLinkFilter(page, updatedNote);
  await verifyTagTreeFilter(page, tagParent, tagChild, updatedNote);
  await verifyTaggedAttachmentFilter(page, tagChild, updatedNote);
  await page.goto(new URL('/?path=notes', base).toString(), { waitUntil: 'networkidle' });
  await moveCardToDefaultWorkspace(page, updatedNote);
  await switchWorkspace(page, workspace, '默认工作区');
  await verifyMovedCardData(page, updatedNote, [commentTree.root, commentTree.reply]);
  await deleteComment(page, updatedNote, commentTree.reply);
  await deleteComment(page, updatedNote, commentTree.root);
  await verifyGlobalResourceSearch(page, attachmentName);
  await verifyResourceFolders(page, {
    attachmentName,
    renamedAttachmentName,
    disposableAttachmentNames,
    rootFolder,
    renamedRootFolder,
    nestedFolder,
    disposableFolder,
    siblingFolder,
    siblingFolderWithPrefix,
  });
  await deleteResource(page, renamedAttachmentName);
  await switchWorkspace(page, '默认工作区', workspace);
  await verifySharedAttachmentProtection(page);
  await verifyTransactionalEditorAttachmentDeletion(page);
  const paginationBlinkoras = await createPaginationFixtures(page, {
    targetType: '闪念',
    path: '',
    fixtureName: 'blinkora',
    count: 11,
  });
  const paginationNotes = await createPaginationFixtures(page, {
    targetType: '笔记',
    path: 'notes',
    fixtureName: 'note',
    count: 12,
  });
  const paginationTodos = await createPaginationFixtures(page, {
    targetType: '待办',
    path: 'todo',
    fixtureName: 'todo',
    count: 11,
  });
  await configurePagination(page);
  const paginationPages = await verifyPagination(page, {
    path: '',
    fixtureName: 'Blinkora',
    paginationContents: [updatedBlinkora, ...paginationBlinkoras],
  });
  const notePaginationPages = await verifyPagination(page, {
    path: 'notes',
    fixtureName: 'Note',
    paginationContents: paginationNotes,
  });
  const todoPaginationPages = await verifyPagination(page, {
    path: 'todo',
    fixtureName: 'Todo',
    paginationContents: [updatedTodo, ...paginationTodos],
  });
  await verifyPaginationAfterDeletion(page, {
    path: '',
    fixtureName: 'Blinkora',
    deletedContent: paginationPages.secondPageContents[0],
    remainingContent: paginationPages.secondPageContents[1],
  });
  await verifyPaginationAfterDeletion(page, {
    path: 'notes',
    fixtureName: 'Note',
    deletedContent: notePaginationPages.secondPageContents[0],
    remainingContent: notePaginationPages.secondPageContents[1],
  });
  await verifyPaginationAfterDeletion(page, {
    path: 'todo',
    fixtureName: 'Todo',
    deletedContent: todoPaginationPages.secondPageContents[0],
    remainingContent: todoPaginationPages.secondPageContents[1],
  });
  const allPaginationPages = await verifyPagination(page, {
    path: 'all',
    fixtureName: 'all-list',
    paginationContents: [
      updatedBlinkora,
      ...paginationBlinkoras,
      ...paginationNotes,
      updatedTodo,
      ...paginationTodos,
    ],
    expectedSecondPageCardCount: 10,
  });
  // Deleting a note changes its timestamp, which can legitimately reshuffle
  // the global list. Check this snapshot after all type-specific mutations.
  await verifyPaginationAfterDeletion(page, {
    path: 'all',
    fixtureName: 'all-list',
    deletedContent: allPaginationPages.secondPageContents[0],
    expectedRemainingCardCount: 10,
  });
  const blinkoraPaginationContents = [updatedBlinkora, ...paginationBlinkoras];
  await archiveCards(page, blinkoraPaginationContents);
  const archivedPaginationPages = await verifyPagination(page, {
    path: 'archived',
    fixtureName: 'Archived Blinkora',
    paginationContents: blinkoraPaginationContents,
  });
  await verifyPaginationAfterDeletion(page, {
    path: 'archived',
    fixtureName: 'Archived Blinkora',
    deletedContent: archivedPaginationPages.secondPageContents[0],
    remainingContent: archivedPaginationPages.secondPageContents[1],
  });
  await restoreArchivedCards(
    page,
    blinkoraPaginationContents.filter(content => content !== archivedPaginationPages.secondPageContents[0]),
  );
  await trashCards(page, blinkoraPaginationContents);
  const recycledPaginationPages = await verifyPagination(page, {
    path: 'trash',
    fixtureName: 'Recycled Blinkora',
    paginationContents: blinkoraPaginationContents,
  });
  const permanentlyDeletedContent = recycledPaginationPages.secondPageContents[0];
  const remainingRecycledContent = recycledPaginationPages.secondPageContents[1];
  await deleteRecycledCard(page, permanentlyDeletedContent);
  await page.waitForFunction(() => new URLSearchParams(window.location.search).get('page') === '2', undefined, { timeout: 10_000 });
  await noteCard(page, remainingRecycledContent).waitFor({ state: 'visible', timeout: 10_000 });
  assert(await page.locator('.blinkora-flip-card').count() === 1,
    'Permanently deleting a second-page Recycled Blinkora did not retain the remaining card on page two.');
  await restoreRecycledCards(
    page,
    blinkoraPaginationContents.filter(content => content !== permanentlyDeletedContent),
  );
  await switchWorkspace(page, workspace, '默认工作区');
  const todoFilterVisibleContent = `browser UI Markdown task ${stamp}`;
  await verifyDateRangeFilter(page, updatedNote, createdNote.id);
  await createNote(page, '闪念', `- [ ] ${todoFilterVisibleContent}`, '', todoFilterVisibleContent);
  await verifyTodoContentFilter(page, todoFilterVisibleContent);
  await invokeCardMenuAction(page, todoFilterVisibleContent, 'TrashItem', 'notes.trashMany');
  await deleteRecycledCard(page, todoFilterVisibleContent);
  await page.goto(new URL('/', base).toString(), { waitUntil: 'networkidle' });
  await waitForApp(page);
  const untaggedFilterContent = `browser UI untagged ${stamp}`;
  await createNote(page, '闪念', untaggedFilterContent, '');
  await verifyWithoutTagFilter(page, untaggedFilterContent);
  await invokeCardMenuAction(page, untaggedFilterContent, 'TrashItem', 'notes.trashMany');
  await deleteRecycledCard(page, untaggedFilterContent);
  // Operation logs remain scoped to the workspace where the action occurred,
  // even after the note itself is moved elsewhere.
  await switchWorkspace(page, '默认工作区', workspace);
  await verifyOperationLogSettings(page, updatedNote);
  const fontFixture = await createFontFixture(page);
  await verifyFontSelection(page, fontFixture);
  const deletedFont = await runTrpcFixtureMutation(page, 'fonts.delete', { id: fontFixture.id });
  assert(deletedFont?.success === true, 'Deleting local font fixture failed.');
  await verifyWorkspaceTokenGuide(page);
  await verifyStorageSettings(page);
  const backupWorkspace = `browser UI backup workspace ${stamp}`;
  await page.goto(new URL('/', base).toString(), { waitUntil: 'networkidle' });
  await waitForApp(page);
  await switchWorkspace(page, workspace, '默认工作区');
  await createAndSelectWorkspace(page, backupWorkspace);
  const backupArchive = await verifyBackupExport(page);
  const fullJsonArchive = await verifyFullJsonBackupExport(page);
  await verifyFullJsonBackupImport(page, fullJsonArchive);
  await verifyBackupImport(page, backupArchive);
  await switchWorkspace(page, backupWorkspace, '默认工作区');
  const disposableWorkspaceRecord = await createAndSelectWorkspace(page, disposableWorkspace);
  await createNote(page, '笔记', disposableWorkspaceNote, 'path=notes');
  await editNote(
    page,
    disposableWorkspaceNote,
    updatedDisposableWorkspaceNote,
    async () => attachFileToEditedNote(page, disposableWorkspaceAttachment),
  );
  await verifyCommentTree(page, updatedDisposableWorkspaceNote, disposableWorkspaceComment);
  const disposableAgentToken = await runTrpcFixtureMutation(page, 'agentTokens.create', {
    workspaceId: disposableWorkspaceRecord.id,
    name: `browser disposable token ${stamp}`,
  });
  assert(Number.isInteger(disposableAgentToken?.id) && disposableAgentToken?.token?.startsWith('bkws_'),
    'Create disposable Workspace Agent token failed.');
  await verifyWorkspaceLifecycle(page, {
    workspaceName: disposableWorkspace,
    renamedWorkspaceName: renamedDisposableWorkspace,
    defaultWorkspaceName: '默认工作区',
    expectedDeletedAttachmentFiles: 1,
  });
  await verifyMultiSelectMove(page, {
    currentWorkspace: '默认工作区',
    sourceWorkspace: workspace,
    targetWorkspace: '默认工作区',
    targetWorkspaceIsDefault: true,
    candidateContents: paginationNotes,
  });
  await verifyMobile(browser, diagnostics);

  assert(diagnostics.length === 0, 'Browser diagnostics reported an error response or console error.', diagnostics);
  console.log('browser smoke passed: desktop/mobile login, daily review, workspace create/switch/rename/default/delete, single and multi-card Workspace move, three note types plus round-trip conversion, edit/history/tag-tree/attachment/reference/custom typed properties, Todo complete/restore, pin/archive/recycle/restore, comment tree create/reply/edit/delete, date-range/tag+attachment/attachment/link/Todo-content/without-tag filters with reset and reload retention where supported, operation-log content filtering, local-font selection/reload/reset, Blinkora/Note/Todo/all/archive/trash pagination page-two reload/delete retention/out-of-range reset, Workspace Agent token guide, S3 form protection, workspace Markdown export/import plus full JSON export/import, global search, resource download/attachment/folder rename/nesting/move/sibling-delete protection, transactional editor attachment deletion, and multi-select delete; no console errors or local 4xx/5xx');
  }
} finally {
  await desktop.close();
  await browser.close();
}
