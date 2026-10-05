const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { OrderStore } = require('./lib/order-store');
const { requireAdmin, keysMatch } = require('./lib/admin-auth');
const { redactOrder, redactOrderForOwner, toAdminOrder } = require('./lib/redact');
const {
  isValidWebhookSignature,
  extractOrderId,
  extractPaymentId,
  extractAmount,
  isPaymentSuccessEvent,
  getWebhookSecret,
  verifyPaymentWithRazorpay
} = require('./lib/razorpay-webhook');
const { getAllowedOrigins, getMisconfiguredOrigins, isProduction } = require('./lib/config');
const { RateLimiter, LIMITERS } = require('./lib/rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Orders live in SQLite, so they survive restarts and redeploys.
// Set PUFFORA_DB_PATH to relocate the database file (tests use a temp path).
const orderStore = new OrderStore();

// CORS is restricted to the known storefront origins. An open cors() would let
// any site on the internet call these APIs from a visitor's browser.
// Requests with no Origin header (server-to-server, curl, the Razorpay webhook)
// are allowed through, since CORS only governs browser access.
const ALLOWED_ORIGINS = getAllowedOrigins();
const ORIGIN_MISCONFIG = getMisconfiguredOrigins();

// A browser sends Origin; a same-origin or non-browser caller does not. Requests
// with no Origin are allowed through, since CORS only governs browser access.
function isOriginAllowed(origin) {
  if (!origin) {
    return true;
  }
  return ALLOWED_ORIGINS.includes(origin);
}

// Terminates a disallowed cross-origin request with a clean 403 instead of
// letting cors() throw, which would surface as a 500 and leak a stack trace.
app.use((req, res, next) => {
  if (isOriginAllowed(req.get('origin'))) {
    return next();
  }

  return res.status(403).json({ ok: false, error: 'Origin not allowed by CORS policy.' });
});

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      // Already rejected by the guard above; this keeps the header absent.
      return callback(null, false);
    },
    methods: ['GET', 'POST'],
    credentials: false,
    maxAge: 600
  })
);

// Razorpay signs the exact bytes it sent, so the raw body has to survive JSON
// parsing. Re-serialising the parsed object would change key order/whitespace
// and the signature would never match. `verify` runs before the body is parsed.
app.use(
  express.json({
    limit: '100kb',
    verify: (req, res, buf) => {
      req.rawBody = buf && buf.length ? buf.toString('utf8') : '';
    }
  })
);

// Rate limiters for the public, unauthenticated endpoints. Admin routes are
// protected by the admin key instead and are deliberately not throttled here.
const createOrderLimiter = new RateLimiter(LIMITERS.createOrder());
const paymentLimiter = new RateLimiter(LIMITERS.payment());
const lookupLimiter = new RateLimiter(LIMITERS.lookup());
const webhookLimiter = new RateLimiter(LIMITERS.webhook());

// Selling price for the 250 g pack. Larger packs are derived at runtime through
// VARIANT_PRICING unless an explicit price is listed for that pack size, so the
// server stays the single source of truth for pricing (the client never sends
// an amount).
const VARIANT_PRICING = {
  '250': 1.0,
  '500': 1.8,
  '1000': 3.2
};

// Explicit selling price per pack size, keyed by product slug then pack size.
// Where a pack size is listed here it overrides the multiplier entirely.
const PRODUCT_VARIANT_PRICES = {
  cashew: { '250': 269, '500': 549, '1000': 1049 },
  almond: { '250': 349, '500': 669, '1000': 1299 },
  walnut: { '250': 349, '500': 700, '1000': 1399 },
  sabja: { '250': 149, '500': 299, '1000': 599 },
  anjeer: { '250': 259, '500': 525, '1000': 1050 },
  pumpkin: { '250': 174, '500': 349, '1000': 699 },
  sunflower: { '250': 100, '500': 200, '1000': 399 },
  chia: { '250': 124, '500': 249, '1000': 499 },
  watermelon: { '250': 249, '500': 499, '1000': 999 },
  muskmelon: { '250': 249, '500': 499, '1000': 999 }
};

const DEFAULT_VARIANT_SIZE = '250';

