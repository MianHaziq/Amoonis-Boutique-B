# Backend Changes — 2026-07-21 — App Team Brief

**What changed:** The order `status` field's allowed values were renamed (client-requested,
WooCommerce-style status set). **This is a breaking change for any code that matches on the old
literal strings.**

| Ref | Area | App impact |
|---|---|---|
| 1 | Order `status` enum renamed | **BREAKING — action required.** Old values no longer returned or accepted. |
| 2 | Push/inbox `data.status` for `ORDER_STATUS` events | **BREAKING — action required.** Same new literal strings appear here too. |
| 3 | `GET /orders/history`, `/orders/admin/history`, `/orders`, `/orders/export` `status` query param | **BREAKING** — an old value (e.g. `?status=DELIVERED`) now returns **400 Invalid value**, not results. |
| 4 | `PATCH /orders/{id}/status` body | **BREAKING** — `{ "status": "CONFIRMED" }` (or any other old value) now returns **400 Invalid status**. |
| 5 | Orders are no longer hidden pre-payment | **Informational, no code change needed.** See below — may change what you expect to *not* see in list endpoints. |

---

## 1) Order status values renamed

**Old set (7 values):** `AWAITING_PAYMENT`, `PENDING`, `CONFIRMED`, `PROCESSING`, `SHIPPED`,
`DELIVERED`, `CANCELLED`.

**New set (8 values):** `PENDING_PAYMENT`, `PROCESSING`, `ON_HOLD`, `COMPLETED`, `CANCELLED`,
`REFUNDED`, `FAILED`, `DRAFT`.

**Mapping (for reference — existing/historical orders in the database were migrated exactly like
this; new orders only ever start at `PENDING_PAYMENT`):**

| Old value | New value |
|---|---|
| `AWAITING_PAYMENT` | `PENDING_PAYMENT` |
| `PENDING` | `PENDING_PAYMENT` |
| `CONFIRMED` | `PROCESSING` |
| `PROCESSING` | `PROCESSING` |
| `SHIPPED` | `PROCESSING` |
| `DELIVERED` | `COMPLETED` |
| `CANCELLED` | `CANCELLED` |
| *(none — new)* | `ON_HOLD` |
| *(none — new)* | `REFUNDED` |
| *(none — new)* | `FAILED` |
| *(none — new)* | `DRAFT` |

**What this means for the app:**
- Any `switch`/`if` statement (Dart or otherwise) matching on the old status strings — for
  displaying the order status, driving a progress stepper, or handling a push deep-link — will no
  longer match. If you use an **exhaustive enum match with no default/fallback case**, this can
  crash on an unrecognized value. **Add a fallback case before this ships to your users**, even if
  you don't localize all 8 values immediately.
- The old 5-step fulfillment flow (`PENDING → CONFIRMED → PROCESSING → SHIPPED → DELIVERED`)
  collapses to 3 steps: `PENDING_PAYMENT → PROCESSING → COMPLETED`. If your progress stepper UI
  hardcodes 5 steps, it needs to become 3.
- `ON_HOLD`, `REFUNDED`, `FAILED`, `DRAFT` are **admin-set labels only** — the app never triggers
  them itself, but must be able to *display* an order in any of these states without crashing.
  None of them deduct/restore stock or change payment state on their own from the app's point of
  view — they're purely informational for the buyer.
- `paymentStatus` (`UNPAID`/`PAID`/`FAILED`) is a **separate, unchanged field** — do not confuse
  `OrderStatus.FAILED` (a rare admin-set order state) with `paymentStatus: "FAILED"` (an online
  payment attempt that didn't go through — this one is unchanged and still the one to check after
  a payment attempt).

All request/response examples in `APP_DEVELOPER_HANDOFF.md`, `APP_DEVELOPER_GUIDE_apple_pay_flutter.md`,
`APP_DEVELOPER_GUIDE_payments_and_notifications.md`, `app-developer-notifications.md`, and
`GUEST_CHECKOUT_MOBILE.md` have been updated to the new values — re-read the relevant sections
rather than relying on memory of the old contract.

## 2) Push / inbox payloads

`ORDER_STATUS` push and inbox notifications carry the new literal in `data.status`, e.g.:
```json
{ "type": "ORDER_STATUS", "orderId": "...", "status": "PROCESSING" }
```
Only `PROCESSING`, `ON_HOLD`, `COMPLETED`, `CANCELLED`, `REFUNDED`, `FAILED` ever trigger this push
(`PENDING_PAYMENT` is covered by the separate `ORDER_PLACED` push instead; `DRAFT` never notifies
a customer). See `app-developer-notifications.md` §5 for the full updated table.

## 3–4) Query param / body validation

These were already validated server-side (`express-validator` `.isIn([...])`) against the enum —
only the allowed value list changed. An old client sending an old value gets a normal `400` with
`errors: [{ field: "status", message: "Invalid status" }]` — not a silent no-op or a 500.

## 5) No more hidden pre-payment state

Previously, an online order sat in a hidden `AWAITING_PAYMENT` state — excluded from
`/orders/history` and admin lists until payment succeeded. That hidden state no longer exists:
**every order, online or COD, is a real, visible order in `PENDING_PAYMENT` from the moment it's
placed.** If your app's order-history screen assumed unpaid online orders would never appear,
that assumption no longer holds — they now appear immediately, same as a COD order does today.
