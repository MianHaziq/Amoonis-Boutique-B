const rateLimit = require('express-rate-limit');

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
// Per real client IP (the app sets `trust proxy`, so limits key off the
// X-Forwarded-For client, not the Railway edge). Sized for a content-heavy
// storefront where one browsing visitor legitimately fires many catalog reads.
const MAX_PUBLIC = 300; // per window for public APIs
const MAX_AUTH = 600;  // per window for authenticated
const MAX_AUTH_STRICT = 10; // signin / signup / oauth — guards brute force
const MAX_PASSWORD_RESET = 5; // forgot-password / reset-password — guards email spam

// The storefront's server-side renderer (Next.js SSR/ISR) issues catalog reads
// for EVERY visitor from a SINGLE server IP, so a per-IP public limit would
// throttle the whole site the moment traffic picks up (all SSR requests share
// one bucket). A trusted first-party caller proves itself with the shared
// INTERNAL_API_KEY and bypasses the public/auth limiters; ordinary browser
// traffic (no key) is still limited per real client IP. The strict auth /
// password limiters are deliberately NOT bypassable — the SSR server never
// calls those endpoints, and they must guard credential abuse regardless of
// caller. When INTERNAL_API_KEY is unset the check is always false, so the
// limiters behave exactly as before (safe default — no accidental open door).
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const isTrustedInternal = (req) =>
  Boolean(INTERNAL_API_KEY) && req.get('X-Internal-Key') === INTERNAL_API_KEY;

const publicLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_PUBLIC,
  message: { success: false, message: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTrustedInternal,
});

const authLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_AUTH,
  message: { success: false, message: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTrustedInternal,
});

// Strict limiter for credential / OAuth flows — per-IP, 10 attempts / 15min.
const authStrictLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_AUTH_STRICT,
  message: { success: false, message: 'Too many attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // only count failed attempts so honest users aren't locked out
});

// Strict limiter for password reset endpoints — per-IP, 5 attempts / 15min.
const passwordResetLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_PASSWORD_RESET,
  message: { success: false, message: 'Too many password reset requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { publicLimiter, authLimiter, authStrictLimiter, passwordResetLimiter };
