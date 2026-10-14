-- Per-region toggle for the Saudi National Address SHORT ADDRESS field at checkout.
-- Only Saudi Arabia needs it, so an admin turns it on for the SA region and leaves it off
-- everywhere else. Additive and defaulted false so every existing (non-Saudi) region stops
-- being blocked by this Saudi-specific field the moment the column lands.
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "shortAddressEnabled" BOOLEAN NOT NULL DEFAULT false;
