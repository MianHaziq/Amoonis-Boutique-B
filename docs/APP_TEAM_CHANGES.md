# Backend Security Hardening — Mobile App Team Brief

**What changed:** Five backend fixes shipped — three are **invisible to the app today** (existing API contracts unchanged) and **two introduce new optional behavior**. No required code change to keep the current app working, but a few items are strongly recommended.

| Ref | Area | App impact |
|---|---|---|
| C3 | `verifyToken` now blocks deactivated users | **Action required (low effort)** — handle new 403 path |
| C5 | Apple Sign In email anti-impersonation | **Action required (clarify error UX)** — handle two new error responses |
| H7 | Address default uniqueness | None — silent improvement |
| M7 | Refresh tokens added | **Optional adoption** — new fields/endpoints, opt in when ready |
| L8 | Health endpoints added | None — informational |

---

## 1) Deactivated users now get a 403 (C3)

**What changed:** Previously, when an admin set a user's status to `INACTIVE`, that user could still call the app's APIs (cart, orders, profile, addresses, push prefs, etc.) for up to 7 days until their JWT naturally expired. From this release, every authenticated request validates the user's status server-side.

**What the app may now see:**

```json
HTTP 403
{
  "success": false,
  "message": "Your account has been deactivated. Please contact support."
}
```

This can appear on ANY authenticated endpoint, not just login. Propagation takes up to 30 seconds (server-side cache TTL).

**Recommended app behavior:**
- Centralize 401/403 handling in your API client. If status is 403 and `message` includes "deactivated", clear local session and redirect to a "Contact support" screen (or login).
- A new 401 message you may also see is `"Session expired. Please login again."` — same handling as the existing 401 `"Token expired..."` you already handle.

**No request format change. No field rename.**

---

## 2) Apple Sign In — stricter email handling (C5)

**Why:** Previously, the body-supplied `email` could be used by an attacker to link an arbitrary Apple ID to a victim's existing email/password account. The server now only trusts the email that **Apple itself signed** inside the identity token.

**What the app may now see in NEW edge cases:**

- **HTTP 409** — `"This email is already linked to a different Apple ID. Please sign in with your original method."`
  Happens if the user's email is already linked to a different Apple ID in the backend. Almost never seen by real users.

