// Regression test for finding
// 2026-05-22-discharge-tpa-patient-claim-paid-without-evidence-1a29da94.
//
// The patient TPA claim screen (GET /portal/tpa/claims/:id) used to
// surface only `tpa_paid`, which is the insurer → hospital settlement.
// The patient app rendered that field under a "You paid" header, so a
// patient who had paid nothing themselves still saw a large "You paid"
// amount with no per-transaction evidence to back it up — a real
// integrity problem on a cashless bill where the patient owes only the
// non-payable / disallowed residual.
//
// The fix adds two server-side surfaces:
//   summary.patient_paid       — sum of the patient's own non-INSURANCE,
//                                non-reversed payments on the linked
//                                invoice (cash/UPI/card/netbanking).
//   summary.patient_amount_due — max(0, patient_responsibility −
//                                       patient_paid).
//   patient_payments[]         — auditable per-transaction list backing
//                                patient_paid (mode/reference/amount/
//                                collected_at/reversed). INSURANCE rows
//                                are stripped — they're TPA settlement,
//                                not patient payments.
//
// Asserted scenarios:
//   * Cash patient pays 5,500 in two installments + the TPA settles
//     78,000 via INSURANCE mode + one earlier 1,000 cash entry is
//     reversed. Expected: patient_paid = 5,500 (not 6,500, not 83,500).
//   * patient_amount_due = max(0, patient_responsibility −
//                                  patient_paid) = 0 (fully paid).
//   * patient_payments only lists non-INSURANCE rows including the
//     reversed one (flagged) so the patient can see the void.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const PATIENT_UID = 'f7777777-7777-4777-8777-aaaaaaaa7707';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const stamp = Date.now() % 100000;
const POLICY_NUMBER = `POL-PAIDEV-${stamp}`;
const CLAIM_NUMBER = `CL-PAIDEV-${stamp}`;
const INVOICE_NUMBER = `INV-PAIDEV-${stamp}`;