const PRODUCTS = {
  'dry-fruits-almond': { name: 'Almond', slug: 'almond', price: 349, category: 'Dry Fruits' },
  'dry-fruits-anjeer': { name: 'Anjeer', slug: 'anjeer', price: 259, category: 'Dry Fruits' },
  'dry-fruits-cashew': { name: 'Cashew', slug: 'cashew', price: 269, category: 'Dry Fruits' },
  'dry-fruits-pista': { name: 'Pista', slug: 'pista', price: 699, category: 'Dry Fruits' },
  'dry-fruits-walnut': { name: 'Walnut', slug: 'walnut', price: 349, category: 'Dry Fruits' },
  'premium-dates-ajwa': { name: 'Ajwa', slug: 'ajwa', price: 999, category: 'Premium Dates' },
  'premium-dates-kalmi': { name: 'Kalmi', slug: 'kalmi', price: 699, category: 'Premium Dates' },
  'premium-dates-mashrook': { name: 'Mashrook', slug: 'mashrook', price: 899, category: 'Premium Dates' },
  'premium-dates-medjool': { name: 'Medjool', slug: 'medjool', price: 1099, category: 'Premium Dates' },
  'seeds-pumpkin': { name: 'Pumpkin', slug: 'pumpkin', price: 174, category: 'Seeds' },
  'seeds-watermelon': { name: 'Watermelon', slug: 'watermelon', price: 249, category: 'Seeds' },
  'seeds-muskmelon': { name: 'Muskmelon', slug: 'muskmelon', price: 249, category: 'Seeds' },
  'seeds-sunflower': { name: 'Sunflower', slug: 'sunflower', price: 100, category: 'Seeds' },
  'seeds-chia': { name: 'Chia', slug: 'chia', price: 124, category: 'Seeds' },
  'seeds-sabja': { name: 'Sabja', slug: 'sabja', price: 149, category: 'Seeds' },
  'healthy-snacks-makhana': { name: 'Makhana', slug: 'makhana', price: 459, category: 'Healthy Snacks' }
};

function getVariantSizes() {
  return Object.keys(VARIANT_PRICING);
}

function calculateVariantPrice(basePrice, variantSize, slug) {
  const multiplier = VARIANT_PRICING[variantSize];
  if (!multiplier) {
    return null;
  }

  // An explicit selling price for this pack size always wins over the
  // multiplier. Products without one keep the derived price.
  const explicit = slug && PRODUCT_VARIANT_PRICES[slug];
  if (explicit && explicit[variantSize] !== undefined) {
    return explicit[variantSize];
  }

  return Math.round(basePrice * multiplier);
}

// Resolves a (productId, variantId) pair into the concrete pack the customer
// selected. Returns null when the product is unknown or the variant does not
// belong to it, so callers can reject the payload instead of guessing.
function resolveVariant(productId, variantId) {
  const product = PRODUCTS[productId];
  if (!product) {
    return null;
  }

  const requested = variantId === undefined || variantId === null || variantId === ''
    ? `${product.slug}-${DEFAULT_VARIANT_SIZE}`
    : String(variantId);

  const variantSize = getVariantSizes().find((size) => requested === `${product.slug}-${size}`);
  if (!variantSize) {
    return null;
  }

  return {
    variantId: requested,
    variantSize,
    price: calculateVariantPrice(product.price, variantSize, product.slug)
  };
}

function createOrderId() {
  return 'ORD-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

// A second, independent secret that the customer must present to read their
// order back. Order IDs are short and guessable, so they cannot be the only
// thing protecting customer details.
function createOrderToken() {
  return crypto.randomBytes(24).toString('hex');
}

function calculateTotals(items) {
  const subtotal = items.reduce((total, item) => total + (item.price * item.quantity), 0);
  const shipping = subtotal > 0 ? 99 : 0;
  const grandTotal = subtotal + shipping;
  return { subtotal, shipping, grandTotal };
}

function validatePayload(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object') {
    errors.push('Request body must be an object.');
    return errors;
  }

  if (!payload.customer || typeof payload.customer !== 'object') {
    errors.push('Customer details are required.');
  } else {
    const { fullName, email, phone, address, city, state, pincode } = payload.customer;
    if (!fullName || !fullName.trim()) errors.push('Full name is required.');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('A valid email is required.');
    if (!phone || !/^(?:(?:\+|0{0,2})91[-\s]?)?[6-9]\d{9}$/.test(phone)) errors.push('A valid Indian mobile number is required.');
    if (!address || !address.trim()) errors.push('Address is required.');
    if (!city || !city.trim()) errors.push('City is required.');
    if (!state || !state.trim()) errors.push('State is required.');
    if (!pincode || !/^\d{6}$/.test(pincode)) errors.push('A valid 6-digit Indian PIN code is required.');
  }

  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    errors.push('At least one cart item is required.');
  } else {
    payload.items.forEach((item, index) => {
      if (!item.productId || typeof item.productId !== 'string') {
        errors.push(`Item ${index + 1} is missing productId.`);
        return;
      }
      if (!PRODUCTS[item.productId]) {
        errors.push(`Invalid product ID: ${item.productId}`);
      }
      if (!Number.isInteger(item.quantity) || item.quantity < 1) {
        errors.push(`Item ${index + 1} has an invalid quantity.`);
        return;
      }

      const hasVariantId = item.variantId !== undefined && item.variantId !== null && item.variantId !== '';
      if (hasVariantId && typeof item.variantId !== 'string') {
        errors.push(`Item ${index + 1} has an invalid variantId.`);
        return;
      }
      if (!resolveVariant(item.productId, item.variantId)) {
        errors.push(`Invalid variant ID: ${item.variantId} for product ${item.productId}`);
      }
    });
  }

  return errors;
}

