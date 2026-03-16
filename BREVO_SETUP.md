# Brevo (Sendinblue) SMTP Setup Guide

This guide walks you through setting up Brevo as the email provider for LKnight LMS.
Brevo's free tier gives you **300 emails/day** — plenty for contact forms and password resets.

---

## Step 1: Create a Brevo Account

1. Go to [https://www.brevo.com](https://www.brevo.com)
2. Click **Sign Up Free**
3. Use your business email (e.g., `inquiries@lknightproductions.com`) to sign up
4. Verify your email address via the confirmation link

---

## Step 2: Get Your SMTP Credentials

1. After logging in, go to **Settings** (gear icon, top-right)
2. Navigate to **SMTP & API** (under "Developers" section)
3. You'll see your SMTP settings:
   - **SMTP Server:** `smtp-relay.brevo.com`
   - **Port:** `587`
   - **Login:** Your Brevo account email
4. Click **Generate a new SMTP key**
5. Give it a name (e.g., `lknight-lms-backend`)
6. **Copy the SMTP key** — this is your password (you won't see it again!)

---

## Step 3: Verify Your Sender Email

1. Go to **Settings** → **Senders, Domains & Dedicated IPs**
2. Click **Senders** tab
3. Click **Add a Sender**
4. Add your sender details:
   - **From Name:** `LKnight Learning Hub`
   - **From Email:** `inquiries@lknightproductions.com`
5. Brevo will send a verification email — click the link to confirm
6. Status should change to **Verified**

---

## Step 4: (Recommended) Verify Your Domain

This improves email deliverability and prevents your emails from going to spam.

1. Go to **Settings** → **Senders, Domains & Dedicated IPs**
2. Click **Domains** tab
3. Click **Add a Domain** → Enter `lknightproductions.com`
4. Brevo will show you **DNS records** to add:
   - A **TXT record** for SPF
   - A **TXT record** for DKIM
   - A **CNAME record** for Brevo tracking (optional)
5. Add these records in your domain registrar's DNS settings
6. Come back to Brevo and click **Verify** for each record
7. Once all are verified, your domain is authenticated

---

## Step 5: Update Your `.env` File

Open `LKnight-Lms-backend/.env` and update the email section with your real credentials:

```env
# Email Configuration (Brevo SMTP)
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=your-actual-brevo-login-email@example.com
SMTP_PASS=xsmtpsib-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-xxxxxxxxxx
FROM_EMAIL=inquiries@lknightproductions.com
CONTACT_EMAIL=inquiries@lknightproductions.com
```

Replace:
- `SMTP_USER` → Your Brevo account login email
- `SMTP_PASS` → The SMTP key you generated in Step 2

---

## Step 6: Test the Setup

### Test Contact Form
1. Start the backend: `npm run dev`
2. Start the frontend: `npm run dev`
3. Go to the Contact page and submit a test message
4. Check `inquiries@lknightproductions.com` for:
   - The contact form notification email
   - (Also check the sender's email for the confirmation email)

### Test Forgot Password
1. Go to `/signin` → Click **Forgot password?**
2. Enter a registered user's email
3. Check that email inbox for the password reset link
4. Click the link and set a new password

---

## Production Deployment (Railway)

When deploying to Railway, add these environment variables:

| Variable | Value |
|---|---|
| `SMTP_HOST` | `smtp-relay.brevo.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | Your Brevo login email |
| `SMTP_PASS` | Your Brevo SMTP key |
| `FROM_EMAIL` | `inquiries@lknightproductions.com` |
| `CONTACT_EMAIL` | `inquiries@lknightproductions.com` |
| `FRONTEND_URL` | `https://www.lknightlearninghub.com` |

**Important:** Make sure `FRONTEND_URL` is set to your production URL so password reset links point to the correct domain.

---

## Troubleshooting

| Issue | Solution |
|---|---|
| Emails going to spam | Complete domain verification (Step 4) |
| "Invalid login" error | Double-check `SMTP_USER` is your Brevo email and `SMTP_PASS` is the SMTP key (not your account password) |
| "Sender not verified" | Complete sender verification (Step 3) |
| Password reset link broken | Ensure `FRONTEND_URL` is correct in `.env` |
| Hit daily limit | Free tier is 300/day. Upgrade at brevo.com/pricing if needed |

---

## Email Features Enabled

Once Brevo is configured, these features will work:

1. **Contact Form** (`/contact`) — Sends inquiry to your inbox + confirmation to the sender
2. **Forgot Password** (`/forgot-password`) — Sends password reset link to user's email
3. **Reset Password** (`/reset-password?token=...`) — User sets new password via the emailed link
