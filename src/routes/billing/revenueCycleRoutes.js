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

const router = express.Router();

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
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
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
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
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

export default router;
