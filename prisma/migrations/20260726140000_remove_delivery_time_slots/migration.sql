-- Remove delivery time slots. Scheduled delivery is DATE-ONLY (the storefront collects a
-- day, not a time-of-day), so per-zone time windows and the per-order slot snapshot are
-- unused. isSameDayDelivery is kept (it flags a scheduled order placed for today).

-- DropTable
DROP TABLE IF EXISTS "DeliveryTimeSlot";

-- AlterTable: drop the per-order slot snapshot columns
ALTER TABLE "Order" DROP COLUMN IF EXISTS "deliverySlotLabel";
ALTER TABLE "Order" DROP COLUMN IF EXISTS "deliverySlotStart";
ALTER TABLE "Order" DROP COLUMN IF EXISTS "deliverySlotEnd";
