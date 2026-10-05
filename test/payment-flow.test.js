const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Every store in this suite shares one throwaway database file, which lets the
// tests simulate a server restart (close and reopen) against the same data.
const TEST_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'puffora-orders-')),
  'orders.db'
);

// Must be set before requiring server.js, because server.js opens the store
// (and so resolves the database path) at module load time.
process.env.PUFFORA_DB_PATH = TEST_DB_PATH;
// Raise the per-IP limits: this suite legitimately creates many orders.
process.env.RATE_LIMIT_CREATE_ORDER = '1000';
process.env.RATE_LIMIT_PAYMENT = '1000';
process.env.RATE_LIMIT_LOOKUP = '1000';
process.env.RATE_LIMIT_WEBHOOK = '1000';

const { OrderStore } = require('../lib/order-store');
const {
  verifyPaymentSignature,
  resolveVariant,
  calculateVariantPrice,
  VARIANT_PRICING,
  PRODUCT_VARIANT_PRICES
} = require('../server');

function buildOrder(orderId, overrides = {}) {
  return {
    orderId,
    clientOrderId: `client-${orderId}`,
    customer: {
      fullName: 'Asha Rao',
      email: 'asha@example.com',
      phone: '9876543210',
      address: '12 Mango Street',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411001'
    },
    items: [
      {
        productId: 'dry-fruits-almond',
        productName: 'Almond',
        category: 'Dry Fruits',
        variantId: 'almond-1000',
        variantSize: '1000',
        basePrice: 349,
        price: 1299,
        quantity: 2,
        itemTotal: 2598
      }
    ],
    subtotal: 2598,
    shipping: 99,
    grandTotal: 2697,
    orderStatus: 'PENDING',
    paymentStatus: 'PENDING',
    payment: { gateway: 'razorpay', mode: 'demo', amount: 269700, currency: 'INR' },
    sessionId: 'anonymous',
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

test.after(() => {
  // server.js keeps its own store handle open; release it first, otherwise
  // Windows locks the database file and the cleanup below fails with EPERM.
  require('../server').orderStore.close();
  fs.rmSync(path.dirname(TEST_DB_PATH), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('verifyPaymentSignature validates Razorpay signatures', () => {
  const secret = 'test-secret';
  const orderId = 'order_123';
  const paymentId = 'pay_123';
  const signature = verifyPaymentSignature({ orderId, paymentId, secret });

  assert.ok(signature);
  assert.equal(typeof signature, 'string');
  assert.match(signature, /^[a-f0-9]{64}$/);
});

test('calculateVariantPrice prefers explicit selling prices over multipliers', () => {
  // Cashew has explicit prices, which override the 1.0/1.8/3.2 multipliers.
  assert.equal(calculateVariantPrice(269, '250', 'cashew'), 269);
  assert.equal(calculateVariantPrice(269, '500', 'cashew'), 549, 'not 269 * 1.8 = 484');
  assert.equal(calculateVariantPrice(269, '1000', 'cashew'), 1049, 'not 269 * 3.2 = 861');

  // A product with no explicit entry still falls back to the multiplier.
  assert.equal(calculateVariantPrice(699, '250', 'pista'), 699);
  assert.equal(calculateVariantPrice(699, '500', 'pista'), 1258); // 699 * 1.8
  assert.equal(calculateVariantPrice(999, '1000', 'ajwa'), 3197); // 999 * 3.2

  assert.equal(calculateVariantPrice(269, '4000', 'cashew'), null, 'unknown size must not price');
});

test('every explicit selling price is applied exactly as listed', () => {
  const expected = {
    cashew: { 250: 269, 500: 549, 1000: 1049 },
    almond: { 250: 349, 500: 669, 1000: 1299 },
    walnut: { 250: 349, 500: 700, 1000: 1399 },
    sabja: { 250: 149, 500: 299, 1000: 599 },
    anjeer: { 250: 259, 500: 525, 1000: 1050 },
    pumpkin: { 250: 174, 500: 349, 1000: 699 },
    sunflower: { 250: 100, 500: 200, 1000: 399 },
    chia: { 250: 124, 500: 249, 1000: 499 },
    watermelon: { 250: 249, 500: 499, 1000: 999 },
    muskmelon: { 250: 249, 500: 499, 1000: 999 }
  };

  const productIds = {
    cashew: 'dry-fruits-cashew',
    almond: 'dry-fruits-almond',
    walnut: 'dry-fruits-walnut',
    sabja: 'seeds-sabja',
    anjeer: 'dry-fruits-anjeer',
    pumpkin: 'seeds-pumpkin',
    sunflower: 'seeds-sunflower',
    chia: 'seeds-chia',
    watermelon: 'seeds-watermelon',
    muskmelon: 'seeds-muskmelon'
  };

  Object.keys(expected).forEach((slug) => {
    Object.keys(expected[slug]).forEach((size) => {
      const resolved = resolveVariant(productIds[slug], `${slug}-${size}`);
      assert.equal(resolved.price, expected[slug][size],
        `${slug} ${size}g must cost ${expected[slug][size]}, got ${resolved.price}`);
    });
  });
});

test('larger packs never cost less than the 250 g pack', () => {
  Object.keys(PRODUCT_VARIANT_PRICES).forEach((slug) => {
    const sizes = Object.keys(PRODUCT_VARIANT_PRICES[slug]).map(Number).sort((a, b) => a - b);
    for (let i = 1; i < sizes.length; i += 1) {
      assert.ok(
        PRODUCT_VARIANT_PRICES[slug][sizes[i]] >= PRODUCT_VARIANT_PRICES[slug][sizes[i - 1]],
        `${slug}: ${sizes[i]}g must not cost less than ${sizes[i - 1]}g`
      );
    }
  });
});

test('resolveVariant prices each pack size from the base price', () => {
  assert.deepEqual(resolveVariant('dry-fruits-almond', 'almond-250'), {
    variantId: 'almond-250',
    variantSize: '250',
    price: 349
  });

  const kilo = resolveVariant('dry-fruits-almond', 'almond-1000');
  assert.equal(kilo.variantSize, '1000');
  assert.equal(kilo.price, 1299, '1 kg almond must not be billed at the 250 g price');
});

test('resolveVariant defaults to the 250 g pack when variantId is omitted', () => {
  for (const missing of [undefined, null, '']) {
    const resolved = resolveVariant('dry-fruits-almond', missing);
    assert.equal(resolved.variantSize, '250');
    assert.equal(resolved.variantId, 'almond-250');
    assert.equal(resolved.price, 349);
  }
});

test('resolveVariant rejects variants that do not belong to the product', () => {
  assert.equal(resolveVariant('dry-fruits-almond', 'anjeer-500'), null,
    'a variant owned by another product must be rejected');
  assert.equal(resolveVariant('dry-fruits-almond', 'almond-750'), null,
    'an unsupported pack size must be rejected');
  assert.equal(resolveVariant('not-a-product', 'almond-250'), null);
});

test('every catalogue product prices all three pack sizes', () => {
  const basePrices = {
    'dry-fruits-almond': 349,
    'dry-fruits-anjeer': 259,
    'dry-fruits-cashew': 269,
    'dry-fruits-pista': 699,
    'dry-fruits-walnut': 349,
    'premium-dates-ajwa': 999,
    'premium-dates-kalmi': 699,
    'premium-dates-mashrook': 899,
    'premium-dates-medjool': 1099,
    'seeds-pumpkin': 174,
    'seeds-watermelon': 249,
    'seeds-muskmelon': 249,
    'seeds-sunflower': 100,
    'seeds-chia': 124,
    'seeds-sabja': 149,
    'healthy-snacks-makhana': 459
  };

  Object.keys(basePrices).forEach((productId) => {
    const slug = productId.split('-').pop();
    const explicit = PRODUCT_VARIANT_PRICES[slug];

    Object.keys(VARIANT_PRICING).forEach((size) => {
      const resolved = resolveVariant(productId, `${slug}-${size}`);
      assert.ok(resolved, `${productId} / ${size} must resolve`);

      // Listed products use their explicit selling price; the rest are derived.
      const expected = explicit && explicit[size] !== undefined
        ? explicit[size]
        : Math.round(basePrices[productId] * VARIANT_PRICING[size]);

      assert.equal(resolved.price, expected, `${productId} / ${size} price`);
      assert.ok(resolved.price >= basePrices[productId], 'larger packs must never cost less');
    });
  });
});

// ---------------------------------------------------------------------------
// Order persistence
// ---------------------------------------------------------------------------

test('creates an order and reads it back with its variant pricing intact', () => {
  const store = new OrderStore({ filename: TEST_DB_PATH });
  try {
    const created = store.createOrder(buildOrder('ORD-CREATE'));

    const loaded = store.findOrder('ORD-CREATE');
    assert.ok(loaded, 'the stored order must be retrievable');
    assert.equal(loaded.orderId, created.orderId);
    assert.equal(loaded.paymentStatus, 'PENDING');
    assert.equal(loaded.orderStatus, 'PENDING');
    assert.equal(loaded.grandTotal, 2697);

    // The whole point of the variant fix must survive a storage round trip.
    assert.equal(loaded.items.length, 1);
    assert.equal(loaded.items[0].variantId, 'almond-1000');
    assert.equal(loaded.items[0].variantSize, '1000');
    assert.equal(loaded.items[0].price, 1299);
    assert.equal(loaded.items[0].basePrice, 349);
    assert.equal(loaded.items[0].itemTotal, 2598);

    assert.deepEqual(loaded.customer, buildOrder('ORD-CREATE').customer);
  } finally {
    store.close();
  }
});

test('findOrder returns null for an unknown order', () => {
  const store = new OrderStore({ filename: TEST_DB_PATH });
  try {
    assert.equal(store.findOrder('ORD-DOES-NOT-EXIST'), null);
  } finally {
    store.close();
  }
});

test('orders survive a full store restart (close and reopen)', () => {
  const orderId = 'ORD-PERSIST';

  // "First run" of the server: create and pay.
  const firstRun = new OrderStore({ filename: TEST_DB_PATH });
  try {
    firstRun.createOrder(buildOrder(orderId));
    const paid = firstRun.updateOrder(orderId, {
      paymentStatus: 'PAID',
      orderStatus: 'PAID',
      paidAt: new Date().toISOString()
    });
    assert.equal(paid.paymentStatus, 'PAID');
  } finally {
    firstRun.close();
  }

  // "Restart": a brand new store instance pointing at the same file.
  const afterRestart = new OrderStore({ filename: TEST_DB_PATH });
  try {
    const reloaded = afterRestart.findOrder(orderId);
    assert.ok(reloaded, 'the order must still exist after a restart');
    assert.equal(reloaded.paymentStatus, 'PAID', 'payment state must be durable');
    assert.equal(reloaded.orderStatus, 'PAID');
    assert.ok(reloaded.paidAt, 'paidAt must survive the restart');
    assert.equal(reloaded.grandTotal, 2697);
    assert.equal(reloaded.items[0].variantId, 'almond-1000');
    assert.equal(reloaded.items[0].price, 1299, 'variant price must survive the restart');
  } finally {
    afterRestart.close();
  }
});

test('the database file is created on disk and reused across restarts', () => {
  assert.ok(fs.existsSync(TEST_DB_PATH), 'the SQLite file must exist after a write');
  const reopened = new OrderStore({ filename: TEST_DB_PATH });
  try {
    // Reopening must not wipe previously stored rows.
    assert.ok(reopened.findOrder('ORD-PERSIST'), 'existing rows must survive reopening');
  } finally {
    reopened.close();
  }
});

test('updateOrder records payment failure and cancellation transitions', () => {
  const store = new OrderStore({ filename: TEST_DB_PATH });
  try {
    store.createOrder(buildOrder('ORD-FAILED'));
    store.createOrder(buildOrder('ORD-CANCELLED'));

    store.updateOrder('ORD-FAILED', {
      paymentStatus: 'FAILED',
      orderStatus: 'FAILED',
      failedAt: new Date().toISOString()
    });
    store.updateOrder('ORD-CANCELLED', {
      paymentStatus: 'CANCELLED',
      orderStatus: 'CANCELLED',
      cancelledAt: new Date().toISOString()
    });

    const failed = store.findOrder('ORD-FAILED');
    assert.equal(failed.paymentStatus, 'FAILED');
    assert.ok(failed.failedAt);

    const cancelled = store.findOrder('ORD-CANCELLED');
    assert.equal(cancelled.paymentStatus, 'CANCELLED');
    assert.ok(cancelled.cancelledAt);
  } finally {
    store.close();
  }
});

test('updateOrder returns null for an unknown order', () => {
  const store = new OrderStore({ filename: TEST_DB_PATH });
  try {
    assert.equal(store.updateOrder('ORD-NOPE', { paymentStatus: 'PAID' }), null);
  } finally {
    store.close();
  }
});

test('duplicate order ids are rejected rather than silently overwritten', () => {
  const store = new OrderStore({ filename: TEST_DB_PATH });
  try {
    store.createOrder(buildOrder('ORD-DUP'));
    assert.throws(() => store.createOrder(buildOrder('ORD-DUP')), /UNIQUE|constraint/i);
  } finally {
    store.close();
  }
});

test('listOrders returns every stored order', () => {
  const store = new OrderStore({ filename: TEST_DB_PATH });
  try {
    const ids = store.listOrders().map((order) => order.orderId);
    ['ORD-CREATE', 'ORD-PERSIST', 'ORD-FAILED', 'ORD-CANCELLED'].forEach((id) => {
      assert.ok(ids.includes(id), `${id} must be listed`);
    });
  } finally {
    store.close();
  }
});

test('findPendingOrderByClientOrderId enforces checkout idempotency', () => {
  const store = new OrderStore({ filename: TEST_DB_PATH });
  try {
    const pending = store.createOrder(buildOrder('ORD-IDEM', { clientOrderId: 'checkout-42' }));
    assert.equal(store.findPendingOrderByClientOrderId('checkout-42').orderId, pending.orderId);

    // Once paid, the same client id must no longer match a PENDING order, so a
    // fresh checkout attempt is allowed to create a new order.
    store.updateOrder('ORD-IDEM', {
      paymentStatus: 'PAID',
      orderStatus: 'PAID',
      paidAt: new Date().toISOString()
    });
    assert.equal(store.findPendingOrderByClientOrderId('checkout-42'), null);
    assert.equal(store.findPendingOrderByClientOrderId(undefined), null);
  } finally {
    store.close();
  }
});

test('the running server uses the configured database', () => {
  const { orderStore, app } = require('../server');
  assert.equal(orderStore.filename, TEST_DB_PATH, 'server must honour PUFFORA_DB_PATH');

  orderStore.createOrder(buildOrder('ORD-VIA-SERVER'));
  const viaApi = orderStore.findOrder('ORD-VIA-SERVER');

  assert.ok(viaApi, 'orders written by the server must be readable');
  assert.equal(viaApi.items[0].variantSize, '1000');
  assert.equal(viaApi.items[0].price, 1299);
  assert.equal(typeof app, 'function', 'the express app must still be exported');
});
