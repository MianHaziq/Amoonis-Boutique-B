# eCommerce API – Example Responses

Base URL: `/api/v1` (or `/api`). All success responses use the format: `{ success, message, data?, meta? }`. Errors: `{ success: false, message, errors? }`.

---

## Admin auth

- **Login:** `POST /auth/signin` with `{ "email": "admin@example.com", "password": "Admin@123" }`.
- Use the returned `data.token` as `Authorization: Bearer <token>` for admin routes.

---

## Categories

**GET /categories** (public)
```json
{
  "success": true,
  "message": "Categories fetched successfully",
  "data": [
    {
      "id": "uuid",
      "title": "Women",
      "description": "Women collection",
      "image": null,
      "totalProducts": 5,
      "createdAt": "...",
      "updatedAt": "..."
    }
  ],
  "meta": { "total": 1 }
}
```

**GET /categories/:id** (public, with products)
```json
{
  "success": true,
  "message": "Category fetched successfully",
  "data": {
    "id": "uuid",
    "title": "Women",
    "description": "...",
    "image": null,
    "totalProducts": 2,
    "products": [
      {
        "id": "uuid",
        "title": "Product A",
        "subtitle": null,
        "description": "...",
        "image": null,
        "price": 29.99,
        "discountedPrice": 24.99,
        "categoryId": "uuid",
        "createdAt": "...",
        "updatedAt": "..."
      }
    ]
  }
}
```

**POST /categories** (admin)
- Body: `{ "title": "Men", "description": "...", "image": null }`
- Response: `201` with `data` = created category.

---

## Products

**GET /products** (public, paginated)
- Query: `?page=1&limit=10`
```json
{
  "success": true,
  "message": "Products fetched successfully",
  "data": [ { "id": "...", "title": "...", "price": 29.99, "discountedPrice": 24.99, "category": { "id": "...", "title": "Women" }, ... } ],
  "meta": {
    "pagination": { "page": 1, "limit": 10, "total": 50, "totalPages": 5 }
  }
}
```

**GET /products/category/:categoryId** (public, paginated)
- Same shape as GET /products, filtered by category.

**GET /products/:id** (public)
```json
{
  "success": true,
  "message": "Product fetched successfully",
  "data": {
    "id": "uuid",
    "title": "Product A",
    "subtitle": "...",
    "description": "...",
    "image": null,
    "price": 29.99,
    "discountedPrice": 24.99,
    "categoryId": "uuid",
    "category": { "id": "...", "title": "Women" },
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

**POST /products** (admin)
- Body: `{ "title": "...", "subtitle": "...", "description": "...", "image": null, "price": 29.99, "discountedPrice": 24.99, "categoryId": "uuid" }`
- Response: `201` with created product in `data`.

---

## Cart (user JWT required)

**POST /cart** – Add to cart
- Body: `{ "productId": "uuid", "quantity": 1, "message": "Gift wrap" }`

**PATCH /cart/quantity** – Update quantity
- Body: `{ "productId": "uuid", "quantity": 2 }`

**PATCH /cart/message** – Order message
- Body: `{ "orderMessage": "Leave at door" }`

**GET /cart**
```json
{
  "success": true,
  "message": "Cart fetched successfully",
  "data": {
    "id": "cart-uuid",
    "items": [
      {
        "id": "item-uuid",
        "productId": "uuid",
        "product": { "id": "...", "title": "...", "price": 29.99, "discountedPrice": 24.99, ... },
        "quantity": 2,
        "message": "Gift wrap",
        "lineTotal": 49.98
      }
    ],
    "totalAmount": 49.98,
    "orderMessage": "Leave at door"
  }
}
```

**DELETE /cart/item/:productId** – Remove one product from cart.

**DELETE /cart** – Clear cart.

---

## Orders

**POST /orders/checkout** (user JWT)
- Creates order from current cart and clears cart.
```json
{
  "success": true,
  "message": "Order placed successfully",
  "data": {
    "id": "order-uuid",
    "userId": "...",
    "orderMessage": "Leave at door",
    "totalAmount": 99.97,
    "status": "PENDING",
    "createdAt": "...",
    "updatedAt": "...",
    "items": [
      {
        "id": "...",
        "productId": "...",
        "product": { "id": "...", "title": "...", "image": null },
        "quantity": 2,
        "perProductMessage": "Gift wrap",
        "price": 24.99
      }
    ]
  }
}
```

**GET /orders/:id** (user: own order; admin: any)
- Same shape as checkout `data`.

**GET /orders** (admin only, paginated)
- Query: `?page=1&limit=10&status=PENDING`
- Response: `data` = array of orders (with `user`, `itemCount`), `meta.pagination`.

**PATCH /orders/:id/status** (admin)
- Body: `{ "status": "CONFIRMED" }` (or PROCESSING, SHIPPED, DELIVERED, CANCELLED).
- Response: full order in `data`.
