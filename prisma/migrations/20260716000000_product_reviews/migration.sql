-- ============================================================================
-- Product reviews
--
-- Star rating + written review per product. Either userId is set (signed-in
-- reviewer) or guestName/guestEmail are set (guest reviewer — gated by the new
-- Settings.allowGuestReviews toggle, default on). Published immediately; admins
-- moderate after the fact via delete (no pending/approval state).
-- ============================================================================

-- AlterEnum
ALTER TYPE "ManagerPermission" ADD VALUE IF NOT EXISTS 'REVIEWS';

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "allowGuestReviews" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE IF NOT EXISTS "Review" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "userId" TEXT,
    "guestName" TEXT,
    "guestEmail" TEXT,
    "rating" INTEGER NOT NULL,
    "comment" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Review_productId_idx" ON "Review"("productId");
CREATE INDEX IF NOT EXISTS "Review_productId_createdAt_idx" ON "Review"("productId", "createdAt");
CREATE INDEX IF NOT EXISTS "Review_userId_idx" ON "Review"("userId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Review" ADD CONSTRAINT "Review_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Review" ADD CONSTRAINT "Review_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
