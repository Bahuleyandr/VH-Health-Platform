// src/routes/billing/publicPaymentPageRoutes.js
//
// PUBLIC payment landing page — GET /pay/:token.
//
// WHY THIS EXISTS: paymentLinkService.sendPaymentLink() has always texted
// patients a `${HOSPITAL_PAY_BASE_URL}/<token>` URL, but no route ever served
// it — every patient who tapped the link got a 404 (audit 2026-08-09, finding
// F8). This router is that missing page.
//
// SHAPE / MOUNTING:
//   * Mounted OUTSIDE /api/v1, above validateApiKey and jwtAuth (app.js), for
//     the same reason /downtime/static is: it is a browser page opened by a
//     patient who holds no credential except the token in the URL.
//   * It renders HTML, so it deliberately does NOT use the success()/error()
//     JSON envelope. Same exemption /downtime/static and the BCMA wristband /
//     lab specimen label renderers already take.
//   * The router is explicitly marked `billing` for the OpenAPI tag registry.
//     Without that, the filename bootstrap would resolve an undeclared slug and
//     fail spec generation.
//
// SECURITY / PHI POSTURE:
//   * The token is a BEARER CREDENTIAL. It is never logged, and never echoed
//     into the page body.
//   * The page shows ONLY: hospital display name, invoice number, amount,
//     currency, link expiry/paid timestamps. No patient name, no phone, no
//     diagnosis, no line items — see getPublicPaymentLinkView()'s allowlist,
//     pinned by src/tests/unit/publicPaymentPageView.test.js.
//   * Unknown, malformed, and expired-beyond-lookup tokens all render ONE
//     byte-identical 404 page, so the route is not a token-enumeration oracle.
//     States that require a real token (paid / expired / cancelled) do differ —
//     that is information the link holder already has, not an oracle.
//   * Rate-limited with the patient profile at the mount (app.js).
//   * NO inline <script>: the app's CSP sets script-src 'self' with no
//     'unsafe-inline'. Inline <style> IS permitted (style-src carries
//     'unsafe-inline'), which is why this page is styled inline and scriptless.

import express from 'express';
import { markRouterDomain } from '../../config/openapiDomain.js';
import logger from '../../logging/logger.js';
import { getPublicPaymentLinkView } from '../../services/billing/paymentLinkService.js';

const router = markRouterDomain(express.Router(), 'billing');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function formatAmount(amount, currency) {
  const value = Number(amount);
  const text = Number.isFinite(value) ? value.toFixed(2) : '0.00';
  return currency === 'INR' ? `₹${text}` : `${currency} ${text}`;
}

// Dates are shown to a patient in India; keep it short and unambiguous.
function formatDate(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
  });
}

const STYLE = `
  *{box-sizing:border-box}
  body{margin:0;padding:24px 16px;background:#f4f6f8;color:#12212e;
       font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .panel{max-width:420px;margin:0 auto;background:#fff;border-radius:12px;
        border:1px solid #dfe5ea;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
  .hospital{font-size:14px;font-weight:600;color:#4a5b6a;letter-spacing:.02em;
            text-transform:uppercase;margin:0 0 20px}
  .label{font-size:13px;color:#5c6b7a;margin:0 0 4px}
  .amount{font-size:34px;font-weight:700;letter-spacing:-.02em;margin:0 0 20px}
  .ref{font-size:15px;margin:0 0 20px;padding-bottom:20px;border-bottom:1px solid #eceff2}
  .ref span{color:#5c6b7a}
  .btn{display:block;background:#0b6b3a;color:#fff;text-decoration:none;
       text-align:center;font-size:17px;font-weight:600;padding:15px 20px;
       border-radius:8px;margin:0 0 12px}
  .hint{font-size:13px;color:#5c6b7a;margin:0 0 4px}
  .note{margin:20px 0 0;padding:14px 16px;border-radius:8px;font-size:14px;
        background:#f0f4f7;color:#3a4a58}
  .note.good{background:#e8f5ed;color:#14512f}
  .note.warn{background:#fdf3e0;color:#6b4a10}
  .status{font-size:20px;font-weight:600;margin:0 0 10px}
`;

