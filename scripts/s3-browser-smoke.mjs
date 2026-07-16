#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { chromium } from 'playwright';

const requiredEnvironment = [
  'BLINKORA_BASE_URL',
  'BLINKORA_SMOKE_USER',
  'BLINKORA_SMOKE_PASSWORD',
  'BLINKORA_S3_SMOKE_ENDPOINT',
  'BLINKORA_S3_SMOKE_REGION',
  'BLINKORA_S3_SMOKE_BUCKET',
  'BLINKORA_S3_SMOKE_ACCESS_KEY',
  'BLINKORA_S3_SMOKE_SECRET_KEY',
  'BLINKORA_S3_BROWSER_CUSTOM_PATH',
];
const missingEnvironment = requiredEnvironment.filter(name => !process.env[name]?.trim());
if (missingEnvironment.length > 0) {
  console.error(`FAIL: smoke:s3-browser requires ${missingEnvironment.join(', ')}`);
  process.exit(1);
}

const base = new URL(process.env.BLINKORA_BASE_URL);
const browserExecutable = process.env.BLINKORA_BROWSER_EXECUTABLE
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const credentials = {
  endpoint: process.env.BLINKORA_S3_SMOKE_ENDPOINT.trim(),
  region: process.env.BLINKORA_S3_SMOKE_REGION.trim(),
  bucket: process.env.BLINKORA_S3_SMOKE_BUCKET.trim(),
  accessKeyId: process.env.BLINKORA_S3_SMOKE_ACCESS_KEY.trim(),
  accessKeySecret: process.env.BLINKORA_S3_SMOKE_SECRET_KEY.trim(),
};
const customPath = normalizeCustomPath(process.env.BLINKORA_S3_BROWSER_CUSTOM_PATH);
const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const noteContent = `S3 browser image lifecycle ${stamp}`;
const imageName = `s3-browser-${stamp}.png`;
const imageBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function fail(message, details) {
  console.error(`\nFAIL: ${message}`);
  if (details !== undefined) {
    console.error(typeof details === 'string' ? details : JSON.stringify(details, null, 2));
  }
  process.exitCode = 1;
  throw new Error(message);
}

function assert(condition, message, details) {
  if (!condition) fail(message, details);
}

function normalizeCustomPath(value) {
  const parts = String(value ?? '')
    .trim()
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean);
  assert(parts.length > 0, 'S3 browser smoke requires a non-empty isolated custom path.');
  assert(!parts.some(part => part === '.' || part === '..'),
    'S3 browser smoke custom path contains an invalid segment.');
  return `${parts.join('/')}/`;
}

function requireIsolatedTarget() {
  assert(process.env.BLINKORA_S3_BROWSER_SMOKE_ISOLATED === '1',
    'Set BLINKORA_S3_BROWSER_SMOKE_ISOLATED=1 only for a disposable acceptance instance.');
  assert(['127.0.0.1', 'localhost', '::1'].includes(base.hostname),
    'S3 browser smoke only accepts a loopback Blinkora target.');
  assert(base.port && base.port !== '6676',
    'S3 browser smoke refuses the persistent local service port.');
  assert(existsSync(browserExecutable), 'S3 browser smoke requires a local Chrome executable.');

  const pathSegments = customPath.split('/').filter(Boolean);
  assert(pathSegments.some(segment => segment.startsWith('smoke-')),
    'S3 browser smoke custom path must contain a generated smoke-* segment.');
  assert(pathSegments.at(-1)?.startsWith('browser-'),
    'S3 browser smoke custom path must end in a generated browser-* segment.');
  assert(!pathSegments.some(segment => ['blinkora', 'blinkora_local'].includes(segment.toLowerCase())),
    'S3 browser smoke refuses existing Blinkora data prefixes.');

  const apiCustomPath = process.env.BLINKORA_S3_SMOKE_CUSTOM_PATH
    ? normalizeCustomPath(process.env.BLINKORA_S3_SMOKE_CUSTOM_PATH)
    : '';
  assert(!apiCustomPath || apiCustomPath !== customPath,
    'S3 browser smoke must use a different child prefix from the API smoke.');
}

