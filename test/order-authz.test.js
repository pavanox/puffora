'use strict';

// Authorization tests: prove that customer data cannot be dumped by an
// unauthenticated caller, while the checkout / thank-you flow still works.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEST_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'puffora-authz-')),
  'orders.db'
);

process.env.PUFFORA_DB_PATH = TEST_DB_PATH;
// Raise the per-IP limits: this suite legitimately creates many orders.
process.env.RATE_LIMIT_CREATE_ORDER = '1000';
process.env.RATE_LIMIT_PAYMENT = '1000';
process.env.RATE_LIMIT_LOOKUP = '1000';
process.env.RATE_LIMIT_WEBHOOK = '1000';
process.env.ADMIN_API_KEY = 'test-admin-secret-key';

const { app, orderStore } = require('../server');
const { redactOrder, redactOrderForOwner } = require('../lib/redact');
const { keysMatch } = require('../lib/admin-auth');

let server;
let baseUrl;

const CUSTOMER = {
  fullName: 'Priya Sharma',
  email: 'priya.sharma@example.com',
  phone: '9876543210',
  address: '42 Secret Lane, Sector 9',
  city: 'Pune',
  state: 'Maharashtra',
  pincode: '411001'
};

async function request(url, options = {}) {
  const response = await fetch(baseUrl + url, options);
  let body = null;
  try {
    body = await response.json();
  } catch (error) {
    body = null;
  }
  return { status: response.status, body };
}

// Creates a real order through the API and returns its id and token.
async function createOrderOverHttp() {
  const result = await request('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientOrderId: `authz-${Date.now()}-${Math.random()}`,
      customer: CUSTOMER,
      items: [{ productId: 'dry-fruits-almond', variantId: 'almond-1000', quantity: 1 }]
    })
  });

  assert.equal(result.status, 201, 'order creation must succeed');
  return { orderId: result.body.order.orderId, orderToken: result.body.orderToken };
}

// Asserts that no customer PII appears anywhere in a serialised payload.
function assertNoPii(payload) {
  const serialised = JSON.stringify(payload);
  [
    CUSTOMER.fullName,
    CUSTOMER.email,
    CUSTOMER.phone,
    CUSTOMER.address,
    CUSTOMER.city,
    CUSTOMER.pincode
  ].forEach((secret) => {
    assert.ok(
      !serialised.includes(secret),
      `response must not contain "${secret}" but was: ${serialised.slice(0, 400)}`
    );
  });
}
// ---------------------------------------------------------------------------
// The order list must never be public
// ---------------------------------------------------------------------------

test('GET /api/orders without credentials is rejected', async () => {
  await createOrderOverHttp();

  const result = await request('/api/orders');

  assert.equal(result.status, 401, 'the order list must require authentication');
  assert.equal(result.body.ok, false);
  assert.equal(result.body.orders, undefined, 'no orders array may be returned');
  assertNoPii(result.body);
});

test('GET /api/orders with a wrong key is rejected', async () => {
  const result = await request('/api/orders', {
    headers: { 'x-admin-key': 'not-the-real-key' }
  });

  assert.equal(result.status, 401);
  assertNoPii(result.body);
});

test('GET /api/orders with a near-miss key is rejected', async () => {
  // Guards against a prefix or case-insensitive comparison bug.
  const result = await request('/api/orders', {
    headers: { authorization: 'Bearer test-admin-secret-ke' }
  });

  assert.equal(result.status, 401);
  assertNoPii(result.body);
});

test('GET /api/orders accepts the admin key via X-Admin-Key', async () => {
  const result = await request('/api/orders', {
    headers: { 'x-admin-key': 'test-admin-secret-key' }
  });

  assert.equal(result.status, 200);
  assert.ok(Array.isArray(result.body.orders));
  assert.ok(result.body.orders.length > 0, 'the admin must see the orders');
  // An authenticated admin is allowed the full record.
  assert.ok(result.body.orders.some((order) => order.customer.fullName === CUSTOMER.fullName));
});

test('GET /api/orders accepts the admin key via a Bearer token', async () => {
  const result = await request('/api/orders', {
    headers: { authorization: 'Bearer test-admin-secret-key' }
  });

  assert.equal(result.status, 200);
  assert.ok(result.body.orders.length > 0);
});

