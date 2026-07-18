-- Seed Saudi Arabia's default delivery zones (its 13 administrative regions —
-- there's no "emirate" concept in KSA, this is the equivalent granularity).
-- Looked up dynamically by region code, admin can rename/add/remove freely.
INSERT INTO "DeliveryZone" (id, "regionId", name, "sortOrder", "updatedAt")
SELECT gen_random_uuid(), r.id, zone.name, zone.sort, now()
FROM "Region" r, (VALUES
  ('Riyadh', 0), ('Makkah', 1), ('Madinah', 2), ('Eastern Province', 3),
  ('Asir', 4), ('Tabuk', 5), ('Hail', 6), ('Northern Borders', 7),
  ('Jazan', 8), ('Najran', 9), ('Al Bahah', 10), ('Al Jouf', 11), ('Al Qassim', 12)
) AS zone(name, sort)
WHERE r.code = 'SA'
ON CONFLICT ("regionId", name) DO NOTHING;