- **HTTP 409** — `"An account with this email already exists. Please sign in with your original method, then link Apple from settings."`
  Happens if a user previously signed up with email+password (or Google), then tries to Sign in with Apple WITHOUT Apple providing email (which only happens on subsequent Apple sign-ins after the very first one). In practice, this only affects users who:
  1. Created an account via email+password OR Google.
  2. Have NEVER used Apple Sign In on this device before.
  3. Try Apple Sign In and Apple omits email (cached at Apple's end).

**Recommended app behavior:**
- Always pass the `identityToken` you receive from Apple.
- On the **first** Apple Sign In on a device, Apple WILL include the email in the identity token. Continue to pass `fullName` (or legacy `firstName`/`lastName`) in the body so the backend can store the user's name.
- If you previously sent `email` in the request body for returning users, you may continue to do so — the backend ignores it for linking. It is only used when creating a brand-new account and Apple omits the email (rare).
- If the user lands on one of the two 409 responses above, show the returned message verbatim and offer a "Sign in with email/password / Google" entry point.

**No request format change. The `email`, `fullName`, `firstName`, `lastName` fields on the request body are still accepted exactly as before.**

---

## 3) Address default uniqueness (H7)

**No app change.** The backend now enforces (at the database level) that a user has at most one default address. If two simultaneous "set default" calls land at the same time, one succeeds and the second silently re-applies its intent — both return the standard 200 with the latest state. No new error codes.

---

## 4) Refresh tokens — opt-in (M7)

**What's new:**

### New fields on existing responses (additive)

`POST /auth/signup`, `POST /auth/signin`, `POST /auth/google`, `POST /auth/apple` now return two additional fields under `data` whenever refresh-token issuance succeeds:

```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "user": { ... },
    "token": "<JWT access token, same as before>",
    "refreshToken": "<NEW — 96-char hex string>",
    "refreshTokenExpiresAt": "2026-08-10T12:34:56.000Z"
  }
}
```

The existing `token` field still contains the access JWT exactly as today. **The app can ignore the new fields entirely and keep working.**

### New endpoints

#### `POST /api/v1/auth/refresh`
Exchanges a refresh token for a new access token (and rotates the refresh token).

Request:
```json
{ "refreshToken": "<refresh token from previous login>" }
```

Response on success (200):
```json
{
  "success": true,
  "message": "Token refreshed successfully",
  "data": {
    "token": "<new access JWT>",
    "refreshToken": "<NEW refresh token — old one is now revoked>",
    "refreshTokenExpiresAt": "2026-08-10T12:34:56.000Z"
  }
}
```

Errors:
- `400` if `refreshToken` missing.
- `401` `"Invalid or expired refresh token. Please login again."` if the refresh token is unknown, expired, or already rotated. **App should clear session and route to login.**
- `403` if the user has been deactivated.

#### `POST /api/v1/auth/logout`
Revokes the supplied refresh token. With no body and a valid Bearer access token, revokes ALL refresh tokens for the current user (use on "sign out everywhere").

Request:
```json
{ "refreshToken": "<refresh token to revoke>" }
```

Response (200):
```json
{ "success": true, "message": "Logged out successfully" }
```

### Recommended adoption order
1. Start persisting `refreshToken` from auth responses (Keychain on iOS, EncryptedSharedPreferences on Android — same place you store the existing `token`).
2. When the API returns 401 `"Token expired. Please login again."`, instead of force-logout, call `POST /auth/refresh` with the stored refresh token. On 200, retry the original request with the new access token.
3. On 401 from `/auth/refresh`, then clear session and route to login.
4. On user-initiated logout, call `POST /auth/logout` with the refresh token, then clear local state.

### Important behavior to be aware of
- **Refresh tokens are single-use.** Every call to `/auth/refresh` returns a new refresh token; the old one is revoked. Concurrent refresh attempts from the same token will result in one success and one 401 — handle that by serializing refresh calls on the client.
- **Password change** (`PUT /auth/change-password/{userId}`) and **password reset** (`POST /auth/reset-password`) now **invalidate all currently issued access tokens AND refresh tokens** for the user. After a password change, the app should treat the user as logged out and redirect to login.
- Refresh-token lifetime is 90 days by default.

---

## 5) Health endpoints (L8) — informational

Two new public endpoints (no auth):
- `GET /health/live` — process up. Always 200 unless the server is down.
- `GET /health/ready` — process can serve traffic (DB reachable). 200 when DB up, 503 when DB down.

These are for monitoring/devops. No app changes needed.

---

## What did NOT change

- **No existing API response field was renamed or removed.** Every key the app currently parses still exists with the same name, type, and meaning.
- **No HTTP status code was changed for existing flows** (except: deactivated users now get 403 instead of being silently let through — see C3).
- **No URL path was changed.** Both `/api/...` and `/api/v1/...` continue to work.
- **No new required request field.** Everything new (refresh token, etc.) is optional from the app's perspective.

---

## Minimum viable rollout for the app

If you want to ship the smallest possible app update that aligns with these backend changes:

1. **Handle 403 with "deactivated" message** anywhere in your API error handler → redirect to login/contact support. *(C3)*
2. **Handle 409 with "already linked / already exists" messages** on the Apple Sign In screen → surface the message and offer alternative sign-in. *(C5)*

Everything else (refresh tokens, logout endpoint, health checks) can be adopted at your own pace without breaking the current app.

---

## Backend rollout notes (FYI)

- The `prisma migrate deploy` step in `npm start` will run the new migration `20260512000000_security_hardening` automatically on Railway. It adds two columns/tables and one partial unique index. No downtime expected; the migration is idempotent (`IF NOT EXISTS` throughout).
- Existing user JWTs (issued before this deploy) **continue to work** — they have no `tv` claim and the middleware accepts them. After natural expiry (≤7 days) all in-circulation tokens will carry the `tv` claim and revocation becomes universal.
- An in-memory cache (30s TTL) prevents the new per-request user lookup from adding measurable latency.

If you have questions about a specific error message or want a Postman collection of the new endpoints, ping the backend channel.
