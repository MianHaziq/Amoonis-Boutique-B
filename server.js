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
const uploadRoutes = require('./src/routes/upload.routes');
const categoryRoutes = require('./src/routes/category.routes');
const productRoutes = require('./src/routes/product.routes');
const cartRoutes = require('./src/routes/cart.routes');
const orderRoutes = require('./src/routes/order.routes');
const bannerRoutes = require('./src/routes/banner.routes');
const sectionRoutes = require('./src/routes/section.routes');
const errorHandler = require('./src/middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 5000;

// const allowedOrigins = process.env.ALLOWED_ORIGINS
//   ? process.env.ALLOWED_ORIGINS.split(',')
//   : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:5000'];

app.use(helmet({
  contentSecurityPolicy: process.env.NODE_ENV === 'production',
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
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

// Mount v1 routes
v1Router.use('/auth', authRoutes);
v1Router.use('/user', userProfileRoutes);
v1Router.use('/users', userRoutes);
v1Router.use('/contact', contactRoutes);
v1Router.use('/settings', settingsRoutes);
v1Router.use('/upload', uploadRoutes);
v1Router.use('/categories', categoryRoutes);
v1Router.use('/products', productRoutes);
v1Router.use('/cart', cartRoutes);
v1Router.use('/orders', orderRoutes);
v1Router.use('/banners', bannerRoutes);
v1Router.use('/sections', sectionRoutes);

app.use('/api/v1', v1Router);

// Legacy /api/* for backward compatibility (same handlers)
app.use('/api/auth', authRoutes);
app.use('/api/user', userProfileRoutes);
app.use('/api/users', userRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/products', productRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/banners', bannerRoutes);
app.use('/api/sections', sectionRoutes);

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
