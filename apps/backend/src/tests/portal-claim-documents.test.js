// Regression test for findings 95008441 + 0a3e84c3.
//
// `tpa_claim_documents` rows hold policy docs, prescription scans, and
// clinical-summary PDFs the hospital uploads to support a TPA claim.
// Patients had NO way to see what was submitted on their behalf:
// IRDAI transparency requires the patient sees the document packet,
// and patients needed copies for their own records post-settlement.
// The new endpoint `GET /portal/tpa/claims/:id/documents` returns
// only patient-visible metadata (no uploaded_by staff uuid, no
// internal review notes).
//
// Asserted:
//   * Owner sees the document metadata list.
//   * Another patient cannot list the same claim's documents (404).
//   * Internal columns (uploaded_by, notes) are NOT in the response.
//   * Documents attached to the parent preauth surface alongside
//     documents attached to the claim itself.
//   * Download URLs are issued only after the same ownership check,
//     expire quickly, and write an append-only audit row.

import crypto from 'crypto';
import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const PATIENT_UID = 'f9999999-9999-4999-8999-aaaaaaaa9909';
const OTHER_UID = 'f9999999-9999-4999-8999-bbbbbbbbbb09';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const STAMP = String(Date.now() % 100000).padStart(5, '0');
const POLICY_NUMBER = `POL-DOCS-${STAMP}`;
const CLAIM_NUMBER = `CL-DOCS-${STAMP}`;
const PREAUTH_NUMBER = `PA-DOCS-${STAMP}`;

