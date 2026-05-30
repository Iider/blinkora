ALTER TABLE "workspaces" ALTER COLUMN "name" SET DEFAULT '默认工作区';

UPDATE "workspaces"
SET "name" = '默认工作区'
WHERE "isDefault" = true
  AND "name" = 'Default';
