// src/routes/billing/revenueCycleRoutes.js
//
// Revenue-cycle foundations: ICD→CPT mapping lookups + denial dashboard feed.
// Full 837 EDI generation and pre-auth are flagged as follow-up in the
// backend ROADMAP under 3D — what's here is the admin-portal-ready data API.

import express from 'express';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';
import { build837P } from '../../services/billing/ediGenerator.js';
import { generateDenialRiskAssist } from '../../services/ai/clinicalAiWorkflowService.js';

const router = express.Router();

function parseLimit(value, fallback, max) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

const SUBMITTER = {
  name: process.env.EDI_SUBMITTER_NAME || 'VH HEALTH',
  id: process.env.EDI_SUBMITTER_ID || 'VHHEALTH01',
  contactName: process.env.EDI_SUBMITTER_CONTACT || 'BILLING DEPT',
  contactPhone: process.env.EDI_SUBMITTER_PHONE || '',
};
const BILLING_PROVIDER = {
  name: process.env.EDI_PROVIDER_NAME || 'VENKATAESWARA HOSPITAL',
  npi: process.env.EDI_PROVIDER_NPI || '0000000000',
  taxId: process.env.EDI_PROVIDER_TAXID || '00-0000000',
  address: {
    line1: process.env.EDI_PROVIDER_ADDR || '',
    city: process.env.EDI_PROVIDER_CITY || 'CHENNAI',
    state: process.env.EDI_PROVIDER_STATE || 'TN',
    postalCode: process.env.EDI_PROVIDER_POSTAL || '',
  },
};

/** GET /icd-cpt-map?icd10=X[&limit=50] — lookup billing codes by diagnosis. */
router.get('/icd-cpt-map', async (req, res) => {
  try {
    const icd = req.query.icd10;
    const limit = parseLimit(req.query.limit, 50, 200);
    const rows = icd
      ? await prisma.$queryRawUnsafe(
          `SELECT id, icd10_code, cpt_code, description, default_charge
             FROM icd_cpt_map
            WHERE icd10_code = $1
            LIMIT $2`,
          icd,
          limit,
        )
      : await prisma.$queryRawUnsafe(
          `SELECT id, icd10_code, cpt_code, description, default_charge
             FROM icd_cpt_map
            ORDER BY icd10_code ASC
            LIMIT $1`,
          limit,
        );
    return success(res, { items: rows, count: rows.length }, 'ICD/CPT map');
  } catch (err) {
    logger.error('icd-cpt-map error:', err);
    return error(res, 'Failed to load ICD/CPT map', 500);
  }
});

/** GET /denials/summary — aggregate denial reasons for the dashboard. */
router.get('/denials/summary', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(parseInt(req.query.days, 10) || 90, 365));
    const [overall] = await prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*)::int                               AS total,
         COALESCE(SUM(denied_amount), 0)::float      AS denied_total,
         COUNT(*) FILTER (WHERE appealed)::int       AS appealed,
         COUNT(*) FILTER (WHERE appeal_outcome = 'won')::int AS won
       FROM claim_denials
      WHERE denied_at >= NOW() - ($1 || ' days')::interval`,
      String(days),
    );

    const byReason = await prisma.$queryRawUnsafe(
      `SELECT reason_code, COUNT(*)::int AS count, COALESCE(SUM(denied_amount), 0)::float AS amount
         FROM claim_denials
        WHERE denied_at >= NOW() - ($1 || ' days')::interval
        GROUP BY reason_code
        ORDER BY count DESC
        LIMIT 20`,
      String(days),
    );

    return success(res, {
      windowDays: days,
      overall,
      byReason,
    }, 'Denial summary');
  } catch (err) {
    logger.error('denial summary error:', err);
    return error(res, 'Failed to load denial summary', 500);
  }
});

/** GET /denials — paginated recent denials. */
router.get('/denials', async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, 50, 200);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT d.id, d.invoice_id, d.payer, d.reason_code, d.reason_text,
              d.denied_amount, d.appealed, d.appeal_outcome, d.denied_at
         FROM claim_denials d
        ORDER BY d.denied_at DESC
        LIMIT $1`,
      limit,
    );
    return success(res, { items: rows, count: rows.length }, 'Recent denials');
  } catch (err) {
    logger.error('denials list error:', err);
    return error(res, 'Failed to list denials', 500);
  }
});

