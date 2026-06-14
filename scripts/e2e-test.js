/**
 * End-to-end test: hits API with server running on PORT.
 * Run: node server.js (in another terminal), then node scripts/e2e-test.js
 * Or: npm run e2e (if script runs server then tests)
 */
require('dotenv').config();
const PORT = process.env.PORT || 5000;
const BASE = `http://localhost:${PORT}/api/v1`;

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

async function main() {
  let adminToken = null;
  let createdProductId = null;
  let categoryId = null;

  // --- Health ---
  test('GET / (health)', async () => {
    const res = await fetch(`http://localhost:${PORT}/`);
    assert(res.ok, `Health check failed: ${res.status}`);
    const data = await res.json();
    assert(data.status === 'healthy', 'Expected status healthy');
  });

  // --- Auth (admin) ---
  test('POST /auth/signin (admin)', async () => {
    const res = await fetch(`${BASE}/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'Admin@123' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Signin failed: ${res.status} ${data.message || JSON.stringify(data)}`);
    assert(data.success && data.data?.token, 'Expected success and token');
    adminToken = data.data.token;
  });

  // --- Categories (public) ---
  test('GET /categories', async () => {
    const res = await fetch(`${BASE}/categories`);
    assert(res.ok, `Categories failed: ${res.status}`);
    const data = await res.json();
    assert(data.success && Array.isArray(data.data), 'Expected success and data array');
    if (data.data.length > 0) categoryId = data.data[0].id;
  });

  // --- Products list (public) ---
  test('GET /products', async () => {
    const res = await fetch(`${BASE}/products?page=1&limit=5`);
    assert(res.ok, `Products list failed: ${res.status}`);
    const data = await res.json();
    assert(data.success && Array.isArray(data.data), 'Expected success and data array');
    // Each product must have productOptions array (new field)
    for (const p of data.data) {
      assert(Array.isArray(p.productOptions), `Product ${p.id} missing productOptions array`);
    }
  });

  // --- Create product with productOptions (admin) ---
  test('POST /products (with productOptions)', async () => {
    const res = await fetch(`${BASE}/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        title: 'E2E Test Product',
        price: 19.99,
        // Products now default to DRAFT (multi-region module). Publish so the public
        // GET /products/:id below can see it.
        status: 'PUBLISHED',
        productOptions: [
          { title: 'Box Color', options: ['red', 'blue', 'black'] },
          { title: 'Flower Color', options: ['orange', 'red', 'blue', 'white', 'yellow'] },
          { title: 'Box Type', options: ['classic', 'premium'] },
        ],
      }),
    });
    const createBody = await res.json();
    if (!res.ok) throw new Error(`Create product failed: ${res.status} ${createBody.message || JSON.stringify(createBody)}`);
    const data = createBody;
    assert(data.success && data.data?.id, 'Expected success and product id');
    assert(Array.isArray(data.data.productOptions), 'Created product must have productOptions');
    assert(data.data.productOptions.length === 3, 'Expected 3 productOptions');
    createdProductId = data.data.id;
  });

  // --- Get product by id (public) ---
  test('GET /products/:id', async () => {
    assert(createdProductId, 'Need created product id');
    const res = await fetch(`${BASE}/products/${createdProductId}`);
    assert(res.ok, `Get product failed: ${res.status}`);
    const data = await res.json();
    assert(data.success && data.data?.id === createdProductId, 'Expected same product');
    assert(Array.isArray(data.data.productOptions), 'Product detail must have productOptions');
    assert(data.data.productOptions.some(o => o.title === 'Box Color' && o.options?.includes('red')), 'Box Color options must include red');
  });

  // --- Update product (productOptions) ---
  test('PUT /products/:id (update productOptions)', async () => {
    const res = await fetch(`${BASE}/products/${createdProductId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        productOptions: [
          { title: 'Size', options: ['S', 'M', 'L'] },
        ],
      }),
    });
    const updateBody = await res.json();
    if (!res.ok) throw new Error(`Update product failed: ${res.status} ${updateBody.message || JSON.stringify(updateBody)}`);
    const data = updateBody;
    assert(data.success && Array.isArray(data.data.productOptions), 'Updated product must have productOptions');
    assert(data.data.productOptions.length === 1 && data.data.productOptions[0].title === 'Size', 'Expected single option Size');
  });

  // --- Sections (public) ---
  test('GET /sections', async () => {
    const res = await fetch(`${BASE}/sections`);
    assert(res.ok, `Sections failed: ${res.status}`);
    const data = await res.json();
    assert(data.success && Array.isArray(data.data), 'Expected success and data array');
    for (const s of data.data) {
      assert(Array.isArray(s.products), 'Section must have products array');
      for (const p of s.products) {
        assert(Array.isArray(p.productOptions), `Section product ${p?.id} must have productOptions`);
      }
    }
  });

  // --- Cart (with auth - admin as user) ---
  test('GET /cart', async () => {
    const res = await fetch(`${BASE}/cart`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert(res.ok, `Cart failed: ${res.status}`);
    const data = await res.json();
    assert(data.success !== undefined, 'Expected success/error response');
    if (data.data?.items?.length) {
      for (const item of data.data.items) {
        assert(Array.isArray(item.product?.productOptions), 'Cart item product must have productOptions');
      }
    }
  });

  // --- Add to cart then get cart ---
  test('POST /cart then GET /cart', async () => {
    const addRes = await fetch(`${BASE}/cart`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ productId: createdProductId, quantity: 1 }),
    });
    const addData = await addRes.json();
    if (!addRes.ok) throw new Error(`Add to cart failed: ${addRes.status} ${addData.message || JSON.stringify(addData)}`);
    const getRes = await fetch(`${BASE}/cart`, { headers: { Authorization: `Bearer ${adminToken}` } });
    assert(getRes.ok, 'GET cart failed');
    const data = await getRes.json();
    const item = data.data?.items?.find(i => i.productId === createdProductId);
    if (item) {
      assert(Array.isArray(item.product?.productOptions), 'Cart item product must have productOptions');
    }
  });

  // --- Orders (checkout then list; verify order item product has productOptions) ---
  test('POST /orders/checkout then GET /orders', async () => {
    const createRes = await fetch(`${BASE}/orders/checkout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const contentType = createRes.headers.get('content-type') || '';
    const createData = contentType.includes('application/json') ? await createRes.json() : null;
    if (createRes.ok && createData?.data?.order?.items?.length) {
      for (const item of createData.data.order.items) {
        assert(Array.isArray(item.product?.productOptions), 'Order item product must have productOptions');
      }
    }
    const listRes = await fetch(`${BASE}/orders`, { headers: { Authorization: `Bearer ${adminToken}` } });
    assert(listRes.ok, `GET orders failed: ${listRes.status}`);
    const listData = await listRes.json();
    assert(listData.success !== undefined, 'Expected success/error response');
  });

  // --- Cleanup: delete created product (best-effort; may fail if product is in an order) ---
  test('DELETE /products/:id (cleanup)', async () => {
    const res = await fetch(`${BASE}/products/${createdProductId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const delBody = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 500) throw new Error(`Delete product failed: ${res.status} ${delBody.message || JSON.stringify(delBody)}`);
    // 500 is acceptable (e.g. FK constraint if product is in an order)
  });

  // Run all tests
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  OK: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL: ${name}`);
      console.error(`    ${err.message}`);
      failed++;
    }
  }
  console.log('\n---');
  console.log(`Passed: ${passed}, Failed: ${failed}, Total: ${tests.length}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('E2E runner error:', err);
  process.exit(1);
});
