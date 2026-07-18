require('dotenv').config();

const { validateEnv } = require('./src/config/env');
try {
  validateEnv();
} catch (e) {
  console.error('[SERVER] Environment validation failed:', e.message);
  process.exit(1);
}

console.log('[SERVER] Starting Amoon Bloom API...');
console.log('[SERVER] NODE_ENV:', process.env.NODE_ENV);
console.log('[SERVER] PORT:', process.env.PORT);

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./src/config/swagger');
const prisma = require('./src/config/db');

process.on('uncaughtException', (err) => {
  console.error('[SERVER] Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[SERVER] Unhandled Rejection at:', promise, 'reason:', reason);
});

// Routes
const authRoutes = require('./src/routes/auth.routes');
const userRoutes = require('./src/routes/user.routes');
const userProfileRoutes = require('./src/routes/userProfile.routes');
const contactRoutes = require('./src/routes/contact.routes');
const settingsRoutes = require('./src/routes/settings.routes');
const vatRoutes = require('./src/routes/vat.routes');
const uploadRoutes = require('./src/routes/upload.routes');
const categoryRoutes = require('./src/routes/category.routes');
const productRoutes = require('./src/routes/product.routes');
const cartRoutes = require('./src/routes/cart.routes');
const orderRoutes = require('./src/routes/order.routes');
const bannerRoutes = require('./src/routes/banner.routes');
const sectionRoutes = require('./src/routes/section.routes');
const regionRoutes = require('./src/routes/region.routes');
const deliveryZoneRoutes = require('./src/routes/deliveryZone.routes');
const analyticsRoutes = require('./src/routes/analytics.routes');
const promoCodeRoutes = require('./src/routes/promoCode.routes');
const addressRoutes = require('./src/routes/address.routes');
const notificationRoutes = require('./src/routes/notification.routes');
const jobsRoutes = require('./src/routes/jobs.routes');
const reviewRoutes = require('./src/routes/review.routes');
const errorHandler = require('./src/middleware/errorHandler');
const { startJobs, stopJobs } = require('./src/jobs');

const app = express();
const PORT = process.env.PORT || 5000;

// AUTH-2: the app runs behind a reverse proxy / load balancer (Railway), so the real
// client IP arrives in X-Forwarded-For. Without trusting the proxy, express-rate-limit
// keys every request on the proxy's IP — one shared bucket for all clients, which both
// throttles legitimate traffic and lets attackers bypass the per-IP brute-force limits.
// Trust a single proxy hop by default; override with TRUST_PROXY (e.g. 2 for two hops).
app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

// const allowedOrigins = process.env.ALLOWED_ORIGINS
//   ? process.env.ALLOWED_ORIGINS.split(',')
//   : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:5000'];

app.use(helmet({
  contentSecurityPolicy: process.env.NODE_ENV === 'production',
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cors({
  origin: true,
  credentials: true,
  // Exposes the export routes' filename to the browser — without this the
  // JS response object hides Content-Disposition on cross-origin requests
  // (frontend/backend run on different ports), even though the raw HTTP
  // response carries it.
  exposedHeaders: ['Content-Disposition'],
}));
// Capture the raw request body (used to verify the MyFatoorah webhook HMAC signature).
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// API v1 base
const v1Router = express.Router();

// Swagger (served at /api-docs, no version prefix)
const swaggerOptions = {
  swaggerOptions: {
    tryItOutEnabled: true,
    persistAuthorization: true,
  },
  // Readable tag descriptions (Markdown): headings, lists, softer inline code
  customCss: `
    .swagger-ui .markdown p { margin: 0.4em 0 0.65em; line-height: 1.6; max-width: 56rem; }
    .swagger-ui .markdown h1, .swagger-ui .markdown h2, .swagger-ui .markdown h3 {
      margin: 1em 0 0.45em; font-weight: 600; letter-spacing: 0.02em;
      border-bottom: 1px solid rgba(128,128,128,0.28); padding-bottom: 0.35em;
    }
    .swagger-ui .markdown h3 { font-size: 1.06em; margin-top: 0.9em; }
    .swagger-ui .markdown ul { margin: 0.35em 0 0.75em 1.1em; padding-left: 0.5em; }
    .swagger-ui .markdown li { margin: 0.28em 0; line-height: 1.55; }
    .swagger-ui .markdown code {
      font-size: 0.86em; padding: 0.12em 0.4em; border-radius: 4px;
      background: rgba(128,128,128,0.14) !important; border: 1px solid rgba(128,128,128,0.12);
    }
  `,
};
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, swaggerOptions));

// Health
app.get('/', (req, res) => {
  res.json({
    message: 'Amoon Bloom API',
    status: 'healthy',
    version: '1.0.0',
    docs: '/api-docs',
    api: '/api/v1',
  });
});

