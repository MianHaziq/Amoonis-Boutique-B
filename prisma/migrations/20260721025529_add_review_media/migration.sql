-- Add customer-uploaded media (photo CDN URLs) to reviews.
-- Non-destructive additive column; existing rows default to an empty array.
ALTER TABLE "Review" ADD COLUMN IF NOT EXISTS "media" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
