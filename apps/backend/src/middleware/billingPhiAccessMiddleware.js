import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { logPhiAccess } from '../utils/hipaaAudit.js';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

function tenantOf(req) {
  return req.user?.tenant_id
    || req.user?.tenantId
    || req.tenantId
    || req.tenant?.id
    || DEFAULT_TENANT_ID;
}

function cleanId(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function actionFor(method) {
  switch (String(method || '').toUpperCase()) {
    case 'GET':
    case 'HEAD':
      return 'VIEW';
    case 'POST':
      return 'CREATE';
    case 'PUT':
    case 'PATCH':
      return 'UPDATE';
    case 'DELETE':
      return 'DELETE';
    default:
      return 'ACCESS';
  }
}

export function isBillingPhiPath(path) {
  const normalized = String(path || '').split('?')[0].toLowerCase();
  return normalized === '/invoices'
    || normalized.startsWith('/invoices/')
    || normalized === '/payments'
    || normalized.startsWith('/payments/')
    || normalized === '/payment-links'
    || normalized.startsWith('/payment-links/');
}

export function deriveBillingInvoiceId(req) {
  const queryOrBody = cleanId(req.body?.invoice_id)
    || cleanId(req.body?.invoiceId)
    || cleanId(req.query?.invoice_id)
    || cleanId(req.query?.invoiceId);
  if (queryOrBody) return queryOrBody;

  const routePath = String(req.url || req.originalUrl || '').split('?')[0];
  const invoiceMatch = routePath.match(/\/invoices\/(\d+)(?:\/|$)/i);
  return invoiceMatch?.[1] ?? null;
}

export async function resolveBillingPhiContext(req) {
  const directPatientUid = cleanId(req.body?.patient_uid)
    || cleanId(req.body?.patientUid)
    || cleanId(req.query?.patient_uid)
    || cleanId(req.query?.patientUid);
  const directAdmissionId = cleanId(req.body?.admission_id)
    || cleanId(req.body?.admissionId)
    || cleanId(req.query?.admission_id)
    || cleanId(req.query?.admissionId);
  const invoiceId = deriveBillingInvoiceId(req);

  if (directPatientUid && directAdmissionId) {
    return { patientUid: directPatientUid, admissionId: directAdmissionId, invoiceId };
  }

  if (!invoiceId || !/^\d+$/.test(String(invoiceId))) {
    return {
      patientUid: directPatientUid,
      admissionId: directAdmissionId,
      invoiceId: invoiceId || null,
    };
  }

  const rows = await prisma.$queryRawUnsafe(
    `SELECT patient_uid, admission_id
       FROM billing_invoices
      WHERE id = $1::int
        AND tenant_id = $2::uuid
      LIMIT 1`,
    Number(invoiceId),
    tenantOf(req),
  );
  const row = Array.isArray(rows) ? rows[0] : null;

  return {
    patientUid: directPatientUid || cleanId(row?.patient_uid),
    admissionId: directAdmissionId || cleanId(row?.admission_id),
    invoiceId,
  };
}

export function billingPhiAccessLogger(recordType = 'BILLING_INVOICE') {
  return (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      if (!isBillingPhiPath(req.url || req.originalUrl || '')) return;

      const actorUid = req.acting?.actorUid ?? req.user?.uid ?? null;
      const userId = actorUid || req.user?.id;
      if (!userId) return;

      setImmediate(async () => {
        try {
          const context = await resolveBillingPhiContext(req);
          logPhiAccess({
            userId: String(userId),
            userRole: req.acting?.actorRole ?? req.user?.role ?? 'UNKNOWN',
            patientId: context.patientUid || null,
            recordType,
            action: actionFor(req.method),
            ip: req.ip,
            requestId: req.id,
            actorUid,
            subjectUid: req.user?.uid ?? null,
            actingAsDependent: req.acting != null,
            deviceType: req.user?.deviceType ?? null,
          });
        } catch (err) {
          logger.warn('Billing PHI audit write failed', {
            path: req.originalUrl || req.url,
            method: req.method,
            error: err?.message,
          });
        }
      });
    });

    next();
  };
}

export default billingPhiAccessLogger;
