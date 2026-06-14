-- ============================================================================
-- Multi-region support + draft/published content
--
-- Regions are stored as DATA (Region table) rather than an enum, so new regions
-- can be added at runtime with no further migration. Products / categories /
-- banners / sections relate to regions many-to-many (a row per visible region).
-- Orders and users carry a single region.
--
-- Backfill strategy (so nothing disappears on deploy):
--   * Existing content rows -> status PUBLISHED, future inserts default to DRAFT.
--   * Existing content rows -> visible in ALL seeded regions.
--   * Existing users / orders -> assigned to the default region.
-- ============================================================================

-- CreateEnum
CREATE TYPE "PublishStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- ----------------------------------------------------------------------------
-- Draft/published status columns.
-- Add with DEFAULT 'PUBLISHED' so every PRE-EXISTING row stays visible, then
-- flip the column default to 'DRAFT' so NEW rows are hidden until published
-- (matches Prisma @default(DRAFT)).
-- ----------------------------------------------------------------------------
ALTER TABLE "Product"     ADD COLUMN "status" "PublishStatus" NOT NULL DEFAULT 'PUBLISHED';
ALTER TABLE "Category"    ADD COLUMN "status" "PublishStatus" NOT NULL DEFAULT 'PUBLISHED';
ALTER TABLE "Section"     ADD COLUMN "status" "PublishStatus" NOT NULL DEFAULT 'PUBLISHED';
ALTER TABLE "BannerImage" ADD COLUMN "status" "PublishStatus" NOT NULL DEFAULT 'PUBLISHED';

ALTER TABLE "Product"     ALTER COLUMN "status" SET DEFAULT 'DRAFT';
ALTER TABLE "Category"    ALTER COLUMN "status" SET DEFAULT 'DRAFT';
ALTER TABLE "Section"     ALTER COLUMN "status" SET DEFAULT 'DRAFT';
ALTER TABLE "BannerImage" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

-- Single-region FKs on User and Order.
ALTER TABLE "User"  ADD COLUMN "regionId" TEXT;
ALTER TABLE "Order" ADD COLUMN "regionId" TEXT;

-- CreateTable
CREATE TABLE "Region" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductRegion" (
    "productId" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductRegion_pkey" PRIMARY KEY ("productId","regionId")
);

-- CreateTable
CREATE TABLE "CategoryRegion" (
    "categoryId" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CategoryRegion_pkey" PRIMARY KEY ("categoryId","regionId")
);

-- CreateTable
CREATE TABLE "BannerRegion" (
    "bannerId" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BannerRegion_pkey" PRIMARY KEY ("bannerId","regionId")
);

-- CreateTable
CREATE TABLE "SectionRegion" (
    "sectionId" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SectionRegion_pkey" PRIMARY KEY ("sectionId","regionId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Region_code_key" ON "Region"("code");
CREATE INDEX "Region_isActive_idx" ON "Region"("isActive");
CREATE INDEX "Region_sortOrder_idx" ON "Region"("sortOrder");
CREATE INDEX "ProductRegion_regionId_idx" ON "ProductRegion"("regionId");
CREATE INDEX "CategoryRegion_regionId_idx" ON "CategoryRegion"("regionId");
CREATE INDEX "BannerRegion_regionId_idx" ON "BannerRegion"("regionId");
CREATE INDEX "SectionRegion_regionId_idx" ON "SectionRegion"("regionId");
CREATE INDEX "BannerImage_status_idx" ON "BannerImage"("status");
CREATE INDEX "Category_status_idx" ON "Category"("status");
CREATE INDEX "Product_status_idx" ON "Product"("status");
CREATE INDEX "Section_status_idx" ON "Section"("status");
CREATE INDEX "Order_regionId_idx" ON "Order"("regionId");
CREATE INDEX "User_regionId_idx" ON "User"("regionId");

-- AddForeignKey
ALTER TABLE "ProductRegion"  ADD CONSTRAINT "ProductRegion_productId_fkey"   FOREIGN KEY ("productId")  REFERENCES "Product"("id")     ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "ProductRegion"  ADD CONSTRAINT "ProductRegion_regionId_fkey"    FOREIGN KEY ("regionId")   REFERENCES "Region"("id")      ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "CategoryRegion" ADD CONSTRAINT "CategoryRegion_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id")    ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "CategoryRegion" ADD CONSTRAINT "CategoryRegion_regionId_fkey"   FOREIGN KEY ("regionId")   REFERENCES "Region"("id")      ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "BannerRegion"   ADD CONSTRAINT "BannerRegion_bannerId_fkey"     FOREIGN KEY ("bannerId")   REFERENCES "BannerImage"("id") ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "BannerRegion"   ADD CONSTRAINT "BannerRegion_regionId_fkey"     FOREIGN KEY ("regionId")   REFERENCES "Region"("id")      ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "SectionRegion"  ADD CONSTRAINT "SectionRegion_sectionId_fkey"   FOREIGN KEY ("sectionId")  REFERENCES "Section"("id")     ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "SectionRegion"  ADD CONSTRAINT "SectionRegion_regionId_fkey"    FOREIGN KEY ("regionId")   REFERENCES "Region"("id")      ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "User"  ADD CONSTRAINT "User_regionId_fkey"  FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- Seed the two launch regions. UAE is the default (used when the client sends
-- no/unknown X-Region). gen_random_uuid() is built into Postgres 13+.
-- ----------------------------------------------------------------------------
INSERT INTO "Region" ("id", "code", "name", "name_ar", "isDefault", "isActive", "sortOrder", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'UAE', 'United Arab Emirates', 'الإمارات العربية المتحدة', true,  true, 0, now(), now()),
  (gen_random_uuid(), 'SA',  'Saudi Arabia',         'المملكة العربية السعودية', false, true, 1, now(), now());

-- ----------------------------------------------------------------------------
-- Backfill: make all existing content visible in EVERY seeded region.
-- ----------------------------------------------------------------------------
INSERT INTO "ProductRegion" ("productId", "regionId", "createdAt")
SELECT p."id", r."id", now() FROM "Product" p CROSS JOIN "Region" r;

INSERT INTO "CategoryRegion" ("categoryId", "regionId", "createdAt")
SELECT c."id", r."id", now() FROM "Category" c CROSS JOIN "Region" r;

INSERT INTO "BannerRegion" ("bannerId", "regionId", "createdAt")
SELECT b."id", r."id", now() FROM "BannerImage" b CROSS JOIN "Region" r;

INSERT INTO "SectionRegion" ("sectionId", "regionId", "createdAt")
SELECT s."id", r."id", now() FROM "Section" s CROSS JOIN "Region" r;

-- ----------------------------------------------------------------------------
-- Backfill: assign existing users and orders to the default region.
-- ----------------------------------------------------------------------------
UPDATE "User"  SET "regionId" = (SELECT "id" FROM "Region" WHERE "isDefault" = true LIMIT 1) WHERE "regionId" IS NULL;
UPDATE "Order" SET "regionId" = (SELECT "id" FROM "Region" WHERE "isDefault" = true LIMIT 1) WHERE "regionId" IS NULL;
