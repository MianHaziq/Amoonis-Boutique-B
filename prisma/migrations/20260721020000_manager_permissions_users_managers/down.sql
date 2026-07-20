-- =====================================================================
-- Manual rollback for 20260721020000_manager_permissions_users_managers
-- =====================================================================
-- Prisma is forward-only; this is the reverse pair to migration.sql. Run against
-- the SAME database that received the up migration. Idempotent (guards) so a
-- partial re-run is safe.
--
-- PostgreSQL can't drop a value from an in-use enum, so for `ManagerPermission`:
--   1. Strip USERS / MANAGERS from any managerPermissions arrays.
--   2. Rebuild the enum without them via the rename-and-swap recipe.
-- =====================================================================

BEGIN;

-- 1. Remove the values from any User.managerPermissions arrays first so the
--    enum rebuild doesn't fail on orphan references.
UPDATE "User"
SET    "managerPermissions" = array_remove(
           array_remove("managerPermissions", 'USERS'::"ManagerPermission"),
           'MANAGERS'::"ManagerPermission"
       )
WHERE  'USERS'    = ANY ("managerPermissions")
   OR  'MANAGERS' = ANY ("managerPermissions");

-- 2. Rebuild ManagerPermission without the two values (rename-and-swap).
--    Skip entirely if neither is present (idempotent re-run).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM   pg_enum e
        JOIN   pg_type t ON t.oid = e.enumtypid
        WHERE  t.typname = 'ManagerPermission'
        AND    e.enumlabel IN ('USERS', 'MANAGERS')
    ) THEN
        -- a. New enum without the two values (the pre-migration set)
        CREATE TYPE "ManagerPermission_new" AS ENUM (
            'PRODUCTS', 'ORDERS', 'CATEGORIES', 'SECTIONS',
            'BANNERS', 'CONTACT', 'SETTINGS', 'PROMO_CODES',
            'ANALYTICS', 'REGIONS', 'REVIEWS', 'DELIVERY_ZONES',
            'VAT', 'NOTIFICATIONS'
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
--        WHERE  migration_name = '20260721020000_manager_permissions_users_managers';
-- =====================================================================
