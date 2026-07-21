# Heads up — order status values changed (breaking change)

Hi team,

We just shipped a change to how orders track their lifecycle on the backend — the client asked us
to move to a WooCommerce-style status set, and it touches the exact field you're already reading
(`order.status`) and the push/inbox payloads you deep-link on. **This needs a small update on your
side before this reaches users**, so please read this before your next release.

## The short version

The old 7 statuses are gone. There are 8 new ones:

| Before | After |
|---|---|
| `AWAITING_PAYMENT` | `PENDING_PAYMENT` |
| `PENDING` | `PENDING_PAYMENT` |
| `CONFIRMED` | `PROCESSING` |
| `PROCESSING` | `PROCESSING` |
| `SHIPPED` | `PROCESSING` |
| `DELIVERED` | `COMPLETED` |
| `CANCELLED` | `CANCELLED` |
| — | `ON_HOLD` *(new)* |
| — | `REFUNDED` *(new)* |
| — | `FAILED` *(new)* |
| — | `DRAFT` *(new)* |

Every order — COD or online — now starts at `PENDING_PAYMENT` and is a real, visible order from
the moment it's placed (there's no more hidden "not really an order yet" state to worry about).

## What you need to do

1. **Find every place you match on the old status strings** — a progress stepper, a status label/
   color, a push deep-link switch on `data.status`. Update them to the new 8 values.
2. **Add a fallback/default case if you don't already have one.** If your status handling is an
   exhaustive `switch` with no default, an unrecognized value can crash. `ON_HOLD`, `REFUNDED`,
   `FAILED`, and `DRAFT` are admin-set only — you'll never trigger them from the app, but you must
   be able to *display* an order sitting in one of them without falling over.
3. **If your progress UI hardcodes 5 steps** (Pending → Confirmed → Processing → Shipped →
   Delivered), collapse it to 3: **Pending payment → Processing → Completed**.
4. **Don't confuse `OrderStatus.FAILED` with `paymentStatus: "FAILED"`.** They're two different
   fields. `paymentStatus` is unchanged — still `UNPAID`/`PAID`/`FAILED` — and still the one to
   check right after a payment attempt. `OrderStatus.FAILED` is a separate, rare, admin-set label.
5. **If you validate the `status` query param client-side** before calling `/orders/history` etc.,
   update the allowed list — the server will now 400 on an old value instead of matching it.

## Where to look for the full detail

- **`docs/APP_TEAM_CHANGES_2026-07-21.md`** — the full breaking-change brief: every endpoint
  affected, example before/after payloads, and the push-notification table.
- **`docs/APP_DEVELOPER_HANDOFF.md`**, **`APP_DEVELOPER_GUIDE_apple_pay_flutter.md`**,
  **`APP_DEVELOPER_GUIDE_payments_and_notifications.md`**, **`app-developer-notifications.md`**,
  **`GUEST_CHECKOUT_MOBILE.md`** — all already updated in place with the new status values in
  every request/response example, so you can keep using them as your day-to-day reference.

## Not urgent, but worth knowing

Nothing about payment flows, Apple Pay, or the endpoints themselves changed — same routes, same
request shapes, same response envelope. This is purely a rename/expansion of the `status` field's
allowed values. If your app currently just displays whatever string the server sends (no hardcoded
switch), you may have very little to change — but please double-check rather than assume.

Ping us if anything here is unclear or if you find a spot we missed.
