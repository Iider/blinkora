#!/usr/bin/env node

const required = [
  'BLINKORA_BASE_URL',
  'BLINKORA_SMOKE_USER',
  'BLINKORA_SMOKE_PASSWORD',
  'BLINKORA_S3_SMOKE_ENDPOINT',
  'BLINKORA_S3_SMOKE_REGION',
  'BLINKORA_S3_SMOKE_BUCKET',
  'BLINKORA_S3_SMOKE_ACCESS_KEY',
  'BLINKORA_S3_SMOKE_SECRET_KEY',
];

const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  console.error(`FAIL: smoke:s3 requires ${missing.join(', ')}`);
  process.exit(1);
}

if (process.env.BLINKORA_S3_SMOKE_ISOLATED !== '1') {
  console.error('FAIL: set BLINKORA_S3_SMOKE_ISOLATED=1 after pointing at an isolated acceptance instance');
  process.exit(1);
}

await import('./rust-smoke.mjs');
