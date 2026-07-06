// Swarm-port 83385ac0 — TPA discharge final-claim anchoring.
//
// markForDischarge Phase 1.5 auto-creates the final cashless claim. Two
// selection hazards, both hit by the swarm QA loop:
//   * a mid-stay preauth raised against a DIFFERENT policy (wrong payer /
//     second insurer) must not steal the final claim from the policy the
//     admission was actually admitted under (admissions.policy_id);
//   * a newer-but-smaller interim invoice must not shrink the claim — the
//     final claim anchors to the largest live invoice, not the latest.
//
// Seeds two policies, an approved preauth on each (the wrong-payer one is an
// enhancement created later, which the pre-fix ordering preferred), and two
// issued invoices (larger one older). Asserts the auto-created final claim
// anchors to the admission's policy and the larger bill.

import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'b3333333-3333-4333-8333-83385ac00001';
const DOCTOR_UID = 'b3333333-3333-4333-8333-83385ac00002';
const ADMIN_UID = 'b3333333-3333-4333-8333-83385ac00003';
const API_KEY = process.env.API_KEY || 'test-api-key';
const STAMP = String(Date.now() % 100000).padStart(5, '0');

function mkClient(role, uid, intId) {
  const token = generateTestToken(role, { uid, id: intId });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: (p) => request(app).put(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

describe('TPA discharge final-claim selection (swarm-port 83385ac0)', () => {
  let admin;
  let wardId;
  let bedId;
  let admissionId;
  let admitPolicyId;
  let wrongPayerPolicyId;
  let approvedAdmitPreauthId;

  async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM tpa_claims WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM insurance_preauth WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM discharge_summaries WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM insurance_policies WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM beds WHERE bed_number = 'TPA-ANCHOR-BED'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM wards WHERE name = 'TPA-ANCHOR-WARD'`).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID, DOCTOR_UID, ADMIN_UID).catch(() => {});
  }

  beforeAll(async () => {
    await cleanup();
    admin = mkClient('ADMIN', ADMIN_UID, 990083);

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES
         ($1::uuid, '9000083001', 'TPA Anchor Patient', 'PATIENT', true, NOW()),
         ($2::uuid, '9000083002', 'TPA Anchor Doctor', 'DOCTOR', true, NOW()),
         ($3::uuid, '9000083003', 'TPA Anchor Admin', 'ADMIN', true, NOW())`,
      PATIENT_UID, DOCTOR_UID, ADMIN_UID);

    const policies = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_policies (patient_uid, policy_number, status, tenant_id)
       VALUES
         ($1::uuid, $2, 'active', $4::uuid),
         ($1::uuid, $3, 'active', $4::uuid)
       RETURNING id, policy_number`,
      PATIENT_UID, `NIA-ANCHOR-${STAMP}`, `STAR-WRONG-${STAMP}`, TENANT);
    admitPolicyId = policies.find((p) => p.policy_number.startsWith('NIA')).id;
    wrongPayerPolicyId = policies.find((p) => p.policy_number.startsWith('STAR')).id;

    const wardRows = await prisma.$queryRawUnsafe(
      `INSERT INTO wards
         (name, floor, total_beds, attendant_pass_color, attendant_pass_screening_level)
       VALUES ('TPA-ANCHOR-WARD', 3, 1, 'green', 'standard')
       RETURNING id`);
    wardId = wardRows[0].id;
    const bedRows = await prisma.$queryRawUnsafe(
      `INSERT INTO beds (ward_id, ward_name, bed_number, status)
       VALUES ($1, 'TPA-ANCHOR-WARD', 'TPA-ANCHOR-BED', 'available') RETURNING id`,
      wardId);
    bedId = bedRows[0].id;

    // Real API admit so the admission carries encounter/canonical rows and
    // policy_id resolves from the raw policy_number (existing behavior).
    const res = await admin.post('/api/v1/emr/admit').send({
      patient_uid: PATIENT_UID,
      admitting_doctor: DOCTOR_UID,
      chief_complaint: 'Cashless cataract surgery workup',
      admitting_diagnosis: 'Dense cataract, planned phaco',
      admission_type: 'emergency',
      priority: 'urgent',
      bed_id: bedId,
      policy_number: `NIA-ANCHOR-${STAMP}`,
      estimated_cost: 80000,
      emergency_consent_bypass_reason: 'Test — TPA anchoring fixture',
    });
    expect(res.statusCode).toBe(201);
    admissionId = res.body.data.admission.id;

    // Approved preauth on the admission's policy (older) + an approved
    // wrong-payer enhancement (newer). The pre-fix ordering — approved
    // first, enhancement first, newest first — picked the wrong payer.
    const preauths = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_preauth
         (policy_id, patient_uid, admission_id, preauth_number, request_type,
          primary_diagnosis, expected_cost, status, sanctioned_amount, tenant_id, created_at)
       VALUES
         ($1::int, $3::uuid, $4::int, $5, 'planned',
          'Cashless cataract surgery', 80000, 'approved', 78000, $7::uuid, NOW() - INTERVAL '2 days'),
         ($2::int, $3::uuid, $4::int, $6, 'enhancement',
          'Wrong payer enhancement', 65000, 'approved', 65000, $7::uuid, NOW() - INTERVAL '1 day')
       RETURNING id, policy_id`,
      admitPolicyId, wrongPayerPolicyId, PATIENT_UID, admissionId,
      `PA-NIA-${STAMP}`, `PA-STAR-${STAMP}`, TENANT);
    approvedAdmitPreauthId = preauths.find((p) => Number(p.policy_id) === Number(admitPolicyId)).id;

    // Larger final bill issued BEFORE a smaller interim invoice. The pre-fix
    // ordering (latest issued_at) picked the smaller one.
    await prisma.$executeRawUnsafe(
      `INSERT INTO billing_invoices
         (invoice_number, patient_uid, admission_id, invoice_type,
          subtotal, total_amount, amount_paid, amount_due, status, tenant_id, issued_at, created_at)
       VALUES
         ($1, $3::uuid, $4::int, 'final', 80000, 80000, 0, 80000, 'ISSUED', $5::uuid,
          NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours'),
         ($2, $3::uuid, $4::int, 'final', 65000, 65000, 0, 65000, 'ISSUED', $5::uuid,
          NOW(), NOW())`,
      `INV-ANCHOR-${STAMP}-A`, `INV-ANCHOR-${STAMP}-B`, PATIENT_UID, admissionId, TENANT);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('anchors the auto-created final claim to the admission policy and the largest live invoice', async () => {
    const res = await admin.post(`/api/v1/emr/${admissionId}/mark-for-discharge`).send({});
    expect(res.statusCode).toBe(201);

    const claims = await prisma.$queryRawUnsafe(
      `SELECT policy_id, preauth_id, invoice_id, total_billed, claimed_amount, stage, claim_type
         FROM tpa_claims
        WHERE admission_id = $1::int AND stage = 'final' AND status <> 'cancelled'
        ORDER BY id DESC`,
      Number(admissionId));
    expect(claims).toHaveLength(1);
    const claim = claims[0];
    expect(Number(claim.policy_id)).toBe(Number(admitPolicyId));
    expect(Number(claim.preauth_id)).toBe(Number(approvedAdmitPreauthId));
    expect(Number(claim.total_billed)).toBe(80000);
    expect(Number(claim.claimed_amount)).toBe(80000);
    expect(claim.claim_type).toBe('cashless');

    const invoice = await prisma.$queryRawUnsafe(
      `SELECT invoice_number, total_amount FROM billing_invoices WHERE id = $1::int`,
      claim.invoice_id);
    expect(Number(invoice[0].total_amount)).toBe(80000);
    expect(invoice[0].invoice_number).toBe(`INV-ANCHOR-${STAMP}-A`);
  });
});
