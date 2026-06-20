# Notifications — App Developer Integration Guide

> ## 📣 Read this first (summary)
>
> The notification **backend is fully built, tested, and live**. Nothing is integrated on the app side yet — this doc is your full handoff.
>
> **What the backend does:**
> - **Push (FCM)** — order lifecycle (placed → confirmed → processing → shipped → delivered → cancelled), automatic **"new promo code is live"** notifications, and admin announcements. Sent asynchronously via a durable job queue (retries, never blocks requests).
> - **In-app inbox** — every push is also saved as a record, so users see history + unread badges even if offline. Auto-pruned over time.
> - **Per-user preferences** — users enable/disable each channel (order updates / promotions / announcements), enforced server-side.
> - **Localized** push copy (EN/AR) — you do **not** translate notification text on the client.
>
> **What you need to do:**
> 1. Add Firebase using the **same project as us: `amoonbloom`** (we'll share `google-services.json` / `GoogleService-Info.plist`; iOS also needs the APNs key in Firebase).
> 2. **Save the FCM token** → `POST /api/v1/user/push/token` (body `{ "fcmToken": "...", "platform": "IOS|ANDROID|WEB" }`, with the user's `Bearer` JWT) — after login and on every token refresh. `DELETE` it on logout **before** clearing the JWT.
> 3. Handle pushes in foreground/background/killed and **deep-link on `data.type`**.
> 4. Build **two screens**: a **Notification Preferences page** (`/user/notifications/preferences`) and an **In-app Inbox** with unread badge (`/notifications`).
>
> ⚠️ Follow the **professional-standards checklist (§9)** — it covers what usually breaks (permission UX, token refresh, badge sync, deep-link fallbacks, RTL/i18n, logout token cleanup). Full flow + all 8 endpoints are below.

---

Hi 👋 — this is the **complete** guide for integrating notifications into the mobile app. The backend notification module is **fully built, tested (34/34 automated checks passing), and live**. Nothing on the app side is integrated yet — this document tells you exactly what to build and how.

Please follow the **professional-standards checklist in §9** — it's not optional, it's how we avoid the classic notification bugs (duplicate tokens, missing permission prompts, badges that never clear, deep links that don't route).

---

## 0. TL;DR — what you need to do

1. Add Firebase to the app (same Firebase project as the backend — **`amoonbloom`**).
2. Request OS notification permission (iOS always; Android 13+).
3. Get the FCM token and **`POST /api/v1/user/push/token`** after login + on every token refresh.
4. **`DELETE`** that token on logout (before clearing the JWT).
5. Handle incoming pushes in all 3 app states (foreground / background / killed) and **deep-link on `data.type`**.
6. Build **two screens**:
   - **Notification Preferences page** (settings) → uses `/user/notifications/preferences`.
   - **In-app Notification Inbox** (list + unread badge) → uses `/notifications`.

Everything you call is listed in §3 with exact request/response.

---

## 1. How the whole module works (architecture)

We send notifications through **3 layers**, all handled by the backend automatically:

```
 An event happens (order placed, status change, promo goes live)
        │
        ▼
 Notification dispatcher  ──enqueues──►  Background job queue (pg-boss, durable, retries)
                                                │
                                                ▼
                                   Push worker resolves localized text, then:
                                                │
                        ┌───────────────────────┼───────────────────────┐
                        ▼                        ▼                        ▼
              1) FCM push to device   2) Writes In-App Inbox    3) Respects user preference
                 (if channel on)         record (always*)          (orderStatus/promotions/announcements)
```

Key properties you should rely on:

- **Asynchronous & reliable.** Sends go through a durable queue (pg-boss on Postgres) with automatic retries. A push is never lost because of a transient FCM hiccup, and placing an order never blocks on push delivery.
- **In-app inbox is the source of truth for history.** Every push is also persisted to a `Notification` record, so a user who was offline (or had push disabled) still sees it in the inbox. **This is why you must build the inbox screen** — push alone is lossy.
- **Per-user preferences are enforced server-side.** If a user turns off a channel, we don't send that push. (Order-status records are still written to the inbox even if the push is off, because they're transactional — see §5.)
- **Localized.** Push text is rendered in the user's `preferredLanguage` (English/Arabic) automatically. You don't translate notification copy on the client.

\* Order-status notifications are always written to the inbox even if push is off; promotional/announcement notifications are skipped entirely when the user opted out.

---

## 2. Provider & Firebase setup

We use **Firebase Cloud Messaging (FCM HTTP v1)**. No OneSignal, no Expo, no direct APNs.

You'll need, from the **same Firebase project the backend uses (`amoonbloom`)**:

- **Android:** `google-services.json`.
- **iOS:** `GoogleService-Info.plist` **and** an APNs Auth Key uploaded to Firebase Console → Project Settings → Cloud Messaging → Apple app configuration. Without the APNs key, iOS pushes silently fail.

⚠️ The #1 cause of "API returns 200 but no push arrives" is the client using a **different Firebase project** than the server. They must match. I'll share these config files with you directly.

**FCM data payload values are always strings** (FCM constraint) — parse/cast on the client accordingly.

---

## 3. API Reference

**Base URL:** `https://<host>/api/v1` (a legacy `/api` prefix without `/v1` also works, but use `/api/v1`).
**Auth:** every endpoint requires `Authorization: Bearer <JWT>` from the existing auth flow.
**Response envelope (all endpoints):**
```json
{ "success": true, "message": "…", "data": { … }, "meta": { … } }
```
Errors: `{ "success": false, "message": "…", "errors": [ … ] }`.

### 3.1 Register device token — `POST /user/push/token`

```http
POST /api/v1/user/push/token
Authorization: Bearer <JWT>
Content-Type: application/json

{ "fcmToken": "<token from Firebase SDK>", "platform": "ANDROID" }
```
- `platform`: `"IOS" | "ANDROID" | "WEB"` (optional, defaults to `ANDROID`).

**200:**
```json
{
  "success": true,
  "message": "Device registered for push notifications",
  "data": { "id": "uuid", "platform": "ANDROID", "updatedAt": "2026-06-17T12:34:56.000Z" }
}
```
- **Idempotent** — same token just refreshes it.
- If the token was registered to another user (someone else logged in on this device), it's **automatically transferred** to the current user.
- A user can have **multiple devices** — each registers its own token.

### 3.2 Unregister token (on logout) — `DELETE /user/push/token`

```http
DELETE /api/v1/user/push/token
Authorization: Bearer <JWT>
Content-Type: application/json

{ "fcmToken": "<same token>" }
```
- **200:** `{ "success": true, "message": "Device unregistered" }`
- **404:** token not found for this user.
- ⚠️ Call this **before** you clear the JWT, or it will 401.

### 3.3 Get preferences — `GET /user/notifications/preferences`

```json
{
  "success": true,
  "message": "Notification preferences",
  "data": { "orderStatus": true, "promotions": true, "announcements": true, "updatedAt": "…" }
}
```
First read auto-creates the row with all channels `true`.

### 3.4 Update preferences — `PATCH /user/notifications/preferences`

```http
PATCH /api/v1/user/notifications/preferences
Content-Type: application/json

{ "promotions": false }
```
- All three fields (`orderStatus`, `promotions`, `announcements`) are optional **individually**, but send **at least one** boolean (else `400`). Omitted fields are unchanged.
- Returns the full updated preferences object.

### 3.5 List inbox — `GET /notifications`

```http
GET /api/v1/notifications?page=1&limit=20&unreadOnly=false
```
| Query | Default | Notes |
|---|---|---|
| `page` | 1 | |
| `limit` | 20 | max 50 |
| `unreadOnly` | false | `true`/`1` → only unread |

**200:**
```json
{
  "success": true,
  "message": "Notifications fetched",
  "data": [
    {
      "id": "uuid",
      "type": "ORDER_STATUS",
      "title": "On the way",
      "body": "Your order has shipped.",
      "data": { "type": "ORDER_STATUS", "orderId": "uuid", "status": "SHIPPED" },
      "readAt": null,
      "createdAt": "2026-06-17T12:34:56.000Z"
    }
  ],
  "meta": {
    "pagination": { "page": 1, "limit": 20, "total": 42, "totalPages": 3 },
    "unreadCount": 5
  }
}
```
Newest first. `readAt: null` = unread.

### 3.6 Unread count (for the badge) — `GET /notifications/unread-count`
```json
{ "success": true, "message": "Unread count fetched", "data": { "unreadCount": 5 } }
```

### 3.7 Mark one read — `PATCH /notifications/:id/read`
- `:id` must be a UUID.
- **200:** `{ "success": true, "message": "Notification marked read" }`
- **404:** not found / not yours / already read.

### 3.8 Mark all read — `POST /notifications/read-all`
```json
{ "success": true, "message": "All notifications marked read", "data": { "updated": 5 } }
```

---

## 4. The push payload (what arrives on the device)

Every push has a `notification` block (for the OS tray) and a `data` block (for routing). **Always branch on `data.type`, never on the title/body text** (copy is localized and will change).

```json
{
  "notification": { "title": "On the way", "body": "Your order has shipped." },
  "data": {
    "brand": "Amoon Bloom",
    "type": "ORDER_STATUS",
    "orderId": "<uuid>",
    "status": "SHIPPED"
  }
}
```

Server already sets: **Android** `priority: high`; **iOS** `aps.sound = "default"`. You don't configure sound/priority on the client.

---

## 5. Events that trigger notifications

| Event | `data.type` | Extra `data` fields | Preference channel | Audience |
|---|---|---|---|---|
| Order placed (after checkout / payment) | `ORDER_PLACED` | `orderId`, `status: "PENDING"` | `orderStatus`* | the buyer |
| **New order — staff alert** 🆕 | `ORDER_PLACED` | `orderId`, `status: "PENDING"` | none (operational) | all **ADMIN + MANAGER** (buyer excluded) |
| Order confirmed | `ORDER_STATUS` | `orderId`, `status: "CONFIRMED"` | `orderStatus`* | the buyer |
| Order processing | `ORDER_STATUS` | `orderId`, `status: "PROCESSING"` | `orderStatus`* | the buyer |
| Order shipped | `ORDER_STATUS` | `orderId`, `status: "SHIPPED"` | `orderStatus`* | the buyer |
| Order delivered | `ORDER_STATUS` | `orderId`, `status: "DELIVERED"` | `orderStatus`* | the buyer |
| Order cancelled | `ORDER_STATUS` | `orderId`, `status: "CANCELLED"` | `orderStatus`* | the buyer |
| **New promo code goes live** 🆕 | `PROMOTION` | `promoCode`, `promoCodeId` | `promotions` | **all users**, or **new users only** if the code is new-user-only |
| Admin announcement | `ANNOUNCEMENT` | (campaign-specific) | `announcements` | broadcast |

\* **Order-status pushes are transactional**: even if `orderStatus` push is OFF, the notification is still written to the in-app inbox (the push just isn't delivered). Promotions/announcements are skipped entirely when their channel is off.

### Staff "new order" alert 🆕
When a customer places an order, **all ADMIN and MANAGER users** also receive a push with `data.type = "ORDER_PLACED"` (title **"New Order"**, body e.g. *"Order #A1B2C3D4 placed — 199 AED."*). This is **operational** — it is *not* gated by the staff member's personal notification preferences, so admins always get alerted. The buyer is excluded (an admin buying as a customer won't be double-notified). Since the type is `ORDER_PLACED`, route it by the logged-in user's **role**: ADMIN/MANAGER → admin order screen, customer → customer order screen (you've already implemented this).

### About the new "promo code goes live" feature 🆕
When an admin creates a discount code with a future start date (e.g. *active from the 1st*), the backend automatically notifies users **on the day it becomes active** — once per code:
- A **normal** code → broadcast to **all** users.
- A code flagged **new-users-only** → sent **only to eligible new users** (so people aren't told about a code they can't redeem).

On the client this arrives as `data.type = "PROMOTION"` with `data.promoCode` (the code string) and `data.promoCodeId`. Route it to your deals/promo screen and you can pre-fill or highlight the code.

---

## 6. Client-side handling (all 3 states)

Branch on `data.type` and deep-link:

| `data.type` | Suggested action |
|---|---|
| `ORDER_PLACED` / `ORDER_STATUS` | Open order detail (`orderId`); optionally toast the new `status` |
| `PROMOTION` | Open deals/promo screen; highlight `promoCode` |
| `ANNOUNCEMENT` | Open news/announcements screen |

Handle each app state:
1. **Foreground** — Firebase fires `onMessage` / `onMessageReceived`; the OS tray does **not** show it, so render an in-app banner yourself (and refresh the inbox badge).
2. **Background** — OS tray notification; tap → `onNotificationOpenedApp` → route.
3. **Killed/Quit** — tap launches the app; read `getInitialNotification()` on startup and route from there.

After handling any push, **refresh the unread count** (§3.6) so the badge stays in sync.

---

## 7. Token lifecycle — get this right

Most integration bugs live here:

1. **On app start (logged in):** get the current FCM token → `POST` it (idempotent).
2. **On token refresh** (`onTokenRefresh` / `onNewToken`): `POST` the new token immediately.
3. **On logout:** `DELETE` the token **first**, then clear the JWT.
4. **Different user logs in on same device:** just `POST` with the new JWT — backend transfers it.

Invalid tokens (uninstall etc.) are detected and **purged automatically** server-side when FCM rejects them — you do nothing.

---

## 8. Screens you must build

### 8.1 Notification Preferences page (Settings)
- On open: `GET /user/notifications/preferences` → render 3 toggles:
  - **Order updates** → `orderStatus`
  - **Promotions & offers** → `promotions`
  - **Announcements** → `announcements`
- On toggle: `PATCH` the single changed field (optimistic UI, revert on error).
- **Also surface OS-level permission state.** If the user denied system notification permission, show a banner ("Notifications are turned off in system settings") with a deep link to OS settings — toggling our in-app prefs can't override a denied OS permission.

### 8.2 In-app Notification Inbox
- A list screen: `GET /notifications?page=…&limit=20` (infinite scroll / pagination via `meta.pagination`).
- Show unread vs read styling (`readAt == null` = unread).
- **Badge:** drive the app icon / tab badge from `GET /notifications/unread-count`.
- On tap: `PATCH /notifications/:id/read`, then deep-link using the row's `data` (same `type` routing as §6).
- "Mark all read" action: `POST /notifications/read-all`.
- Pull-to-refresh re-fetches page 1 + unread count.
- Empty state when `total === 0`.

> Note: old notifications are auto-pruned server-side (read after ~90 days, anything after ~180), so the inbox stays bounded — don't cache forever on the client.

---

## 9. Professional-standards checklist ✅

Please tick all of these — this is the bar for "done":

- [ ] **Permission UX:** request notification permission at a sensible moment (not cold on first launch); handle "denied" gracefully with a settings deep link.
- [ ] **Token registration is reliable:** posted on login, on every refresh, and re-posted on app start. Never assume one post is enough.
- [ ] **Logout order:** `DELETE` token → then clear JWT. (Don't orphan tokens — they cause pushes to ex-users' devices.)
- [ ] **Deep-link on `data.type`**, never on copy text. Unknown `type` → open the inbox (safe fallback), don't crash.
- [ ] **All 3 app states** handled (foreground/background/killed) and verified on **both** iOS and Android.
- [ ] **Badge stays in sync** with `unread-count` after every push and every inbox interaction.
- [ ] **Inbox + push are reconciled:** opening the inbox and tapping marks read; don't show counts that disagree.
- [ ] **i18n:** you don't translate notification copy (server does), but your own UI chrome (buttons, empty states) must respect the app language and RTL for Arabic.
- [ ] **Resilience:** network failures on token POST / inbox fetch are retried/queued, not silently dropped.
- [ ] **Security:** never log full FCM tokens or JWTs in production builds.
- [ ] **No duplicate banners:** in foreground, show your in-app banner once (FCM `onMessage` can fire alongside your own logic).

---

## 10. How to test end-to-end

1. Log in → confirm token row exists (I can check the DB, or you log the token and compare).
2. Place an order → expect an **Order placed** push within seconds + a new inbox row + unread badge +1.
3. Ask me/admin to change the order status → expect the matching status push + inbox row.
4. Toggle **Order updates** OFF → place another order → **no push**, but the inbox **still** gets the record (transactional). Toggle promotions OFF → you should get **no** promo pushes at all.
5. Open inbox, tap a notification → it marks read, badge decrements, app deep-links correctly.
6. (Promo) When a scheduled promo code goes live, expect a `PROMOTION` push to the right audience.

If API returns 200 but no push arrives, check: token correctness, **client Firebase project == server (`amoonbloom`)**, iOS APNs key uploaded, and server logs.

---

## 11. What changed on the backend recently (changelog)

- ✅ **In-app inbox is now fully built** (`Notification` model + the 4 inbox endpoints in §3.5–3.8). Earlier versions of this doc said it wasn't — it is now.
- ✅ **Automatic "promo code goes live" notifications** with all-users vs new-users-only audience targeting.
- ✅ **Durable background-job delivery** (pg-boss) with retries; pushes/emails never block requests and survive transient outages.
- ✅ **Concurrency-safe preferences** and **automatic inbox retention/cleanup**.
- ✅ Order emails now go out via **Resend** (transactional) — unrelated to push, FYI.

Anything unclear, ping me and I'll clarify or add examples.

— Backend
