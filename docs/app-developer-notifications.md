# Push Notifications — App Developer Integration Guide

Hi 👋 — here's everything you need to wire push notifications into the mobile app. The backend is **ready and live** for the order-lifecycle flow; promotions/announcements have backend functions in place but no admin trigger UI yet (out of scope for the app integration).

---

## TL;DR

- **Provider:** Firebase Cloud Messaging (FCM HTTP v1). No OneSignal, no Expo, no APNs-direct — just Firebase.
- **Backend status:** ✅ Ready. Firebase service account is already configured on the server.
- **What you do:**
  1. Get the FCM token from the Firebase SDK on the device.
  2. After login, `POST` it to `/api/v1/user/push/token`.
  3. On logout, `DELETE` it from the same endpoint.
  4. Listen for incoming FCM messages and deep-link based on the `data.type` field.
  5. (Optional) Build a settings screen using `/api/v1/user/notifications/preferences`.

---

## 1. Provider & Setup

We use **Firebase Cloud Messaging (FCM)** via the Firebase Admin SDK on the server. You'll need:

- The **Firebase project** credentials (google-services.json for Android, GoogleService-Info.plist for iOS) — I'll share these separately. They must come from the **same Firebase project** the backend uses, otherwise tokens won't be deliverable.
- For iOS: APNs auth key uploaded to the Firebase Console (Project Settings → Cloud Messaging → Apple app configuration).
- For Android: nothing extra — google-services.json is enough.

The data payload uses string values only (FCM constraint), so parse accordingly on the client.

---

## 2. API Endpoints

All endpoints require a JWT bearer token from the existing auth flow.

**Base URL:** `https://<your-host>/api/v1` (production) or `http://<lan-ip>:5000/api/v1` (local).
A legacy `/api` prefix (without `/v1`) also works for backward compatibility, but prefer `/api/v1`.

### 2.1 Register device token

```http
POST /api/v1/user/push/token
Authorization: Bearer <JWT>
Content-Type: application/json

{
  "fcmToken": "<token from Firebase SDK>",
  "platform": "ANDROID"   // "IOS" | "ANDROID" | "WEB" — defaults to ANDROID
}
```

**Response 200:**
```json
{
  "success": true,
  "message": "Device registered for push notifications",
  "data": {
    "id": "uuid",
    "platform": "ANDROID",
    "updatedAt": "2026-05-10T12:34:56.000Z"
  }
}
```

**Notes:**
- Idempotent — calling it again with the same token just refreshes `updatedAt`.
- If the same token was previously registered to another user (e.g. someone else logged in on this device), the backend automatically transfers it to the current user.
- One user can have **multiple tokens** (phone + tablet, etc.) — each device registers its own.
- Call this once after login and again whenever the SDK reports a token refresh (`onTokenRefresh` / `onNewToken`).

