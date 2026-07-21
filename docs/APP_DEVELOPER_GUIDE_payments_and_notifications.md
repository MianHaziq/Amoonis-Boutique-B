# Amoon Bloom — App Developer Integration Guide
## Payments (MyFatoorah / Apple Pay) + Notifications (Push + Inbox)

> Written for a beginner. Read top to bottom. Every API call shows the exact URL, what to
> send, and what you get back. At the end there are **step-by-step test flows** you can run
> yourself before we test together.

---

## 0. The basics (read this first)

**Base URL**
- Local (backend running on a laptop): `http://localhost:5000/api/v1`
- Production (Railway): `https://YOUR-RAILWAY-DOMAIN/api/v1`

Everywhere below I write `{BASE}` — replace it with one of the two above.
(There is also a legacy `/api/...` prefix that works the same; prefer `/api/v1`.)

**Authentication**
Almost every call needs the logged-in user's token:
```
Authorization: Bearer <accessToken>
```
You get `accessToken` from the login/signup response. If a call returns `401`, the token is
missing or expired.

**Region header (optional but recommended)**
Send the user's region so prices/catalog match:
```
X-Region: UAE
```
(or `SA`, etc. If you don't send it, the backend uses the user's saved region or the default.)

**Response format — ALWAYS the same shape**
Success:
```json
{ "success": true, "message": "….", "data": { … }, "meta": { … } }
```
Error:
```json
{ "success": false, "message": "Why it failed", "errors": [ { "field": "x", "message": "…" } ] }
```
So in the app: check `success`. If `true`, read `data`. If `false`, show `message`.

---

# PART A — PAYMENT MODULE

## A1. Concepts (understand these 4 things)

1. **Two payment methods**
   - `COD` (Cash on Delivery) — order is placed instantly.
   - `MYFATOORAH` — online payment (cards **and Apple Pay**). The order is placed **only after payment succeeds**.

2. **Order goes through statuses** (field: `status`)
   `PENDING_PAYMENT` → `PROCESSING` → `COMPLETED` (or `ON_HOLD` / `CANCELLED` / `REFUNDED` / `FAILED` / `DRAFT`).
   Every order — COD or online — starts as **`PENDING_PAYMENT`**; it's a real, visible order from
   the moment it's placed. It becomes `PROCESSING` once payment succeeds (online) or an admin
   confirms it (COD). ⚠️ **Renamed from the old contract** (`PENDING`/`AWAITING_PAYMENT`/`CONFIRMED`/
   `SHIPPED`/`DELIVERED`) — see `APP_TEAM_CHANGES.md` for the dated breaking-change entry.

3. **Payment has its own status** (field: `paymentStatus`): `UNPAID` → `PAID` (or `FAILED`).

4. **The cart**
   - COD checkout: cart is cleared immediately.
   - Online checkout: cart is **kept** until payment succeeds (so if the user cancels, their cart is still there). It's cleared automatically once paid.

> **Golden rule:** Never trust the payment redirect in the app. After payment, always ask the
> server "is this order paid?" using **GET `{BASE}/orders/{id}/status`**. The backend verifies
> with MyFatoorah itself — that's the source of truth.

---

## A2. The payment endpoints (with examples)

### (1) Add a product to the cart
`POST {BASE}/cart`
```json
{ "productId": "PRODUCT-UUID", "quantity": 1 }
```
Returns the updated cart in `data`. (Checkout turns the **whole cart** into one order.)

### (2) Create the order (checkout)
`POST {BASE}/orders/checkout`
Headers: `Authorization`, `X-Region`
Body:
```json
{
  "paymentMethod": "MYFATOORAH",      // or "COD"
  "addressId": "SAVED-ADDRESS-UUID",  // OR send "shippingAddress" inline (see below)
  "promoCode": "WELCOME10"            // optional
}
```
Inline address instead of `addressId`:
```json
{
  "paymentMethod": "MYFATOORAH",
  "shippingAddress": { "streetAddress": "123 Main St", "city": "Dubai", "country": "UAE" }
}
```
> **You do NOT send name/phone.** The backend automatically uses the user's profile `fullName`
> and `phone`. Make sure those are set at signup (this is the "auto-fill" — see A4).

