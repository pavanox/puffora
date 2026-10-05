'use strict';

// Razorpay webhook signature verification and event handling.
//
// Razorpay signs the exact raw request body with the webhook secret and sends
// the HMAC in the x-razorpay-signature header. Verifying a re-serialised JSON
// object would fail, so the raw body must be preserved by the body parser.

const crypto = require('crypto');
const Razorpay = require('razorpay');

// Events that mean the customer actually paid. Everything else is acknowledged
// but ignored, so Razorpay does not retry events we do not care about.
const PAYMENT_SUCCESS_EVENTS = new Set(['payment.captured', 'order.paid']);

function getWebhookSecret() {
  return process.env.RAZORPAY_WEBHOOK_SECRET || '';
}

// Constant-time comparison of the presented signature against the expected
// HMAC of the raw body.
function isValidWebhookSignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) {
    return false;
  }

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  const provided = Buffer.from(String(signature).trim(), 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  if (provided.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(provided, expectedBuffer);
}

// The payload shape is payload.payment.entity.notes (and payload.order.entity.notes).
function paymentEntity(payload) {
  return (
    (payload && payload.payload && payload.payload.payment && payload.payload.payment.entity) ||
    (payload && payload.payload && payload.payload.order && payload.payload.order.entity) ||
    null
  );
}

// Recovers our orderId from a webhook payload. Razorpay puts it in the payment
// entity's notes; the receipt is the fallback.
function extractOrderId(payload) {
  const notes = (paymentEntity(payload) && paymentEntity(payload).notes) || {};

  if (notes.orderId) {
    return notes.orderId;
  }

  // Fall back to the receipt, which we set to our orderId when creating the
  // Razorpay order.
  const receipt = paymentEntity(payload) && paymentEntity(payload).receipt;
  if (receipt) {
    return receipt;
  }

  return null;
}

function extractPaymentId(payload) {
  const entity = paymentEntity(payload);
  return (entity && entity.id) || null;
}

function extractAmount(payload) {
  const entity = paymentEntity(payload);
  return entity && typeof entity.amount === 'number' ? entity.amount : null;
}

function isPaymentSuccessEvent(event) {
  return PAYMENT_SUCCESS_EVENTS.has(event);
}

// Confirms a payment with Razorpay directly before an order is marked PAID.
//
// The client-side signature proves the response came from Razorpay, but it does
// not prove that the amount charged matches the order, nor that the payment was
// actually captured. Fetching the payment closes both gaps.
//
// Returns { ok: true, payment } on success, or { ok: false, reason } when the
// payment cannot be confirmed. When Razorpay credentials are absent (demo
// mode) it returns { ok: true, skipped: true } so local development still works.
async function verifyPaymentWithRazorpay({ paymentId, expectedAmount, expectedCurrency }) {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    return { ok: true, skipped: true, reason: 'Razorpay credentials are not configured.' };
  }

  if (!paymentId) {
    return { ok: false, reason: 'A payment id is required to verify the payment with Razorpay.' };
  }

  let payment;
  try {
    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    payment = await razorpay.payments.fetch(paymentId);
  } catch (error) {
    // A fetch failure must never be treated as "paid".
    return { ok: false, reason: `Could not confirm the payment with Razorpay: ${error.message}` };
  }

  if (!payment || !payment.id) {
    return { ok: false, reason: 'Razorpay returned no payment for this id.' };
  }

  // Only a captured payment counts. `authorized` means the money is reserved
  // but not yet taken, and `failed` means it never completed.
  if (payment.status !== 'captured') {
    return { ok: false, reason: `Payment is not captured (status: ${payment.status}).` };
  }

  if (payment.captured === false) {
    return { ok: false, reason: 'Payment is not captured.' };
  }

  // Amounts are in the smallest currency unit (paise) on both sides.
  if (typeof expectedAmount === 'number' && Number(payment.amount) !== expectedAmount) {
    return {
      ok: false,
      reason: `Payment amount mismatch: Razorpay charged ${payment.amount}, expected ${expectedAmount}.`
    };
  }

  if (expectedCurrency && payment.currency && payment.currency !== expectedCurrency) {
    return { ok: false, reason: `Currency mismatch: ${payment.currency} vs ${expectedCurrency}.` };
  }

  return { ok: true, payment };
}

module.exports = {
  isValidWebhookSignature,
  extractOrderId,
  extractPaymentId,
  extractAmount,
  isPaymentSuccessEvent,
  getWebhookSecret,
  verifyPaymentWithRazorpay,
  PAYMENT_SUCCESS_EVENTS
};