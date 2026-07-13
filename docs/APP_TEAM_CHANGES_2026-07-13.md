# Backend Changes — Week of 2026-07-06 to 2026-07-13 — App Team Brief

**Base URL:** all endpoints below are under `/api/v1/...` (legacy unversioned mirrors `/api/...` also work, same routers, same behavior — migrate to `/api/v1` going forward).

**Response envelope (unchanged, applies to every endpoint in this doc):**
```json
// success
{ "success": true, "message": "string", "data": { }, "meta": { } }
// error
{ "success": false, "message": "string", "errors": [ { "field": "string", "message": "string" } ] }
```

## Summary — what needs action vs. what's invisible

| # | Area | App impact |
|---|---|---|
| 1 | `GET /products/search` | **New — adopt for search UI.** No breaking change. |
| 2 | Product & section reorder (admin) | None for app — admin panel only. List ordering may change subtly (see below). |
| 3 | Colour swatches + multi-image variants | **New fields, additive.** Old clients keep working; adopt `optionColors`/`optionImageSets` for a richer variant picker. |
| 4 | Web/App banner platform split | **Action required only for the website team** — must send `?platform=WEB`. Mobile app is unaffected (defaults to `MOBILE`). |
| 5 | Multi-region pricing & currency (UAE/AED + SA/SAR) | **Action required** — must send `X-Region` header; new `currency` fields on cart/order; SAR customers restricted to Cash on Delivery for now. |
| 6 | FCM push notifications, device tokens, preferences | **New — adopt for push.** New endpoints, no breaking change to anything existing. |
| 7 | Staff "new order" alerts | None — internal/admin-only, no new endpoint for app. |
| 8 | **Apple Pay `pay-session` endpoint hardened** | **BREAKING — action required.** Response contract for `POST /orders/:id/pay-session` changed. |
| 9 | Scheduled email reports + rich order confirmation email | None — email-only, no API/response change. |

---

## 1. Product search — `GET /api/v1/products/search` (NEW)

Fast, typo-tolerant search backed by Postgres trigram indexes (was previously unavailable — client had to filter client-side or hit `/products` with no search support).

- **Auth:** Public. Optional `Authorization: Bearer <token>` — if a valid admin/manager token is sent, results include drafts.
- **Headers:** `X-Region: <code>` (e.g. `UAE`, `SA`) — scopes results to published products in that region for normal shoppers. See §5 for the full region system.
- **Query params:**
  | Param | Type | Required | Notes |
  |---|---|---|---|
  | `q` | string, max 100 chars | optional | Empty/omitted → `data: []`, not the full catalog. |
  | `page` | int ≥ 1 | optional, default 1 | |
  | `limit` | int 1–100 | optional, default 10 | |

- **Matching:** case-insensitive substring match across `title`, `title_ar`, `subtitle`, `subtitle_ar`, and the product's category title (EN/AR).
- **Response `200`:**
```json
{
  "success": true,
  "message": "Products fetched successfully",
  "data": [ /* product objects — identical shape to GET /products, see §3 */ ],
  "meta": {
    "pagination": { "page": 1, "limit": 10, "total": 4, "totalPages": 1 },
    "query": "<normalized q, trimmed/truncated>"
  }
}
```
- **Status codes:** `200` always on success (including empty results); `400` on validation failure (`q` too long, bad `page`/`limit`).
- **Note:** search results are ordered by `createdAt desc` — they do **not** follow the new admin-controlled `sortOrder` (see §2), since relevance/recency matters more for search than manual merchandising order.

---

## 2. Product & section reorder (admin panel only — no app-facing change)

Two new admin-only endpoints let staff manually set display order:

- `PATCH /api/v1/products/order` — body `{ "items": [{ "id": "<uuid>", "sortOrder": 0 }, ...] }`
- `PATCH /api/v1/sections/order` — same body shape, for homepage sections.

Both require an admin/manager JWT with the relevant permission (`PRODUCTS` / `SECTIONS`). Response: `{ success: true, message: "...updated successfully", data: null, meta: { count: <n> } }`. Errors: `400` invalid body, `404` if any id doesn't exist.

**What this means for the app:** `GET /products`, `GET /products/category/:id`, and section-nested products now sort by `sortOrder asc, createdAt desc` instead of pure recency. All existing products default `sortOrder: 0`, so **nothing changes until an admin manually reorders something** in the panel — after that, list order may differ from "newest first." No request/response field was removed; `sortOrder` (int) is now present on every product object, purely additive.

