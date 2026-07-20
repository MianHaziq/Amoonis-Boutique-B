/**
 * Environment variable validation for Amoon Bloom backend.
 * Required vars must be set for the app to start in production.
 */

const required = [
  'DATABASE_URL',
  'JWT_SECRET',
];

const optional = [
  'NODE_ENV',
  'PORT',
  'HOST',
  'ALLOWED_ORIGINS',
  'ENABLE_API_DOCS', // 'true' forces Swagger UI on in production (off by default there)
  'GOOGLE_CLIENT_ID',
  'APPLE_CLIENT_ID',
  'JWT_EXPIRES_IN',
  'FRONTEND_URL',
  'FROM_EMAIL',
  'RESEND_API_KEY',
  'RESEND_FROM',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'BUNNY_STORAGE_ZONE',
  'BUNNY_STORAGE_REGION',
  'BUNNY_STORAGE_ACCESS_KEY',
  'BUNNY_IMAGES_CDN_HOSTNAME',
  'CONTACT_EMAIL',
  'FIREBASE_SERVICE_ACCOUNT_JSON',
  'FIREBASE_SERVICE_ACCOUNT_BASE64',
  // Auto-translation. Pick a provider with TRANSLATION_PROVIDER:
  //   google → Google Cloud Translation (needs GOOGLE_TRANSLATE_API_KEY)
  //   azure  → Azure AI Translator (needs AZURE_TRANSLATOR_KEY + REGION)
  //   none   → kill switch; admin-supplied bilingual fields saved as provided.
  'TRANSLATION_PROVIDER',
  'GOOGLE_TRANSLATE_API_KEY',
  'GOOGLE_TRANSLATE_ENDPOINT',
  'AZURE_TRANSLATOR_KEY',
  'AZURE_TRANSLATOR_REGION',
  'AZURE_TRANSLATOR_ENDPOINT',
  'TRANSLATION_TIMEOUT_MS',
  'TRANSLATION_RETRY_ATTEMPTS',
  'TRANSLATION_CACHE_MAX',
  // MyFatoorah payments (Apple Pay + cards via hosted page). Payment endpoints
  // are disabled if MYFATOORAH_API_KEY is unset; COD checkout still works.
  'MYFATOORAH_API_KEY',
  'MYFATOORAH_BASE_URL',
  'MYFATOORAH_CALLBACK_URL',
  'MYFATOORAH_ERROR_URL',
  'MYFATOORAH_CURRENCY',
  'MYFATOORAH_TIMEOUT_MS',
  'MYFATOORAH_WEBHOOK_SECRET',
  // Background jobs (pg-boss). The engine runs in-process by default and stores jobs
  // in the existing Postgres (no Redis needed).
  'JOBS_ENABLED', // 'false' fully disables the engine (enqueue runs inline)
  'JOBS_IN_PROCESS', // 'false' = API doesn't run the worker (use `node worker.js`)
  'PGBOSS_SCHEMA',
  'PGBOSS_POOL_MAX',
  'PRISMA_POOL_MAX',
  'SMTP_SECURE',
  // Scheduled-job tuning (sensible defaults baked in; override only if needed).
  'PAYMENT_RECONCILE_CRON',
  'PAYMENT_RECONCILE_MIN_AGE_MIN',
  'PAYMENT_RECONCILE_MAX_AGE_HOURS',
  'PAYMENT_RECONCILE_BATCH',
  'ORDER_EXPIRE_CRON',
  'ORDER_EXPIRE_HOURS',
  'LOW_STOCK_CRON',
  'LOW_STOCK_THRESHOLD',
  'CLEANUP_RESET_TOKENS_CRON',
  'CLEANUP_REFRESH_TOKENS_CRON',
  'REFRESH_TOKEN_RETAIN_DAYS',
  'CART_ABANDONED_CRON',
  'CART_ABANDON_DAYS',
  'PROMO_ARCHIVE_CRON',
];

// A JWT signing secret shorter than this is trivially brute-forceable, which would
// let an attacker forge tokens for any user (including ADMIN). Enforce a floor.
const MIN_JWT_SECRET_LENGTH = 32;

function validateEnv() {
  const missing = required.filter((key) => !process.env[key] || process.env[key].trim() === '');
  if (missing.length > 0 && process.env.NODE_ENV === 'production') {
    console.error('[ENV] Missing required environment variables:', missing.join(', '));
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (missing.length > 0) {
    console.warn('[ENV] Missing optional-for-dev variables (required in production):', missing.join(', '));
  }

  // Guard against a weak/placeholder JWT secret. Fatal in production; a warning in
  // dev so local work isn't blocked.
  const jwtSecret = process.env.JWT_SECRET || '';
  if (jwtSecret && jwtSecret.trim().length < MIN_JWT_SECRET_LENGTH) {
    const msg = `JWT_SECRET is too short (${jwtSecret.trim().length} chars); use at least ${MIN_JWT_SECRET_LENGTH} random characters`;
    if (process.env.NODE_ENV === 'production') {
      console.error('[ENV]', msg);
      throw new Error(msg);
    }
    console.warn('[ENV]', msg);
  }

  return { required: required.filter((k) => process.env[k]), optional };
}

module.exports = { validateEnv, required, optional };
