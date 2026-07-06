// src/services/nhcx/nhcxPaymentNoticeService.js
//
// NL-2 P4 PaymentNotice capture. A PaymentNotice is inbound evidence only:
// it never changes claim status, ledger entries, or INSURANCE_AR until a
// finance reviewer explicitly approves the settlement draft below.

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { recordClaimPayment } from '../insurance/claimsService.js';
import { requireTenantId } from '../tenant/tenantService.js';

function clean(value) {
  return String(value ?? '').trim();
}

function safeText(value, max = 1_000) {
  const text = clean(value);
  return text ? text.slice(0, max) : null;
}

function resources(bundle) {
  return (bundle?.entry || []).map((entry) => entry.resource).filter(Boolean);
}

function firstResource(bundle, resourceType) {
  return resources(bundle).find((resource) => resource.resourceType === resourceType) || null;
}

function amountValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function firstAmount(...values) {
  for (const value of values) {
    const parsed = amountValue(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function identifierValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(identifierValues);
  if (typeof value === 'object') {
    return [
      value.value,
      value.id,
      value.reference,
      value.identifier?.value,
      ...(Array.isArray(value.identifier) ? value.identifier.map((item) => item?.value) : []),
    ].map((item) => safeText(item, 255)).filter(Boolean);
  }
  return [safeText(value, 255)].filter(Boolean);
}

function claimIdFromReference(value) {
  const text = clean(value);
  const match = text.match(/(?:claim|tpa-claim|tpa-claim-id|claim-id)[^\d]*(\d+)|^(\d+)$/i);
  const raw = match?.[1] || match?.[2];
  return raw ? Number(raw) : null;
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ''))];
}

function extractPaymentNotice(bundle, context = {}) {
  const notice = firstResource(bundle, 'PaymentNotice');
  if (!notice) {
    throw AppError.badRequest('NHCX payment notice callback must contain PaymentNotice', 'NHCX_PAYMENT_NOTICE_REQUIRED');
  }
  const reconciliation = firstResource(bundle, 'PaymentReconciliation');
  const detail = Array.isArray(reconciliation?.detail) ? reconciliation.detail : [];
  const claimReferences = unique([
    ...identifierValues(notice.request),
    ...identifierValues(notice.response),
    ...identifierValues(notice.identifier),
    ...identifierValues(reconciliation?.identifier),
    ...detail.flatMap((item) => [
      ...identifierValues(item.request),
      ...identifierValues(item.response),
      ...identifierValues(item.identifier),
    ]),
  ]);
  const claimIds = unique(claimReferences.map(claimIdFromReference).filter((value) => value && value > 0));
  const amount = firstAmount(
    notice.amount?.value,
    notice.payment?.amount?.value,
    notice.paymentAmount?.value,
    reconciliation?.paymentAmount?.value,
    reconciliation?.total?.value,
    ...detail.map((item) => item.amount?.value),
  );
  const paymentReference = safeText(
    notice.payment?.identifier?.value
      || notice.payment?.reference
      || notice.identifier?.[0]?.value
      || reconciliation?.identifier?.[0]?.value
      || context.hcxApiCallId,
    255,
  );

  return {
    resourceId: safeText(notice.id, 160),
    reconciliationId: safeText(reconciliation?.id, 160),
    status: safeText(notice.status || reconciliation?.status, 80),
    amount,
    currency: safeText(
      notice.amount?.currency
        || notice.payment?.amount?.currency
        || reconciliation?.paymentAmount?.currency
        || 'INR',
      12,
    ),
    paymentReference,
    paidAt: safeText(notice.paymentDate || notice.created || reconciliation?.paymentDate || reconciliation?.created, 80),
    claimIds,
    claimReferences,
    rawResourceTypes: resources(bundle).map((resource) => resource.resourceType),
  };
}

