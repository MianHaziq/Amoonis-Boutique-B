const swaggerJsdoc = require('swagger-jsdoc');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';
const baseUrl = `http://${HOST}:${PORT}`;

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Amoonis Boutique API',
      version: '1.0.0',
      description: 'Ecommerce API: Auth, Users, Categories, Products, Cart, Orders, Contact, Settings, Upload. All routes are under `/api/v1` or `/api`. Use **Authorize** with the JWT from signin for protected endpoints.',
    },
    servers: [
      { url: `${baseUrl}/api/v1`, description: 'API v1 (all routes)' },
    ],
    tags: [
      { name: 'Auth', description: 'Signup, login, Google OAuth, password reset' },
      { name: 'Users', description: 'User CRUD and stats (admin)' },
      { name: 'Contact', description: 'Contact form and admin messages' },
      { name: 'Settings', description: 'Site settings (public and admin)' },
      { name: 'Upload', description: 'Image upload (Bunny CDN)' },
      { name: 'Categories', description: 'Product categories (admin CRUD, public list)' },
      { name: 'Products', description: 'Products (admin CRUD, public list/detail)' },
      { name: 'Cart', description: 'User cart (add, update, remove, get)' },
      { name: 'Orders', description: 'Checkout and order management' },
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
          description: 'Product with price, category, and ordered images',
          properties: {
            id: { type: 'string', format: 'uuid' },
            title: { type: 'string', example: 'Summer Dress' },
            subtitle: { type: 'string', nullable: true },
            description: { type: 'string', nullable: true },
            image: { type: 'string', nullable: true, description: 'First image URL (thumbnail)' },
            images: { type: 'array', items: { type: 'string' }, description: 'All image URLs in display order (first = top)' },
            price: { type: 'number', format: 'float', example: 49.99 },
            discountedPrice: { type: 'number', format: 'float', nullable: true, example: 39.99 },
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
            description: { type: 'string' },
            price: { type: 'number', example: 49.99 },
            discountedPrice: { type: 'number', nullable: true, example: 39.99 },
            categoryId: { type: 'string', format: 'uuid', nullable: true, description: 'Optional; assign or change later via PUT /products/:id' },
            images: {
              type: 'array',
              maxItems: 10,
              items: { type: 'string', format: 'uri' },
              description: 'Up to 10 image URLs in display order. First = top; reorder in app (e.g. drag 7th to 3rd) then send final order here.',
              example: ['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg'],
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
      },
    },
  },
  apis: ['./src/routes/*.js'],
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = swaggerSpec;