/**
 * GET /ar-aging — accounts receivable aging across both invoice tables.
 *
 * Unifies the legacy `invoices` surface (OPD/walk-in path, schema 5333)
 * with `billing_invoices` (Sprint 4+ IPD billing, schema 8903 — used
 * by every cashless TPA admission). Without the v2 side, IPD
 * receivables awaiting TPA settlement — the bulk of cashless volume,
 * 30-90 day pay cycles — are invisible to finance. See finding
 * 2026-05-09-tpa-insurance-claim-billing-ar-aging-blind-to-ipd.
 *
 * `source` ('legacy'|'v2') on each row disambiguates the two
 * SERIAL ids (both start at 1). `insurer_name` + `claim_reference`
 * are populated only on v2 rows that have a linked tpa_claims row.
 */
router.get('/ar-aging', async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, 25, 100);

    // Normalised open-invoice CTE: legacy `invoices`
    // (total_amount/paid_amount/payment_status/due_date) UNIONed with
    // `billing_invoices` (total_amount/amount_paid/status/no-due_date,
    // plus tpa_claims+policies+payers join for the insurer side).
    const baseCte = `
      WITH base AS (
        SELECT
          'legacy'::text AS source,
          i.id::int AS id,
          i.invoice_number,
          i.patient_uid,
          u.name AS patient_name,
          i.type AS invoice_type,
          i.total_amount::numeric AS total_amount,
          COALESCE(i.paid_amount, 0)::numeric AS paid_amount,
          (i.total_amount - COALESCE(i.paid_amount, 0))::numeric AS outstanding,
          GREATEST(CURRENT_DATE - COALESCE(i.due_date, i.issued_at::date), 0) AS age_days,
          i.issued_at,
          NULL::text AS insurer_name,
          NULL::text AS claim_reference
        FROM invoices i
        LEFT JOIN users u ON u.uid = i.patient_uid
        WHERE i.payment_status NOT IN ('paid', 'cancelled')
          AND (i.total_amount - COALESCE(i.paid_amount, 0)) > 0
        UNION ALL
        SELECT
          'v2'::text AS source,
          bi.id::int AS id,
          bi.invoice_number,
          bi.patient_uid,
          COALESCE(bi.patient_name, u.name) AS patient_name,
          bi.invoice_type,
          bi.total_amount::numeric AS total_amount,
          COALESCE(bi.amount_paid, 0)::numeric AS paid_amount,
          COALESCE(bi.amount_due, bi.total_amount - COALESCE(bi.amount_paid, 0))::numeric AS outstanding,
          GREATEST(CURRENT_DATE - COALESCE(bi.issued_at::date, bi.created_at::date), 0) AS age_days,
          bi.issued_at,
          tc_one.insurer_name,
          tc_one.claim_reference
        FROM billing_invoices bi
        LEFT JOIN users u ON u.uid = bi.patient_uid
        -- D21: Multiple tpa_claims pointing at the same invoice
        -- (initial + enhancement chain, or a re-filed claim) used to
        -- cartesian-multiply this row, inflating invoice_count and
        -- total_outstanding in the aggregations below. Collapse to
        -- one row per invoice by picking the LATEST tpa_claims row
        -- (highest id), and join policy/payer off that single row.
        -- Findings 8131f896 + 9c28990d.
        LEFT JOIN LATERAL (
          SELECT
            tc.claim_number AS claim_reference,
            p.display_name AS insurer_name
          FROM tpa_claims tc
          LEFT JOIN insurance_policies ipol ON ipol.id = tc.policy_id
          LEFT JOIN payers p ON p.id = ipol.payer_id
          WHERE tc.invoice_id = bi.id
          ORDER BY tc.id DESC
          LIMIT 1
        ) tc_one ON TRUE
        WHERE bi.status IN ('ISSUED', 'PARTIAL')
          AND bi.voided_at IS NULL
          AND COALESCE(bi.amount_due, bi.total_amount - COALESCE(bi.amount_paid, 0)) > 0
      )
    `;

    const [overall] = await prisma.$queryRawUnsafe(
      `${baseCte}
       SELECT
         COUNT(*)::int AS invoice_count,
         COALESCE(SUM(outstanding), 0)::float AS total_outstanding,
         COALESCE(MAX(age_days), 0)::int AS oldest_age_days
       FROM base`,
    );

    const buckets = await prisma.$queryRawUnsafe(
      `${baseCte}
       , bucketed AS (
         SELECT
           CASE
             WHEN age_days <= 30 THEN '0-30'
             WHEN age_days <= 60 THEN '31-60'
             WHEN age_days <= 90 THEN '61-90'
             ELSE '90+'
           END AS bucket,
           outstanding
         FROM base
       )
       SELECT
         bucket,
         COUNT(*)::int AS invoice_count,
         COALESCE(SUM(outstanding), 0)::float AS outstanding_amount
       FROM bucketed
       GROUP BY bucket
       ORDER BY CASE bucket WHEN '0-30' THEN 1 WHEN '31-60' THEN 2 WHEN '61-90' THEN 3 ELSE 4 END`,
    );

    const invoices = await prisma.$queryRawUnsafe(
      `${baseCte}
       SELECT
         source,
         id,
         invoice_number,
         patient_uid,
         patient_name,
         invoice_type AS type,
         total_amount::float,
         paid_amount::float,
         outstanding::float AS outstanding_amount,
         issued_at,
         age_days::int,
         insurer_name,
         claim_reference
       FROM base
       ORDER BY age_days DESC, outstanding DESC, issued_at ASC
       LIMIT $1`,
      limit,
    );

    return success(res, {
      as_of: new Date().toISOString(),
      overall,
      buckets,
      invoices,
    }, 'A/R aging summary');
  } catch (err) {
    logger.error('A/R aging error:', err);
    return error(res, 'Failed to load A/R aging', 500);
  }
});

