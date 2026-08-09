// apps/backend/scripts/openapi/schemas/publicPaymentPage.mjs
// Public bill-payment landing page (src/routes/billing/publicPaymentPageRoutes.js),
// mounted at /pay — OUTSIDE /api/v1 and above validateApiKey/jwtAuth on purpose: it is
// the browser page a patient opens from the payment link we SMS/WhatsApp/email, and the
// opaque link token in the URL is the only credential they hold. It renders HTML, not
// the platform's JSON envelope, the same way /downtime/static does.

export const operations = {
  'GET /pay/{token}': {
    summary: 'Public bill-payment landing page',
    description:
      'Server-rendered HTML page a patient opens from the payment link sent by SMS, ' +
      'WhatsApp or email. Unauthenticated by design — the opaque `token` is the bearer ' +
      'credential — and rate-limited with the patient profile. Shows the hospital display ' +
      'name, invoice number (or "advance payment" when the link is not invoice-backed), ' +
      'the amount due, and one of four states: payable (with a `upi://pay` intent link ' +
      'built from the stored NPCI deep link), already paid, expired, or cancelled. Expiry ' +
      'is evaluated from the link row\'s `expires_at` rather than its status, so a link ' +
      'past its deadline is never presented as payable even before the expiry cron runs. ' +
      'Unknown and malformed tokens return one identical 404 page so the route cannot be ' +
      'used to enumerate tokens; a lookup failure returns 503 with a retry page. No PHI is ' +
      'published beyond the invoice number and amount — in particular no patient name, ' +
      'phone, diagnosis or bill line items. UPI is the only rail offered: no card, ' +
      'netbanking or wallet gateway is integrated, and payment is reconciled manually by ' +
      'the billing desk, which the page states rather than implying instant confirmation.',
    pathParameters: {
      token: { type: 'string', minLength: 16, maxLength: 64 },
    },
  },
};
