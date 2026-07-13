# Guest Checkout — Mobile App Integration Guide

**Audience:** Mobile app developer
**Date:** 2026-07-10
**TL;DR:** Customers can now place an order **without logging in**. There is a new public endpoint `POST /api/v1/orders/guest-checkout`. Everything else (pricing, promo, inventory, order status, COD) works exactly like the authenticated checkout. When a guest later creates an account (or signs in) with the **same email**, their guest orders are automatically linked to that account and appear in their order history.

**Nothing about the existing authenticated flow changed.** All the changes are additive and backward compatible — the app will keep working as-is until you decide to add the guest path.

---

## 1. What changed on the backend

1. **New endpoint** `POST /api/v1/orders/guest-checkout` — place an order with **no auth token**.
2. **Order object** now has these additional fields (present everywhere an order is returned):
   - `userId` is now **nullable** — it is `null` for guest orders (previously always a string).
   - `guestName`, `guestPhone`, `guestEmail` — the guest's contact snapshot (all `null` for normal logged-in orders).
3. **Coupon preview** `POST /api/v1/promo-codes/validate` now works **without a token** (guests can preview a discount). Authenticated behaviour is unchanged.
4. **Account linking** — on signup / signin / Google / Apple login, any guest orders that used the **same email** are automatically attached to the account.

> ⚠️ **Only change you must handle defensively:** `order.userId` can now be `null`. If your models/parsers assume it is always non-null, make it optional/nullable. All the other new fields are optional additions you can ignore until you build the guest flow.

---

## 2. New endpoint — `POST /api/v1/orders/guest-checkout`

Place an order as an unauthenticated guest.

| | |
|---|---|
| **Method / Path** | `POST /api/v1/orders/guest-checkout` |
| **Auth** | ❌ None — **do not** send an `Authorization` header |
| **Headers** | `Content-Type: application/json`, `X-Region: UAE` (or `SA`) — same region header you already send elsewhere; controls currency/catalog |
| **Payment** | Always **COD** (Cash on Delivery). Online payment is not available for guests. |

### Request body

```jsonc
{
  "items": [                       // REQUIRED, non-empty. Guests have no server cart,
    { "productId": "uuid", "quantity": 2, "message": "optional gift note" },
    { "productId": "uuid", "quantity": 1 }
  ],
  "shippingAddress": {             // REQUIRED
    "fullName": "Ahmed Al Mansouri",   // REQUIRED
    "phone": "+971501234567",          // REQUIRED
    "streetAddress": "Villa 14, Al Wasl Road", // REQUIRED
    "city": "Dubai",                   // REQUIRED
    "apartment": "Apt 2",              // optional
    "state": "Dubai",                  // optional
    "postalCode": "00000",             // optional
    "country": "United Arab Emirates"  // optional
  },
  "email": "guest@example.com",    // OPTIONAL — highly recommended (see §4)
  "orderMessage": "Please call before delivery", // optional, order-level note
  "promoCode": "SAVE10"            // optional
}
```

**Field rules:**
- `items[].productId` — must be a valid UUID of a **published**, in-stock product.
- `items[].quantity` — integer ≥ 1.
- `shippingAddress.fullName` / `phone` / `streetAddress` / `city` — **required and non-empty** (validated server-side; enforce in the UI too).
- `email` — optional but **strongly recommended**: it (a) sends the order-confirmation email and (b) is the key that links this order to an account if the customer signs up later. If you collect it, send it; otherwise omit it.
- `promoCode` — optional. `newUsersOnly` codes are **rejected for guests** (a guest is not a registered new user); all other codes work.

### Success response — `201 Created`

The `data` object is the **exact same order shape** returned by the authenticated `POST /orders/checkout` — same `items[].product` snapshot, same totals — plus the guest fields and `userId: null`.

