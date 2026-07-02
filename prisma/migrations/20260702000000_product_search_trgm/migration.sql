-- Fast product search.
-- Storefront search matches user text against product title/subtitle (EN + AR).
-- A plain ILIKE '%term%' can't use a btree index and degrades to a sequential scan
-- as the catalog grows. pg_trgm + GIN trigram indexes let Postgres serve those
-- substring/fuzzy matches from an index, keeping search fast at scale. Trigrams are
-- language-agnostic, so the same approach covers Arabic text.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- One GIN trigram index per searchable text column. IF NOT EXISTS keeps the
-- migration safe to re-run. These accelerate the case-insensitive ILIKE '%q%'
-- (and similarity) filters the search endpoint issues.
CREATE INDEX IF NOT EXISTS "Product_title_trgm_idx"
  ON "Product" USING gin ("title" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Product_title_ar_trgm_idx"
  ON "Product" USING gin ("title_ar" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Product_subtitle_trgm_idx"
  ON "Product" USING gin ("subtitle" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Product_subtitle_ar_trgm_idx"
  ON "Product" USING gin ("subtitle_ar" gin_trgm_ops);

-- Category name search (a product query like "women" should surface its category too).
CREATE INDEX IF NOT EXISTS "Category_title_trgm_idx"
  ON "Category" USING gin ("title" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Category_title_ar_trgm_idx"
  ON "Category" USING gin ("title_ar" gin_trgm_ops);
