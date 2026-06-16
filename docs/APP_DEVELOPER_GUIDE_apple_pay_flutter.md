# App Developer Brief — Native Apple Pay in Flutter (MyFatoorah)

> Audience: the Flutter developer. Goal: **native Apple Pay** — user taps Apple Pay,
> the native iOS sheet appears, they confirm with Face ID, payment completes **without
> any web page** (Airbnb-style). This brief tells you exactly what to build, what the
> backend gives you, and how to test it. Read it fully before starting.

---

## 0. The big picture (how the pieces fit)

```
Flutter app  ──(1) POST /orders/{id}/payment-session──►  Our backend  ──InitiateSession──►  MyFatoorah
Flutter app  ◄──────── { sessionId, countryCode } ────────  Our backend
Flutter app  ──(2) MyFatoorah Flutter SDK + sessionId──►  shows NATIVE Apple Pay sheet
User confirms with Face ID → SDK executes the payment with MyFatoorah
MyFatoorah  ──(3) webhook──►  Our backend marks the order PAID  (also re-checked by a job)
Flutter app  ──(4) GET /orders/{id}/status──►  shows "Order confirmed"
```

**Why a "session"?** Your app must **never contain our secret MyFatoorah API key**. So the
backend creates a one-time **`sessionId`** and gives it to the app. The app pays using that
session. The secret stays on the server. This is the secure, production-correct way.

---

## 1. Two things must be ready before native Apple Pay works

These are **not your job to obtain**, but you depend on them — confirm with the project owner:

1. **Apple Pay enabled on the MyFatoorah account.**
2. **Apple Pay Payment Processing Certificate exchanged with MyFatoorah** (owner gets a CSR
   from MyFatoorah, generates the cert in the Apple Developer account, sends it back). This
   gates native Apple Pay — without it, the Apple Pay sheet will fail.

You **do** handle the Xcode side (Section 3).

---

## 2. What the backend provides (your API contract)

Base URL (testing): `https://<ngrok-or-railway>/api/v1`
All calls need the logged-in user's token: `Authorization: Bearer <accessToken>`.

**(a) Create the order** — same as a normal online order:
`POST /orders/checkout`
```json
{ "paymentMethod": "MYFATOORAH", "addressId": "<saved-address-uuid>" }
```
→ returns `data.id` = **orderId**, with `status: "AWAITING_PAYMENT"`.

**(b) Create a payment session for Apple Pay** *(backend endpoint provided for this flow)*:
`POST /orders/{orderId}/payment-session`
→ returns:
```json
{ "success": true, "data": { "sessionId": "xxxxxxxx", "countryCode": "ARE" } }
```
Use `sessionId` with the MyFatoorah SDK. It's valid for **one** payment and is short-lived —
create it right before showing the Apple Pay button.

**(c) Confirm the result** (source of truth — always do this after paying):
`GET /orders/{orderId}/status`
→ `data.paymentStatus === "PAID"` and `data.status === "CONFIRMED"` means success.

> Do **not** trust the SDK's local "success" alone — always confirm with `GET /status`. The
> backend verifies with MyFatoorah server-side (webhook + a reconcile job), so this is reliable
> even if the app crashes right after paying.

---

## 3. iOS / Xcode setup (your job, one time)

1. Open the iOS project in Xcode.
2. **Signing & Capabilities → + Capability → Apple Pay.**
3. Add the **Merchant ID** that the owner registered in the Apple Developer account
   (e.g. `merchant.com.amoonbloom.app`) — get the exact value from the owner.
4. Make sure the bundle ID + provisioning profile include the Apple Pay entitlement.
5. Apple Pay requires a **real device** for testing (see Section 6).

---

## 4. Flutter integration (your main work)

Package: **`myfatoorah_flutter`** (latest, currently `^3.3.2`).
Official docs (follow these for exact API): https://docs.myfatoorah.com/docs/flutter
Apple Pay native specifics: https://docs.myfatoorah.com/docs/apple-pay-native

High-level steps (see docs for exact method signatures):

1. **Initialize the SDK** once at app start:
   - `MFSDK.init(...)` with country + `MFEnvironment.TEST` (switch to `LIVE` for production).
   - 🔐 **Security:** do **not** hardcode our production secret API key in the app. Use the
     **session flow**: get `sessionId` from the backend (Section 2b) and use it for the
     payment. If the SDK's `init` requires a key during development, use a **test key only**
     and coordinate with the backend team — the real charge is authorized via the backend
     session, not a key baked into the app.
