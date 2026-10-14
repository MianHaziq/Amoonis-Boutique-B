# Per-region National Address (Short Address) at checkout — backend done, your turn

**Date:** 2026-10-14
**Who this is for:** Admin panel developer **and** storefront / user-side (customer app) developer
**Status:** Backend shipped & tested. Two small UI changes needed before this is complete.

---

## The problem we fixed

The checkout "National Address / Short Address" field (the Saudi 4-letters-4-digits code, e.g. `JHRC3674`) was **hardcoded as required for every region**. That meant customers in **UAE — and any non-Saudi region — were blocked at checkout** by a field that only Saudi Arabia actually needs.

## The fix (concept)

We made it a **per-region admin toggle**. Each region now has a boolean flag:

- **`shortAddressEnabled = true`** → checkout **shows and requires** the Short Address field (this is Saudi Arabia).
- **`shortAddressEnabled = false`** → the field is **not shown and not required** (UAE and everyone else). This is the **default**.

So the admin decides, per region, whether this field appears and is mandatory. Nothing else about checkout changed.

**Current data:** `SA = true`, `UAE = false`.

---

## What we changed on the backend

1. Added a new column `shortAddressEnabled` (boolean, default `false`) to the **Region** model + DB migration.
2. **Admin create/update region** endpoints now accept `shortAddressEnabled` in the body.
3. **Public `GET /regions`** now returns `shortAddressEnabled` on every region object.
4. **Checkout validation** no longer blanket-requires the field. The requirement is now enforced **per region**, server-side, on both authenticated checkout and guest checkout.

The field itself is unchanged: it is sent at checkout as a **top-level `shortAddress`** string (NOT nested inside `shippingAddress`). Format: **4 letters followed by 4 digits**, an optional single space/hyphen is tolerated (`JHRC3674`, `JHRC 3674`, `JHRC-3674`); it is stored uppercased without separators.

---

## API reference

Base URL (local): `http://localhost:5000/api/v1`
Region is selected per request via the **`X-Region`** header (e.g. `X-Region: SA` or `X-Region: UAE`).

### 1) Read regions — `GET /regions` (public)

Use this to populate the region picker AND to decide whether to render the Short Address field.

**Response (trimmed to the relevant fields):**

```json
{
  "success": true,
  "message": "Regions retrieved",
  "data": [
    {
      "id": "…-uuid-…",
      "code": "UAE",
      "name": "United Arab Emirates",
      "currency": "AED",
      "shortAddressEnabled": false
    },
    {
      "id": "…-uuid-…",
      "code": "SA",
      "name": "Saudi Arabia",
      "currency": "SAR",
      "shortAddressEnabled": true
    }
  ],
  "meta": { "total": 2 }
}
```

> `shortAddressEnabled` is a real boolean. Read it off the region the customer is checking out in.

### 2) Update a region — `PUT /regions/{id}` (admin / manager)

Used by the **admin panel** to flip the toggle. Requires an admin/manager JWT with the `REGIONS` permission.

**Headers:** `Authorization: Bearer <admin JWT>`, `Content-Type: application/json`

**Request body (send only what you change — it's a partial update):**

```json
{ "shortAddressEnabled": true }
```

**Response:**

```json
{
  "success": true,
  "message": "Region updated",
  "data": { "id": "…", "code": "SA", "shortAddressEnabled": true }
}
```

> Notes: the value must be a boolean (`true`/`false`). Sending `null` means "leave unchanged". Creating a region (`POST /regions`) also accepts `shortAddressEnabled`; if omitted it defaults to `false`.

### 3) Checkout — `POST /orders/checkout` (auth) and `POST /orders/guest-checkout` (public)

`shortAddress` is a **top-level** body field (sibling of `shippingAddress`, not inside it).

**Request (guest checkout example):**

```json
{
  "items": [{ "productId": "…-uuid-…", "quantity": 1 }],
  "shippingAddress": {
    "fullName": "Test User",
    "phone": "+966500000000",
    "streetAddress": "123 St",
    "city": "Riyadh",
    "country": "Saudi Arabia",
    "area": "Olaya"
  },
  "shortAddress": "JHRC3674"
}
```

**Behavior now depends on the `X-Region` of the request:**

| Region (`X-Region`) | `shortAddressEnabled` | `shortAddress` sent? | Result |
|---|---|---|---|
| SA | true | missing / empty | **400** `{"success":false,"message":"shortAddress is required"}` |
| SA | true | wrong format | **400** `{"success":false,"message":"shortAddress must be 4 letters followed by 4 digits (e.g. JHRC3674)"}` |
| SA | true | valid (`JHRC3674`) | ✅ order placed |
| UAE | false | missing / empty | ✅ order placed (field not required) |
| UAE | false | valid value | ✅ order placed (accepted and stored, but not required) |
| any | — | wrong format (non-empty) | **400** format error (format is always validated when a value is present) |

> **Important:** empty is only rejected when the region has the toggle on. A malformed *non-empty* value is always rejected regardless of region.

---

## What the ADMIN PANEL dev needs to do

Add a single toggle to the **Region edit form** (where `codEnabled`, `onlinePaymentEnabled`, etc. already live):

- **Label:** "Require National Address (Short Address) at checkout" (or similar).
- **Bound to:** `region.shortAddressEnabled` (boolean) from `GET /regions`.
- **On save:** include `shortAddressEnabled: true|false` in the `PUT /regions/{id}` body.

That's it — no new endpoint. It behaves exactly like the other per-region boolean toggles you already render.

## What the STOREFRONT / USER-SIDE dev needs to do

At checkout, make the Short Address field **conditional on the current region**:

1. From `GET /regions`, find the region the customer is checking out in (the one whose `code` you send in `X-Region`) and read its `shortAddressEnabled`.
2. **If `true`** → render the Short Address input, mark it **required**, and send it as top-level `shortAddress` in the checkout body. Validate format client-side: `^[A-Za-z]{4}[\s-]?[0-9]{4}$` (show e.g. `JHRC3674`).
3. **If `false`** → **do not render** the field and **do not send** `shortAddress` (or send empty — both are fine).
4. Keep handling the server's 400 errors (`"shortAddress is required"` / the format message) as a fallback.

This removes the hard block for UAE and every other region, while Saudi keeps requiring it.

---

## How we verified it (already tested on the backend)

- `GET /regions` → returns `SA: true`, `UAE: false`. ✅
- Guest checkout to **SA** with no `shortAddress` → `400 "shortAddress is required"`. ✅
- Guest checkout to **UAE** with no `shortAddress` → **order placed successfully**. ✅

Any questions on the payloads, ping us. The backend is live and ready for your changes.