---

## 3. Colour swatches & multi-image variants (additive — safe to ignore, recommended to adopt)

Every `productOptions[]` item (returned on `GET /products`, `/products/:id`, `/products/category/:id`, `/products/search`, and nested in sections) now has two new fields alongside the existing `title`, `options`, `optionImages`:

```json
{
  "id": "uuid",
  "title": "Colour",
  "title_ar": "اللون",
  "options": ["Blue", "Black"],
  "options_ar": ["أزرق", "أسود"],
  "optionImages": ["https://cdn/blue-1.jpg", "https://cdn/black-1.jpg"],
  "optionColors": ["#1e3a8a", "#000000"],
  "optionImageSets": [
    ["https://cdn/blue-1.jpg", "https://cdn/blue-2.jpg"],
    ["https://cdn/black-1.jpg"]
  ]
}
```

- **`optionColors`** — array of hex strings, index-aligned with `options`. Use this to render an actual colour swatch instead of (or alongside) a photo thumbnail. Empty array if the admin hasn't set colours for that option.
- **`optionImageSets`** — array-of-arrays of image URLs, index-aligned with `options`. Lets a variant (e.g. "Blue") have **multiple** photos instead of one. `optionImages[k]` is always kept in sync as `optionImageSets[k][0]` (first photo of the set), so **old app versions that only read `optionImages` continue to work correctly** and just won't show the extra photos.
- Nothing existing was renamed or removed. No action required; upgrade the variant picker UI whenever convenient to use `optionImageSets` for a photo gallery per colour, and `optionColors` for swatch chips.

---

## 4. Web/App banner platform split

`BannerImage` now has a `platform` field: `"MOBILE"` or `"WEB"`. All existing banners were backfilled to `"MOBILE"`.

- `GET /api/v1/banners?platform=MOBILE|WEB`
- **Mobile app: no action needed.** If `platform` is omitted, the API defaults to `"MOBILE"` — exactly the same banners the app has always received.
- **Website team: action required.** The web client must explicitly send `?platform=WEB` to get web banners (including the new video-capable hero banners). If it's omitted, the web client will silently receive the mobile banner set instead of an error — so this is easy to miss in testing.
- Banner object response now includes `"platform": "MOBILE" | "WEB"` — additive field, safe to ignore if unused.

**New: `POST /api/v1/upload/video`** (admin only, for web hero banner videos) — multipart `file` field, accepts `mp4/webm/mov/avi/mkv`, up to 500MB, returns `{ "url": "https://cdn/..." }`. Not relevant to the mobile app.

---

## 5. Multi-region pricing & currency (UAE/AED + Saudi Arabia/SAR) — action required

This is the biggest change this week. The store now supports two regions with different currencies. **The app must start sending a region header on every storefront request.**

### 5.1 How to specify region
Send header **`X-Region: <code>`** on every request (e.g. `X-Region: UAE` or `X-Region: SA`). If omitted, the server silently falls back to the default region (`UAE`/`AED`) — it never errors, but the shopper may see the wrong currency/promo/products if the header is missing.

- Applies to: product list/detail/search, categories, sections, banners, cart, promo `/available` and `/validate`, and checkout (`X-Region` is read directly at checkout too).
- Recommended: read the region once at app startup / login (from user profile or a region picker) and attach `X-Region` as a default header on your HTTP client for every request.

### 5.2 List available regions — `GET /api/v1/regions`
Public, no auth needed for the active-region list.
```json
{
  "success": true,
  "data": [
    { "id": "uuid", "code": "UAE", "name": "United Arab Emirates", "currency": "AED", "isDefault": true, "isActive": true },
    { "id": "uuid", "code": "SA", "name": "Saudi Arabia", "currency": "SAR", "isDefault": false, "isActive": true }
  ]
}
```
Use this to build a region/country picker in-app.

### 5.3 Product pricing — same field names, resolved server-side
Product responses **do not** return a price list per region. `price` and `discountedPrice` are resolved to whatever region you sent in `X-Region` — no client-side currency math needed.
- `X-Region: SA` → `price`/`discountedPrice` reflect the SAR price (if the admin set one; if not, they fall back to the AED number — **not** an auto currency conversion, just a raw number, so don't assume it's converted).
- No region header / `X-Region: UAE` → AED prices as before.
- **Heads up:** the raw admin-only fields `priceSar`/`discountedPriceSar` are currently still present in the storefront JSON payload alongside the resolved `price`/`discountedPrice`. Please **ignore `priceSar`/`discountedPriceSar` in the app** and only use `price`/`discountedPrice` — we're confirming internally whether those raw fields should be stripped from non-admin responses.

