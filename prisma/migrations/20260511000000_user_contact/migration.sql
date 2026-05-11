-- Authenticated-user issue/inquiry table. Separate from the public ContactMessage
-- form so we always have a userId and can show user details in admin.

CREATE TABLE "UserContact" (
  "id"          TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "title"       TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'NEW',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "UserContact_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserContact_userId_idx"    ON "UserContact"("userId");
CREATE INDEX "UserContact_status_idx"    ON "UserContact"("status");
CREATE INDEX "UserContact_createdAt_idx" ON "UserContact"("createdAt");

ALTER TABLE "UserContact"
  ADD CONSTRAINT "UserContact_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
