// apps/backend/src/tests/nhcx-payment-notice-p4.deep.test.js
//
// NL-2 P4: PaymentNotice is evidence only. Settlement happens only when the
// finance review action delegates to claimsService.recordClaimPayment.

import { randomUUID } from 'node:crypto';
import prisma from '../lib/prisma.js';
import { processNHCXCallback } from '../services/nhcx/nhcxInboundCallbackService.js';
import {
  approvePaymentNoticeReview,
  listPaymentNoticeReviews,
  rejectPaymentNoticeReview,
} from '../services/nhcx/nhcxPaymentNoticeService.js';

const TENANT_A = '00000000-0000-4000-8000-0000000004a1';
const TENANT_B = '00000000-0000-4000-8000-0000000004b1';
const cleanup = { claimIds: [], policyIds: [], patientUids: [], messageIds: [] };

async function ensureTenant(id, slug) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    id,
    slug,
    slug,
  );
}

async function makePatient(tenantId) {
  const uid = randomUUID();
  const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at)
     VALUES ($1::uuid, $2, 'NHCX P4 Test', 'PATIENT', $3::uuid, NOW())`,
    uid,
    phone,
    tenantId,
  );
  cleanup.patientUids.push(uid);
  return uid;
}

async function makePolicy({ tenantId, patientUid }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO insurance_policies (patient_uid, policy_number, tenant_id)
     VALUES ($1::uuid, $2, $3::uuid)
     RETURNING id`,
    patientUid,
    `POL-P4-${Math.floor(Math.random() * 1e9)}`,
    tenantId,
  );
  cleanup.policyIds.push(Number(rows[0].id));
  return Number(rows[0].id);
}

async function makeApprovedClaim({ tenantId, patientUid, policyId, claimed = 50000 }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO tpa_claims
       (claim_number, policy_id, patient_uid, total_billed, claimed_amount, approved_amount,
        claim_type, status, tenant_id)
     VALUES ($1, $2::int, $3::uuid, $4::numeric, $4::numeric, $4::numeric,
             'cashless', 'approved', $5::uuid)
     RETURNING id, claim_number`,
    `CLM-P4-${Math.floor(Math.random() * 1e9)}`,
    policyId,
    patientUid,
    claimed,
    tenantId,
  );
  cleanup.claimIds.push(Number(rows[0].id));
  return { id: Number(rows[0].id), claimNumber: rows[0].claim_number };
}

function paymentNoticeBundle({ claimId, amount, reference }) {
  return {
    resourceType: 'Bundle',
    id: `payment-notice-bundle-${reference}`,
    meta: {
      profile: ['https://www.nrces.in/ndhm/fhir/r4/StructureDefinition/PaymentNoticeBundle'],
      versionId: '7.0.0-design-target',
    },
    type: 'collection',
    entry: [
      {
        resource: {
          resourceType: 'PaymentNotice',
          id: `notice-${reference}`,
          status: 'active',
          created: '2026-07-06T12:00:00.000Z',
          request: { reference: `Claim/claim-${claimId}` },
          response: { reference: `ClaimResponse/claim-response-${claimId}` },
          payment: { identifier: { value: reference } },
          amount: { value: amount, currency: 'INR' },
        },
      },
      {
        resource: {
          resourceType: 'PaymentReconciliation',
          id: `recon-${reference}`,
          status: 'active',
          created: '2026-07-06T12:00:00.000Z',
          paymentAmount: { value: amount, currency: 'INR' },
          detail: [{
            request: { reference: `Claim/claim-${claimId}` },
            response: { reference: `ClaimResponse/claim-response-${claimId}` },
            amount: { value: amount, currency: 'INR' },
          }],
        },
      },
    ],
  };
}

async function captureNotice({ tenantId, claimId, amount = 50000, reference = `UTR-${randomUUID()}` }) {
  const bundle = paymentNoticeBundle({ claimId, amount, reference });
  const result = await processNHCXCallback({
    tenantId,
    endpoint: 'paymentnotice/request',
    body: { payload: `jwe-${reference}` },
    headers: {
      'x-hcx-recipient_code': `VH-NHCX-${tenantId.slice(-4)}`,
      'x-hcx-sender_code': 'PAYER-NHCX-SAMPLE',
      'x-hcx-api_call_id': `payment-notice-${reference}`,
      'x-hcx-correlation_id': `payment-corr-${reference}`,
      'x-hcx-workflow_id': `claim-${claimId}`,
    },
    participantCodeSelf: `VH-NHCX-${tenantId.slice(-4)}`,
    signatureVerified: true,
    runtimeResolver: async () => ({ environment: 'sandbox' }),
    decryptPayload: async () => ({ bundle, protectedHeaders: {} }),
  });
  if (result.envelope?.id) cleanup.messageIds.push(String(result.envelope.id));
  return result;
}

async function claimRow(id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT status, paid_amount, disallowed_amount, payment_reference
       FROM tpa_claims
      WHERE id = $1::int`,
    id,
  );
  return rows[0];
}

