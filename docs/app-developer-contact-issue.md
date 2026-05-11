# Contact / Issue Form — App Developer Integration Guide

Hey 👋 — here is everything you need to wire up the in-app **Contact Us / Report an issue** screen.

There is **one submit endpoint** and the body has **two fields only**: `subject` and `message`. The user's name, email and phone are **not** in the body — the backend reads them from the user profile via the JWT, and the admin panel sees them on each row. The only profile requirement is that the user has a **phone number** saved before they can submit; if it's missing, the app must ask the user to add it first.

---

## TL;DR — three calls, in this order

| Step | Call | Purpose |
|------|------|---------|
| 1 | `GET /api/v1/user/profile` | Load `fullName`, `email`, `phone` to pre-fill the contact screen |
| 2 | `PATCH /api/v1/user/profile/phone` *(only if `phone` is null/empty)* | Save the phone the user just typed |
| 3 | `POST /api/v1/contact/issue` | Submit `{ subject, message }` |

Base URL: `https://<your-host>/api/v1` (the `/api` prefix without `/v1` also works).
All three calls need the user JWT in `Authorization: Bearer <token>`.

---

## 1. Load the profile (for pre-fill)

### Request

```
GET /api/v1/user/profile
Authorization: Bearer <user JWT>
```

### Response (200)

```json
{
  "success": true,
  "message": "Profile fetched successfully",
  "data": {
    "id": "6f6c6d36-e66a-4002-94f6-de5370612de5",
    "email": "john@example.com",
    "fullName": "John Doe",
    "firstName": "John",
    "lastName": "Doe",
    "avatar": null,
    "role": "CUSTOMER",
    "status": "ACTIVE",
    "isEmailVerified": false,
    "preferredLanguage": "en",
    "phone": null,
    "addressCountry": null,
    "addressCity": null,
    "createdAt": "2026-04-08T11:22:14.000Z",
    "updatedAt": "2026-05-11T09:14:02.000Z"
  }
}
```

### What to do with each field on the screen

| Field on screen   | Source           | Editable here? | Notes |
|-------------------|------------------|----------------|-------|
| Full name         | `data.fullName`  | ❌ display only | Greys out; lives in profile screen for edits |
| Email             | `data.email`     | ❌ display only | Same — managed elsewhere |
| Phone number      | `data.phone`     | ✅ only when null/empty | See step 2 |
| Subject           | user input       | ✅ | Required, single-line |
| Message           | user input       | ✅ | Required, multi-line textarea |

Pre-fill the three identity fields purely as **display** so the user knows what the support team will see. Don't put them in the contact request body — they get ignored.

---

## 2. Ask for a phone number when `phone` is null

If `data.phone` is `null` or an empty string, the user cannot submit yet. Show an inline prompt:

> *"Please add your phone number so we can get back to you."*

Have them type the new phone, then call:

### Request

```
PATCH /api/v1/user/profile/phone
Authorization: Bearer <user JWT>
Content-Type: application/json
```

```json
{ "phone": "+971507654321" }
```

### Response (200)

```json
{
  "success": true,
  "message": "Phone number updated successfully",
  "data": { "phone": "+971507654321" }
}
```

After 200, store the new phone in your local state and enable the Submit button.

> **Belt-and-suspenders:** the contact endpoint also enforces this server-side and returns **400** with the message `"Please add a phone number to your profile before submitting a contact."` if a request slips through without a phone. Treat that 400 the same way — open the add-phone UI.

---

## 3. Submit the contact

### Request

```
POST /api/v1/contact/issue
Authorization: Bearer <user JWT>
Content-Type: application/json
```

**Body — only these two fields:**

```json
{
  "subject": "Order missing item",
  "message": "My package was missing the scarf I ordered yesterday."
}
```

Both are required and trimmed. Empty strings are rejected.

### Response (201)