function createDiagnostics(page) {
  const failures = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      failures.push({
        phase: page.__s3SmokePhase,
        kind: 'console',
        message: message.text(),
        source: message.location().url,
      });
    }
  });
  page.on('pageerror', error => {
    failures.push({ phase: page.__s3SmokePhase, kind: 'pageerror', message: error.message });
  });
  page.on('requestfailed', request => {
    if (request.failure()?.errorText === 'net::ERR_ABORTED') return;
    const requestUrl = new URL(request.url());
    if (requestUrl.origin === base.origin) {
      failures.push({
        phase: page.__s3SmokePhase,
        kind: 'requestfailed',
        path: `${requestUrl.pathname}${requestUrl.search}`,
        message: request.failure()?.errorText,
      });
    }
  });
  page.on('response', response => {
    const responseUrl = new URL(response.url());
    if (responseUrl.origin === base.origin && response.status() >= 400) {
      failures.push({
        kind: 'http',
        status: response.status(),
        path: `${responseUrl.pathname}${responseUrl.search}`,
      });
    }
  });
  return failures;
}

function trpcProcedureIndex(response, procedure) {
  const pathname = new URL(response.url()).pathname;
  const prefix = '/api/trpc/';
  if (!pathname.startsWith(prefix)) return -1;
  return pathname.slice(prefix.length).split(',').indexOf(procedure);
}

function waitForTrpcMutation(page, procedure, timeout = 15_000) {
  return page.waitForResponse(
    response => response.request().method() === 'POST'
      && trpcProcedureIndex(response, procedure) >= 0,
    { timeout },
  );
}

async function trpcResponseJson(response, procedure) {
  const payload = await response.json();
  const procedureIndex = trpcProcedureIndex(response, procedure);
  const result = Array.isArray(payload) ? payload[procedureIndex] : payload;
  return result?.result?.data?.json;
}

function trpcRequestJsonInput(response, procedure) {
  const body = JSON.parse(response.request().postData() || '{}');
  if (body?.json !== undefined) return body.json;
  const values = Array.isArray(body) ? body : Object.values(body || {});
  const procedureIndex = trpcProcedureIndex(response, procedure);
  return values[procedureIndex]?.json;
}

async function signIn(page) {
  await page.goto(new URL('/signin', base).toString(), { waitUntil: 'networkidle' });
  await page.locator('input[type="text"]').fill(process.env.BLINKORA_SMOKE_USER);
  await page.locator('input[name="password"]').fill(process.env.BLINKORA_SMOKE_PASSWORD);
  await Promise.all([
    page.waitForURL(new URL('/', base).toString(), { timeout: 10_000 }),
    page.locator('form button').filter({ hasText: '登录' }).click(),
  ]);
  await waitForApp(page);
}

async function waitForApp(page) {
  await page.locator('#global-editor').waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('#vditor-create .vditor-ir [contenteditable="true"]')
    .waitFor({ state: 'visible', timeout: 15_000 });
}

async function openStorageSettings(page) {
  await page.goto(new URL('/settings', base).toString(), { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '存储', exact: true }).click();
}

async function chooseObjectStorage(page, currentLabel, targetKey) {
  const current = page.getByRole('button', { name: currentLabel, exact: true });
  await current.waitFor({ state: 'visible', timeout: 10_000 });
  await current.click();
  const option = page.locator(`[data-key="${targetKey}"]`).last();
  await option.waitFor({ state: 'visible', timeout: 10_000 });
  await option.focus();
  await page.keyboard.press('Enter');
}

async function fillS3Form(page, config) {
  const fields = [
    ['s3Endpoint', config.endpoint],
    ['s3AccessKeyId', config.accessKeyId],
    ['s3AccessKeySecret', config.accessKeySecret],
    ['s3Bucket', config.bucket],
    ['s3Region', config.region],
    ['s3CustomPath', config.customPath],
  ];
  for (const [name, value] of fields) {
    await page.locator(`input[name="${name}"]`).fill(value);
  }
}

async function validateS3(page, expectedOk) {
  const requested = waitForTrpcMutation(page, 'config.saveAndValidateS3', 60_000);
  await page.getByRole('button', { name: '保存并验证', exact: true }).click();
  const response = await requested;
  assert(response.ok(), 'S3 form validation request failed at the HTTP layer.', {
    status: response.status(),
  });
  const result = await trpcResponseJson(response, 'config.saveAndValidateS3');
  assert(result?.ok === expectedOk, 'S3 form returned an unexpected validation result.', {
    ok: result?.ok,
    objectStorage: result?.objectStorage,
  });
  return result;
}