async function ledgerEntryCount(tenantId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS count
       FROM ledger_entries
      WHERE tenant_id = $1::uuid`,
    tenantId,
  );
  return Number(rows[0]?.count || 0);
}

beforeAll(async () => {
  await ensureTenant(TENANT_A, 'nhcx-p4-a');
  await ensureTenant(TENANT_B, 'nhcx-p4-b');
});

afterAll(async () => {
  try {
    if (cleanup.messageIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM nhcx_messages WHERE id = ANY($1::bigint[])`, cleanup.messageIds);
    }
    if (cleanup.claimIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM tpa_claim_correspondence WHERE claim_id = ANY($1::int[])`, cleanup.claimIds).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM tpa_claims WHERE id = ANY($1::int[])`, cleanup.claimIds);
    }
    if (cleanup.policyIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM insurance_policies WHERE id = ANY($1::int[])`, cleanup.policyIds);
    }
    if (cleanup.patientUids.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, cleanup.patientUids);
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
});

describe('NL-2 P4 PaymentNotice review', () => {
  it('captures PaymentNotice without changing tpa_claims status or posting ledger entries', async () => {
    const patient = await makePatient(TENANT_A);
    const policyId = await makePolicy({ tenantId: TENANT_A, patientUid: patient });
    const claim = await makeApprovedClaim({ tenantId: TENANT_A, patientUid: patient, policyId });
    const beforeClaim = await claimRow(claim.id);
    const beforeLedger = await ledgerEntryCount(TENANT_A);

    const result = await captureNotice({ tenantId: TENANT_A, claimId: claim.id, amount: 50000, reference: `P4-FULL-${claim.id}` });

    const afterClaim = await claimRow(claim.id);
    expect(result).toMatchObject({ duplicate: false, processed: false });
    expect(result.envelope.status).toBe('manual_review');
    expect(afterClaim.status).toBe(beforeClaim.status);
    expect(Number(afterClaim.paid_amount || 0)).toBe(Number(beforeClaim.paid_amount || 0));
    expect(await ledgerEntryCount(TENANT_A)).toBe(beforeLedger);
  });

  it('deduplicates the same PaymentNotice envelope', async () => {
    const patient = await makePatient(TENANT_A);
    const policyId = await makePolicy({ tenantId: TENANT_A, patientUid: patient });
    const claim = await makeApprovedClaim({ tenantId: TENANT_A, patientUid: patient, policyId });
    const reference = `P4-DUP-${claim.id}`;

    const first = await captureNotice({ tenantId: TENANT_A, claimId: claim.id, amount: 50000, reference });
    const second = await captureNotice({ tenantId: TENANT_A, claimId: claim.id, amount: 50000, reference });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS count
         FROM nhcx_messages
        WHERE tenant_id = $1::uuid
          AND hcx_api_call_id = $2`,
      TENANT_A,
      `payment-notice-${reference}`,
    );
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(Number(rows[0].count)).toBe(1);
  });

  it('approval settles short-pay only after finance review approval', async () => {
    const patient = await makePatient(TENANT_A);
    const policyId = await makePolicy({ tenantId: TENANT_A, patientUid: patient });
    const claim = await makeApprovedClaim({ tenantId: TENANT_A, patientUid: patient, policyId });
    const captured = await captureNotice({ tenantId: TENANT_A, claimId: claim.id, amount: 42000, reference: `P4-SHORT-${claim.id}` });

    expect((await claimRow(claim.id)).status).toBe('approved');

    await approvePaymentNoticeReview({
      tenantId: TENANT_A,
      id: captured.envelope.id,
      reviewerUid: randomUUID(),
    });

    const settled = await claimRow(claim.id);
    expect(settled.status).toBe('settled_partial');
    expect(Number(settled.paid_amount)).toBe(42000);
    expect(Number(settled.disallowed_amount)).toBe(8000);
  });

  it('rejecting a notice leaves the claim untouched', async () => {
    const patient = await makePatient(TENANT_A);
    const policyId = await makePolicy({ tenantId: TENANT_A, patientUid: patient });
    const claim = await makeApprovedClaim({ tenantId: TENANT_A, patientUid: patient, policyId });
    const captured = await captureNotice({ tenantId: TENANT_A, claimId: claim.id, amount: 50000, reference: `P4-REJECT-${claim.id}` });

    await rejectPaymentNoticeReview({
      tenantId: TENANT_A,
      id: captured.envelope.id,
      reviewerUid: randomUUID(),
      reason: 'duplicate payer evidence',
    });

    const row = await claimRow(claim.id);
    expect(row.status).toBe('approved');
    expect(row.payment_reference).toBeNull();
  });

  it('does not surface tenant A notices in tenant B review queue', async () => {
    const patient = await makePatient(TENANT_A);
    const policyId = await makePolicy({ tenantId: TENANT_A, patientUid: patient });
    const claim = await makeApprovedClaim({ tenantId: TENANT_A, patientUid: patient, policyId });
    await captureNotice({ tenantId: TENANT_A, claimId: claim.id, amount: 50000, reference: `P4-XTENANT-${claim.id}` });

    const tenantBQueue = await listPaymentNoticeReviews({ tenantId: TENANT_B, status: 'manual_review' });

    expect(tenantBQueue.items).toHaveLength(0);
  });
});
