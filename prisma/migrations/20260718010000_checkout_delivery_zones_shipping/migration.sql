-- AlterTable
ALTER TABLE "Address" ADD COLUMN     "area" TEXT,
ADD COLUMN     "deliveryZoneId" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "shippingAmount" DECIMAL(10,2),
ADD COLUMN     "shippingArea" TEXT,
ADD COLUMN     "shippingZoneName" TEXT;

-- AlterTable
ALTER TABLE "Region" ADD COLUMN     "shippingFlatRate" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "DeliveryZone" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryZone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryZone_regionId_idx" ON "DeliveryZone"("regionId");

-- CreateIndex
CREATE INDEX "DeliveryZone_isActive_idx" ON "DeliveryZone"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryZone_regionId_name_key" ON "DeliveryZone"("regionId", "name");

-- CreateIndex
CREATE INDEX "Address_deliveryZoneId_idx" ON "Address"("deliveryZoneId");

-- AddForeignKey
ALTER TABLE "DeliveryZone" ADD CONSTRAINT "DeliveryZone_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Address" ADD CONSTRAINT "Address_deliveryZoneId_fkey" FOREIGN KEY ("deliveryZoneId") REFERENCES "DeliveryZone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed UAE's 8 delivery zones (emirates), looked up dynamically by region code
-- rather than a hardcoded id so this migration is portable across environments.
INSERT INTO "DeliveryZone" (id, "regionId", name, "sortOrder", "updatedAt")
SELECT gen_random_uuid(), r.id, zone.name, zone.sort, now()
FROM "Region" r, (VALUES
  ('Abu Dhabi', 0), ('Dubai', 1), ('Sharjah', 2), ('Ajman', 3),
  ('Umm Al Quwain', 4), ('Ras Al Khaimah', 5), ('Fujairah', 6), ('Al Ain', 7)
) AS zone(name, sort)
WHERE r.code = 'UAE';