async function verifyS3ConfigurationFlow(page) {
  await openStorageSettings(page);
  await chooseObjectStorage(page, '本地文件系统', 's3');

  const invalidConfig = {
    ...credentials,
    endpoint: 'http://[::1',
    customPath,
  };
  await fillS3Form(page, invalidConfig);
  const invalidResult = await validateS3(page, false);
  assert(invalidResult?.objectStorage === 'local',
    'Failed S3 validation did not keep actual storage local.');
  await page.getByText(/S3 配置验证失败，当前仍使用本地存储/)
    .waitFor({ state: 'visible', timeout: 10_000 });

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '存储', exact: true }).click();
  await chooseObjectStorage(page, '本地文件系统', 's3');
  const retainedValues = await Promise.all([
    page.locator('input[name="s3Endpoint"]').inputValue(),
    page.locator('input[name="s3AccessKeyId"]').inputValue(),
    page.locator('input[name="s3AccessKeySecret"]').inputValue(),
    page.locator('input[name="s3Bucket"]').inputValue(),
    page.locator('input[name="s3Region"]').inputValue(),
    page.locator('input[name="s3CustomPath"]').inputValue(),
  ]);
  const expectedRetainedValues = [
    invalidConfig.endpoint,
    invalidConfig.accessKeyId,
    invalidConfig.accessKeySecret,
    invalidConfig.bucket,
    invalidConfig.region,
    invalidConfig.customPath,
  ];
  assert(isDeepStrictEqual(retainedValues, expectedRetainedValues),
    'Failed S3 validation did not retain the form for correction.', {
      matchingFields: retainedValues.map((value, index) => value === expectedRetainedValues[index]),
    });

  await fillS3Form(page, { ...credentials, customPath });
  const validResult = await validateS3(page, true);
  assert(
    validResult?.objectStorage === 's3'
      && validResult?.normalizedCustomPath === customPath,
    'Valid S3 form did not activate the isolated custom path.',
    {
      objectStorage: validResult?.objectStorage,
      normalizedCustomPath: validResult?.normalizedCustomPath,
    },
  );
  await page.getByText('S3 配置验证通过，已启用对象存储', { exact: true })
    .waitFor({ state: 'visible', timeout: 10_000 });

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '存储', exact: true }).click();
  await page.getByRole('button', { name: 'S3', exact: true })
    .waitFor({ state: 'visible', timeout: 10_000 });
}

async function selectNoteType(page, targetType) {
  const labels = ['闪念', '笔记', '待办'];
  await page.waitForFunction(typeLabels => typeLabels.some(label => {
    const button = document.querySelector(`#global-editor button[aria-label="${label}"]`);
    return button instanceof HTMLElement && button.offsetParent !== null;
  }), labels, { timeout: 10_000 });
  const selector = labels.map(label => `#global-editor button[aria-label="${label}"]`).join(', ');
  const currentType = await page.locator(selector).evaluateAll(buttons => (
    buttons.find(button => button instanceof HTMLElement && button.offsetParent !== null)
      ?.getAttribute('aria-label') ?? null
  ));
  assert(labels.includes(currentType), 'Global editor did not expose its selected note type.');
  if (currentType !== targetType) {
    await page.locator(`#global-editor button[aria-label="${currentType}"]`).click();
    await page.locator('[data-note-type-picker-content] button').filter({ hasText: targetType }).click();
    await page.locator(`#global-editor button[aria-label="${targetType}"]`)
      .waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(600);
  }
}

