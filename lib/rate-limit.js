'use strict';

// Small fixed-window rate limiter for the public order and payment endpoints.
//
// Implemented in-process with no extra dependency, which is appropriate here
// because the app runs as a single Node process. If it is ever scaled to
// multiple instances this store would need to become shared (Redis), otherwise
// each instance would enforce its own independent budget.

// Decay evicted buckets so a long-running process cannot accumulate one entry
// per unique IP forever.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

class RateLimiter {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 60 * 1000;
    this.max = options.max || 30;
    this.message = options.message || 'Too many requests. Please try again shortly.';
    this.keyGenerator = options.keyGenerator || defaultKeyGenerator;
    this.hits = new Map();
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    // Do not hold the event loop open just for the sweeper.
    if (typeof this.sweeper.unref === 'function') {
      this.sweeper.unref();
    }
  }

  sweep() {
    // Drops buckets whose window has elapsed, so a long-running process does not
    // accumulate one entry per unique IP forever.
    const cutoff = Date.now() - this.windowMs;
    this.hits.forEach((entry, key) => {
      if (entry.startedAt < cutoff) {
        this.hits.delete(key);
      }
    });
  }

  // Express middleware. Responds 429 with a Retry-After header once the budget
  // for the window is exhausted.
  middleware() {
    return (req, res, next) => {
      const key = this.keyGenerator(req);
      const now = Date.now();
      const entry = this.hits.get(key);

      if (!entry || now - entry.startedAt >= this.windowMs) {
        this.hits.set(key, { startedAt: now, count: 1 });
        return next();
      }

      entry.count += 1;

      if (entry.count > this.max) {
        const retryAfterSeconds = Math.max(1, Math.ceil((this.windowMs - (now - entry.startedAt)) / 1000));
        res.set('Retry-After', String(retryAfterSeconds));
        return res.status(429).json({ ok: false, error: this.message });
      }

      return next();
    };
  }

  stop() {
    clearInterval(this.sweeper);
  }
}

// Identifies the caller. Prefers the proxy-provided client IP, because with
// CORS restricted to known origins the request may still traverse a reverse
// proxy in production.
function defaultKeyGenerator(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) {
    return forwarded.split(',')[0].trim();
  }

  return req.ip || req.socket && req.socket.remoteAddress || 'unknown';
}

// Named presets so the limits are obvious at the call site. The maxima can be
// raised via environment variables for local testing and load testing without
// editing code.
function limit(name, fallback) {
  const raw = process.env[`RATE_LIMIT_${name.toUpperCase()}`];
  const parsed = raw === undefined ? NaN : Number(raw);
  const max = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback.max;

  return { windowMs: fallback.windowMs, max, message: fallback.message };
}

const LIMITERS = {
  // Order creation is the expensive one: it talks to Razorpay.
  createOrder: () => limit('create_order', { windowMs: 60 * 1000, max: 10, message: 'Too many checkout attempts. Please wait a minute and try again.' }),
  // Payment verification is called by the browser; allow retries but not floods.
  payment: () => limit('payment', { windowMs: 60 * 1000, max: 30, message: 'Too many payment requests. Please wait a moment and try again.' }),
  // Read-only order lookup.
  lookup: () => limit('lookup', { windowMs: 60 * 1000, max: 60, message: 'Too many requests. Please slow down.' }),
  // Webhooks come from Razorpay; a burst of retries must not be throttled.
  webhook: () => limit('webhook', { windowMs: 60 * 1000, max: 600 })
};

module.exports = { RateLimiter, LIMITERS, defaultKeyGenerator };