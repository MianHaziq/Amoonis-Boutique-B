-- ============================================================================
-- Region legal citations
--
-- Per-region legal citations (governing law jurisdiction, VAT law, data
-- protection law + authority, IP law, consumer protection law + authority,
-- standards authority) shown across the 5 storefront legal pages (Privacy,
-- Terms, Refund Policy, Shipping Policy, Product Disclaimer). Every one of
-- these pages hardcoded UAE-specific law citations directly in the page
-- content; a newly-created region (e.g. Morocco) showed the same UAE
-- citations verbatim, which is factually wrong for that region.
--
-- All 18 columns nullable at the DB level (additive, no NOT NULL — regions
-- created before this migration, and any created after via a path that
-- bypasses the new required-field validation, simply have no value here).
-- The application layer is where "required" is enforced:
--   - Amoonis-Boutique-B/src/services/region.service.js `createRegion` now
--     rejects a new region without all 18 fields set.
--   - Amoon-Bloom-F/src/features/location/regionContact.ts falls back to
--     generic, non-country-specific wording (never another region's specific
--     citation) for any existing region missing a value.
--
-- UAE is seeded below with the EXACT text the 5 legal pages hardcoded before
-- this migration, so the live UAE pages render byte-identical after the
-- frontend is switched over to read these fields instead of literal strings.
-- ============================================================================

-- AlterTable
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "registrationCity" TEXT;
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "registrationCity_ar" TEXT;
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "currencyDisplayName" TEXT;
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "currencyDisplayName_ar" TEXT;
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "vatLawName" TEXT;
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "vatLawName_ar" TEXT;
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "dataProtectionLawName" TEXT;
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "dataProtectionLawName_ar" TEXT;
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "dataProtectionAuthority" TEXT;
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "dataProtectionAuthority_ar" TEXT;
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "ipLawName" TEXT;
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "ipLawName_ar" TEXT;
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "consumerProtectionLawName" TEXT;
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "consumerProtectionLawName_ar" TEXT;
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "consumerProtectionAuthority" TEXT;
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "consumerProtectionAuthority_ar" TEXT;
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "standardsAuthority" TEXT;
ALTER TABLE "Region" ADD COLUMN IF NOT EXISTS "standardsAuthority_ar" TEXT;

-- Data migration: seed UAE with the exact text the legal pages hardcoded
-- before this change, so nothing visibly changes for the live UAE region.
UPDATE "Region" SET
  "registrationCity" = 'Dubai',
  "registrationCity_ar" = 'دبي',
  "currencyDisplayName" = 'UAE Dirhams (AED)',
  "currencyDisplayName_ar" = 'الدرهم الإماراتي',
  "vatLawName" = 'UAE Federal Decree-Law on Value Added Tax',
  "vatLawName_ar" = 'المرسوم بقانون اتحادي بشأن ضريبة القيمة المضافة',
  "dataProtectionLawName" = 'UAE Federal Decree-Law No. 45 of 2021 on the Protection of Personal Data (PDPL)',
  "dataProtectionLawName_ar" = 'المرسوم بقانون اتحادي رقم 45 لسنة 2021 بشأن حماية البيانات الشخصية (PDPL)',
  "dataProtectionAuthority" = 'UAE Data Office',
  "dataProtectionAuthority_ar" = 'مكتب البيانات الإماراتي',
  "ipLawName" = 'UAE Federal Law No. 38 of 2021 on Intellectual Property Rights',
  "ipLawName_ar" = 'القانون الاتحادي رقم 38 لسنة 2021 بشأن الحقوق المعنوية',
  "consumerProtectionLawName" = 'UAE Federal Law No. 15 of 2020 on Consumer Protection',
  "consumerProtectionLawName_ar" = 'القانون الاتحادي الإماراتي رقم 15 لسنة 2020 بشأن حماية المستهلك',
  "consumerProtectionAuthority" = 'UAE Ministry of Economy Consumer Protection Department',
  "consumerProtectionAuthority_ar" = 'إدارة حماية المستهلك في وزارة الاقتصاد الإماراتية',
  "standardsAuthority" = 'Emirates Authority for Standardisation and Metrology (ESMA)',
  "standardsAuthority_ar" = 'هيئة الإمارات للمواصفات والمقاييس (ESMA)'
WHERE "code" = 'UAE';
