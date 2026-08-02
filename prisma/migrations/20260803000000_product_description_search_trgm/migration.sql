-- Extends product search to also match description-block text (see
-- 20260702000000_product_search_trgm for the original title/subtitle/category
-- indexes). Same rationale: a plain ILIKE '%term%' over ProductDescription would
-- degrade to a sequential scan across every block of every product as the catalog
-- grows; a GIN trigram index lets Postgres serve it from an index instead.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "ProductDescription_description_trgm_idx"
  ON "ProductDescription" USING gin ("description" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "ProductDescription_description_ar_trgm_idx"
  ON "ProductDescription" USING gin ("description_ar" gin_trgm_ops);