function verifyPaymentSignature({ orderId, paymentId, secret, signature }) {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  if (signature === undefined) {
    return expectedSignature;
  }

  return expectedSignature === signature;
}

function findOrder(orderId) {
  return orderStore.findOrder(orderId);
}

async function createPaymentOrder(order) {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    return {
      gateway: 'razorpay',
      mode: 'demo',
      amount: order.grandTotal * 100,
      currency: 'INR',
      orderId: order.orderId,
      message: 'Razorpay credentials are not configured. Payment is running in demo mode for local development.'
    };
  }

  const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
  const paymentOrder = await razorpay.orders.create({
    amount: Math.round(order.grandTotal * 100),
    currency: 'INR',
    receipt: order.orderId,
    notes: {
      orderId: order.orderId,
      sessionId: order.sessionId
    }
  });

  return {
    gateway: 'razorpay',
    mode: 'live',
    keyId,
    amount: paymentOrder.amount,
    currency: paymentOrder.currency,
    razorpayOrderId: paymentOrder.id,
    orderId: order.orderId
  };
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Puffora backend is running.' });
});

app.post('/api/orders', createOrderLimiter.middleware(), async (req, res) => {
  const errors = validatePayload(req.body);
  if (errors.length) {
    return res.status(400).json({ ok: false, errors });
  }

  const payload = req.body;
  const items = payload.items.map((item) => {
    const product = PRODUCTS[item.productId];
    // Price is derived server-side from the resolved variant. The client never
    // sends an amount, so it cannot influence what the customer is charged.
    const variant = resolveVariant(item.productId, item.variantId);
    const unitPrice = variant ? variant.price : product.price;
    return {
      productId: item.productId,
      productName: product.name,
      category: product.category,
      variantId: variant ? variant.variantId : `${product.slug}-${DEFAULT_VARIANT_SIZE}`,
      variantSize: variant ? variant.variantSize : DEFAULT_VARIANT_SIZE,
      basePrice: product.price,
      price: unitPrice,
      quantity: item.quantity,
      itemTotal: unitPrice * item.quantity
    };
  });

  const { subtotal, shipping, grandTotal } = calculateTotals(items);
  const clientOrderId = payload.clientOrderId || createOrderId();
  const existingOrder = orderStore.findPendingOrderByClientOrderId(clientOrderId);

  if (existingOrder) {
    return res.status(200).json({
      ok: true,
      order: redactOrder(existingOrder),
      orderToken: existingOrder.orderToken,
      payment: existingOrder.payment
    });
  }

  const order = {
    orderId: createOrderId(),
    clientOrderId,
    customer: payload.customer,
    items,
    subtotal,
    shipping,
    grandTotal,
    orderStatus: 'PENDING',
    paymentStatus: 'PENDING',
    sessionId: payload.sessionId || 'anonymous',
    createdAt: new Date().toISOString(),
    orderToken: createOrderToken()
  };

  order.payment = await createPaymentOrder(order);
  orderStore.createOrder(order);

  // The order token is returned exactly once, to the browser that created the
  // order. It is the only credential the thank-you page needs to read the order.
  return res.status(201).json({
    ok: true,
    order: redactOrder(order),
    orderToken: order.orderToken,
    payment: order.payment
  });
});

