# Multi-Region + Draft — Complete Integration Guide

_Last updated: 2026-06-15. Backend: Amoon Bloom API (Express + Prisma + PostgreSQL)._
_Base URL: `http://<host>:5000/api/v1` (legacy `/api/*` also works). Live docs: `/api-docs`._

This guide covers **both sides**:
- **Admin side** — how you create/mark content (draft vs published, which region(s) it shows in).
- **Storefront (app) side** — how the user app reads region-scoped content.

---

## 0. The two concepts

1. **Region** — currently **UAE** and **Saudi Arabia (SA)**. Regions are **data, not hardcoded** —
   admins can add Kuwait, Qatar, etc. later with no code change. Always fetch them from `GET /regions`.
2. **Publish status** — every content item is **`DRAFT`** (hidden from the app) or **`PUBLISHED`** (live).
   New items default to **DRAFT**.

### ⚠️ Two different region identifiers — don't mix them up
| Use | Identifier | Example | Where |
|---|---|---|---|
| **Marking content** (create/update bodies) | region **UUID** (`id`) | `"7c2e…-uuid"` | `regionIds` array |
| **Reading as the app** | region **code** | `UAE` | `X-Region` header |
| **Admin filtering** | region **code** | `SA` | `?region=` query |

So: to **mark** a product for UAE you put UAE's **`id`** in `regionIds`. To **read** the UAE catalog you
send `X-Region: UAE`. Get both `id` and `code` from `GET /regions`.

---

## 1. Standard response envelope
```json
{ "success": true, "message": "…", "data": <payload>, "meta": { "pagination": {…} } }
```
Errors: `{ "success": false, "message": "…", "errors": [ { "field": "…", "message": "…" } ] }`.

---

## 2. Regions API

### `GET /regions` — list regions
- **Public** (no token): returns **active** regions only — use for the app's region picker.
- **Admin/manager token**: returns **all** regions (incl. inactive).
```json
{ "success": true, "message": "Regions fetched successfully",
  "data": [
    { "id": "uae-uuid", "code": "UAE", "name": "United Arab Emirates", "name_ar": "الإمارات العربية المتحدة", "isDefault": true,  "isActive": true, "sortOrder": 0 },
    { "id": "sa-uuid",  "code": "SA",  "name": "Saudi Arabia",         "name_ar": "المملكة العربية السعودية", "isDefault": false, "isActive": true, "sortOrder": 1 }
  ],
  "meta": { "total": 2 } }
```
- `isDefault: true` → used when the app sends no/unknown `X-Region`.
- **Keep `id` ↔ `code` mapping** in the admin UI: you show `name`, send `id` in `regionIds`, send `code` in `X-Region`.

