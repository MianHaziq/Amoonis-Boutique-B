-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "defaultDeliveryLeadDays" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "deliveryLeadDays" INTEGER;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "deliveryLeadDays" INTEGER;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "resolvedLeadDays" INTEGER;
