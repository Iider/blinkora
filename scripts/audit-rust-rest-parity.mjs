const nodeRuntimeRoutes = [
  ['GET', '/health', 'server/index.ts'],
  ['POST', '/api/auth/login', 'server/routerExpress/auth/index.ts'],
  ['POST', '/api/auth/verify-2fa', 'server/routerExpress/auth/index.ts'],
  ['GET', '/api/auth/profile', 'server/routerExpress/auth/index.ts'],
  ['POST', '/api/auth/logout', 'server/routerExpress/auth/index.ts'],
  ['GET', '/api/auth/validate-token', 'server/routerExpress/auth/index.ts'],
  ['GET', '/api/file/*', 'server/routerExpress/file/file.ts'],
  ['POST', '/api/file/upload', 'server/routerExpress/file/upload.ts'],
  ['OPTIONS', '/api/file/upload', 'server/routerExpress/file/upload.ts'],
  ['POST', '/api/file/upload-by-url', 'server/routerExpress/file/upload-by-url.ts'],
  ['OPTIONS', '/api/file/upload-by-url', 'server/routerExpress/file/upload-by-url.ts'],
  ['POST', '/api/file/delete', 'server/routerExpress/file/delete.ts'],
  ['GET', '/api/s3file/*', 'server/routerExpress/file/s3file.ts'],
  ['POST', '/api/backup/import', 'server/routerExpress/backup.ts'],
  ['GET', '/sse', 'server/routerExpress/mcp.ts'],
  ['POST', '/messages', 'server/routerExpress/mcp.ts'],
];

const rustRuntimeRoutes = [
  ['GET', '/health', 'server-rust/src/main.rs'],
  ['HEAD', '/health', 'server-rust/src/main.rs'],
  ['POST', '/api/auth/login', 'server-rust/src/handlers/auth.rs'],
  ['POST', '/api/auth/register', 'server-rust/src/handlers/auth.rs'],
  ['POST', '/api/auth/verify-2fa', 'server-rust/src/handlers/auth.rs'],
  ['GET', '/api/auth/profile', 'server-rust/src/handlers/auth.rs'],
  ['POST', '/api/auth/logout', 'server-rust/src/handlers/auth.rs'],
  ['GET', '/api/auth/validate-token', 'server-rust/src/handlers/auth.rs'],
  ['GET', '/api/file/*', 'server-rust/src/handlers/files.rs'],
  ['POST', '/api/file/upload', 'server-rust/src/handlers/files.rs'],
  ['POST', '/api/file/upload-by-url', 'server-rust/src/handlers/files.rs'],
  ['POST', '/api/file/delete', 'server-rust/src/handlers/files.rs'],
  ['GET', '/api/s3file/*', 'server-rust/src/handlers/files.rs'],
  ['POST', '/api/backup/import', 'server-rust/src/handlers/backup.rs'],
  ['GET', '/sse', 'server-rust/src/main.rs'],
  ['POST', '/messages', 'server-rust/src/main.rs'],
  ['GET', '/api/sse', 'server-rust/src/handlers/mod.rs'],
  ['POST', '/api/messages', 'server-rust/src/handlers/mod.rs'],
  ['GET', '/api/trpc/*', 'server-rust/src/handlers/mod.rs'],
  ['POST', '/api/trpc/*', 'server-rust/src/handlers/mod.rs'],
  ['GET', '/trpc/*', 'server-rust/src/handlers/mod.rs'],
  ['POST', '/trpc/*', 'server-rust/src/handlers/mod.rs'],
];

const intentionallySkipped = [
  ['/api/openapi.json', 'OpenAPI document endpoint is documentation-only and depends on Node tRPC OpenAPI generation.'],
  ['/api-doc', 'Swagger UI is documentation-only and not part of the Rust runtime target.'],
  ['/dist/js/*', 'Vditor assets are covered by static-file smoke rather than Express route parity.'],
  ['/api/v1/*', 'OpenAPI REST aliases are generated from tRPC in Node; frontend runtime uses tRPC and Rust parity is tracked by audit:rust-trpc.'],
];

function key([method, path]) {
  return `${method} ${path}`;
}

const rustKeys = new Set(rustRuntimeRoutes.map(key));
const missingInRust = nodeRuntimeRoutes
  .filter(([method, path]) => {
    if (method === 'OPTIONS') return false;
    return !rustKeys.has(`${method} ${path}`);
  })
  .map(([method, path, source]) => ({ method, path, source }));

const extraInRust = rustRuntimeRoutes
  .filter((route) => !new Set(nodeRuntimeRoutes.map(key)).has(key(route)))
  .map(([method, path, source]) => ({ method, path, source }));

const result = {
  ok: missingInRust.length === 0,
  nodeRuntimeRouteCount: nodeRuntimeRoutes.length,
  rustRuntimeRouteCount: rustRuntimeRoutes.length,
  missingInRust,
  extraInRust,
  intentionallySkipped,
};

console.log(JSON.stringify(result, null, 2));

if (!result.ok) process.exit(1);
