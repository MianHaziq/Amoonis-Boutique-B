-- Add fullName as the canonical name field, backfill from existing firstName/lastName,
-- and relax NOT NULL on firstName/lastName so new signups can omit them.

ALTER TABLE "User" ADD COLUMN "fullName" TEXT;

UPDATE "User"
SET "fullName" = NULLIF(TRIM(CONCAT_WS(' ', "firstName", "lastName")), '')
WHERE "fullName" IS NULL;

ALTER TABLE "User" ALTER COLUMN "firstName" DROP NOT NULL;
ALTER TABLE "User" ALTER COLUMN "lastName" DROP NOT NULL;