Response (online payment example):
```json
{
  "success": true,
  "message": "Order placed successfully",
  "data": { "id": "ORDER-UUID", "status": "PENDING_PAYMENT", "paymentStatus": "UNPAID", "totalAmount": 250.00, "items": [ … ] }
}
```
Keep the `data.id` — that's the **orderId** you need next.

### (3) Start the online payment
`POST {BASE}/orders/{orderId}/pay`
(no body needed; just the `Authorization` header)

Response:
```json
{ "success": true, "message": "Payment created",
  "data": { "paymentUrl": "https://apitest.myfatoorah.com/…", "invoiceId": "123456" } }
```
- `paymentUrl` = the **MyFatoorah hosted payment page**. Open it in a WebView (or external browser).
- On iPhone, this page shows the **Apple Pay button automatically**, plus card entry.

### (4) Check the result (the important one)
`GET {BASE}/orders/{orderId}/status`
Response:
```json
{ "success": true, "data": { "id": "ORDER-UUID", "status": "PROCESSING", "paymentStatus": "PAID", "totalAmount": 250.00 } }
```
- `paymentStatus: "PAID"` + `status: "PROCESSING"` → **success** ✅
- Still `PENDING_PAYMENT` / `UNPAID` → not paid yet (user closed it or is still paying).
- `paymentStatus: "FAILED"` → payment failed; let them retry by calling **/pay** again.

### Other useful reads
- `GET {BASE}/orders/{orderId}` — full order detail (items, address, totals).
- `GET {BASE}/orders/history?page=1&limit=10` — the user's past orders (online orders only appear here **after** they're paid).

### Endpoints the app does NOT call (backend-only — just so you know they exist)
- `GET {BASE}/orders/payment/callback` and `/payment/error` — MyFatoorah redirects the browser here after payment.
- `POST {BASE}/orders/payment/webhook` — MyFatoorah server tells our server the result.
- A **background job** also re-checks unpaid orders every few minutes. So even if the phone
  loses internet right after paying, the order will still get confirmed automatically.

---

## A3. Flow 1 — Normal online checkout (from the cart)

```
1. User taps "Checkout" with items in cart.
2. App → POST /orders/checkout   { paymentMethod: "MYFATOORAH", addressId }   → get orderId
3. App → POST /orders/{orderId}/pay                                           → get paymentUrl
4. App opens paymentUrl in a WebView.
5. User pays (card or Apple Pay) on that page.
6. MyFatoorah redirects the WebView to our callback URL (contains ?paymentId=…).
   → App detects this redirect (URL starts with our callback) and CLOSES the WebView.
7. App → GET /orders/{orderId}/status   (poll every 2s, up to ~5 times)
       → paymentStatus PAID  → show "Order confirmed!" 🎉
       → still UNPAID         → show "Payment pending" and let them retry
```

**How to detect the redirect in a WebView (step 6):** watch the WebView's URL changes. When the
URL contains `/orders/payment/callback` (success) or `/orders/payment/error` (cancel/fail),
stop loading, close the WebView, and go to step 7. Do **not** decide success from which URL it
was — always confirm with `/status`.

---

## A4. Flow 2 — Express Apple Pay straight from the product page

This is the experience you described: on the product screen the user taps **Apple Pay**
directly (without visiting the cart). Behind the scenes the app does the cart + checkout + pay
steps for them, and Apple Pay fills the payment details.

**What the app does when "Apple Pay" is tapped on a product:**
```
1. (background) POST /cart            { productId, quantity: 1 }       // add the item
2. (background) POST /orders/checkout { paymentMethod: "MYFATOORAH", addressId: <user's default> }
3. (background) POST /orders/{orderId}/pay                              → paymentUrl
4. Open paymentUrl in a WebView. On iPhone, the Apple Pay button is right there.
5. User taps Apple Pay → iOS shows the Apple Pay sheet with their card already filled in.
6. After approval → same as Flow 1 steps 6–7 (detect redirect → GET /status → confirm).
```

**About "auto-fill":**
- **Payment card auto-fill** = handled by **Apple Pay itself** on the hosted page. The user
  doesn't type a card; iOS fills it. ✅
- **Name / phone / shipping** = filled by the **backend** from the user's profile + chosen
  address (that's why checkout doesn't ask for name/phone). So make sure the user has a
  `fullName`, `phone`, and at least one saved address before offering express Apple Pay.

