# Amoon Bloom — App Developer Handoff
## Complete Payment + Notification Integration (Flutter)

> One document with everything: what the backend now does, every API (with request/response),
> the three payment paths, the **Apple Pay button on the product page**, notifications, and a
> checklist of what you (app dev) build. Read top to bottom.

> ⚠️ **BREAKING CHANGE (see `APP_TEAM_CHANGES.md` for the dated entry): Order `status` values were
> renamed.** Any code matching on the old strings (`PENDING`, `AWAITING_PAYMENT`, `CONFIRMED`,
> `SHIPPED`, `DELIVERED`) must be updated — see Section 2.

---

## 0. Basics

- **Base URL:** `https://amoonbloom-backend-production.up.railway.app/api/v1`
  (local/staging may differ — same paths.)
- **Auth:** every user call needs `Authorization: Bearer <accessToken>` (from login/signup).
- **Region (optional):** send `X-Region: UAE` so prices/catalog match the region.
- **Response shape (always):**
  - Success: `{ "success": true, "message": "...", "data": {...}, "meta": {...} }`
  - Error: `{ "success": false, "message": "...", "errors": [...] }`
  - → In code: check `success`; if true read `data`; if false show `message`.
- **Live API docs (try every endpoint in the browser):**
  `https://amoonbloom-backend-production.up.railway.app/api-docs`

---

## 1. What the backend now provides (built + tested)

- **Checkout & orders** — cart → order, COD + online, order history/detail/status.
- **Three payment paths:** (A) Cash on Delivery, (B) online hosted page (cards + Apple Pay in a
  web view), (C) **native Apple Pay** (native sheet, no web page — what you want).
- **Reliable confirmation** — every online payment is verified server-side via webhook **and**
  a background reconcile job, so an order is never lost even if the app closes mid-payment.
- **Notifications** — push (FCM) + an in-app **inbox** with unread badge + per-channel
  preferences, localized to the user's language (English/Arabic).
- **Stock safety** — stock is deducted exactly once on confirmation (race-safe).

You integrate against the endpoints below; the confirmation/stock/jobs are automatic.

---

## 2. Order & payment states (know these)

- **Order `status`:** `PENDING_PAYMENT` → `PROCESSING` → `COMPLETED`
  (or `ON_HOLD` / `CANCELLED` / `REFUNDED` / `FAILED` / `DRAFT`). Every order — COD or online —
  starts at **`PENDING_PAYMENT`**; it's a real, visible order from the moment it's placed (there is
  no longer a separate hidden "awaiting payment" state). `ON_HOLD`/`REFUNDED`/`FAILED`/`DRAFT` are
  admin-set labels only — the app never needs to trigger them itself, but must be able to *display*
  any of the 8 values without crashing (don't use an exhaustive switch with no default/fallback case).
- **`paymentStatus`:** `UNPAID` → `PAID` (or `FAILED`).
- **Cart:** COD clears it immediately; online keeps it until payment succeeds (then auto-clears).

**Golden rule:** after any online payment, confirm with **`GET /orders/{id}/status`** — that's
the source of truth (backend re-verifies with MyFatoorah). Never decide success from the UI alone.

---

## 3. Cart endpoints

**Add to cart** — `POST /cart`
```json
{ "productId": "PRODUCT-UUID", "quantity": 1 }
```
→ `data` = updated cart.

Other: `GET /cart` (current cart), `PATCH /cart/quantity` `{productId, quantity}`,
`DELETE /cart/item/{productId}`, `DELETE /cart` (clear).

---

## 4. Checkout (creates the order)

`POST /orders/checkout`
```json
{
  "paymentMethod": "MYFATOORAH",        // or "COD"
  "addressId": "SAVED-ADDRESS-UUID",    // OR inline "shippingAddress": { "streetAddress": "...", "city": "...", "country": "..." }
  "promoCode": "WELCOME10"              // optional
}
```
> Do **not** send name/phone — the backend stamps them from the user's profile (`fullName`,
> `phone`). Make sure those exist before checkout (especially for Apple Pay).

Response (online):
```json
{
  "success": true,
  "message": "Order placed successfully",
  "data": {
    "id": "ORDER-UUID",
    "status": "PENDING_PAYMENT",
    "paymentStatus": "UNPAID",
    "totalAmount": 250.00,
    "items": [ /* line items */ ]
  }
}
```
- Both COD and MYFATOORAH → `status: "PENDING_PAYMENT"` at creation. It moves to `PROCESSING`
  once payment is confirmed (online) or an admin confirms it (COD).
Keep `data.id` = **orderId** for the next steps.

---

## 5. The three payment paths

### Path A — Cash on Delivery (COD)
Just call checkout with `paymentMethod: "COD"`. Order is `PENDING_PAYMENT`. Done. (An "Order placed"
push is sent automatically.)

### Path B — Online hosted page (cards + Apple Pay inside a web view)
1. `POST /orders/{orderId}/pay` (no body)
   → `data`: `{ "paymentUrl": "https://...", "invoiceId": "123456" }`
