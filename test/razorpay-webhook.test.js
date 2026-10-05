'use strict';

// Razorpay webhook tests: signature verification, idempotent handling of
// duplicate deliveries, and unmatched/edge-case events.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEST_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'puffora-webhook-')),
  'orders.db'
);

const WEBHOOK_SECRET = 'whsec_test_secret_value';

process.env.PUFFORA_DB_PATH = TEST_DB_PATH;
// Raise the per-IP limits: this suite legitimately creates many orders.
process.env.RATE_LIMIT_CREATE_ORDER = '1000';
process.env.RATE_LIMIT_PAYMENT = '1000';
process.env.RATE_LIMIT_LOOKUP = '1000';
process.env.RATE_LIMIT_WEBHOOK = '1000';
process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.ADMIN_API_KEY = 'test-admin-secret-key';

const { app, orderStore } = require('../server');
const {
  isValidWebhookSignature,
  extractOrderId,
  extractPaymentId,
  isPaymentSuccessEvent
} = require('../lib/razorpay-webhook');

let server;
let baseUrl;

const CUSTOMER = {
  fullName: 'Rahul Verma',
  email: 'rahul.verma@example.com',
  phone: '9876543210',
  address: '77 Test Road',
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

// Signs the body exactly as Razorpay does: HMAC-SHA256 over the raw bytes.
function sign(rawBody) {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
}

// Sends a webhook with a valid signature unless overridden.
async function sendWebhook(payload, options = {}) {
  const rawBody = options.rawBody !== undefined ? options.rawBody : JSON.stringify(payload);
  const signature = options.signature !== undefined ? options.signature : sign(rawBody);

  const headers = { 'Content-Type': 'application/json' };
  if (signature !== null) {
    headers['x-razorpay-signature'] = signature;
  }

  return request('/api/webhooks/razorpay', {
    method: 'POST',
    headers,
    body: rawBody
  });
}

// Razorpay sends the captured amount in paise. It is derived from the real
// order so the webhook amount check exercises a genuine match, and tests can
// override it to prove mismatches are rejected.
function buildCapturedEvent(orderId, overrides = {}) {
  const stored = orderStore.findOrder(orderId);
  const expectedAmount = stored ? Math.round(stored.grandTotal * 100) : 129900;

  return {
    entity: 'event',
    account_id: 'acc_test',
    event: overrides.event || 'payment.captured',
    contains: ['payment'],
    id: overrides.id || `evt_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    created_at: 1700000000,
    payload: {
      entity: 'payment',
      payment: {
        // Razorpay's real shape: payload.payment.entity holds the fields.
        entity: {
          id: overrides.paymentId || `pay_${orderId}`,
          amount: overrides.amount !== undefined ? overrides.amount : expectedAmount,
          currency: 'INR',
          status: 'captured',
          method: 'upi',
          captured: true,
          receipt: orderId,
          notes: overrides.notes !== undefined ? overrides.notes : { orderId }
        }
      }
    }
  };
}

async function createPendingOrder(variantId = 'almond-1000', quantity = 1) {
  const result = await request('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientOrderId: `wh-${Date.now()}-${Math.random()}`,
      customer: CUSTOMER,
      items: [{ productId: 'dry-fruits-almond', variantId, quantity }]
    })
  });

  assert.equal(result.status, 201, 'order creation must succeed');
  return result.body.order.orderId;
}

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

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

test('isValidWebhookSignature accepts a correct HMAC and rejects everything else', () => {
  const raw = '{"event":"payment.captured"}';
  const good = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');

  assert.equal(isValidWebhookSignature(raw, good, WEBHOOK_SECRET), true);
  assert.equal(isValidWebhookSignature(raw, 'deadbeef', WEBHOOK_SECRET), false);
  assert.equal(isValidWebhookSignature(raw, '', WEBHOOK_SECRET), false);
  assert.equal(isValidWebhookSignature(raw, undefined, WEBHOOK_SECRET), false);
  assert.equal(isValidWebhookSignature('', good, WEBHOOK_SECRET), false);

  // A signature made with the wrong secret must not be accepted.
  const wrongSecret = crypto.createHmac('sha256', 'other-secret').update(raw).digest('hex');
  assert.equal(isValidWebhookSignature(raw, wrongSecret, WEBHOOK_SECRET), false);

  // Signing a different body must not be accepted.
  assert.equal(isValidWebhookSignature('{"event":"tampered"}', good, WEBHOOK_SECRET), false);

  // With no configured secret nothing can validate.
  assert.equal(isValidWebhookSignature(raw, good, ''), false);
});

test('a webhook with no signature header is rejected', async () => {
  const orderId = await createPendingOrder();
  const result = await sendWebhook(buildCapturedEvent(orderId), { signature: null });

  assert.equal(result.status, 400);
  assert.equal(result.body.ok, false);
  assert.equal(orderStore.findOrder(orderId).paymentStatus, 'PENDING',
    'the order must not change when the signature is missing');
});

test('a webhook with an invalid signature is rejected and leaves the order untouched', async () => {
  const orderId = await createPendingOrder();
  const result = await sendWebhook(buildCapturedEvent(orderId), { signature: 'not-a-valid-signature' });

  assert.equal(result.status, 400);
  assert.equal(orderStore.findOrder(orderId).paymentStatus, 'PENDING');
  assert.equal(orderStore.findOrder(orderId).orderStatus, 'PENDING');
});

test('a webhook signed with the wrong secret is rejected', async () => {
  const orderId = await createPendingOrder();
  const payload = buildCapturedEvent(orderId);
  const rawBody = JSON.stringify(payload);
  const badSignature = crypto.createHmac('sha256', 'attacker-secret').update(rawBody).digest('hex');

  const result = await sendWebhook(payload, { signature: badSignature });

  assert.equal(result.status, 400);
  assert.equal(orderStore.findOrder(orderId).paymentStatus, 'PENDING');
});

test('a tampered body carrying a valid-looking signature is rejected', async () => {
  await createPendingOrder();
  const original = JSON.stringify(buildCapturedEvent('ORD-ORIGINAL'));
  const signature = sign(original);

  // Same signature, different bytes on the wire.
  const tampered = JSON.stringify(buildCapturedEvent('ORD-SOMETHING-ELSE'));
  const result = await sendWebhook(buildCapturedEvent('ORD-SOMETHING-ELSE'), {
    rawBody: tampered,
    signature
  });

  assert.equal(result.status, 400);
  assert.equal(orderStore.findOrder('ORD-SOMETHING-ELSE'), null,
    'the tampered payload must not create or pay an order');
});

test('the webhook fails closed when no secret is configured', async () => {
  const saved = process.env.RAZORPAY_WEBHOOK_SECRET;
  delete process.env.RAZORPAY_WEBHOOK_SECRET;

  try {
    const orderId = await createPendingOrder();
    const result = await sendWebhook(buildCapturedEvent(orderId));

    assert.equal(result.status, 503, 'webhooks must stay disabled without a secret');
    assert.equal(orderStore.findOrder(orderId).paymentStatus, 'PENDING');
  } finally {
    process.env.RAZORPAY_WEBHOOK_SECRET = saved;
  }
});

// ---------------------------------------------------------------------------
// Happy path: payment.captured marks the order PAID
// ---------------------------------------------------------------------------

test('a valid payment.captured webhook marks the order PAID', async () => {
  const orderId = await createPendingOrder('almond-1000', 2);
  assert.equal(orderStore.findOrder(orderId).paymentStatus, 'PENDING');

  const result = await sendWebhook(buildCapturedEvent(orderId));

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.status, 'paid');
  assert.equal(result.body.orderId, orderId);

  const stored = orderStore.findOrder(orderId);
  assert.equal(stored.paymentStatus, 'PAID');
  assert.equal(stored.orderStatus, 'PAID');
  assert.ok(stored.paidAt, 'paidAt must be set');
  assert.equal(stored.payment.paymentId, `pay_${orderId}`);
  assert.equal(stored.payment.amount, 269700, 'the captured amount must match the order total');
  assert.equal(stored.payment.source, 'webhook');

  // Variant pricing must be untouched by the webhook.
  assert.equal(stored.items[0].variantId, 'almond-1000');
  assert.equal(stored.items[0].price, 1299);
  assert.equal(stored.grandTotal, 2697);
});

test('the webhook response does not leak customer PII', async () => {
  const orderId = await createPendingOrder();
  const result = await sendWebhook(buildCapturedEvent(orderId));

  const serialised = JSON.stringify(result.body);
  [CUSTOMER.fullName, CUSTOMER.email, CUSTOMER.phone, CUSTOMER.address].forEach((secret) => {
    assert.ok(!serialised.includes(secret), `webhook response leaked "${secret}"`);
  });
  assert.equal(result.body.order.customer, undefined);
  assert.equal(result.body.order.orderToken, undefined);
});

test('a webhook marks an order PAID even when the browser never called /verify', async () => {
  // This is the exact gap the webhook exists to close: the customer paid but
  // closed the tab, so /verify never ran and the order was stuck at PENDING.
  const orderId = await createPendingOrder();
  assert.equal(orderStore.findOrder(orderId).paymentStatus, 'PENDING');

  await sendWebhook(buildCapturedEvent(orderId));

  assert.equal(orderStore.findOrder(orderId).paymentStatus, 'PAID');
});

// ---------------------------------------------------------------------------
// Duplicate deliveries
// ---------------------------------------------------------------------------

test('a duplicate webhook delivery is acknowledged but not applied twice', async () => {
  const orderId = await createPendingOrder();
  const event = buildCapturedEvent(orderId, { id: 'evt_duplicate_test' });

  const first = await sendWebhook(event);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'paid');

  const firstPaidAt = orderStore.findOrder(orderId).paidAt;

  const second = await sendWebhook(event);
  assert.equal(second.status, 200, 'a replay must still return 2xx so Razorpay stops retrying');
  assert.equal(second.body.status, 'duplicate');
  assert.equal(second.body.ok, true);

  const stored = orderStore.findOrder(orderId);
  assert.equal(stored.paymentStatus, 'PAID');
  assert.equal(stored.paidAt, firstPaidAt, 'paidAt must not move on a replay');
});

test('the same event delivered many times stays idempotent', async () => {
  const orderId = await createPendingOrder();
  const event = buildCapturedEvent(orderId, { id: 'evt_repeated_delivery' });

  const statuses = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await sendWebhook(event);
    statuses.push(result.body.status);
  }

  assert.deepEqual(statuses, ['paid', 'duplicate', 'duplicate', 'duplicate', 'duplicate']);
  assert.equal(orderStore.findOrder(orderId).paymentStatus, 'PAID');
});

test('a different event id for an already-paid order is a no-op', async () => {
  const orderId = await createPendingOrder();

  const first = await sendWebhook(buildCapturedEvent(orderId, { id: 'evt_first' }));
  assert.equal(first.body.status, 'paid');

  const paidAt = orderStore.findOrder(orderId).paidAt;

  // A genuinely new event, but the order is already settled.
  const second = await sendWebhook(buildCapturedEvent(orderId, { id: 'evt_second' }));
  assert.equal(second.status, 200);
  assert.equal(second.body.status, 'already_paid');

  const stored = orderStore.findOrder(orderId);
  assert.equal(stored.paymentStatus, 'PAID');
  assert.equal(stored.paidAt, paidAt);
});

// ---------------------------------------------------------------------------
// Interaction with the browser /verify endpoint
// ---------------------------------------------------------------------------

test('a webhook arriving after /verify does not double-apply', async () => {
  const orderId = await createPendingOrder();

  const verified = await request('/api/payments/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, paymentId: 'pay_browser', signature: 'demo-signature' })
  });
  assert.equal(verified.status, 200);
  const paidAtAfterVerify = orderStore.findOrder(orderId).paidAt;
  assert.equal(orderStore.findOrder(orderId).paymentStatus, 'PAID');

  // The webhook then arrives and must leave the order exactly as it was.
  const result = await sendWebhook(buildCapturedEvent(orderId));

  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'already_paid');
  assert.equal(orderStore.findOrder(orderId).paidAt, paidAtAfterVerify);
  assert.equal(orderStore.findOrder(orderId).payment.paymentId, 'pay_browser',
    'the browser-confirmed payment id must not be overwritten');
});

test('a webhook does not revive a FAILED order', async () => {
  const orderId = await createPendingOrder();

  await request('/api/payments/fail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId })
  });
  assert.equal(orderStore.findOrder(orderId).paymentStatus, 'FAILED');

  const result = await sendWebhook(buildCapturedEvent(orderId));

  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'already_finalised');
  assert.equal(orderStore.findOrder(orderId).paymentStatus, 'FAILED',
    'a failed order must stay failed');
});

test('a webhook does not revive a CANCELLED order', async () => {
  const orderId = await createPendingOrder();

  await request('/api/payments/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId })
  });
  assert.equal(orderStore.findOrder(orderId).paymentStatus, 'CANCELLED');

  const result = await sendWebhook(buildCapturedEvent(orderId));

  assert.equal(result.body.status, 'already_finalised');
  assert.equal(orderStore.findOrder(orderId).paymentStatus, 'CANCELLED');
});

// ---------------------------------------------------------------------------
// Unmatched and irrelevant events
// ---------------------------------------------------------------------------

test('a valid webhook for an unknown order is acknowledged as unmatched', async () => {
  const result = await sendWebhook(buildCapturedEvent('ORD-DOES-NOT-EXIST'));

  assert.equal(result.status, 200, 'an unknown order must not trigger endless retries');
  assert.equal(result.body.status, 'unmatched');
  assert.equal(result.body.orderId, 'ORD-DOES-NOT-EXIST');
  assert.equal(orderStore.findOrder('ORD-DOES-NOT-EXIST'), null,
    'an unmatched webhook must never create an order');
});

test('a non-success event is acknowledged and ignored', async () => {
  const orderId = await createPendingOrder();

  const result = await sendWebhook(buildCapturedEvent(orderId, {
    event: 'payment.authorized',
    id: 'evt_authorized_only'
  }));

  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'ignored');
  assert.equal(orderStore.findOrder(orderId).paymentStatus, 'PENDING',
    'an authorized-but-not-captured payment must not mark the order PAID');
});

test('order.paid is also treated as a success event', async () => {
  const orderId = await createPendingOrder();

  const result = await sendWebhook(buildCapturedEvent(orderId, {
    event: 'order.paid',
    id: 'evt_order_paid'
  }));

  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'paid');
  assert.equal(orderStore.findOrder(orderId).paymentStatus, 'PAID');
});
test('a payload without an event is rejected', async () => {
  const result = await sendWebhook({ id: 'evt_no_event', payload: {} });

  assert.equal(result.status, 400);
  assert.equal(result.body.ok, false);
});

test('a success event with no identifiable order is rejected', async () => {
  const result = await sendWebhook({
    id: 'evt_no_order',
    event: 'payment.captured',
    payload: { payment: { entity: 'payment', id: 'pay_x', amount: 100 } }
  });

  assert.equal(result.status, 400);
  assert.match(result.body.error, /order/i);
});

test('the order id falls back to the receipt when notes are absent', async () => {
  const orderId = await createPendingOrder();

  const event = buildCapturedEvent(orderId, { id: 'evt_receipt_fallback' });
  delete event.payload.payment.entity.notes; // force the receipt fallback path

  const result = await sendWebhook(event);

  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'paid');
  assert.equal(orderStore.findOrder(orderId).paymentStatus, 'PAID');
});
