-- Drop legacy split-name columns. `fullName` is the single source of truth for
-- user display names now; API no longer accepts or returns firstName/lastName.

ALTER TABLE "User" DROP COLUMN IF EXISTS "firstName";
ALTER TABLE "User" DROP COLUMN IF EXISTS "lastName";