/** GET /claim-queue — actionable insurance claims for billing follow-up. */
router.get('/claim-queue', async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, 50, 200);
    const statuses = String(
      req.query.status || 'submitted,under_review,partially_approved,rejected',
    )
      .split(',')
      .map((status) => status.trim())
      .filter(Boolean)
      .join(',');

    const summary = await prisma.$queryRawUnsafe(
      `SELECT
         status,
         COUNT(*)::int AS count,
         COALESCE(SUM(claim_amount), 0)::float AS claim_amount,
         COALESCE(SUM(claim_amount - COALESCE(approved_amount, 0)), 0)::float AS payer_balance
       FROM insurance_claims
       WHERE status = ANY(string_to_array($1, ','))
       GROUP BY status
       ORDER BY count DESC`,
      statuses,
    );

    const claims = await prisma.$queryRawUnsafe(
      `SELECT
         c.id,
         c.claim_number,
         c.patient_uid,
         u.name AS patient_name,
         c.invoice_id,
         i.invoice_number,
         c.insurance_provider,
         c.policy_number,
         c.claim_amount::float,
         c.approved_amount::float,
         (c.claim_amount - COALESCE(c.approved_amount, 0))::float AS payer_balance,
         c.status,
         c.submitted_at,
         c.reviewed_at,
         c.rejection_reason,
         GREATEST(CURRENT_DATE - c.submitted_at::date, 0)::int AS days_in_queue
       FROM insurance_claims c
       LEFT JOIN invoices i ON i.id = c.invoice_id
       LEFT JOIN users u ON u.uid = c.patient_uid
       WHERE c.status = ANY(string_to_array($1, ','))
       ORDER BY
         CASE c.status
           WHEN 'submitted' THEN 1
           WHEN 'under_review' THEN 2
           WHEN 'rejected' THEN 3
           WHEN 'partially_approved' THEN 4
           ELSE 5
         END,
         days_in_queue DESC,
         c.submitted_at ASC
       LIMIT $2`,
      statuses,
      limit,
    );

    return success(res, {
      statuses: statuses ? statuses.split(',') : [],
      summary,
      claims,
    }, 'Claim queue');
  } catch (err) {
    logger.error('claim queue error:', err);
    return error(res, 'Failed to load claim queue', 500);
  }
});

/**
 * GET /837/:invoiceId — generate an X12 837P claim file for a single invoice.
 *
 * Pulls the invoice, patient, and ICD/CPT data, builds the minimum-viable
 * 837P via ediGenerator, and returns it as application/edi-x12 so billing
 * staff can download the file for payer submission. Returns 404 if the
 * invoice or its patient can't be resolved. Payer-specific extensions and
 * validation against a given payer's companion guide are explicitly out of
 * scope — see the ROADMAP for follow-up.
 */
