-- Restore comments as private annotations for agent-maintained wiki notes.
-- This migration is idempotent so it can recover environments where the
-- earlier simplification migration was already applied.

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

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comments_noteId_fkey') THEN
        ALTER TABLE "comments" DROP CONSTRAINT "comments_noteId_fkey";
    END IF;
    ALTER TABLE "comments" ADD CONSTRAINT "comments_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comments_accountId_fkey') THEN
        ALTER TABLE "comments" ADD CONSTRAINT "comments_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comments_parentId_fkey') THEN
        ALTER TABLE "comments" DROP CONSTRAINT "comments_parentId_fkey";
    END IF;
    ALTER TABLE "comments" ADD CONSTRAINT "comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
END $$;

CREATE INDEX IF NOT EXISTS "comments_noteId_idx" ON "comments"("noteId");
CREATE INDEX IF NOT EXISTS "comments_accountId_idx" ON "comments"("accountId");
CREATE INDEX IF NOT EXISTS "comments_kind_idx" ON "comments"("kind");
CREATE INDEX IF NOT EXISTS "comments_status_idx" ON "comments"("status");
CREATE INDEX IF NOT EXISTS "comments_parentId_idx" ON "comments"("parentId");
