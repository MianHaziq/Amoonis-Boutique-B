# Backend Security & Correctness Audit — Amoon Bloom API

**Stack:** Express 5 · Prisma 7 · PostgreSQL · pg-boss · MyFatoorah
**Reviewed:** 2026-06-28
**Surface:** ~18.5k LOC across services, controllers, jobs

> Scope: backend code paths only — orders, payments, inventory reservation, promotions,
> authentication, and the background-job machinery. Does **not** include dependency CVE
> scanning, infrastructure/secrets-management review, or a live penetration test.
> `file:line` references are against the working tree at review time and drift with edits —
> verify before editing.

## Summary

| Severity | Count |
|----------|-------|
| 🔴 Critical | 1 |
| 🟠 High | 9 |
| 🟡 Medium | 21 |
| 🔵 Low | 8 |
| **Total** | **39** |

The codebase is genuinely mature on the hard parts (atomic stock reservation, idempotent
payment confirmation, hashed/rotating refresh tokens, fail-closed underpayment handling).
The real risks are at the edges — configuration, timing races, and missing input bounds.

### Fix first

Ordered by blast radius × likelihood. The top three can lose money or hand over the store.

1. **AUTH-1 — Forge-able admin tokens.** The live `.env` ships `JWT_SECRET=your-jwt-secret` and startup never rejects it.
2. **AUTH-2 — Rate limiting silently off.** `trust proxy` unset behind Railway → every brute-force guard keys on the proxy IP.
3. **PAY-1 — Charged + oversold.** A cancelled-then-paid order can flip to PAID and silently un-cancel to PROCESSING with stock already returned and never re-deducted.
4. **AUTH-4 — Account deletion without a password.** Omit the `password` field and the re-auth check is skipped entirely.
5. **AUTH-3 — CORS reflects any origin with credentials**, exposing the browser-based admin panel.
6. **CFG-1 — Maintenance mode is decorative.** Nothing server-side reads it; checkout stays open.

---

## Payments & Orders

`order.service` · `payment.service` · `order.controller`

The order core is well-built — stock is reserved atomically at placement, the PAID flip is a
single-winner conditional `UPDATE`, and underpayments fail closed. The remaining risks are
timing races and the absence of a state machine, not the happy path.

### 🟠 PAY-1 (High) — Expire-vs-pay race un-cancels an order and oversells stock
**Location:** `order.service.js:1331 → 1406 → 1416` (confirmOrderPayment) vs `orderExpire.job.js:38-87`

**Impact:** `confirmOrderPayment` reads the order once, then the PAID claim guards
only on `paymentStatus != 'PAID'` — not on `status` — and acts on the stale snapshot. If the
expire job cancels the order (restoring stock, `inventoryDeducted:false`) in the gap, a late
payment still claims it PAID, `finalizePaidOrder` sees the stale `PENDING_PAYMENT`, and drives
it to PROCESSING. `updateOrderStatus` then sees `CANCELLED→PROCESSING` so it does **not**
re-deduct. Net: customer charged, order silently un-cancelled, stock oversold, manual refund.

> Status values renamed 2026-07-21 (see `APP_TEAM_CHANGES_2026-07-21.md`) — this bug's mechanics
> are otherwise unchanged, but the order-status admin UI now exposes 8 targets (was 6), including
> ON_HOLD/REFUNDED/FAILED/DRAFT, from any current status with the same lack of a transition
> legality check described in PAY-2 below — a slightly wider surface for the same underlying gap.

**Fix:** Make the claim status-aware (`status IN ('PENDING_PAYMENT')`) and re-read the
order under `SELECT … FOR UPDATE` before `finalizePaidOrder`, so a cancelled order routes to the
`order_cancelled_needs_refund` path instead of confirming.

### 🟡 PAY-2 (Medium) — No order state machine; any status transition is allowed
**Location:** `order.service.js` (updateOrderStatus)

**Impact:** The handler validates only that the target is a known status, not that the transition
is legal. `COMPLETED→CANCELLED` restores stock for goods already delivered; `CANCELLED→PROCESSING`
un-cancels and confirms without re-deducting (oversell). Admin-only, but a fat-finger corrupts
inventory and fulfilment state.