function page(title, bodyHtml) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style></head>
<body><div class="panel">${bodyHtml}</div></body></html>`;
}

// The ONE response for unknown, malformed, and otherwise unresolvable tokens.
// Keep it a constant: any per-token variation turns this into an oracle.
export const INVALID_LINK_PAGE = page('Payment link not valid', `
  <p class="status">This payment link is not valid</p>
  <p class="hint">The link may have been mistyped, or it may have been replaced by a newer one.</p>
  <div class="note">Please contact the hospital billing desk for a current payment link.</div>`);

const UNAVAILABLE_PAGE = page('Payment temporarily unavailable', `
  <p class="status">We can’t load this payment link right now</p>
  <p class="hint">This is a temporary problem on our side.</p>
  <div class="note">Please try again in a few minutes, or contact the hospital billing desk.</div>`);

/**
 * Render the page for a resolved link view. Pure: the ONLY patient-visible
 * fields are the ones getPublicPaymentLinkView() allowlists.
 */
export function renderPaymentPage(view) {
  const hospital = `<p class="hospital">${escapeHtml(view.hospitalName)}</p>`;
  const amount = formatAmount(view.amount, view.currency);
  const reference = view.invoiceReference
    ? `<p class="ref"><span>Invoice</span> ${escapeHtml(view.invoiceReference)}</p>`
    : `<p class="ref"><span>Advance payment</span></p>`;

  if (view.state === 'payable') {
    const expiry = formatDate(view.expiresAt);
    return page(`Pay ${amount}`, `${hospital}
  <p class="label">Amount due</p>
  <p class="amount">${escapeHtml(amount)}</p>
  ${reference}
  ${view.upiDeepLink
    ? `<a class="btn" href="${escapeHtml(view.upiDeepLink)}">Pay by UPI</a>
  <p class="hint">Opens your UPI app (GPay, PhonePe, Paytm and others).</p>`
    : `<div class="note warn">A UPI payment option is not available for this link.
       Please pay at the hospital billing counter.</div>`}
  ${expiry ? `<p class="hint">This link is valid until ${escapeHtml(expiry)}.</p>` : ''}
  <div class="note">After you pay, the hospital billing desk confirms the payment
  against its bank records — this can take a little time. Please keep your UPI
  reference number until the bill shows as paid.</div>`);
  }

  if (view.state === 'paid') {
    const paidOn = formatDate(view.paidAt);
    return page('Bill already paid', `${hospital}
  <p class="status">This bill has already been paid</p>
  ${reference}
  <p class="label">Amount</p>
  <p class="amount">${escapeHtml(amount)}</p>
  <div class="note good">No further payment is due${paidOn ? ` — recorded on ${escapeHtml(paidOn)}` : ''}.</div>`);
  }

  if (view.state === 'expired') {
    return page('Payment link expired', `${hospital}
  <p class="status">This payment link has expired</p>
  ${reference}
  <div class="note warn">Please contact the hospital billing desk for a new payment
  link, or pay at the billing counter.</div>`);
  }

  if (view.state === 'cancelled') {
    return page('Payment link cancelled', `${hospital}
  <p class="status">This payment link has been cancelled</p>
  ${reference}
  <div class="note warn">Please contact the hospital billing desk if you still need
  to pay this bill.</div>`);
  }

  // 'unavailable' — a status this page has no truthful presentation for.
  return page('Payment link unavailable', `${hospital}
  <p class="status">This payment link cannot be used</p>
  ${reference}
  <div class="note warn">Please contact the hospital billing desk.</div>`);
}

function sendPage(res, status, html) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Payment state changes; never let a proxy or the browser serve a stale
  // "unpaid" (or "paid") page. The URL also carries a bearer token.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  return res.status(status).send(html);
}

// GET /:token — mounted at /pay, so the served path is /pay/:token.
router.get('/:token', async (req, res) => {
  let view;
  try {
    view = await getPublicPaymentLinkView({ link_token: req.params.token });
  } catch (err) {
    // Never surface err.message, and never render a JSON envelope at a browser.
    // Note the token is deliberately absent from this log line.
    logger.error('Public payment page lookup failed', { error: err.message });
    return sendPage(res, 503, UNAVAILABLE_PAGE);
  }

  if (!view) return sendPage(res, 404, INVALID_LINK_PAGE);
  return sendPage(res, 200, renderPaymentPage(view));
});

export default router;
