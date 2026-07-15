#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const base = new URL(process.env.BLINKORA_BASE_URL || 'http://127.0.0.1:6676');
const browserExecutable = process.env.BLINKORA_BROWSER_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const user = `browser_smoke_${stamp}`;
const password = 'BrowserSmoke!local';
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
    response => response.request().method() === 'POST' && response.url().includes('/api/trpc/notes.upsert'),
    { timeout: 15_000 },
  );
}

function waitForTrpcMutation(page, procedure) {
  return page.waitForResponse(
    response => response.request().method() === 'POST' && response.url().includes(`/api/trpc/${procedure}`),
    { timeout: 15_000 },
  );
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

async function createAndSelectWorkspace(page, name) {
  const currentWorkspace = page.locator('button').filter({ hasText: '默认工作区' }).first();
  await currentWorkspace.waitFor({ state: 'visible', timeout: 10_000 });
  await currentWorkspace.click();
  await page.locator('[role="menuitemradio"]').filter({ hasText: '管理工作区' }).click();

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
}

async function createNote(page, targetType, content, expectedPath) {
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

  if (expectedPath) {
    await page.waitForFunction(path => window.location.search.includes(path), expectedPath, { timeout: 10_000 });
  }
  const noteText = page.getByText(content, { exact: true }).first();
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

async function editNote(page, originalContent, updatedContent, beforeSave) {
  await page.goto(new URL('/?path=notes', base).toString(), { waitUntil: 'commit' });
  await page.waitForFunction(() => window.location.search.includes('path=notes'), undefined, { timeout: 10_000 });
  const card = page.locator('.blinkora-flip-card').filter({ hasText: originalContent });
  await card.waitFor({ state: 'visible', timeout: 10_000 });

  await card.click({ position: { x: 200, y: 80 } });
  await page.waitForTimeout(250);
  const fullscreenEdit = page.getByRole('button', { name: '编辑', exact: true });
  if (await fullscreenEdit.count()) {
    await fullscreenEdit.click();
  } else {
    await card.dblclick({ position: { x: 200, y: 80 } });
  }

  const editEditor = page.locator('#vditor-edit .vditor-ir [contenteditable="true"]');
  await editEditor.waitFor({ state: 'visible', timeout: 10_000 });
  await editEditor.click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(updatedContent.slice(originalContent.length));
  await beforeSave?.();
  await saveEditedNote(page);
}

async function attachFileToEditedNote(page, fileName) {
  const editorRoot = page.locator('#vditor-edit').locator('xpath=ancestor::*[.//input[@type="file"]][1]');
  const fileInput = editorRoot.locator('input[type="file"]');
  await fileInput.waitFor({ state: 'attached', timeout: 10_000 });
  const uploaded = page.waitForResponse(
    response => response.request().method() === 'POST' && response.url().includes('/api/file/upload'),
    { timeout: 15_000 },
  );
  await fileInput.setInputFiles({
    name: fileName,
    mimeType: 'text/plain',
    buffer: Buffer.from(`temporary browser smoke attachment ${stamp}`),
  });
  const response = await uploaded;
  assert(response.ok(), 'Upload attachment request failed.', { status: response.status() });
  await page.getByText(fileName, { exact: true }).last().waitFor({ state: 'visible', timeout: 10_000 });
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
}

async function verifyGlobalSearch(page, content) {
  await page.getByRole('button', { name: /搜索/ }).click();
  const search = page.locator('[aria-label="global-search"]');
  await search.waitFor({ state: 'visible', timeout: 10_000 });
  await search.fill(content);
  await page.getByRole('dialog').getByText(content, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await page.keyboard.press('Escape');
}

async function verifyAttachmentFilter(page, content) {
  await page.goto(new URL('/?path=all', base).toString(), { waitUntil: 'networkidle' });
  await page.locator('[data-filter-trigger="true"]').click();
  await page.getByRole('radio', { name: '包含文件', exact: true }).click();
  await page.getByRole('button', { name: '应用筛选', exact: true }).click();
  await page.waitForFunction(() => new URLSearchParams(window.location.search).get('withFile') === 'true', undefined, { timeout: 10_000 });
  await noteCard(page, content).waitFor({ state: 'visible', timeout: 10_000 });
  assert(await page.locator('.blinkora-flip-card').count() === 1,
    'Attachment filter did not reduce the list to the attached Note.');

  const reset = page.getByRole('button', { name: '重置', exact: true });
  await reset.waitFor({ state: 'hidden', timeout: 10_000 });
  await page.locator('[data-filter-trigger="true"]').click();
  await reset.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(200);
  await reset.click();
  await page.waitForFunction(() => !new URLSearchParams(window.location.search).has('withFile'), undefined, { timeout: 10_000 });
}

async function createPaginationNotes(page, count) {
  await page.goto(new URL('/', base).toString(), { waitUntil: 'networkidle' });
  const contents = [];
  for (let index = 1; index <= count; index += 1) {
    const content = `browser UI pagination blinkora ${index} ${stamp}`;
    await createNote(page, '闪念', content, '');
    contents.push(content);
  }
  return contents;
}

async function verifyPagination(page) {
  await page.goto(new URL('/settings', base).toString(), { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '偏好', exact: true }).click();

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

  await page.goto(new URL('/', base).toString(), { waitUntil: 'networkidle' });
  const pagination = page.locator('[data-note-pagination="true"]');
  await pagination.waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('.blinkora-flip-card').first().waitFor({ state: 'visible', timeout: 10_000 });
  assert(await page.locator('.blinkora-flip-card').count() === 10,
    'The first pagination page did not render exactly ten Blinkora cards.');

  const pageTwo = pagination.locator('[data-slot="item"]').filter({ hasText: '2' });
  assert(await pageTwo.count() === 1, 'Pagination did not render exactly one page-two button.', {
    controls: await pagination.locator('[data-slot="item"]').allTextContents(),
  });
  await pageTwo.click();
  await page.waitForFunction(() => new URLSearchParams(window.location.search).get('page') === '2', undefined, { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelectorAll('.blinkora-flip-card').length === 1, undefined, { timeout: 10_000 });

  await page.goto(new URL('/?page=999', base).toString(), { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !new URLSearchParams(window.location.search).has('page'), undefined, { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelectorAll('.blinkora-flip-card').length === 10, undefined, { timeout: 10_000 });
}

function noteCard(page, content) {
  return page.locator('.blinkora-flip-card').filter({ hasText: content });
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
  const card = noteCard(page, content);
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

async function verifyComment(page, note, content) {
  await page.goto(new URL('/?path=notes', base).toString(), { waitUntil: 'networkidle' });
  const card = noteCard(page, note);
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await card.hover();
  const annotation = card.getByRole('button', { name: '添加评论', exact: true });
  await annotation.click();

  const dialog = page.getByRole('dialog').filter({ hasText: '评论' }).last();
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  const editor = await visibleElement(
    page,
    dialog.locator('#vditor-comment [contenteditable="true"]'),
    'Annotation editor',
  );
  await editor.click();
  await page.keyboard.insertText(content);
  const created = waitForTrpcMutation(page, 'comments.create');
  const submit = await visibleElement(
    page,
    dialog.locator('[role="button"][aria-label="提交"]'),
    'Annotation submit action',
  );
  await submit.click();
  const response = await created;
  assert(response.ok(), 'Create annotation request failed.', { status: response.status() });
  await dialog.getByText(content, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await page.keyboard.press('Escape');
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

async function verifyMovedCardData(page, note, comment) {
  await page.goto(new URL('/?path=notes', base).toString(), { waitUntil: 'networkidle' });
  await noteCard(page, note).waitFor({ state: 'visible', timeout: 10_000 });

  const card = noteCard(page, note);
  await card.hover();
  await card.locator('button[data-drag-ignore="true"][aria-label*="评论"]').click();
  const dialog = page.getByRole('dialog').filter({ hasText: '评论' }).last();
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await dialog.getByText(comment, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
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

function resourceEntry(page, folderName) {
  return page.locator('.group').filter({ hasText: folderName }).first();
}

async function openResourceMenu(page, folderName) {
  const entry = resourceEntry(page, folderName);
  await entry.waitFor({ state: 'visible', timeout: 10_000 });
  const more = entry.getByRole('button', { name: '更多信息', exact: true });
  await more.waitFor({ state: 'visible', timeout: 10_000 });
  await more.click();
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

async function deleteFolder(page, folderName) {
  await openResourceMenu(page, folderName);
  const remove = page.locator('[data-key="delete"]').last();
  await remove.waitFor({ state: 'visible', timeout: 10_000 });
  await remove.click();

  const dialog = page.getByRole('dialog', { name: '确认删除' });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  const deleted = waitForTrpcMutation(page, 'attachments.delete');
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  const response = await deleted;
  assert(response.ok(), 'Delete resource folder request failed.', { status: response.status() });
  await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
  await page.getByText(folderName, { exact: true }).waitFor({ state: 'hidden', timeout: 10_000 });
}

async function verifyResourceFolders(page, rootFolder, renamedRootFolder, nestedFolder, disposableFolder) {
  await page.goto(new URL('/resources', base).toString(), { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '新建文件夹', exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await createFolder(page, rootFolder);
  await renameFolder(page, rootFolder, renamedRootFolder);

  await page.getByText(renamedRootFolder, { exact: true }).click();
  await page.waitForFunction(
    (folder) => new URLSearchParams(window.location.search).get('folder') === folder,
    renamedRootFolder,
    { timeout: 10_000 },
  );
  await page.getByText('根目录', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await createFolder(page, nestedFolder);

  await page.getByText('根目录', { exact: true }).click();
  await page.waitForFunction(() => !new URLSearchParams(window.location.search).has('folder'), undefined, { timeout: 10_000 });
  await createFolder(page, disposableFolder);
  await deleteFolder(page, disposableFolder);
}

async function verifyMobile(browser, diagnostics) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  diagnostics.push(...createDiagnostics(page, 'mobile'));

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
  const blinkora = `browser UI blinkora ${stamp}`;
  const tag = `browser_smoke_tag_${stamp.replace(/[^a-zA-Z0-9]/g, '')}`;
  const note = `browser UI note ${stamp} #${tag}`;
  const todo = `browser UI todo ${stamp}`;
  const updatedNote = `${note} (edited)`;
  const workspace = `browser UI workspace ${stamp}`;
  const rootFolder = `browser UI folder ${stamp}`;
  const renamedRootFolder = `browser UI folder renamed ${stamp}`;
  const nestedFolder = `browser UI nested folder ${stamp}`;
  const disposableFolder = `browser UI disposable folder ${stamp}`;
  const comment = `browser UI comment ${stamp}`;
  const attachmentName = `browser-ui-attachment-${stamp}.txt`;

  await registerAndSignIn(page);
  await createAndSelectWorkspace(page, workspace);
  await createNote(page, '闪念', blinkora, '');
  await verifyDailyReview(page, blinkora);
  await page.goto(new URL('/', base).toString(), { waitUntil: 'networkidle' });
  await waitForApp(page);
  await createNote(page, '笔记', note, 'path=notes');
  await createNote(page, '待办', todo, 'path=todo');
  const paginationBlinkoras = await createPaginationNotes(page, 10);
  await verifyPagination(page);
  await verifyGlobalSearch(page, blinkora);
  await editNote(page, note, updatedNote, async () => {
    await attachFileToEditedNote(page, attachmentName);
    await addReferenceToEditedNote(page, blinkora);
  });
  await verifyTodoCompletion(page, todo);
  await verifyCardStateActions(page, updatedNote, paginationBlinkoras[0]);
  await verifyComment(page, updatedNote, comment);
  await verifyAttachmentFilter(page, updatedNote);
  await page.goto(new URL('/?path=notes', base).toString(), { waitUntil: 'networkidle' });
  await moveCardToDefaultWorkspace(page, updatedNote);
  await switchWorkspace(page, workspace, '默认工作区');
  await verifyMovedCardData(page, updatedNote, comment);
  await verifyResourceFolders(page, rootFolder, renamedRootFolder, nestedFolder, disposableFolder);
  await verifyMobile(browser, diagnostics);

  assert(diagnostics.length === 0, 'Browser diagnostics reported an error response or console error.', diagnostics);
  console.log('browser smoke passed: desktop/mobile login, daily review, workspace creation/switch/move, three note types, edit/history/tag/attachment/reference, Todo complete/restore, pin/archive/recycle/restore, annotation, attachment filter/reset, pagination/out-of-range reset, global search, resource folder rename/nesting/delete; no console errors or local 4xx/5xx');
} finally {
  await desktop.close();
  await browser.close();
}