app.post('/api/payments/verify', paymentLimiter.middleware(), async (req, res) => {
  const { orderId, paymentId, signature, razorpayOrderId } = req.body || {};

  if (!orderId || !paymentId || !signature) {
    return res.status(400).json({ ok: false, error: 'Payment verification payload is incomplete.' });
  }

  const order = findOrder(orderId);
  if (!order) {
    return res.status(404).json({ ok: false, error: 'Order not found.' });
  }

  if (order.paymentStatus === 'PAID') {
    return res.status(200).json({ ok: true, order: redactOrder(order), message: 'Payment already verified.' });
  }

  if (order.paymentStatus === 'FAILED' || order.paymentStatus === 'CANCELLED') {
    return res.status(409).json({ ok: false, order: redactOrder(order), error: 'Payment flow is already finalised.' });
  }

  const secret = process.env.RAZORPAY_KEY_SECRET || '';
  const expectedSignature = verifyPaymentSignature({
    orderId: razorpayOrderId || order.payment?.razorpayOrderId || '',
    paymentId,
    secret,
    signature
  });

  const isValid = expectedSignature === true || expectedSignature === signature;
  const isDemoMode = order.payment?.mode === 'demo';

  if (!isValid && !isDemoMode) {
    const failed = orderStore.updateOrder(orderId, {
      paymentStatus: 'FAILED',
      orderStatus: 'FAILED',
      failedAt: new Date().toISOString()
    });
    return res.status(400).json({ ok: false, order: redactOrder(failed), error: 'Payment signature verification failed.' });
  }

  // The signature proves Razorpay produced the response, but not that the right
  // amount was actually captured. Confirm against the Razorpay API before
  // treating the order as paid. Skipped automatically in demo mode.
  if (!isDemoMode) {
    const confirmation = await verifyPaymentWithRazorpay({
      paymentId,
      expectedAmount: Math.round(order.grandTotal * 100),
      expectedCurrency: 'INR'
    });

    if (!confirmation.ok) {
      return res.status(400).json({
        ok: false,
        order: redactOrder(order),
        error: confirmation.reason
      });
    }
  }

  const paid = orderStore.updateOrder(orderId, {
    paymentStatus: 'PAID',
    orderStatus: 'PAID',
    payment: {
      ...order.payment,
      paymentId,
      signature,
      verifiedAt: new Date().toISOString()
    },
    paidAt: new Date().toISOString()
  });

  return res.status(200).json({ ok: true, order: redactOrder(paid), message: 'Payment verified successfully.' });
});

app.post('/api/payments/fail', paymentLimiter.middleware(), (req, res) => {
  const { orderId } = req.body || {};
  const order = findOrder(orderId);

  if (!order) {
    return res.status(404).json({ ok: false, error: 'Order not found.' });
  }

  if (order.paymentStatus === 'PAID') {
    return res.status(200).json({ ok: true, order: redactOrder(order), message: 'Payment already completed.' });
  }

  const failed = orderStore.updateOrder(orderId, {
    paymentStatus: 'FAILED',
    orderStatus: 'FAILED',
    failedAt: new Date().toISOString()
  });
  return res.status(200).json({ ok: true, order: redactOrder(failed), message: 'Payment failed.' });
});

app.post('/api/payments/cancel', paymentLimiter.middleware(), (req, res) => {
  const { orderId } = req.body || {};
  const order = findOrder(orderId);

  if (!order) {
    return res.status(404).json({ ok: false, error: 'Order not found.' });
  }

  if (order.paymentStatus === 'PAID') {
    return res.status(200).json({ ok: true, order: redactOrder(order), message: 'Payment already completed.' });
  }

  const cancelled = orderStore.updateOrder(orderId, {
    paymentStatus: 'CANCELLED',
    orderStatus: 'CANCELLED',
    cancelledAt: new Date().toISOString()
  });
  return res.status(200).json({ ok: true, order: redactOrder(cancelled), message: 'Payment cancelled.' });
});

