# Email System (Resend)

This document describes how email sending works in the Amoonis Boutique backend using **Resend**.

## Overview

- **Primary service:** Resend API for transactional emails.
- **Config:** Environment variables for API key and sender.
- **Module:** `src/services/email.service.js` (used by features such as team invitations; auth password reset can use nodemailer or be wired to Resend).

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `RESEND_API_KEY` | Yes (for Resend) | API key from [Resend](https://resend.com) |
| `FROM_EMAIL` or `RESEND_FROM` | Recommended | Sender address, e.g. `Amoonis Boutique <noreply@yourdomain.com>` |
| (Optional) SMTP vars | For fallback | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` – used by auth (e.g. password reset) if Resend is not used for that flow |

If `RESEND_API_KEY` is not set, `sendEmail` returns `{ sent: false, error: { message: 'Email not configured' } }` and logs a warning.

## Service structure

**File:** `src/services/email.service.js`

### `sendEmail(to, subject, html)`

- **Parameters:** `to` (string), `subject` (string), `html` (string).
- **Returns:** `Promise<{ sent: boolean, id?: string, error?: object }>`.
- Uses `FROM_EMAIL` or `RESEND_FROM` or a default Resend onboarding address.

### `sendTeamInvitationEmail({ to, inviterName, acceptUrl, isExistingUser })`

- Sends a prebuilt HTML template for “you’ve been granted access” / “accept invitation”.
- **Parameters:**
  - `to` – invitee email
  - `inviterName` – name of inviter
  - `acceptUrl` – link to accept or open dashboard
  - `isExistingUser` – if true, copy says access is already granted
- **Returns:** same as `sendEmail`.

## How to send emails

1. **From a controller or service:**  
   `const emailService = require('../services/email.service');`  
   `await emailService.sendEmail(to, subject, html);`

2. **For invitations:**  
   `await emailService.sendTeamInvitationEmail({ to, inviterName, acceptUrl, isExistingUser });`

3. **Error handling:** Check `sent` and optional `error` in the return value; do not throw on failure so the main flow (e.g. saving a record) can continue.

## How to extend (new templates)

1. **Option A – Inline HTML in a new function**  
   Add a new exported function in `email.service.js` that builds `html` and calls `sendEmail(to, subject, html)`.

2. **Option B – Template file**  
   Create a small helper that reads an HTML file or uses a simple placeholder replace (e.g. `{{name}}`, `{{link}}`) and then call `sendEmail(to, subject, html)`.

3. **Option C – Dedicated template module**  
   Create `src/templates/email/` (e.g. `welcome.js`, `orderConfirmation.js`) that return `{ subject, html }` and call `sendEmail(to, subject, html)` from the service.

Keep all Resend usage inside `email.service.js` so API key and sender are in one place.

## Auth password reset

- Currently, password reset in `src/controllers/auth.controller.js` may use **nodemailer** (SMTP) with `SMTP_*` and `FROM_EMAIL`.
- To use Resend for password reset: in the auth controller, replace the nodemailer call with `emailService.sendEmail(user.email, 'Password Reset', html)` and build the same reset link in `html`.

## Summary

- **Resend** is the main email provider; configure `RESEND_API_KEY` and sender.
- **Service:** `email.service.js` – `sendEmail()` and `sendTeamInvitationEmail()`.
- **Extend:** Add new functions or template helpers that call `sendEmail()` with the right subject and HTML.
