// Regression test for the DEFERRED half of finding cluster
// 2026-05-20-tpa-insurance-claim-billing-4600ed9c (cover-exceeded) and
// 2026-05-22-tpa-insurance-claim-billing-b5906e90 (room-cap liability).
//
// #154 added the HARD guards on the TPA claim path (claimed_amount must
// not exceed total_billed; approved/paid must not exceed claimed). Those
// stay intact and are re-asserted here. What this suite covers is the
// NON-BLOCKING advisory layer added on top:
//
//   1. When a claim's claimed_amount exceeds the cumulative SANCTIONED
//      COVER of its linked pre-auth chain (preauth + approved enhancements),
//      createClaim/getClaimBundle attach a non-blocking
//      CLAIM_EXCEEDS_SANCTIONED_COVER warning that directs the coordinator
//      to file an enhancement — the claim still succeeds (a final bill
//      legitimately exceeding pre-auth cover is exactly when an enhancement
//      is filed).
//   2. When the insurer's partial approval capped the room category and the
//      billed room charges exceed the cap, a non-blocking
//      CLAIM_ROOM_CHARGES_EXCEED_CAP warning flags the excess as
//      patient-payable. Creation still succeeds, but final submission
//      now requires payment evidence or explicit liability consent.
//
// Runs against the live QA Postgres (127.0.0.1:55432) like the other TPA
// flow suites. Seeds a real preauth chain + responses + invoice so the
// cumulative-cover and caps sourcing exercise the actual SQL.

import prisma from '../lib/prisma.js';
import * as claims from '../services/insurance/claimsService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'f4444444-4444-4444-8444-dddddddd6601';

const createdClaimIds = [];
const createdInvoiceIds = [];
const createdPreauthIds = [];
const createdAdmissionIds = [];
const createdSummaryIds = [];
const createdPaymentIds = [];
const createdConsentIds = [];
let policyId;

async function seedIssuedInvoice({ total, admissionId, roomRent = 0 }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO billing_invoices
       (invoice_number, patient_uid, admission_id, invoice_type,
        subtotal, total_amount, amount_paid, amount_due, status, tenant_id)
     VALUES ($1, $2::uuid, $3::int, 'final',
             $4::numeric, $4::numeric, 0, $4::numeric, 'ISSUED', $5::uuid)
     RETURNING id`,
    `INV-COVER-${Date.now() % 100000}-${createdInvoiceIds.length}`,
    PATIENT_UID, admissionId, total, TENANT,
  );
  const invoiceId = rows[0].id;
  createdInvoiceIds.push(invoiceId);
  if (roomRent > 0) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO billing_invoice_items
         (invoice_id, category, description, quantity, unit_price,
          gst_rate, line_subtotal, cgst_amount, sgst_amount, igst_amount, line_total,
          source_ref_type, source_ref_id)
       VALUES ($1::int, 'room_rent', 'Room rent', 1, $2::numeric,
               0, $2::numeric, 0, 0, 0, $2::numeric,
               'room_day', $3::int)`,
      invoiceId, roomRent, admissionId,
    );
  }
  return invoiceId;
}

async function seedAdmission({ admissionId, roomCategory = 'private' }) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO admissions (id, patient_uid, room_category, tenant_id)
     VALUES ($1::int, $2::uuid, $3, $4::uuid)
     ON CONFLICT (id) DO UPDATE SET room_category = $3`,
    admissionId, PATIENT_UID, roomCategory, TENANT,
  );
  createdAdmissionIds.push(admissionId);
  return admissionId;
}

async function seedSignedDischargeSummary({ admissionId }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO discharge_summaries
       (admission_id, patient_uid, status, signed_at, tenant_id)
     VALUES ($1::int, $2::uuid, 'signed', NOW(), $3::uuid)
     RETURNING id`,
    admissionId, PATIENT_UID, TENANT,
  );
  createdSummaryIds.push(rows[0].id);
  return rows[0].id;
}