// Razorpay webhook.
//
// This is the authoritative confirmation of payment. The browser-driven
// /api/payments/verify is a convenience that can be lost if the customer
// closes the tab; this endpoint cannot.
//
// Security: the x-razorpay-signature header must be a valid HMAC-SHA256 of the
// raw body using the webhook secret. An unsigned or forged request is rejected
// with 400 and never reaches the order update.
app.post('/api/webhooks/razorpay', webhookLimiter.middleware(), async (req, res) => {
  const secret = getWebhookSecret();
  if (!secret) {
    // Fail closed: without a secret no signature can be trusted.
    return res.status(503).json({ ok: false, error: 'Webhook handling is not configured.' });
  }

  const signature = req.get('x-razorpay-signature');

  if (!isValidWebhookSignature(req.rawBody, signature, secret)) {
    return res.status(400).json({ ok: false, error: 'Invalid webhook signature.' });
  }

  const payload = req.body || {};
  const event = payload.event;

  if (!event) {
    return res.status(400).json({ ok: false, error: 'Webhook payload is missing an event.' });
  }

  const eventId = payload.id || null;

  // Duplicate delivery: Razorpay retries until it gets a 2xx. Acknowledge the
  // repeat without applying it again.
  if (eventId && orderStore.findWebhookEvent(eventId)) {
    return res.status(200).json({ ok: true, status: 'duplicate', event });
  }

  // Events we do not act on are acknowledged so Razorpay stops retrying them.
  if (!isPaymentSuccessEvent(event)) {
    if (eventId) {
      orderStore.recordWebhookEvent({
        eventId,
        event,
        orderId: extractOrderId(payload),
        paymentId: extractPaymentId(payload),
        orderStatus: 'IGNORED'
      });
    }
    return res.status(200).json({ ok: true, status: 'ignored', event });
  }

  const orderId = extractOrderId(payload);
  if (!orderId) {
    return res.status(400).json({ ok: false, error: 'Could not determine the order for this event.' });
  }

  const order = orderStore.findOrder(orderId);
  if (!order) {
    // Not matched to a local order. Returning 404 makes Razorpay retry, which is
    // wrong for a genuinely unknown order, so this is acknowledged instead.
    if (eventId) {
      orderStore.recordWebhookEvent({
        eventId,
        event,
        orderId,
        paymentId: extractPaymentId(payload),
        orderStatus: 'UNMATCHED'
      });
    }
    return res.status(200).json({ ok: true, status: 'unmatched', event, orderId });
  }

  // Already settled by the browser /verify call or an earlier delivery: the
  // webhook must not move a PAID order, and must not revive FAILED/CANCELLED.
  if (order.paymentStatus === 'PAID') {
    if (eventId) {
      orderStore.recordWebhookEvent({
        eventId,
        event,
        orderId,
        paymentId: extractPaymentId(payload),
        orderStatus: 'ALREADY_PAID'
      });
    }
    return res.status(200).json({ ok: true, status: 'already_paid', event, orderId });
  }

  if (order.paymentStatus === 'FAILED' || order.paymentStatus === 'CANCELLED') {
    if (eventId) {
      orderStore.recordWebhookEvent({
        eventId,
        event,
        orderId,
        paymentId: extractPaymentId(payload),
        orderStatus: 'ALREADY_FINALISED'
      });
    }
    return res.status(200).json({ ok: true, status: 'already_finalised', event, orderId });
  }

  const reportedAmount = extractAmount(payload);
  if (reportedAmount !== null && Math.round(order.grandTotal * 100) !== reportedAmount) {
    // Record it for investigation but do not mark the order paid.
    if (eventId) {
      orderStore.recordWebhookEvent({
        eventId,
        event,
        orderId,
        paymentId: extractPaymentId(payload),
        orderStatus: 'AMOUNT_MISMATCH'
      });
    }
    return res.status(200).json({
      ok: true,
      status: 'amount_mismatch',
      event,
      orderId,
      expectedAmount: Math.round(order.grandTotal * 100),
      receivedAmount: reportedAmount
    });
  }

  // Confirm the payment directly with Razorpay when the order was created in
  // live mode. This is the authoritative check that the money was captured.
  if (order.payment && order.payment.mode === 'live') {
    const confirmation = await verifyPaymentWithRazorpay({
      paymentId: extractPaymentId(payload),
      expectedAmount: Math.round(order.grandTotal * 100),
      expectedCurrency: 'INR'
    });

    if (!confirmation.ok) {
      if (eventId) {
        orderStore.recordWebhookEvent({
          eventId,
          event,
          orderId,
          paymentId: extractPaymentId(payload),
          orderStatus: 'UNCONFIRMED'
        });
      }
      // 200 so Razorpay stops retrying an event that will not become valid, but
      // the order is deliberately left untouched and unpaid.
      return res.status(200).json({
        ok: true,
        status: 'unconfirmed',
        event,
        orderId,
        reason: confirmation.reason
      });
    }
  }

  const paid = orderStore.updateOrder(orderId, {
    paymentStatus: 'PAID',
    orderStatus: 'PAID',
    payment: {
      ...order.payment,
      paymentId: extractPaymentId(payload) || undefined,
      amount: extractAmount(payload) || undefined,
      source: 'webhook',
      event,
      verifiedAt: new Date().toISOString()
    },
    paidAt: new Date().toISOString()
  });

  if (eventId) {
    orderStore.recordWebhookEvent({
      eventId,
      event,
      orderId,
      paymentId: extractPaymentId(payload),
      orderStatus: 'PAID'
    });
  }

  return res.status(200).json({ ok: true, status: 'paid', event, orderId, order: redactOrder(paid) });
});