### 5.4 Cart — new `currency` field
```json
{
  "id": "cart-uuid",
  "items": [ { "id": "...", "product": { "price": 79.99, "...": "..." }, "quantity": 2, "lineTotal": 159.98 } ],
  "totalAmount": 159.98,
  "currency": "AED"
}
```
`currency` is new and reflects the region you sent via `X-Region` (defaults to `AED` if not sent). Display this next to totals instead of hardcoding "AED".

### 5.5 Orders — new `currency` and `regionId` fields
Order objects (checkout response, `GET /orders/history`, `GET /orders/:id`) now include:
```json
{ "...": "...", "currency": "AED", "regionId": "uuid-or-null" }
```
Legacy orders placed before this change show `currency: "AED"` by default.

**Important restriction:** online payment (Apple Pay / card via MyFatoorah) is currently only configured for AED. If a shopper in the `SA` region tries to pay online, checkout will return:
```
400 { "success": false, "message": "Online payment isn't available for this region yet — please choose Cash on Delivery." }
```
**Action required:** for `SA`/SAR region users, either hide the online-payment option in the checkout UI or gracefully handle this 400 by falling back to Cash on Delivery. This will be lifted once a SAR-capable payment gateway is added.

### 5.6 Promo codes — now region-scoped
- `GET /promo-codes/available` only returns codes valid in the shopper's `X-Region`.
- `POST /promo-codes/validate` — new possible failure:
```
400 { "success": false, "message": "This promo code is not available in your region" }
```
Same check is re-enforced at checkout, so a promo that looked valid at cart-preview time can still fail at final checkout with this same message if something changed — handle it as a normal "promo invalid" error, same as existing invalid/expired-code handling.

### 5.7 Region-related error/status reference
| Scenario | Status |
|---|---|
| Unknown `X-Region` code | No error — silently falls back to default region (`UAE`/`AED`) |
| Admin filters by unknown `?region=` code (admin panel only) | `200` with zero results (not relevant to app) |
| Promo code not valid in shopper's region | `400`, message above |
| Online payment attempted in non-AED region | `400`, message above |

---

## 6. FCM push notifications, device tokens & preferences (new)

All endpoints below require `Authorization: Bearer <JWT>` and live under `/api/v1/user/...` and `/api/v1/notifications/...`.

### 6.1 Register device token — `POST /api/v1/user/push/token`
```json
// request
{ "fcmToken": "<fcm-token-string>", "platform": "IOS" } // platform: "IOS" | "ANDROID" | "WEB", optional, defaults to "ANDROID"
```
```json
// 200 response
{ "success": true, "message": "Device registered for push notifications", "data": { "id": "uuid", "platform": "IOS", "updatedAt": "2026-07-13T..." } }
```
- `400` if `fcmToken` missing, or `platform` sent but not one of the three allowed values.
- Idempotent: re-registering the same `fcmToken` just updates it. If the same token was previously registered to a different user (e.g. shared device, different login), it's transferred to the current user.
- **Note:** registration is keyed only by `fcmToken` — there is no separate `deviceId` concept, so call this again on every app foreground/token-refresh event (FCM tokens can rotate).

### 6.2 Unregister device token — `DELETE /api/v1/user/push/token`
```json
{ "fcmToken": "<fcm-token-string>" }
```
`200` `{ "success": true, "message": "Device unregistered" }` · `404` if token not found for this user · `400` if missing.
Call this on logout so the signed-out device stops receiving that user's pushes.

### 6.3 Get notification preferences — `GET /api/v1/user/notifications/preferences`
```json
{ "success": true, "data": { "orderStatus": true, "promotions": true, "announcements": true, "updatedAt": "..." } }
```
Defaults to all-`true` on first read (auto-created).

### 6.4 Update notification preferences — `PATCH /api/v1/user/notifications/preferences`
```json
{ "orderStatus": false } // send any subset of orderStatus/promotions/announcements
```
`200` returns the merged preferences object (same shape as GET). `400` if none of the three booleans are present in the body.
**Note:** staff "new order" alerts (§7) and account-security emails are NOT gated by these preferences — only customer-facing order-status/promo/announcement pushes respect them.

