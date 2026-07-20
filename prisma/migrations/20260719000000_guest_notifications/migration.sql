-- AlterTable: Notification.userId becomes optional so a guest order's status
-- changes can create a row (userId NULL, guestEmail set) before an account
-- exists; linkGuestOrdersToUser re-points these to the account on signup/login.
ALTER TABLE "Notification" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "Notification" ADD COLUMN "guestEmail" TEXT;

-- CreateIndex
CREATE INDEX "Notification_guestEmail_idx" ON "Notification"("guestEmail");