2. Open `paymentUrl` in an in-app browser (`WKWebView` / Chrome Custom Tab).
3. User pays (on iPhone the Apple Pay button shows on the page).
4. Detect the redirect to `.../orders/payment/callback` (success) or `.../payment/error` →
   close the browser.
5. `GET /orders/{orderId}/status` → `PAID`/`PROCESSING` = success.
- Simplest, works today, no Apple setup. Good fallback / Android path.

### Path C — Native Apple Pay (native sheet, no web page) ← the target UX
Two backend endpoints (your secret key never goes in the app):

**Step 1 — create session:** `POST /orders/{orderId}/payment-session`
→ `data`: `{ "sessionId": "xxxx-xxxx", "countryCode": "KWT" }`

**Step 2 — app shows the native Apple Pay sheet** using the MyFatoorah Flutter SDK
(`myfatoorah_flutter`) with that `sessionId`. The SDK attaches the Apple Pay token to the session.

**Step 3 — execute & place the order:** `POST /orders/{orderId}/pay-session`
```json
{ "sessionId": "xxxx-xxxx" }
```
→ `data`:
```json
{ "isPaid": true, "orderId": "ORDER-UUID", "status": "Paid", "paymentUrl": null }
```
- `isPaid: true` → **order placed** (PROCESSING/PAID, stock deducted). Show success.
- `isPaid: false` → declined → show retry.
- (Idempotent and safe; backend re-verifies with MyFatoorah.)

---

## 6. The Apple Pay button ON THE PRODUCT PAGE (express checkout)

On a product screen the user can **"Add to cart"** OR tap **Apple Pay** to buy that one product
immediately. Use the dedicated **`POST /orders/buy-now`** endpoint — it orders just that product
and **does NOT touch the cart** (verified: even after the online payment succeeds, the user's
cart is left exactly as it was).

```
User taps "Buy with Apple Pay" on a product:
1. POST /orders/buy-now  { productId, quantity, paymentMethod:"MYFATOORAH", addressId:<default> }
                                                       -> orderId (PENDING_PAYMENT)
2. POST /orders/{orderId}/payment-session              -> sessionId
3. MyFatoorah Flutter SDK: native Apple Pay sheet      -> Face ID
4. POST /orders/{orderId}/pay-session { sessionId }    -> isPaid:true -> ORDER PLACED
5. (optional) GET /orders/{orderId}/status             -> PROCESSING/PAID
```
For a COD "Buy Now", just call step 1 with `paymentMethod:"COD"` — placed (`PENDING_PAYMENT`) instantly, no payment steps.

**`POST /orders/buy-now` request:**
```json
{
  "productId": "PRODUCT-UUID",
  "quantity": 1,
  "paymentMethod": "MYFATOORAH",          // or "COD"
  "addressId": "SAVED-ADDRESS-UUID",      // or inline "shippingAddress": {...}
  "promoCode": "WELCOME10"                // optional
}
```
Response = same shape as checkout (`data.id` = orderId; `PENDING_PAYMENT` for both online and COD).

**Important things to handle:**
- **Pre-checks before showing the express button:** the user must have a **default address** and
  a profile **name + phone** (the backend uses them; it doesn't collect them at pay time). If
  missing, send them to add an address first.
- **Cart vs Buy Now are independent:** "Add to cart" → `POST /cart` then later `POST /orders/checkout`
  (whole cart). "Buy with Apple Pay" → `POST /orders/buy-now` (just that product, cart untouched).
- Only **published, in-stock** products can be bought — otherwise a `400` with a clear message.
- Show the Apple Pay button **only on iOS** (Section 8). On Android, use "Add to cart" / normal checkout.

---

## 7. Reading orders

- `GET /orders/{id}` → full detail (items, address, totals).
- `GET /orders/{id}/status` →
  ```json
  { "id": "...", "status": "PROCESSING", "paymentStatus": "PAID", "totalAmount": 250.00,
    "progress": { "currentStep": "PROCESSING", "isTerminal": false, "typicalFlow": [...], "stepIndex": 1 } }
  ```
- `GET /orders/history?page=1&limit=10&status=COMPLETED` → user's orders (online orders appear
  here only **after** payment). `meta.pagination` for paging.

---

## 8. iOS / Xcode setup for native Apple Pay (your one-time setup)
1. Xcode → **Signing & Capabilities → + Capability → Apple Pay**.
2. Add the **Merchant ID** (the owner registers it in the Apple Developer account — get the exact
   value from them).
3. Add the `myfatoorah_flutter` package (latest); init with `MFEnvironment.TEST` (→ `LIVE` for prod).
4. Apple Pay testing needs a **real iPhone** (never the Simulator).
- 🔐 **Never hardcode our secret MyFatoorah API key in the app.** Use the `sessionId` from
  Section 5/6. Coordinate with the backend team if the SDK's `init` needs a key during dev.
- Full SDK steps: see `docs/APP_DEVELOPER_GUIDE_apple_pay_flutter.md` and
  https://docs.myfatoorah.com/docs/flutter

---

## 9. Notifications

### Register the device (after login)
`POST /user/push/token`
```json
{ "fcmToken": "FCM-TOKEN", "platform": "IOS" }   // IOS | ANDROID | WEB
```
On logout: `DELETE /user/push/token` `{ "fcmToken": "FCM-TOKEN" }`.

