const rateLimit = require('express-rate-limit');

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_PUBLIC = 100; // per window for public APIs
const MAX_AUTH = 200;  // per window for authenticated

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

module.exports = { publicLimiter, authLimiter };
