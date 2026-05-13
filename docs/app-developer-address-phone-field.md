# Mobile App Brief — Phone Number in the Address Form

**Status:** No backend change required — every endpoint mentioned below is already live.
**App impact:** **UX change.** Add a required "Phone number" field to the "Add / Edit Address" screen, prefilled from the user profile.

---

## TL;DR

- Show a **Phone number** input in the address form.
- **Prefill** it from the user's saved profile phone if they have one; show **empty** if not.
- The field is **required** to save the address.
- The user can edit the prefilled phone — both when their profile already has one and when it's empty.
- When the user changes the phone, save it both to the **address row** and (recommended) to their **profile** so the next address prefills with the latest number.

The backend already stores phone on every address row and decorates address responses with the profile phone, so no API changes are required. You only need to wire up three existing endpoints in the right order.

---

## The flow

```
┌─────────────────────────────────────────────────────────────────┐
│  User taps "Add Address"                                         │
│           │                                                       │
│           ▼                                                       │
│  App reads user profile (already in app state, or                 │
│  GET /user/profile)                                               │
│           │                                                       │
│           ▼                                                       │
│  Phone field prefilled with profile.phone                         │
│   - If profile.phone is null → empty input                        │
│   - If profile.phone exists → prefilled, editable                 │
│           │                                                       │
│           ▼                                                       │
│  User fills / edits address. Phone is REQUIRED.                   │
│  Client validation: phone must be non-empty before "Save" enables.│
│           │                                                       │
│           ▼                                                       │
│  On Save:                                                         │
│    1. POST /user/addresses with phone in the body                 │
│    2. If phone differs from profile.phone →                       │
│       also PATCH /user/profile/phone (recommended)                │
└─────────────────────────────────────────────────────────────────┘
```

---

## APIs to use

### 1) Read the prefill value — `GET /user/profile`

You probably already call this on app start. The response includes `phone`:

```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "fullName": "Aisha Khan",
    "phone": "+971501234567",          // ← prefill the address phone input from here
    "preferredLanguage": "en",
    "addressCountry": "United Arab Emirates",
    "addressCity": "Dubai",
    ...
  }
}
```

If `data.phone` is `null`, leave the input empty.

**Auth:** `Authorization: Bearer <accessToken>`

---

### 2) Save the address — `POST /user/addresses`

The `phone` field is already accepted on this endpoint. Send it in the body:

**Request**

```http
POST /api/v1/user/addresses
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{
  "label": "Home",
  "phone": "+971501234567",
  "streetAddress": "Villa 14, Al Wasl Road",
  "apartment": "Apt 401",
  "city": "Dubai",
  "country": "United Arab Emirates",
  "isDefault": true
}
```

**Required by app UX (enforce client-side):** `phone`.
**Optional on the server:** every other field — the user can save a partial address. Phone is also technically optional on the backend today; if you don't enforce client-side, the user will save addresses with null phone, which checkout will fall back to the profile phone for. The cleanest UX is client-side required.

**Response (201)** — note `phone` is decorated from either the row or the profile, whichever is present:

```json
{
  "success": true,
  "message": "Address added successfully",
  "data": {
    "id": "550e8400-...",
    "label": "Home",
    "fullName": "Aisha Khan",
    "phone": "+971501234567",
    "streetAddress": "Villa 14, Al Wasl Road",
    "apartment": "Apt 401",
    "city": "Dubai",
    "state": null,
    "postalCode": null,
    "country": "United Arab Emirates",
    "isDefault": true,
    "createdAt": "2026-05-12T15:00:00.000Z",
    "updatedAt": "2026-05-12T15:00:00.000Z"
  }
}
```

---

### 3) Edit an existing address — `PATCH /user/addresses/{id}`

Same shape, partial update. Only send the fields you changed:

```http
PATCH /api/v1/user/addresses/550e8400-...
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{ "phone": "+971509999999" }
```

**Response (200)** — same shape as POST.

---

### 4) Update the canonical profile phone — `PATCH /user/profile/phone`

This is the **existing dedicated endpoint** for the user's profile phone. Call it whenever the user enters or changes a phone number on the address form so the next address auto-prefills with the latest value.

**Request**

```http
PATCH /api/v1/user/profile/phone
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{ "phone": "+971509999999" }
```

**Response (200)**

```json
{
  "success": true,
  "message": "Phone number updated successfully",
  "data": { "phone": "+971509999999" }
}
```

**To clear the profile phone:** send `{ "phone": "" }` (empty string).

---