**Two things to know (important, so expectations are correct):**
1. **Checkout uses the whole cart.** Right now "buy now" adds the product to the cart and
   checks out the **entire cart**. If you want true "buy ONLY this one product, ignore the
   cart," that needs a small new backend endpoint (e.g. `POST /orders/buy-now`). Tell us if you
   want that — it's a quick add. For the first version, adding-to-cart-then-checkout is fine
   when the cart is empty or the user intends to buy everything.
2. **Apple Pay here is the button on the MyFatoorah hosted page**, not a fully native Apple Pay
   sheet that we build ourselves. That's the normal, supported way and it still shows the real
   Apple Pay sheet inside the page. A *fully native* Apple Pay (no web page at all) would need
   extra backend work + an Apple Pay merchant certificate + domain validation — we can do that
   later if you want it, but it is **not required** to ship Apple Pay now.

---

## A5. How YOU (app dev) test payments — by yourself

You're using the **MyFatoorah test (sandbox)** environment (the backend is already configured
for it: `apitest.myfatoorah.com`). No real money moves.

**Test with the hosted page (easiest):**
1. Run the full flow A3 (or A4) against the backend.
2. When the WebView opens the `paymentUrl`, you'll see MyFatoorah's **test** payment screen.
3. Choose a card and use a **MyFatoorah sandbox test card**. A commonly documented one:
   - Card: `5453 0100 0009 5323` · Expiry: any future date (e.g. `05/26`) · CVV: `100`
   - If it asks for a 3-D Secure OTP, use `1234`.
   - ⚠️ Sandbox cards can change — confirm the current test cards in your **MyFatoorah test
     dashboard → Documentation** if that one is rejected.
4. Complete payment → the page redirects → close WebView → call `GET /orders/{id}/status`.
5. You should see `paymentStatus: PAID`, `status: PROCESSING`.

**To test a FAILED payment:** cancel on the MyFatoorah page, or use a failing test card. Then
`/status` shows `FAILED` (or still `UNPAID`) — your app should let the user tap pay again.

**To test Apple Pay specifically:** Apple Pay only appears on a **real iPhone** (Safari/WebView),
signed into an Apple ID, in a supported country. In sandbox you can add an Apple **sandbox test
card** to Wallet. If you don't have that set up yet, test the card flow first — the app logic
(open page → detect redirect → confirm) is identical for Apple Pay and cards.

**Quick test without the app (using curl or Postman) — proves the backend works:**
```bash
# 1) log in to get a token (use your real login endpoint/body)
# 2) add to cart
curl -X POST {BASE}/cart -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"productId":"<PRODUCT_UUID>","quantity":1}'
# 3) checkout (online)
curl -X POST {BASE}/orders/checkout -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"paymentMethod":"MYFATOORAH","shippingAddress":{"streetAddress":"123 St","city":"Dubai","country":"UAE"}}'
# → copy data.id  (the orderId)
# 4) start payment
curl -X POST {BASE}/orders/<ORDER_ID>/pay -H "Authorization: Bearer $TOKEN"
# → open data.paymentUrl in a browser, pay with the test card
# 5) check result
curl {BASE}/orders/<ORDER_ID>/status -H "Authorization: Bearer $TOKEN"
```

---

# PART B — NOTIFICATIONS

There are **two parts** and you should integrate both:
- **Push notifications** (Firebase Cloud Messaging / FCM) — pop up on the phone.
- **In-app inbox** — a list inside the app of every notification (so nothing is missed if the
  phone was offline), with an **unread badge** count.

## B1. Push setup (do this once after login)

1. Get the device's FCM token from the Firebase SDK in the app.
2. Send it to the backend:
   `POST {BASE}/user/push/token`
   ```json
   { "fcmToken": "THE-FCM-TOKEN", "platform": "IOS" }   // platform: IOS | ANDROID | WEB
   ```
3. On logout, remove it:
   `DELETE {BASE}/user/push/token`
   ```json
   { "fcmToken": "THE-FCM-TOKEN" }
   ```

> The backend already auto-deletes dead tokens, so you don't manage that.

## B2. What notifications the backend sends + their data