```jsonc
{
  "success": true,
  "message": "Order placed successfully",
  "data": {
    "id": "21f3a575-a556-44fb-971b-686aee5f6198",
    "orderNumber": 1047,               // human-friendly number to show the customer
    "userId": null,                    // <-- null for guest orders
    "guestName": "Ahmed Al Mansouri",
    "guestPhone": "+971501234567",
    "guestEmail": "guest@example.com",
    "orderMessage": "Please call before delivery",
    "totalAmount": 698,
    "discountAmount": null,             // set when a promo is applied (see below)
    "appliedPromoCode": null,
    "paymentMethod": "COD",
    "paymentStatus": "UNPAID",
    "status": "PENDING",                // COD orders are placed instantly as PENDING
    "currency": "AED",
    "regionId": "43b90023-...",
    "shippingAddress": {
      "fullName": "Ahmed Al Mansouri",
      "phone": "+971501234567",
      "streetAddress": "Villa 14, Al Wasl Road",
      "apartment": "Apt 2",
      "city": "Dubai",
      "state": "Dubai",
      "postalCode": "00000",
      "country": "United Arab Emirates"
    },
    "inventoryDeducted": true,
    "createdAt": "2026-07-10T10:12:19.637Z",
    "updatedAt": "2026-07-10T10:12:19.637Z",
    "items": [
      {
        "id": "2e0878a9-...",
        "productId": "f773da9d-...",
        "product": { /* full product snapshot: id, title, title_ar, image, images[],
                        descriptions[], productOptions[] — identical to authed checkout */ },
        "quantity": 2,
        "perProductMessage": null,
        "price": 299                    // unit price captured at order time
      }
      // ...more items
    ]
  }
}
```

### Success response WITH a promo code — `201`

```jsonc
{
  "success": true,
  "message": "Order placed successfully",
  "data": {
    "orderNumber": 1048,
    "userId": null,
    "totalAmount": 269.1,          // subtotal - discount (no shipping, no tax)
    "discountAmount": 29.9,
    "appliedPromoCode": "SAVE10",
    "status": "PENDING",
    "paymentMethod": "COD"
    // ...same shape as above
  }
}
```

> Total is always `subtotal − discount`. There is **no shipping fee and no tax** in the system (same as the authenticated flow).

### Error responses — `400`

**a) Field validation error** (missing/invalid input) — has an `errors` array:

```jsonc
{
  "success": false,
  "message": "Validation failed",
  "errors": [
    { "field": "shippingAddress.fullName", "message": "Full name is required" }
  ]
}
```

**b) Business rule error** (out of stock, unavailable product, invalid promo, empty items) — plain message, no `errors` array:

```jsonc
{ "success": false, "message": "Luxury Self-Care Box: only 0 in stock (you requested 1)" }
```

Other example messages you may get (HTTP 400): `"A product in your order is no longer available"`, `"This promo code has expired"`, `"This promo code is only available to new customers"`, `"Minimum order amount of 500 is required to use this promo code"`.

> **Parsing tip:** always read `message` for the user-facing text. If `errors[]` is present, it's a field-level validation failure; otherwise it's a single business error in `message`.

---

## 3. Coupon preview for guests — `POST /api/v1/promo-codes/validate`

Optional. Use this to show the discount **before** placing the order (same as your logged-in flow). It now accepts requests **with or without** a token.

**Request** (guests send `items` in the body since they have no server cart):

```jsonc
{ "code": "SAVE10", "items": [ { "productId": "uuid", "quantity": 1 } ] }
```

**Success — `200`:**

```jsonc
{
  "success": true,
  "message": "Promo code is valid",
  "data": {
    "promoCode": { "id": "...", "code": "SAVE10", "discountType": "PERCENTAGE",
                   "discountValue": 10, "appliesTo": "ALL_PRODUCTS",
                   "newUsersOnly": false, "newUserWithinDays": null },
    "cartSubtotal": 299,
    "eligibleSubtotal": 299,
    "discountAmount": 29.9,
    "total": 269.1,
    "eligibleProductIds": ["f773da9d-..."]
  }
}
```

**Invalid code — `404`** (or `400` with the specific reason):

```jsonc
{ "success": false, "message": "Promo code not found" }
```

> Behaviour matches your existing usage: **a resolved (200) response = the code is valid and applied**; a `400/404` carries the reason in `message`. Then send the same `promoCode` string in the guest-checkout body — the server re-validates and applies it at order time.

---

## 4. Account linking (guest order → account)

When a customer creates an account **or** signs in with an email that matches a guest order's `email`, the server automatically sets that order's `userId` to their account and it appears in their order history. This happens on:

- `POST /auth/signup` (email + password)
- `POST /auth/signin`
- `POST /auth/google`
- `POST /auth/apple`

No extra API call is needed — it's automatic and best-effort. **Email is the linking key** (email is unique and collected at signup; phone is not). So: **collect the guest's email at checkout whenever you can.**

