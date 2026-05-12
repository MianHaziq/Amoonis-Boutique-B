# Mobile App Brief — `firstName` / `lastName` Removed (use `fullName`)

**Status:** Shipped to backend (`main`). Database columns dropped, request/response contracts updated.
**App impact:** **Action required.** This is a breaking change for any screen that reads or sends `firstName` / `lastName`.

---

## TL;DR

- The backend no longer has `firstName` or `lastName` — anywhere. Not in the database, not in API responses, not in request bodies.
- The only name field is **`fullName`** (string).
- Old request bodies that still send `firstName` / `lastName` are **silently ignored** on update endpoints and **rejected with 400** on signup / admin-create. Stop sending them.
- Old response parsers that read `user.firstName` / `user.lastName` will now read `undefined`. Replace with `user.fullName`.

---

## Why we did this

We had three name fields competing for the same data: `fullName`, `firstName`, `lastName`. Every API call had to handle three states, every form had to keep them in sync, and order/contact joins selected all three. One canonical field is simpler and removes a class of "name shows correctly on Screen A but not Screen B" bugs.

The `fullName` field has been the canonical source since the migration on **2026-05-09**. This change finishes the cleanup by removing the legacy columns.

---

## What changed in the API

### 1) Signup — `POST /auth/signup`

**Before**

```json
{ "firstName": "Aisha", "lastName": "Khan", "email": "...", "password": "..." }
```

**Now — required**

```json
{ "fullName": "Aisha Khan", "email": "...", "password": "..." }
```

Sending only `firstName` / `lastName` → **400 `"Full name is required"`**.

### 2) Apple Sign In — `POST /auth/apple`

**Before:** `fullName` OR `firstName` + `lastName` accepted.
**Now:** only `fullName`. Apple gives you the name only on first authorization — keep passing it from the client when present, just as `fullName`.

```json
{ "identityToken": "...", "fullName": "Aisha Khan", "email": "..." }
```

### 3) Google Sign In — `POST /auth/google`

**No change to the request.** You still pass `idToken` or `accessToken` exactly as before. The backend now stores Google's `name` (or `given_name + family_name` if `name` is missing) into the **`fullName`** column on the user row. No work for the app.

### 4) Update profile — `PUT /auth/profile/:userId`

Only `fullName` is read.

```json
{ "fullName": "Aisha Khan" }
```

If you still send `firstName` / `lastName`, they're **silently dropped** (no error, no effect). Update your "Edit Profile" screen to bind to a single text field.

### 5) Every response that used to include `firstName` / `lastName`

These no longer contain those fields at all:

- `POST /auth/signup`, `POST /auth/signin`, `POST /auth/google`, `POST /auth/apple` → `data.user`
- `GET /auth/user/:userId` (the "me" endpoint)
- `GET /user/profile`
- `PUT /auth/profile/:userId`
- `GET /users` and `GET /users/:id` (admin list / detail)
- `POST /users`, `PUT /users/:id` (admin create / update)
- `GET /orders` and `GET /orders/admin/history` — `data[*].user` is now `{ id, email, fullName }`
- `GET /contact/admin/issues` — `data[*].user.firstName` / `.lastName` gone

Every one of these now exposes a single `fullName` (string, nullable).

### 6) Admin user sort — `GET /users?sortBy=...`

Old enum: `[fullName, firstName, lastName, email, createdAt, role, status]`
New enum: `[fullName, email, createdAt, role, status]`

Passing `sortBy=firstName` or `sortBy=lastName` won't crash — the server silently falls back to `createdAt` — but admin panel sort buttons should be removed for those columns.

### 7) Admin user search — `GET /users?search=...`

Search now matches against `email` and `fullName` only (was: email, fullName, firstName, lastName). No app change unless your admin search UI advertises "search by first name" — the behaviour is the same from the user's perspective for any name typed into one box.

---

## Concrete checklist for the app team

**Search-and-replace your codebase for these symbols and fix each hit:**

- `firstName`
- `lastName`
- `first_name`
- `last_name`

**Specific screens to touch:**

1. **Signup screen** — single "Full name" text field. Drop the two-field layout.
2. **Edit profile / Personal details screen** — single "Full name" text field. The PATCH/PUT payload sends `{ "fullName": "..." }` only.
3. **Apple Sign In** — when reading Apple's `fullName` object (`givenName` / `familyName`), concatenate them on the client and send as a single `fullName` string. Do NOT send `firstName` / `lastName` keys in the body.
4. **Admin panel — users list** — remove "First Name" and "Last Name" columns. Use the single "Full name" column.
5. **Admin panel — create/edit user form** — single "Full name" field.
6. **Admin panel — sort dropdown** — remove "First name" / "Last name" sort options.
7. **Admin panel — order detail customer card** — read `order.user.fullName`. Don't fall back to `firstName + ' ' + lastName`.
8. **Admin panel — contact / issue list** — read `contact.user.fullName`.
9. **Profile / Account screens that display the user's name** — read `fullName` directly. Stop computing `${firstName} ${lastName}`.

**Validation rules to update:**

- Single field. Required on signup. Trim whitespace. The backend trims server-side, but trimming on the client keeps your UI honest.
- No format constraint (we accept any non-empty string). A user can type "Mohammed bin Rashid Al Maktoum" or "Cher" — both valid.

**What you can delete:**

- Any client-side splitter that does `name.split(' ')` to derive first/last.
- Any back-compat code that reads `firstName ?? fullName.split(' ')[0]`.
- The `firstName` / `lastName` columns in your local SQLite / Realm / Hive cache schema (you'll need a local migration to drop them on the device).

---

## Migration timing

- **Backend:** already shipped. Old app builds will keep working in degraded mode:
  - Signups from old clients that send only `firstName` / `lastName` → **break (400)**.
  - Profile updates from old clients that send `firstName` / `lastName` → **silently no-op**, no error.
  - All read endpoints from old clients → keys just become `undefined`. If the app crashes on `undefined`, that's an old-client crash, not a backend issue.
- **Recommended:** ship the app-side change in the next release. Force-update users on the previous version is not required, but signups will fail until they update.

---

## Verified server-side

We tested 18 scenarios before this brief: signup happy path, signup with only legacy fields (400), mixed payloads, signin shape, profile shape, profile update with `fullName`, profile update with legacy fields (ignored), admin create / list / stats / search / sort, admin orders, admin order history, addresses, admin contact list. Every response is clean — no leftover `firstName` or `lastName` anywhere.

---

## Questions?

If any screen of the app is reading or sending these fields and you're not sure how to refactor it, ping backend with the screen name and the current payload — we'll suggest the migration path.
