'use strict';

// Controls what each audience is allowed to see in an order.
//
// The full order record contains customer name, email, phone and street address.
// Those fields must never reach an unauthenticated response, so every route
// shapes its output through one of these functions rather than returning the
// stored order directly.

// Safe for any response that is not explicitly authorised: no name, contact
// details or address. Items, totals and status are kept so the thank-you page
// can still render a receipt.
function redactOrder(order) {
  if (!order) {
    return null;
  }

  return {
    orderId: order.orderId,
    items: (order.items || []).map((item) => ({
      productId: item.productId,
      productName: item.productName,
      variantSize: item.variantSize,
      quantity: item.quantity,
      price: item.price,
      itemTotal: item.itemTotal
    })),
    subtotal: order.subtotal,
    shipping: order.shipping,
    grandTotal: order.grandTotal,
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
    createdAt: order.createdAt,
    paidAt: order.paidAt
  };
}

// Keeps the customer's first name so the confirmation page can greet them,
// while still withholding email, phone and address.
function redactOrderForOwner(order) {
  const redacted = redactOrder(order);
  if (!redacted) {
    return null;
  }

  const fullName = order.customer && order.customer.fullName ? String(order.customer.fullName) : '';
  redacted.customer = { firstName: fullName.split(' ')[0] || 'Guest' };
  return redacted;
}

// Everything, for an authenticated admin.
function toAdminOrder(order) {
  return order;
}

module.exports = { redactOrder, redactOrderForOwner, toAdminOrder };