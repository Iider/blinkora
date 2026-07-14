#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const unitFile = new URL('../deploy/fnas/blinkora.service', import.meta.url);
const expected = new Map([
  ['Unit', new Map([
    ['Description', 'Blinkora SQLite Web service'],
    ['After', 'network-online.target'],
    ['Wants', 'network-online.target'],
  ])],
  ['Service', new Map([
    ['Type', 'simple'],
    ['User', 'blinkora'],
    ['Group', 'blinkora'],
    ['WorkingDirectory', '/vol1/1000/docker/blinkora/local'],
    ['EnvironmentFile', '/vol1/1000/docker/blinkora/local/blinkora.env'],
    ['ExecStart', '/vol1/1000/docker/blinkora/local/bin/blinkora-server'],
    ['Restart', 'on-failure'],
    ['RestartSec', '3'],
    ['NoNewPrivileges', 'true'],
    ['PrivateTmp', 'true'],
  ])],
  ['Install', new Map([['WantedBy', 'multi-user.target']])],
]);

const parsed = new Map([...expected.keys()].map((section) => [section, new Map()]));
let section = '';

for (const [index, rawLine] of readFileSync(unitFile, 'utf8').split(/\r?\n/).entries()) {
  const line = rawLine.trim();
  if (!line || line.startsWith('#') || line.startsWith(';')) continue;
  const header = line.match(/^\[([^\]]+)\]$/);
  if (header) {
    section = header[1];
    if (!parsed.has(section)) fail(`line ${index + 1}: unsupported section [${section}]`);
    continue;
  }
  const assignment = line.match(/^([^=\s]+)=(.*)$/);
  if (!assignment || !section) fail(`line ${index + 1}: expected a section or key=value assignment`);
  const [, key, value] = assignment;
  const values = parsed.get(section);
  if (!expected.get(section).has(key)) fail(`line ${index + 1}: unsupported key ${section}.${key}`);
  if (values.has(key)) fail(`line ${index + 1}: duplicate key ${section}.${key}`);
  values.set(key, value);
}

for (const [sectionName, keys] of expected) {
  for (const [key, value] of keys) {
    const actual = parsed.get(sectionName).get(key);
    if (actual !== value) fail(`${sectionName}.${key} must be ${JSON.stringify(value)}`);
  }
}

console.log('FNAS systemd unit template is valid');

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}