Source: [src/controllers/pushNotification.controller.js:5-24](../src/controllers/pushNotification.controller.js#L5-L24)

### 2.2 Unregister device token (on logout)

```http
DELETE /api/v1/user/push/token
Authorization: Bearer <JWT>
Content-Type: application/json

{ "fcmToken": "<same token>" }
```

**Response 200:** `{ "success": true, "message": "Device unregistered" }`
**Response 404:** Token not found for this user.

Important: do this **before** clearing the JWT on logout, otherwise the request will 401.

Source: [src/controllers/pushNotification.controller.js:26-37](../src/controllers/pushNotification.controller.js#L26-L37)

### 2.3 Get notification preferences

```http
GET /api/v1/user/notifications/preferences
Authorization: Bearer <JWT>
```

**Response 200:**
```json
{
  "success": true,
  "message": "Notification preferences",
  "data": {
    "orderStatus": true,
    "promotions": true,
    "announcements": true,
    "updatedAt": "2026-05-10T12:34:56.000Z"
  }
}
```

If the user has never set preferences, the row is created on first read with all three set to `true`.

### 2.4 Update notification preferences

```http
PATCH /api/v1/user/notifications/preferences
Authorization: Bearer <JWT>
Content-Type: application/json

{
  "orderStatus": true,
  "promotions": false,
  "announcements": true
}
```

All three fields are optional individually, but at least one must be present (returns 400 otherwise). Returns the updated preferences object.

Source: [src/controllers/pushNotification.controller.js:39-67](../src/controllers/pushNotification.controller.js#L39-L67)

---

## 3. What the backend sends

Today, **two events** trigger pushes:

### 3.1 Order placed (right after checkout)

Triggered automatically inside `createOrder()`. Sent to all of that user's registered devices, gated by the `orderStatus` preference.

```json
{
  "notification": {
    "title": "Order placed",
    "body": "Thank you! Your Amoon Bloom order was received."
  },
  "data": {
    "brand": "Amoon Bloom",
    "type": "ORDER_PLACED",
    "orderId": "<uuid>",
    "status": "PENDING"
  }
}
```

### 3.2 Order status change (admin updates the order)

Triggered when admin/manager changes order status. `PENDING` is skipped (already covered above).

```json
{
  "notification": {
    "title": "On the way",
    "body": "Your order has shipped."
  },
  "data": {
    "brand": "Amoon Bloom",
    "type": "ORDER_STATUS",
    "orderId": "<uuid>",
    "status": "SHIPPED"
  }
}
```

Status → title/body mapping (server-side, [src/services/pushNotification.service.js:10-16](../src/services/pushNotification.service.js#L10-L16)):

| Status | Title | Body |
|---|---|---|
| `CONFIRMED` | Order confirmed | Your Amoon Bloom order is confirmed. |
| `PROCESSING` | Preparing your order | We're getting your items ready. |
| `SHIPPED` | On the way | Your order has shipped. |
| `DELIVERED` | Delivered | Your order was delivered. Enjoy! |
| `CANCELLED` | Order cancelled | Your order has been cancelled. |

### 3.3 Future channels (backend functions exist, not wired yet)

- `type: "PROMOTION"` — gated by `promotions` preference
- `type: "ANNOUNCEMENT"` — gated by `announcements` preference

These will arrive in the same shape (notification + data with a `type` field) once we add the admin trigger. Build the client-side handler now so it's ready.

### 3.4 Platform-specific options the server already sets

- **Android:** `priority: high` — wakes the device for foreground delivery.
- **iOS:** `apns.payload.aps.sound = "default"` — plays the default sound.

You don't need to set anything else on the client to get sound/priority — it's done.

---

## 4. Client-side handling

**Always branch on `data.type`** (not on the `notification` text — copy will change). Suggested deep links:

| `data.type` | Action |
|---|---|
| `ORDER_PLACED` | Navigate to order detail screen, `orderId` from data |
| `ORDER_STATUS` | Same — order detail screen, optionally show toast with new `status` |
| `PROMOTION` | Navigate to promo/deals screen (when implemented) |
| `ANNOUNCEMENT` | Navigate to news/announcements screen (when implemented) |

Handle three states:
1. **Foreground** — Firebase fires `onMessage`/`onMessageReceived`. You'll need to render an in-app banner manually; the system tray won't show it.
2. **Background** — System tray notification. Tap navigates via your `onNotificationOpenedApp` handler.
3. **Killed/Quit** — Tap launches the app; read `getInitialNotification()` on startup and route from there.

---

## 5. Token lifecycle — please get this right

This is where most integrations break:

1. **On every app start (when logged in):** Get the current FCM token and POST it. The endpoint is idempotent.
2. **On token refresh** (`onTokenRefresh` / `onNewToken`): POST the new token. Old token gets cleaned up automatically by FCM rejecting it server-side.
3. **On logout:** DELETE the token first, *then* clear the JWT.
4. **On login as a different user on the same device:** Just POST the token with the new JWT. The backend handles the transfer.

If a token becomes invalid (uninstall, etc.), FCM returns `messaging/registration-token-not-registered` and the backend automatically purges it ([src/services/pushNotification.service.js:55-67](../src/services/pushNotification.service.js#L55-L67)) — you don't need to do anything.

---

## 6. Testing

Once you've got the token registration working, the simplest end-to-end test:

1. Log in on the device, register the token.
2. Place an order through the app → you should get the "Order placed" push within seconds.
3. Have me (or admin) update the order status → you should get the matching status push.
4. Toggle `orderStatus: false` via PATCH → place another order → no push should arrive.

If pushes don't arrive but the API calls return 200, check:
- Token is correct (log it on the client, compare to DB).
- Firebase project on the client matches the one on the server (most common cause of silent failures).
- iOS: APNs key is uploaded to Firebase Console.
- Server logs — push errors are logged but don't block the request.

---

## 7. Questions / open items

- **In-app notification history (a "Notifications" inbox screen with read/unread state)** isn't built yet. If the design needs it, let me know and I'll add a `Notification` model + endpoints (`GET /notifications`, `PATCH /notifications/:id/read`, unread count). It's ~half a day of backend work.
- **Rich media (image in push)** isn't sent today, but FCM supports it. If the design needs hero images in pushes, ping me and I'll add an `imageUrl` to the payload.
- **Deep link URLs** — currently I'm sending `orderId` and you build the route on the client. If you'd rather have a full `deepLink` string in the data payload, easy to add.

Anything else, just ping me.

— Backend
