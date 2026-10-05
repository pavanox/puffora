'use strict';

const crypto = require('crypto');

// Guards endpoints that expose customer data across all orders.
//
// Uses a shared admin key from the ADMIN_API_KEY environment variable. There is
// no user/role table in this project yet, so a single bearer secret is the
// smallest mechanism that actually closes the hole; a full auth system can
// replace requireAdmin without changing the routes.

function getAdminKey() {
  return process.env.ADMIN_API_KEY || '';
}

// Timing-safe comparison so the key cannot be recovered by measuring response
// latency. Hashing first keeps both buffers the same length.
function keysMatch(candidate, expected) {
  if (!candidate || !expected) {
    return false;
  }

  const a = crypto.createHash('sha256').update(String(candidate)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function readPresentedKey(req) {
  const header = req.get('authorization');
  if (header && /^bearer\s+/i.test(header)) {
    return header.replace(/^bearer\s+/i, '').trim();
  }
  return req.get('x-admin-key') || '';
}

// Express middleware. Responds 401 when no valid admin key is presented.
function requireAdmin(req, res, next) {
  const adminKey = getAdminKey();

  // Fail closed: if no key is configured the endpoint stays locked rather than
  // defaulting to open.
  if (!adminKey) {
    return res.status(503).json({
      ok: false,
      error: 'Admin access is not configured on this server.'
    });
  }

  if (!keysMatch(readPresentedKey(req), adminKey)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  }

  return next();
}

// Same secret, but compared against a per-order lookup token.
function tokenMatches(candidate, expected) {
  return keysMatch(candidate, expected);
}

module.exports = { requireAdmin, keysMatch, tokenMatches, getAdminKey };