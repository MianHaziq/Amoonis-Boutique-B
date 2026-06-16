-- =====================================================================
-- Manual rollback for migration 20260617000000_manager_permissions_analytics_regions
-- =====================================================================
-- Prisma is forward-only; this script is the reverse pair to migration.sql.
-- Run against the SAME database that received the up migration, wrapped in
-- a single transaction. Designed to be idempotent (guards everywhere) so
-- partial re-runs are safe.
--
-- Pre-flight: PostgreSQL does not allow dropping a value from an in-use
-- enum type. For `ManagerPermission`, we:
--   1. Strip 'ANALYTICS' / 'REGIONS' from any User.managerPermissions arrays.
--   2. Rebuild the enum without them using the rename-and-swap pattern
--      (the standard recipe from the Postgres docs).
-- =====================================================================

BEGIN;

-- 1. Remove the new values from any User.managerPermissions arrays so the
--    enum rebuild below doesn't fail on orphan references.
UPDATE "User"
SET    "managerPermissions" = array_remove(
           array_remove("managerPermissions", 'ANALYTICS'::"ManagerPermission"),
           'REGIONS'::"ManagerPermission"
       )
WHERE  'ANALYTICS' = ANY ("managerPermissions")
   OR  'REGIONS'   = ANY ("managerPermissions");

-- 2. Rebuild the ManagerPermission enum without ANALYTICS / REGIONS
--    (rename-and-swap). Skip entirely if neither value is present
--    (idempotent re-run).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM   pg_enum e
        JOIN   pg_type t ON t.oid = e.enumtypid
        WHERE  t.typname = 'ManagerPermission'
        AND    e.enumlabel IN ('ANALYTICS', 'REGIONS')
    ) THEN
        -- a. New enum without ANALYTICS / REGIONS
        CREATE TYPE "ManagerPermission_new" AS ENUM (
            'PRODUCTS', 'ORDERS', 'CATEGORIES', 'SECTIONS',
            'BANNERS', 'CONTACT', 'SETTINGS', 'PROMO_CODES'
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
--   1. Check out the prior schema.prisma (before this commit)
--   2. Run `npx prisma generate` so the client matches the DB
--   3. Delete the migration row, if desired:
--        DELETE FROM "_prisma_migrations"
--        WHERE  migration_name = '20260617000000_manager_permissions_analytics_regions';
-- =====================================================================