function workflowAdmissionId(context = {}) {
  const parsed = Number.parseInt(clean(context.hcxWorkflowId), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function resolveClaimForNotice({ tenantId, outboundContext = null, notice, context = {} }) {
  const ids = unique([
    outboundContext?.claim_id ? Number(outboundContext.claim_id) : null,
    ...notice.claimIds,
  ].filter((value) => Number.isFinite(value) && value > 0));
  const references = unique(notice.claimReferences);
  const admissionId = ids.length || references.length ? null : workflowAdmissionId(context);
  if (!ids.length && !references.length && !admissionId) {
    return { claim: null, linkIssue: 'No claim identifier, correlation, or workflow match was present on the notice.' };
  }

  const rows = await prisma.$queryRawUnsafe(
    `SELECT c.id, c.claim_number, c.status, c.claimed_amount, c.approved_amount,
            c.paid_amount, c.disallowed_amount, c.payment_reference,
            c.tpa_reference_id, c.patient_uid::text AS patient_uid,
            c.policy_id, c.preauth_id, c.invoice_id, c.admission_id,
            pol.policy_number,
            payer.display_name AS payer_name,
            tpa.display_name AS tpa_name
       FROM tpa_claims c
       LEFT JOIN insurance_policies pol ON pol.id = c.policy_id
       LEFT JOIN payers payer ON payer.id = pol.payer_id
       LEFT JOIN tpas tpa ON tpa.id = pol.tpa_id
      WHERE c.tenant_id = $1::uuid
        AND (
          c.id = ANY($2::int[])
          OR c.claim_number = ANY($3::text[])
          OR c.tpa_reference_id = ANY($3::text[])
          OR ($4::int IS NOT NULL AND c.admission_id = $4::int)
        )
      ORDER BY
        CASE
          WHEN c.id = ANY($2::int[]) THEN 0
          WHEN c.claim_number = ANY($3::text[]) THEN 1
          WHEN c.tpa_reference_id = ANY($3::text[]) THEN 2
          ELSE 3
        END,
        c.updated_at DESC NULLS LAST,
        c.id DESC
      LIMIT 2`,
    tenantId,
    ids,
    references,
    admissionId,
  );

  if (!rows.length) {
    return { claim: null, linkIssue: 'No same-tenant TPA claim matched the notice identifiers.' };
  }
  if (!ids.length && !references.length && admissionId && rows.length > 1) {
    return { claim: null, linkIssue: `Workflow id ${admissionId} matched multiple TPA claims; finance must link manually.` };
  }
  return { claim: rows[0], linkIssue: null };
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function buildSettlementDraft({ notice, claim, context = {} }) {
  if (!claim || notice.amount == null || notice.amount <= 0) return null;
  const claimed = numberOrNull(claim.claimed_amount) || 0;
  const approved = numberOrNull(claim.approved_amount);
  const basis = approved != null && approved > 0 ? approved : claimed;
  const paymentReference = notice.paymentReference || context.hcxApiCallId || `payment-notice-${notice.resourceId || 'nhcx'}`;
  const paidAmount = numberOrNull(notice.amount);
  return {
    claim_id: Number(claim.id),
    paid_amount: paidAmount,
    payment_reference: paymentReference,
    paid_at: notice.paidAt || null,
    expected_amount: basis,
    short_pay: basis > 0 && paidAmount + 0.01 < basis,
    disallowed_amount_preview: basis > 0 && paidAmount < basis
      ? Number((basis - paidAmount).toFixed(2))
      : 0,
    source: 'nhcx_payment_notice',
  };
}

function discrepancyList({ notice, claim, linkIssue, draft }) {
  const issues = [];
  if (linkIssue) issues.push({ code: 'claim_unresolved', severity: 'warning', message: linkIssue });
  if (notice.amount == null || notice.amount <= 0) {
    issues.push({ code: 'amount_missing', severity: 'warning', message: 'PaymentNotice did not carry a positive payment amount.' });
  }
  if (claim && notice.amount != null) {
    const claimed = numberOrNull(claim.claimed_amount) || 0;
    const approved = numberOrNull(claim.approved_amount);
    if (claimed > 0 && notice.amount > claimed + 0.01) {
      issues.push({ code: 'amount_exceeds_claimed', severity: 'critical', message: 'Notice amount exceeds claimed amount.' });
    }
    if (approved != null && approved > 0 && Math.abs(notice.amount - approved) > 0.01) {
      issues.push({ code: 'amount_differs_from_approved', severity: draft?.short_pay ? 'warning' : 'info', message: 'Notice amount differs from approved amount.' });
    }
    if (draft?.short_pay) {
      issues.push({ code: 'short_pay', severity: 'warning', message: 'Approval will settle this as a partial payment through recordClaimPayment.' });
    }
  }
  return issues;
}

function metadataIssue({ notice, claim = null, draft = null, discrepancies = [], reviewStatus = 'manual_review', reviewerUid = null, reason = null } = {}) {
  return {
    severity: 'information',
    code: 'payment_notice_review',
    message: 'NHCX PaymentNotice captured for finance review',
    payment_notice: {
      review_status: reviewStatus,
      amount: notice.amount,
      currency: notice.currency,
      payment_reference: notice.paymentReference || draft?.payment_reference || null,
      paid_at: notice.paidAt || null,
      resource_id: notice.resourceId || null,
      reconciliation_id: notice.reconciliationId || null,
      claim_references: notice.claimReferences,
      claim: claim ? {
        id: Number(claim.id),
        claim_number: claim.claim_number,
        status: claim.status,
        claimed_amount: numberOrNull(claim.claimed_amount),
        approved_amount: numberOrNull(claim.approved_amount),
        paid_amount: numberOrNull(claim.paid_amount),
        policy_number: claim.policy_number || null,
        payer_name: claim.payer_name || null,
        tpa_name: claim.tpa_name || null,
      } : null,
      settlement_draft: draft,
      discrepancies,
      reviewer_uid: reviewerUid,
      reason,
      reviewed_at: reviewerUid ? new Date().toISOString() : null,
    },
  };
}

function parseIssues(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function paymentNoticeMetadata(envelope) {
  return parseIssues(envelope?.validation_issues)
    .find((issue) => issue?.code === 'payment_notice_review')?.payment_notice || null;
}

function mergeIssues(profileIssues = [], metadata) {
  return [
    ...parseIssues(profileIssues).filter((issue) => issue?.code !== 'payment_notice_review'),
    metadata,
  ];
}

async function updateEnvelopeReview({ envelopeId, tenantId, status, issues, claim, lastError = null, processed = false }) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE nhcx_messages
        SET status = $3,
            claim_id = COALESCE($4::int, claim_id),
            preauth_id = COALESCE($5::int, preauth_id),
            policy_id = COALESCE($6::int, policy_id),
            patient_uid = COALESCE($7::uuid, patient_uid),
            admission_id = COALESCE($8::int, admission_id),
            validation_issues = $9::jsonb,
            last_error = $10,
            processed_at = CASE WHEN $11::boolean THEN NOW() ELSE processed_at END,
            updated_at = NOW()
      WHERE id = $1::bigint
        AND tenant_id = $2::uuid
      RETURNING *`,
    String(envelopeId),
    tenantId,
    status,
    claim?.id ? Number(claim.id) : null,
    claim?.preauth_id ? Number(claim.preauth_id) : null,
    claim?.policy_id ? Number(claim.policy_id) : null,
    claim?.patient_uid || null,
    claim?.admission_id ? Number(claim.admission_id) : null,
    JSON.stringify(issues || []),
    lastError ? safeText(lastError, 2_000) : null,
    processed === true,
  );
  return rows[0] || null;
}

export async function recordInboundPaymentNotice({
  tenantId,
  bundle,
  context = {},
  outboundContext = null,
  envelope,
  profileIssues = [],
} = {}) {
  const tid = requireTenantId(tenantId);
  const notice = extractPaymentNotice(bundle, context);
  const { claim, linkIssue } = await resolveClaimForNotice({ tenantId: tid, outboundContext, notice, context });
  const draft = buildSettlementDraft({ notice, claim, context });
  const discrepancies = discrepancyList({ notice, claim, linkIssue, draft });
  const metadata = metadataIssue({
    notice,
    claim,
    draft,
    discrepancies,
    reviewStatus: 'manual_review',
  });
  const lastError = linkIssue || (draft ? null : 'PaymentNotice cannot be approved until it has a linked claim and positive amount.');
  const updated = await updateEnvelopeReview({
    envelopeId: envelope.id,
    tenantId: tid,
    status: 'manual_review',
    issues: mergeIssues(profileIssues, metadata),
    claim,
    lastError,
  });
  return {
    reviewRequired: true,
    notice,
    claimId: claim?.id ? Number(claim.id) : null,
    settlementDraft: draft,
    discrepancies,
    envelope: updated || envelope,
  };
}

function normalizeReviewRow(row) {
  const metadata = paymentNoticeMetadata(row) || {};
  const claim = metadata.claim || (row.claim_id ? {
    id: Number(row.claim_id),
    claim_number: row.claim_number,
    status: row.claim_status,
    claimed_amount: numberOrNull(row.claimed_amount),
    approved_amount: numberOrNull(row.approved_amount),
    paid_amount: numberOrNull(row.paid_amount),
    policy_number: row.policy_number || null,
    payer_name: row.payer_name || null,
    tpa_name: row.tpa_name || null,
  } : null);
  return {
    id: String(row.id),
    status: row.status,
    received_at: row.received_at,
    processed_at: row.processed_at,
    last_error: row.last_error,
    hcx_api_call_id: row.hcx_api_call_id,
    hcx_correlation_id: row.hcx_correlation_id,
    hcx_workflow_id: row.hcx_workflow_id,
    participant_code_counterparty: row.participant_code_counterparty,
    notice: {
      amount: metadata.amount ?? null,
      currency: metadata.currency || 'INR',
      payment_reference: metadata.payment_reference || null,
      paid_at: metadata.paid_at || null,
      resource_id: metadata.resource_id || null,
      reconciliation_id: metadata.reconciliation_id || null,
    },
    claim,
    settlement_draft: metadata.settlement_draft || null,
    discrepancies: metadata.discrepancies || [],
    review_status: metadata.review_status || row.status,
    reason: metadata.reason || null,
  };
}

export async function listPaymentNoticeReviews({ tenantId, status = 'manual_review', limit = 100 } = {}) {
  const tid = requireTenantId(tenantId);
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 250);
  const statuses = status && status !== 'all'
    ? [String(status)]
    : ['manual_review', 'processed', 'rejected'];
  const rows = await prisma.$queryRawUnsafe(
    `SELECT m.*,
            c.claim_number,
            c.status AS claim_status,
            c.claimed_amount,
            c.approved_amount,
            c.paid_amount,
            c.policy_id AS claim_policy_id,
            pol.policy_number,
            payer.display_name AS payer_name,
            tpa.display_name AS tpa_name
       FROM nhcx_messages m
       LEFT JOIN tpa_claims c
         ON c.id = m.claim_id
        AND c.tenant_id = m.tenant_id
       LEFT JOIN insurance_policies pol ON pol.id = c.policy_id
       LEFT JOIN payers payer ON payer.id = pol.payer_id
       LEFT JOIN tpas tpa ON tpa.id = pol.tpa_id
      WHERE m.tenant_id = $1::uuid
        AND m.direction = 'inbound'
        AND m.cycle = 'payment_notice'
        AND m.status = ANY($2::text[])
      ORDER BY m.received_at DESC NULLS LAST, m.created_at DESC, m.id DESC
      LIMIT $3::int`,
    tid,
    statuses,
    safeLimit,
  );
  const items = rows.map(normalizeReviewRow);
  return {
    items,
    summary: {
      count: items.length,
      manual_review: items.filter((item) => item.status === 'manual_review').length,
      processed: items.filter((item) => item.status === 'processed').length,
      rejected: items.filter((item) => item.status === 'rejected').length,
    },
  };
}

async function getPaymentNoticeEnvelope({ tenantId, id }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT *
       FROM nhcx_messages
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
        AND direction = 'inbound'
        AND cycle = 'payment_notice'
      LIMIT 1`,
    tenantId,
    String(id),
  );
  if (!rows[0]) throw AppError.notFound('Payment notice review not found', 'NHCX_PAYMENT_NOTICE_NOT_FOUND');
  return rows[0];
}

export async function getPaymentNoticeReview({ tenantId, id } = {}) {
  const tid = requireTenantId(tenantId);
  const envelope = await getPaymentNoticeEnvelope({ tenantId: tid, id });
  return normalizeReviewRow(envelope);
}

function approvedDraftFrom(metadata, overrides = {}) {
  const base = metadata?.settlement_draft || {};
  const paidAmount = overrides.paid_amount ?? overrides.paidAmount ?? base.paid_amount;
  const paymentReference = safeText(overrides.payment_reference ?? overrides.paymentReference ?? base.payment_reference, 255);
  const paidAt = safeText(overrides.paid_at ?? overrides.paidAt ?? base.paid_at, 80);
  const amount = Number(paidAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw AppError.badRequest('A positive paid_amount is required to approve the payment notice', 'NHCX_PAYMENT_NOTICE_AMOUNT_REQUIRED');
  }
  if (!paymentReference) {
    throw AppError.badRequest('payment_reference is required to approve the payment notice', 'NHCX_PAYMENT_NOTICE_REFERENCE_REQUIRED');
  }
  return {
    claim_id: Number(base.claim_id),
    paid_amount: Number(amount.toFixed(2)),
    payment_reference: paymentReference,
    paid_at: paidAt || null,
    expected_amount: base.expected_amount ?? null,
    short_pay: base.expected_amount != null && amount + 0.01 < Number(base.expected_amount),
    disallowed_amount_preview: base.expected_amount != null && amount < Number(base.expected_amount)
      ? Number((Number(base.expected_amount) - amount).toFixed(2))
      : 0,
    source: 'nhcx_payment_notice',
  };
}

export async function approvePaymentNoticeReview({
  tenantId,
  id,
  reviewerUid = null,
  draftOverrides = {},
} = {}) {
  const tid = requireTenantId(tenantId);
  const envelope = await getPaymentNoticeEnvelope({ tenantId: tid, id });
  if (envelope.status === 'processed') {
    return { alreadyProcessed: true, envelope: normalizeReviewRow(envelope), paymentResult: null };
  }
  if (envelope.status === 'rejected') {
    throw AppError.badRequest('Rejected payment notices cannot be approved', 'NHCX_PAYMENT_NOTICE_REJECTED');
  }
  const metadata = paymentNoticeMetadata(envelope);
  if (!metadata?.claim?.id && !envelope.claim_id) {
    throw AppError.badRequest('Payment notice is not linked to a TPA claim', 'NHCX_PAYMENT_NOTICE_CLAIM_REQUIRED');
  }
  const draft = approvedDraftFrom(metadata, draftOverrides);
  draft.claim_id = Number(draft.claim_id || envelope.claim_id);

  let paymentResult = null;
  try {
    paymentResult = await recordClaimPayment({
      tenantId: tid,
      id: draft.claim_id,
      paid_amount: draft.paid_amount,
      payment_reference: draft.payment_reference,
      paid_at: draft.paid_at,
      recorded_by: reviewerUid,
    });
  } catch (err) {
    await updateEnvelopeReview({
      envelopeId: envelope.id,
      tenantId: tid,
      status: 'manual_review',
      issues: parseIssues(envelope.validation_issues),
      claim: { id: draft.claim_id },
      lastError: err?.message || 'Payment notice approval failed',
    });
    throw err;
  }

  const updatedMetadata = {
    ...metadata,
    settlement_draft: draft,
    review_status: 'approved',
    reviewer_uid: reviewerUid,
    reviewed_at: new Date().toISOString(),
    reason: null,
  };
  const updated = await updateEnvelopeReview({
    envelopeId: envelope.id,
    tenantId: tid,
    status: 'processed',
    issues: mergeIssues(envelope.validation_issues, {
      severity: 'information',
      code: 'payment_notice_review',
      message: 'NHCX PaymentNotice approved by finance reviewer',
      payment_notice: updatedMetadata,
    }),
    claim: { id: draft.claim_id },
    lastError: null,
    processed: true,
  });
  return {
    alreadyProcessed: false,
    envelope: normalizeReviewRow(updated || envelope),
    paymentResult,
  };
}

export async function rejectPaymentNoticeReview({
  tenantId,
  id,
  reviewerUid = null,
  reason,
} = {}) {
  const tid = requireTenantId(tenantId);
  const rejectionReason = safeText(reason, 1_000);
  if (!rejectionReason) {
    throw AppError.badRequest('A rejection reason is required', 'NHCX_PAYMENT_NOTICE_REJECTION_REASON_REQUIRED');
  }
  const envelope = await getPaymentNoticeEnvelope({ tenantId: tid, id });
  if (envelope.status === 'processed') {
    throw AppError.badRequest('Approved payment notices cannot be rejected', 'NHCX_PAYMENT_NOTICE_ALREADY_APPROVED');
  }
  const metadata = paymentNoticeMetadata(envelope) || {};
  const updatedMetadata = {
    ...metadata,
    review_status: 'rejected',
    reviewer_uid: reviewerUid,
    reviewed_at: new Date().toISOString(),
    reason: rejectionReason,
  };
  const updated = await updateEnvelopeReview({
    envelopeId: envelope.id,
    tenantId: tid,
    status: 'rejected',
    issues: mergeIssues(envelope.validation_issues, {
      severity: 'information',
      code: 'payment_notice_review',
      message: 'NHCX PaymentNotice rejected by finance reviewer',
      payment_notice: updatedMetadata,
    }),
    claim: envelope.claim_id ? { id: Number(envelope.claim_id) } : null,
    lastError: rejectionReason,
    processed: true,
  });
  return normalizeReviewRow(updated || envelope);
}

export const __testing__ = {
  extractPaymentNotice,
  paymentNoticeMetadata,
  buildSettlementDraft,
  discrepancyList,
};