// Liveness — process is up. Cheap, never touches the DB. Use this from
// container orchestrators (Railway, Kubernetes liveness probes) to decide
// whether the process is alive.
app.get('/health/live', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// Readiness — process can serve traffic. Pings the DB so a transient outage
// flips the probe to 503 and an upstream load balancer drains the pod.
app.get('/health/ready', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.status(200).json({ status: 'ready', db: 'up' });
  } catch (err) {
    return res.status(503).json({ status: 'unavailable', db: 'down' });
  }
});

// Mount v1 routes
v1Router.use('/auth', authRoutes);
v1Router.use('/user', userProfileRoutes);
v1Router.use('/users', userRoutes);
v1Router.use('/contact', contactRoutes);
v1Router.use('/settings', settingsRoutes);
v1Router.use('/vat', vatRoutes);
v1Router.use('/upload', uploadRoutes);
v1Router.use('/categories', categoryRoutes);
v1Router.use('/products', productRoutes);
v1Router.use('/cart', cartRoutes);
v1Router.use('/orders', orderRoutes);
v1Router.use('/banners', bannerRoutes);
v1Router.use('/sections', sectionRoutes);
v1Router.use('/regions', regionRoutes);
v1Router.use('/delivery-zones', deliveryZoneRoutes);
v1Router.use('/admin/analytics', analyticsRoutes);
v1Router.use('/promo-codes', promoCodeRoutes);
v1Router.use('/user/addresses', addressRoutes);
v1Router.use('/notifications', notificationRoutes);
v1Router.use('/admin/jobs', jobsRoutes);
v1Router.use('/reviews', reviewRoutes);

app.use('/api/v1', v1Router);

// Legacy /api/* for backward compatibility (same handlers)
app.use('/api/auth', authRoutes);
app.use('/api/user', userProfileRoutes);
app.use('/api/users', userRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/vat', vatRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/products', productRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/banners', bannerRoutes);
app.use('/api/sections', sectionRoutes);
app.use('/api/regions', regionRoutes);
app.use('/api/delivery-zones', deliveryZoneRoutes);
app.use('/api/admin/analytics', analyticsRoutes);
app.use('/api/promo-codes', promoCodeRoutes);
app.use('/api/user/addresses', addressRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin/jobs', jobsRoutes);

app.use(errorHandler);

const HOST = '0.0.0.0';
const server = app.listen(PORT, HOST, () => {
  console.log(`[SERVER] Server running on port ${PORT}`);
  console.log(`[SERVER] Local:   http://localhost:${PORT}`);
  console.log(`[SERVER] Swagger: http://localhost:${PORT}/api-docs`);
  console.log(`[SERVER] API v1:  http://localhost:${PORT}/api/v1`);
  console.log(`[SERVER] For mobile/web clients: set base URL to http://localhost:${PORT}/api/v1 (or your LAN IP for a physical device).`);
});

server.on('error', (err) => {
  console.error('[SERVER] Failed to start:', err);
  process.exit(1);
});

// Background-job engine (pg-boss). Runs in-process by default so a single Railway
// service handles both API and jobs; set JOBS_IN_PROCESS=false to run the worker
// separately via `node worker.js`. start() never throws — a failure degrades to
// inline execution and the API keeps serving.
if (process.env.JOBS_IN_PROCESS !== 'false') {
  startJobs().catch((err) => console.error('[SERVER] job engine start error:', err.message));
}

// Graceful shutdown: stop accepting new connections, drain in-flight HTTP requests
// and jobs, then close the DB. We await each step (rather than exiting immediately)
// so a deploy's SIGTERM doesn't sever active requests/jobs. A hard-exit backstop
// guarantees the process dies even if something hangs.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[SERVER] ${signal} received — shutting down gracefully...`);

  // Backstop: if draining hangs, force-exit regardless. Must be comfortably longer
  // than the graceful drain so it never preempts it: stopJobs() runs pg-boss's
  // graceful stop (timeout: 8000 — see src/jobs/queue.js) and server.close() must
  // also finish first. 30s leaves ample headroom for both before the hard exit.
  const backstop = setTimeout(() => {
    console.error('[SERVER] graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 30000);
  backstop.unref();

  try {
    await new Promise((resolve) => server.close(resolve)); // stop HTTP, drain in-flight
    console.log('[SERVER] HTTP server closed');
    // Drain pg-boss FIRST and wait for it to fully resolve — only then disconnect
    // Prisma, so in-flight jobs keep their shared DB connection through the drain.
    await stopJobs(); // pg-boss graceful drain (up to 8s)
    await prisma.$disconnect();
  } catch (err) {
    console.error('[SERVER] shutdown error:', err.message);
  }
  clearTimeout(backstop);
  process.exit(0);
}
['SIGTERM', 'SIGINT'].forEach((sig) => process.on(sig, () => shutdown(sig)));
