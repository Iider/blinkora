import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function read(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function getNodeRouters() {
  const app = read('server/routerTrpc/_app.ts');
  const importMatches = [...app.matchAll(/import\s+\{\s*(\w+)\s*\}\s+from\s+['"]\.\/([^'"]+)['"]/g)];
  const routerFileByVariable = new Map(importMatches.map(([, variable, path]) => [variable, `server/routerTrpc/${path}.ts`]));
  const appRouterMatch = app.match(/export const appRouter = router\(\{([\s\S]*?)\n\}\);/);
  if (!appRouterMatch) throw new Error('Could not find appRouter definition');
  return [...appRouterMatch[1].matchAll(/^\s*(\w+):\s*(\w+),?\s*$/gm)].map(([, prefix, variable]) => {
    const file = routerFileByVariable.get(variable);
    if (!file) throw new Error(`Could not resolve router file for variable: ${variable}`);
    return { prefix, file };
  });
}

function getNodeProcedures() {
  const procedures = new Set();

  for (const { prefix, file } of getNodeRouters()) {
    const source = read(file);
    for (const [, key] of source.matchAll(/^  ([A-Za-z_$][\w$]*):\s*(?:authProcedure|publicProcedure)(?:\.use\([^)]*\))?\b/gm)) {
      procedures.add(`${prefix}.${key}`);
    }
  }

  return [...procedures].sort();
}

function getRustProcedures() {
  const rustFiles = [
    'server-rust/src/handlers/auth.rs',
    'server-rust/src/handlers/attachments.rs',
    'server-rust/src/handlers/backup.rs',
    'server-rust/src/handlers/comments.rs',
    'server-rust/src/handlers/config.rs',
    'server-rust/src/handlers/fonts.rs',
    'server-rust/src/handlers/notes.rs',
    'server-rust/src/handlers/public.rs',
    'server-rust/src/handlers/tags.rs',
    'server-rust/src/handlers/workspaces.rs',
  ];
  const procedures = new Set();

  for (const file of rustFiles) {
    const source = read(file);
    for (const [, procedure] of source.matchAll(/registry\.insert\(\s*"([^"]+)"/g)) {
      procedures.add(procedure);
    }
  }

  return [...procedures].sort();
}

const nodeProcedures = getNodeProcedures();
const rustProcedures = getRustProcedures();
const rustSet = new Set(rustProcedures);
const nodeSet = new Set(nodeProcedures);

const missingInRust = nodeProcedures.filter((procedure) => !rustSet.has(procedure));
const extraInRust = rustProcedures.filter((procedure) => !nodeSet.has(procedure));

const result = {
  ok: missingInRust.length === 0,
  nodeCount: nodeProcedures.length,
  rustCount: rustProcedures.length,
  missingInRust,
  extraInRust,
};

console.log(JSON.stringify(result, null, 2));

if (!result.ok) process.exit(1);
