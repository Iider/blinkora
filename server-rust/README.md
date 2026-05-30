# Blinkora Rust Backend

Primary Rust backend for Blinkora. It lives in `server-rust/`; the TS/Node backend remains as a temporary behavior reference, and the retired Go stack is archived at `docker/backups/` local ignored archive.

Target shape:

- One Rust binary serves REST APIs, tRPC-compatible endpoints, file APIs, health checks, and React/Vite static assets.
- Runtime Docker image contains Debian slim, the Rust binary, SQL migrations, and prebuilt frontend static files only.
- The frontend remains unchanged and continues to call the existing `/api/trpc/*` surface.

Local development:

```bash
bun run dev:rust
```

The root `dev:rust` script defaults to `http://127.0.0.1:6677`, the Rust Docker PostgreSQL on `localhost:55433`, `dist/public` for static assets, and `docker/data/blinkora-rust` for local files. `bun run dev:frontend` serves Vite at `http://localhost:5173` and proxies API requests to the Rust dev backend. Override `DATABASE_URL`, `PUBLIC_PATH`, `DATA_DIR`, `PORT`, `BLINKORA_DEV_FRONTEND_PORT`, or `BLINKORA_DEV_BACKEND_URL` when needed.

Build flow:

```bash
bun run build:rust-release
docker compose -f docker/docker-compose.rust.yml build web
docker compose -f docker/docker-compose.rust.yml up -d
```

The default Docker runtime image does not include Node, Bun, npm, cargo, Go, or a Rust compiler. `docker/dockerfile.rust` copies the prebuilt Linux binary from `release/rust/blinkora-rust`, plus static frontend assets from `release/rust/public`.

If the local machine cannot cross-compile the Linux binary, `bun run build:rust-release` can fall back to a Docker binary builder by setting `BLINKORA_RUST_DOCKER_BUILD=1`. A full Docker compile path is still available for debugging through `docker/dockerfile.rust.fullbuild`, but it is not the default deployment path.

For domestic low-complexity deployment, treat `release/rust` as the handoff artifact. The deployment server should only build the runtime image from `docker/dockerfile.rust` and start `docker/docker-compose.rust.yml`; it should not run `bun install`, `npm install`, `cargo build`, or frontend bundling. If `release/rust/blinkora-rust` or `release/rust/public` is missing, rebuild the release on a build machine or CI before deploying.

On startup, the Rust backend applies SQL files from `MIGRATIONS_DIR` to an empty database and records them in `_prisma_migrations`. The Docker image copies `prisma/migrations` to `/app/prisma/migrations`.

Backup import/export currently follows the Blinkora “restore as a new workspace” rule. The Rust backend restores workspace data, notes, attachment records, and local attachment files from backup zip files without replacing or merging existing workspaces.

Smoke test with an explicit local test account:

```bash
BLINKORA_BASE_URL=http://127.0.0.1:6676 \
BLINKORA_SMOKE_USER=<test-user> \
BLINKORA_SMOKE_PASSWORD=<test-password> \
bun run smoke:rust
```

The smoke script covers health checks, static asset fallback rules, auth, REST auth profile / validate-token / logout, tRPC `users.login`, user detail, public server version and link preview APIs, font list/create/get/update/upload/data/delete, workspace list/create/update/set-default/get-default/delete, config, `config.ai` model/provider shape, notes, tags, comments/private annotations, resource attachment folder create/list/rename/move/delete flows, file upload/upload-by-url/read/delete, wrong-workspace file permission rejection, sibling folder prefix safety, markdown export, backup import, restored attachment path/content verification, recycle-bin flows, batch note operations, local keyword fallback for `notes.list` AI-query mode, token/relevance ordering for AI-query fallback, archived/recycled exclusion in AI-query mode, vector metadata fields for note filters and workspace boundaries, `task.rebuildEmbedding` / `task.embeddingProgress` index status paths, local `_blinkora_rust_vectors` score-based AI-query recall, optional mock OpenAI-compatible provider dense-vector recall including a no-keyword-match vector-only assertion, and the MCP SSE main path for `searchBlinkora`, `upsertBlinkora`, `updateBlinkora`, and `deleteBlinkora`.

The Rust RAG path stores vectors in `_blinkora_rust_vectors`. Without a configured embedding model it uses a deterministic local sparse vector fallback. With `embeddingModelId` configured, it reads `aiModels` and `aiProviders` and supports OpenAI-compatible/custom, Azure/AzureOpenAI, VoyageAI, and Ollama embedding request/response shapes. Provider protocol handling is covered by Rust unit tests, and `BLINKORA_MOCK_EMBEDDING_SMOKE=1 bun run smoke:rust` verifies the OpenAI-compatible dense-vector path through the Docker runtime. Real third-party provider credentials still need separate deployment-environment verification.

