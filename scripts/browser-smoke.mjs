#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const base = new URL(process.env.BLINKORA_BASE_URL || 'http://127.0.0.1:6676');
const browserExecutable = process.env.BLINKORA_BROWSER_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const user = `browser_smoke_${stamp}`;
const password = 'BrowserSmoke!local';
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
    const response = await fetch(`/api/trpc/${procedure}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ json: input }),
    });
    const payload = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, payload };
  }, { procedure, input });

  assert(result.ok, `Fixture mutation ${procedure} failed.`, { status: result.status });
  return result.payload?.result?.data?.json;
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
    const fullscreenEdit = page.getByRole('button', { name: '编辑', exact: true });
    if (await fullscreenEdit.count()) {
      await fullscreenEdit.click();
    } else {
      await card.dblclick({ position: { x: 200, y: 80 } });
    }
  } else {
    await openCardMenu(page, originalContent);
    const edit = page.locator('[data-key="EditItem"]').last();
    await edit.waitFor({ state: 'visible', timeout: 10_000 });
    await edit.click();
  }

  const editEditor = page.locator('#vditor-edit .vditor-ir [contenteditable="true"]');
  await editEditor.waitFor({ state: 'visible', timeout: 10_000 });
  await editEditor.click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(updatedContent.slice(originalContent.length));
  await beforeSave?.();
  await saveEditedNote(page);
  await noteCard(page, updatedContent).waitFor({ state: 'visible', timeout: 10_000 });
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

async function verifyFontSelection(page, font) {
  await page.goto(new URL('/settings', base).toString(), { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '偏好', exact: true }).click();
  const fontButton = page.locator('[data-font-switcher-ready="true"]');
  await fontButton.waitFor({ state: 'visible', timeout: 10_000 });

  const updateFont = waitForTrpcMutation(page, 'config.update');
  await fontButton.click();
  await selectFontOption(page, font.name);
  const selected = await updateFont;
  assert(selected.ok(), 'Selecting local font did not update config.', { status: selected.status() });
  await page.waitForFunction(name => document.body.style.fontFamily.includes(name), font.name, { timeout: 10_000 });

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '偏好', exact: true }).click();
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

async function restoreRecycledCards(page, contents) {
  await page.goto(listUrl('trash').toString(), { waitUntil: 'networkidle' });
  for (const content of contents) {
    const card = noteCard(page, content);
    await invokeCardMenuAction(page, content, 'ArchivedItem');
    await card.waitFor({ state: 'hidden', timeout: 10_000 });
  }
}

async function verifyWorkspaceTokenGuide(page) {
  await page.goto(new URL('/settings', base).toString(), { waitUntil: 'networkidle' });
  const refreshToken = page.getByRole('button', { name: '刷新当前工作区令牌', exact: true });
  await refreshToken.waitFor({ state: 'visible', timeout: 10_000 });
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
  await page.goto(new URL('/settings', base).toString(), { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '存储', exact: true }).click();
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
  await page.getByRole('button', { name: '存储', exact: true }).click();
  await page.getByRole('button', { name: '本地文件系统', exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
}

async function verifyBackupExport(page) {
  await page.goto(new URL('/settings', base).toString(), { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '备份与恢复', exact: true }).click();
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
  await page.goto(new URL('/settings', base).toString(), { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '备份与恢复', exact: true }).click();
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
  await page.goto(new URL('/settings', base).toString(), { waitUntil: 'networkidle' });
  const initialLoad = waitForTrpcQuery(page, 'operationLogs.list');
  await page.getByRole('button', { name: '操作日志', exact: true }).click();
  const initialResponse = await initialLoad;
  assert(initialResponse.ok(), 'Operation log initial list request failed.', { status: initialResponse.status() });
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
  await createFolder(page, siblingFolder);
  await createFolder(page, siblingFolderWithPrefix);
  await deleteResource(page, siblingFolder);
  await page.getByText(siblingFolderWithPrefix, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await createFolder(page, disposableFolder);
  await deleteResource(page, disposableFolder);
  await deleteSelectedResources(page, disposableAttachmentNames);
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
  const attachmentName = `browser-ui-attachment-${stamp}.txt`;
  const renamedAttachmentName = `browser-ui-attachment-renamed-${stamp}.txt`;
  const disposableAttachmentNames = [
    `browser-ui-attachment-batch-a-${stamp}.txt`,
    `browser-ui-attachment-batch-b-${stamp}.txt`,
  ];

  await registerAndSignIn(page);
  await createAndSelectWorkspace(page, workspace);
  await createNote(page, '闪念', blinkora, '');
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
  await verifyTodoCompletion(page, updatedTodo);
  await verifyCardStateActions(page, updatedNote, updatedBlinkora);
  await verifyGlobalSearch(page, updatedBlinkora);
  const commentTree = await verifyCommentTree(page, updatedNote, comment);
  await verifyAttachmentFilter(page, updatedNote);
  await verifyLinkFilter(page, updatedNote);
  await verifyTagTreeFilter(page, tagParent, tagChild, updatedNote);
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
  await verifyMobile(browser, diagnostics);

  assert(diagnostics.length === 0, 'Browser diagnostics reported an error response or console error.', diagnostics);
  console.log('browser smoke passed: desktop/mobile login, daily review, workspace creation/switch/move, three note types, edit/history/tag-tree/attachment/reference, Todo complete/restore, pin/archive/recycle/restore, comment tree create/reply/edit/delete, date-range/attachment/link/Todo-content/without-tag filters with reset and reload retention where supported, operation-log content filtering, local-font selection/reload/reset, Blinkora/Note/Todo/all/archive/trash pagination page-two reload/delete retention/out-of-range reset, Workspace Agent token guide, S3 form protection, workspace Markdown export/import plus full JSON export/import, global search, resource attachment/folder rename/nesting/move/sibling-delete protection and multi-select delete; no console errors or local 4xx/5xx');
} finally {
  await desktop.close();
  await browser.close();
}
