'use strict';

// Production-readiness tests: CORS restriction, rate limiting, secret
// hygiene and startup configuration guards.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEST_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'puffora-prod-')),
  'orders.db'
);

process.env.PUFFORA_DB_PATH = TEST_DB_PATH;
process.env.ADMIN_API_KEY = 'test-admin-secret-key';
process.env.ALLOWED_ORIGINS = 'https://www.puffora.test';
// The suite creates many orders on purpose; production limits do not apply here.
process.env.RATE_LIMIT_CREATE_ORDER = '1000';
process.env.RATE_LIMIT_PAYMENT = '1000';
process.env.RATE_LIMIT_LOOKUP = '1000';
process.env.RATE_LIMIT_WEBHOOK = '1000';

const { app, orderStore } = require('../server');
const { RateLimiter, LIMITERS, defaultKeyGenerator } = require('../lib/rate-limit');
const { getAllowedOrigins, splitList, isProduction } = require('../lib/config');

let server;
let baseUrl;

const CUSTOMER = {
  fullName: 'Prod Audit',
  email: 'audit@example.com',
  phone: '9876543210',
  address: '1 Audit Street',
  city: 'Pune',
  state: 'Maharashtra',
  pincode: '411001'
};

async function createOrderWithOrigin(origin) {
  const response = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin },
    body: JSON.stringify({
      clientOrderId: `cors-${Date.now()}-${Math.random()}`,
      customer: CUSTOMER,
      items: [{ productId: 'dry-fruits-almond', variantId: 'almond-250', quantity: 1 }]
    })
  });
  return { status: response.status, headers: response.headers };
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
// CORS
// ---------------------------------------------------------------------------

test('the configured storefront origin is allowed', async () => {
  const result = await createOrderWithOrigin('https://www.puffora.test');
  assert.equal(result.status, 201);
  assert.equal(
    result.headers.get('access-control-allow-origin'),
    'https://www.puffora.test'
  );
});

test('a blocked origin is refused with a clean 403 and no stack trace', async () => {
  const response = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({
      clientOrderId: `evil-${Date.now()}`,
      customer: CUSTOMER,
      items: [{ productId: 'dry-fruits-almond', variantId: 'almond-250', quantity: 1 }]
    })
  });

  assert.equal(response.status, 403, 'a disallowed origin must be refused');
  assert.equal(
    response.headers.get('access-control-allow-origin'),
    null,
    'a blocked origin must not be reflected back'
  );

  const body = await response.json();
  assert.equal(body.ok, false);
  assert.ok(!JSON.stringify(body).includes('server.js'), 'no stack trace may be leaked');
});

test('a blocked origin is never reflected back', async () => {
  const response = await fetch(`${baseUrl}/api/orders`, {
    method: 'GET',
    headers: { origin: 'https://evil.example', 'x-admin-key': 'test-admin-secret-key' }
  });

  assert.equal(
    response.headers.get('access-control-allow-origin'),
    null,
    'a blocked origin must not be reflected back'
  );
});

