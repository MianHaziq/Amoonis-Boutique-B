-- AlterTable: add the web-only permanent-route slug for each region.
-- Nullable + additive so existing rows and the mobile app are unaffected
-- (the mobile app never reads this and keeps scoping by `code`).
ALTER TABLE "Region" ADD COLUMN "urlSlug" TEXT;

-- Backfill the two existing regions so /ae/… and /sa/… resolve immediately.
-- Must run BEFORE creating the unique index below.
UPDATE "Region" SET "urlSlug" = 'ae' WHERE "code" = 'UAE';
UPDATE "Region" SET "urlSlug" = 'sa' WHERE "code" = 'SA';

-- CreateIndex: a slug maps to exactly one region (multiple NULLs allowed in Postgres).
CREATE UNIQUE INDEX "Region_urlSlug_key" ON "Region"("urlSlug");
