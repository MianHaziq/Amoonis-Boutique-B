const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Amoon Bloom API',
      version: '1.0.0',
      description:
        'Mobile ecommerce API for **Amoon Bloom**. Use **Authorize** with your JWT. Base URL: **/api/v1** (or **/api**). Customers can register **FCM tokens** and **notification preferences** under **Push notifications**. Managers get **managerPermissions** after sign-in.',
    },
    // Relative URL: Swagger “Try it out” uses the same host as the page (localhost, LAN IP, or production).
    servers: [
      { url: '/api/v1', description: 'API v1 (all routes)' },
    ],
    tags: [
      { name: 'Auth', description: 'Signup, login, Google OAuth, password reset, get/update user by ID' },
      {
        name: 'User Profile',
        description: 'Current user profile by token: profile, preferred language, address',
      },
      {
        name: 'Push notifications',
        description:
          '**Amoon Bloom** mobile push (Firebase Cloud Messaging). Register **POST /user/push/token** after login; **GET/PATCH /user/notifications/preferences** for toggles (defaults all on). Server sends order lifecycle pushes when Firebase credentials are configured.',
      },
      {
        name: 'Users',
        description: [
          '### User management (admin)',
          '',
          'Create and maintain **customer** and **manager** accounts. Every route here requires an **Administrator** JWT. Other roles receive **403 Forbidden**.',
          '',
          '### Account types',
          '',
          '- **Customer** — Default shopper account. Use when role is omitted or set to CUSTOMER.',
          '- **Manager** — Staff with restricted API access. Needs a **job title** and a **non-empty permission list**. Managers use the same sign-in flow; the response includes **managerPermissions** for your front-end. The API always enforces permissions server-side.',
          '',
          '### Adding a manager (recommended flow)',
          '',
          '1. **GET /users/manager-permissions** — Load the catalog (labels + help text) for checkboxes or toggles.',
          '2. Let the admin pick one or more areas (e.g. orders and products).',
          '3. **POST /users** — Send role MANAGER, managerTitle, managerPermissions, and optionally an avatar image URL from the upload endpoint.',
          '4. After the manager signs in, use **managerPermissions** to show or hide sections in your admin app.',
          '',
          '### Permission keys (JSON strings, uppercase)',
          '',
          'PRODUCTS · ORDERS · CATEGORIES · SECTIONS · BANNERS · CONTACT · SETTINGS',
          '',
          'You can assign several at once (for example orders **and** products).',
          '',
          '### Important',
          '',
          'Administrator accounts **cannot** be created through **POST /users**. Provision the first admin via your seed script or database.',
        ].join('\n'),
      },
      { name: 'Upload', description: 'Image upload (Bunny CDN)' },
      { name: 'Categories', description: 'Product categories (admin CRUD, public list)' },
      {
        name: 'Products',
        description:
          'Products (admin CRUD, public list/detail). On create or update, set **categoryId** to the UUID from **GET /categories** to place the product in that category.',
      },
      {
        name: 'Cart',
        description:
          'User cart (add, update, remove, get). **GET /cart/suggestions** returns category-aware picks when the cart has items; if the cart is empty, it returns a **random** sample of in-stock products (same size limits via query params).',
      },
      {
        name: 'Orders',
        description:
          'Checkout and order management. **GET /orders/history** lists the signed-in customer’s orders; **GET /orders/admin/history** is the staff audit log (optional **includeItems**). **GET /orders/{id}/status** is a lightweight status poll after checkout. Successful checkout triggers an **order placed** push when FCM is configured and **orderStatus** notifications are on. Admin status updates send matching pushes.',
      },
      { name: 'Banners', description: 'Landing page banners (public list; admin add, reorder, delete)' },
      { name: 'Sections', description: 'Admin-created sections for user panel (e.g. Ramadan Deals) with products and categories' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        ManagerPermissionKey: {
          type: 'string',
          enum: ['PRODUCTS', 'ORDERS', 'CATEGORIES', 'SECTIONS', 'BANNERS', 'CONTACT', 'SETTINGS'],
          description:
            'Area of the admin API this manager may access. Send these exact uppercase values in `managerPermissions` arrays. Admins bypass checks.',
        },
        ManagerPermissionCatalogItem: {
          type: 'object',
          description: 'One selectable permission for the “create/edit manager” screen.',
          properties: {
            key: { $ref: '#/components/schemas/ManagerPermissionKey' },
            label: { type: 'string', example: 'Orders', description: 'Short label for UI' },
            description: {
              type: 'string',
              example: 'List all orders, view any order, update order status',
              description: 'What this permission allows (for tooltips or help text)',
            },
          },
        },
        ManagerPermissionCatalog: {
          type: 'object',
          properties: {
            permissions: {
              type: 'array',
              items: { $ref: '#/components/schemas/ManagerPermissionCatalogItem' },
              description: 'All keys the backend accepts; use to build checkboxes before POST/PATCH manager.',
            },
          },
        },
        User: {
          type: 'object',
          description:
            'Single user as returned by admin user APIs (`GET/POST/PUT /users`, `GET /users/{id}`). `role` and `status` are **title-cased** for display (e.g. `Manager`, `Active`). For managers, `managerPermissions` lists granted API areas; for others they are empty.',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string', example: 'Sam Lee', description: 'firstName + lastName' },
            firstName: { type: 'string' },
            lastName: { type: 'string' },
            email: { type: 'string', format: 'email' },
            avatar: {
              type: 'string',
              description: 'Image URL, or two-letter initials if no image is set',
              example: 'https://cdn.example.com/avatars/sam.jpg',
            },
            role: {
              type: 'string',
              enum: ['Customer', 'Admin', 'Manager'],
              description: 'Display form of DB role CUSTOMER / ADMIN / MANAGER',
            },
            managerTitle: {
              type: 'string',
              nullable: true,
              example: 'Operations lead',
              description: 'Job title; only for managers, otherwise null',
            },
            managerPermissions: {
              type: 'array',
              items: { $ref: '#/components/schemas/ManagerPermissionKey' },
              description: 'Granted keys; empty unless role is Manager',
            },
            status: { type: 'string', enum: ['Active', 'Inactive'], description: 'Display form of ACTIVE / INACTIVE' },
            isEmailVerified: { type: 'boolean' },
            joinedAt: { type: 'string', format: 'date-time', description: 'Same as createdAt' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        UserInput: {
          type: 'object',
          required: ['email', 'firstName', 'lastName', 'password'],
          description:
            'Create user (admin). For **MANAGER**, also send `managerTitle` and non-empty `managerPermissions`. **ADMIN** cannot be created here (`403`).',
          properties: {
            email: { type: 'string', format: 'email' },
            firstName: { type: 'string' },
            lastName: { type: 'string' },
            password: { type: 'string', format: 'password', description: 'Login password for the new account' },
            role: {
              type: 'string',
              enum: ['CUSTOMER', 'MANAGER'],
              default: 'CUSTOMER',
              description: 'Use MANAGER for staff with limited API access',
            },
            status: {
              type: 'string',
              enum: ['ACTIVE', 'INACTIVE'],
              default: 'ACTIVE',
              description: 'INACTIVE blocks login',
            },
            avatar: {
              type: 'string',
              nullable: true,
              description: 'Public image URL (upload via `POST /upload/image` first if needed)',
            },
            managerTitle: {
              type: 'string',
              description: '**Required** when `role` is `MANAGER` (e.g. “Inventory specialist”)',
            },
            managerPermissions: {
              type: 'array',
              items: { $ref: '#/components/schemas/ManagerPermissionKey' },
              minItems: 1,
              description: '**Required** when `role` is `MANAGER`; at least one key. Load options from `GET /users/manager-permissions`.',
            },
          },
        },
        UserUpdateInput: {
          type: 'object',
          description:
            'Partial update (admin). Send only fields to change. If the user is or becomes a **MANAGER**, `managerTitle` and at least one `managerPermissions` must remain valid (see server validation). Clearing role to CUSTOMER/ADMIN clears manager fields.',
          properties: {
            email: { type: 'string', format: 'email' },
            firstName: { type: 'string' },
            lastName: { type: 'string' },
            password: { type: 'string', format: 'password', description: 'New password; omit to keep current' },
            role: { type: 'string', enum: ['CUSTOMER', 'ADMIN', 'MANAGER'] },
            status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] },
            avatar: { type: 'string', nullable: true },
            managerTitle: { type: 'string', description: 'Required for manager accounts' },
            managerPermissions: {
              type: 'array',
              items: { $ref: '#/components/schemas/ManagerPermissionKey' },
              minItems: 1,
              description: 'Replace entire permission set when sent',
            },
          },
        },
        UserStats: {
          type: 'object',
          description: 'Counts for admin dashboard (`GET /users/stats`).',
          properties: {
            total: { type: 'integer', example: 120, description: 'All users' },
            customers: { type: 'integer', example: 100 },
            admins: { type: 'integer', example: 1 },
            managers: { type: 'integer', example: 5, description: 'Users with role MANAGER' },
            active: { type: 'integer', example: 115, description: 'status ACTIVE' },
            inactive: { type: 'integer', example: 5, description: 'status INACTIVE' },
          },
        },
        ChangeUserRoleInput: {
          type: 'object',
          required: ['role'],
          description:
            'Change role (admin). When setting **MANAGER**, you must include `managerTitle` and `managerPermissions` (≥1). Other roles clear manager fields.',
          properties: {
            role: { type: 'string', enum: ['CUSTOMER', 'ADMIN', 'MANAGER'] },
            managerTitle: { type: 'string', description: 'Required if role is MANAGER' },
            managerPermissions: {
              type: 'array',
              items: { $ref: '#/components/schemas/ManagerPermissionKey' },
              minItems: 1,
              description: 'Required if role is MANAGER',
            },
          },
        },
        AuthUser: {
          type: 'object',
          description:
            'User object inside auth responses (signup/signin). For **MANAGER**, includes managerTitle and managerPermissions (same keys as GET /users/manager-permissions). Other roles use null and [].',
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
              description: 'User UUID',
            },
            email: {
              type: 'string',
              format: 'email',
            },
            firstName: {
              type: 'string',
            },
            lastName: {
              type: 'string',
            },
            role: { type: 'string', enum: ['CUSTOMER', 'ADMIN', 'MANAGER'], description: 'Raw DB enum (not title-cased)' },
            status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] },
            managerTitle: { type: 'string', nullable: true },
            managerPermissions: {
              type: 'array',
              items: { $ref: '#/components/schemas/ManagerPermissionKey' },
              description: 'Populated when role is MANAGER',
            },
            isEmailVerified: {
              type: 'boolean',
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
            },
            updatedAt: {
              type: 'string',
              format: 'date-time',
            },
          },
        },
        UserProfile: {
          type: 'object',
          description: 'Current user profile (token-based). Includes optional preferred language and address.',
          properties: {
            id: { type: 'string', format: 'uuid', description: 'User UUID' },
            email: { type: 'string', format: 'email', description: 'User email' },
            firstName: { type: 'string', description: 'First name' },
            lastName: { type: 'string', description: 'Last name' },
            avatar: { type: 'string', nullable: true, description: 'Profile image URL' },
            role: { type: 'string', enum: ['CUSTOMER', 'ADMIN', 'MANAGER'], description: 'User role' },
            managerTitle: { type: 'string', nullable: true, description: 'Job title when role is MANAGER' },
            managerPermissions: {
              type: 'array',
              items: { type: 'string' },
              description: 'Permission keys when role is MANAGER; empty for other roles',
            },
            status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'], description: 'Account status' },
            isEmailVerified: { type: 'boolean', description: 'Email verification status' },
            preferredLanguage: { type: 'string', nullable: true, example: 'en', description: 'User preferred language code (e.g. en, ar)' },
            addressCountry: { type: 'string', nullable: true, example: 'United Arab Emirates', description: 'User address country' },
            addressCity: { type: 'string', nullable: true, example: 'Dubai', description: 'User address city' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        PreferredLanguageInput: {
          type: 'object',
          required: ['preferredLanguage'],
          properties: {
            preferredLanguage: {
              type: 'string',
              example: 'en',
              description: 'Preferred language code (e.g. en, ar, fr). Stored for the authenticated user.',
            },
          },
        },
        AddressInput: {
          type: 'object',
          properties: {
            addressCountry: {
              type: 'string',
              example: 'United Arab Emirates',
              description: 'User address country. Optional.',
            },
            addressCity: {
              type: 'string',
              example: 'Dubai',
              description: 'User address city. Optional.',
            },
          },
        },
        PushTokenRegister: {
          type: 'object',
          required: ['fcmToken'],
          properties: {
            fcmToken: {
              type: 'string',
              description: 'FCM registration token from the mobile SDK',
              example: 'dK3x...long-token...',
            },
            platform: {
              type: 'string',
              enum: ['IOS', 'ANDROID', 'WEB'],
              default: 'ANDROID',
              description: 'Client platform (case-insensitive in API)',
            },
          },
        },
        PushTokenUnregister: {
          type: 'object',
          required: ['fcmToken'],
          properties: {
            fcmToken: { type: 'string', description: 'Same token previously registered' },
          },
        },
        NotificationPreferences: {
          type: 'object',
          description: 'All default **true** when the row is first created.',
          properties: {
            orderStatus: {
              type: 'boolean',
              example: true,
              description: 'Order placed, confirmed, processing, shipped, delivered, cancelled',
            },
            promotions: {
              type: 'boolean',
              example: true,
              description: 'Marketing and offers (reserved for future campaigns)',
            },
            announcements: {
              type: 'boolean',
              example: true,
              description: 'App and store announcements (reserved for future use)',
            },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        NotificationPreferencesPatch: {
          type: 'object',
          description: 'Send at least one field; omitted fields stay unchanged.',
          properties: {
            orderStatus: { type: 'boolean' },
            promotions: { type: 'boolean' },
            announcements: { type: 'boolean' },
          },
        },
        SignupInput: {
          type: 'object',
          required: ['firstName', 'lastName', 'email', 'password'],
          properties: {
            firstName: {
              type: 'string',
              example: 'John',
            },
            lastName: {
              type: 'string',
              example: 'Doe',
            },
            email: {
              type: 'string',
              format: 'email',
              example: 'john@example.com',
            },
            password: {
              type: 'string',
              example: 'password123',
            },
          },
        },
        SigninInput: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: {
              type: 'string',
              format: 'email',
              example: 'john@example.com',
            },
            password: {
              type: 'string',
              example: 'password123',
            },
          },
        },
        Error: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            message: { type: 'string', description: 'Error message' },
            errors: {
              type: 'array',
              items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } } },
              description: 'Validation errors when present',
            },
          },
        },
        Category: {
          type: 'object',
          description: 'Product category',
          properties: {
            id: { type: 'string', format: 'uuid', example: '550e8400-e29b-41d4-a716-446655440000' },
            title: { type: 'string', example: 'Women' },
            description: { type: 'string', example: 'Women collection' },
            image: { type: 'string', nullable: true },
            totalProducts: { type: 'integer', example: 5 },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        CategoryCreate: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string', example: 'Women', description: 'Category name' },
            description: { type: 'string', example: 'Women collection' },
            image: { type: 'string', nullable: true },
          },
        },
        Product: {
          type: 'object',
          description: 'Product with price, category, ordered images, and multiple descriptions (title optional per item)',
          properties: {
            id: { type: 'string', format: 'uuid' },
            title: { type: 'string', example: 'Summer Dress' },
            subtitle: { type: 'string', nullable: true },
            image: { type: 'string', nullable: true, description: 'First image URL (thumbnail)' },
            images: { type: 'array', items: { type: 'string' }, description: 'All image URLs in display order (first = top)' },
            descriptions: {
              type: 'array',
              description: 'Multiple description blocks. Each has optional title and required description. If only one, title can be omitted.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  title: { type: 'string', nullable: true, description: 'Optional section title (e.g. "Materials")' },
                  description: { type: 'string', description: 'Description text' },
                },
              },
            },
            productOptions: {
              type: 'array',
              description: 'Optional custom options per product (e.g. Box Color: red, blue, black; Flower Color: orange, red, blue). Each item has title and options array.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  title: { type: 'string', example: 'Box Color' },
                  options: { type: 'array', items: { type: 'string' }, example: ['red', 'blue', 'black'] },
                },
              },
            },
            price: { type: 'number', format: 'float', example: 49.99 },
            discountedPrice: { type: 'number', format: 'float', nullable: true, example: 39.99 },
            quantity: { type: 'integer', example: 10, description: 'Stock quantity (admin tracking)' },
            categoryId: { type: 'string', format: 'uuid', nullable: true },
            category: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        ProductCreate: {
          type: 'object',
          required: ['title', 'price'],
          properties: {
            title: { type: 'string', example: 'Summer Dress' },
            subtitle: { type: 'string', example: 'Light cotton' },
            descriptions: {
              type: 'array',
              description: 'Multiple descriptions. Each item: title (optional), description (required). Single description needs no title.',
              items: {
                type: 'object',
                required: ['description'],
                properties: {
                  title: { type: 'string', nullable: true, example: 'Materials' },
                  description: { type: 'string', example: '100% cotton' },
                },
              },
            },
            price: { type: 'number', example: 49.99 },
            discountedPrice: { type: 'number', nullable: true, example: 39.99 },
            quantity: { type: 'integer', minimum: 0, example: 10, description: 'Stock quantity for admin tracking' },
            categoryId: {
              type: 'string',
              format: 'uuid',
              nullable: true,
              example: '550e8400-e29b-41d4-a716-446655440000',
              description:
                'Optional. UUID of the category this product belongs to. List categories with **GET /categories** (each item has `id`); paste that `id` here. Omit to create uncategorized; change later with **PUT /products/{id}** and `categoryId`. Invalid id → **404**.',
            },
            images: {
              type: 'array',
              maxItems: 10,
              items: { type: 'string', format: 'uri', description: 'Public image URL (e.g. from POST /upload/image)' },
              description:
                'Optional. Up to 10 image URLs in display order (first = primary / thumbnail). Upload files via POST /upload/image?path=products, then use the returned urls here.',
              example: ['https://cdn.example.com/products/1.jpg', 'https://cdn.example.com/products/2.jpg'],
            },
            productOptions: {
              type: 'array',
              description: 'Optional. Multiple title + options (e.g. Box Color: red, blue, black; Flower Color: orange, red, blue). Number of options per title is flexible.',
              items: {
                type: 'object',
                required: ['title'],
                properties: {
                  title: { type: 'string', example: 'Box Color' },
                  options: { type: 'array', items: { type: 'string' }, example: ['red', 'blue', 'black'] },
                },
              },
            },
          },
        },
        ProductUpdate: {
          type: 'object',
          description: [
            'Admin partial update: include **only** fields you want to change; omitted fields stay as-is.',
            'Updatable fields match create: **title**, **subtitle**, **price**, **discountedPrice**, **quantity** (stock), **categoryId**, **descriptions**, **images**, **productOptions**.',
            '**Replace semantics:** sending **descriptions**, **images**, or **productOptions** replaces that entire list (use empty array `[]` to clear images or descriptions; options cleared similarly).',
            'New image files: **POST /upload/image** (e.g. `?path=products`), then put returned URLs in **images**.',
          ].join(' '),
          example: {
            title: 'Summer Dress — sale',
            subtitle: 'Light organic cotton',
            price: 44.99,
            discountedPrice: 34.99,
            quantity: 25,
            categoryId: '550e8400-e29b-41d4-a716-446655440000',
            descriptions: [
              { title: 'Care', description: 'Machine wash cold' },
              { description: 'Relaxed fit' },
            ],
            images: [
              'https://cdn.example.com/products/dress-front-v2.jpg',
              'https://cdn.example.com/products/dress-detail.jpg',
            ],
            productOptions: [
              { title: 'Size', options: ['S', 'M', 'L', 'XL'] },
              { title: 'Color', options: ['Ivory', 'Sage'] },
            ],
          },
          properties: {
            title: { type: 'string', example: 'Summer Dress — updated', description: 'Product name' },
            subtitle: {
              type: 'string',
              nullable: true,
              example: 'Light organic cotton',
              description: 'Short tagline; send `null` or empty to clear if your client supports it',
            },
            descriptions: {
              type: 'array',
              description:
                'When present, **replaces** all descriptions. Same items as POST /products (`description` required per row; `title` optional).',
              items: {
                type: 'object',
                required: ['description'],
                properties: {
                  title: { type: 'string', nullable: true, example: 'Materials' },
                  description: { type: 'string', example: '100% cotton' },
                },
              },
              example: [{ title: 'Care', description: 'Machine wash cold' }, { description: 'Relaxed fit' }],
            },
            price: { type: 'number', format: 'float', example: 49.99, description: 'Regular price' },
            discountedPrice: {
              type: 'number',
              format: 'float',
              nullable: true,
              example: 39.99,
              description: 'Sale price; omit to leave unchanged, or set as needed',
            },
            quantity: {
              type: 'integer',
              minimum: 0,
              example: 25,
              description: 'Stock / inventory count (admin). Non-negative integer.',
            },
            categoryId: {
              type: 'string',
              format: 'uuid',
              nullable: true,
              example: '550e8400-e29b-41d4-a716-446655440000',
              description:
                'Set or move to another category using the category’s `id` from **GET /categories**. Send `null` to remove the product from any category.',
            },
            images: {
              type: 'array',
              maxItems: 10,
              items: { type: 'string', format: 'uri', description: 'Public image URL (e.g. from POST /upload/image)' },
              description:
                'When present, **replaces** the full gallery (order = array order, first = thumbnail). Up to 10 URLs. `[]` removes all images.',
              example: ['https://cdn.example.com/products/1.jpg', 'https://cdn.example.com/products/2.jpg'],
            },
            productOptions: {
              type: 'array',
              description: 'When present, **replaces** all variant-style options (same shape as create).',
              items: {
                type: 'object',
                required: ['title'],
                properties: {
                  title: { type: 'string', example: 'Size' },
                  options: { type: 'array', items: { type: 'string' }, example: ['S', 'M', 'L'] },
                },
              },
              example: [{ title: 'Size', options: ['S', 'M', 'L'] }, { title: 'Color', options: ['Ivory', 'Sage'] }],
            },
          },
        },
        CartItem: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            productId: { type: 'string', format: 'uuid' },
            product: { $ref: '#/components/schemas/Product' },
            quantity: { type: 'integer', example: 2 },
            message: { type: 'string', nullable: true, description: 'Per-item note (e.g. gift wrap)' },
            lineTotal: { type: 'number', example: 79.98 },
          },
        },
        Cart: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            items: { type: 'array', items: { $ref: '#/components/schemas/CartItem' } },
            totalAmount: { type: 'number', example: 99.97 },
            orderMessage: { type: 'string', nullable: true, description: 'Optional note for the whole order' },
          },
        },
        CartAddBody: {
          type: 'object',
          required: ['productId'],
          properties: {
            productId: { type: 'string', format: 'uuid', example: '550e8400-e29b-41d4-a716-446655440000' },
            quantity: { type: 'integer', minimum: 1, example: 1 },
            message: { type: 'string', example: 'Gift wrap please' },
          },
        },
        Order: {
          type: 'object',
          description:
            '**PENDING → CONFIRMED** reduces **Product.quantity** per line (**409** if insufficient). **CANCELLED** restores stock whenever **inventoryDeducted** is true. Reverting to **PENDING** from confirmed/processing/shipped/delivered also restores. **inventoryDeducted** reflects whether deduction is active.',
          properties: {
            id: { type: 'string', format: 'uuid' },
            userId: { type: 'string', format: 'uuid' },
            orderMessage: { type: 'string', nullable: true },
            totalAmount: { type: 'number', example: 99.97 },
            status: { type: 'string', enum: ['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'] },
            inventoryDeducted: {
              type: 'boolean',
              description: 'True after a successful **CONFIRMED** transition deducted catalog stock for this order',
            },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  productId: { type: 'string' },
                  product: { type: 'object' },
                  quantity: { type: 'integer' },
                  perProductMessage: { type: 'string', nullable: true },
                  price: { type: 'number' },
                },
              },
            },
          },
        },
        OrderStatusUpdate: {
          type: 'object',
          required: ['status'],
          properties: {
            status: {
              type: 'string',
              enum: ['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'],
              example: 'CONFIRMED',
            },
          },
        },
        OrderStatusSnapshot: {
          type: 'object',
          description: 'Lightweight order status from **GET /orders/{id}/status** (post-checkout polling).',
          properties: {
            id: { type: 'string', format: 'uuid' },
            status: {
              type: 'string',
              enum: ['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'],
            },
            totalAmount: { type: 'number' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
            progress: {
              type: 'object',
              properties: {
                currentStep: { type: 'string' },
                isTerminal: { type: 'boolean', description: 'True when DELIVERED or CANCELLED' },
                typicalFlow: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Common fulfillment sequence for UI steppers',
                },
                stepIndex: { type: 'integer', nullable: true },
              },
            },
          },
        },
        CartSuggestions: {
          type: 'object',
          description:
            'Payload inside **data** for **GET /cart/suggestions**. Non-empty cart: **sections** by category + **discover** from other categories. Empty cart: **sections** is empty and **discover** is a random in-stock sample.',
          properties: {
            headline: { type: 'string', example: 'Complete your look' },
            hint: { type: 'string', description: 'UX copy; empty cart explains random picks vs category-based mode' },
            sections: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  category: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', format: 'uuid' },
                      title: { type: 'string' },
                    },
                  },
                  headline: { type: 'string' },
                  subhead: { type: 'string' },
                  products: { type: 'array', items: { $ref: '#/components/schemas/Product' } },
                },
              },
            },
            discover: {
              type: 'array',
              items: { $ref: '#/components/schemas/Product' },
              description: 'In-stock picks from categories not represented in the cart',
            },
          },
        },
        ApiSuccess: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            message: { type: 'string' },
            data: { type: 'object' },
            meta: { type: 'object', description: 'Pagination or extra info' },
          },
        },
        BannerImage: {
          type: 'object',
          description: 'Landing page banner image (display order by sortOrder)',
          properties: {
            id: { type: 'string', format: 'uuid', description: 'Banner ID' },
            url: { type: 'string', description: 'Image URL (stored in DB; Bunny CDN can be used later)' },
            sortOrder: { type: 'integer', description: 'Display order (0 = first)' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        SectionWithItems: {
          type: 'object',
          description: 'Section with products and categories (same shape as product list and category list)',
          properties: {
            id: { type: 'string', format: 'uuid' },
            title: { type: 'string', example: 'Ramadan Deals' },
            image: { type: 'string', nullable: true },
            sortOrder: { type: 'integer' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
            products: {
              type: 'array',
              items: { $ref: '#/components/schemas/Product' },
              description: 'Products in section (id, image, title, price, etc. as in product API)',
            },
            categories: {
              type: 'array',
              items: { $ref: '#/components/schemas/Category' },
              description: 'Categories in section (id, title, image, totalProducts, etc.)',
            },
          },
        },
      },
    },
  },
  apis: [
    './src/routes/auth.routes.js',
    './src/routes/user.routes.js',
    './src/routes/userProfile.routes.js',
    './src/routes/upload.routes.js',
    './src/routes/category.routes.js',
    './src/routes/product.routes.js',
    './src/routes/cart.routes.js',
    './src/routes/order.routes.js',
    './src/routes/banner.routes.js',
    './src/routes/section.routes.js',
  ],
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = swaggerSpec;
