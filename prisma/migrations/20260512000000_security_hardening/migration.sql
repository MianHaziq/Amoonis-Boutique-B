-- Security hardening: tokenVersion on User, RefreshToken table,
-- and a partial unique index that guarantees a single default Address per user.
-- All changes are additive; no existing column is dropped or renamed.

-- =============================================================
-- 1. User.tokenVersion
-- Counter bumped to invalidate all currently-issued access tokens.
-- Default 0; legacy tokens have no `tv` claim and are accepted during rollout.
-- =============================================================
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- =============================================================
-- 2. RefreshToken table
-- Server-side store; raw tokens are never persisted, only their SHA-256 hash.
-- =============================================================
CREATE TABLE IF NOT EXISTS "RefreshToken" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");
CREATE INDEX IF NOT EXISTS "RefreshToken_userId_idx" ON "RefreshToken"("userId");
CREATE INDEX IF NOT EXISTS "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");

-- FK only if it doesn't already exist (idempotent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'RefreshToken_userId_fkey'
  ) THEN
    ALTER TABLE "RefreshToken"
      ADD CONSTRAINT "RefreshToken_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

-- =============================================================
-- 3. Address default uniqueness
-- Step a: keep at most one default per user (most recent updatedAt wins).
--         Anything older is demoted to isDefault = false so the partial index can be added.
-- Step b: create the partial unique index.
-- =============================================================
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "userId"
      ORDER BY "updatedAt" DESC, "createdAt" DESC, "id" DESC
    ) AS rn
  FROM "Address"
  WHERE "isDefault" = TRUE
)
UPDATE "Address" a
SET "isDefault" = FALSE
FROM ranked r
WHERE a."id" = r."id" AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "Address_userId_default_unique"
  ON "Address"("userId")
  WHERE "isDefault" = TRUE;