describe('GET /portal/tpa/claims/:id — patient paid evidence (D70)', () => {
  let policyId;
  let claimId;
  let invoiceId;
  const admissionId = 940200 + (Date.now() % 10000);
  let patientToken;

  beforeAll(async () => {
    const userRows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'Patient Paid Evidence', 'PATIENT', true, NOW())
       ON CONFLICT (uid) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      PATIENT_UID,
      `9888${stamp.toString().padStart(6, '0')}`.slice(0, 10),
    );
    const userId = userRows[0].id;

    const policyRows = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_policies
         (patient_uid, policy_number, policyholder_name, policy_type,
          status, tenant_id)
       VALUES ($1::uuid, $2, 'Patient Paid Evidence', 'individual',
               'active', $3::uuid)
       RETURNING id`,
      PATIENT_UID, POLICY_NUMBER, TENANT_ID,
    );
    policyId = policyRows[0].id;

    const invoiceRows = await prisma.$queryRawUnsafe(
      `INSERT INTO billing_invoices
         (invoice_number, patient_uid, admission_id, invoice_type,
          subtotal, total_amount, amount_paid, amount_due, status, tenant_id)
       VALUES ($1, $2::uuid, $3::int, 'room_charge',
               83500, 83500, 83500, 0, 'PAID', $4::uuid)
       RETURNING id`,
      INVOICE_NUMBER, PATIENT_UID, admissionId, TENANT_ID,
    );
    invoiceId = invoiceRows[0].id;

    // Patient's own settled payments: 4,500 cash + 1,000 UPI = 5,500.
    await prisma.$executeRawUnsafe(
      `INSERT INTO billing_payments
         (invoice_id, patient_uid, amount, mode, reference, collected_at, reversed, tenant_id)
       VALUES ($1::int, $2::uuid, 4500, 'CASH', 'RCPT-001', NOW() - INTERVAL '2 days', false, $3::uuid),
              ($1::int, $2::uuid, 1000, 'UPI',  'UPI-XYZ',  NOW() - INTERVAL '1 day',  false, $3::uuid)`,
      invoiceId, PATIENT_UID, TENANT_ID,
    );
    // Reversed earlier cash entry — must NOT count toward patient_paid.
    await prisma.$executeRawUnsafe(
      `INSERT INTO billing_payments
         (invoice_id, patient_uid, amount, mode, reference, collected_at, reversed, tenant_id)
       VALUES ($1::int, $2::uuid, 1000, 'CASH', 'RCPT-VOID', NOW() - INTERVAL '3 days', true, $3::uuid)`,
      invoiceId, PATIENT_UID, TENANT_ID,
    );
    // TPA settlement booked as an INSURANCE-mode payment — must NOT
    // count toward patient_paid either, even though it touches the
    // same invoice.
    await prisma.$executeRawUnsafe(
      `INSERT INTO billing_payments
         (invoice_id, patient_uid, amount, mode, reference, collected_at, reversed, tenant_id)
       VALUES ($1::int, $2::uuid, 78000, 'INSURANCE', 'TPA-SETTLE-1', NOW(), false, $3::uuid)`,
      invoiceId, PATIENT_UID, TENANT_ID,
    );

    const claimRows = await prisma.$queryRawUnsafe(
      `INSERT INTO tpa_claims
         (claim_number, policy_id, patient_uid, claim_type,
          total_billed, patient_copay, non_payable_amount,
          claimed_amount, approved_amount, paid_amount, disallowed_amount,
          status, admission_id, invoice_id, tenant_id)
       VALUES ($1, $2::int, $3::uuid, 'cashless',
               83500, 0, 3500, 80000, 80000, 78000, 2000,
               'settled_partial', $4::int, $5::int, $6::uuid)
       RETURNING id`,
      CLAIM_NUMBER, policyId, PATIENT_UID, admissionId, invoiceId, TENANT_ID,
    );
    claimId = claimRows[0].id;

    patientToken = generateTestToken('PATIENT', { uid: PATIENT_UID, id: userId });
  });

  afterAll(async () => {
    if (claimId) {
      await prisma
        .$executeRawUnsafe(`DELETE FROM tpa_claims WHERE id = $1::int`, claimId)
        .catch(() => {});
    }
    if (invoiceId) {
      await prisma
        .$executeRawUnsafe(`DELETE FROM billing_payments WHERE invoice_id = $1::int`, invoiceId)
        .catch(() => {});
      await prisma
        .$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = $1::int`, invoiceId)
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

  it('returns patient_paid that excludes INSURANCE + reversed payments', async () => {
    const res = await request(app)
      .get(`/api/v1/portal/tpa/claims/${claimId}`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${patientToken}`);

    expect(res.statusCode).toBe(200);
    // patient_paid is the 4,500 cash + 1,000 UPI = 5,500. NOT 6,500
    // (the reversed 1,000 must drop) and NOT 83,500 (the INSURANCE
    // 78,000 must NOT count as "You paid").
    expect(res.body.data.summary.patient_paid).toBe(5500);
    expect(res.body.data.summary.tpa_paid).toBe(78000); // unchanged
    // patient_responsibility = non_payable + disallowed + copay = 5500.
    // patient_amount_due = max(0, 5500 − 5500) = 0.
    expect(res.body.data.summary.patient_amount_due).toBe(0);
    expect(res.body.data.summary.patient_responsibility).toBe(5500);
  });

  it('returns patient_payments evidence list (excludes INSURANCE, keeps reversed flagged)', async () => {
    const res = await request(app)
      .get(`/api/v1/portal/tpa/claims/${claimId}`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${patientToken}`);

    expect(res.statusCode).toBe(200);
    const payments = res.body.data.patient_payments;
    expect(Array.isArray(payments)).toBe(true);
    // Three non-INSURANCE rows total: 4,500 + 1,000 + the reversed
    // 1,000. The INSURANCE 78,000 must be filtered out.
    expect(payments).toHaveLength(3);
    expect(payments.some((p) => String(p.mode).toUpperCase() === 'INSURANCE')).toBe(false);
    // The reversed entry must still appear (with reversed:true) so the
    // patient can audit the void rather than wondering where it went.
    const reversed = payments.find((p) => p.reversed === true);
    expect(reversed).toBeTruthy();
    expect(Number(reversed.amount)).toBe(1000);
    expect(String(reversed.mode).toUpperCase()).toBe('CASH');
    // Settled rows back the patient_paid total.
    const settled = payments
      .filter((p) => !p.reversed)
      .reduce((acc, p) => acc + Number(p.amount), 0);
    expect(settled).toBe(5500);
  });
});