async function createImageNote(page) {
  await page.goto(new URL('/?path=notes', base).toString(), { waitUntil: 'networkidle' });
  await waitForApp(page);
  await selectNoteType(page, '笔记');

  const editor = page.locator('#vditor-create .vditor-ir [contenteditable="true"]:visible');
  await editor.click();
  await page.keyboard.insertText(noteContent);

  const imageRead = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.origin === base.origin
      && url.pathname.startsWith(`/api/s3file/${customPath}`)
      && response.request().method() === 'GET';
  }, { timeout: 30_000 });
  const uploaded = page.waitForResponse(response => (
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/file/upload'
  ), { timeout: 60_000 });
  await page.locator('#global-editor input[type="file"]').first().setInputFiles({
    name: imageName,
    mimeType: 'image/png',
    buffer: imageBytes,
  });
  const uploadResponse = await uploaded;
  assert(uploadResponse.ok(), 'S3 image upload failed.', { status: uploadResponse.status() });
  const upload = await uploadResponse.json();
  assert(
    upload?.path?.startsWith(`/api/s3file/${customPath}`)
      && upload?.filePath === upload.path
      && upload?.type === 'image/png',
    'S3 image upload returned an incompatible attachment object.',
    { path: upload?.path, filePath: upload?.filePath, type: upload?.type },
  );
  const imageResponse = await imageRead;
  assert(imageResponse.status() === 200, 'S3 image preview request failed.', {
    status: imageResponse.status(),
  });
  await imageResponse.finished();
  const editorPreview = page.locator('#global-editor .attachment-container img').first();
  if (await editorPreview.count()) {
    await waitForImageReady(editorPreview, 'S3 image editor preview');
  }

  const saved = waitForTrpcMutation(page, 'notes.upsert');
  await page.locator('#global-editor div[class*="w-[60px]"]').click();
  const saveResponse = await saved;
  assert(saveResponse.ok(), 'Saving the S3 image Note failed.', { status: saveResponse.status() });
  const note = await trpcResponseJson(saveResponse, 'notes.upsert');
  assert(
    Number.isInteger(note?.id)
      && note?.attachments?.some(attachment => attachment.path === upload.path),
    'Saved Note did not retain its S3 image attachment.',
    { noteId: note?.id, attachmentCount: note?.attachments?.length },
  );

  const card = page.locator('.blinkora-flip-card').filter({ hasText: noteContent });
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  const preview = card.locator('img').first();
  await waitForImageReady(preview, 'S3 image card preview');
  assert(!(await preview.getAttribute('src'))?.includes('image-fallback.svg'),
    'S3 image card rendered the fallback image.');
  return { note, upload };
}

async function waitForImageReady(image, description) {
  await image.waitFor({ state: 'visible', timeout: 10_000 });
  await image.evaluate(async element => {
    if (!(element instanceof HTMLImageElement)) return;
    if (!element.complete || element.naturalWidth === 0) {
      await element.decode();
    }
  });
  assert(await image.evaluate(element => (
    element instanceof HTMLImageElement
      && element.complete
      && element.naturalWidth > 0
      && element.naturalHeight > 0
  )), `${description} did not finish decoding.`);
}

async function browserAuthHeaders(page) {
  const auth = await page.evaluate(() => {
    const storedToken = window.localStorage.getItem('blinkoraToken');
    const storedWorkspaceId = window.localStorage.getItem('blinkoraCurrentWorkspaceId');
    return {
      token: storedToken ? JSON.parse(storedToken)?.token ?? '' : '',
      workspaceId: storedWorkspaceId ? JSON.parse(storedWorkspaceId) : null,
    };
  });
  assert(auth.token, 'Browser session did not expose its account token.');
  return {
    Authorization: `Bearer ${auth.token}`,
    ...(auth.workspaceId ? { 'x-workspace-id': String(auth.workspaceId) } : {}),
  };
}

async function verifyUploadedBytes(page, path) {
  const response = await page.request.get(new URL(path, base).toString(), {
    headers: await browserAuthHeaders(page),
    failOnStatusCode: false,
  });
  assert(response.status() === 200, 'Authenticated S3 image read failed.', {
    status: response.status(),
  });
  assert(isDeepStrictEqual(await response.body(), imageBytes),
    'Authenticated S3 image bytes changed after upload.');
}

function noteCard(page) {
  return page.locator('.blinkora-flip-card').filter({ hasText: noteContent });
}

