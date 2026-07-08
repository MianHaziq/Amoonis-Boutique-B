-- ============================================================================
-- Promo code region scoping (PromoCodeRegion)
--
-- Mirrors ProductRegion/CategoryRegion/SectionRegion/BannerRegion. A promo code
-- with no rows here is invalid everywhere; the service layer defaults new codes
-- to the default region (UAE) when no regionIds are supplied, matching every
-- other region-aware entity in this schema.
-- ============================================================================

-- CreateTable
CREATE TABLE "PromoCodeRegion" (
    "promoCodeId" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PromoCodeRegion_pkey" PRIMARY KEY ("promoCodeId","regionId")
);

-- CreateIndex
CREATE INDEX "PromoCodeRegion_regionId_idx" ON "PromoCodeRegion"("regionId");

-- AddForeignKey
ALTER TABLE "PromoCodeRegion" ADD CONSTRAINT "PromoCodeRegion_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PromoCodeRegion" ADD CONSTRAINT "PromoCodeRegion_regionId_fkey"    FOREIGN KEY ("regionId")    REFERENCES "Region"("id")    ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every EXISTING promo code becomes valid in ALL currently-active
-- regions (so no code silently disappears from checkout on deploy). New codes
-- created after this migration default to the default region only unless the
-- admin explicitly picks others (see promoCode.service.js).
INSERT INTO "PromoCodeRegion" ("promoCodeId", "regionId", "createdAt")
SELECT p.id, r.id, CURRENT_TIMESTAMP
FROM "PromoCode" p
CROSS JOIN "Region" r
WHERE r."isActive" = true
ON CONFLICT DO NOTHING;
