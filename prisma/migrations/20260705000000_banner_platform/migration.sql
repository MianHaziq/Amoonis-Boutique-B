-- ============================================================================
-- Banner platform targeting (mobile vs web)
--
-- Adds an optional-by-default `platform` column to BannerImage so admins can
-- target a banner at the MOBILE app or the WEB site. Web hero videos live here.
--
-- Backward-compatible / mobile-safe by design:
--   * New enum with a NOT NULL DEFAULT 'MOBILE'. Every existing row is backfilled
--     to MOBILE, so the Flutter app (which sends no platform filter and defaults
--     to MOBILE on the server) keeps receiving exactly the banners it does today.
--   * WEB banners are only returned when a client explicitly asks for platform=WEB,
--     so web-only videos can never reach the mobile app.
-- ============================================================================

-- CreateEnum
CREATE TYPE "BannerPlatform" AS ENUM ('MOBILE', 'WEB');

-- AlterTable
ALTER TABLE "BannerImage" ADD COLUMN     "platform" "BannerPlatform" NOT NULL DEFAULT 'MOBILE';

-- CreateIndex
CREATE INDEX "BannerImage_platform_idx" ON "BannerImage"("platform");
