const rateLimit = require('express-rate-limit');

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_PUBLIC = 100; // per window for public APIs
const MAX_AUTH = 200;  // per window for authenticated
const MAX_AUTH_STRICT = 10; // signin / signup / oauth — guards brute force
const MAX_PASSWORD_RESET = 5; // forgot-password / reset-password — guards email spam

const publicLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_PUBLIC,
  message: { success: false, message: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_AUTH,
  message: { success: false, message: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
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