async function deleteImageFromEditor(page, upload) {
  const card = noteCard(page);
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await card.click({ position: { x: 200, y: 80 } });
  const edit = page.getByRole('button', { name: '编辑', exact: true });
  await edit.waitFor({ state: 'visible', timeout: 10_000 });
  await edit.click();

  const editor = page.locator('#vditor-edit');
  await editor.waitFor({ state: 'visible', timeout: 10_000 });
  const attachment = editor.locator(
    'xpath=following-sibling::div[contains(concat(" ", normalize-space(@class), " "), " attachment-container ")]',
  );
  const deleteRequests = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/file/delete') {
      deleteRequests.push(request.url());
    }
  });
  const deleteIcon = attachment.getByRole('button', { name: '删除', exact: true });
  await deleteIcon.waitFor({ state: 'visible', timeout: 10_000 });
  await deleteIcon.click();
  const confirmation = page.getByText('该操作将删除资源，你确定吗？', { exact: true });
  await confirmation.waitFor({ state: 'visible', timeout: 10_000 });
  const confirmationPanel = confirmation.locator(
    'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " px-1 ")][1]',
  );
  await confirmationPanel.getByRole('button', { name: '确认', exact: true }).click();
  await attachment.waitFor({ state: 'hidden', timeout: 10_000 });
  assert(deleteRequests.length === 0,
    'Editor attachment removal called the standalone delete endpoint before Note save.',
    deleteRequests);

  const saved = waitForTrpcMutation(page, 'notes.upsert', 60_000);
  const sendButtons = page.locator('div[class*="w-[60px]"]');
  await sendButtons.last().click();
  const saveResponse = await saved;
  assert(saveResponse.ok(), 'Saving the Note with its S3 image removed failed.', {
    status: saveResponse.status(),
  });
  const saveInput = trpcRequestJsonInput(saveResponse, 'notes.upsert');
  assert(
    saveInput?.deletedAttachmentPaths?.length === 1
      && saveInput.deletedAttachmentPaths[0] === upload.path
      && Array.isArray(saveInput.attachments)
      && saveInput.attachments.length === 0,
    'Editor did not submit the S3 deletion as part of the Note transaction.',
    saveInput,
  );
  const updatedNote = await trpcResponseJson(saveResponse, 'notes.upsert');
  assert(updatedNote?.attachments?.length === 0,
    'Saved Note still returned the deleted S3 attachment.', updatedNote?.attachments);

  const resource = await page.request.get(new URL(upload.path, base).toString(), {
    headers: await browserAuthHeaders(page),
    failOnStatusCode: false,
  });
  assert(resource.status() === 404, 'Transactionally deleted S3 image remained readable.', {
    status: resource.status(),
  });
}

async function switchBackToLocal(page) {
  await openStorageSettings(page);
  const updated = waitForTrpcMutation(page, 'config.update');
  await chooseObjectStorage(page, 'S3', 'local');
  const response = await updated;
  assert(response.ok(), 'Switching object storage back to local failed.', {
    status: response.status(),
  });
  const input = trpcRequestJsonInput(response, 'config.update');
  assert(input?.key === 'objectStorage' && input?.value === 'local',
    'Storage dropdown submitted an unexpected local fallback payload.');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '存储', exact: true }).click();
  await page.getByRole('button', { name: '本地文件系统', exact: true })
    .waitFor({ state: 'visible', timeout: 10_000 });
}

async function bestEffortCleanup(page, uploadedPath) {
  try {
    const headers = await browserAuthHeaders(page);
    if (uploadedPath) {
      await page.request.post(new URL('/api/file/delete', base).toString(), {
        headers: { ...headers, 'content-type': 'application/json' },
        data: { attachment_path: uploadedPath },
        failOnStatusCode: false,
      });
    }
    await page.request.post(new URL('/api/trpc/config.update', base).toString(), {
      headers: { ...headers, 'content-type': 'application/json' },
      data: { json: { key: 'objectStorage', value: 'local' } },
      failOnStatusCode: false,
    });
  } catch {
    // The disposable local harness removes its database. Known uploaded paths
    // are the only remote objects this cleanup ever targets.
  }
}

requireIsolatedTarget();
const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: 'zh-CN',
});
const page = await context.newPage();
const diagnostics = createDiagnostics(page);
let uploadedPath = '';
let completed = false;

try {
  page.__s3SmokePhase = 'sign-in';
  await signIn(page);
  page.__s3SmokePhase = 'settings-validation';
  await verifyS3ConfigurationFlow(page);
  page.__s3SmokePhase = 'image-create';
  const fixture = await createImageNote(page);
  uploadedPath = fixture.upload.path;
  page.__s3SmokePhase = 'image-read';
  await verifyUploadedBytes(page, uploadedPath);
  page.__s3SmokePhase = 'image-editor-delete';
  await deleteImageFromEditor(page, fixture.upload);
  page.__s3SmokePhase = 'local-restore';
  await switchBackToLocal(page);
  assert(diagnostics.length === 0,
    'S3 browser smoke observed console, page, or unexpected local HTTP errors.', diagnostics);
  completed = true;
  console.log('S3 browser smoke passed: settings validation/fallback, isolated PNG upload and preview, byte-identical read, transactional editor deletion, and local-storage restore');
} finally {
  if (!completed) {
    await bestEffortCleanup(page, uploadedPath);
  }
  await context.close();
  await browser.close();
}
