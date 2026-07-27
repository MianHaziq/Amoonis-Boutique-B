-- Concrete resolved STANDARD arrival date snapshot (region-tz "YYYY-MM-DD"), so the
-- displayed delivery date never drifts with the viewer timezone (the day-count could).
ALTER TABLE "Order" ADD COLUMN "estimatedDeliveryDate" TEXT;
