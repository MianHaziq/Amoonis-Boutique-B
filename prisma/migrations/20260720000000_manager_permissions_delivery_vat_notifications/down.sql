-- =====================================================================
-- Manual rollback for 20260720000000_manager_permissions_delivery_vat_notifications
-- =====================================================================
-- Prisma is forward-only; this is the reverse pair to migration.sql. Run against
-- the SAME database that received the up migration. Idempotent (guards) so a
-- partial re-run is safe.
--
-- PostgreSQL can't drop a value from an in-use enum, so for `ManagerPermission`:
--   1. Strip DELIVERY_ZONES / VAT / NOTIFICATIONS from any managerPermissions arrays.
--   2. Rebuild the enum without them via the rename-and-swap recipe.
-- =====================================================================

BEGIN;

-- 1. Remove the values from any User.managerPermissions arrays first so the
--    enum rebuild doesn't fail on orphan references.
UPDATE "User"
SET    "managerPermissions" = array_remove(
           array_remove(
               array_remove("managerPermissions", 'DELIVERY_ZONES'::"ManagerPermission"),
               'VAT'::"ManagerPermission"
           ),
           'NOTIFICATIONS'::"ManagerPermission"
       )
WHERE  'DELIVERY_ZONES' = ANY ("managerPermissions")
   OR  'VAT'            = ANY ("managerPermissions")
   OR  'NOTIFICATIONS'  = ANY ("managerPermissions");

-- 2. Rebuild ManagerPermission without the three values (rename-and-swap).
--    Skip entirely if none are present (idempotent re-run).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM   pg_enum e
        JOIN   pg_type t ON t.oid = e.enumtypid
        WHERE  t.typname = 'ManagerPermission'
        AND    e.enumlabel IN ('DELIVERY_ZONES', 'VAT', 'NOTIFICATIONS')
    ) THEN
        -- a. New enum without the three values (the pre-migration set)
        CREATE TYPE "ManagerPermission_new" AS ENUM (
            'PRODUCTS', 'ORDERS', 'CATEGORIES', 'SECTIONS',
            'BANNERS', 'CONTACT', 'SETTINGS', 'PROMO_CODES',
            'ANALYTICS', 'REGIONS', 'REVIEWS'
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
--        WHERE  migration_name = '20260720000000_manager_permissions_delivery_vat_notifications';
-- =====================================================================
