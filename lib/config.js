'use strict';

// Runtime configuration, read only from the environment.
//
// Every secret (Razorpay keys, webhook secret, admin key) is read from
// process.env and must never be written into frontend code, HTML or committed
// files. See .env.example for the required variable names.

const DEFAULT_LOCAL_ORIGINS = [
  'http://localhost:5500',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:3000'
];

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// The storefront origins allowed to call the API. In production this MUST be
// set explicitly via ALLOWED_ORIGINS; the localhost defaults exist only so
// local development keeps working.
function getAllowedOrigins() {
  const configured = splitList(process.env.ALLOWED_ORIGINS);
  return configured.length ? configured : DEFAULT_LOCAL_ORIGINS;
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

// Origins that are only permitted when not running in production. If any of
// these appear in ALLOWED_ORIGINS in production it is a configuration mistake
// worth failing loudly about.
function getMisconfiguredOrigins() {
  if (!isProduction()) {
    return [];
  }

  return getAllowedOrigins().filter(
    (origin) => origin.includes('localhost') || origin.includes('127.0.0.1')
  );
}

// Public origin of the deployed site, used for logging and for validating that
// the storefront itself is served over HTTPS.
function getStorefrontOrigin() {
  return process.env.STOREFRONT_ORIGIN || '';
}

module.exports = {
  DEFAULT_LOCAL_ORIGINS,
  getAllowedOrigins,
  getMisconfiguredOrigins,
  getStorefrontOrigin,
  isProduction,
  splitList
};