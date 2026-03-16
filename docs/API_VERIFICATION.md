# API Verification: Response Consistency, Error Handling, Performance

This document summarizes verification of **consistent API responses**, **consistent error handling**, and **performance** across the Amoonis Boutique API.

---

## 1. Consistent API Response

### Standard shapes

- **Success:** `{ success: true, message?: string, data?: any, meta?: object }`
- **Error:** `{ success: false, message: string, errors?: Array<{ field, message }> }`

Defined in `src/utils/response.js`: `success(res, data, message, status, meta)` and `error(res, message, status, errors)`.

### Where it’s used

| Area | Uses response util? | Notes |
|------|----------------------|--------|
| **Category, Product, Cart, Order** | ✅ Yes | All use `success()` / `error()` |
| **Auth** | Manual but same shape | `{ success, message, data }` |
| **Settings** | ✅ Yes | Switched to `success()` |
| **Upload** | ✅ Yes | Switched to `success()` / `error()` |
| **Contact, User, Admin** | Manual | Same shape: `success`, `message`, `data` |
| **Validation middleware** | Fixed shape | `success: false`, `message: 'Validation failed'`, `errors[]` |
| **Auth middleware (401/403)** | Fixed shape | `success: false`, `message` |
| **Global error handler** | Fixed shape | `success: false`, `message`, `errors?` |

All JSON responses use the same success/error structure so clients can rely on `success` and `message` (and `data` / `errors` / `meta` where applicable).

---

## 2. Error Handling

### Global error handler (`src/middleware/errorHandler.js`)

- **Prisma P2002** (unique violation) → `409` + “A record with this value already exists”
- **Prisma P2025** (record not found) → `404` + “Record not found”
- **Other** → `err.status` / `err.statusCode` or `500`, message from error (or “Internal Server Error”)
- **Payload:** `{ success: false, message[, errors] }` (same as response util)
- **Logging:** Full stack in non-production; message-only for 5xx in production (no stack leak)

### Controller pattern

- Controllers use **try/catch** and pass errors to **next(err)** so the global handler can respond.
- Known cases (e.g. Prisma P2025, P2002, custom `CATEGORY_HAS_PRODUCTS`) are often handled in the controller with `error(res, message, status)` and only unexpected errors are passed to `next(err)`.

### Validation errors

- `handleValidationErrors` returns **400** with `{ success: false, message: 'Validation failed', errors: [{ field, message }] }`, matching the standard error shape.

### Auth middleware

- **401** (no token, invalid/expired token) and **403** (insufficient role) return `{ success: false, message }` with no stack or internal details.

Result: one consistent way to represent errors (status code + same JSON shape) and no leaking of internals in production.

---

## 3. Performance

### Rate limiting (`src/middleware/rateLimit.js`)

- **Public routes:** 100 requests per 15 minutes per IP.
- **Authenticated routes:** 200 requests per 15 minutes per IP.
- Prevents abuse and keeps the API stable under load.

### Database

- **Pagination:** List endpoints (products, orders, categories list) use `page`/`limit` with a cap (e.g. limit max 100) to avoid large result sets.
- **Count + list in parallel:** Product and order list handlers use `Promise.all([findMany(...), count(...)])` so list and total count are fetched in one round-trip.
- **Select only what’s needed:**
  - Product list/category: `include: { category: { select: { id, title } } }`.
  - Cart: `product: { select: { id, title, image, price, discountedPrice } }` (no full product blob).
  - Order items: product limited to `id`, `title`, `image` (and similar) where enough for display.
- **Indexes (Prisma schema):**
  - User: unique on `email`, `googleId`.
  - Category: `@@index([title])`.
  - Product: `@@index([categoryId])`, `@@index([title])`.
  - Cart: `@@index([userId])`; CartItem: `@@unique([cartId, productId])`, `@@index([cartId])`, `@@index([productId])`.
  - Order: `@@index([userId])`, `@@index([status])`, `@@index([createdAt])`; OrderItem: `@@index([orderId])`, `@@index([productId])`.
  - ContactMessage: `@@index([status])`, `@@index([createdAt])`.

### Transactions

- **Checkout:** Order creation + order items + cart clear happen inside a single `prisma.$transaction(...)` so consistency and rollback are guaranteed.

### Summary

- Responses are consistent (success/error shape and response util where applicable).
- Errors are handled in one place (global handler + validation + auth) with a single JSON format and safe production behavior.
- Performance is considered via rate limits, pagination, parallel count+list, minimal selects/includes, indexes, and transactional checkout.