### Manage regions (admin only — `SETTINGS` permission; admins bypass)
| Method | Path | Body |
|---|---|---|
| POST | `/regions` | `{ "code": "KW", "name": "Kuwait", "name_ar": "الكويت", "isActive": true, "sortOrder": 2, "isDefault": false }` |
| PUT | `/regions/:id` | any subset of the above; `isDefault:true` unsets the previous default |
| DELETE | `/regions/:id` | — (blocked **409** if it's the default or still used by products/users/orders) |

`code` and `name` are required on create. `code` is uppercased and must be unique (409 if dup).

---

## 3. How content is marked — `status` + `regionIds`

**Every** content create/update endpoint (products, categories, banners, sections) accepts the same
two fields:

| Field | Type | Meaning | Default if omitted |
|---|---|---|---|
| `status` | `"DRAFT"` \| `"PUBLISHED"` | Draft = hidden from app; Published = live | `"DRAFT"` |
| `regionIds` | array of region **UUIDs** | Which regions the item shows in | the **default region only** |

### The "which region" options map directly to `regionIds`:
| Admin choice | Send |
|---|---|
| **Show in both regions** | `"regionIds": ["<uaeId>", "<saId>"]` |
| **Show in UAE only** | `"regionIds": ["<uaeId>"]` |
| **Show in Saudi only** | `"regionIds": ["<saId>"]` |
| **Default (UAE only)** | omit `regionIds` |

### The "draft / publish" options map to `status`:
| Admin choice | Send |
|---|---|
| **Save as draft** (hidden) | `"status": "DRAFT"` (or omit — it's the default) |
| **Publish** (go live) | `"status": "PUBLISHED"` |

> Suggested admin UI: a **publish toggle** (Draft/Published) + a **region multi-select** (checkboxes
> "UAE" / "Saudi Arabia", default UAE) on every create/edit form. On submit, map the checked regions to
> their `id`s and send as `regionIds`. On **update**, sending `regionIds` **replaces** the whole set.

**Validation errors:**
- `status` not DRAFT/PUBLISHED → `400`.
- `regionIds` not an array, or a value isn't a UUID → `400`.
- A UUID that isn't a real region → `400` `"Unknown region id(s): …"`.

---

## 4. Products

### Create — `POST /products` (admin, `PRODUCTS` permission)
```json
{
  "title": "Summer Dress",
  "title_ar": "فستان صيفي",
  "subtitle": "Light cotton",
  "price": 49.99,
  "discountedPrice": 39.99,
  "quantity": 10,
  "categoryId": "category-uuid",
  "images": ["https://cdn/…1.jpg", "https://cdn/…2.jpg"],
  "descriptions": [ { "title": "Materials", "description": "100% cotton", "description_ar": "١٠٠٪ قطن" } ],
  "productOptions": [ { "title": "Size", "options": ["S","M","L"], "options_ar": ["صغير","وسط","كبير"] } ],

  "status": "PUBLISHED",                 // ← draft/publish
  "regionIds": ["uae-uuid", "sa-uuid"]   // ← both regions; use one id for single-region
}
```
- `title` (or `title_ar`) and `price` are required. Everything else optional.
- Arabic fields auto-translate if you send only one language.
- Omit `status` → DRAFT. Omit `regionIds` → UAE (default) only.

### Update — `PUT /products/:id`
Send only the fields you're changing. `status` / `regionIds` behave the same; **`regionIds` replaces**
the product's region set. Examples:
```json
{ "status": "PUBLISHED" }                       // just publish it
{ "regionIds": ["sa-uuid"] }                    // move it to Saudi-only
{ "regionIds": ["uae-uuid", "sa-uuid"], "status": "PUBLISHED" }  // both regions + live
{ "price": 44.99, "quantity": 25 }              // normal edits, region/status untouched
```

### Admin read response (with admin token) — includes region tags + status
```json
{ "id": "uuid", "title": "Summer Dress", "price": 49.99, "quantity": 10,
  "status": "DRAFT",
  "regionIds": ["uae-uuid", "sa-uuid"],
  "regions": [ { "id": "uae-uuid", "code": "UAE", "name": "United Arab Emirates", "name_ar": "…" },
               { "id": "sa-uuid",  "code": "SA",  "name": "Saudi Arabia", "name_ar": "…" } ],
  "category": { "id": "uuid", "title": "Women" }, "images": [...], "descriptions": [...], "productOptions": [...] }
```

### Delete — `DELETE /products/:id` (409 if it's in active orders).

---

## 5. Categories — `POST/PUT /categories` (admin, `CATEGORIES`)
Same `status` + `regionIds` pattern.
```json
{ "title": "Women", "title_ar": "نساء", "description": "Women collection",
  "image": "https://…",
  "status": "PUBLISHED",
  "regionIds": ["uae-uuid", "sa-uuid"] }
```
Admin read adds `status`, `regions`, `regionIds`. `DELETE /categories/:id` is blocked (400) if it has products.

---

## 6. Banners — `/banners` (admin, `BANNERS`)

### Add — `POST /banners` (one or many; `status`/`regionIds` apply to all added)
```json
{ "url": "https://…/banner.jpg", "status": "PUBLISHED", "regionIds": ["uae-uuid"] }
```
or multiple:
```json
{ "urls": ["https://…/a.jpg", "https://…/b.jpg"], "status": "DRAFT", "regionIds": ["uae-uuid","sa-uuid"] }
```

### Edit a single banner — `PUT /banners/:id` (new)
Change `url`, `status`, and/or `regionIds`:
```json
{ "status": "PUBLISHED", "regionIds": ["sa-uuid"] }
```

### Reorder — `PATCH /banners/order` `{ "order": ["bannerId1","bannerId2", …] }`
### Delete — `DELETE /banners/:id`

Admin read of `GET /banners` (with token) returns every banner across all regions with `status` + `regions` + `regionIds`.

---

## 7. Sections (home blocks) — `/sections` (admin, `SECTIONS`)

### Create — `POST /sections`
```json
{
  "title": "Ramadan Deals",
  "title_ar": "عروض رمضان",
  "image": "https://…",
  "productIds": ["prod-uuid-1", "prod-uuid-2"],
  "categoryIds": ["cat-uuid-1"],
  "status": "PUBLISHED",
  "regionIds": ["uae-uuid", "sa-uuid"]
}
```
- `title` (or `title_ar`) required. `productIds`/`categoryIds` ordered = display order.
- `status` + `regionIds` mark the **section itself**.

### Update — `PUT /sections/:id`
Send any subset. Sending `productIds`/`categoryIds` **replaces** the lists; sending `regionIds` replaces the region set.

### Region behavior (important)
A section in **both** regions can still contain a UAE-only product. The backend **double-filters** for the
storefront: an SA user sees the section only if it's in SA, **and** only the products/categories inside it
that are themselves in SA + published. Admins (token) see everything unfiltered. You don't manage this —
it's automatic.

---

## 8. Storefront (the user app) — send `X-Region`

The app does **not** send a token for catalog reads. It sends the header **`X-Region: UAE`** (or `SA`,
a `code` from `GET /regions`). The backend returns **only PUBLISHED items in that region**. Missing/unknown
header → default region (UAE). Drafts/out-of-region items are excluded from lists and return **404** on detail.

| Method | Path | Behavior |
|---|---|---|
| GET | `/products?page=1&limit=10` | region + published list |
| GET | `/products/:id` | 404 if draft/out-of-region |
| GET | `/products/category/:categoryId` | region + published list |
| GET | `/categories`, `/categories/:id` | region + published |
| GET | `/banners` | region + published, ordered |
| GET | `/sections`, `/sections/:id` | region + published; nested products/categories also filtered |

**Storefront payload note:** responses **omit** `regions`/`regionIds` (the app already filtered; those are
admin-only). `status` will always be `PUBLISHED` for anything the app receives. All other fields
(title/title_ar, price, images, descriptions, productOptions, etc.) are exactly as before.

**Example product (storefront):**
```json
{ "id": "uuid", "title": "Summer Dress", "title_ar": "فستان صيفي", "price": 49.99, "discountedPrice": 39.99,
  "quantity": 10, "status": "PUBLISHED", "category": { "id": "uuid", "title": "Women" },
  "image": "https://…1.jpg", "images": ["https://…1.jpg","https://…2.jpg"],
  "descriptions": [...], "productOptions": [...] }
```

---

## 9. Users — region capture & filtering

- **Signup** (`POST /auth/signup`, `/auth/google`, `/auth/apple`): send `X-Region` → the new account is
  tagged with that region. Response `data.user` includes `regionId`.
- **Profile** (`GET /user/profile`): now returns `regionId` + `region` `{ id, code, name, name_ar }`.
  Use `region.code` as the logged-in user's default `X-Region`.
- **Admin user list** (`GET /users`): supports `?region=CODE` (or region UUID) filter; each user row
  includes its `region`. Admin can reassign via `PUT /users/:id` with `{ "regionId": "<uuid>" }` (or
  `{ "region": "SA" }`).

---

## 10. Orders — region capture
`POST /orders/checkout`: send `X-Region` → the order is stamped with that region (for analytics). Request
body unchanged. Falls back to the user's region, then default, if the header is absent.

---

## 11. Analytics (admin dashboard) — region-aware

All four analytics endpoints accept an optional `?region=CODE` filter. **Omit it for the combined
"both / mixed" view** (the default — this is the current behavior, unchanged).

| Endpoint | Purpose |
|---|---|
| `GET /admin/analytics/revenue?preset=all_time` | revenue summary + time series + status breakdown |
| `GET /admin/analytics/kpi?preset=month` | KPI totals (orders, revenue, AOV, units, customers) |
| `GET /admin/analytics/revenue/by-category?preset=year` | sales grouped by category |
| `GET /admin/analytics/sales/by-day?preset=week` | per-day (or per-month for all_time) sales |

Add `&region=UAE` or `&region=SA` to scope. The response echoes the applied filter in
`data.range.region` (`null` = combined). Suggested dashboard UI: a **region selector with
"All (combined) / UAE / Saudi Arabia"**.

Example:
```
GET /admin/analytics/revenue?preset=all_time            → combined (range.region = null)
GET /admin/analytics/revenue?preset=all_time&region=SA  → Saudi only (range.region = "SA")
```
Auth: admin token, or manager with `ORDERS` or `SETTINGS` permission.

---

## 12. Permissions summary (managers; admins bypass all)
| Area | Permission key |
|---|---|
| Products | `PRODUCTS` |
| Categories | `CATEGORIES` |
| Banners | `BANNERS` |
| Sections | `SECTIONS` |
| Regions | `SETTINGS` |
| Analytics | `ORDERS` or `SETTINGS` |

---

## 13. Backward compatibility
- Existing products/categories/banners/sections were backfilled to **PUBLISHED + both regions** — nothing
  disappeared. Existing users/orders were assigned the default region.
- `X-Region` is optional everywhere; old app builds keep working on the default region.

---

## 14. Integration checklist
**Admin panel**
- [ ] Region multi-select (checkboxes, default UAE) + Draft/Published toggle on every product/category/banner/section form.
- [ ] Map checked regions → region `id`s → `regionIds` on submit.
- [ ] Region management screen (`/regions` CRUD).
- [ ] Region filter (`?region=`) + status filter (`?status=`) on admin lists.
- [ ] Analytics region selector (All / UAE / SA via `?region=`).

**Mobile app**
- [ ] Global interceptor attaches `X-Region: <code>`.
- [ ] `GET /regions` → region picker; persist; switcher in Settings refreshes catalog.
- [ ] Default region from `GET /user/profile` → `region.code` for logged-in users.
- [ ] Send `X-Region` on signup + checkout.
- [ ] Handle 404 on detail screens as "not available in your region".

---

## 15. Verify before shipping (please do this end-to-end)
1. Create a product as **DRAFT, UAE only** → app (X-Region: UAE) must **not** see it; admin must see it.
2. Publish it → app (UAE) sees it; app (SA) does **not**.
3. Create a **Saudi-only** published product → visible with `X-Region: SA`, hidden with `X-Region: UAE`.
4. Section in both regions containing a UAE-only product → SA user sees the section **without** that product.
5. Banner draft → hidden; publish + UAE-only → shows for UAE, hidden for SA.
6. Signup with a region → profile shows the right region; checkout with region → order completes.
7. No `X-Region` header → app still works on the default region.
8. Analytics: combined vs `?region=UAE` vs `?region=SA` return sensible, scoped numbers.
9. **UI must be professional & polished:** clean region multi-select + publish toggle in admin; clean
   region switcher, RTL Arabic (`*_ar` fields), loading skeletons, and empty states ("No items in your
   region yet") in the app. Test **both languages and both regions** before release.
