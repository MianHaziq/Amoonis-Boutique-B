-- VAT moves from a single store-wide config row to ONE ROW PER REGION, so each region
-- (UAE 5%, KSA 15%, ...) can carry its own rate / inclusive flag / scope.

ALTER TABLE "VatConfig" ADD COLUMN "regionId" TEXT;

-- Backfill the existing singleton row onto the default (or first) region.
UPDATE "VatConfig"
SET "regionId" = (
  SELECT "id" FROM "Region"
  ORDER BY "isDefault" DESC, "sortOrder" ASC
  LIMIT 1
)
WHERE "id" = 'default';

-- Fresh DB with no regions yet: drop the orphan row rather than leave regionId NULL.
DELETE FROM "VatConfig" WHERE "regionId" IS NULL;

ALTER TABLE "VatConfig" ALTER COLUMN "regionId" SET NOT NULL;
CREATE UNIQUE INDEX "VatConfig_regionId_key" ON "VatConfig"("regionId");
ALTER TABLE "VatConfig" ADD CONSTRAINT "VatConfig_regionId_fkey"
  FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- "id" is no longer a meaningful business key ('default') — new rows get a Prisma-generated
-- uuid, so drop the stale DB-level default.
ALTER TABLE "VatConfig" ALTER COLUMN "id" DROP DEFAULT;
