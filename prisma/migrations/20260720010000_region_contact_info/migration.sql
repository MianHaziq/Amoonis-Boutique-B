-- ============================================================================
-- Region contact/legal info
--
-- Per-region contact fields (email, phone, WhatsApp, address, business hours)
-- shown across the storefront: footer, homepage support section, WhatsApp
-- button, contact page, legal pages (privacy/terms/refund/shipping/product
-- disclaimer), checkout receipt, and order confirmation/status emails.
--
-- Same fallback convention as the existing Region.legalEntity field: all
-- nullable, all additive — null falls back to the frontend's
-- siteConfig.contact.* / siteConfig.legalEntity, so existing regions and every
-- call site keep rendering exactly what they show today until an admin
-- explicitly sets a region's contact info.
-- ============================================================================

-- AlterTable
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "contactEmail" TEXT;
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "contactPhone" TEXT;
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "whatsappNumber" TEXT;
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "address" TEXT;
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "address_ar" TEXT;
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "hours" TEXT;
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "hours_ar" TEXT;
