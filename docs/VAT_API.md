# VAT (Tax) — API & Integration Guide

**Audience:** App developer (web + mobile)
**Date:** 2026-07-13
**Base URL:** `http://<host>:5000/api/v1` (legacy `/api/*` also works). Live docs: `/api-docs`.

**TL;DR:** VAT is configured **per region** — UAE and Saudi Arabia can each have their own rate,
inclusive/exclusive pricing, and scope. It is always **calculated server-side** at order placement;
the app never sends a tax amount, it only reads one back. There's one new public endpoint
(`GET /vat/public`) to preview the current region's rate, and every order response now carries a
VAT breakdown (`subtotalAmount`, `taxAmount`/`vatAmount`, `vatRatePercent`, `vatInclusive`).

**Nothing about the existing checkout flow changed.** You don't send anything new to place an
order — the new fields are additive on the response side only.

---

## 0. The model, in one paragraph

Each **Region** (UAE, Saudi Arabia, …) can have its own `VatConfig`: a rate (0–100%), an
`inclusive` flag, and a scope (`ALL_PRODUCTS`, `SPECIFIC_PRODUCTS`, or `SPECIFIC_CATEGORIES`). A
region with no config behaves as **VAT disabled**. When an order is placed, the server resolves the
order's region, looks up that region's VAT config, computes the tax on the net (post-discount)
taxable amount, and snapshots the result onto the `Order` and each `OrderItem`. Changing a region's
rate later never retroactively changes past orders — every order carries its own snapshot.

### ⚠️ Same region-identifier split you already know from Multi-Region

| Use | Identifier | Example | Where |
|---|---|---|---|
| **Reading VAT as the app** (storefront) | region **code** | `UAE` | `X-Region` header on `GET /vat/public` |
| **Admin: editing a region's VAT** | region **UUID** (`id`) | `"43b90023-…"` | `:regionId` path param |

Get both the code and the UUID from `GET /regions` (unchanged, already in your app).

---

## 1. Public endpoint — preview the current region's VAT

```
GET /api/v1/vat/public
Headers: X-Region: UAE      (or ?region=UAE query param; falls back to the store's default
                              region if omitted/unknown — same fallback behaviour as every
                              other region-aware endpoint you already call)
Auth:    none
```

**Response — `200`**
```jsonc
{
  "success": true,
  "message": "Public VAT config fetched successfully",
  "data": {
    "enabled": true,
    "ratePercent": 5,
    "inclusive": false,
    "appliesTo": "ALL_PRODUCTS"   // ALL_PRODUCTS | SPECIFIC_PRODUCTS | SPECIFIC_CATEGORIES
  }
}
```

This is intentionally minimal — it does **not** expose which product/category IDs are taxed when
scoped. That's catalog-scoping data the storefront doesn't need and shouldn't leak.

### Using this to preview VAT before checkout

You can only compute an **exact** client-side preview when `appliesTo === "ALL_PRODUCTS"` (the
common case):

```js
const net = Math.max(0, subtotal - discount);   // after promo discount, before VAT
let vatAmount = 0, total = net;

if (vat.enabled && vat.ratePercent > 0 && vat.appliesTo === "ALL_PRODUCTS") {
  if (vat.inclusive) {
    // Prices already include VAT — total is unchanged, we only EXTRACT the amount to display.
    vatAmount = round2(net - net / (1 + vat.ratePercent / 100));
    // total stays = net
  } else {
    // VAT is ADDED on top.
    vatAmount = round2(net * (vat.ratePercent / 100));
    total = round2(net + vatAmount);
  }
}
```

