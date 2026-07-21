-- CreateEnum
CREATE TYPE "DeliveryType" AS ENUM ('STANDARD', 'SCHEDULED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "deliveryType" "DeliveryType" NOT NULL DEFAULT 'STANDARD',
ADD COLUMN     "estimatedDeliveryDays" INTEGER,
ADD COLUMN     "scheduledDeliveryAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Region" ADD COLUMN     "standardDeliveryDays" INTEGER;

-- CreateIndex
CREATE INDEX "Order_scheduledDeliveryAt_idx" ON "Order"("scheduledDeliveryAt");
