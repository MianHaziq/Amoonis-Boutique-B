# Contact / Issue API — App Developer Integration Guide

Hey 👋 — here is the final shape of the in-app contact form.

The form only sends **two fields**: `subject` and `message`. The user's name, email and phone are **not** in the body — the backend reads them from the user profile using the `userId` from the JWT. The admin panel sees the full user details on each submission.

The form does require the user to have a **phone number** on their profile before they can submit. The app should pre-fill name / email / phone from the profile, and if `phone` is empty, ask the user to add it via the existing phone-update API before letting them send the message.

---

## TL;DR

1. **On contact-screen open** → `GET /api/v1/user/profile` to load the user's `fullName`, `email`, `phone`.
2. **If `phone` is null or empty** → show a "please add your phone number" UI; send the new value via `PATCH /api/v1/user/profile/phone`, then continue.
3. **Submit** → `POST /api/v1/contact/issue` with `{ subject, message }` only.

Base URL: `https://<your-host>/api/v1` (the legacy `/api` prefix also works).

---

## 1. Load profile for pre-fill

`GET /api/v1/user/profile`

**Headers**

```
Authorization: Bearer <user JWT>
```

The response includes (among other fields):

```json
{
  "fullName": "John Doe",
  "email":    "john@example.com",
  "phone":    null
}
```

Pre-fill the contact screen's display fields:

| Field on screen | Source | Editable here? |
|-----------------|--------|----------------|
| Full name       | `fullName` | No — display only |
| Email           | `email`    | No — display only |
| Phone           | `phone`    | Editable if null (see step 2) |
| Subject         | user input | Yes |
| Message         | user input | Yes |

These three identity fields are **not** sent to the contact endpoint — the backend resolves them from the JWT.

---

## 2. Require phone before submit

If `user.phone` is `null` or empty:

- Show an inline prompt: *"Please add your phone number so we can contact you back."*
- Let the user enter a phone.
- Call:

```
PATCH /api/v1/user/profile/phone
Authorization: Bearer <user JWT>
Content-Type: application/json

{ "phone": "+971507654321" }
```

On `200`, refresh the local profile state with the new phone and unlock the submit button. (Sending an empty string clears it again.)

> **Belt-and-suspenders:** the contact endpoint *also* checks this server-side and returns `400` with the message `"Please add a phone number to your profile before submitting a contact."` if the user somehow gets past your client check. Treat that 400 as "open the add-phone flow."

---

## 3. Submit the contact

`POST /api/v1/contact/issue`

**Headers**

```
Authorization: Bearer <user JWT>
Content-Type: application/json
```

**Body — only these two fields**

```json
{
  "subject": "Order missing item",
  "message": "My package was missing the scarf I ordered."
}
```

Both fields are required and trimmed; empty strings are rejected.

**Success — 201**

```json
{
  "success": true,
  "message": "Contact submitted successfully",
  "data": {
    "id": "b76096bc-3d36-41cb-a18f-c00bbfe98790",
    "userId": "fc4a0f2b-c7fe-44ec-b396-40fad318c655",
    "subject": "Order missing item",
    "message": "My package was missing the scarf I ordered.",
    "status": "NEW",
    "createdAt": "2026-05-11T14:21:39.537Z",
    "updatedAt": "2026-05-11T14:21:39.537Z"
  }
}
```

**Errors**

| Code | When |
|------|------|
| 400  | `subject` or `message` missing/empty (`errors[]` includes the field). |
| 400  | User has no phone on profile — open the add-phone flow and retry. |
| 401  | Missing / invalid / expired token. |

---

## 4. End-to-end flow on the app

```
[Open contact screen]
        │
        ▼
GET /user/profile
        │
        ▼
   ┌────────────┐
   │ phone null │── yes ──► Show "Add phone" UI
   └─────┬──────┘            │
         │ no                ▼
         │            PATCH /user/profile/phone
         │                   │
         ▼                   ▼
[Show form: name/email/phone read-only,
 subject + message inputs]
         │
         ▼
POST /contact/issue { subject, message }
         │
         ▼
   [Success toast] ─── go back ───►
```

---

## 5. Admin side (FYI — not your job, just so you know what the admin sees)

`GET /api/v1/contact/admin/issues` (admin / manager with `CONTACT` permission) returns each submission with the sender's user record embedded:

```json
{
  "subject": "Order missing item",
  "message": "...",
  "status":  "NEW",
  "user": {
    "id": "...",
    "fullName": "John Doe",
    "firstName": "John",
    "lastName": "Doe",
    "email":    "john@example.com",
    "phone":    "+971501234567",
    "avatar":   null,
    "role":     "CUSTOMER"
  }
}
```

That's why we need the phone on the profile — the admin uses it to follow up.

---

## 6. Quick cURL recipes

```bash
# Get the current profile (for pre-fill)
curl https://<host>/api/v1/user/profile \
  -H "Authorization: Bearer $USER_TOKEN"

# Add or update the user's phone
curl -X PATCH https://<host>/api/v1/user/profile/phone \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"phone":"+971501234567"}'

# Submit a contact
curl -X POST https://<host>/api/v1/contact/issue \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"subject":"Order missing item","message":"My package was missing the scarf."}'
```

---

## 7. Notes

- Don't put `fullName`, `email`, or `phone` in the contact request body — they will be ignored. The backend trusts the JWT, not the body, for identity.
- After a successful 201, clear the form. No follow-up call needed; the admin sees the row immediately.
- A 401 means the session expired — route through normal re-login.
- There's no user-facing "my issues history" endpoint yet — ping me if you want one (`GET /api/v1/contact/my-issues`) and I'll add it.

Reach out if anything's unclear or if you want the phone check moved client-side only (currently it's enforced on both sides for safety).