router.get('/837/:invoiceId', async (req, res) => {
  try {
    const invoiceId = parseInt(req.params.invoiceId, 10);
    if (!Number.isFinite(invoiceId)) return error(res, 'Invalid invoiceId', 400);

    const invoiceRows = await prisma.$queryRawUnsafe(
      `SELECT i.id, i.invoice_number, i.patient_uid, i.items, i.total_amount,
              i.issued_at, i.insurance_claim_id
         FROM invoices i WHERE i.id = $1`,
      invoiceId,
    );
    if (invoiceRows.length === 0) return error(res, 'Invoice not found', 404);
    const invoice = invoiceRows[0];

    const patientRows = await prisma.$queryRawUnsafe(
      `SELECT uid, name, gender, birthday, phone FROM users WHERE uid = $1::uuid`,
      invoice.patient_uid,
    );
    if (patientRows.length === 0) return error(res, 'Patient not found for invoice', 404);
    const patient = patientRows[0];

    // Parse invoice.items — expected to be [{ description, cpt?, icd10?, amount, units? }].
    const items = Array.isArray(invoice.items)
      ? invoice.items
      : (typeof invoice.items === 'string' ? JSON.parse(invoice.items) : []);

    const diagnoses = [];
    const services = [];
    for (const it of items) {
      if (it.icd10 && !diagnoses.find((d) => d.icd10 === it.icd10)) {
        diagnoses.push({ icd10: it.icd10 });
      }
      if (it.cpt) {
        services.push({
          cpt: it.cpt,
          charge: Number(it.amount) || 0,
          units: it.units ?? 1,
          diagnosisPointers: it.icd10
            ? [diagnoses.findIndex((d) => d.icd10 === it.icd10) + 1]
            : [1],
        });
      }
    }

    // Fallback: if invoice items don't carry CPTs, look up by the first ICD via icd_cpt_map.
    if (services.length === 0 && diagnoses.length > 0) {
      const mapRows = await prisma.$queryRawUnsafe(
        `SELECT cpt_code, default_charge FROM icd_cpt_map WHERE icd10_code = $1 LIMIT 1`,
        diagnoses[0].icd10,
      );
      if (mapRows.length > 0) {
        services.push({
          cpt: mapRows[0].cpt_code,
          charge: Number(mapRows[0].default_charge) || Number(invoice.total_amount) || 0,
          units: 1,
          diagnosisPointers: [1],
        });
      }
    }
    if (services.length === 0) {
      return error(res, 'Invoice has no service lines to bill (no CPT-coded items)', 422);
    }

    const [firstName, ...rest] = (patient.name || '').split(/\s+/);
    const lastName = rest.join(' ') || firstName;

    const edi = build837P({
      submitter: SUBMITTER,
      receiver: {
        name: req.query.payerName || 'DEFAULT PAYER',
        id: req.query.payerId || '00000',
      },
      billingProvider: BILLING_PROVIDER,
      subscriber: {
        firstName: firstName || 'PATIENT',
        lastName: lastName || 'UNKNOWN',
        memberId: String(invoice.insurance_claim_id || patient.phone || 'UNKNOWN'),
        dob: patient.birthday || new Date('1970-01-01'),
        gender: (patient.gender || 'U').slice(0, 1).toUpperCase(),
        payerId: req.query.payerId || '00000',
      },
      patient: null,
      claim: {
        id: invoice.invoice_number || invoice.id,
        total: Number(invoice.total_amount) || 0,
        serviceDate: invoice.issued_at,
        diagnoses,
        services,
      },
    });

    res.setHeader('Content-Type', 'application/edi-x12; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="claim-${invoice.invoice_number || invoice.id}.edi"`);
    return res.send(edi);
  } catch (err) {
    logger.error('837 generation error:', err);
    return error(res, 'Failed to generate 837 claim', 500);
  }
});

/**
 * POST /:claimId/denial-risk
 *   Runs the Clinical AI denial-risk module against an insurance claim.
 *   Returns a draft with citations + safety flags — never mutates the claim.
 *   Review/signoff is captured in clinical_ai_reviews.
 */
router.post('/:claimId/denial-risk', async (req, res, next) => {
  try {
    const draft = await generateDenialRiskAssist(req.params.claimId, req.user?.uid || null, req);
    return success(res, draft, 'Denial risk draft generated');
  } catch (err) {
    return next(err);
  }
});

export default router;
