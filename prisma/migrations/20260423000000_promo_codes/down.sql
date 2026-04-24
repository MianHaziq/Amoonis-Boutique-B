-- =====================================================================
-- Manual rollback for migration 20260423000000_promo_codes
-- =====================================================================
-- Prisma is forward-only; this script is the reverse pair to migration.sql.
-- Run against the SAME database that received the up migration, wrapped in
-- a single transaction. Designed to be idempotent (IF EXISTS everywhere) so
-- partial re-runs are safe.
--
-- Pre-flight: PostgreSQL does not allow dropping a value from an in-use
-- enum type. For `ManagerPermission`, we:
--   1. Strip 'PROMO_CODES' from any User.managerPermissions arrays.
--   2. Rebuild the enum without 'PROMO_CODES' using the rename-and-swap
--      pattern (the standard recipe from the Postgres docs).
-- =====================================================================

BEGIN;

-- 1. Drop foreign keys & tables (cascades clean up indexes and any rows).
DROP TABLE IF EXISTS "PromoCodeUsage"    CASCADE;
DROP TABLE IF EXISTS "PromoCodeProduct"  CASCADE;
DROP TABLE IF EXISTS "PromoCodeCategory" CASCADE;
DROP TABLE IF EXISTS "PromoCode"         CASCADE;

-- 2. Drop the enum types exclusive to promo codes.
DROP TYPE IF EXISTS "DiscountType";
DROP TYPE IF EXISTS "PromoAppliesTo";

-- 3. Remove PROMO_CODES from any User.managerPermissions arrays so the
--    enum rebuild below doesn't fail on orphan references.
UPDATE "User"
SET    "managerPermissions" = array_remove("managerPermissions", 'PROMO_CODES'::"ManagerPermission")
WHERE  'PROMO_CODES' = ANY ("managerPermissions");

-- 4. Rebuild the ManagerPermission enum without PROMO_CODES (rename-and-swap).
--    Skip entirely if PROMO_CODES is not present (idempotent re-run).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM   pg_enum e
        JOIN   pg_type t ON t.oid = e.enumtypid
        WHERE  t.typname = 'ManagerPermission'
        AND    e.enumlabel = 'PROMO_CODES'
    ) THEN
        -- a. New enum without PROMO_CODES
        CREATE TYPE "ManagerPermission_new" AS ENUM (
            'PRODUCTS', 'ORDERS', 'CATEGORIES', 'SECTIONS',
            'BANNERS', 'CONTACT', 'SETTINGS'
        );

        -- b. Swap the column over (array cast)
        ALTER TABLE "User"
            ALTER COLUMN "managerPermissions" DROP DEFAULT,
            ALTER COLUMN "managerPermissions"
                TYPE "ManagerPermission_new"[]
                USING "managerPermissions"::text[]::"ManagerPermission_new"[],
            ALTER COLUMN "managerPermissions"
                SET DEFAULT ARRAY[]::"ManagerPermission_new"[];

        -- c. Drop old, rename new → old
        DROP TYPE "ManagerPermission";
        ALTER TYPE "ManagerPermission_new" RENAME TO "ManagerPermission";
    END IF;
END $$;

COMMIT;

-- =====================================================================
-- After running:
--   1. Check out the prior schema.prisma (before the promo-code commit)
--   2. Run `npx prisma generate` so the client matches the DB
--   3. Delete the migration row, if desired:
--        DELETE FROM "_prisma_migrations"
--        WHERE  migration_name = '20260423000000_promo_codes';
-- =====================================================================