For `SPECIFIC_PRODUCTS` / `SPECIFIC_CATEGORIES`, **don't guess a number** — you don't know which
lines are taxable. Show something like *"Tax may apply to some items — confirmed once you place
your order"* and trust the real order response for the final figure. This is exactly what the web
checkout does (see `CheckoutClient.tsx`'s `vatUncertain` flag if you want a reference).

---

## 2. Admin/Manager endpoints — configure VAT per region

Auth: `Authorization: Bearer <token>` — role `ADMIN` (bypasses permission checks) or `MANAGER` with
the `SETTINGS` permission. Same auth pattern as `/settings`.

### 2.1 List every region's config

```
GET /api/v1/vat
```

```jsonc
{
  "success": true,
  "message": "VAT configs fetched successfully",
  "data": [
    {
      "regionId": "43b90023-ba50-4601-9304-7d653efa5ca0",
      "regionCode": "UAE",
      "regionName": "United Arab Emirates",
      "enabled": true,
      "ratePercent": 5,
      "inclusive": false,
      "appliesTo": "ALL_PRODUCTS",
      "productIds": [],
      "categoryIds": [],
      "updatedAt": "2026-07-13T13:22:11.097Z"
    },
    {
      "regionId": "b47ec091-a168-411b-87f1-3745ba42a757",
      "regionCode": "SA",
      "regionName": "Saudi Arabia",
      "enabled": false,
      "ratePercent": 0,
      "inclusive": false,
      "appliesTo": "ALL_PRODUCTS",
      "productIds": [],
      "categoryIds": [],
      "updatedAt": "2026-06-01T09:00:00.000Z"
    }
  ],
  "meta": { "total": 2 }
}
```

A region that's never been explicitly configured still appears here as a **disabled default**
(`enabled: false, ratePercent: 0`) — nothing is silently missing from this list.

### 2.2 Get one region's full config

```
GET /api/v1/vat/:regionId
```

Same shape as one entry above, including the scoped `productIds`/`categoryIds` — use this to
populate an edit screen for a single region.

**Error — `404`** (unknown/invalid region id):
```jsonc
{ "success": false, "message": "Region not found" }
```

### 2.3 Update one region's config

```
PUT /api/v1/vat/:regionId
Content-Type: application/json
```

**Partial update** — only send the fields you're changing:

```jsonc
{
  "enabled": true,
  "ratePercent": 5,
  "inclusive": false,
  "appliesTo": "SPECIFIC_PRODUCTS",
  "productIds": ["prod-uuid-1", "prod-uuid-2"]
}
```

Returns the updated config, same shape as §2.2.

**Field notes:**
- `ratePercent` — number, `0–100`. Sending `150` → `400 { message: "ratePercent must be a number between 0 and 100" }`.
- `inclusive` — `true` = catalogue prices already include VAT (nothing added at checkout; the
  amount is only *extracted* for reporting). `false` = VAT is added on top at checkout.
- `appliesTo` — `ALL_PRODUCTS | SPECIFIC_PRODUCTS | SPECIFIC_CATEGORIES`.
- `productIds` / `categoryIds` — **replaces** the scope list entirely when sent. Omit the field to
  leave the existing scope untouched (e.g. you can flip `enabled` off/on without re-sending the
  scope every time).
- Enabling `SPECIFIC_PRODUCTS`/`SPECIFIC_CATEGORIES` with an **empty** id list is rejected —
  `400 { message: "Select at least one product for SPECIFIC_PRODUCTS VAT" }` (or the categories
  equivalent) — this exists so you can't silently save a VAT that taxes nothing.
- Unknown `regionId` → `404 { message: "Region not found" }`.
- No/insufficient auth → `401` / `403`, same as every other admin endpoint.

---

## 3. How VAT shows up on an Order

Every endpoint that returns an order — `POST /orders/checkout`, `POST /orders/buy-now`,
`POST /orders/guest-checkout`, `GET /orders/:id`, `GET /orders/history`,
`GET /orders/admin/history` — now includes these fields on the order object:

| Field | Type | Meaning |
|---|---|---|
| `subtotalAmount` | `number \| null` | Pre-VAT, pre-discount line sum. `null` only on legacy orders placed **before** VAT existed. |
| `discountAmount` | `number \| null` | Unchanged — promo discount, applied **before** VAT. |
| `taxAmount` | `number` | The VAT amount. `0` when no VAT applied. |
| `vatAmount` | `number` | **Alias of `taxAmount`** — same value, use whichever key reads better in your code. |
| `vatRatePercent` | `number \| null` | The rate actually applied at order time (e.g. `5`). `null` when no VAT applied. |
| `vatInclusive` | `boolean` | `true` = VAT was already inside the item prices (total unaffected by it); `false` = VAT was added on top of the total. |
| `totalAmount` | `number` | The final charged/payable amount — **already includes** exclusive VAT. Unaffected by inclusive VAT (it was already in there). |

Each `OrderItem` also carries its own per-line snapshot:

| Field | Type | Meaning |
|---|---|---|
| `vatRatePercent` | `number` | This line's rate. `0` if the line fell outside a scoped VAT. |
| `vatAmount` | `number` | This line's VAT amount. `0` if untaxed. |

### Example — exclusive VAT (added on top)

```jsonc
{
  "orderNumber": 1052,
  "subtotalAmount": 299,
  "discountAmount": null,
  "taxAmount": 14.95,
  "vatAmount": 14.95,
  "vatRatePercent": 5,
  "vatInclusive": false,
  "totalAmount": 313.95,          // 299 + 14.95
  "items": [
    { "productId": "f773da9d-...", "price": 299, "quantity": 1,
      "vatRatePercent": 5, "vatAmount": 14.95 }
  ]
}
```

### Example — inclusive VAT (already in the price)

```jsonc
{
  "orderNumber": 1053,
  "subtotalAmount": 200,
  "taxAmount": 9.52,               // extracted portion, informational
  "vatAmount": 9.52,
  "vatRatePercent": 5,
  "vatInclusive": true,
  "totalAmount": 200               // unchanged — the 9.52 was already inside the 200
}
```

### Example — VAT disabled / not applicable

```jsonc
{
  "subtotalAmount": 150,
  "taxAmount": 0,
  "vatAmount": 0,
  "vatRatePercent": null,
  "vatInclusive": false,
  "totalAmount": 150
}
```

> **Rendering rule of thumb:** only show a VAT line when `vatRatePercent != null && (taxAmount > 0)`.
> Label it `"VAT (${vatRatePercent}%)"` for exclusive, or `"Includes VAT (${vatRatePercent}%)"` for
> inclusive (don't add it to the displayed total in the inclusive case — it's already in there).

**These are snapshots taken at order placement**, computed from whatever VAT config was live in
the order's region at that moment. Editing a region's rate afterwards never changes past orders —
each order is frozen at what the customer actually saw/paid.

---

## 4. Recommended app flow

1. **Cart / checkout screen:** call `GET /vat/public` with your usual `X-Region` header to preview
   tax (exact for `ALL_PRODUCTS`, a disclaimer otherwise — see §1).
2. **Place the order** exactly as you do today (`POST /orders/checkout`, `/orders/buy-now`, or
   `/orders/guest-checkout`) — **no VAT fields to send.** The server resolves the order's region and
   computes everything.
3. **Render the receipt** from the response's `subtotalAmount` / `taxAmount` (or `vatAmount`) /
   `vatRatePercent` / `vatInclusive` / `totalAmount` — this is the source of truth; always trust it
   over your own pre-order preview, since only it accounts for scoped products/categories.
4. **Order history / order detail screens** — render the same fields for a consistent breakdown;
   they're present on every order-returning endpoint listed in §3.

---

## 5. Admin app / dashboard flow (if you build a native admin screen)

1. `GET /vat` → render one row/tab per region, showing `enabled` + `ratePercent` as a quick badge
   (e.g. "5%" or "Off").
2. Selecting a region → `GET /vat/:regionId` for the full editable form (or just reuse the row from
   step 1 — it already has everything except you'd want the scoped id lists, which are also on
   that same list response).
3. Saving → `PUT /vat/:regionId` with only the changed fields.
4. If `appliesTo` is `SPECIFIC_PRODUCTS`/`SPECIFIC_CATEGORIES`, show a multi-select of products /
   categories (reuse whatever picker your promo-code screen already has — the shape is identical:
   an array of UUIDs).

The web admin reference implementation lives at `Amoonis-fr/src/components/admin/tax/VatSettingsPage.tsx`
if you want to see the exact request sequence.

---

## 6. Error responses — summary

| Scenario | Status | Body |
|---|---|---|
| Invalid rate (outside 0–100) | `400` | `{ "success": false, "message": "ratePercent must be a number between 0 and 100" }` |
| Invalid `appliesTo` value | `400` | `{ "success": false, "message": "Invalid appliesTo. Use ALL_PRODUCTS, SPECIFIC_PRODUCTS, SPECIFIC_CATEGORIES." }` |
| Enabling scoped VAT with empty id list | `400` | `{ "success": false, "message": "Select at least one product for SPECIFIC_PRODUCTS VAT" }` (or categories) |
| Unknown `regionId` | `404` | `{ "success": false, "message": "Region not found" }` |
| No/insufficient auth on admin routes | `401` / `403` | standard auth error envelope |

Response envelope is the same everywhere else in the API: `{ success, message, data }` on success;
`{ success:false, message, errors? }` on error.

---

## 7. What did NOT change (safe to leave as-is)

- Checkout request bodies — `POST /orders/checkout`, `/orders/buy-now`, `/orders/guest-checkout` —
  **unchanged**. You never send tax data.
- `POST /promo-codes/validate` — unchanged; promo discount is still computed and applied **before**
  VAT.
- All `/auth/*`, `/cart/*`, `/user/*`, product/category/region endpoints — unchanged.
- Pre-existing orders (placed before this feature shipped) simply have `subtotalAmount: null`,
  `taxAmount: 0`, `vatRatePercent: null` — treat those as "no VAT data available", not an error.

**Action item for the app:** treat `subtotalAmount` and `vatRatePercent` as nullable, render a VAT
line only when `vatRatePercent != null`, and — if you want a pre-checkout estimate — call
`GET /vat/public` and follow the math in §1.