// Customer-facing lookup used by the thank-you page.
//
// The orderId on its own is not a credential: it is only 8 hex characters and
// therefore enumerable. The caller must also present the orderToken issued at
// checkout. Without a valid token the response deliberately does not confirm
// whether the order exists, so this cannot be used to probe for valid IDs.
app.get('/api/orders/:orderId', lookupLimiter.middleware(), (req, res) => {
  const { orderId } = req.params;
  const orderToken =
    req.get('x-order-token') || (req.query.token ? String(req.query.token) : '');

  const order = orderStore.findOrderByToken(orderId, orderToken);

  if (!order) {
    return res.status(404).json({
      ok: false,
      error: 'Order not found. A valid order token is required to view order details.'
    });
  }

  return res.json({ ok: true, order: redactOrderForOwner(order) });
});

// Admin-only order list. Requires the ADMIN_API_KEY (Bearer token or
// X-Admin-Key header) and returns full records including customer contact
// details. Fails closed with 503 if no admin key is configured.
app.get('/api/orders', requireAdmin, (req, res) => {
  const orders = orderStore.listOrders().map(toAdminOrder);
  res.json({ ok: true, count: orders.length, orders });
});

module.exports = {
  app,
  orderStore,
  verifyPaymentSignature,
  resolveVariant,
  calculateVariantPrice,
  VARIANT_PRICING,
  PRODUCT_VARIANT_PRICES,
  DEFAULT_VARIANT_SIZE,
  redactOrder,
  redactOrderForOwner,
  requireAdmin,
  createOrderToken,
  isValidWebhookSignature,
  isPaymentSuccessEvent,
  assertProductionConfiguration
};

// Refuses to start in production when the configuration would leave the app
// insecure or non-functional. In development these are warnings only.
function assertProductionConfiguration() {
  const problems = [];

  if (!isProduction()) {
    return problems;
  }

  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    problems.push('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set; the server would fall back to demo mode and take no real money.');
  }

  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    problems.push('RAZORPAY_WEBHOOK_SECRET is not set; webhooks will be rejected with 503 and paid orders may stay PENDING.');
  }

  if (!process.env.ADMIN_API_KEY) {
    problems.push('ADMIN_API_KEY is not set; the admin order list stays locked.');
  }

  if (!process.env.ALLOWED_ORIGINS) {
    problems.push('ALLOWED_ORIGINS is not set; falling back to localhost-only defaults, so the live storefront cannot call the API.');
  }

  if (ORIGIN_MISCONFIG.length) {
    problems.push(`ALLOWED_ORIGINS contains local origins in production: ${ORIGIN_MISCONFIG.join(', ')}`);
  }

  return problems;
}

if (require.main === module) {
  const configProblems = assertProductionConfiguration();

  if (configProblems.length && isProduction()) {
    console.error('Refusing to start: unsafe production configuration.');
    configProblems.forEach((problem) => console.error(`  - ${problem}`));
    process.exit(1);
  }

  const server = app.listen(PORT, () => {
    const mode = isProduction() ? 'production' : 'development';
    const demoMode = !process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET;
    console.log(`Puffora backend running on port ${PORT} (${mode})`);
    console.log(`Orders database: ${orderStore.filename}`);
    console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
    console.log(`Razorpay mode: ${demoMode ? 'DEMO (no real payments)' : 'LIVE'}`);

    if (configProblems.length && !isProduction()) {
      console.warn('Configuration warnings:');
      configProblems.forEach((problem) => console.warn(`  - ${problem}`));
    }
  });

  // Flush and release the SQLite handle so the WAL is checkpointed cleanly.
  const shutdown = () => {
    server.close(() => {
      orderStore.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
