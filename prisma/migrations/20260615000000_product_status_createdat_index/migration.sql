-- Performance: the storefront product listing filters by status and sorts by createdAt
-- (WHERE status='PUBLISHED' ORDER BY "createdAt" DESC). A composite (status, createdAt)
-- index lets Postgres satisfy both the filter and the sort from one index scan. Its
-- leftmost prefix also covers plain status-equality filters/counts, so the standalone
-- status index is redundant and dropped.
DROP INDEX IF EXISTS "Product_status_idx";
CREATE INDEX "Product_status_createdAt_idx" ON "Product"("status", "createdAt");