**Fix:** Define an allowed-transitions map and reject illegal moves with a 409; require an
explicit "force restock" flag for any path that returns stock after fulfilment.

### 🟡 PAY-3 (Medium) — Apple Pay `EXECUTING` marker can permanently strand an order
**Location:** `order.service.js:1204-1248` (executeOrderPayment)

**Impact:** The double-charge guard writes `paymentTransactionId='EXECUTING'` and clears it in a
`finally`. If the process dies between the two, the marker sticks, `paymentStatus` stays
non-PAID, and every future execute returns `payment_already_in_progress` forever —
`initiateOrderPayment` doesn't clear it either. The order's native-pay path is bricked.

**Fix:** Make the marker recoverable: store a timestamp and treat a marker older than the gateway
timeout as stale and reclaimable; have the reconcile job sweep stranded markers.

### 🟡 PAY-4 (Medium) — Reconcile job can overlap itself
**Location:** `paymentReconcile.job.js:68` · `jobs/index.js:48` (no singletonKey)

**Impact:** Runs every 3 min over up to 200 orders, each a MyFatoorah round-trip. A slow run still
active when the next fires means two runs hit the same invoices — doubled gateway calls and a
widened PAY-1 window. Outcome is idempotent, but wasteful and risk-amplifying.

**Fix:** Schedule with a `singletonKey` so only one reconcile runs at a time.

### 🔵 PAY-5 (Low) — Webhook unauthenticated when the secret is unset
**Location:** `payment.service.js:203` · `order.controller.js:275` · `MYFATOORAH_WEBHOOK_SECRET` currently unset

**Impact:** `verifyWebhookSignature` returns `true` when no secret is configured (it is not).
Re-verification via GetPaymentStatus means a forged event can't mark an order paid, but
unauthenticated POSTs (and the public GET callback) trigger outbound gateway calls with no rate
limit — a minor amplification/DoS vector.

**Fix:** Set `MYFATOORAH_WEBHOOK_SECRET` in production and rate-limit the callback/webhook routes.

---

## Authentication & Access Control

`auth.controller` · `middleware` · `server.js`

Refresh-token design is strong (hashed at rest, single-use rotation, revoke-on-password-change,
`tokenVersion` invalidation). The problems are at the edges: secret handling, proxy config, CORS,
and a couple of fail-open guards.

### 🔴 AUTH-1 (Critical) — Weak JWT secret accepted; no strength check; algorithm not pinned
**Location:** `.env` (`JWT_SECRET=your-jwt-secret`, 15 chars) · `config/env.js:81` · `middleware/auth.js:79,129`

**Impact:** The working `.env` contains the literal placeholder. `validateEnv` only checks the var
is non-empty and only throws when `NODE_ENV==='production'`; there's no length/placeholder check,
and `jwt.verify` doesn't pin `algorithms`. If the placeholder reaches any deployed env, an
attacker forges `{ role:'ADMIN' }` tokens and owns every admin route.

**Fix:** Reject missing/placeholder/<32-char secrets at startup in **all** environments; rotate
the real secret; pass `{ algorithms:['HS256'] }` to every verify call.

### 🟠 AUTH-2 (High) — Rate limiting broken behind the proxy
**Location:** `server.js` (no `app.set('trust proxy', …)`) · `middleware/rateLimit.js`

**Impact:** Deployed behind Railway but `trust proxy` is never set, so `req.ip` is the proxy's
address. Every limiter (signin, signup, OAuth, password-reset) shares one bucket — either
throttling all users together or bypassable via spoofed `X-Forwarded-For`. This silently negates
the brute-force protection that AUTH-1 and enumeration depend on.

**Fix:** `app.set('trust proxy', 1)` (match the real proxy hop count) so limiters key on the true
client IP.

### 🟠 AUTH-3 (High) — CORS reflects any origin with credentials enabled
**Location:** `server.js:64` — `cors({ origin: true, credentials: true })`

**Impact:** Reflects the caller's `Origin` for every site while allowing credentials. The intended
`ALLOWED_ORIGINS` allowlist is commented out. Any malicious page can issue credentialed
cross-origin requests against the browser-based admin panel.

**Fix:** Restore the allowlist; never pair `origin:true` with `credentials:true`.

