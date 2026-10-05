'use strict';

// Persistent order storage backed by SQLite (Node's built-in `node:sqlite`).
// Chosen over a JSON file because writes are atomic and survive concurrent
// requests, and over better-sqlite3 because it needs no native compilation.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'orders.db');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS orders (
    order_id        TEXT PRIMARY KEY,
    client_order_id TEXT,
    customer        TEXT    NOT NULL,
    items           TEXT    NOT NULL,
    subtotal        INTEGER NOT NULL,
    shipping        INTEGER NOT NULL,
    grand_total     INTEGER NOT NULL,
    order_status    TEXT    NOT NULL,
    payment_status  TEXT    NOT NULL,
    payment         TEXT,
    session_id      TEXT,
    created_at      TEXT    NOT NULL,
    paid_at         TEXT,
    failed_at       TEXT,
    cancelled_at    TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_orders_client_order
    ON orders (client_order_id, payment_status);
`;

// Tables added after the first release. Created only when missing, so an
// existing database is upgraded in place.
const EXTRA_TABLES = [
  `CREATE TABLE IF NOT EXISTS webhook_events (
     event_id     TEXT PRIMARY KEY,
     event        TEXT NOT NULL,
     order_id     TEXT,
     payment_id   TEXT,
     order_status TEXT,
     received_at  TEXT NOT NULL
   );`
];

// Columns added after the first release. CREATE TABLE IF NOT EXISTS will not add
// them to an existing database, so each one is applied conditionally instead.
const MIGRATIONS = [
  { column: 'order_token', definition: 'TEXT' }
];

function applyMigrations(db) {
  const existing = new Set(
    db.prepare('PRAGMA table_info(orders)').all().map((column) => column.name)
  );

  MIGRATIONS.forEach(({ column, definition }) => {
    if (!existing.has(column)) {
      db.exec(`ALTER TABLE orders ADD COLUMN ${column} ${definition};`);
    }
  });

  // Created here rather than in SCHEMA, because the index depends on a column
  // that a migrated database may not have had yet.
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_token ON orders (order_token);');
}

function toOrder(row) {
  if (!row) {
    return null;
  }

  return {
    orderId: row.order_id,
    clientOrderId: row.client_order_id || undefined,
    customer: JSON.parse(row.customer),
    items: JSON.parse(row.items),
    subtotal: row.subtotal,
    shipping: row.shipping,
    grandTotal: row.grand_total,
    orderStatus: row.order_status,
    paymentStatus: row.payment_status,
    payment: row.payment ? JSON.parse(row.payment) : undefined,
    sessionId: row.session_id,
    createdAt: row.created_at,
    paidAt: row.paid_at || undefined,
    failedAt: row.failed_at || undefined,
    cancelledAt: row.cancelled_at || undefined
  };
}

// Full order record including the secret lookup token. Only the server should
// ever see this shape; API responses must go through redaction first.
function toPrivateOrder(row) {
  const order = toOrder(row);
  if (!order) {
    return null;
  }

  order.orderToken = row.order_token || null;
  return order;
}

class OrderStore {
  constructor(options = {}) {
    this.filename = options.filename || process.env.PUFFORA_DB_PATH || DEFAULT_DB_PATH;

    if (this.filename !== ':memory:') {
      fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    }

    this.db = new DatabaseSync(this.filename);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    EXTRA_TABLES.forEach((statement) => this.db.exec(statement));
    applyMigrations(this.db);
  }

  // Inserts a new order. Throws if the orderId already exists.
  createOrder(order) {
    this.db
      .prepare(
        `INSERT INTO orders (
           order_id, client_order_id, customer, items, subtotal, shipping,
           grand_total, order_status, payment_status, payment, session_id,
           created_at, paid_at, failed_at, cancelled_at, order_token
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        order.orderId,
        order.clientOrderId || null,
        JSON.stringify(order.customer || {}),
        JSON.stringify(order.items || []),
        order.subtotal,
        order.shipping,
        order.grandTotal,
        order.orderStatus,
        order.paymentStatus,
        order.payment ? JSON.stringify(order.payment) : null,
        order.sessionId || null,
        order.createdAt,
        order.paidAt || null,
        order.failedAt || null,
        order.cancelledAt || null,
        order.orderToken || null
      );

    return order;
  }

  findOrder(orderId) {
    return toPrivateOrder(this.db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId));
  }

  // Used by the customer-facing lookup. Returns the order only when the secret
  // token issued at checkout matches, so a guessed orderId alone reveals nothing.
  findOrderByToken(orderId, orderToken) {
    if (!orderId || !orderToken) {
      return null;
    }

    return toPrivateOrder(
      this.db.prepare('SELECT * FROM orders WHERE order_id = ? AND order_token = ?').get(orderId, orderToken)
    );
  }

  listOrders() {
    return this.db
      .prepare('SELECT * FROM orders ORDER BY created_at ASC')
      .all()
      .map(toOrder);
  }

  // Supports the idempotency check that stops a retried checkout creating a
  // second order while the first is still awaiting payment.
  findPendingOrderByClientOrderId(clientOrderId) {
    if (!clientOrderId) {
      return null;
    }

    return toOrder(
      this.db
        .prepare("SELECT * FROM orders WHERE client_order_id = ? AND payment_status = 'PENDING' LIMIT 1")
        .get(clientOrderId)
    );
  }

  // Persists changes to an existing order (used for payment transitions).
  updateOrder(orderId, updates) {
    const current = this.findOrder(orderId);
    if (!current) {
      return null;
    }

    const next = { ...current, ...updates };
    this.db
      .prepare(
        `UPDATE orders SET
           order_status = ?, payment_status = ?, payment = ?,
           paid_at = ?, failed_at = ?, cancelled_at = ?
         WHERE order_id = ?`
      )
      .run(
        next.orderStatus,
        next.paymentStatus,
        next.payment ? JSON.stringify(next.payment) : null,
        next.paidAt || null,
        next.failedAt || null,
        next.cancelledAt || null,
        orderId
      );

    return next;
  }

  // Records a processed webhook event. Returns false when the eventId has
// already been seen, which is how duplicate deliveries are detected: Razorpay
// retries a webhook until it receives a 2xx, so the same event can arrive
// several times and must not be applied twice.
recordWebhookEvent({ eventId, event, orderId, paymentId, orderStatus }) {
  const existing = this.findWebhookEvent(eventId);
  if (existing) {
    return false;
  }

  this.db
    .prepare(
      `INSERT INTO webhook_events
         (event_id, event, order_id, payment_id, order_status, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(eventId, event, orderId || null, paymentId || null, orderStatus || null, new Date().toISOString());

  return true;
}

findWebhookEvent(eventId) {
  if (!eventId) {
    return null;
  }

  return this.db.prepare('SELECT * FROM webhook_events WHERE event_id = ?').get(eventId) || null;
}

close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = { OrderStore, DEFAULT_DB_PATH };
