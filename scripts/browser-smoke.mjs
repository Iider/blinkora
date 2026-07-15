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
}

async function createNote(page, currentType, targetType, content, expectedPath) {
  if (currentType !== targetType) {
    const typeButton = page.locator(`#global-editor button[aria-label="${currentType}"]`);
    await typeButton.waitFor({ state: 'visible', timeout: 10_000 });
    await typeButton.click();
    await page.locator('[data-note-type-picker-content] button').filter({ hasText: targetType }).click();
    await page.locator(`#global-editor button[aria-label="${targetType}"]`).waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(600);
  }

  const editor = page.locator('#vditor-create .vditor-ir [contenteditable="true"]');
  await editor.click();
  await page.keyboard.insertText(content);
  const saved = waitForNoteUpsert(page);
  await page.locator('#global-editor div[class*="w-[60px]"]').click();
  const response = await saved;
  assert(response.ok(), 'Create note request failed.', { status: response.status() });

  if (expectedPath) {
    await page.waitForFunction(path => window.location.search.includes(path), expectedPath, { timeout: 10_000 });
  }
  await page.getByText(content, { exact: true }).first().waitFor({ state: 'visible', timeout: 10_000 });
}

async function editNote(page, originalContent, updatedContent) {
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

  const sendButtons = page.locator('div[class*="w-[60px]"]');
  assert(await sendButtons.count() >= 2, 'Edit mode did not expose its save action.');
  const saved = waitForNoteUpsert(page);
  await sendButtons.last().click();
  const response = await saved;
  assert(response.ok(), 'Edit note request failed.', { status: response.status() });
}

async function verifyGlobalSearch(page, content) {
  await page.getByRole('button', { name: /搜索/ }).click();
  const search = page.locator('[aria-label="global-search"]');
  await search.waitFor({ state: 'visible', timeout: 10_000 });
  await search.fill(content);
  await page.getByRole('dialog').getByText(content, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
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

async function verifyResourceFolders(page, rootFolder, nestedFolder) {
  await page.goto(new URL('/resources', base).toString(), { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '新建文件夹', exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await createFolder(page, rootFolder);

  await page.getByText(rootFolder, { exact: true }).click();
  await page.waitForFunction(
    (folder) => new URLSearchParams(window.location.search).get('folder') === folder,
    rootFolder,
    { timeout: 10_000 },
  );
  await page.getByText('根目录', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await createFolder(page, nestedFolder);
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
  const note = `browser UI note ${stamp}`;
  const todo = `browser UI todo ${stamp}`;
  const updatedNote = `${note} (edited)`;
  const workspace = `browser UI workspace ${stamp}`;
  const rootFolder = `browser UI folder ${stamp}`;
  const nestedFolder = `browser UI nested folder ${stamp}`;

  await registerAndSignIn(page);
  await createAndSelectWorkspace(page, workspace);
  await createNote(page, '闪念', '闪念', blinkora, '');
  await createNote(page, '闪念', '笔记', note, 'path=notes');
  await createNote(page, '笔记', '待办', todo, 'path=todo');
  await verifyGlobalSearch(page, blinkora);
  await editNote(page, note, updatedNote);
  await verifyResourceFolders(page, rootFolder, nestedFolder);
  await verifyMobile(browser, diagnostics);

  assert(diagnostics.length === 0, 'Browser diagnostics reported an error response or console error.', diagnostics);
  console.log('browser smoke passed: desktop/mobile login, workspace creation and switch, three note types, note edit, global search, nested resource folders; no console errors or local 4xx/5xx');
} finally {
  await desktop.close();
  await browser.close();
}