Optional real embedding provider smoke with an explicit local test account:

```bash
BLINKORA_BASE_URL=http://127.0.0.1:6676 \
BLINKORA_SMOKE_USER=<test-user> \
BLINKORA_SMOKE_PASSWORD=<test-password> \
BLINKORA_REAL_EMBEDDING_SMOKE=1 \
BLINKORA_REAL_EMBEDDING_PROVIDER=custom \
BLINKORA_REAL_EMBEDDING_BASE_URL=https://api.openai.com/v1 \
BLINKORA_REAL_EMBEDDING_API_KEY=replace-with-real-key \
BLINKORA_REAL_EMBEDDING_MODEL_KEY=text-embedding-3-small \
bun run smoke:rust
```

Use `BLINKORA_REAL_EMBEDDING_PROVIDER=azure`, `azureopenai`, `voyageai`, or `ollama` to target those protocol paths. Azure can also set `BLINKORA_REAL_EMBEDDING_API_VERSION`. Ollama can omit `BLINKORA_REAL_EMBEDDING_API_KEY` when the endpoint does not require it.
When `BLINKORA_REAL_EMBEDDING_SMOKE=1` is enabled, the smoke script requires `BLINKORA_REAL_EMBEDDING_BASE_URL` and `BLINKORA_REAL_EMBEDDING_MODEL_KEY`. It also requires `BLINKORA_REAL_EMBEDDING_API_KEY` for providers other than Ollama.

For CI/local verification of the real-provider configuration branch without external credentials, use `BLINKORA_REAL_EMBEDDING_USE_LOCAL_MOCK=1` together with `BLINKORA_REAL_EMBEDDING_SMOKE=1`. This still writes a real `aiProviders` / `aiModels` / `embeddingModelId` configuration into the database, but points it at the script-managed OpenAI-compatible mock endpoint.

Latest local acceptance snapshot:

- `node --check scripts/rust-smoke.mjs`: passed.
- `bun run verify:rust`: passed.
- `bun run audit:rust-trpc`: passed with `missingInRust=[]`.
- `bun run audit:rust-rest`: passed with `missingInRust=[]`.
- `cargo test --manifest-path server-rust/Cargo.toml`: passed, 6 tests.
- `bun run smoke:rust` with MinIO S3 and `BLINKORA_MOCK_EMBEDDING_SMOKE=1`: passed with `ok=true`, `noteId=43`, `todoId=49`, `importedWorkspaceId=7`, `mockEmbeddingSmoke.requestCount=27`, and `mockEmbeddingSmoke.vectorKinds=["dense"]`.
- `bun run smoke:rust` with MinIO S3, `BLINKORA_REAL_EMBEDDING_SMOKE=1`, and `BLINKORA_REAL_EMBEDDING_USE_LOCAL_MOCK=1`: passed with `ok=true`, `noteId=71`, `todoId=77`, `importedWorkspaceId=9`, `realEmbeddingSmoke.localMock=true`, `realEmbeddingSmoke.requestCount=34`, and `realEmbeddingSmoke.vectorKinds=["dense"]`.
- The smoke script supports real third-party providers through `BLINKORA_REAL_EMBEDDING_SMOKE=1`; external credentials are still verified only when supplied.

Known remaining gaps:

- The Rust backend is the primary runtime stack.
- `bun run audit:rust-trpc` reports no missing Rust procedures.
- Real third-party embedding credentials have not yet been verified; protocol unit tests, mock OpenAI-compatible dense-vector Docker smoke, and the real-provider configuration branch with a local mock endpoint are complete.
- Current release-runtime checks confirm the running container has no `node`, `bun`, `npm`, or `cargo`; Docker deployment should continue to use prebuilt `release/rust` artifacts.

Optional S3 smoke uses the `s3-smoke` Docker Compose profile, MinIO, and an explicit local test account:

```bash
NEXTAUTH_SECRET=replace-with-a-secure-random-secret \
docker compose -f docker/docker-compose.rust.yml --profile s3-smoke up -d

BLINKORA_BASE_URL=http://127.0.0.1:6676 \
BLINKORA_SMOKE_USER=<test-user> \
BLINKORA_SMOKE_PASSWORD=<test-password> \
BLINKORA_S3_SMOKE_ENDPOINT=http://minio:9000 \
BLINKORA_S3_SMOKE_BUCKET=blinkora-rust-smoke \
BLINKORA_S3_SMOKE_ACCESS_KEY=blinkora \
BLINKORA_S3_SMOKE_SECRET_KEY=blinkora-rust-s3-secret \
BLINKORA_S3_SMOKE_REGION=us-east-1 \
bun run smoke:rust
```

When the S3 variables are present, the smoke script validates real S3 config save, upload to `/api/s3file/*`, authenticated read, resource move/rename path handling, delete, and local-storage fallback reset.
