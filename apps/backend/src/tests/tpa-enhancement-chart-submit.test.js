// Regression test for finding
// 2026-05-20-tpa-insurance-claim-doctor-391174a0
//
// A treating doctor can open a mid-stay TPA enhancement draft from the
// patient chart (POST /api/v1/admissions/:admissionId/tpa-enhancement),
// but the two endpoints needed to FINISH that workflow — fetch the
// justification template and submit the pre-auth — lived only under
// /api/v1/insurance/*, which is mounted behind
// requireRole('ADMIN','SUPER_ADMIN','BILLING_STAFF','INSURANCE_COORDINATOR').
// A DOCTOR therefore hit a 403 at the mount and could never submit the
// enhancement they had just drafted.
//
// The fix exposes a `GET /template` and `POST /:preauthId/submit` pair on
// the clinician-gated chart router (admissionEnhancementRoutes, mounted at
// /api/v1/admissions/:admissionId/tpa-enhancement with the clinical roles
// allowed), with an admission-ownership guard on submit so a clinician on
// one admission cannot submit another admission's pre-auth.

import { authClient } from './testClient.js';
import prisma from '../lib/prisma.js';
import * as claims from '../services/insurance/claimsService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'f1111111-1111-4111-8111-aaaaaaaa3901';
const ADMISSION_ID = 990391; // synthetic; the submit guard reads preauth.admission_id, no FK join needed

describe('Chart-shaped TPA enhancement — doctor can fetch template + reach submit (391174a0)', () => {
  const doctor = authClient('DOCTOR');
  let policyId;
  let strayPreauthId; // a pre-auth that does NOT belong to ADMISSION_ID

  beforeAll(async () => {
    const policyRows = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_policies
         (patient_uid, policy_number, status, tenant_id)
       VALUES ($1::uuid, $2, 'active', $3::uuid)
       RETURNING id`,
      PATIENT_UID,
      `POL-ENH-${Date.now() % 100000}`,
      TENANT,
    );
    policyId = policyRows[0].id;

    // A pre-auth with no admission link — used to prove the ownership
    // guard fires (its admission_id will not equal ADMISSION_ID) while
    // still being a real, fetchable row (so getPreauth does not 404).
    const stray = await claims.createPreauth({
      tenantId: TENANT,
      policy_id: policyId,
      patient_uid: PATIENT_UID,
      admission_id: null,
      request_type: 'planned',
      primary_diagnosis: 'Unrelated admission pre-auth',
      expected_cost: 25000,
    });
    strayPreauthId = stray.id;
  });

  afterAll(async () => {
    if (strayPreauthId) {
      await prisma
        .$executeRawUnsafe(`DELETE FROM insurance_preauth WHERE id = $1::int`, strayPreauthId)
        .catch(() => {});
    }
    if (policyId) {
      await prisma
        .$executeRawUnsafe(`DELETE FROM insurance_policies WHERE id = $1::int`, policyId)
        .catch(() => {});
    }
    await prisma.$disconnect().catch(() => {});
  });

  it('lets a DOCTOR fetch the enhancement justification template from the chart', async () => {
    const res = await doctor.get(
      `/api/v1/admissions/${ADMISSION_ID}/tpa-enhancement/template`,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.version).toBe(1);
    expect(res.body.data.title).toMatch(/enhancement/i);
    expect(Array.isArray(res.body.data.fields)).toBe(true);
    expect(res.body.data.fields[0].key).toBe('clinical_reason');
  });

  it('blocks a non-clinical role (PATIENT) at the mount — RBAC boundary intact', async () => {
    const patient = authClient('PATIENT');
    const res = await patient.get(
      `/api/v1/admissions/${ADMISSION_ID}/tpa-enhancement/template`,
    );

    expect(res.statusCode).toBe(403);
  });

  it('lets a DOCTOR reach the submit handler (no longer 403) and enforces admission ownership', async () => {
    // The stray pre-auth exists but is not linked to ADMISSION_ID, so the
    // ownership guard returns 404. Critically this is NOT a 403 — the
    // doctor passed the mount-level RBAC and reached the chart handler,
    // which is exactly what 391174a0 was about.
    const res = await doctor.post(
      `/api/v1/admissions/${ADMISSION_ID}/tpa-enhancement/${strayPreauthId}/submit`,
    );

    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.message || '').toMatch(/does not belong to this admission/i);
  });

  it('returns 404 (not 403) when a DOCTOR submits a non-existent pre-auth', async () => {
    const res = await doctor.post(
      `/api/v1/admissions/${ADMISSION_ID}/tpa-enhancement/2000000000/submit`,
    );

    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
