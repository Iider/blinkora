-- Blinkora runtime schema for SQLite.
--
-- Timestamp values are stored as UTC text so SQLx continues to expose the
-- same ISO-8601 JSON values as the previous database implementation. JSON is
-- stored as validated JSON text and BLOBs remain binary. Keep the quoted
-- camelCase names: they are part of the API-to-database compatibility layer.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  nickname TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  "apiToken" TEXT NOT NULL DEFAULT '',
  note INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT '',
  "createdAt" TEXT NOT NULL DEFAULT (blinkora_now()),
  "updatedAt" TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '默认工作区',
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  "accountId" INTEGER NOT NULL REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE CASCADE,
  "isDefault" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TEXT NOT NULL DEFAULT (blinkora_now()),
  "updatedAt" TEXT NOT NULL DEFAULT (blinkora_now())
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL DEFAULT '',
  "isArchived" INTEGER NOT NULL DEFAULT 0,
  "isRecycle" INTEGER NOT NULL DEFAULT 0,
  "isTop" INTEGER NOT NULL DEFAULT 0,
  metadata TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
  "createdAt" TEXT NOT NULL DEFAULT (blinkora_now()),
  "updatedAt" TEXT NOT NULL,
  "isReviewed" INTEGER NOT NULL DEFAULT 0,
  "accountId" INTEGER REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE SET NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "workspaceId" INTEGER REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS tag (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  parent INTEGER NOT NULL DEFAULT 0,
  "createdAt" TEXT NOT NULL DEFAULT (blinkora_now()),
  "updatedAt" TEXT NOT NULL,
  "accountId" INTEGER REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE SET NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "workspaceId" INTEGER REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "tagsToNote" (
  -- The previous schema exposed a sequence-backed id even though the composite key is
  -- authoritative. SQLite cannot auto-increment a non-primary-key column, so
  -- the trigger below assigns the same monotonic internal id after insertion.
  id INTEGER NOT NULL DEFAULT 0,
  "noteId" INTEGER NOT NULL DEFAULT 0 REFERENCES notes(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  "tagId" INTEGER NOT NULL DEFAULT 0 REFERENCES tag(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  PRIMARY KEY ("noteId", "tagId")
);

CREATE TRIGGER IF NOT EXISTS "tagsToNote_assign_id"
AFTER INSERT ON "tagsToNote"
FOR EACH ROW WHEN NEW.id = 0
BEGIN
  UPDATE "tagsToNote"
  SET id = (SELECT COALESCE(MAX(id), 0) + 1 FROM "tagsToNote")
  WHERE rowid = NEW.rowid;
END;

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  size TEXT NOT NULL DEFAULT '0',
  "noteId" INTEGER REFERENCES notes(id) ON UPDATE CASCADE ON DELETE SET NULL,
  "createdAt" TEXT NOT NULL DEFAULT (blinkora_now()),
  "updatedAt" TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  depth INTEGER,
  "perfixPath" TEXT DEFAULT '',
  "accountId" INTEGER REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE SET NULL,
  metadata TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
  "workspaceId" INTEGER REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "noteHistory" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  "noteId" INTEGER NOT NULL REFERENCES notes(id) ON UPDATE CASCADE ON DELETE CASCADE,
  content TEXT NOT NULL,
  metadata TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
  version INTEGER NOT NULL,
  "accountId" INTEGER,
  "createdAt" TEXT NOT NULL DEFAULT (blinkora_now()),
  "workspaceId" INTEGER REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "noteReference" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  "fromNoteId" INTEGER NOT NULL REFERENCES notes(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  "toNoteId" INTEGER NOT NULL REFERENCES notes(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  "createdAt" TEXT NOT NULL DEFAULT (blinkora_now()),
  UNIQUE ("fromNoteId", "toNoteId")
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  "accountId" INTEGER REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE SET NULL,
  "noteId" INTEGER NOT NULL REFERENCES notes(id) ON UPDATE CASCADE ON DELETE CASCADE,
  "parentId" INTEGER REFERENCES comments(id) ON UPDATE CASCADE ON DELETE CASCADE,
  "createdAt" TEXT NOT NULL DEFAULT (blinkora_now()),
  "updatedAt" TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'annotation',
  status TEXT NOT NULL DEFAULT 'open',
  metadata TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
  "workspaceId" INTEGER REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL DEFAULT '',
  config TEXT CHECK (config IS NULL OR json_valid(config)),
  "userId" INTEGER REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE SET NULL,
  "workspaceId" INTEGER REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS fonts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  "displayName" TEXT NOT NULL,
  url TEXT,
  "fileData" BLOB,
  "isLocal" INTEGER NOT NULL DEFAULT 0,
  "isSystem" INTEGER NOT NULL DEFAULT 0,
  weights TEXT NOT NULL CHECK (json_valid(weights)),
  category TEXT NOT NULL DEFAULT 'sans-serif',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TEXT NOT NULL DEFAULT (blinkora_now()),
  "updatedAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "agentAccessTokens" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  "tokenHash" TEXT NOT NULL UNIQUE,
  token TEXT,
  "accountId" INTEGER NOT NULL REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE CASCADE,
  "workspaceId" INTEGER NOT NULL REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE,
  permissions TEXT NOT NULL DEFAULT '{"notes":["read","write"],"comments":["read","write"],"tags":["read"]}' CHECK (json_valid(permissions)),
  "expiresAt" TEXT,
  "revokedAt" TEXT,
  "lastUsedAt" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (blinkora_now()),
  "updatedAt" TEXT NOT NULL DEFAULT (blinkora_now())
);

CREATE TABLE IF NOT EXISTS "operationLog" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  "accountId" INTEGER REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE SET NULL,
  "workspaceId" INTEGER REFERENCES workspaces(id) ON UPDATE CASCADE ON DELETE SET NULL,
  "actorType" TEXT NOT NULL DEFAULT 'user',
  "actorAccountId" INTEGER,
  "actorAgentTokenId" INTEGER,
  "actorLabel" TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  "noteId" INTEGER,
  "noteType" INTEGER,
  "noteTitle" TEXT NOT NULL DEFAULT '',
  "changedFields" TEXT NOT NULL DEFAULT '[]' CHECK (json_valid("changedFields")),
  summary TEXT NOT NULL DEFAULT '',
  details TEXT CHECK (details IS NULL OR json_valid(details)),
  "createdAt" TEXT NOT NULL DEFAULT (blinkora_now())
);

CREATE TABLE IF NOT EXISTS cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL CHECK (json_valid(value)),
  "createdAt" TEXT NOT NULL DEFAULT (blinkora_now()),
  "updatedAt" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "agentAccessTokens_accountId_workspaceId_idx" ON "agentAccessTokens" ("accountId", "workspaceId");
CREATE INDEX IF NOT EXISTS "agentAccessTokens_workspaceId_idx" ON "agentAccessTokens" ("workspaceId");
CREATE INDEX IF NOT EXISTS "agentAccessTokens_revokedAt_idx" ON "agentAccessTokens" ("revokedAt");
CREATE INDEX IF NOT EXISTS "attachments_accountId_workspaceId_idx" ON attachments ("accountId", "workspaceId");
CREATE INDEX IF NOT EXISTS "attachments_workspaceId_idx" ON attachments ("workspaceId");
CREATE INDEX IF NOT EXISTS "comments_accountId_idx" ON comments ("accountId");
CREATE INDEX IF NOT EXISTS comments_kind_idx ON comments (kind);
CREATE INDEX IF NOT EXISTS "comments_noteId_idx" ON comments ("noteId");
CREATE INDEX IF NOT EXISTS "comments_parentId_idx" ON comments ("parentId");
CREATE INDEX IF NOT EXISTS comments_status_idx ON comments (status);
CREATE INDEX IF NOT EXISTS "comments_workspaceId_idx" ON comments ("workspaceId");
CREATE INDEX IF NOT EXISTS "config_userId_workspaceId_idx" ON config ("userId", "workspaceId");
CREATE INDEX IF NOT EXISTS "config_workspaceId_idx" ON config ("workspaceId");
CREATE INDEX IF NOT EXISTS "noteHistory_accountId_idx" ON "noteHistory" ("accountId");
CREATE INDEX IF NOT EXISTS "noteHistory_noteId_idx" ON "noteHistory" ("noteId");
CREATE INDEX IF NOT EXISTS "noteHistory_workspaceId_idx" ON "noteHistory" ("workspaceId");
CREATE INDEX IF NOT EXISTS "operationLog_workspaceId_actorType_idx" ON "operationLog" ("workspaceId", "actorType");
CREATE INDEX IF NOT EXISTS "operationLog_workspaceId_createdAt_idx" ON "operationLog" ("workspaceId", "createdAt");
CREATE INDEX IF NOT EXISTS "operationLog_workspaceId_id_idx" ON "operationLog" ("workspaceId", id);
CREATE INDEX IF NOT EXISTS "operationLog_workspaceId_noteId_idx" ON "operationLog" ("workspaceId", "noteId");
CREATE INDEX IF NOT EXISTS "operationLog_workspaceId_noteType_idx" ON "operationLog" ("workspaceId", "noteType");
CREATE INDEX IF NOT EXISTS "notes_accountId_workspaceId_idx" ON notes ("accountId", "workspaceId");
CREATE INDEX IF NOT EXISTS "notes_workspaceId_idx" ON notes ("workspaceId");
CREATE INDEX IF NOT EXISTS "tag_accountId_workspaceId_idx" ON tag ("accountId", "workspaceId");
CREATE INDEX IF NOT EXISTS "tag_workspaceId_idx" ON tag ("workspaceId");