**Order history after linking** — `GET /orders/history` (authenticated) now returns the previously-guest order (note `userId` is now set, and the guest snapshot is retained for reference):

```jsonc
[
  {
    "id": "21f3a575-...",
    "userId": "bf80af53-...",           // now linked to the account
    "guestName": "Ahmed Al Mansouri",   // snapshot retained
    "guestPhone": "+971501234567",
    "guestEmail": "guest@example.com",
    "totalAmount": 698,
    "currency": "AED",
    "status": "PENDING",
    "itemCount": 2,
    "createdAt": "...", "updatedAt": "..."
  }
]
```

---

## 5. Recommended mobile flow

**Before (current app):** Browse → Add to cart → **must log in** → checkout → order.

**Now (add a guest path):**

1. Browse → Add to cart (local cart, no login needed).
2. Tap **Checkout**. Offer two options (Shopify-style):
   - **Continue as guest** → show the guest form.
   - **Sign in / Create account** → your existing auth, then the authenticated checkout you already have.
3. **Guest form** — collect:
   - Full name *(required)*
   - Phone *(required)*
   - City *(required — use a picker of supported cities; default to the first one)*
   - Street address *(required)*
   - Email *(optional but recommended)*
   - Apartment / state / postal code / country *(optional)*
   - Optional promo code (preview via `/promo-codes/validate`).
4. On **Place order** → `POST /orders/guest-checkout` with the payload from §2.
   - Disable the button / show a loader while the request is in flight to **prevent double submission**.
5. On `201` → show a **success screen** using the returned order object (§6). On `400` → show `message` (and highlight the offending field if `errors[]` is present).

**Supported cities** (client-side list — there is no city API; city is stored as free text). Default = first entry:
- **UAE (`X-Region: UAE`):** Dubai *(default)*, Abu Dhabi, Sharjah
- **Saudi Arabia (`X-Region: SA`):** Riyadh *(default)*, Jeddah, Dammam

---

## 6. Post-order success screen (guest)

Guests **cannot** call `GET /orders/:id` (it requires auth) — so **render the success screen from the order object returned by the `201`**. Don't try to re-fetch it.

Show:
- ✅ "Your order has been placed successfully" + `orderNumber` and total.
- Order summary (items, total), delivery address, COD note.
- A **create-account nudge** (this is the whole point of the flow):
  > "Create an account using the same email to easily:
  > • Track your orders • View order history • Save delivery addresses • Receive order updates • Enjoy a faster checkout next time"
- CTAs: **Create Account**, **Login**, **Continue Shopping**.

---

## 7. Rules & behaviour summary

| Topic | Guest behaviour |
|---|---|
| Auth | None. No token sent. |
| Payment | COD only (`paymentMethod` forced to `COD`). |
| Items | Sent inline in the request body (guests have no server-side cart). |
| Pricing / totals | Server-computed & trusted. Total = subtotal − discount. No shipping, no tax. |
| Inventory | Reserved atomically at order placement (`inventoryDeducted: true`); out-of-stock → `400`. |
| Order status | Starts `PENDING`; same lifecycle as authed orders (PENDING→CONFIRMED→PROCESSING→SHIPPED→DELIVERED / CANCELLED, admin-driven). |
| Promo codes | Work, except `newUsersOnly` codes (rejected for guests). Per-user usage limits are not tracked for guests. |
| Order retrieval | Guests can only see the order from the `201` response. Tracking requires creating an account. |
| Linking | Automatic on signup/signin/Google/Apple by matching `email`. |
| Notifications | Push is skipped (no device account); confirmation **email** is sent if `email` was provided. |

---

## 8. What did NOT change (safe to leave as-is)

- `POST /orders/checkout` (authenticated cart checkout) — unchanged.
- `POST /orders/buy-now` — unchanged.
- All `/auth/*`, `/cart/*`, `/user/*`, product/category endpoints — unchanged.
- `GET /orders/history`, `GET /orders/:id`, `GET /orders/:id/status` — unchanged (still auth-only; they just also carry the new optional guest fields).
- Response envelope is the same everywhere: `{ success, message, data }` on success; `{ success:false, message, errors? }` on error.

**Action item for the app:** only make sure `Order.userId` is treated as **nullable** in your models. Then build the guest checkout screen + call `POST /orders/guest-checkout`.