describe('GET /portal/tpa/claims/:id/documents — patient document list (H D69)', () => {
  let claimId;
  let policyId;
  let preauthId;
  let claimDocumentId;
  let patientToken;
  let otherToken;
  const admissionId = 950500 + (Date.now() % 5000);

  function expiredStorageToken(key) {
    const secret = process.env.JWT_SECRET || 'test-jwt-secret';
    const expiryMs = Date.now() - 1000;
    const sig = crypto.createHmac('sha256', secret).update(`${key}|${expiryMs}`).digest('base64url');
    return `${sig}.${expiryMs}`;
  }

  beforeAll(async () => {
    const userRows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9700200099', 'D69 Patient', 'PATIENT', true, NOW())
       ON CONFLICT (uid) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      PATIENT_UID,
    );
    patientToken = generateTestToken('PATIENT', {
      uid: PATIENT_UID,
      id: userRows[0].id,
    });
    otherToken = generateTestToken('PATIENT', {
      uid: OTHER_UID,
      id: 9_700_299,
    });

    const policyRows = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_policies
         (patient_uid, policy_number, policyholder_name, policy_type,
          status, tenant_id)
       VALUES ($1::uuid, $2, 'D69 Patient', 'individual', 'active', $3::uuid)
       RETURNING id`,
      PATIENT_UID, POLICY_NUMBER, TENANT_ID,
    );
    policyId = policyRows[0].id;

    // Preauth row — supports the document linkage path where docs are
    // attached to the preauth (e.g. cashless approval letter) and the
    // claim picks them up via preauth_id. Required NOT NULL fields on
    // this DB shape: primary_diagnosis + expected_cost.
    const preauthRows = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_preauth
         (preauth_number, policy_id, patient_uid, admission_id,
          request_type, status, primary_diagnosis, expected_cost,
          tenant_id)
       VALUES ($1, $2::int, $3::uuid, $4::int,
               'planned', 'submitted', 'Pneumonia', 50000,
               $5::uuid)
       RETURNING id`,
      PREAUTH_NUMBER, policyId, PATIENT_UID, admissionId, TENANT_ID,
    );
    preauthId = preauthRows[0].id;

    const claimRows = await prisma.$queryRawUnsafe(
      `INSERT INTO tpa_claims
         (claim_number, policy_id, patient_uid, claim_type,
          total_billed, claimed_amount, approved_amount,
          status, admission_id, preauth_id, tenant_id)
       VALUES ($1, $2::int, $3::uuid, 'cashless',
               50000, 50000, 48000,
               'paid', $4::int, $5::int, $6::uuid)
       RETURNING id`,
      CLAIM_NUMBER, policyId, PATIENT_UID, admissionId, preauthId, TENANT_ID,
    );
    claimId = claimRows[0].id;

    // Three documents: 2 on the claim, 1 on the parent preauth — the
    // patient should see all three.
    const docRows = await prisma.$queryRawUnsafe(
      `INSERT INTO tpa_claim_documents
         (claim_id, preauth_id, doc_type, file_name, mime_type, file_size_bytes, file_url, uploaded_at, uploaded_by, notes)
       VALUES ($1::int, NULL, 'clinical_summary',  'clinical_summary.pdf',  'application/pdf', 12345, 'r2://docs/clin.pdf',  NOW() - INTERVAL '1 day', NULL, 'internal staff note A'),
              ($1::int, NULL, 'discharge_summary', 'discharge_summary.pdf', 'application/pdf', 23456, 'r2://docs/disch.pdf', NOW() - INTERVAL '2 hours', NULL, 'internal staff note B'),
              (NULL, $2::int, 'preauth_approval',  'preauth_letter.pdf',    'application/pdf', 5678,  'r2://docs/pa.pdf',    NOW() - INTERVAL '3 days', NULL, 'internal staff note C')
       RETURNING id, doc_type`,
      claimId, preauthId,
    );
    claimDocumentId = docRows.find((d) => d.doc_type === 'discharge_summary')?.id;
  });

  afterAll(async () => {
    if (claimId) {
      await prisma
        .$executeRawUnsafe(`DELETE FROM tpa_claim_documents WHERE claim_id = $1::int OR preauth_id = $2::int`, claimId, preauthId)
        .catch(() => {});
      await prisma
        .$executeRawUnsafe(`DELETE FROM tpa_claims WHERE id = $1::int`, claimId)
        .catch(() => {});
    }
    if (preauthId) {
      await prisma
        .$executeRawUnsafe(`DELETE FROM insurance_preauth WHERE id = $1::int`, preauthId)
        .catch(() => {});
    }
    if (policyId) {
      await prisma
        .$executeRawUnsafe(`DELETE FROM insurance_policies WHERE id = $1::int`, policyId)
        .catch(() => {});
    }
    await prisma
      .$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT_UID)
      .catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('returns the owner-patient document list with claim + preauth docs', async () => {
    const res = await request(app)
      .get(`/api/v1/portal/tpa/claims/${claimId}/documents`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${patientToken}`);

    expect(res.statusCode).toBe(200);
    const docs = res.body.data;
    expect(Array.isArray(docs)).toBe(true);
    // All three docs visible (2 on claim + 1 on parent preauth).
    expect(docs.length).toBe(3);
    const docTypes = docs.map((d) => d.doc_type).sort();
    expect(docTypes).toEqual(['clinical_summary', 'discharge_summary', 'preauth_approval']);
  });

  it('strips internal-only columns from the response (no uploaded_by, no notes)', async () => {
    const res = await request(app)
      .get(`/api/v1/portal/tpa/claims/${claimId}/documents`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${patientToken}`);
    expect(res.statusCode).toBe(200);
    for (const d of res.body.data) {
      // Internal staff fields must NOT leak to the patient surface.
      expect(d).not.toHaveProperty('uploaded_by');
      expect(d).not.toHaveProperty('notes');
      // Patient-visible fields ARE present.
      expect(d).toHaveProperty('doc_type');
      expect(d).toHaveProperty('file_name');
      expect(d).toHaveProperty('mime_type');
      expect(d).toHaveProperty('uploaded_at');
    }
  });

  it('returns 404 for another patient (no leak)', async () => {
    const res = await request(app)
      .get(`/api/v1/portal/tpa/claims/${claimId}/documents`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(res.statusCode).toBe(404);
  });

  it('issues a short-lived signed download URL for the owner and writes an audit row', async () => {
    const res = await request(app)
      .get(`/api/v1/portal/tpa/claims/${claimId}/documents/${claimDocumentId}/download-url`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${patientToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.expires_in_seconds).toBeLessThanOrEqual(300);
    expect(res.body.data.url).toContain('/api/v1/storage/file/docs/disch.pdf?token=');
    expect(res.body.data.document).toEqual(expect.objectContaining({
      id: claimDocumentId,
      claim_id: claimId,
      doc_type: 'discharge_summary',
      file_name: 'discharge_summary.pdf',
    }));
    expect(res.body.data.document).not.toHaveProperty('file_url');

    const audit = await prisma.$queryRawUnsafe(
      `SELECT action, metadata
         FROM clinical_audit_events
        WHERE patient_uid = $1::uuid
          AND resource_table = 'tpa_claim_documents'
          AND resource_id = $2
          AND action = 'portal.tpa_claim_document_download_url_issued'
        ORDER BY occurred_at DESC
        LIMIT 1`,
      PATIENT_UID, String(claimDocumentId),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toEqual(expect.objectContaining({
      claim_id: claimId,
      doc_type: 'discharge_summary',
      expires_in_seconds: 300,
    }));
  });

  it('returns 404 when another patient requests a document download URL', async () => {
    const res = await request(app)
      .get(`/api/v1/portal/tpa/claims/${claimId}/documents/${claimDocumentId}/download-url`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.statusCode).toBe(404);
    expect(res.body.data).toBeUndefined();
  });

  it('rejects an expired local signed storage URL', async () => {
    const token = expiredStorageToken('docs/disch.pdf');
    const res = await request(app)
      .get(`/api/v1/storage/file/docs/disch.pdf?token=${encodeURIComponent(token)}`);

    expect(res.statusCode).toBe(403);
    expect(res.body.message).toBe('Invalid or expired token');
  });
});