2. When the user taps **Apple Pay** on the product/checkout screen:
   - Call backend `POST /orders/checkout` (if no order yet) → get `orderId`.
   - Call backend `POST /orders/{orderId}/payment-session` → get `sessionId`.
3. **Render the Apple Pay button** with `MFApplePayButton` and call its `applePayPayment(...)`
   using an `MFExecutePaymentRequest` (invoice value + currency) and the `sessionId`.
   - This shows the **native Apple Pay sheet** (no web page).
4. On the SDK success callback → call `GET /orders/{orderId}/status` to confirm → show the
   success screen. On failure/cancel → show retry.

**Express "Apple Pay from the product page"** (the UX you want): when Apple Pay is tapped on a
product, do checkout → session → Apple Pay sheet **in the background**. Make sure the user has
a saved **default address** and a profile **name + phone** first (the backend uses those — the
app does not collect them at pay time).

---

## 5. Android note
Apple Pay is iOS-only. On Android, either hide the Apple Pay button or fall back to the normal
online flow: `POST /orders/{id}/pay` → open the returned `paymentUrl` in a Chrome Custom Tab →
confirm with `GET /status`. (Same backend, no Apple Pay.)

---

## 6. How to test (sandbox)

You need a **real iPhone** — Apple Pay never works on the iOS Simulator.

1. SDK environment = **TEST**; MyFatoorah account in test mode.
2. On the iPhone, sign into a **sandbox Apple ID** (created in App Store Connect → Users and
   Access → Sandbox).
3. Add an **Apple sandbox test card** to Wallet:
   https://developer.apple.com/apple-pay/sandbox-testing/
4. **VPN to a GCC region** (UAE) on the phone — the MyFatoorah/bank test gateways block some
   countries (e.g. Pakistan). Real customers in-region won't need this.
5. Run the flow: checkout → tap Apple Pay → native sheet → Face ID → success.
6. Confirm with `GET /orders/{orderId}/status` → `PAID` / `CONFIRMED`.

If the Apple Pay button doesn't appear on a real iPhone: Apple Pay isn't enabled on the
MyFatoorah account yet, the certificate exchange (Section 1) isn't done, the Merchant ID is
missing in Xcode, or there's no card in Wallet.

---

## 7. Your checklist

- [ ] iOS: Apple Pay capability + Merchant ID added in Xcode.
- [ ] Add `myfatoorah_flutter`; `MFSDK.init` with TEST env.
- [ ] Get `orderId` from `POST /orders/checkout`.
- [ ] Get `sessionId` from `POST /orders/{id}/payment-session` (no secret key in the app).
- [ ] Show `MFApplePayButton`; execute with `sessionId` + amount/currency.
- [ ] On success → `GET /orders/{id}/status` → confirm → success screen.
- [ ] Handle cancel/failure → retry.
- [ ] Android fallback to hosted page (`/pay` → `paymentUrl`).
- [ ] Tested on a real iPhone with sandbox Apple ID + test card + GCC VPN.

---

## 8. If we need to ship sooner (fallback option)
If the Apple Pay certificate exchange (Section 1) isn't finished, you can ship the
**hosted-page** flow first: `POST /orders/{id}/pay` → open `paymentUrl` in a WebView /
Custom Tab → on iPhone the Apple Pay button shows **inside that page** (no SDK, no certificate
needed) → confirm with `GET /status`. Then upgrade to the native sheet (Sections 3–4) later.
Both use the same checkout + status endpoints.

---

**Questions / blockers:** if any endpoint returns an error, copy the full JSON `message` and
send it to the backend team. Most issues are a missing `Authorization` header, missing default
address, Apple Pay not enabled on the MyFatoorah account, or the certificate exchange not done.

Reference docs:
- MyFatoorah Flutter SDK: https://pub.dev/packages/myfatoorah_flutter
- MyFatoorah Flutter guide: https://docs.myfatoorah.com/docs/flutter
- Apple Pay native: https://docs.myfatoorah.com/docs/apple-pay-native
- Apple Pay sandbox testing: https://developer.apple.com/apple-pay/sandbox-testing/