### 🟠 AUTH-4 (High) — Account deletion skips the password check when it's omitted
**Location:** `auth.controller.js:881-888` (deleteAccount)

**Impact:** Guard is `if (user.password && password) { verify }`. If the account has a password but
the request omits the field, verification is skipped and the account (cascading orders,
addresses) is deleted unconditionally — a stolen token wipes the account without re-auth.

**Fix:** When `user.password` exists, require `password` and 401 on absence/mismatch.

### 🟡 AUTH-5 (Medium) — Ownership checks fail open
**Location:** `auth.controller.js:501, 765, 812, 871`

**Impact:** Pattern `if (req.userId && req.userId !== userId) 403` is skipped entirely if
`req.userId` is ever falsy. Not exploitable today (verifyToken always sets it), but one
middleware-ordering change (see AUTH-6) turns it into account takeover.

**Fix:** Fail closed: `if (!req.userId || req.userId !== userId) 403`.

### 🟡 AUTH-6 (Medium) — Validation runs before authentication on profile routes
**Location:** `userProfile.routes.js:117, 145, 205, 244, 268, 323`

**Impact:** Validator chains run before `verifyToken`, so unauthenticated callers get 400 responses
that distinguish valid vs invalid payload shapes — minor info leak and inconsistent with the rest
of the codebase, and the precondition that makes AUTH-5 latent.

**Fix:** Mount `verifyToken` first on every authenticated route.

### 🟡 AUTH-7 (Medium) — Inconsistent admin-promotion policy; no last-admin protection
**Location:** `user.controller.js:258-262, 423-437` vs `createUser:83-85`

**Impact:** `createUser` forbids creating an ADMIN, but `updateUser` / `changeUserRole` accept
`role:'ADMIN'` from the body — the policy is trivially bypassed. No guard stops
demoting/deactivating the last admin (lockout risk).

**Fix:** Enforce the no-ADMIN-via-API rule consistently; block demotion/deactivation of the final
active admin.

### 🟡 AUTH-8 (Medium) — Google access-token sign-in doesn't verify audience
**Location:** `auth.controller.js:208-227`

**Impact:** The ID-token flow correctly pins the audience; the access-token flow just calls
`userinfo`. An access token minted for *any* other Google app with the profile/email scope is
accepted as proof of identity — classic confused-deputy.

**Fix:** Validate `aud`/`azp` via `tokeninfo`, or require the ID-token flow only.

### 🟡 AUTH-9 (Medium) — Apple sign-in: `email_verified` and nonce not enforced
**Location:** `appleAuth.service.js:59-84` · `auth.controller.js:411-445`

**Impact:** Signature/iss/aud/exp are verified (good) and linking by unverified email is correctly
blocked. Residual: no nonce (replay binding) and `email_verified` is ignored, so a new account
can be created with an attacker-chosen email (stored `isEmailVerified:false`, which limits it).

**Fix:** Require and verify a client nonce; trust the token email only when `email_verified===true`.

### 🔵 AUTH-10 (Low) — Signin timing oracle enables email enumeration
**Location:** `auth.controller.js:147-155`

**Impact:** Unknown email returns before any bcrypt work; a known email runs bcrypt(12). The
latency delta reveals which emails are registered (worsened by AUTH-2).

**Fix:** Run a dummy bcrypt compare against a constant hash on the not-found path.

### 🔵 AUTH-11 (Low) — Assorted hardening gaps
**Location:** `userProfile`/`user` routes · `auth.controller.js:769-802` · `auth.routes.js` validators

**Impact:** No rate limiter on authenticated mutation/admin routes; `getMe` selects `password` then
strips it in JS (one careless spread away from leaking the hash); password minimum is only 6
characters.

**Fix:** Add limiters to authenticated writes; never select the hash; raise the password policy.

---

## Inventory & Catalog

`product.service` · `category.service` · routes

Storefront visibility (DRAFT hiding, region scoping) and the atomic stock-reservation path are
sound — no DRAFT leak, no SQL injection, no N+1 in the list paths. The gaps are missing input
bounds and one unbounded public read.

### 🟠 CAT-1 (High) — GET /categories/:id returns every product, unpaginated
**Location:** `category.service.js:155-176` (nested products include has no `take`)

