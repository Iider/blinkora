-- Add single-account multi-workspace support.
-- The migration is intentionally idempotent because this fork keeps recovery
-- migrations runnable across partially migrated local environments.

CREATE TABLE IF NOT EXISTS "workspaces" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR NOT NULL DEFAULT 'Default',
    "description" VARCHAR NOT NULL DEFAULT '',
    "icon" VARCHAR NOT NULL DEFAULT '',
    "color" VARCHAR NOT NULL DEFAULT '',
    "accountId" INTEGER NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_accountId_fkey') THEN
        ALTER TABLE "workspaces"
        ADD CONSTRAINT "workspaces_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "workspaces_accountId_idx" ON "workspaces"("accountId");
CREATE INDEX IF NOT EXISTS "workspaces_isDefault_idx" ON "workspaces"("isDefault");

ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "workspaceId" INTEGER;
ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "workspaceId" INTEGER;
ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "workspaceId" INTEGER;
ALTER TABLE "comments" ADD COLUMN IF NOT EXISTS "workspaceId" INTEGER;
ALTER TABLE "tag" ADD COLUMN IF NOT EXISTS "workspaceId" INTEGER;
ALTER TABLE "noteHistory" ADD COLUMN IF NOT EXISTS "workspaceId" INTEGER;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attachments_workspaceId_fkey') THEN
        ALTER TABLE "attachments"
        ADD CONSTRAINT "attachments_workspaceId_fkey"
        FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'config_workspaceId_fkey') THEN
        ALTER TABLE "config"
        ADD CONSTRAINT "config_workspaceId_fkey"
        FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notes_workspaceId_fkey') THEN
        ALTER TABLE "notes"
        ADD CONSTRAINT "notes_workspaceId_fkey"
        FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comments_workspaceId_fkey') THEN
        ALTER TABLE "comments"
        ADD CONSTRAINT "comments_workspaceId_fkey"
        FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tag_workspaceId_fkey') THEN
        ALTER TABLE "tag"
        ADD CONSTRAINT "tag_workspaceId_fkey"
        FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'noteHistory_workspaceId_fkey') THEN
        ALTER TABLE "noteHistory"
        ADD CONSTRAINT "noteHistory_workspaceId_fkey"
        FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "attachments_accountId_workspaceId_idx" ON "attachments"("accountId", "workspaceId");
CREATE INDEX IF NOT EXISTS "attachments_workspaceId_idx" ON "attachments"("workspaceId");
CREATE INDEX IF NOT EXISTS "config_userId_workspaceId_idx" ON "config"("userId", "workspaceId");
CREATE INDEX IF NOT EXISTS "config_workspaceId_idx" ON "config"("workspaceId");
CREATE INDEX IF NOT EXISTS "notes_accountId_workspaceId_idx" ON "notes"("accountId", "workspaceId");
CREATE INDEX IF NOT EXISTS "notes_workspaceId_idx" ON "notes"("workspaceId");
CREATE INDEX IF NOT EXISTS "comments_workspaceId_idx" ON "comments"("workspaceId");
CREATE INDEX IF NOT EXISTS "tag_accountId_workspaceId_idx" ON "tag"("accountId", "workspaceId");
CREATE INDEX IF NOT EXISTS "tag_workspaceId_idx" ON "tag"("workspaceId");
CREATE INDEX IF NOT EXISTS "noteHistory_workspaceId_idx" ON "noteHistory"("workspaceId");

INSERT INTO "workspaces" ("name", "accountId", "isDefault")
SELECT 'Default', a."id", true
FROM "accounts" a
WHERE NOT EXISTS (
    SELECT 1 FROM "workspaces" w WHERE w."accountId" = a."id"
);

UPDATE "workspaces" w
SET "isDefault" = true
WHERE w."id" IN (
    SELECT MIN(w2."id")
    FROM "workspaces" w2
    GROUP BY w2."accountId"
    HAVING BOOL_OR(w2."isDefault") = false
);

UPDATE "notes" n
SET "workspaceId" = w."id"
FROM "workspaces" w
WHERE n."workspaceId" IS NULL
  AND n."accountId" = w."accountId"
  AND w."isDefault" = true;

UPDATE "tag" t
SET "workspaceId" = w."id"
FROM "workspaces" w
WHERE t."workspaceId" IS NULL
  AND t."accountId" = w."accountId"
  AND w."isDefault" = true;

UPDATE "attachments" a
SET "workspaceId" = n."workspaceId"
FROM "notes" n
WHERE a."workspaceId" IS NULL
  AND a."noteId" = n."id"
  AND n."workspaceId" IS NOT NULL;

UPDATE "attachments" a
SET "workspaceId" = w."id"
FROM "workspaces" w
WHERE a."workspaceId" IS NULL
  AND a."accountId" = w."accountId"
  AND w."isDefault" = true;

UPDATE "comments" c
SET "workspaceId" = n."workspaceId"
FROM "notes" n
WHERE c."workspaceId" IS NULL
  AND c."noteId" = n."id"
  AND n."workspaceId" IS NOT NULL;

UPDATE "comments" c
SET "workspaceId" = w."id"
FROM "workspaces" w
WHERE c."workspaceId" IS NULL
  AND c."accountId" = w."accountId"
  AND w."isDefault" = true;

UPDATE "config" c
SET "workspaceId" = w."id"
FROM "workspaces" w
WHERE c."workspaceId" IS NULL
  AND c."userId" = w."accountId"
  AND w."isDefault" = true;

UPDATE "noteHistory" h
SET "workspaceId" = n."workspaceId"
FROM "notes" n
WHERE h."workspaceId" IS NULL
  AND h."noteId" = n."id"
  AND n."workspaceId" IS NOT NULL;

UPDATE "noteHistory" h
SET "workspaceId" = w."id"
FROM "workspaces" w
WHERE h."workspaceId" IS NULL
  AND h."accountId" = w."accountId"
  AND w."isDefault" = true;
