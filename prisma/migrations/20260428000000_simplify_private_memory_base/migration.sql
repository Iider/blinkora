-- Simplify Blinkora into a private single-user memory/note base.
-- Removed social/public-share/plugin/AI-chat/external-MCP scheduled-agent tables and fields.

ALTER TABLE "accounts" DROP COLUMN IF EXISTS "loginType";
ALTER TABLE "accounts" DROP COLUMN IF EXISTS "linkAccountId";

ALTER TABLE "attachments" DROP COLUMN IF EXISTS "isShare";
ALTER TABLE "attachments" DROP COLUMN IF EXISTS "sharePassword";

ALTER TABLE "notes" DROP COLUMN IF EXISTS "isShare";
ALTER TABLE "notes" DROP COLUMN IF EXISTS "sharePassword";
ALTER TABLE "notes" DROP COLUMN IF EXISTS "shareEncryptedUrl";
ALTER TABLE "notes" DROP COLUMN IF EXISTS "shareExpiryDate";
ALTER TABLE "notes" DROP COLUMN IF EXISTS "shareMaxView";
ALTER TABLE "notes" DROP COLUMN IF EXISTS "shareViewCount";

CREATE TABLE IF NOT EXISTS "comments" (
    "id" SERIAL NOT NULL,
    "content" TEXT NOT NULL,
    "kind" VARCHAR NOT NULL DEFAULT 'annotation',
    "status" VARCHAR NOT NULL DEFAULT 'open',
    "metadata" JSON,
    "accountId" INTEGER,
    "noteId" INTEGER NOT NULL,
    "parentId" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "comments" DROP COLUMN IF EXISTS "guestName";
ALTER TABLE "comments" DROP COLUMN IF EXISTS "guestIP";
ALTER TABLE "comments" DROP COLUMN IF EXISTS "guestUA";
ALTER TABLE "comments" ADD COLUMN IF NOT EXISTS "kind" VARCHAR NOT NULL DEFAULT 'annotation';
ALTER TABLE "comments" ADD COLUMN IF NOT EXISTS "status" VARCHAR NOT NULL DEFAULT 'open';
ALTER TABLE "comments" ADD COLUMN IF NOT EXISTS "metadata" JSON;
ALTER TABLE "comments" DROP CONSTRAINT IF EXISTS "comments_noteId_fkey";
ALTER TABLE "comments" ADD CONSTRAINT "comments_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "comments" DROP CONSTRAINT IF EXISTS "comments_accountId_fkey";
ALTER TABLE "comments" ADD CONSTRAINT "comments_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "comments" DROP CONSTRAINT IF EXISTS "comments_parentId_fkey";
ALTER TABLE "comments" ADD CONSTRAINT "comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "comments_noteId_idx" ON "comments"("noteId");
CREATE INDEX IF NOT EXISTS "comments_accountId_idx" ON "comments"("accountId");
CREATE INDEX IF NOT EXISTS "comments_kind_idx" ON "comments"("kind");
CREATE INDEX IF NOT EXISTS "comments_status_idx" ON "comments"("status");
CREATE INDEX IF NOT EXISTS "comments_parentId_idx" ON "comments"("parentId");
DROP TABLE IF EXISTS "follows" CASCADE;
DROP TABLE IF EXISTS "notifications" CASCADE;
DROP TABLE IF EXISTS "plugin" CASCADE;
DROP TABLE IF EXISTS "message" CASCADE;
DROP TABLE IF EXISTS "conversation" CASCADE;
DROP TABLE IF EXISTS "noteInternalShare" CASCADE;
DROP TABLE IF EXISTS "aiScheduledTask" CASCADE;
DROP TABLE IF EXISTS "mcpServers" CASCADE;