```json
{
  "success": true,
  "message": "Contact submitted successfully",
  "data": {
    "id": "9b543679-7eb9-4d48-9993-f0fa5689bded",
    "userId": "fc4a0f2b-c7fe-44ec-b396-40fad318c655",
    "subject": "Order missing item",
    "message": "My package was missing the scarf I ordered yesterday.",
    "status": "NEW",
    "createdAt": "2026-05-11T14:28:10.843Z",
    "updatedAt": "2026-05-11T14:28:10.843Z"
  }
}
```

### Error responses

| HTTP | When | Body shape | App reaction |
|------|------|-----------|--------------|
| 400  | Empty / missing `subject` or `message` | `{ "success": false, "message": "Validation failed", "errors": [{ "field": "subject", "message": "Subject is required" }] }` | Show inline field errors |
| 400  | User profile has no phone | `{ "success": false, "message": "Please add a phone number to your profile before submitting a contact." }` | Open the add-phone UI, then retry the submit |
| 401  | Missing / invalid / expired token | `{ "success": false, "message": "Access denied. No token provided." }` (or `Token expired...`, `Invalid token.`) | Run the re-login flow |

---

## 4. End-to-end flow on the app

```
[User taps "Contact us"]
         │
         ▼
GET /user/profile
         │
   ┌─────┴──────┐
   │ phone null │── yes ──► Show "Add phone" UI ──► PATCH /user/profile/phone ──┐
   └─────┬──────┘                                                                │
         │ no                                                                    │
         ▼                                                                       │
[Render contact screen]                                                          │
  • fullName  (read-only)  ◄──────────────────────────────────────────────────── │
  • email     (read-only)                                                        │
  • phone     (read-only, refreshed from PATCH response) ◄─────────────────────  │
  • subject   (input, required)
  • message   (textarea, required)
         │
         ▼  [User taps Send]
POST /contact/issue { subject, message }
         │
   ┌─────┴─────┐
   │  201      │── show success state, clear form, navigate back
   │  400 (phone) │── re-open Add phone UI
   │  400 (validation) │── highlight field
   │  401      │── re-login
   └───────────┘
```

---

## 5. UI checklist

- ✅ Show the user's `fullName`, `email`, `phone` on the screen, all read-only, so they know what support will see.
- ✅ Show a hint near the phone field: *"This is how we'll reach you back."*
- ✅ If `phone` is empty on screen load, gate the form behind an "Add phone number" CTA instead of letting the user type subject/message first.
- ✅ Disable Submit while a request is in flight; re-enable on response.
- ✅ Don't send `fullName`, `email`, `phone`, `userId` in the body — only `subject` and `message`. Anything else is ignored.
- ✅ On 201, show a confirmation ("Thanks — we'll reply within 24 hours"), then pop the screen.
- ✅ On the `phone-missing` 400, route back to the Add phone UI, not the field-validation UI.

---

## 6. Quick cURL recipes (for testing locally)

```bash
TOKEN="<paste a user JWT here>"

# 1. Pull profile
curl https://<host>/api/v1/user/profile \
  -H "Authorization: Bearer $TOKEN"

# 2. Save a phone number (only when profile.phone is null)
curl -X PATCH https://<host>/api/v1/user/profile/phone \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"phone":"+971501234567"}'

# 3. Submit the contact
curl -X POST https://<host>/api/v1/contact/issue \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"subject":"Order missing item","message":"My package was missing the scarf."}'
```

---

## 7. What the admin will see (FYI)

`GET /api/v1/contact/admin/issues` — admin or manager with `CONTACT` permission. Each row comes back with the sender's profile joined in, so support knows who sent it and how to reach them:

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

That's why we hard-require the phone before submit.

---

## 8. Open questions / nice-to-haves

- No user-facing "my issues history" endpoint yet. Tell me if you want `GET /api/v1/contact/my-issues` and I'll add it.
- No attachments support today (subject + message only). Let me know if you need image uploads for screenshots.
- No status updates pushed back to the user yet (the admin can mark things READ / REPLIED / ARCHIVED internally). Ping me if support wants to notify users when their issue is replied to.

Ping me on anything that's unclear, or if any of the response shapes need to change for the UI.