### What pushes arrive + deep-link data
| Event | `data` payload | On tap |
|---|---|---|
| Order placed | `{ "type":"ORDER_PLACED", "orderId":"...", "status":"PENDING" }` | open that order |
| Order status changed | `{ "type":"ORDER_STATUS", "orderId":"...", "status":"PROCESSING" }` | open that order |
| Promotion | `{ "type":"PROMOTION", ... }` | open promo screen |
| Announcement | `{ "type":"ANNOUNCEMENT", ... }` | open relevant screen |
Titles/bodies are pre-translated to the user's language. Read `data.type` / `data.orderId` to navigate.

### In-app inbox (list + badge)
- `GET /notifications?page=1&limit=20` (add `&unreadOnly=true` for unread). `data` = list,
  `meta.unreadCount` = badge, `meta.pagination` = paging.
- `GET /notifications/unread-count` → `data.unreadCount` (cheap, for app launch).
- `PATCH /notifications/{id}/read` (on open) · `POST /notifications/read-all`.
Each item: `{ id, type, title, body, data, readAt, createdAt }` — show a dot when `readAt` is null.

### Preferences (settings screen)
- `GET /user/notifications/preferences` → `{ orderStatus, promotions, announcements }` (booleans).
- `PATCH /user/notifications/preferences` `{ "promotions": false }` (send only what changed).

---

## 10. YOUR checklist (app side)

**Cart & checkout**
- [ ] Add-to-cart (`POST /cart`); checkout screen (`POST /orders/checkout`, COD + MYFATOORAH).

**Payments**
- [ ] COD: checkout → show "placed".
- [ ] Online hosted (Path B): `/pay` → open `paymentUrl` in web view → detect redirect → `/status`.
- [ ] Native Apple Pay (Path C): `/payment-session` → SDK native sheet → `/pay-session` → `/status`.
- [ ] **Apple Pay button on the product page** (Section 6) with the pre-checks.
- [ ] Retry when `paymentStatus` is `UNPAID`/`FAILED`.
- [ ] iOS: Apple Pay capability + Merchant ID; Android: hide Apple Pay, use Path B/COD.

**Notifications**
- [ ] Register/remove FCM token; handle taps via `data.type`/`data.orderId`.
- [ ] Inbox screen + unread badge; mark-read / mark-all-read.
- [ ] Notification settings screen (preferences).

**Before showing express Apple Pay**
- [ ] Ensure user has a default address + profile name/phone.

---

## 11. How to TEST (sandbox)
- Backend is in **MyFatoorah test mode** (no real money).
- **Online/hosted:** checkout → `/pay` → open URL → pay with a sandbox card and confirm `/status`.
- **Test cards** (from MyFatoorah): KNET `8888880000000001` exp `09/30` (success), or Visa
  `5123450000000008` exp `01/39` CVV `100`. **You're testing from a region MyFatoorah may
  geo-block — use a VPN (GCC) during testing.** Real customers in-region don't need it.
- **Native Apple Pay:** real iPhone + sandbox Apple ID + Apple test card in Wallet
  (https://developer.apple.com/apple-pay/sandbox-testing/) + VPN. Tap Apple Pay → native sheet →
  Face ID → `/pay-session` returns `isPaid:true`.
- **Notifications:** register token → place a COD order → you get an "Order placed" push and it
  appears in `GET /notifications`.

---

## 12. What's still pending (so nothing surprises us)

**Backend team / owner:**
- Apple Pay **enabled on the MyFatoorah account** + the **Apple Pay certificate exchange** with
  MyFatoorah (longest lead time — in progress).
- **Apple Merchant ID** (owner, in Apple Developer account) → share the value with you.
- Production env switch to **live** MyFatoorah (we use test now).
  *(`POST /orders/buy-now` for single-item express Apple Pay is now built — see Section 6.)*

**You (app dev):** everything in the Section 10 checklist.

---

## 13. Quick reference — all endpoints

| Purpose | Method & path |
|---|---|
| Add to cart | `POST /cart` |
| Checkout (whole cart) | `POST /orders/checkout` |
| Buy Now (single product, ignores cart) | `POST /orders/buy-now` |
| Online pay (hosted page) | `POST /orders/{id}/pay` |
| Apple Pay session (native) | `POST /orders/{id}/payment-session` |
| Apple Pay execute (native) | `POST /orders/{id}/pay-session` |
| Order status (confirm) | `GET /orders/{id}/status` |
| Order detail | `GET /orders/{id}` |
| Order history | `GET /orders/history` |
| Register push token | `POST /user/push/token` |
| Remove push token | `DELETE /user/push/token` |
| Inbox list | `GET /notifications` |
| Unread count | `GET /notifications/unread-count` |
| Mark read / all read | `PATCH /notifications/{id}/read` · `POST /notifications/read-all` |
| Push preferences | `GET` / `PATCH /user/notifications/preferences` |

**Any error you don't understand:** copy the full JSON `message` and send it to the backend team.
Most issues: missing `Authorization` header, no default address, or (for push) token not registered.
