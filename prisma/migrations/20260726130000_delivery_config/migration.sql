-- Delivery configuration: per-region and per-zone delivery settings.
-- All columns are additive with safe defaults / nullable, so existing regions, zones and
-- orders behave exactly as before this migration (zero regression).

-- Region: city-level delivery config
ALTER TABLE "Region" ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Asia/Dubai',
ADD COLUMN     "freeDeliveryThreshold" DECIMAL(10,2),
ADD COLUMN     "deliveryDays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "sameDayEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sameDayCutoff" TEXT,
ADD COLUMN     "codEnabled" BOOLEAN NOT NULL DEFAULT true;

-- DeliveryZone: per-zone overrides (null / [] = inherit region)
ALTER TABLE "DeliveryZone" ADD COLUMN     "shippingFlatRate" DECIMAL(10,2),
ADD COLUMN     "freeDeliveryThreshold" DECIMAL(10,2),
ADD COLUMN     "sameDayEnabled" BOOLEAN,
ADD COLUMN     "sameDayCutoff" TEXT,
ADD COLUMN     "standardLeadDays" INTEGER,
ADD COLUMN     "deliveryDays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "codEnabled" BOOLEAN,
ADD COLUMN     "minOrderAmount" DECIMAL(10,2),
ADD COLUMN     "maxOrderAmount" DECIMAL(10,2);

-- Order: delivery slot + same-day snapshots
ALTER TABLE "Order" ADD COLUMN     "deliverySlotLabel" TEXT,
ADD COLUMN     "deliverySlotStart" TEXT,
ADD COLUMN     "deliverySlotEnd" TEXT,
ADD COLUMN     "isSameDayDelivery" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "DeliveryTimeSlot" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "label_ar" TEXT,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryTimeSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryBlackoutDate" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "label" TEXT,
    "label_ar" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryBlackoutDate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryTimeSlot_zoneId_idx" ON "DeliveryTimeSlot"("zoneId");

-- CreateIndex
CREATE INDEX "DeliveryTimeSlot_isActive_idx" ON "DeliveryTimeSlot"("isActive");

-- CreateIndex
CREATE INDEX "DeliveryBlackoutDate_regionId_idx" ON "DeliveryBlackoutDate"("regionId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryBlackoutDate_regionId_date_key" ON "DeliveryBlackoutDate"("regionId", "date");

-- AddForeignKey
ALTER TABLE "DeliveryTimeSlot" ADD CONSTRAINT "DeliveryTimeSlot_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "DeliveryZone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryBlackoutDate" ADD CONSTRAINT "DeliveryBlackoutDate_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE CASCADE ON UPDATE CASCADE;
