// src/routes/billing/gstEInvoiceRoutes.js — G2 (reaudit 2026-08-25)
//
// GST e-invoicing (IRN/IRP) + Tally/GL accounting export. Dark-gated in the
// service layer: env off → 503 GST_EINVOICE_NOT_ENABLED, tenant off → 403
// GST_EINVOICE_DISABLED. Mounted BEFORE the generic /api/v1/billing mounts so
// their role gates cannot shadow this surface.

import { Router } from 'express';
import * as irn from '../../services/billing/gstEInvoiceService.js';
import * as tally from '../../services/billing/tallyExportService.js';
import { success, relayAppError } from '../../utils/responseHelper.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { markRouterDomain } from '../../config/openapiDomain.js';

const router = markRouterDomain(Router(), 'gst-einvoice');

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function wrap(handler) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      return relayAppError(res, err, 'GST e-invoice error');
    }
  };
}

// ── IRN / IRP ────────────────────────────────────────────────────────────
router.post('/invoices/:invoiceId/irn', wrap(async (req) =>
  irn.generateIrn({
    tenantId: tenantOf(req),
    invoiceId: req.params.invoiceId,
    actorUid: req.user?.uid,
    buyerGstin: req.body?.buyer_gstin || null,
  })));

router.get('/invoices/:invoiceId/irn', wrap(async (req) =>
  irn.getEInvoice({ tenantId: tenantOf(req), invoiceId: req.params.invoiceId })));

router.post('/invoices/:invoiceId/irn/cancel', wrap(async (req) =>
  irn.cancelIrn({
    tenantId: tenantOf(req),
    invoiceId: req.params.invoiceId,
    reason: req.body?.reason,
    actorUid: req.user?.uid,
  })));

router.get('/einvoices', wrap(async (req) =>
  irn.listEInvoices({
    tenantId: tenantOf(req),
    status: req.query.status,
    from: req.query.from,
    to: req.query.to,
    limit: req.query.limit,
  })));

// ── Tally / GL accounting export (self-contained, no creds) ────────────────
router.get('/export/tally', wrap(async (req) =>
  tally.exportTallyXml({
    tenantId: tenantOf(req),
    from: req.query.from || null,
    to: req.query.to || null,
  })));

router.get('/export/gl', wrap(async (req) =>
  tally.exportGlCsv({
    tenantId: tenantOf(req),
    from: req.query.from || null,
    to: req.query.to || null,
  })));

export default router;
