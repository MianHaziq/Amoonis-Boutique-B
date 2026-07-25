-- Region-scope saved addresses: an address now records the region it belongs to
-- so the storefront can show/enable it only while the user is shopping in that
-- region (an address saved in UAE isn't offered at checkout while in KSA).

-- AlterTable
ALTER TABLE "Address" ADD COLUMN "regionId" TEXT;

-- CreateIndex
CREATE INDEX "Address_regionId_idx" ON "Address"("regionId");

-- AddForeignKey (SetNull so deleting a region never orphans/deletes the address)
ALTER TABLE "Address" ADD CONSTRAINT "Address_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill (1): the most authoritative signal — the address's delivery zone
-- belongs to exactly one region.
UPDATE "Address" a
SET "regionId" = dz."regionId"
FROM "DeliveryZone" dz
WHERE a."deliveryZoneId" = dz."id"
  AND a."regionId" IS NULL;

-- Backfill (2): addresses with no delivery zone fall back to the owner's home
-- region (captured from X-Region at signup). Rows still null after this are
-- treated as "no region" and remain visible everywhere (safe legacy fallback).
UPDATE "Address" a
SET "regionId" = u."regionId"
FROM "User" u
WHERE a."userId" = u."id"
  AND a."regionId" IS NULL
  AND u."regionId" IS NOT NULL;