## Recommended save sequence

```dart
// pseudocode
Future<void> saveAddress(AddressForm form, UserProfile profile) async {
  // 1. Always store phone on the address row itself.
  final saved = await api.post('/user/addresses', {
    'label': form.label,
    'phone': form.phone,            // <-- required by your UX
    'streetAddress': form.street,
    'apartment': form.apartment,
    'city': form.city,
    'country': form.country,
    'isDefault': form.isDefault,
  });

  // 2. If the phone differs from the user's profile phone, update the profile
  //    so the next address auto-prefills with the latest value.
  if (form.phone != profile.phone) {
    await api.patch('/user/profile/phone', { 'phone': form.phone });
    // Update local profile cache so the next "Add Address" screen prefills correctly.
    appState.profile = appState.profile.copyWith(phone: form.phone);
  }
}
```

**Order matters:** save the address first, then update the profile. If the address save fails (e.g. address-limit reached), you haven't already mutated the profile.

---

## UX rules

| Situation | What the app shows | What the app sends |
|---|---|---|
| New user, no profile phone | Empty phone input, "Required" hint | New phone in `POST /user/addresses` + new phone in `PATCH /user/profile/phone` |
| Returning user, profile.phone exists | Phone input prefilled with `profile.phone`, editable | If unchanged → only `POST /user/addresses`. If changed → both endpoints. |
| Editing an existing address (PATCH) | Phone input prefilled with `address.phone` | `PATCH /user/addresses/{id}` with the new phone. Update profile too if user explicitly wants it as their default phone. |

---

## Validation rules to enforce on the client

- **Required.** Disable "Save" until the user has entered a phone number.
- **Trim whitespace** before submitting — the backend trims server-side but trimming on the client keeps the error states honest.
- **Length / format** — no strict backend validation today; recommend a basic country-code-aware mask (e.g. `intl-phone-field`) so users don't submit garbage. The backend stores whatever string you send.

---

## Edge cases

1. **User types a phone, then clears it before saving.** Block save with "Phone is required." The backend would accept an empty/null phone and the address-list would silently fall back to the profile phone — but your UX rule is "required", so block at the form level.
2. **User has no profile phone and submits the first address.** Send phone in both calls (`POST /user/addresses` and `PATCH /user/profile/phone`). The user now has a profile phone for next time.
3. **Phone differs between two addresses** (Home vs. Work). Allow it — each address row has its own phone column. Only call `PATCH /user/profile/phone` for the address the user marks as their primary contact phone (you can ask "Use this phone as your main contact number?" with a checkbox).
4. **Logged-in user with old `address.phone = null` rows from before this change.** The address-list response already returns `profile.phone` as a fallback for those rows. No migration needed — just show what comes back.
5. **Sign-up / Google / Apple flows.** None of them collect phone today. The first phone a user enters will be on the address form. That's the trigger to also write it to the profile.

---

## What the backend does NOT need

You asked whether anything backend-side has to change. It doesn't:

- `POST /user/addresses` already accepts `phone` ([src/routes/address.routes.js:22](src/routes/address.routes.js#L22)).
- `PATCH /user/addresses/{id}` already accepts `phone` ([src/routes/address.routes.js:35](src/routes/address.routes.js#L35)).
- Address responses already include `phone`, falling back to the profile if the row is null ([src/services/address.service.js:52](src/services/address.service.js#L52)).
- `PATCH /user/profile/phone` already exists ([src/routes/userProfile.routes.js:145](src/routes/userProfile.routes.js#L145)).

If you later want phone to be **server-enforced required** on `POST /user/addresses` (so a buggy client can't save addresses without it), say the word and we'll add the validator. Today's behavior is "client enforces required, server is permissive."

---

## Quick reference — API base

- Base URL: `/api/v1`
- All endpoints below require `Authorization: Bearer <accessToken>`

| Purpose | Method | Path |
|---|---|---|
| Read profile (for prefill) | GET | `/user/profile` |
| List saved addresses | GET | `/user/addresses` |
| Create address | POST | `/user/addresses` |
| Update address | PATCH | `/user/addresses/{id}` |
| Delete address | DELETE | `/user/addresses/{id}` |
| Set address as default | PATCH | `/user/addresses/{id}/default` |
| Update profile phone | PATCH | `/user/profile/phone` |

---

## Questions?

If your UX requires server-side enforcement of "phone is required on POST/PATCH address" — ping backend. It's a one-line change but a breaking one for any client still sending empty phone, so we want a coordinated rollout.