Every push has a **title/body** (shown to the user, already translated to the user's language —
English or Arabic based on the user's `preferredLanguage`) and a **data** object for deep links:

| When | data payload | What the app should do on tap |
|---|---|---|
| Order placed | `{ "type": "ORDER_PLACED", "orderId": "…", "status": "PENDING_PAYMENT" }` | Open that order's detail screen |
| Order status changed | `{ "type": "ORDER_STATUS", "orderId": "…", "status": "PROCESSING" }` | Open that order's detail screen |
| Promotion | `{ "type": "PROMOTION", … }` | Open promotions / a target screen |
| Announcement | `{ "type": "ANNOUNCEMENT", … }` | Open the relevant screen |

So in the app: read `data.type` and `data.orderId` to navigate. (Order notifications respect the
user's preference toggle — see B4.)

## B3. In-app inbox (the notification list + badge)

- List (newest first):
  `GET {BASE}/notifications?page=1&limit=20`
  Optional `?unreadOnly=true` to show only unread.
  Response `data` is the list; `meta.unreadCount` is the badge number; `meta.pagination` for paging.
- Badge count only (cheap, for app launch / refresh):
  `GET {BASE}/notifications/unread-count` → `data.unreadCount`
- Mark one as read (when user opens it):
  `PATCH {BASE}/notifications/{id}/read`
- Mark all as read:
  `POST {BASE}/notifications/read-all`

Each notification object looks like:
```json
{ "id": "…", "type": "ORDER_STATUS", "title": "On the way", "body": "Your order has shipped.",
  "data": { "type": "ORDER_STATUS", "orderId": "…", "status": "PROCESSING" }, "readAt": null, "createdAt": "…" }
```
Show a dot/badge when `readAt` is `null`.

## B4. Notification preferences (settings screen)

Let the user toggle channels:
- Read: `GET {BASE}/user/notifications/preferences`
  → `data: { orderStatus: true, promotions: true, announcements: true }`
- Update (send only what changed):
  `PATCH {BASE}/user/notifications/preferences`
  ```json
  { "promotions": false }
  ```
> Note: order updates always appear in the **inbox** even if the user turns off the *push*
> popups; promotions/announcements are skipped entirely when turned off.

## B5. How YOU test notifications — by yourself

1. Log in on a real device, register the FCM token (B1).
2. **Place an order** (COD is fastest: checkout with `paymentMethod: "COD"`). Within a second
   you should get an **"Order placed"** push, and `GET /notifications` should show it.
3. Ask an admin to change the order status (or use the admin dashboard). You'll get an
   **"On the way"/"Delivered"** push for each change.
4. Tap the push → confirm the app opens the right order using `data.orderId`.
5. Open the inbox screen → confirm the item is there, badge count is correct, and tapping it
   marks it read (`unreadCount` drops).
6. Toggle a preference off and confirm that channel's push stops.

> If a push doesn't arrive: check the token was registered, the device allowed notifications,
> and Firebase is configured on the backend. The inbox (`GET /notifications`) is the reliable
> fallback to confirm the backend created the notification even if the push didn't pop up.

---

# PART C — App-side integration checklist (what's pending on YOUR side)

Tick these off:

**Payments**
- [ ] "Add to cart" calls `POST /cart`.
- [ ] Checkout screen calls `POST /orders/checkout` (COD and MyFatoorah).
- [ ] For MyFatoorah: call `POST /orders/{id}/pay`, open `paymentUrl` in a WebView.
- [ ] WebView detects redirect to `…/payment/callback` or `…/payment/error`, then closes.
- [ ] After WebView closes, poll `GET /orders/{id}/status` and show the result.
- [ ] "Retry payment" calls `/pay` again when `paymentStatus` is `FAILED`/`UNPAID`.
- [ ] Express Apple Pay button on product page = add to cart → checkout → pay (Flow A4).
- [ ] Ensure the user has `fullName`, `phone`, and a default address before express Apple Pay.

**Notifications**
- [ ] Register FCM token after login (`POST /user/push/token`); remove on logout.
- [ ] Handle incoming push: read `data.type` / `data.orderId` and deep-link.
- [ ] Inbox screen using `GET /notifications` + unread badge from `meta.unreadCount`.
- [ ] Mark-as-read on open (`PATCH /notifications/{id}/read`) and "mark all read".
- [ ] Settings screen for `GET/PATCH /user/notifications/preferences`.

**Ask the backend team (us) if you need:**
- [ ] A true single-item "Buy Now" endpoint that ignores the cart (`POST /orders/buy-now`).
- [ ] Fully native Apple Pay (no web page) — needs Apple merchant cert + extra backend.

---

# PART D — Full end-to-end test script (do these in order)

> Goal: prove the whole thing works before we test together. Use a **real device** for push +
> Apple Pay. Backend on local or Railway.

**Setup**
1. Backend running; you know `{BASE}`.
2. Create/login a test user. Save the `accessToken`.
3. Set the user's profile: `fullName`, `phone`, and add a default address.
4. Register the FCM token (`POST /user/push/token`).

**Test 1 — COD order + notification (no money involved)**
1. `POST /cart` add a product.
2. `POST /orders/checkout` with `{ "paymentMethod": "COD", "addressId": "…" }`.
3. Expect: `data.status = "PENDING_PAYMENT"`. Within ~1s an **"Order placed"** push arrives.
4. `GET /notifications` → the notification is listed; `meta.unreadCount` = 1.
5. `PATCH /notifications/{id}/read` → `unread-count` becomes 0.

**Test 2 — Online card payment (sandbox)**
1. `POST /cart` add a product.
2. `POST /orders/checkout` with `{ "paymentMethod": "MYFATOORAH", "addressId": "…" }` → save `orderId`.
3. `GET /orders/{orderId}/status` → `PENDING_PAYMENT` / `UNPAID`.
4. `POST /orders/{orderId}/pay` → open `paymentUrl`.
5. Pay with the sandbox **test card** (A5).
6. WebView redirects → close it → poll `GET /orders/{orderId}/status`.
7. Expect: `PAID` + `PROCESSING`. An **"Order placed"** push arrives. The order now appears in
   `/orders/history`, and the cart is empty.

**Test 3 — Express Apple Pay from product page (real iPhone)**
1. On a product screen, tap **Apple Pay**.
2. App silently does cart → checkout → pay, opens `paymentUrl`, Apple Pay button shows.
3. Tap Apple Pay → approve with Face ID/Touch ID (sandbox card in Wallet).
4. Redirect → confirm with `GET /orders/{id}/status` → `PAID`/`PROCESSING`. 🎉

**Test 4 — Payment cancelled / failed**
1. Do Test 2 but **cancel** on the MyFatoorah page (or use a failing card).
2. `GET /orders/{orderId}/status` → still `UNPAID` or `FAILED`.
3. Tap "Retry" → `POST /orders/{orderId}/pay` again → pay successfully → `PAID`/`PROCESSING`.
   (This proves retry works and we never lose the order.)

**Test 5 — "Lost connection" safety net (optional, impressive)**
1. Do Test 2 up to paying successfully, but **kill the app/internet right after paying**
   (before `/status`).
2. Wait ~3–5 minutes, reopen, `GET /orders/{orderId}/status`.
3. Expect: it's `PAID`/`PROCESSING` anyway — the backend's reconcile job caught it. ✅

**Test 6 — Status-change notifications**
1. Take any confirmed order. Have an admin move it `PROCESSING → COMPLETED`.
2. Each change → a push + a new inbox item with the right `data.status`.

---

## Quick reference — every endpoint in one place

| Purpose | Method & path | Auth |
|---|---|---|
| Add to cart | `POST {BASE}/cart` | user |
| Checkout (create order) | `POST {BASE}/orders/checkout` | user |
| Start online payment | `POST {BASE}/orders/{id}/pay` | user |
| Check order/payment result | `GET {BASE}/orders/{id}/status` | user |
| Order detail | `GET {BASE}/orders/{id}` | user |
| Order history | `GET {BASE}/orders/history` | user |
| Register push token | `POST {BASE}/user/push/token` | user |
| Remove push token | `DELETE {BASE}/user/push/token` | user |
| Inbox list | `GET {BASE}/notifications` | user |
| Unread count (badge) | `GET {BASE}/notifications/unread-count` | user |
| Mark one read | `PATCH {BASE}/notifications/{id}/read` | user |
| Mark all read | `POST {BASE}/notifications/read-all` | user |
| Get/set push preferences | `GET` / `PATCH {BASE}/user/notifications/preferences` | user |

**Interactive API docs (try every endpoint in the browser):** `{BASE without /api/v1}/api-docs`
e.g. `http://localhost:5000/api-docs`. Click "Authorize", paste the token, and test live.

---

*Questions? Anything that returns an error you don't understand — copy the full JSON `message`
and send it to the backend team. Most issues are a missing `Authorization` header, a missing
default address, or the FCM token not registered.*
