-- Drop the legacy public-form ContactMessage table. The authenticated
-- UserContact table is now the single source of contact submissions.

DROP TABLE IF EXISTS "ContactMessage";