async function seedPatientPayment({ invoiceId, amount }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO billing_payments
       (invoice_id, patient_uid, amount, mode, reference, tenant_id)
     VALUES ($1::int, $2::uuid, $3::numeric, 'CASH', $4, $5::uuid)
     RETURNING id`,
    invoiceId, PATIENT_UID, amount, `ROOM-CAP-${Date.now() % 100000}`, TENANT,
  );
  createdPaymentIds.push(rows[0].id);
  return rows[0].id;
}

async function seedLiabilityConsent({ consentType = 'financial_liability' } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO patient_consents
       (patient_uid, consent_type, granted, status, granted_at, source,
        notes, tenant_id)
     VALUES ($1::uuid, $2, true, 'active', NOW(), 'staff',
             'Patient acknowledged TPA room-upgrade liability', $3::uuid)
     RETURNING id`,
    PATIENT_UID, consentType, TENANT,
  );
  createdConsentIds.push(rows[0].id);
  return rows[0].id;
}

// Seed a preauth (optionally a child enhancement) directly, then record an
// approval response so the chain has a cumulative sanctioned cover.
async function seedApprovedPreauth({
  expectedCost, sanctioned, parentId = null, requestType = 'planned', rawResponse = null,
}) {
  const num = `PA-COVER-${Date.now() % 100000}-${createdPreauthIds.length}`;
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO insurance_preauth
       (policy_id, patient_uid, preauth_number, request_type, parent_preauth_id,
        primary_diagnosis, expected_cost, status, sanctioned_amount, sanctioned_at,
        tenant_id)
     VALUES ($1::int, $2::uuid, $3, $4, $5::int,
             'Acute pancreatitis', $6::numeric, 'approved', $7::numeric, NOW(),
             $8::uuid)
     RETURNING id`,
    policyId, PATIENT_UID, num, requestType, parentId,
    expectedCost, sanctioned, TENANT,
  );
  const preauthId = rows[0].id;
  createdPreauthIds.push(preauthId);
  await prisma.$executeRawUnsafe(
    `INSERT INTO insurance_preauth_responses
       (preauth_id, response_type, sanctioned_amount, raw_response, decided_at)
     VALUES ($1::int, 'approved', $2::numeric, $3::jsonb, NOW())`,
    preauthId, sanctioned, JSON.stringify(rawResponse || {}),
  );
  return preauthId;
}

describe('TPA claim cover-exceeded + room-cap advisories (4600ed9c / b5906e90)', () => {
  beforeAll(async () => {
    const pol = await prisma.$queryRawUnsafe(
      `INSERT INTO insurance_policies
         (patient_uid, policy_number, status, tenant_id)
       VALUES ($1::uuid, $2, 'active', $3::uuid)
       RETURNING id`,
      PATIENT_UID, `POL-COVER-${Date.now() % 100000}`, TENANT,
    );
    policyId = pol[0].id;
  });

  afterAll(async () => {
    for (const id of createdClaimIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM tpa_claim_correspondence WHERE claim_id = $1::int`, id).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM tpa_claim_documents WHERE claim_id = $1::int`, id).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM tpa_claims WHERE id = $1::int`, id).catch(() => {});
    }
    for (const id of createdSummaryIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM discharge_summaries WHERE id = $1::int`, id).catch(() => {});
    }
    for (const id of createdPaymentIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_payments WHERE id = $1::int`, id).catch(() => {});
    }
    for (const id of createdConsentIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM patient_consents WHERE id = $1::int`, id).catch(() => {});
    }
    for (const id of createdPreauthIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM insurance_preauth_responses WHERE preauth_id = $1::int`, id).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM insurance_preauth WHERE id = $1::int`, id).catch(() => {});
    }
    for (const id of createdInvoiceIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoice_items WHERE invoice_id = $1::int`, id).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = $1::int`, id).catch(() => {});
    }
    for (const id of createdAdmissionIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE id = $1::int`, id).catch(() => {});
    }
    if (policyId) {
      await prisma.$executeRawUnsafe(`DELETE FROM insurance_policies WHERE id = $1::int`, policyId).catch(() => {});
    }
    await prisma.$disconnect().catch(() => {});
  });

  it('surfaces a non-blocking cover-exceeded warning but still creates the claim (the 4600ed9c scenario)', async () => {
    // ₹50k preauth + ₹15k enhancement = ₹65k cumulative cover. The final
    // bill is ₹80k. The claim is created (not rejected) and carries the
    // CLAIM_EXCEEDS_SANCTIONED_COVER advisory with a ₹15k shortfall.
    const parent = await seedApprovedPreauth({ expectedCost: 50000, sanctioned: 50000 });
    await seedApprovedPreauth({
      expectedCost: 15000, sanctioned: 15000, parentId: parent, requestType: 'enhancement',
    });

    const claim = await claims.createClaim({
      tenantId: TENANT, policy_id: policyId, preauth_id: parent,
      patient_uid: PATIENT_UID, claim_type: 'cashless', stage: 'final',
      total_billed: 80000, claimed_amount: 80000,
    });
    createdClaimIds.push(claim.id);

    // Created successfully — not blocked.
    expect(claim.id).toBeGreaterThan(0);
    expect(Number(claim.claimed_amount)).toBe(80000);
    // Carries the advisory.
    expect(Array.isArray(claim.warnings)).toBe(true);
    const cover = claim.warnings.find((w) => w.code === 'CLAIM_EXCEEDS_SANCTIONED_COVER');
    expect(cover).toBeDefined();
    expect(cover.sanctioned).toBe(65000);
    expect(cover.claimed).toBe(80000);
    expect(cover.shortfall).toBe(15000);

    // The same advisory is visible on the read surface (GET /claims/:id).
    const bundle = await claims.getClaimBundle({ tenantId: TENANT, id: claim.id });
    const coverOnRead = bundle.claim.warnings.find((w) => w.code === 'CLAIM_EXCEEDS_SANCTIONED_COVER');
    expect(coverOnRead).toBeDefined();
    expect(coverOnRead.shortfall).toBe(15000);

    // And a correspondence note was logged once (at creation) to nudge the
    // coordinator toward filing an enhancement.
    const note = bundle.correspondence.find((c) =>
      String(c.subject || '').match(/enhancement/i));
    expect(note).toBeDefined();
  });

  it('attaches NO cover warning when the claim is within the sanctioned cover', async () => {
    const parent = await seedApprovedPreauth({ expectedCost: 80000, sanctioned: 80000 });

    const claim = await claims.createClaim({
      tenantId: TENANT, policy_id: policyId, preauth_id: parent,
      patient_uid: PATIENT_UID, claim_type: 'cashless', stage: 'final',
      total_billed: 70000, claimed_amount: 70000,
    });
    createdClaimIds.push(claim.id);

    expect(claim.warnings).toEqual([]);
  });

  it('still HARD-rejects a claim whose claimed_amount exceeds total_billed (#154 untouched)', async () => {
    const parent = await seedApprovedPreauth({ expectedCost: 50000, sanctioned: 50000 });
    await expect(
      claims.createClaim({
        tenantId: TENANT, policy_id: policyId, preauth_id: parent,
        patient_uid: PATIENT_UID, claim_type: 'reimbursement',
        total_billed: 50000, claimed_amount: 60000,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'CLAIM_AMOUNT_EXCEEDS_BILLED',
    });
  });

  it('surfaces a non-blocking room-cap warning when billed room charges exceed the insurer cap', async () => {
    // Insurer capped room rent at ₹13,500 (semi-private); the patient stayed
    // private and the bill carries ₹18,000 room rent → ₹4,500 patient-payable.
    const admissionId = 660100 + (Date.now() % 10000);
    await seedAdmission({ admissionId, roomCategory: 'private' });

    const parent = await seedApprovedPreauth({
      expectedCost: 80000, sanctioned: 80000,
      rawResponse: { caps: { room_category: { max_category: 'semi_private', max_amount: 13500 } } },
    });
    const invoiceId = await seedIssuedInvoice({ total: 80000, admissionId, roomRent: 18000 });

    const claim = await claims.createClaim({
      tenantId: TENANT, policy_id: policyId, preauth_id: parent,
      invoice_id: invoiceId, admission_id: admissionId,
      patient_uid: PATIENT_UID, claim_type: 'cashless', stage: 'final',
      total_billed: 80000, claimed_amount: 80000,
    });
    createdClaimIds.push(claim.id);

    const room = claim.warnings.find((w) => w.code === 'CLAIM_ROOM_CHARGES_EXCEED_CAP');
    expect(room).toBeDefined();
    expect(room.room_charges).toBe(18000);
    expect(room.room_cap).toBe(13500);
    expect(room.excess).toBe(4500);
    expect(room.patient_payable).toBe(4500);

  });

  it('blocks final cashless submit when room-cap liability has no payment or consent evidence', async () => {
    const admissionId = 670100 + (Date.now() % 10000);
    await seedAdmission({ admissionId, roomCategory: 'private' });
    await seedSignedDischargeSummary({ admissionId });
    const parent = await seedApprovedPreauth({
      expectedCost: 80000, sanctioned: 80000,
      rawResponse: { caps: { room_category: { max_category: 'semi_private', max_amount: 13500 } } },
    });
    const invoiceId = await seedIssuedInvoice({ total: 80000, admissionId, roomRent: 18000 });

    const claim = await claims.createClaim({
      tenantId: TENANT, policy_id: policyId, preauth_id: parent,
      invoice_id: invoiceId, admission_id: admissionId,
      patient_uid: PATIENT_UID, claim_type: 'cashless', stage: 'final',
      total_billed: 80000, claimed_amount: 80000,
    });
    createdClaimIds.push(claim.id);

    await expect(
      claims.submitClaim({ tenantId: TENANT, id: claim.id, submitted_by: null }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'ROOM_CAP_LIABILITY_NOT_ACKNOWLEDGED',
      details: expect.objectContaining({
        accepted_consent_types: expect.arrayContaining(['financial_liability', 'room_upgrade_liability']),
      }),
    });
  });

  it('allows final cashless submit after the patient pays the room-cap difference', async () => {
    const admissionId = 680100 + (Date.now() % 10000);
    await seedAdmission({ admissionId, roomCategory: 'private' });
    await seedSignedDischargeSummary({ admissionId });
    const parent = await seedApprovedPreauth({
      expectedCost: 80000, sanctioned: 80000,
      rawResponse: { caps: { room_category: { max_category: 'semi_private', max_amount: 13500 } } },
    });
    const invoiceId = await seedIssuedInvoice({ total: 80000, admissionId, roomRent: 18000 });
    await seedPatientPayment({ invoiceId, amount: 4500 });

    const claim = await claims.createClaim({
      tenantId: TENANT, policy_id: policyId, preauth_id: parent,
      invoice_id: invoiceId, admission_id: admissionId,
      patient_uid: PATIENT_UID, claim_type: 'cashless', stage: 'final',
      total_billed: 80000, claimed_amount: 80000,
    });
    createdClaimIds.push(claim.id);

    const submitted = await claims.submitClaim({
      tenantId: TENANT, id: claim.id, submitted_by: null,
    });
    expect(submitted.status).toBe('submitted');
  });

  it('allows final cashless submit when financial-liability consent is captured', async () => {
    const admissionId = 690100 + (Date.now() % 10000);
    await seedAdmission({ admissionId, roomCategory: 'private' });
    await seedSignedDischargeSummary({ admissionId });
    await seedLiabilityConsent();
    const parent = await seedApprovedPreauth({
      expectedCost: 80000, sanctioned: 80000,
      rawResponse: { caps: { room_category: { max_category: 'semi_private', max_amount: 13500 } } },
    });
    const invoiceId = await seedIssuedInvoice({ total: 80000, admissionId, roomRent: 18000 });

    const claim = await claims.createClaim({
      tenantId: TENANT, policy_id: policyId, preauth_id: parent,
      invoice_id: invoiceId, admission_id: admissionId,
      patient_uid: PATIENT_UID, claim_type: 'cashless', stage: 'final',
      total_billed: 80000, claimed_amount: 80000,
    });
    createdClaimIds.push(claim.id);

    const submitted = await claims.submitClaim({
      tenantId: TENANT, id: claim.id, submitted_by: null,
    });
    expect(submitted.status).toBe('submitted');
  });

  it('attaches an empty warnings array when the claim has no linked preauth', async () => {
    const claim = await claims.createClaim({
      tenantId: TENANT, policy_id: policyId,
      patient_uid: PATIENT_UID, claim_type: 'reimbursement',
      total_billed: 40000, claimed_amount: 40000,
    });
    createdClaimIds.push(claim.id);
    expect(claim.warnings).toEqual([]);
  });
});
