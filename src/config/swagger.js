const swaggerJsdoc = require('swagger-jsdoc');

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || 'localhost';
const baseUrl = `http://${HOST}:${PORT}`;

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Amoonis Boutique API',
      version: '1.0.0',
      description: 'Ecommerce API: Auth, User Profile, Users, Categories, Products, Cart, Orders, Upload. All routes are under `/api/v1` or `/api`. Use **Authorize** with the JWT from signin for protected endpoints.',
    },
    servers: [
      { url: `${baseUrl}/api/v1`, description: 'API v1 (all routes)' },
    ],
    tags: [
      { name: 'Auth', description: 'Signup, login, Google OAuth, password reset, get/update user by ID' },
      { name: 'User Profile', description: 'Current user profile by token: get profile, update preferred language, update address' },
      { name: 'Users', description: 'User CRUD and stats (admin)' },
      { name: 'Upload', description: 'Image upload (Bunny CDN)' },
      { name: 'Categories', description: 'Product categories (admin CRUD, public list)' },
      { name: 'Products', description: 'Products (admin CRUD, public list/detail)' },
      { name: 'Cart', description: 'User cart (add, update, remove, get)' },
      { name: 'Orders', description: 'Checkout and order management' },
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
        User: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
              description: 'User UUID',
            },
            email: {
              type: 'string',
              format: 'email',
              description: 'User email',
            },
            firstName: {
              type: 'string',
              description: 'User first name',
            },
            lastName: {
              type: 'string',
              description: 'User last name',
            },
            isEmailVerified: {
              type: 'boolean',
              description: 'Email verification status',
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
              description: 'Creation timestamp',
            },
            updatedAt: {
              type: 'string',
              format: 'date-time',
              description: 'Last update timestamp',
            },
          },
        },
        UserInput: {
          type: 'object',
          required: ['email', 'firstName', 'lastName', 'password'],
          properties: {
            email: {
              type: 'string',
              format: 'email',
              description: 'User email',
            },
            firstName: {
              type: 'string',
              description: 'User first name',
            },
            lastName: {
              type: 'string',
              description: 'User last name',
            },
            password: {
              type: 'string',
              description: 'User password',
            },
          },
        },
        AuthUser: {
          type: 'object',
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
            role: { type: 'string', enum: ['CUSTOMER', 'ADMIN'], description: 'User role' },
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
            categoryId: { type: 'string', format: 'uuid', nullable: true, description: 'Optional; assign or change later via PUT /products/:id' },
            images: {
              type: 'array',
              maxItems: 10,
              items: { type: 'string', format: 'uri' },
              description: 'Up to 10 image URLs in display order. First = top; reorder in app (e.g. drag 7th to 3rd) then send final order here.',
              example: ['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg'],
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
          properties: {
            id: { type: 'string', format: 'uuid' },
            userId: { type: 'string', format: 'uuid' },
            orderMessage: { type: 'string', nullable: true },
            totalAmount: { type: 'number', example: 99.97 },
            status: { type: 'string', enum: ['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'] },
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
