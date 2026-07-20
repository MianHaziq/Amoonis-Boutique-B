-- ============================================================================
-- Manager permissions: DELIVERY_ZONES, VAT, NOTIFICATIONS
--
-- Three granular manager-permission keys that the app already referenced in
-- code (routes/constants/frontend) but were never added to the Postgres enum:
--
--   * DELIVERY_ZONES — shipped with the delivery-zones feature (2026-07-18) but
--     the enum value was missed. Creating a manager with this permission would
--     have failed at write time with `invalid input value for enum`. Dormant
--     until now only because no MANAGER users exist yet (admins bypass the
--     permission check entirely).
--   * VAT — carve the Tax/VAT admin area out of the broad SETTINGS permission so
--     tax management can be delegated without granting full site settings.
--   * NOTIFICATIONS — carve the broadcast-push admin area out of SETTINGS/ORDERS
--     so an order-processing manager can no longer send marketing blasts to the
--     entire customer base.
--
-- Additive only, idempotent — existing managerPermissions arrays are untouched.
-- No backfill: there are no production managers to migrate.
-- ============================================================================

-- AlterEnum
ALTER TYPE "ManagerPermission" ADD VALUE IF NOT EXISTS 'DELIVERY_ZONES';
ALTER TYPE "ManagerPermission" ADD VALUE IF NOT EXISTS 'VAT';
ALTER TYPE "ManagerPermission" ADD VALUE IF NOT EXISTS 'NOTIFICATIONS';
