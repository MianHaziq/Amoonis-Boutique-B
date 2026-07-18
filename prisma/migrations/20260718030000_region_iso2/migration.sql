-- AlterTable
ALTER TABLE "Region" ADD COLUMN "iso2" VARCHAR(2);

-- Backfill the two existing regions so their flags don't regress once the
-- storefront starts rendering flagcdn.com images keyed by this column.
UPDATE "Region" SET "iso2" = 'AE' WHERE "code" = 'UAE';
UPDATE "Region" SET "iso2" = 'SA' WHERE "code" = 'SA';
