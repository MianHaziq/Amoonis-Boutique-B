-- ============================================================================
-- Manager permissions: USERS, MANAGERS
--
-- Two granular manager-permission keys that open up the previously admin-only
-- /admin/users section to delegation:
--
--   * USERS    — manage CUSTOMER accounts (list/view/create/edit/status/delete).
--   * MANAGERS — manage MANAGER accounts, including creating new managers and
--                assigning their permissions ("make more managers").
--
-- ADMIN accounts remain untouchable by any manager regardless of permissions —
-- enforced in application code (user.controller.js), not by the enum. Neither
-- key ever grants access to ADMIN rows or the ability to set role=ADMIN.
--
-- Additive only, idempotent — existing managerPermissions arrays are untouched.
-- No backfill: nothing references these keys until the app code (this same
-- change) starts checking for them.
-- ============================================================================

-- AlterEnum
ALTER TYPE "ManagerPermission" ADD VALUE IF NOT EXISTS 'USERS';
ALTER TYPE "ManagerPermission" ADD VALUE IF NOT EXISTS 'MANAGERS';