test('requests without an Origin header still work (server-to-server)', async () => {
  // Razorpay webhooks and curl send no Origin; they must not be blocked.
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

function callMiddleware(middleware, ip) {
  let status = 200;
  const res = {
    set() {},
    status(code) { status = code; return this; },
    json() { return this; }
  };
  middleware({ headers: {}, ip, socket: {} }, res, () => { status = 200; });
  return status;
}

test('the limiter blocks requests past the configured budget', () => {
  const limiter = new RateLimiter({ windowMs: 60000, max: 3 });
  const middleware = limiter.middleware();

  try {
    assert.equal(callMiddleware(middleware, '1.1.1.1'), 200);
    assert.equal(callMiddleware(middleware, '1.1.1.1'), 200);
    assert.equal(callMiddleware(middleware, '1.1.1.1'), 200);
    assert.equal(callMiddleware(middleware, '1.1.1.1'), 429, 'the fourth request must be throttled');
  } finally {
    limiter.stop();
  }
});

test('the limiter tracks each caller separately', () => {
  const limiter = new RateLimiter({ windowMs: 60000, max: 1 });
  const middleware = limiter.middleware();

  try {
    assert.equal(callMiddleware(middleware, '10.0.0.1'), 200);
    assert.equal(callMiddleware(middleware, '10.0.0.1'), 429, 'the same caller is throttled');
    assert.equal(callMiddleware(middleware, '10.0.0.2'), 200, 'a different caller is unaffected');
  } finally {
    limiter.stop();
  }
});

test('a throttled response carries a Retry-After header', () => {
  const limiter = new RateLimiter({ windowMs: 60000, max: 1 });
  const middleware = limiter.middleware();
  let retryAfter = null;

  try {
    callMiddleware(middleware, '10.0.0.5');
    const res = {
      set(key, value) { if (key === 'Retry-After') { retryAfter = value; } },
      status() { return this; },
      json() { return this; }
    };
    middleware({ headers: {}, ip: '10.0.0.5', socket: {} }, res, () => {});
    assert.ok(retryAfter, 'Retry-After must be set so clients know when to retry');
  } finally {
    limiter.stop();
  }
});

test('the limiter honours x-forwarded-for for proxied deployments', () => {
  assert.equal(
    defaultKeyGenerator({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, socket: {} }),
    '203.0.113.7'
  );
  assert.equal(defaultKeyGenerator({ headers: {}, socket: {} }), 'unknown');
});

test('the limiter evicts stale buckets so memory stays bounded', async () => {
  const limiter = new RateLimiter({ windowMs: 20, max: 5 });
  const middleware = limiter.middleware();

  try {
    for (let i = 0; i < 50; i += 1) {
      callMiddleware(middleware, `10.1.0.${i}`);
    }
    assert.equal(limiter.hits.size, 50);

    // Let the window elapse, then sweep.
    await new Promise((resolve) => setTimeout(resolve, 40));
    limiter.sweep();

    assert.equal(limiter.hits.size, 0, 'expired buckets must be removed');
  } finally {
    limiter.stop();
  }
});
// ---------------------------------------------------------------------------
// Secret hygiene
// ---------------------------------------------------------------------------

test('no secret or key is hardcoded in server or library code', () => {
  const files = [
    'server.js',
    'lib/order-store.js',
    'lib/admin-auth.js',
    'lib/razorpay-webhook.js',
    'lib/config.js',
    'lib/rate-limit.js',
    'lib/redact.js'
  ];

  files.forEach((file) => {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.ok(!/rzp_(live|test)_[A-Za-z0-9]{6,}/.test(source), `${file} contains a Razorpay key id`);
    assert.ok(!/whsec_[A-Za-z0-9]{6,}/.test(source), `${file} contains a webhook secret`);
    assert.ok(!/ADMIN_API_KEY\s*=\s*['"][^'"]+['"]/.test(source), `${file} hardcodes the admin key`);
  });
});

test('no secret appears in frontend code', () => {
  const root = path.join(__dirname, '..');
  const htmlFiles = fs.readdirSync(root).filter((f) => f.endsWith('.html'));
  const jsFiles = fs.readdirSync(path.join(root, 'js')).filter((f) => f.endsWith('.js'));

  htmlFiles.concat(jsFiles.map((f) => path.join('js', f))).forEach((file) => {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(
      !/key_secret|RAZORPAY_KEY_SECRET|ADMIN_API_KEY|WEBHOOK_SECRET/.test(source),
      `${file} references a secret`
    );
    assert.ok(!/rzp_live_[A-Za-z0-9]{6,}/.test(source), `${file} contains a Razorpay key`);
  });
});

test('no hardcoded localhost URLs remain in the frontend', () => {
  const root = path.join(__dirname, '..');
  const htmlFiles = fs.readdirSync(root).filter((f) => f.endsWith('.html'));

  htmlFiles.forEach((file) => {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(!/http:\/\/localhost/.test(source), `${file} still hardcodes http://localhost`);
    assert.ok(!/http:\/\/127\.0\.0\.1/.test(source), `${file} still hardcodes http://127.0.0.1`);
  });
});

test('the gitignore protects env files, databases and dependencies', () => {
  const gitignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');

  ['node_modules/', '.env', 'data/', '*.db', '*.db-wal', '*.db-shm'].forEach((pattern) => {
    assert.ok(gitignore.includes(pattern), `.gitignore must include ${pattern}`);
  });

  // .env.example must stay committable.
  assert.ok(gitignore.includes('!.env.example'), '.env.example must be explicitly allowed');
});

test('an .env.example exists and documents every required variable', () => {
  const example = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');

  [
    'RAZORPAY_KEY_ID',
    'RAZORPAY_KEY_SECRET',
    'RAZORPAY_WEBHOOK_SECRET',
    'ADMIN_API_KEY',
    'ALLOWED_ORIGINS',
    'NODE_ENV'
  ].forEach((name) => {
    assert.ok(example.includes(`${name}=`), `.env.example must document ${name}`);
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('allowed origins come from the environment and are parsed correctly', () => {
  assert.deepEqual(getAllowedOrigins(), ['https://www.puffora.test']);
  assert.deepEqual(splitList(' a , b ,, c '), ['a', 'b', 'c']);
  assert.deepEqual(splitList(''), []);
  assert.deepEqual(splitList(undefined), []);
});

test('limit presets can be raised by environment variable', () => {
  const saved = process.env.RATE_LIMIT_CREATE_ORDER;
  process.env.RATE_LIMIT_CREATE_ORDER = '999';
  try {
    assert.equal(LIMITERS.createOrder().max, 999);
  } finally {
    if (saved === undefined) {
      delete process.env.RATE_LIMIT_CREATE_ORDER;
    } else {
      process.env.RATE_LIMIT_CREATE_ORDER = saved;
    }
  }
});

test('the production config guard is exported and detects missing secrets', () => {
  const { assertProductionConfiguration } = require('../server');
  assert.equal(typeof assertProductionConfiguration, 'function');

  const savedEnv = process.env.NODE_ENV;
  const savedKey = process.env.RAZORPAY_KEY_ID;
  process.env.NODE_ENV = 'production';
  delete process.env.RAZORPAY_KEY_ID;

  try {
    const problems = assertProductionConfiguration();
    assert.ok(problems.length > 0, 'production without Razorpay keys must be flagged');
    assert.ok(problems.some((p) => /RAZORPAY_KEY_ID/.test(p)));
  } finally {
    process.env.NODE_ENV = savedEnv;
    if (savedKey !== undefined) {
      process.env.RAZORPAY_KEY_ID = savedKey;
    }
  }
});