test('GET /api/orders fails closed when no admin key is configured', async () => {
  const saved = process.env.ADMIN_API_KEY;
  delete process.env.ADMIN_API_KEY;

  try {
    const result = await request('/api/orders', {
      headers: { 'x-admin-key': 'anything-at-all' }
    });

    assert.equal(result.status, 503, 'the endpoint must stay locked without a configured key');
    assert.equal(result.body.orders, undefined);
// ---------------------------------------------------------------------------
// Single-order lookup needs the token
// ---------------------------------------------------------------------------

test('GET /api/orders/:orderId without a token reveals nothing', async () => {
  const { orderId } = await createOrderOverHttp();

  const result = await request(`/api/orders/${orderId}`);

  assert.equal(result.status, 404, 'a guessed orderId must not return the order');
  assert.equal(result.body.order, undefined);
  assertNoPii(result.body);
});

test('GET /api/orders/:orderId with a wrong token reveals nothing', async () => {
  const { orderId } = await createOrderOverHttp();

  const result = await request(`/api/orders/${orderId}?token=${'f'.repeat(48)}`);

  assert.equal(result.status, 404);
  assert.equal(result.body.order, undefined);
  assertNoPii(result.body);
});

test('GET /api/orders/:orderId with the correct token returns a redacted order', async () => {
  const { orderId, orderToken } = await createOrderOverHttp();

  const result = await request(`/api/orders/${orderId}?token=${orderToken}`);

  assert.equal(result.status, 200, 'the thank-you flow must keep working');
  assert.equal(result.body.order.orderId, orderId);
  assert.equal(result.body.order.paymentStatus, 'PENDING');
  assert.equal(result.body.order.grandTotal, 1398);

  // The receipt still needs these.
  assert.ok(Array.isArray(result.body.order.items));
  assert.equal(result.body.order.items[0].variantSize, '1000');
  assert.equal(result.body.order.items[0].price, 1299, 'variant pricing must be intact');
  assert.equal(result.body.order.customer.firstName, 'Priya');

  // But the contact details and the token must never be echoed back.
  assertNoPii(result.body);
  assert.equal(result.body.orderToken, undefined);
  assert.equal(result.body.order.orderToken, undefined);
  assert.equal(result.body.order.customer.email, undefined);
  assert.equal(result.body.order.customer.address, undefined);
});

test('the order token also works as an X-Order-Token header', async () => {
  const { orderId, orderToken } = await createOrderOverHttp();

  const result = await request(`/api/orders/${orderId}`, {
    headers: { 'x-order-token': orderToken }
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.order.orderId, orderId);
  assertNoPii(result.body);
});

test('one order token cannot be used to read a different order', async () => {
  const first = await createOrderOverHttp();
  const second = await createOrderOverHttp();

// ---------------------------------------------------------------------------
// Payment responses must not leak PII either
// ---------------------------------------------------------------------------

test('payment endpoints return redacted orders', async () => {
  const { orderId } = await createOrderOverHttp();

  const verified = await request('/api/payments/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, paymentId: 'pay_test', signature: 'demo-signature' })
  });

  assert.equal(verified.status, 200);
  assert.equal(verified.body.order.paymentStatus, 'PAID');
  assertNoPii(verified.body);
  assert.equal(verified.body.order.orderToken, undefined);

  const failed = await request('/api/payments/fail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId })
  });

  assert.equal(failed.status, 200, 'an already-paid order stays successful');
  assertNoPii(failed.body);
});

test('order creation returns a token but not the stored customer record', async () => {
  const result = await request('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientOrderId: `authz-create-${Date.now()}`,
      customer: CUSTOMER,
      items: [{ productId: 'seeds-chia', variantId: 'chia-500', quantity: 1 }]
    })
  });

  assert.equal(result.status, 201);
  assert.ok(result.body.orderToken, 'the creator must receive a lookup token');
  assert.ok(result.body.orderToken.length >= 32, 'the token must be long enough to resist guessing');
  assert.equal(result.body.order.orderToken, undefined, 'the token must not be nested in the order');
  assertNoPii(result.body);
});

// ---------------------------------------------------------------------------
// Redaction helpers
// ---------------------------------------------------------------------------

test('redactOrder strips all customer fields', () => {
  const redacted = redactOrder({
    orderId: 'ORD-X',
    customer: CUSTOMER,
    items: [{ productId: 'p', productName: 'P', variantSize: '1000', quantity: 2, price: 10, itemTotal: 20 }],
    subtotal: 20,
    shipping: 99,
    grandTotal: 119,
    orderStatus: 'PAID',
    paymentStatus: 'PAID',
    createdAt: 'now',
    paidAt: 'now',
    orderToken: 'secret-token',
    sessionId: 'abc'
  });

  assert.equal(redacted.customer, undefined);
  assert.equal(redacted.orderToken, undefined);
  assert.equal(redacted.sessionId, undefined);
  assert.equal(redacted.items[0].variantSize, '1000');
  assertNoPii(redacted);
});

test('redactOrderForOwner keeps only the first name', () => {
  const redacted = redactOrderForOwner({
    orderId: 'ORD-X',
    customer: CUSTOMER,
    items: [],
    subtotal: 0,
    shipping: 0,
    grandTotal: 0,
    orderStatus: 'PENDING',
    paymentStatus: 'PENDING',
    createdAt: 'now'
  });

  assert.deepEqual(Object.keys(redacted.customer), ['firstName']);
  assert.equal(redacted.customer.firstName, 'Priya');
  assertNoPii(redacted);
});

test('keysMatch rejects mismatches and empty values', () => {
  assert.equal(keysMatch('secret', 'secret'), true);
  assert.equal(keysMatch('secret', 'Secret'), false);
  assert.equal(keysMatch('secret', 'secret '), false);
  assert.equal(keysMatch('', 'secret'), false);
  assert.equal(keysMatch('secret', ''), false);
  assert.equal(keysMatch(undefined, 'secret'), false);
});
  const result = await request(`/api/orders/${second.orderId}?token=${first.orderToken}`);

  assert.equal(result.status, 404, 'a token must only unlock its own order');
  assert.equal(result.body.order, undefined);
  assertNoPii(result.body);
});
    assertNoPii(result.body);
  } finally {
    process.env.ADMIN_API_KEY = saved;
  }
});

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  orderStore.close();
  fs.rmSync(path.dirname(TEST_DB_PATH), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});