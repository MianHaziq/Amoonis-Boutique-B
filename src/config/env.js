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
];

function validateEnv() {
  const missing = required.filter((key) => !process.env[key] || process.env[key].trim() === '');
  if (missing.length > 0 && process.env.NODE_ENV === 'production') {
    console.error('[ENV] Missing required environment variables:', missing.join(', '));
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (missing.length > 0) {
    console.warn('[ENV] Missing optional-for-dev variables (required in production):', missing.join(', '));
  }
  return { required: required.filter((k) => process.env[k]), optional };
}

module.exports = { validateEnv, required, optional };