**Impact:** The public, unauthenticated detail endpoint loads and serializes *all* published
products in the category. A large category produces a huge response and heavy DB load — a cheap
DoS. Sections already cap this at `take:50`.

**Fix:** Bound the nested include with `take` + `orderBy`; point full browsing at the paginated
products endpoint.

### 🟠 CAT-2 (High) — `discountedPrice` may exceed `price` (no cross-field check)
**Location:** `product.routes.js:116-117, 167-168`

**Impact:** Each is validated only as `isFloat({min:0})`; nothing rejects `discountedPrice > price`.
The storefront then shows a "discount" higher than the base price. Checkout is safe (it charges
the lower of the two), so this is display/data-integrity, not an overcharge.

**Fix:** Add a cross-field validator on create and update (compare against existing price when
price isn't in the payload).

### 🟡 CAT-3 (Medium) — Product update sets stock absolutely (lost update)
**Location:** `product.service.js:298`

**Impact:** `quantity` is overwritten with the submitted value. A restock to `100` discards any
deductions that happened since the form loaded, and two managers editing concurrently clobber each
other — bypassing the careful atomic reservation logic in the order path. Can't go negative, but
can be wrong.

**Fix:** Use an explicit atomic delta/restock op, or gate the absolute set with an
optimistic-concurrency token (`updatedAt`).

### 🟡 CAT-4 (Medium) — `Category.totalProducts` drift + unhandled delete error
**Location:** `category.service.js:129-137` · `section.service.js:88`

**Impact:** `deleteCategory` counts then deletes in two non-transactional statements; under a race
the `onDelete:Restrict` FK throws Prisma `P2003`, which the controller doesn't map → 500 instead
of a clean 409. The denormalized counter has no reconciliation and is read raw by sections (stale
counts there).

**Fix:** Wrap count+delete in a transaction, map `P2003` to 409, and have sections read live
`_count`.

### 🟡 CAT-5 (Medium) — Price has no max bound or decimal constraint
**Location:** `product.routes.js:116-117` · `schema.prisma:302-303` (Decimal(10,2))

**Impact:** Values with >2 decimals are silently rounded by Postgres (stored price ≠ submitted);
values ≥ 10^8 overflow `Decimal(10,2)` and throw an unhandled 500.

**Fix:** Validate `isDecimal({ decimal_digits:'0,2' })` with a sane max; bind as string to avoid
float drift.

### 🟡 CAT-6 (Medium) — Unbounded `page` → deep-offset scans
**Location:** `product.service.js:418-420`

**Impact:** `limit` is capped but `page` isn't, so `?page=99999999` forces a massive OFFSET scan on
a public endpoint — a known latency/DoS vector.

**Fix:** Cap page, or switch hot lists to keyset pagination on the existing `(status, createdAt)`
index.

### 🔵 CAT-7 (Low) — Region filter drops out when no region resolves
**Location:** `utils/regionVisibility.js:22-34`

**Impact:** If `req.regionId` is null, the region clause is omitted and all published products show
to all regions. Low likelihood given the default-region fallback, but worth a guard if zero
regions are ever configured.

**Fix:** Treat a null region as "no products" (or assert a default region exists at boot).

---

## Promotions

`promoCode.service` · `order.service`

Discount math is recomputed against live prices at commit (never trusts the preview), and the
global usage cap is closed with an atomic conditional `UPDATE`. The per-user cap is the one race
that's only narrowed, not closed.

### 🟡 PROMO-1 (Medium) — Per-user usage cap is racy
**Location:** `order.service.js:385-392` (count, not atomic — acknowledged in comments)

**Impact:** The per-user limit is enforced by a `count()` inside the transaction. Two concurrent
orders both read "under the limit" and both proceed — a user can exceed `usageLimitPerUser` and
double-redeem an otherwise single-use / new-user code.

**Fix:** Add a partial unique index (or conditional insert) keyed on (promoCodeId, userId) per
redemption to serialize, mirroring the global-cap approach.

### 🔵 PROMO-2 (Low) — Promo numeric fields lack NaN / negative guards
**Location:** `promoCode.service.js:138-157` (maxDiscountAmount, min/maxOrderAmount)

**Impact:** These pass through raw `Number()` with no finiteness/sign check. A bad string becomes
`NaN` written to a Decimal column (500); negative caps are accepted.

**Fix:** Validate finite and ≥ 0 alongside the existing `discountValue` checks.

### 🔵 PROMO-3 (Low) — Dead `recordUsage` duplicates the commit-time increment
**Location:** `promoCode.service.js:653` (exported, never called)

**Impact:** The order service inlines its own atomic usage increment; `recordUsage` does the same
thing and is unused. Harmless now, but a future wiring that calls both double-counts usage.

**Fix:** Remove it, or make it the single source of truth and route the order path through it.

---

## Background Jobs & Reliability

`jobs/queue` · handlers · `worker.js`

pg-boss is wired sensibly with an inline fallback when the engine is down, and most queries are
batched. The reliability gaps are around pg-boss's 15-minute job-expiry default and the absence of
a dead-letter path for transactional sends.

### 🟠 JOB-1 (High) — Long fan-out jobs hit the 15-min expiry and silently truncate
**Location:** `jobs/queue.js:95-108` (no expireInSeconds) · `broadcast.job.js`

**Impact:** pg-boss marks any job active past 15 minutes as expired. `push.broadcast` (with
`retryLimit:0`) is then marked failed mid-fan-out and never enqueues the remaining users — a
silent partial broadcast for a large user base.

**Fix:** Set an explicit `expireInSeconds` sized to the worst case, and make broadcast resumable
(cursor / per-user `singletonKey`).

### 🟠 JOB-2 (High) — No dead-letter queue for transactional email / push
**Location:** `jobs/queue.js:96` (createQueue, no deadLetter)

**Impact:** An `email.send` (password reset, order confirmation) that exhausts its retries is
archived failed and purged after 7 days with only a log line — no capture, no alert. Important
mail is lost invisibly.

**Fix:** Configure a `deadLetter` queue for email/push and surface its depth on the jobs status
endpoint with an alert.

### 🟡 JOB-3 (Medium) — Notification cleanup deletes in one unbatched statement
**Location:** `cleanup.job.js:49-65`

**Impact:** The code's own comment promises capped batches, but the implementation is a single
`deleteMany`. The first run on a large `Notification` table is one long-lock mass delete.

**Fix:** Loop deleting in capped batches (e.g. 5k) until zero, as the comment describes.

### 🟡 JOB-4 (Medium) — `startJobs` can wedge the engine into inline-only mode
**Location:** `jobs/index.js:31-39`

**Impact:** `started=true` is set before the registration loop, which can throw on a duplicate
queue. After a throw, the `if (started) return` short-circuit means the engine never starts and
everything silently runs inline — contradicting the documented "never throws" contract.

**Fix:** Wrap registration in try/catch; set `started` only after success (reset on failure).

### 🟡 JOB-5 (Medium) — Worker shutdown backstop armed too late
**Location:** `worker.js:43-55` (vs `server.js:211-215` which is correct)

**Impact:** The force-exit timer is set after `await stopJobs()`, so if the drain hangs the
backstop never fires and the worker blocks until the platform SIGKILLs it, losing in-flight jobs
ungracefully.

**Fix:** Arm an unref'd `setTimeout(()=>process.exit(1), N)` before awaiting, mirroring
`server.js`.

### 🟡 JOB-6 (Medium) — Promo marked "announced" even if its broadcast fails
**Location:** `promoAnnounce.job.js:79-103`

**Impact:** `announcedAt` is stamped at enqueue, not on delivery. If the broadcast later fails (e.g.
via JOB-1), the promo is permanently flagged announced with nobody notified, and the daily job
won't retry it.

**Fix:** Stamp `announcedAt` on broadcast completion, or track announce state separately from
enqueue.

### 🔵 JOB-7 (Low) — Cron schedules run in UTC with no timezone
**Location:** `jobs/index.js:48` (no tz) · promoAnnounce / cleanup crons

**Impact:** For an AED / Arabic (UTC+4) business, "daily 03:00" and "just after midnight" promo
announcements can land hours early/late or a day off relative to local expectations.

**Fix:** Pass `tz:'Asia/Dubai'` (or the configured business zone) to `boss.schedule`.

### 🔵 JOB-8 (Low) — Inline-fallback work is fire-and-forget
**Location:** `jobs/queue.js:157-164`

**Impact:** When the engine is down, `enqueue` runs handlers without awaiting. A crash during a
queue outage loses that work (e.g. a password-reset email) — despite the "never silently lost"
comment.

**Fix:** Await the inline fallback for critical transactional sends, or persist an outbox row.

---

## Platform & Configuration

`settings` · `upload` · `address` · `banner`

Address and contact ownership scoping is correct (no IDOR), uploads use UUID filenames (no path
traversal), and analytics queries are parameterized and region-scoped. The gaps are an unenforced
kill-switch and missing validation on a few admin write paths.

### 🟠 CFG-1 (High) — Maintenance mode is never enforced server-side
**Location:** `settings.controller.js:34,67` — no middleware reads it

**Impact:** `maintenanceMode` is stored and returned but no middleware gates requests on it.
Enabling it only hides frontend UI — checkout, orders, and every API stay fully open, giving
operators a false sense that the store is offline.

**Fix:** Add a high-in-chain middleware that 503s non-admin routes when enabled, or rename the flag
to make its frontend-only scope explicit.

### 🟡 CFG-2 (Medium) — `PUT /settings` has no input validation
**Location:** `settings.controller.js:51-80` · `settings.routes.js:70` (no validator)

**Impact:** Fields are copied straight into the upsert. Wrong types throw a 500; `hiddenPages` and
`maintenanceMode` flow unvalidated into the *public* `/settings/public` response — store-wide
breakage is one bad write away.

**Fix:** Add a validator chain (ISO-4217 currency, email checks, boolean coercion, allowlisted page
slugs); reject unknown keys.

### 🟡 CFG-3 (Medium) — Uploads trust the client-supplied content type
**Location:** `middleware/upload.js:29-50` · `bunnyStorage.service.js`

**Impact:** The filter keys off `file.mimetype` from the multipart headers, not file content. An
admin/manager (or a compromised manager account) can store arbitrary bytes — polyglot or HTML
mislabeled as an image — on the trusted store CDN. Filenames are safe (UUID).

**Fix:** Sniff magic bytes server-side and derive the extension/content-type from the real type;
ideally re-encode images through sharp.

### 🟡 CFG-4 (Medium) — A user can be left with zero default addresses
**Location:** `address.service.js:154-194` (updateAddress)

**Impact:** The "exactly one default" invariant is enforced for setting `true` (partial unique index
+ clear-others), but setting the only default to `false` promotes nothing — checkout can then find
no default. (Delete correctly promotes the next.)

**Fix:** On transition to `false`, promote the most-recent remaining address in the same
transaction, or reject un-defaulting.

### 🟡 CFG-5 (Medium) — Banner URLs aren't restricted to the CDN
**Location:** `banner.controller.js:23-40` · `banner.routes.js:128` (isURL only)

**Impact:** Only `isURL()` is checked, so a published banner can point at any external/`http` origin
(off-CDN tracking, mixed content, attacker-controlled images) served to all storefront clients.

**Fix:** Validate the host against the configured CDN hostname and require `https`.

---

## Verified Sound (checked, not skipped)

- **Stock reservation** — placement reserves inventory atomically via row-conditional `UPDATE … WHERE quantity >= n`; concurrent orders for the last unit can't both win.
- **Payment idempotency** — the PAID flip is a single-winner conditional update; callback + webhook + SDK execute + retries converge to one placement (PAY-1 is the one status-blind edge).
- **Underpayment** — fails closed: a short payment in the charged currency (or unknown currency) withholds confirmation for manual review.
- **Refresh tokens** — 96-bit random, SHA-256 at rest, single-use rotation, revoke-all on password change, `tokenVersion` invalidation of access tokens.
- **SQL injection** — all raw queries use parameterized tagged templates; no string interpolation of user input found.
- **Address / contact IDOR** — every read/write is scoped by the authenticated `userId`.
- **Storefront visibility** — DRAFT and out-of-region items don't leak to non-staff; staff flags require an active ADMIN/MANAGER token with matching `tokenVersion`.
- **Promo discount math** — recomputed against live prices at commit and capped at the eligible subtotal; never trusts the preview amount.
