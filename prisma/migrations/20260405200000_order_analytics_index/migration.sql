-- Speed up time-range revenue aggregates (WHERE createdAt + status filters).

CREATE INDEX "Order_createdAt_status_idx" ON "Order" ("createdAt", "status");