### 6.5 In-app notification inbox
- `GET /api/v1/notifications?page=1&limit=20&unreadOnly=true` → paginated list + `meta.unreadCount`
- `GET /api/v1/notifications/unread-count` → `{ "unreadCount": 5 }`
- `PATCH /api/v1/notifications/:id/read` → marks one read, `404` if not found/already read/not yours
- `POST /api/v1/notifications/read-all` → `{ "updated": 5 }`

Each notification row: `{ "id", "userId", "type", "title", "body", "data": { "type": "ORDER_STATUS", "orderId": "...", "status": "SHIPPED" }, "readAt", "createdAt" }`. Use `data.type` to deep-link (e.g. `ORDER_STATUS`/`ORDER_PLACED` → order detail screen).

### 6.6 What triggers a push
Order placed, order status change (confirmed/processing/shipped/delivered/cancelled) → pushed to the customer (respects `orderStatus` preference). No app-side action needed beyond registering the token and handling the notification tap (use `data.orderId` to navigate).

---

## 7. Staff "new order" alerts (internal — no app action)

When an order is placed, admins and permitted managers now get a push + inbox notification ("New Order — Order #1042 placed — 199 AED"). This reuses the same inbox endpoints in §6.5 (staff read their alerts the same way) — no new endpoint was added, and this doesn't affect the customer-facing app at all.

---

## 8. Apple Pay `pay-session` — BREAKING CHANGE, action required

**Endpoint:** `POST /orders/:id/pay-session` (step 2 of native Apple Pay, after `POST /orders/:id/payment-session`). Request body unchanged: `{ "sessionId": "<string>" }`.

**Old contract:** always returned HTTP 200 with `{ isPaid, orderId, status, paymentUrl }` — the app had to check the `isPaid` boolean even on a 200 response to know if payment actually succeeded.

**New contract — stop branching on `isPaid` inside a 200. HTTP status now IS the signal:**

| Status | Meaning | Body |
|---|---|---|
| **200** | Payment succeeded — show success/thank-you screen | `data: { "isPaid": true, "orderId": "...", "status": "...", "paymentStatus": "PAID" }` (note: `paymentUrl` is **no longer returned** on success; `paymentStatus` is new) |
| **402** *(new)* | Payment declined / not completed — show failure, allow retry | `{ "success": false, "message": "Payment not completed", "errors": [{ "field": "paymentUrl", "message": "<url>" }] }` — `errors` only present if a redirect URL exists; for Apple Pay it's usually absent |
| **409** *(new)* | A payment is already in progress for this order (double-tap/concurrent-execute guard) — do NOT retry immediately, show a "processing, please wait" state | `{ "success": false, "message": "A payment is already in progress for this order" }` |
| 400 | Missing `sessionId`, order not payable, already paid, or order total is zero | `{ "success": false, "message": "<reason>" }` |
| 404 | Order not found | `{ "success": false, "message": "Order not found" }` |
| 503 | Online payment not configured server-side | `{ "success": false, "message": "Online payment is not enabled" }` |
| 502 | Gateway error | `{ "success": false, "message": "<gateway error>" }` |

**Required app change:** update the Apple Pay completion handler to treat **any non-200 response (402/409/400/404/502/503) as "not paid"** and stop reading `isPaid`/`paymentUrl` from a 200 body the old way — `paymentUrl` is gone from the success shape, replaced by `paymentStatus: "PAID"`. The other two Apple Pay endpoints (`POST /orders/:id/payment-session` and the hosted-page `POST /orders/:id/pay`) are unchanged.

---

## 9. Scheduled email reports + rich order confirmation (no action needed)

Admins now get automated weekly/monthly sales-summary emails, and the order-confirmation email sent to customers is now a richer HTML template with item/shipping/payment details. **This is email-only** — no HTTP endpoint or response field changed. `POST /orders` (checkout), `GET /orders/:id`, and order history responses are byte-for-byte the same shape as before this change.

---

## Appendix — related docs already in this repo
- `docs/MULTI_REGION_INTEGRATION.md` — original region/draft-publish integration doc (predates the currency work in §5; §5 above is the delta to append).
- `docs/app-developer-notifications.md` — existing push/notifications reference, cross-checked against §6/§7 above.
- `docs/APP_DEVELOPER_GUIDE_apple_pay_flutter.md` — existing Apple Pay Flutter integration guide; needs updating for the §8 contract change.
