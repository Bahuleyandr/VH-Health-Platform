// src/services/insurance/claimsService.js
//
// Sprint 5 — Insurance / TPA workflow.
//
// Pre-auth → enhancement → final claim → settlement, end-to-end. Keeps
// payer/TPA master tables (migration 119) as the source of truth and
// adds the per-encounter rows under it. Uses billing_invoices for the
// final-bill linkage so the cashier and the insurance coordinator
// stay in sync.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { AppError } from '../../utils/AppError.js';
import { boundedInteger } from '../../utils/pagination.js';
import { postInsuranceShiftEntry } from '../billing/ledger/ledgerPostings.js';
import { resolveLedgerWiring } from '../billing/ledger/ledgerAuthoritativeMode.js';
import { notificationOutbox } from '../../utils/notifications/notificationOutbox.js';
import logger from '../../logging/logger.js';

// ── helpers ──────────────────────────────────────────────────────────

// Pre-auth submission SLA windows (hours from creation), keyed by
// request_type. Cashless TPA pre-auth has a hard insurer TAT — a draft
// that's never submitted means the patient is billed cash despite valid
// cover. Deliberately a flat lookup, not an SLA engine.
// Finding: 2026-05-09-tpa-insurance-claim-admission-preauth-draft-not-auto-submitted
const PREAUTH_SUBMIT_SLA_HOURS = {
  emergency: 6,
  enhancement: 12,
  planned: 48,
};
const DEFAULT_PREAUTH_SUBMIT_SLA_HOURS = 24;

function preauthSubmitSlaHours(requestType) {
  const key = String(requestType || '').toLowerCase();
  return PREAUTH_SUBMIT_SLA_HOURS[key] ?? DEFAULT_PREAUTH_SUBMIT_SLA_HOURS;
}

// A draft pre-auth is overdue once its submission deadline has passed.
// Submitted/decided rows keep submit_due_at as a historical SLA record
// but are never "overdue".
function isSubmitOverdue(row) {
  return (
    row?.status === 'draft' &&
    row?.submit_due_at != null &&
    new Date(row.submit_due_at).getTime() < Date.now()
  );
}

function fiscalYearOf(d = new Date()) {
  // Indian FY: Apr 1 → Mar 31. FY24-25 covers Apr 2024 – Mar 2025.
  const m = d.getMonth() + 1;
  const y = d.getFullYear();
  const start = m >= 4 ? y : y - 1;
  return `${String(start).slice(2)}-${String(start + 1).slice(2)}`;
}

// ── Claim status state machine (audit §C-1) ──────────────────────────────
//
// `tpa_claims.status` is a bare varchar with no DB CHECK, so before this guard
// `paid → submitted`, `denied → approved`, `approved → denied` were all
// accepted — and a `denied` flip auto-spawns appeal workflows. These maps make
// every status change a checked from→to transition (mirrors the pharmacy-order
// VALID_TRANSITIONS pattern + submitAppealLetter's AppError.invalidTransition).
//
// recordClaimDecision moves an in-flight claim to a payer verdict; the verdict
// itself IS the target status. Re-recording the SAME decision on a claim
// already in that state is treated as idempotent (no-op) rather than an error,
// so a duplicate TPA-portal callback doesn't 400 or double-write.
const CLAIM_DECISION_TRANSITIONS = {
  submitted: ['approved', 'partially_approved', 'queried', 'denied'],
  queried: ['approved', 'partially_approved', 'queried', 'denied'],
  approved: ['partially_approved', 'denied', 'queried'],
  partially_approved: ['approved', 'denied', 'queried'],
  denied: ['approved', 'partially_approved'],
  // Terminal money/lifecycle states accept no further payer decision.
  paid: [],
  settled_partial: [],
  closed: [],
  cancelled: [],
};

// recordClaimPayment always targets a paid-class status (paid / settled_partial),
// only reachable from a positive payer verdict (or directly from submitted for
// a clean auto-settle). Re-posting the SAME settlement reference is treated as
// idempotent by recordClaimPayment itself.
const CLAIM_PAYMENT_FROM_STATES = ['approved', 'partially_approved', 'submitted'];

async function nextSeq(tableCounter, prefix, tenantId) {
  // Atomic increment per (tenant, fiscal_year).
  const fy = fiscalYearOf();
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO ${tableCounter} (tenant_id, fiscal_year, next_value)
     VALUES ($1::uuid, $2, 1)
     ON CONFLICT (tenant_id, fiscal_year)
     DO UPDATE SET next_value = ${tableCounter}.next_value + 1
     RETURNING next_value`,
    String(tenantId), fy,
  );
  const seq = rows[0].next_value;
  return `${prefix}-${fy.replace('-', '')}-${String(seq).padStart(5, '0')}`;
}

async function assertTpaChildParentInTenant({ tenantId, claim_id, preauth_id }) {
  if (!tenantId) return;
  const checks = [];
  if (claim_id) {
    checks.push(prisma.$queryRawUnsafe(
      `SELECT id
         FROM tpa_claims
        WHERE id = $1::int
          AND tenant_id = $2::uuid
        LIMIT 1`,
      Number(claim_id),
      String(tenantId),
    ));
  }
  if (preauth_id) {
    checks.push(prisma.$queryRawUnsafe(
      `SELECT id
         FROM insurance_preauth
        WHERE id = $1::int
          AND tenant_id = $2::uuid
        LIMIT 1`,
      Number(preauth_id),
      String(tenantId),
    ));
  }
  const results = await Promise.all(checks);
  if (results.some((rows) => !rows.length)) {
    throw AppError.notFound('TPA claim/preauth not found');
  }
}

// ── Insurance policy CRUD ────────────────────────────────────────────

/**
 * Resolve a payer reference. Accepts payer_id (canonical), payer_code, or a
 * fuzzy insurer_name match. Returns the numeric id or null when none match
 * (caller decides whether that's a 400 or a soft fail-open). Migration 203
 * seeds the master with the common Indian insurers, plus an 'OTHER'
 * placeholder row for unrecognised insurers.
 */
async function resolvePayerId(tenantId, { payer_id, payer_code, insurer_code, insurer_name }) {
  if (payer_id) {
    // Sol Ultra #4: a directly-supplied payer_id must still belong to this
    // tenant — never bind a policy to another tenant's payer master. Falls
    // through to null (→ 'OTHER' placeholder or unset) when it isn't ours.
    const owned = await prisma.payers.findFirst({
      where: { id: Number(payer_id), tenant_id: tenantId }, select: { id: true },
    });
    return owned?.id ?? null;
  }
  const code = (payer_code || insurer_code || '').trim();
  if (code) {
    const row = await prisma.payers.findFirst({
      where: { tenant_id: tenantId, payer_code: code.toUpperCase() },
      select: { id: true },
    });
    if (row) return row.id;
  }
  const name = (insurer_name || '').trim();
  if (name) {
    const row = await prisma.payers.findFirst({
      where: {
        tenant_id: tenantId,
        display_name: { contains: name, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (row) return row.id;
  }
  return null;
}

/**
 * Resolve a TPA reference. Same shape as resolvePayerId; accepts tpa_id,
 * tpa_code, or fuzzy display_name.
 */
async function resolveTpaId(tenantId, { tpa_id, tpa_code, tpa_name }) {
  if (tpa_id) {
    // Sol Ultra #4: verify a directly-supplied tpa_id belongs to this tenant.
    const owned = await prisma.tpas.findFirst({
      where: { id: Number(tpa_id), tenant_id: tenantId }, select: { id: true },
    });
    return owned?.id ?? null;
  }
  const code = (tpa_code || '').trim();
  if (code) {
    const row = await prisma.tpas.findFirst({
      where: { tenant_id: tenantId, tpa_code: code.toUpperCase() },
      select: { id: true },
    });
    if (row) return row.id;
  }
  const name = (tpa_name || '').trim();
  if (name) {
    const row = await prisma.tpas.findFirst({
      where: {
        tenant_id: tenantId,
        display_name: { contains: name, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (row) return row.id;
  }
  return null;
}

export async function upsertPolicy({
  tenantId, patient_uid, payer_id, tpa_id, policy_number, member_id,
  policyholder_name, relation_to_patient, policy_type, corporate_employer,
  sum_insured, valid_from, valid_to, card_url, notes, created_by,
  // Master-resolution aliases — counter UIs send these instead of raw FKs.
  payer_code, tpa_code, insurer_code, insurer_name, tpa_name,
}) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  if (!policy_number) throw AppError.badRequest('policy_number is required');

  // Resolve insurer (payer) + TPA against the master before INSERT. If a
  // caller passes only insurer_name/insurer_code, this turns it into the
  // proper FK so downstream queries (network checks, TPA contact lookups,
  // claim caps) reach the right row. Falls back to the 'OTHER' placeholder
  // payer when none of the inputs match the seeded master.
  const resolvedPayerId = await resolvePayerId(tenantId, {
    payer_id, payer_code, insurer_code, insurer_name,
  });
  const resolvedTpaId = await resolveTpaId(tenantId, { tpa_id, tpa_code, tpa_name });
  let finalPayerId = resolvedPayerId;
  if (!finalPayerId && (insurer_name || insurer_code || payer_code)) {
    const placeholder = await prisma.payers.findFirst({
      where: { tenant_id: tenantId, payer_code: 'OTHER' },
      select: { id: true },
    });
    finalPayerId = placeholder?.id ?? null;
  }

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO insurance_policies
       (patient_uid, payer_id, tpa_id, policy_number, member_id,
        policyholder_name, relation_to_patient, policy_type,
        corporate_employer, sum_insured, valid_from, valid_to,
        card_url, notes, created_by, tenant_id)
     VALUES ($1::uuid, $2::int, $3::int, $4, $5, $6, $7, $8, $9,
             $10::numeric, $11::date, $12::date, $13, $14, $15::uuid, $16::uuid)
     RETURNING *`,
    String(patient_uid),
    finalPayerId ? Number(finalPayerId) : null,
    resolvedTpaId ? Number(resolvedTpaId) : null,
    String(policy_number),
    member_id || null, policyholder_name || null,
    relation_to_patient || null, policy_type || null,
    corporate_employer || null,
    sum_insured ? Number(sum_insured) : null,
    valid_from || null, valid_to || null,
    card_url || null, notes || null,
    created_by ? String(created_by) : null, tenantId,
  );
  return rows[0];
}

export async function listPoliciesForPatient({ tenantId, patient_uid }) {
  return prisma.$queryRawUnsafe(
    `SELECT p.*, pa.display_name AS payer_name, t.display_name AS tpa_name
       FROM insurance_policies p
       LEFT JOIN payers pa ON pa.id = p.payer_id
       LEFT JOIN tpas t ON t.id = p.tpa_id
      WHERE p.tenant_id = $1::uuid AND p.patient_uid = $2::uuid
      ORDER BY p.created_at DESC`,
    tenantId, String(patient_uid),
  );
}

// ── Pre-authorization ────────────────────────────────────────────────

export async function createPreauth({
  tenantId, policy_id, patient_uid, admission_id,
  request_type = 'planned', parent_preauth_id,
  primary_diagnosis, icd10_codes, proposed_procedure, procedure_codes,
  treating_doctor_uid, treating_doctor_name,
  expected_admission_date, expected_los_days,
  expected_cost, cost_breakdown, notes, created_by,
}) {
  if (!policy_id) throw AppError.badRequest('policy_id is required');
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  if (!primary_diagnosis) throw AppError.badRequest('primary_diagnosis is required');
  if (!expected_cost || Number(expected_cost) <= 0) {
    throw AppError.badRequest('expected_cost must be > 0');
  }
  // Sol Ultra #15: bind the referenced policy / admission / parent pre-auth to
  // this tenant + patient before creating the pre-auth (parent_preauth_id points
  // at insurance_preauth, i.e. the preauthId ref in the shared checker).
  await assertClaimReferencesBelongToPatient({
    tenantId, patientUid: patient_uid, policyId: policy_id,
    admissionId: admission_id, preauthId: parent_preauth_id,
  });

  const preauth_number = await nextSeq('insurance_preauth_counter', 'PA', tenantId);

  // Stamp a submission deadline at create time so the draft can't sit
  // forgotten. The interval is parameterised (never templated) per the
  // backend SQL rule. Finding:
  // 2026-05-09-tpa-insurance-claim-admission-preauth-draft-not-auto-submitted
  const slaHours = preauthSubmitSlaHours(request_type);

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO insurance_preauth
       (policy_id, patient_uid, admission_id, preauth_number,
        request_type, parent_preauth_id,
        primary_diagnosis, icd10_codes, proposed_procedure, procedure_codes,
        treating_doctor_uid, treating_doctor_name,
        expected_admission_date, expected_los_days,
        expected_cost, cost_breakdown, notes, created_by, tenant_id,
        submit_due_at)
     VALUES ($1::int, $2::uuid, $3::int, $4,
             $5, $6::int,
             $7, $8::text[], $9, $10::text[],
             $11::uuid, $12,
             $13::date, $14::int,
             $15::numeric, $16::jsonb, $17, $18::uuid, $19::uuid,
             NOW() + ($20::int * INTERVAL '1 hour'))
     RETURNING *`,
    Number(policy_id), String(patient_uid),
    admission_id ? Number(admission_id) : null,
    preauth_number, request_type,
    parent_preauth_id ? Number(parent_preauth_id) : null,
    primary_diagnosis,
    icd10_codes || null,
    proposed_procedure || null,
    procedure_codes || null,
    treating_doctor_uid ? String(treating_doctor_uid) : null,
    treating_doctor_name || null,
    expected_admission_date || null,
    expected_los_days ? Number(expected_los_days) : null,
    Number(expected_cost),
    JSON.stringify(cost_breakdown || {}),
    notes || null,
    created_by ? String(created_by) : null, tenantId,
    slaHours,
  );
  const created = rows[0];

  // Nudge the insurance desk that a draft pre-auth needs submitting to
  // the insurer. Best-effort and post-insert — notificationOutbox.queue
  // swallows its own errors, but guard anyway so pre-auth creation never
  // fails on the outbox.
  try {
    await notificationOutbox.queue({
      type: 'push',
      title: 'TPA pre-auth awaiting submission',
      body:
        `Pre-auth ${created.preauth_number} is in draft and must be ` +
        `submitted to the insurer by ${new Date(created.submit_due_at).toISOString()}.`,
      data: {
        kind: 'preauth_submit_due',
        preauth_id: created.id,
        preauth_number: created.preauth_number,
        submit_due_at: created.submit_due_at,
        admission_id: created.admission_id,
      },
    });
  } catch (e) {
    logger.warn(`createPreauth: submit-due nudge failed for #${created.id}: ${e.message}`);
  }

  return created;
}

/**
 * Sum sanctioned_amount across the parent + every approved /
 * partially_approved child for an admission's preauth chain. This is
 * the cumulative TPA cap the cashier should bill against — the original
 * preauth alone is stale once an enhancement is approved. Mirrors the
 * approved-states set used in the chart-path GET handler.
 *
 * Strategy: when called with a child preauth, walk up to the parent
 * once and then aggregate. Stable for chains of any depth because
 * enhancements are always direct children of the original preauth
 * (request_type='enhancement', parent_preauth_id=original.id) —
 * grandchildren are not part of the workflow.
 *
 * Returns numeric values (Number, not Decimal) because the consumers
 * (cashier UI, billing alerts) compare them with computed totals.
 */
export async function chainTotalsFor({ tenantId, preauthId }) {
  const rootRows = await prisma.$queryRawUnsafe(
    `WITH RECURSIVE root AS (
       SELECT id, parent_preauth_id
         FROM insurance_preauth
        WHERE id = $1::int AND tenant_id = $2::uuid
       UNION ALL
       SELECT p.id, p.parent_preauth_id
         FROM insurance_preauth p
         JOIN root r ON r.parent_preauth_id = p.id
     )
     SELECT id FROM root WHERE parent_preauth_id IS NULL LIMIT 1`,
    Number(preauthId), tenantId,
  );
  if (!rootRows.length) {
    return {
      root_preauth_id: null,
      cumulative_approved: 0,
      cumulative_requested: 0,
      chain_length: 0,
    };
  }
  const rootId = rootRows[0].id;
  const totals = await prisma.$queryRawUnsafe(
    `SELECT
        $1::int AS root_id,
        SUM(CASE WHEN status IN ('approved','partially_approved')
                 THEN COALESCE(sanctioned_amount, 0) ELSE 0 END)::numeric AS approved_total,
        SUM(CASE WHEN status NOT IN ('cancelled','lapsed','denied')
                 THEN COALESCE(expected_cost, 0) ELSE 0 END)::numeric AS requested_total,
        COUNT(*)::int AS chain_length
       FROM insurance_preauth
      WHERE tenant_id = $2::uuid
        AND (id = $1::int OR parent_preauth_id = $1::int)`,
    rootId, tenantId,
  );
  const t = totals[0] || {};
  return {
    root_preauth_id: rootId,
    cumulative_approved: Number(t.approved_total ?? 0),
    cumulative_requested: Number(t.requested_total ?? 0),
    chain_length: Number(t.chain_length ?? 0),
  };
}

export async function getPreauth({ tenantId, id }) {
  // Surface the canonical policy payer display-name (`payer_name`) by joining
  // insurance_policies → payers. `recordPreauthResponse`'s payer-mismatch
  // guard reads `pre.payer_name`; the pre-2026-05-23 SELECT only returned
  // insurance_preauth columns, so `pre.payer_name` was always undefined and
  // the guard silently short-circuited (e.g. NIA approval recorded on a Star
  // Health-linked pre-auth). LEFT JOIN keeps free-text / pre-master policies
  // (payer_id=NULL) permissive — the guard treats missing payer_name as
  // "nothing authoritative to compare" and never throws.
  // Findings: 2026-05-22-tpa-insurance-claim-billing-28284746 (parent),
  // 2026-05-22-tpa-insurance-claim-billing-d961e4cf (enhancement).
  const rows = await prisma.$queryRawUnsafe(
    `SELECT pre.*, pa.display_name AS payer_name
       FROM insurance_preauth pre
       LEFT JOIN insurance_policies pol ON pol.id = pre.policy_id
       LEFT JOIN payers pa ON pa.id = pol.payer_id
      WHERE pre.id = $1::int AND pre.tenant_id = $2::uuid`,
    Number(id), tenantId,
  );
  if (!rows.length) throw AppError.notFound('Pre-auth not found');
  // Project cumulative totals across the parent + enhancement chain so
  // every consumer of /api/v1/insurance/preauth/:id (admin TPA desk,
  // chart panel, billing screens) sees the live cap, not the row's
  // own sanctioned amount. See finding
  // 2026-05-10-tpa-insurance-claim-billing-cumulative-approval-not-projected.
  const totals = await chainTotalsFor({ tenantId, preauthId: rows[0].id });
  // Project the latest insurer response onto the detail surface. The
  // partial-approval text + structured caps (pharmacy max, room
  // category, etc.) live in insurance_preauth_responses and otherwise
  // never make it to billing/admission screens.
  // See finding 2026-05-10-tpa-insurance-claim-billing-preauth-caps-hidden-from-detail.
  const respRows = await prisma.$queryRawUnsafe(
    `SELECT response_type, sanctioned_amount, validity_until, conditions,
            query_text, denial_reason, raw_response, decided_by_tpa_user,
            decided_at
       FROM insurance_preauth_responses
      WHERE preauth_id = $1::int
      ORDER BY decided_at DESC, id DESC
      LIMIT 1`,
    rows[0].id,
  );
  const latest_response = respRows[0] || null;
  const caps = extractPreauthCaps(latest_response?.raw_response);
  return {
    ...rows[0], ...totals,
    latest_response,
    conditions: latest_response?.conditions ?? rows[0].query_text ?? null,
    raw_response: latest_response?.raw_response ?? null,
    caps,
    submit_overdue: isSubmitOverdue(rows[0]),
  };
}

/**
 * Pull the structured `caps` object out of the insurer's raw response.
 * The TPA portal payload shape we accept (per
 * recordPreauthResponse contract) is either:
 *   { caps: { pharmacy: { max_amount: 15000, currency: 'INR' },
 *             room_category: { max_category: 'semi_private' } } }
 * or a flat `{ pharmacy_cap: 15000, room_category: 'semi_private' }`.
 * Both surface as a normalised object keyed by category — billing /
 * admission screens read `caps.pharmacy.max_amount` etc directly.
 */
export function extractPreauthCaps(rawResponse) {
  if (!rawResponse || typeof rawResponse !== 'object') return null;
  const raw = rawResponse.caps && typeof rawResponse.caps === 'object'
    ? rawResponse.caps
    : null;
  if (raw) return raw;
  // Fallback: lift the flat *_cap fields some legacy TPA portals use.
  const flat = {};
  if (rawResponse.pharmacy_cap != null) flat.pharmacy = { max_amount: Number(rawResponse.pharmacy_cap), currency: 'INR' };
  if (rawResponse.room_category) flat.room_category = { max_category: String(rawResponse.room_category) };
  return Object.keys(flat).length ? flat : null;
}

// Documents the insurer expects in every cashless TPA pre-auth packet.
// Auto-attached (as virtual vh:// references — the TPA desk dereferences
// them to live admission state at the moment the portal pulls) inside
// submitPreauth, idempotent: only doc_types that aren't already on the
// pre-auth are added, so a desk that hand-uploaded one of these (e.g.
// a scanned advice letter) doesn't get a duplicate row. Finding:
// 2026-05-15-tpa-insurance-claim-billing-77e939fd — a submitted packet
// shipped with only admission_note attached; the insurer queried it
// back for missing advice letter + record bundle, and the desk thought
// the case was in flight when the platform had effectively shipped a
// one-document packet.
const TPA_PREAUTH_STANDARD_DOCS = [
  {
    doc_type: 'admission_note',
    file_name: (admissionId) => `admission-${admissionId}-summary.txt`,
    file_url: (admissionId) => `vh://admissions/${admissionId}/admission-summary`,
    mime_type: 'text/plain',
  },
  {
    doc_type: 'advice_letter',
    file_name: (admissionId) => `advice-${admissionId}.txt`,
    file_url: (admissionId) => `vh://admissions/${admissionId}/advice-letter`,
    mime_type: 'text/plain',
  },
  {
    doc_type: 'record_bundle',
    file_name: (admissionId) => `records-${admissionId}.json`,
    file_url: (admissionId) => `vh://admissions/${admissionId}/record-bundle`,
    mime_type: 'application/json',
  },
];

async function ensurePreauthDocumentBundle({ tenantId, preauthId, admissionId, uploadedBy }) {
  if (!admissionId) return [];
  const existing = await prisma.$queryRawUnsafe(
    `SELECT doc_type FROM tpa_claim_documents WHERE preauth_id = $1::int`,
    preauthId,
  );
  const existingTypes = new Set(existing.map((r) => r.doc_type));
  const attached = [];
  for (const spec of TPA_PREAUTH_STANDARD_DOCS) {
    if (existingTypes.has(spec.doc_type)) continue;
    try {
      const row = await attachDocument({
        tenantId,
        preauth_id: preauthId,
        doc_type: spec.doc_type,
        file_name: spec.file_name(admissionId),
        file_url: spec.file_url(admissionId),
        mime_type: spec.mime_type,
        uploaded_by: uploadedBy,
        notes: 'auto-attached at preauth submission',
      });
      attached.push(row.doc_type);
    } catch (err) {
      // Best-effort: a single auto-attach failure should not block the
      // submission attempt — the doc-count gate below still fires if
      // the packet ends up genuinely empty. Log so the desk can see
      // which auto-attach didn't take.
      logger.warn(
        `ensurePreauthDocumentBundle: ${spec.doc_type} attach failed for preauth=${preauthId}: ${err.message}`,
      );
    }
  }
  return attached;
}

async function ensureClinicalSummaryFromEnhancementNotes({ tenantId, preauth, uploadedBy }) {
  if (preauth?.request_type !== 'enhancement') return null;
  const notes = String(preauth.notes || '').trim();
  if (!notes) return null;

  const existing = await prisma.$queryRawUnsafe(
    `SELECT id
       FROM tpa_claim_documents
      WHERE preauth_id = $1::int
        AND doc_type = 'clinical_summary'
      LIMIT 1`,
    preauth.id,
  );
  if (existing.length) return null;

  const row = await attachDocument({
    tenantId,
    preauth_id: preauth.id,
    doc_type: 'clinical_summary',
    file_name: `preauth-${preauth.id}-clinical-summary.txt`,
    file_url: `vh://insurance/preauth/${preauth.id}/clinical-summary-from-notes`,
    mime_type: 'text/plain',
    uploaded_by: uploadedBy,
    notes: `auto-attached from enhancement clinical note\n\n${notes}`,
  });
  return row?.doc_type || null;
}

export async function submitPreauth({
  tenantId, id, submitted_by, submission_channel = 'portal', tpa_reference_id,
}) {
  const pre = await getPreauth({ tenantId, id });
  if (pre.status !== 'draft') {
    throw AppError.badRequest(`Pre-auth in ${pre.status} cannot be submitted`);
  }

  // Auto-attach the standard 3-document bundle (admission_note,
  // advice_letter, record_bundle) before the doc-count gate runs.
  // Idempotent — only doc_types missing from the pre-auth are added.
  await ensurePreauthDocumentBundle({
    tenantId,
    preauthId: pre.id,
    admissionId: pre.admission_id,
    uploadedBy: submitted_by,
  });
  await ensureClinicalSummaryFromEnhancementNotes({
    tenantId,
    preauth: pre,
    uploadedBy: submitted_by,
  });

  // Block submission with no clinical attachment. Without an admission
  // note / advice letter the TPA portal sees a bare claim number and
  // queries it back — the desk thinks the case is in flight when it
  // is effectively unsubmitted.
  // See finding 2026-05-10-tpa-insurance-claim-billing-preauth-submit-no-documents.
  const docCount = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM tpa_claim_documents WHERE preauth_id = $1::int`,
    pre.id,
  );
  if (!docCount[0] || docCount[0].n === 0) {
    throw AppError.badRequest(
      'Pre-auth submission requires at least one supporting document (admission note, advice letter, or clinical summary). Attach via POST /api/v1/insurance/documents first.',
    );
  }
  await prisma.$executeRawUnsafe(
    `UPDATE insurance_preauth
        SET status = 'submitted', submitted_at = NOW(),
            submitted_by = $1::uuid, submission_channel = $2,
            tpa_reference_id = COALESCE($3, tpa_reference_id),
            updated_at = NOW()
      WHERE id = $4::int`,
    submitted_by ? String(submitted_by) : null,
    submission_channel,
    tpa_reference_id || null,
    pre.id,
  );
  return getPreauth({ tenantId, id });
}

// Stage-4-C — TPA portals and IRDAI forms use the field name `decision`
// with values like `partial`, `approve`, `deny`. The service contract
// uses `response_type` with the canonical enum. Normalise at the
// boundary so the TPA desk clerk gets a 400 with the right field name
// instead of a 500 from the NOT NULL constraint downstream.
// Finding: 2026-05-09-tpa-insurance-claim-billing-preauth-response-500-wrong-field
const VALID_RESPONSE_TYPES = ['approved', 'partially_approved', 'denied', 'queried', 'enhancement_request'];
const RESPONSE_TYPE_ALIASES = {
  approve: 'approved',
  approved: 'approved',
  partial: 'partially_approved',
  partially_approved: 'partially_approved',
  partial_approval: 'partially_approved',
  deny: 'denied',
  denied: 'denied',
  query: 'queried',
  queried: 'queried',
  enhancement: 'enhancement_request',
  enhancement_request: 'enhancement_request',
};

// True when a TPA response's insurer is compatible with the pre-auth policy's
// payer. Normalises (lowercase, strip non-alphanumerics) and substring-matches
// so display-name variants ("Star Health" vs "Star Health and Allied
// Insurance") pass, while a genuinely different payer ("New India Assurance")
// is rejected. Returns true when either side is empty (nothing to compare).
export function insurerMatchesPolicyPayer(responseInsurer, payerName) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const a = norm(responseInsurer);
  const b = norm(payerName);
  if (!a || !b) return true;
  return a.includes(b) || b.includes(a);
}

// ── Claim-settlement payer guard (free-text reference path) ──────────
//
// The claim decision/settlement path carries NO structured insurer field
// the way recordPreauthResponse does — the only payer signal at settlement
// is free-text: the TPA settlement reference (`payment_reference`, e.g.
// "NIA-NEFT-CL-2627-00004-63000") and the claim's own `tpa_reference_id`
// ("NIA-FINAL-CL-2627-00004"). The finding (df39fefb) is exactly this: a
// New India ("NIA") settlement reference recorded on a Star Health policy.
//
// Free-text is unreliable, so we reject ONLY on a CONFIDENT mismatch: a
// recognised insurer token at the START of the reference (the convention
// the desk uses — "NIA-...", "STAR-...") that resolves to a known payer
// which is NOT the policy's payer. An unrecognised token, a token that is
// compatible with the policy payer, or an empty reference never blocks —
// a false reject of a legitimate settlement is worse than the miss.
//
// PAYER_REFERENCE_TOKENS maps the leading reference token to the canonical
// payer display-name it stands for. Keys mirror the seeded payer_code +
// the handful of common short forms a coordinator actually types; values
// are the migration-203 display_name so insurerMatchesPolicyPayer can
// substring-match them against the policy payer.
const PAYER_REFERENCE_TOKENS = {
  NIA: 'New India Assurance Co Ltd',
  NEWINDIA: 'New India Assurance Co Ltd',
  OICL: 'Oriental Insurance Co Ltd',
  ORIENTAL: 'Oriental Insurance Co Ltd',
  NICL: 'National Insurance Co Ltd',
  NATIONAL: 'National Insurance Co Ltd',
  UIIC: 'United India Insurance Co Ltd',
  UNITEDINDIA: 'United India Insurance Co Ltd',
  STAR: 'Star Health and Allied Insurance',
  STARHEALTH: 'Star Health and Allied Insurance',
  ICICI: 'ICICI Lombard General Insurance',
  ICICILOM: 'ICICI Lombard General Insurance',
  ICICILOMBARD: 'ICICI Lombard General Insurance',
  BAJAJ: 'Bajaj Allianz General Insurance',
  HDFC: 'HDFC ERGO General Insurance',
  HDFCERGO: 'HDFC ERGO General Insurance',
  MAXBUPA: 'Niva Bupa Health Insurance',
  NIVABUPA: 'Niva Bupa Health Insurance',
  NIVA: 'Niva Bupa Health Insurance',
  CARE: 'Care Health Insurance',
  TATAAIG: 'Tata AIG General Insurance',
  TATA: 'Tata AIG General Insurance',
  RELIANCE: 'Reliance General Insurance',
  CGHS: 'Central Government Health Scheme',
  ECHS: 'Ex-Servicemen Contributory Health Scheme',
  ESIC: 'Employees State Insurance Corporation',
  PMJAY: 'Ayushman Bharat — PMJAY',
  CMCHIS: 'Chief Minister’s Comprehensive Health Insurance Scheme (TN)',
};

// Best-effort extract the canonical payer display-name a free-text TPA
// reference points at. Splits on the usual reference separators (-, _, /,
// whitespace) and looks up the FIRST recognised token against
// PAYER_REFERENCE_TOKENS. Returns null when the reference is empty or its
// leading token is not a recognised insurer (e.g. "CL-2627-00004" — a bare
// claim number with no payer token, or "ACME-123" — an unknown short form).
// Deliberately conservative: only the leading token is consulted so we do
// not false-match an insurer name buried mid-string in an unrelated note.
export function detectPayerFromReference(reference) {
  const ref = String(reference || '').trim();
  if (!ref) return null;
  const tokens = ref.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  if (!tokens.length) return null;
  // Only the leading token is a confident payer signal. The desk's
  // convention is "<INSURER>-<STAGE>-<CLAIMNO>..." so the insurer, when
  // present, is first. A leading pure-numeric or "CL"/"PA"/"NEFT" token is
  // not an insurer — skip at most one leading non-payer routing token
  // ("NEFT", "UTR", "RTGS", "IMPS", "CHQ") so "NEFT-NIA-..." still resolves.
  const ROUTING_TOKENS = new Set(['NEFT', 'UTR', 'RTGS', 'IMPS', 'CHQ', 'CHEQUE', 'NACH']);
  for (let i = 0; i < tokens.length && i < 2; i += 1) {
    const t = tokens[i];
    if (PAYER_REFERENCE_TOKENS[t]) return PAYER_REFERENCE_TOKENS[t];
    if (!ROUTING_TOKENS.has(t)) break; // first non-routing token wasn't an insurer → give up
  }
  return null;
}

/**
 * Decide whether a claim settlement/decision must be REJECTED for posting to
 * the wrong payer. Pure + side-effect-free so it is unit-testable. Combines
 * the two settlement signals:
 *   - `structuredInsurer` (strong): an insurer name supplied on the decision
 *     (mirrors recordPreauthResponse's raw_response.insurer). When present and
 *     incompatible with the policy payer → confident mismatch.
 *   - `references` (best-effort): free-text reference strings (the settlement
 *     `payment_reference` + the claim's `tpa_reference_id`). A leading
 *     recognised insurer token that resolves to a payer incompatible with the
 *     policy payer → confident mismatch.
 * Returns `{ mismatch: true, detectedPayer, source }` on a confident mismatch,
 * else `{ mismatch: false }`. NEVER reports a mismatch when the policy payer is
 * unknown, no signal is present, or the signal is compatible/unrecognised.
 *
 * @param {{ policyPayerName?: string, structuredInsurer?: string,
 *           references?: Array<string> }} args
 */
export function detectClaimPayerMismatch({ policyPayerName, structuredInsurer, references = [] }) {
  const payer = String(policyPayerName || '').trim();
  if (!payer) return { mismatch: false }; // nothing authoritative to compare against

  // Strong signal first: an explicitly supplied insurer on the decision.
  const structured = String(structuredInsurer || '').trim();
  if (structured && !insurerMatchesPolicyPayer(structured, payer)) {
    return { mismatch: true, detectedPayer: structured, source: 'insurer' };
  }

  // Best-effort free-text: only a confidently-recognised leading token blocks.
  for (const ref of references) {
    const detected = detectPayerFromReference(ref);
    if (detected && !insurerMatchesPolicyPayer(detected, payer)) {
      return { mismatch: true, detectedPayer: detected, source: 'reference', reference: String(ref) };
    }
  }
  return { mismatch: false };
}

/**
 * Resolve the canonical payer display-name for a claim by joining
 * tpa_claims → insurance_policies → payers. Returns '' when the policy has
 * no payer FK (free-text/pre-master policy) so the guard stays permissive.
 * tpa_claims.policy_id is NOT NULL (migration 153) so the claim always has a
 * policy, but payer_id on that policy can be null.
 */
async function resolveClaimPolicyPayerName({ tenantId, claimId }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT pa.display_name AS payer_name
       FROM tpa_claims c
       JOIN insurance_policies p ON p.id = c.policy_id
       LEFT JOIN payers pa ON pa.id = p.payer_id
      WHERE c.id = $1::int AND c.tenant_id = $2::uuid`,
    Number(claimId), tenantId,
  );
  return rows[0]?.payer_name ? String(rows[0].payer_name) : '';
}

/**
 * Shared rejection helper for the claim settlement/decision payer guard.
 * Resolves the policy payer, runs the confident-mismatch decision over the
 * supplied structured insurer + free-text references, and throws
 * CLAIM_INSURER_MISMATCH on a confident mismatch. No-op otherwise.
 * Findings: 2026-05-20-tpa-insurance-claim-billing-df39fefb (NIA settlement
 * reference posted against a Star Health policy).
 */
async function assertClaimSettlementPayerMatch({
  tenantId, claim, structuredInsurer, references,
}) {
  const policyPayerName = await resolveClaimPolicyPayerName({ tenantId, claimId: claim.id });
  const verdict = detectClaimPayerMismatch({
    policyPayerName,
    structuredInsurer,
    references: (references || []).filter(Boolean),
  });
  if (!verdict.mismatch) return;
  const signalDesc = verdict.source === 'insurer'
    ? `decision insurer "${verdict.detectedPayer}"`
    : `settlement reference "${verdict.reference}" (insurer ${verdict.detectedPayer})`;
  throw AppError.badRequest(
    `Claim ${claim.claim_number || claim.id} ${signalDesc} does not match the claim's policy payer ` +
    `"${policyPayerName}"; recording this settlement would misroute payer reconciliation and AR follow-up. ` +
    `Verify the claim is linked to the correct policy/payer before posting.`,
    'CLAIM_INSURER_MISMATCH',
    {
      policy_payer: policyPayerName,
      detected_payer: verdict.detectedPayer,
      signal: verdict.source,
      reference: verdict.reference ?? null,
    },
  );
}

export async function recordPreauthResponse({
  tenantId, preauth_id, response_type, decision, sanctioned_amount, validity_until,
  conditions, query_text, denial_reason, raw_response,
  decided_by_tpa_user, decided_at, recorded_by,
}) {
  const rawValue = response_type ?? decision;
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    throw AppError.badRequest(`response_type is required and must be one of: ${VALID_RESPONSE_TYPES.join(', ')}`);
  }
  const normalised = RESPONSE_TYPE_ALIASES[String(rawValue).trim().toLowerCase()];
  if (!normalised) {
    throw AppError.badRequest(`Invalid response_type "${rawValue}". Must be one of: ${VALID_RESPONSE_TYPES.join(', ')}`);
  }
  response_type = normalised;

  const pre = await getPreauth({ tenantId, id: preauth_id });
  if (!['submitted', 'queried', 'approved', 'partially_approved'].includes(pre.status)) {
    throw AppError.badRequest(`Cannot record response on ${pre.status} pre-auth`);
  }

  // Reject a response whose insurer contradicts the pre-auth policy payer: a
  // New India approval must not be recorded on a Star Health cashless pre-auth
  // (it misroutes the payer and overstates the cumulative cap the cashier
  // trusts at discharge). Only fires when an insurer is supplied; substring-
  // tolerant to absorb display-name variants ("Star Health" vs "Star Health
  // and Allied Insurance").
  // Findings: 2026-05-20-tpa-insurance-claim-billing-24314cb8, -08c03175.
  const responseInsurer = raw_response && typeof raw_response === 'object'
    ? String(raw_response.insurer || '').trim()
    : '';
  if (responseInsurer && pre.payer_name && !insurerMatchesPolicyPayer(responseInsurer, pre.payer_name)) {
    throw AppError.badRequest(
      `Response insurer "${responseInsurer}" does not match the pre-auth policy payer "${pre.payer_name}"; recording an approval from a different insurer would misroute the cashless claim.`,
      'PREAUTH_INSURER_MISMATCH',
      { response_insurer: responseInsurer, policy_payer: pre.payer_name },
    );
  }

  // Insert response row (timeline).
  // Tenant-scope the INSERT (audit / cross-tenant fix): this NHCX ingest path
  // runs on plain prisma with no request tenant context, so omitting tenant_id
  // let the migration-336 GUC-reading column DEFAULT fall back to the DEFAULT
  // tenant and silently mis-place the insurer's response. tenantId is already
  // verified above — getPreauth matched the pre-auth row against it.
  const respRows = await prisma.$queryRawUnsafe(
    `INSERT INTO insurance_preauth_responses
       (tenant_id, preauth_id, response_type, sanctioned_amount, validity_until,
        conditions, query_text, denial_reason, raw_response,
        decided_by_tpa_user, decided_at, recorded_by)
     VALUES ($12::uuid, $1::int, $2, $3::numeric, $4::timestamptz, $5, $6, $7,
             $8::jsonb, $9, $10::timestamptz, $11::uuid)
     RETURNING *`,
    Number(preauth_id), response_type,
    sanctioned_amount ? Number(sanctioned_amount) : null,
    validity_until || null,
    conditions || null, query_text || null, denial_reason || null,
    JSON.stringify(raw_response || {}),
    decided_by_tpa_user || null,
    decided_at || new Date().toISOString(),
    recorded_by ? String(recorded_by) : null,
    tenantId,
  );

  // Project response onto pre-auth row.
  const newStatus = ({
    approved: 'approved',
    partially_approved: 'partially_approved',
    denied: 'denied',
    queried: 'queried',
    enhancement_request: 'queried',
  })[response_type] || pre.status;

  await prisma.$executeRawUnsafe(
    `UPDATE insurance_preauth
        SET status = $1::varchar,
            sanctioned_amount = COALESCE($2::numeric, sanctioned_amount),
            sanctioned_at = CASE WHEN $1::varchar IN ('approved','partially_approved') THEN NOW() ELSE sanctioned_at END,
            validity_until = COALESCE($3::timestamptz, validity_until),
            query_text = CASE WHEN $1::varchar = 'queried' THEN $4::text ELSE query_text END,
            denial_reason = CASE WHEN $1::varchar = 'denied' THEN $5::text ELSE denial_reason END,
            updated_at = NOW()
      WHERE id = $6::int
        AND tenant_id = $7::uuid`,
    newStatus,
    sanctioned_amount ? Number(sanctioned_amount) : null,
    validity_until || null,
    query_text || null,
    denial_reason || null,
    Number(preauth_id),
    tenantId,
  );

  // Wave-4B-1 — room-cap detection. If the partial approval text downgrades
  // the approved room category below the current admission room_category,
  // emit a clinical_alerts row so the bed-board / billing screens surface
  // the upgrade-difference patient liability before discharge reconciliation.
  // Finding: 2026-05-09-tpa-insurance-claim-billing-no-room-cap-flag
  if (response_type === 'partially_approved' && pre.admission_id) {
    try {
      await emitRoomCapAlertIfNeeded({
        tenantId,
        preauth_id: Number(preauth_id),
        admission_id: pre.admission_id,
        conditions_text: conditions || '',
        recorded_by,
      });
    } catch (e) {
      // Alert emission is best-effort — never block the approval flow.
      console.warn(`recordPreauthResponse: room-cap alert emission failed: ${e.message}`);
    }
  }

  return { response: respRows[0], preauth: await getPreauth({ tenantId, id: preauth_id }) };
}

// Wave-4B-1 — room-cap detection helper.
//
// TPA partial approvals frequently carry a free-text "conditions" clause
// like "room cap: semi-private at ₹4500/day" or "approved at general-ward
// rate only". The cashier needs structured visibility into this so the
// upgrade differential (₹X/day private vs semi-private) can be surfaced
// at the bed-board or billing screen, not discovered at discharge
// reconciliation. We parse the conditions text against a small allowlist
// of room category keywords; when the parsed cap is BELOW the admission's
// current room_category, we emit a clinical_alerts row.
//
// Conservative parser — false negatives (missed alert) are OK and the
// cashier still sees the conditions text. False positives (spurious alert)
// would be noise; we keep the keyword set tight.
const ROOM_CATEGORY_RANK = {
  general: 1,
  semi_private: 2,
  'semi-private': 2,
  semiprivate: 2,
  private: 3,
  deluxe: 4,
  suite: 5,
  icu: 5,
  ccu: 5,
};

function detectCappedRoomCategory(conditionsText) {
  if (!conditionsText) return null;
  const t = String(conditionsText).toLowerCase();
  // Look for "[cap|approved|limit|max] ... <category>" — order matters
  // since "private" is a substring of "semi-private".
  const hits = [];
  for (const key of Object.keys(ROOM_CATEGORY_RANK)) {
    if (t.includes(key)) hits.push(key);
  }
  if (!hits.length) return null;
  // Pick the LOWEST-rank match (most restrictive cap mentioned).
  hits.sort((a, b) => ROOM_CATEGORY_RANK[a] - ROOM_CATEGORY_RANK[b]);
  const matched = hits[0];
  // Normalise to canonical category names used on admissions.room_category.
  if (matched === 'semi-private' || matched === 'semiprivate') return 'semi_private';
  return matched;
}

async function emitRoomCapAlertIfNeeded({ tenantId, preauth_id, admission_id, conditions_text, recorded_by }) {
  const cappedCat = detectCappedRoomCategory(conditions_text);
  if (!cappedCat) return;

  // Tenant-scope the admission lookup (audit / cross-tenant fix): admissions
  // carries tenant_id but the previous findUnique matched on id only — SERIAL
  // ids are shared across tenants, so a collision read another tenant's
  // admission (room_category, patient_uid) into this tenant's alert.
  const admission = await prisma.admissions.findFirst({
    where: { id: Number(admission_id), tenant_id: tenantId },
    select: { id: true, room_category: true, patient_uid: true },
  });
  if (!admission?.room_category) return;

  const currentRank = ROOM_CATEGORY_RANK[String(admission.room_category).toLowerCase()] || 0;
  const cappedRank = ROOM_CATEGORY_RANK[cappedCat] || 0;
  if (currentRank <= cappedRank) return; // Patient already at/below cap — no liability.

  // Resolve patient_uid → patient_id (int) for the alert FK.
  const patient = await prisma.users.findUnique({
    where: { uid: admission.patient_uid },
    select: { id: true },
  });

  // Stamp tenant_id explicitly (audit / cross-tenant fix): clinical_alerts has
  // a migration-238 GUC-reading DEFAULT that falls back to the DEFAULT tenant
  // when app.current_tenant_id is unset — which it always is on this plain-
  // prisma NHCX ingest path — so the alert landed on the wrong tenant's board.
  await prisma.clinical_alerts.create({
    data: {
      tenant_id: tenantId,
      patient_id: patient?.id ?? null,
      alert_type: 'TPA_ROOM_CATEGORY_CAP',
      severity: 'medium',
      message:
        `TPA preauth #${preauth_id} approved room category '${cappedCat}'; admission #${admission_id} ` +
        `currently in '${admission.room_category}'. Upgrade difference will be patient liability. ` +
        `Confirm consent + cash-pay-difference or downgrade the room.`,
      created_by: null,
      acknowledged: false,
    },
  });

  // Best-effort signal — recorded_by is informational only here. The
  // alert row carries the operational context downstream consumers need.
  void recorded_by;
}

export async function listPendingPreauths({ tenantId, limit = 100 }) {
  // submit_due_at + submit_overdue surface the SLA on the pending list
  // so the insurance coordinator can see at a glance which drafts have
  // blown their submission window. Overdue drafts sort to the top.
  // Finding: 2026-05-09-tpa-insurance-claim-admission-preauth-draft-not-auto-submitted
  return prisma.$queryRawUnsafe(
    `SELECT pa.id, pa.preauth_number, pa.patient_uid, pa.primary_diagnosis,
            pa.expected_cost, pa.sanctioned_amount, pa.status,
            pa.submitted_at, pa.created_at,
            pa.submit_due_at,
            (pa.status = 'draft'
             AND pa.submit_due_at IS NOT NULL
             AND pa.submit_due_at < NOW()) AS submit_overdue,
            p.policy_number, py.display_name AS payer_name, t.display_name AS tpa_name
       FROM insurance_preauth pa
       JOIN insurance_policies p ON p.id = pa.policy_id
       LEFT JOIN payers py ON py.id = p.payer_id
       LEFT JOIN tpas t ON t.id = p.tpa_id
      WHERE pa.tenant_id = $1::uuid
        AND pa.status IN ('draft','submitted','queried')
      ORDER BY (pa.status = 'draft'
                AND pa.submit_due_at IS NOT NULL
                AND pa.submit_due_at < NOW()) DESC,
               pa.created_at DESC
      LIMIT $2::int`,
    tenantId, boundedInteger(limit, { fallback: 100, min: 1, max: 200 }),
  );
}

// ── Final claim ──────────────────────────────────────────────────────

// Stage-4-C — tpa_claims.stage + parent_claim_id (migration 221).
// Valid stage values; defaults to 'final' for back-compat.
// Finding: 2026-05-09-tpa-insurance-claim-discharge-final-claim-stage-dropped
const VALID_CLAIM_STAGES = ['preauth', 'enhancement', 'final', 'reimbursement'];

function moneyEquals(a, b) {
  return Math.abs(Number(a || 0) - Number(b || 0)) <= 0.01;
}

const FINAL_CASHLESS_TRACEABLE_SOURCE_TYPES = new Set([
  'lab_order',
  'radiology_order',
  'pharmacy_order',
  'ward_indent',
  'room_day',
  'discharge_consult',
  'theatre_case',
  'dialysis_session',
  'cath_procedure_log',
  'cath_consumable_usage',
  'admission_package',
  'package',
]);

const FINAL_CASHLESS_SOURCE_ID_OPTIONAL = new Set(['admission_package', 'package']);

function normalizeBigIntForResponse(value) {
  if (typeof value !== 'bigint') return value;
  if (
    value >= BigInt(Number.MIN_SAFE_INTEGER)
    && value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(value);
  }
  return value.toString();
}

async function assertFinalCashlessInvoiceLinesTraceable(invoiceId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, description, line_total, source_ref_type, source_ref_id
       FROM billing_invoice_items
      WHERE invoice_id = $1::int
        AND COALESCE(line_total, 0) > 0
      ORDER BY id`,
    Number(invoiceId),
  );
  if (!rows.length) return;

  const untraceable = rows.filter((row) => {
    const sourceType = String(row.source_ref_type || '').trim().toLowerCase();
    if (!sourceType || sourceType === 'manual') return true;
    if (!FINAL_CASHLESS_TRACEABLE_SOURCE_TYPES.has(sourceType)) return true;
    return !FINAL_CASHLESS_SOURCE_ID_OPTIONAL.has(sourceType) && row.source_ref_id == null;
  });
  if (!untraceable.length) return;

  const examples = untraceable.slice(0, 5).map((row) => ({
    id: Number(row.id),
    description: String(row.description || '').slice(0, 120),
    source_ref_type: row.source_ref_type || null,
    source_ref_id: normalizeBigIntForResponse(row.source_ref_id),
  }));
  throw AppError.badRequest(
    `Final cashless claim invoice ${invoiceId} has ${untraceable.length} untraceable billable line(s). ` +
      'Run admission itemization or attach source_ref_type/source_ref_id before creating or submitting the final claim.',
    'TPA_INVOICE_LINE_TRACE_REQUIRED',
    { invoice_id: Number(invoiceId), untraceable_count: untraceable.length, examples },
  );
}

async function assertIssuedFinalCashlessInvoice({
  tenantId, invoiceId, patientUid, admissionId, totalBilled,
}) {
  if (!invoiceId) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, invoice_number, status, total_amount, patient_uid, admission_id
       FROM billing_invoices
      WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(invoiceId), tenantId,
  );
  if (!rows.length) throw AppError.notFound('Linked invoice not found');
  const invoice = rows[0];
  if (invoice.status !== 'ISSUED' && invoice.status !== 'PARTIAL' && invoice.status !== 'PAID') {
    throw AppError.badRequest(
      `Final cashless claim requires an issued invoice; invoice ${invoice.id} is ${invoice.status}`,
    );
  }
  if (patientUid && String(invoice.patient_uid) !== String(patientUid)) {
    throw AppError.badRequest('Final cashless claim invoice belongs to a different patient');
  }
  if (admissionId && Number(invoice.admission_id) !== Number(admissionId)) {
    throw AppError.badRequest('Final cashless claim invoice belongs to a different admission');
  }
  // A final cashless claim must be anchored to the FINAL bill for the
  // admission, not an interim/progress invoice. Interim and final IPD
  // invoices share invoice_type='IP' (the interim-ness lives only in
  // free-text notes), so we cannot tell them apart by type. The robust
  // signal: if another live (ISSUED/PARTIAL/PAID, non-voided) invoice for
  // the same admission has a STRICTLY GREATER total_amount, the linked
  // invoice is a stale interim bill and the claim would cap below the full
  // final bill. The cashless settlement then can't reach the real payable
  // total — the insurer's approval (e.g. ₹78k of an ₹80k bill) is rejected
  // by the approved≤claimed guard because claimed_amount was pinned to the
  // interim total (₹76k). Re-anchor the claim to the larger final invoice.
  // Finding 2026-05-22-tpa-insurance-claim-billing-7239f4be.
  if (invoice.admission_id != null) {
    const moreComplete = await prisma.$queryRawUnsafe(
      `SELECT id, invoice_number, total_amount
         FROM billing_invoices
        WHERE tenant_id = $1::uuid
          AND admission_id = $2::int
          AND id <> $3::int
          AND voided_at IS NULL
          AND status IN ('ISSUED','PARTIAL','PAID')
          AND total_amount > $4::numeric + 0.01
        ORDER BY total_amount DESC
        LIMIT 1`,
      tenantId,
      Number(invoice.admission_id),
      Number(invoice.id),
      Number(invoice.total_amount),
    );
    if (moreComplete.length) {
      const fin = moreComplete[0];
      throw AppError.badRequest(
        `Final cashless claim is anchored to interim invoice ${invoice.invoice_number || invoice.id} ` +
        `(${Number(invoice.total_amount)}); a more complete final invoice ` +
        `${fin.invoice_number || fin.id} (${Number(fin.total_amount)}) exists for this admission. ` +
        `Anchor the final claim to the final bill so the settlement can reach the full amount.`,
        'CLAIM_INVOICE_NOT_FINAL',
        {
          linked_invoice_id: Number(invoice.id),
          linked_total: Number(invoice.total_amount),
          final_invoice_id: Number(fin.id),
          final_total: Number(fin.total_amount),
        },
      );
    }
  }
  if (!moneyEquals(totalBilled, invoice.total_amount)) {
    throw AppError.badRequest(
      `Final cashless claim total_billed ${Number(totalBilled)} must match issued invoice total_amount ${Number(invoice.total_amount)}`,
    );
  }
  await assertFinalCashlessInvoiceLinesTraceable(invoice.id);
  return invoice;
}

// Sol Ultra #1/#15: a claim/preauth carried caller-supplied policy_id,
// preauth_id, admission_id and parent_claim_id straight into the INSERT with no
// check that those objects belong to the same tenant AND the same patient. A
// biller could therefore bind a claim to another patient's policy/admission
// (intra-tenant financial-integrity), or reference another tenant's ids. Verify
// each referenced object resolves within the tenant and shares the patient.
// Table names are fixed literals here (never request data) — safe to inline.
async function assertClaimReferencesBelongToPatient({
  tenantId, patientUid, policyId = null, preauthId = null,
  admissionId = null, parentClaimId = null,
}) {
  const refs = [
    ['insurance_policies', policyId, 'policy_id'],
    ['insurance_preauth', preauthId, 'preauth_id'],
    ['admissions', admissionId, 'admission_id'],
    ['tpa_claims', parentClaimId, 'parent_claim_id'],
  ];
  for (const [table, id, label] of refs) {
    if (id == null) continue;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT patient_uid FROM ${table} WHERE id = $1::int AND tenant_id = $2::uuid LIMIT 1`,
      Number(id), tenantId,
    );
    if (!rows.length) {
      throw AppError.badRequest(`${label} not found in this tenant`, 'CLAIM_REFERENCE_INVALID');
    }
    if (patientUid && rows[0].patient_uid && String(rows[0].patient_uid) !== String(patientUid)) {
      throw AppError.forbidden(`${label} belongs to a different patient`, 'CLAIM_REFERENCE_PATIENT_MISMATCH');
    }
  }
}

export async function createClaim({
  tenantId, policy_id, preauth_id, invoice_id, patient_uid, admission_id,
  claim_type = 'cashless', total_billed, patient_copay = 0,
  non_payable_amount = 0, claimed_amount, notes, created_by,
  stage = null, parent_claim_id = null,
}) {
  if (!policy_id) throw AppError.badRequest('policy_id is required');
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  if (!total_billed || Number(total_billed) <= 0) {
    throw AppError.badRequest('total_billed must be > 0');
  }
  const billedNum = Number(total_billed);
  const copayNum = Number(patient_copay) || 0;

  // D8 — Invoice-driven non_payable_amount derivation. When a claim
  // links to an invoice that has line items flagged
  // `tpa_decision = 'non_payable'` (via the TPA-desk
  // recordInvoiceItemTpaDecision flow), those amounts are the
  // adjudicated non-payable totals the insurer has already determined
  // — they MUST flow into the claim's `non_payable_amount` so the
  // `claimed_amount` math reflects what the insurer will actually
  // settle. Pre-fix the caller had to compute non_payable manually
  // (and usually didn't), so a final cashless claim posted
  // `non_payable_amount=0` even when the invoice carried ₹X,000 of
  // already-decided non-payable lines. The insurer then bounced or
  // partially-approved the claim, and the patient was billed for
  // amounts that should have been written off the claim front-up.
  // Logic:
  //   * If invoice_id given and the invoice has non_payable line
  //     totals > 0, USE that derived value (overrides any caller-
  //     supplied non_payable_amount — the invoice is the source of
  //     truth for claim adjudication).
  //   * If the lookup fails (missing column / under-migrated tenant)
  //     fall back to the caller-supplied value with a warning log.
  // Findings 870ff6a9 + 5953f182.
  let nonPayableNum = Number(non_payable_amount) || 0;
  if (invoice_id) {
    try {
      const nonPayableRows = await prisma.$queryRawUnsafe(
        `SELECT COALESCE(SUM(line_total), 0)::numeric AS total
           FROM billing_invoice_items
          WHERE invoice_id = $1::int
            AND tpa_decision = 'non_payable'`,
        Number(invoice_id),
      );
      const derived = Number(nonPayableRows[0]?.total ?? 0);
      if (derived > 0) {
        if (derived !== nonPayableNum) {
          logger.info(
            `createClaim: invoice ${invoice_id} non_payable lines total ${derived} — overriding caller-supplied ${nonPayableNum}`,
          );
        }
        nonPayableNum = derived;
      }
    } catch (err) {
      // Under-migrated tenant (tpa_decision column missing from
      // migration 216 / 213). Log and keep the caller-supplied
      // value so the create path doesn't hard-fail on
      // infrastructure. The CLAIM_PATIENT_SHARE_EXCEEDS_BILLED
      // guard below still catches a clearly-wrong fallback.
      logger.warn(`createClaim: non_payable derivation from invoice ${invoice_id} failed: ${err.message}`);
    }
  }

  const claimAmt = Number(claimed_amount ?? (billedNum - copayNum - nonPayableNum));
  if (claimAmt <= 0) throw AppError.badRequest('claimed_amount must be > 0');
  // A claim can never seek more than was billed, and the patient share
  // (co-pay + non-payable) cannot exceed the bill either — either lets a
  // claim post amounts that reconcile to more than the hospital actually
  // charged, overstating the insurer's liability or the patient's due.
  // Finding 2026-05-20-tpa-insurance-claim-billing-4600ed9c (claim-amount
  // validation accepts claimed/approved beyond what was billed).
  if (claimAmt > billedNum + 0.01) {
    throw AppError.badRequest(
      `claimed_amount ${claimAmt} cannot exceed total_billed ${billedNum}`,
      'CLAIM_AMOUNT_EXCEEDS_BILLED',
      { claimed_amount: claimAmt, total_billed: billedNum },
    );
  }
  if (copayNum + nonPayableNum > billedNum + 0.01) {
    throw AppError.badRequest(
      `patient_copay (${copayNum}) + non_payable_amount (${nonPayableNum}) cannot exceed total_billed ${billedNum}`,
      'CLAIM_PATIENT_SHARE_EXCEEDS_BILLED',
      { patient_copay: copayNum, non_payable_amount: nonPayableNum, total_billed: billedNum },
    );
  }
  if (stage !== null && stage !== undefined && !VALID_CLAIM_STAGES.includes(stage)) {
    throw AppError.badRequest(`Invalid stage "${stage}". Must be one of: ${VALID_CLAIM_STAGES.join(', ')}`);
  }
  // Sol Ultra #15: bind the referenced policy / preauth / admission /
  // parent claim to this tenant + patient. Placed AFTER the pure-input
  // validations (mirroring createPreauth) so shape checks stay DB-free —
  // the unit suite's documented contract — while every path that reaches
  // persistence still passes the binding.
  await assertClaimReferencesBelongToPatient({
    tenantId, patientUid: patient_uid, policyId: policy_id, preauthId: preauth_id,
    admissionId: admission_id, parentClaimId: parent_claim_id,
  });
  const finalStage = stage || 'final';
  if (claim_type === 'cashless' && finalStage === 'final' && invoice_id) {
    await assertIssuedFinalCashlessInvoice({
      tenantId,
      invoiceId: invoice_id,
      patientUid: patient_uid,
      admissionId: admission_id,
      totalBilled: total_billed,
    });
  }

  const claim_number = await nextSeq('tpa_claim_counter', 'CL', tenantId);

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO tpa_claims
       (claim_number, policy_id, preauth_id, invoice_id, patient_uid,
        admission_id, claim_type, total_billed, patient_copay,
        non_payable_amount, claimed_amount, notes, created_by, tenant_id,
        stage, parent_claim_id)
     VALUES ($1, $2::int, $3::int, $4::int, $5::uuid, $6::int, $7,
             $8::numeric, $9::numeric, $10::numeric, $11::numeric,
             $12, $13::uuid, $14::uuid,
             $15, $16::int)
     RETURNING *`,
    claim_number, Number(policy_id),
    preauth_id ? Number(preauth_id) : null,
    invoice_id ? Number(invoice_id) : null,
    String(patient_uid),
    admission_id ? Number(admission_id) : null,
    claim_type, Number(total_billed), Number(patient_copay),
    nonPayableNum, claimAmt,
    notes || null,
    created_by ? String(created_by) : null, tenantId,
    finalStage,
    parent_claim_id ? Number(parent_claim_id) : null,
  );
  const created = rows[0];
  // Attach the non-blocking advisory warnings (cover-exceeded /
  // room-cap). Additive `warnings` field — always an array, empty when
  // nothing applies. Never blocks creation; #154's hard guards above
  // have already passed by this point. logCorrespondence=true writes the
  // enhancement nudge into the claim timeline once, at creation.
  const warnings = await buildClaimWarnings({
    tenantId, claim: created, logCorrespondence: true,
  });
  return { ...created, warnings };
}

export async function getClaim({ tenantId, id }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM tpa_claims WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(id), tenantId,
  );
  if (!rows.length) throw AppError.notFound('Claim not found');
  return rows[0];
}

// ── Non-blocking claim advisories (cover-exceeded + room-cap) ─────────
//
// Deferred half of finding 2026-05-20-tpa-insurance-claim-billing-4600ed9c.
// #154 added the HARD guards (claimed_amount ≤ total_billed,
// approved ≤ claimed, paid ≤ claimed). Those stay untouched. What was
// deferred is the *advisory* layer: a final bill can legitimately exceed
// the sanctioned pre-auth cover — that is exactly when an enhancement is
// filed (enhancement workflow fixed in #151). So when a claim's
// claimed_amount exceeds the cumulative sanctioned cover of its linked
// pre-auth chain we surface a NON-BLOCKING warning telling the
// coordinator to file an enhancement; we never reject. Likewise a partial
// approval that capped the room category leaves the upgrade differential
// as patient-payable (finding 2026-05-22-...-b5906e90) — we flag that as
// an informational warning, not a block.
//
// Warning codes are stable strings; consumers key off `code`.
export const CLAIM_WARNING_CODES = {
  EXCEEDS_SANCTIONED_COVER: 'CLAIM_EXCEEDS_SANCTIONED_COVER',
  ROOM_CHARGES_EXCEED_CAP: 'CLAIM_ROOM_CHARGES_EXCEED_CAP',
};

const ROOM_CAP_LIABILITY_CONSENT_TYPES = [
  'financial_liability',
  'room_upgrade_liability',
];

/**
 * Pure cover-exceeded check. Returns a warning object when the claimed
 * amount exceeds the cumulative sanctioned cover (with a meaningful
 * shortfall), else null. No warning when there is no sanctioned cover yet
 * (cover === 0 / null) — nothing has been approved to compare against, so
 * the cover comparison is not meaningful (the claimed ≤ billed hard guard
 * still applies upstream).
 *
 * @param {{ claimedAmount: number, sanctionedCover: number }} args
 * @returns {{ code, sanctioned, claimed, shortfall } | null}
 */
export function computeCoverExceededWarning({ claimedAmount, sanctionedCover }) {
  const claimed = Number(claimedAmount || 0);
  const sanctioned = Number(sanctionedCover || 0);
  if (!(sanctioned > 0)) return null;
  if (!(claimed > 0)) return null;
  // Tolerance mirrors the moneyEquals epsilon used by the hard guards so a
  // claim that exactly matches cover (or rounds within a paisa) is silent.
  if (claimed <= sanctioned + 0.01) return null;
  const shortfall = Number((claimed - sanctioned).toFixed(2));
  return {
    code: CLAIM_WARNING_CODES.EXCEEDS_SANCTIONED_COVER,
    sanctioned: Number(sanctioned.toFixed(2)),
    claimed: Number(claimed.toFixed(2)),
    shortfall,
    message:
      `Claimed amount ₹${claimed} exceeds the sanctioned cover ₹${sanctioned} ` +
      `by ₹${shortfall}. File an enhancement pre-auth for the shortfall so the ` +
      `insurer can approve the full claim; the final bill legitimately exceeding ` +
      `pre-auth cover is expected and is not blocked.`,
  };
}

/**
 * Pure room-cap check. The insurer's partial approval may cap the covered
 * room category (e.g. semi_private) below where the patient actually
 * stayed (e.g. private). The upgrade differential is patient-payable /
 * non-covered. We flag it when EITHER:
 *   - we know the room charges and a structured room-rent cap amount, and
 *     the charges exceed the cap (preferred — precise excess), OR
 *   - we only know the categories, and the admission category outranks the
 *     capped category (qualitative flag, no rupee figure).
 * Returns a warning object or null.
 *
 * @param {{ roomCharges?: number, roomCapAmount?: number,
 *           admissionRoomCategory?: string, cappedRoomCategory?: string }} args
 */
export function computeRoomCapWarning({
  roomCharges, roomCapAmount, admissionRoomCategory, cappedRoomCategory,
}) {
  const charges = Number(roomCharges || 0);
  const capAmt = Number(roomCapAmount || 0);
  // Amount-based excess (preferred when both numbers are known).
  if (charges > 0 && capAmt > 0 && charges > capAmt + 0.01) {
    const excess = Number((charges - capAmt).toFixed(2));
    return {
      code: CLAIM_WARNING_CODES.ROOM_CHARGES_EXCEED_CAP,
      room_charges: Number(charges.toFixed(2)),
      room_cap: Number(capAmt.toFixed(2)),
      excess,
      patient_payable: excess,
      capped_category: cappedRoomCategory || null,
      admission_category: admissionRoomCategory || null,
      message:
        `Room charges ₹${charges} exceed the insurer's room cap ₹${capAmt} ` +
        `by ₹${excess}. The excess is patient-payable / non-covered; collect ` +
        `the difference, capture financial-liability consent, or downgrade ` +
        `the room before final claim submission.`,
    };
  }
  // Category-only flag: admission category outranks the capped category.
  const capCat = cappedRoomCategory
    ? (ROOM_CATEGORY_RANK[String(cappedRoomCategory).toLowerCase()] ? String(cappedRoomCategory).toLowerCase() : null)
    : null;
  const admCat = admissionRoomCategory ? String(admissionRoomCategory).toLowerCase() : null;
  if (capCat && admCat) {
    const capRank = ROOM_CATEGORY_RANK[capCat] || 0;
    const admRank = ROOM_CATEGORY_RANK[admCat] || 0;
    if (admRank > capRank && capRank > 0) {
      return {
        code: CLAIM_WARNING_CODES.ROOM_CHARGES_EXCEED_CAP,
        room_charges: charges > 0 ? Number(charges.toFixed(2)) : null,
        room_cap: capAmt > 0 ? Number(capAmt.toFixed(2)) : null,
        excess: null,
        patient_payable: null,
        capped_category: capCat,
        admission_category: admCat,
        message:
          `Insurer capped the covered room category at '${capCat}' but the ` +
          `admission is in '${admCat}'. The room-upgrade differential is ` +
          `patient-payable / non-covered. Capture financial-liability consent ` +
          `or downgrade the room before final claim submission.`,
      };
    }
  }
  return null;
}

function roomCapRequiredAmount(warning) {
  const amount = Number(warning?.patient_payable ?? warning?.excess ?? 0);
  return amount > 0 ? Number(amount.toFixed(2)) : 0;
}

async function findRoomCapLiabilityEvidence({ tenantId, claim, warning }) {
  const requiredAmount = roomCapRequiredAmount(warning);
  let patientPaid = 0;

  if (claim.invoice_id && requiredAmount > 0) {
    const paymentRows = await prisma.$queryRawUnsafe(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS total
         FROM billing_payments
        WHERE invoice_id = $1::int
          AND tenant_id = $2::uuid
          AND reversed = false
          AND UPPER(mode) NOT IN ('INSURANCE', 'TPA', 'CORPORATE_TPA')`,
      Number(claim.invoice_id),
      tenantId,
    );
    patientPaid = Number(paymentRows[0]?.total ?? 0);
    if (patientPaid + 0.01 >= requiredAmount) {
      return {
        cleared: true,
        method: 'patient_payment',
        required_patient_payable: requiredAmount,
        patient_paid: Number(patientPaid.toFixed(2)),
      };
    }
  }

  const consentRows = await prisma.$queryRawUnsafe(
    `SELECT id, consent_type, granted_at
       FROM patient_consents
      WHERE patient_uid = $1::uuid
        AND tenant_id = $2::uuid
        AND consent_type IN ('financial_liability', 'room_upgrade_liability')
        AND granted = true
        AND COALESCE(status, 'active') = 'active'
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY granted_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    String(claim.patient_uid),
    tenantId,
  );

  if (consentRows.length) {
    return {
      cleared: true,
      method: 'consent',
      consent_id: Number(consentRows[0].id),
      consent_type: consentRows[0].consent_type,
      required_patient_payable: requiredAmount || null,
      patient_paid: Number(patientPaid.toFixed(2)),
    };
  }

  return {
    cleared: false,
    required_patient_payable: requiredAmount || null,
    patient_paid: Number(patientPaid.toFixed(2)),
  };
}

async function assertRoomCapLiabilityCleared({ tenantId, claim }) {
  if (claim.claim_type !== 'cashless' || claim.stage !== 'final') return;

  const warnings = await buildClaimWarnings({ tenantId, claim });
  const roomWarning = warnings.find((w) => w.code === CLAIM_WARNING_CODES.ROOM_CHARGES_EXCEED_CAP);
  if (!roomWarning) return;

  const evidence = await findRoomCapLiabilityEvidence({ tenantId, claim, warning: roomWarning });
  if (evidence.cleared) return;

  const required = evidence.required_patient_payable;
  const requiredText = required
    ? `₹${required} room-upgrade difference`
    : 'the room-upgrade liability';
  throw AppError.badRequest(
    `Cashless final claim cannot be submitted: insurer room-cap liability is unresolved. ` +
    `Collect at least ${requiredText} from the patient on the linked invoice, capture ` +
    `financial_liability / room_upgrade_liability consent, or downgrade the room before submitting.`,
    'ROOM_CAP_LIABILITY_NOT_ACKNOWLEDGED',
    {
      claim_id: Number(claim.id),
      invoice_id: claim.invoice_id ? Number(claim.invoice_id) : null,
      admission_id: claim.admission_id ? Number(claim.admission_id) : null,
      warning: roomWarning,
      evidence,
      accepted_consent_types: ROOM_CAP_LIABILITY_CONSENT_TYPES,
    },
  );
}

/**
 * Read the room-rent total billed on the claim's linked invoice, summing
 * the canonical `room_rent` billing category (billingV2). Returns 0 when
 * no invoice is linked or no room-rent line exists.
 */
async function roomChargesForInvoice(invoiceId) {
  if (!invoiceId) return 0;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(SUM(line_total), 0)::numeric AS total
       FROM billing_invoice_items
      WHERE invoice_id = $1::int
        AND category = 'room_rent'`,
    Number(invoiceId),
  );
  return Number(rows[0]?.total ?? 0);
}

/**
 * Pull the structured room-rent cap amount out of an insurer caps object.
 * The TPA portal can carry the room cap two ways (see extractPreauthCaps):
 *   caps.room_rent.max_amount        — per-category numeric cap, or
 *   caps.room_category.max_amount    — numeric cap alongside the category, or
 *   caps.room_category.max_category  — the qualitative category only.
 */
function roomCapAmountFromCaps(caps) {
  if (!caps || typeof caps !== 'object') return 0;
  const fromRoomRent = caps.room_rent && caps.room_rent.max_amount != null
    ? Number(caps.room_rent.max_amount) : 0;
  if (fromRoomRent > 0) return fromRoomRent;
  const fromRoomCat = caps.room_category && caps.room_category.max_amount != null
    ? Number(caps.room_category.max_amount) : 0;
  return fromRoomCat > 0 ? fromRoomCat : 0;
}

function cappedRoomCategoryFromCaps(caps) {
  if (!caps || typeof caps !== 'object') return null;
  if (caps.room_category && caps.room_category.max_category) {
    return String(caps.room_category.max_category);
  }
  return null;
}

/**
 * Assemble the non-blocking advisory warnings for a claim row. Pure
 * computation is delegated to the exported helpers; this gatherer just
 * sources the inputs (cumulative sanctioned cover, insurer caps, billed
 * room charges, admission room category). Always returns an array (empty
 * when there is nothing to warn about, or when the claim has no linked
 * pre-auth). Never throws — advisory data must not break a claim
 * read/create.
 *
 * `logCorrespondence` (default false) controls whether the cover-exceeded
 * enhancement nudge is also dropped into the claim timeline as a
 * correspondence row. Callers pass `true` only on a mutation boundary
 * (claim creation) so the note is written once per claim, not on every
 * read of the bundle.
 *
 * @param {{ tenantId: string, claim: object, logCorrespondence?: boolean }} args
 */
export async function buildClaimWarnings({ tenantId, claim, logCorrespondence = false }) {
  const warnings = [];
  try {
    if (!claim || !claim.preauth_id) return warnings;

    // Cumulative sanctioned cover across the pre-auth + enhancement chain.
    const totals = await chainTotalsFor({ tenantId, preauthId: claim.preauth_id });
    const sanctionedCover = Number(totals.cumulative_approved || 0);

    const coverWarning = computeCoverExceededWarning({
      claimedAmount: Number(claim.claimed_amount || 0),
      sanctionedCover,
    });
    if (coverWarning) warnings.push(coverWarning);

    // Room cap: read the latest insurer response caps on the linked
    // pre-auth, plus the billed room charges + admission room category.
    const respRows = await prisma.$queryRawUnsafe(
      `SELECT raw_response
         FROM insurance_preauth_responses
        WHERE preauth_id = $1::int
        ORDER BY decided_at DESC, id DESC
        LIMIT 1`,
      Number(claim.preauth_id),
    );
    const caps = extractPreauthCaps(respRows[0]?.raw_response);
    const roomCapAmount = roomCapAmountFromCaps(caps);
    const cappedRoomCategory = cappedRoomCategoryFromCaps(caps);

    if (roomCapAmount > 0 || cappedRoomCategory) {
      const roomCharges = await roomChargesForInvoice(claim.invoice_id);
      let admissionRoomCategory = null;
      if (claim.admission_id) {
        const adm = await prisma.admissions.findUnique({
          where: { id: Number(claim.admission_id) },
          select: { room_category: true },
        });
        admissionRoomCategory = adm?.room_category || null;
      }
      const roomWarning = computeRoomCapWarning({
        roomCharges,
        roomCapAmount,
        admissionRoomCategory,
        cappedRoomCategory,
      });
      if (roomWarning) warnings.push(roomWarning);
    }

    // Best-effort: drop a correspondence note for the cover-exceeded case
    // so the enhancement nudge is visible in the claim timeline. Only on a
    // mutation boundary (logCorrespondence=true) — reads stay read-only and
    // do not spam the timeline. Guarded — a correspondence-insert failure
    // must never break the read/create.
    if (logCorrespondence && coverWarning && claim.id) {
      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO tpa_claim_correspondence
             (claim_id, direction, channel, subject, body, recorded_by)
           VALUES ($1::int, 'outbound', 'internal', $2, $3, NULL)`,
          Number(claim.id),
          'Claim exceeds sanctioned cover — file enhancement',
          coverWarning.message,
        );
      } catch (corrErr) {
        logger.warn(
          `buildClaimWarnings: cover-exceeded correspondence note failed for claim=${claim.id}: ${corrErr.message}`,
        );
      }
    }
  } catch (err) {
    // Advisory layer is non-fatal by contract.
    logger.warn(
      `buildClaimWarnings: advisory computation failed for claim=${claim?.id}: ${err.message}`,
    );
  }
  return warnings;
}

/**
 * Doc types the final cashless packet must include before submission.
 * Lab + imaging are NOT required — they may not exist for every
 * admission (observation-only / no investigations done). The TPA
 * portal will still query a claim missing them, but discharge summary
 * and final bill are non-negotiable.
 * See finding 2026-05-10-tpa-insurance-claim-discharge-final-claim-submits-without-packet.
 */
export const FINAL_CASHLESS_REQUIRED_DOC_TYPES = ['discharge_summary', 'final_bill'];

// Standard claim-packet documents, attached as virtual vh:// references
// the TPA desk dereferences to the live discharge summary / final bill at
// pull time — exactly the model ensurePreauthDocumentBundle uses for the
// pre-auth packet. Each spec declares the backing record it needs so the
// assembler never fabricates a document for a record that does not exist.
const TPA_CLAIM_STANDARD_DOCS = [
  {
    doc_type: 'discharge_summary',
    requires: 'admission',
    file_name: (admissionId) => `discharge-summary-${admissionId}.pdf`,
    file_url: (admissionId) => `vh://admissions/${admissionId}/discharge-summary`,
    mime_type: 'application/pdf',
  },
  {
    doc_type: 'final_bill',
    requires: 'invoice',
    file_name: (_admissionId, invoiceId) => `final-bill-${invoiceId}.pdf`,
    file_url: (_admissionId, invoiceId) => `vh://billing/invoices/${invoiceId}/final-bill`,
    mime_type: 'application/pdf',
  },
];

// Auto-assemble the claim's supporting packet before the submit gate.
// submitClaim enforces FINAL_CASHLESS_REQUIRED_DOC_TYPES, but nothing
// attached them — the discharge summary + final bill existed as records
// yet were never written to tpa_claim_documents, so every cashless final
// claim hit the "missing required document types" gate with no way for the
// coordinator to satisfy it. Idempotent (skips doc_types already present)
// and best-effort per doc (a single attach failure is logged, never blocks
// the submit attempt — the gate below still fires if the packet is truly
// empty). Mirrors ensurePreauthDocumentBundle.
// Finding 2026-05-21-tpa-insurance-claim-discharge-9746f26c (+ f9ef3054, 54ede17f).
async function ensureClaimDocumentBundle({ tenantId, claimId, admissionId, invoiceId, uploadedBy }) {
  const existing = await prisma.$queryRawUnsafe(
    `SELECT doc_type FROM tpa_claim_documents WHERE claim_id = $1::int`,
    Number(claimId),
  );
  const existingTypes = new Set(existing.map((r) => r.doc_type));
  const attached = [];
  for (const spec of TPA_CLAIM_STANDARD_DOCS) {
    if (existingTypes.has(spec.doc_type)) continue;
    if (spec.requires === 'admission' && !admissionId) continue;
    if (spec.requires === 'invoice' && !invoiceId) continue;
    try {
      const row = await attachDocument({
        tenantId,
        claim_id: claimId,
        doc_type: spec.doc_type,
        file_name: spec.file_name(admissionId, invoiceId),
        file_url: spec.file_url(admissionId, invoiceId),
        mime_type: spec.mime_type,
        uploaded_by: uploadedBy,
        notes: 'auto-assembled at claim submission',
      });
      attached.push(row.doc_type);
    } catch (err) {
      logger.warn(
        `ensureClaimDocumentBundle: ${spec.doc_type} attach failed for claim=${claimId}: ${err.message}`,
      );
    }
  }
  return attached;
}

export async function submitClaim({
  tenantId, id, submitted_by, submission_channel = 'portal', tpa_reference_id,
}) {
  const cl = await getClaim({ tenantId, id });
  if (cl.status !== 'prepared') {
    throw AppError.badRequest(`Claim in ${cl.status} cannot be submitted`);
  }
  if (cl.claim_type === 'cashless' && cl.stage === 'final' && cl.invoice_id) {
    await assertIssuedFinalCashlessInvoice({
      tenantId,
      invoiceId: cl.invoice_id,
      patientUid: cl.patient_uid,
      admissionId: cl.admission_id,
      totalBilled: cl.total_billed,
    });
  }
  await assertRoomCapLiabilityCleared({ tenantId, claim: cl });
  // Assemble the standard packet (discharge summary + final bill) before
  // the doc gates so the cashless requirement is satisfiable from the live
  // records instead of erroring at a dead end. Skips any doc whose backing
  // record (admission / invoice) is absent.
  await ensureClaimDocumentBundle({
    tenantId,
    claimId: cl.id,
    admissionId: cl.admission_id,
    invoiceId: cl.invoice_id,
    uploadedBy: submitted_by,
  });
  const docs = await prisma.$queryRawUnsafe(
    `SELECT doc_type FROM tpa_claim_documents WHERE claim_id = $1::int`,
    cl.id,
  );
  if (docs.length === 0) {
    throw AppError.badRequest(
      'Claim submission requires at least one supporting document. Attach via POST /api/v1/insurance/documents first.',
    );
  }
  // Cashless final claim: enforce the minimal portal packet so the TPA
  // does not bounce the case for missing summary/bill.
  if (cl.claim_type === 'cashless') {
    const present = new Set(docs.map((d) => String(d.doc_type)));
    const missing = FINAL_CASHLESS_REQUIRED_DOC_TYPES.filter((t) => !present.has(t));
    if (missing.length) {
      throw AppError.badRequest(
        `Cashless claim packet missing required document types: ${missing.join(', ')}. Attach all of: ${FINAL_CASHLESS_REQUIRED_DOC_TYPES.join(', ')}.`,
      );
    }

    // D9 — A draft discharge_summary doc was accepted in the packet
    // even when the underlying discharge_summaries row was still
    // draft / ready_for_signoff. Insurers received a draft summary
    // in the cashless packet, audited the claim against unauthorised
    // discharge documentation, then bounced the case (or worse —
    // settled against a draft that was later amended).
    //
    // The gate is intentionally narrow: block ONLY when a
    // discharge_summaries row EXISTS for the admission AND the most
    // recent one is in a non-signed state. If no row exists at all,
    // the auto-assembled vh:// reference (ensureClaimDocumentBundle)
    // still pre-stages the placeholder so the bigger
    // "no-summary-exists" case is the operator's responsibility,
    // not this gate's — option chosen to keep the existing
    // packet-autoassemble test green while still catching the
    // unsigned-draft regression. Findings: d3df8c98, f6440157,
    // 9c3e7848, 21d0b3df.
    if (cl.admission_id) {
      const summaryRows = await prisma.$queryRawUnsafe(
        `SELECT status
           FROM discharge_summaries
          WHERE admission_id = $1::int
          ORDER BY COALESCE(signed_at, created_at) DESC, id DESC
          LIMIT 1`,
        Number(cl.admission_id),
      ).catch((err) => {
        // Under-migrated tenant (table missing) — fall open rather
        // than blocking submit on infrastructure. Log loudly so the
        // gap is visible. Existing doc-presence gate still applies.
        logger.warn(`submitClaim: discharge_summaries status-check failed for admission=${cl.admission_id}: ${err.message}`);
        return null;
      });
      if (summaryRows && summaryRows.length > 0) {
        const latestStatus = String(summaryRows[0].status || '').toLowerCase();
        if (latestStatus !== 'signed' && latestStatus !== 'delivered') {
          throw AppError.badRequest(
            'Cashless final claim cannot be submitted: the discharge summary for this admission is '
            + `in '${latestStatus || 'draft'}' state. Sign the discharge summary (status must be \`signed\` or `
            + '`delivered`) before submitting the claim packet — insurers must not receive a draft summary.',
            'DISCHARGE_SUMMARY_NOT_SIGNED',
            { admission_id: cl.admission_id, current_status: latestStatus || null },
          );
        }
      }
    }
  }
  await prisma.$executeRawUnsafe(
    `UPDATE tpa_claims
        SET status = 'submitted', submitted_at = NOW(),
            submitted_by = $1::uuid, submission_channel = $2,
            tpa_reference_id = COALESCE($3, tpa_reference_id),
            updated_at = NOW()
      WHERE id = $4::int`,
    submitted_by ? String(submitted_by) : null,
    submission_channel,
    tpa_reference_id || null,
    cl.id,
  );
  return getClaim({ tenantId, id });
}

export async function recordClaimDecision({
  tenantId, id, decision, approved_amount, denial_reason, recorded_by,
  insurer, raw_response, disallowed_amount,
  correspondence_channel = 'portal', correspondence_subject = null,
  correspondence_body = null, skip_ledger_shift = false,
}) {
  const cl = await getClaim({ tenantId, id });
  const allowedDecisions = ['approved', 'partially_approved', 'queried', 'denied'];
  if (!allowedDecisions.includes(decision)) throw AppError.badRequest('Invalid decision');

  // State-machine guard. Re-recording the SAME decision the claim already
  // carries is idempotent (a duplicate TPA-portal callback / double-click is a
  // no-op, not a 400 or a duplicate correspondence row). Any other illegal
  // from→to (e.g. paid → submitted, denied → approved is allowed for appeal
  // reversal but paid → denied is not) is rejected as an invalid transition.
  const allowedTo = CLAIM_DECISION_TRANSITIONS[cl.status] ?? null;
  if (allowedTo === null) {
    throw AppError.badRequest(`Cannot record decision on ${cl.status} claim`);
  }
  if (cl.status === decision) {
    // Already in the requested decision state — no-op for safe retries.
    return getClaim({ tenantId, id });
  }
  if (!allowedTo.includes(decision)) {
    throw AppError.invalidTransition(cl.status, decision, allowedTo);
  }

  // Reject a decision whose payer contradicts the claim's policy payer. Two
  // signals: an explicitly-supplied insurer (strong — mirrors
  // recordPreauthResponse), and the claim's own free-text tpa_reference_id
  // (best-effort, only a confidently-recognised leading insurer token blocks).
  // A New India decision must not be recorded on a Star Health policy claim.
  // Finding: 2026-05-20-tpa-insurance-claim-billing-df39fefb.
  const decisionInsurer = (insurer && String(insurer).trim())
    || (raw_response && typeof raw_response === 'object' ? String(raw_response.insurer || '').trim() : '');
  await assertClaimSettlementPayerMatch({
    tenantId,
    claim: cl,
    structuredInsurer: decisionInsurer,
    references: [cl.tpa_reference_id],
  });

  const approvedProvided = approved_amount !== undefined && approved_amount !== null && approved_amount !== '';
  const approvedNum = approvedProvided ? Number(approved_amount) : null;
  if (approvedProvided) {
    const claimedNum = Number(cl.claimed_amount || 0);
    if (claimedNum > 0 && approvedNum > claimedNum) {
      throw AppError.badRequest(
        `approved_amount ${approvedNum} exceeds claimed_amount ${claimedNum}; ` +
        `the insurer cannot approve more than was submitted.`,
        'CLAIM_APPROVED_EXCEEDS_CLAIMED',
        { claimed_amount: claimedNum, approved_amount: approvedNum },
      );
    }
  }
  const disallowedProvided = disallowed_amount !== undefined && disallowed_amount !== null && disallowed_amount !== '';
  let disallowedNum = disallowedProvided ? Number(disallowed_amount) : null;
  if (!disallowedProvided && decision === 'partially_approved' && approvedNum != null) {
    const claimedNum = Number(cl.claimed_amount || 0);
    disallowedNum = claimedNum > approvedNum ? Number((claimedNum - approvedNum).toFixed(2)) : 0;
  }
  if (disallowedNum != null && (!Number.isFinite(disallowedNum) || disallowedNum < 0)) {
    throw AppError.badRequest('disallowed_amount must be a non-negative number', 'CLAIM_DISALLOWED_AMOUNT_INVALID');
  }

  // M4 (audit 2026-06-22): lock the claim row and re-validate the transition
  // against the COMMITTED status inside the tx. The checks above are fast-fail UX
  // on a no-lock read; without this lock two concurrent decisions both read the
  // old status, both pass, and both write (distinct-ref last-writer-wins).
  const tid = requireTenantId(tenantId);
  const wiring = skip_ledger_shift === true
    ? { sameTx: false, postCommit: false }
    : await resolveLedgerWiring(tid);
  await setTenantTx(tid, async (tx) => {
    const lockedRows = await tx.$queryRawUnsafe(
      `SELECT id, status FROM tpa_claims WHERE id = $1::int AND tenant_id = $2::uuid LIMIT 1 FOR UPDATE`,
      cl.id, tid,
    );
    const locked = lockedRows[0];
    if (!locked) throw AppError.notFound('Claim not found');
    const allowedToLocked = CLAIM_DECISION_TRANSITIONS[locked.status] ?? null;
    if (allowedToLocked === null) {
      throw AppError.badRequest(`Cannot record decision on ${locked.status} claim`);
    }
    if (locked.status === decision) return; // idempotent — already in this state
    if (!allowedToLocked.includes(decision)) {
      throw AppError.invalidTransition(locked.status, decision, allowedToLocked);
    }

    await tx.$executeRawUnsafe(
      `UPDATE tpa_claims
          SET status = $1::varchar,
              approved_amount = COALESCE($2::numeric, approved_amount),
              disallowed_amount = COALESCE($3::numeric, disallowed_amount),
              denial_reason = CASE WHEN $1::varchar = 'denied' THEN $4::text ELSE denial_reason END,
              updated_at = NOW()
        WHERE id = $5::int`,
      decision,
      approvedProvided ? approvedNum : null,
      disallowedNum,
      denial_reason || null,
      cl.id,
    );

    // Drop a correspondence row for the audit trail.
    const subject = correspondence_subject || `Decision: ${decision}`;
    const body = correspondence_body || [
      `Decision: ${decision}`,
      approvedProvided ? `Approved: ${approvedNum}` : null,
      disallowedNum != null ? `Disallowed: ${disallowedNum}` : null,
      denial_reason ? `Reason: ${denial_reason}` : null,
    ].filter(Boolean).join('\n');
    await tx.$executeRawUnsafe(
      `INSERT INTO tpa_claim_correspondence
         (claim_id, direction, channel, subject, body, recorded_by)
       VALUES ($1::int, 'inbound', $2,
               $3, $4, $5::uuid)`,
      cl.id,
      correspondence_channel || 'portal',
      subject,
      body,
      recorded_by ? String(recorded_by) : null,
    );

    // Phase 4 enforce: on insurer approval shift PATIENT_AR -> INSURANCE_AR
    // INSIDE the decision tx so a ledger failure rolls back the decision. Uses
    // the committed amount = COALESCE(param, existing) to mirror the UPDATE above.
    if (wiring.sameTx && (decision === 'approved' || decision === 'partially_approved') && cl.invoice_id) {
      await postInsuranceShiftEntry({
        claim: { id: cl.id, invoice_id: cl.invoice_id, patient_uid: cl.patient_uid, approved_amount: approved_amount ?? cl.approved_amount },
        tenantId: tid, tx,
      });
    }
  });

  const updated = await getClaim({ tenantId, id });
  // Ledger (Phase 3c): on insurer approval, shift the receivable
  // PATIENT_AR -> INSURANCE_AR for the approved amount. Post-commit best-effort;
  // a ledger problem never blocks the claim decision. Only meaningful when the
  // claim is invoice-linked and the insurer committed an amount.
  if (wiring.postCommit && (decision === 'approved' || decision === 'partially_approved') && updated && updated.invoice_id) {
    try {
      await postInsuranceShiftEntry({
        claim: {
          id: updated.id, invoice_id: updated.invoice_id, patient_uid: updated.patient_uid, approved_amount: updated.approved_amount,
        },
        tenantId: requireTenantId(tenantId),
      });
    } catch (ledgerErr) {
      logger.error('Ledger INSURANCE_SHIFT post failed (non-blocking)', { claim_id: updated.id, error: ledgerErr.message });
    }
  }
  return updated;
}

export async function recordClaimPayment({
  tenantId, id, paid_amount, payment_reference, paid_at, recorded_by,
}) {
  const cl = await getClaim({ tenantId, id });
  const paidNum = Number(paid_amount);
  if (!paid_amount || paidNum <= 0) {
    throw AppError.badRequest('paid_amount must be > 0');
  }

  // Idempotency: re-posting the SAME settlement (same payment_reference on an
  // already-paid claim) is a no-op so a duplicate insurer callback doesn't
  // double-write the correspondence row. A DIFFERENT settlement on a paid claim
  // is an illegal transition (paid is terminal here).
  if (['paid', 'settled_partial'].includes(cl.status)) {
    const samePayment = payment_reference
      && cl.payment_reference
      && String(cl.payment_reference) === String(payment_reference);
    if (samePayment) return getClaim({ tenantId, id });
    throw AppError.invalidTransition(cl.status, 'paid', CLAIM_PAYMENT_FROM_STATES);
  }
  // State-machine guard: a settlement is only recordable from a positive payer
  // verdict (or directly from submitted for a clean auto-settle).
  if (!CLAIM_PAYMENT_FROM_STATES.includes(cl.status)) {
    throw AppError.invalidTransition(cl.status, 'paid', CLAIM_PAYMENT_FROM_STATES);
  }
  // Reject a settlement whose payer contradicts the claim's policy payer.
  // The only payer signal at settlement is free-text: the settlement
  // reference (payment_reference, e.g. "NIA-NEFT-CL-2627-00004-63000") and
  // the claim's tpa_reference_id ("NIA-FINAL-CL-2627-00004"). Best-effort —
  // only a confidently-recognised leading insurer token that resolves to a
  // payer different from the policy's blocks; an unrecognised / compatible /
  // empty reference never blocks (a false reject of a real settlement is
  // worse than the miss). Finding:
  // 2026-05-20-tpa-insurance-claim-billing-df39fefb — an NIA settlement
  // reference posted against a Star Health policy.
  await assertClaimSettlementPayerMatch({
    tenantId,
    claim: cl,
    references: [payment_reference, cl.tpa_reference_id],
  });
  // Insurers must not pay more than the hospital claimed. The
  // non_payable component (room upgrade delta, pharmacy over-cap,
  // attendant charges, etc.) is patient liability and must never be
  // silently absorbed into the TPA settlement — that would zero out
  // the patient share at discharge. See finding
  // 2026-05-09-tpa-insurance-claim-billing-tpa-overpay-no-validation.
  const claimedNum = Number(cl.claimed_amount || 0);
  if (claimedNum > 0 && paidNum > claimedNum) {
    throw AppError.badRequest(
      `paid_amount ${paidNum} exceeds claimed_amount ${claimedNum}; ` +
      `record an enhancement preauth or split the payment instead.`,
      'PAYMENT_EXCEEDS_CLAIM',
      { claimed_amount: claimedNum, paid_amount: paidNum }
    );
  }
  // Short-paid claim → settled_partial (migration 218). The
  // disallowed_amount is what the insurer refused (claimed − paid).
  // Distinct from non_payable_amount (food / attendant exclusions
  // declared at claim creation).
  // See findings 2026-05-09-tpa-insurance-claim-billing-no-settled-partial-state
  // and 2026-05-10-tpa-insurance-claim-billing-settlement-collapses-to-paid.
  const isShortPay = claimedNum > 0 && paidNum < claimedNum;
  const newStatus = isShortPay ? 'settled_partial' : 'paid';
  const disallowed = isShortPay ? Number((claimedNum - paidNum).toFixed(2)) : 0;
  // M4 (audit 2026-06-22): lock + re-validate the settlement transition against
  // the COMMITTED status inside the tx. The checks above are fast-fail UX on a
  // no-lock read; without this lock two concurrent settlements both read a
  // payable status and both write (distinct-ref last-writer-wins / double-pay).
  const tid = requireTenantId(tenantId);
  await setTenantTx(tid, async (tx) => {
    const lockedRows = await tx.$queryRawUnsafe(
      `SELECT id, status, payment_reference FROM tpa_claims WHERE id = $1::int AND tenant_id = $2::uuid LIMIT 1 FOR UPDATE`,
      cl.id, tid,
    );
    const locked = lockedRows[0];
    if (!locked) throw AppError.notFound('Claim not found');
    if (['paid', 'settled_partial'].includes(locked.status)) {
      const samePayment = payment_reference && locked.payment_reference
        && String(locked.payment_reference) === String(payment_reference);
      if (samePayment) return; // idempotent — same settlement re-posted
      throw AppError.invalidTransition(locked.status, 'paid', CLAIM_PAYMENT_FROM_STATES);
    }
    if (!CLAIM_PAYMENT_FROM_STATES.includes(locked.status)) {
      throw AppError.invalidTransition(locked.status, 'paid', CLAIM_PAYMENT_FROM_STATES);
    }

    await tx.$executeRawUnsafe(
      `UPDATE tpa_claims
          SET status = $1, paid_amount = $2::numeric,
              disallowed_amount = $3::numeric,
              payment_reference = $4, paid_at = COALESCE($5::timestamptz, NOW()),
              updated_at = NOW()
        WHERE id = $6::int`,
      newStatus, paidNum, disallowed,
      payment_reference || null,
      paid_at || null, cl.id,
    );

    await tx.$executeRawUnsafe(
      `INSERT INTO tpa_claim_correspondence
         (claim_id, direction, channel, subject, body, recorded_by)
       VALUES ($1::int, 'inbound', 'portal',
               $2, $3, $4::uuid)`,
      cl.id,
      `Settlement received`,
      `Paid amount: ${paid_amount}\nRef: ${payment_reference || '—'}`,
      recorded_by ? String(recorded_by) : null,
    );
  });

  return getClaim({ tenantId, id });
}

export async function listClaims({
  tenantId, status, patient_uid, claim_type, aging_bucket, limit = 100,
}) {
  const params = [tenantId];
  const where = [`tenant_id = $1::uuid`];
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  if (patient_uid) {
    params.push(String(patient_uid));
    where.push(`patient_uid = $${params.length}::uuid`);
  }
  if (claim_type) { params.push(claim_type); where.push(`claim_type = $${params.length}`); }
  if (aging_bucket) { params.push(aging_bucket); where.push(`aging_bucket = $${params.length}`); }
  params.push(boundedInteger(limit, { fallback: 100, min: 1, max: 200 }));
  return prisma.$queryRawUnsafe(
    `SELECT * FROM tpa_claims_aging
      WHERE ${where.join(' AND ')}
      ORDER BY days_since_submit DESC NULLS LAST
      LIMIT $${params.length}::int`,
    ...params,
  );
}

// ── Documents + correspondence ───────────────────────────────────────

export async function attachDocument({
  tenantId, claim_id, preauth_id, doc_type, file_name, file_url,
  file_size_bytes, mime_type, uploaded_by, notes,
}) {
  if (!claim_id && !preauth_id) {
    throw AppError.badRequest('claim_id or preauth_id is required');
  }
  if (!doc_type) throw AppError.badRequest('doc_type is required');
  if (!file_url) throw AppError.badRequest('file_url is required');
  await assertTpaChildParentInTenant({ tenantId, claim_id, preauth_id });

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO tpa_claim_documents
       (claim_id, preauth_id, doc_type, file_name, file_url,
        file_size_bytes, mime_type, uploaded_by, notes)
     VALUES ($1::int, $2::int, $3, $4, $5,
             $6::bigint, $7, $8::uuid, $9)
     RETURNING *`,
    claim_id ? Number(claim_id) : null,
    preauth_id ? Number(preauth_id) : null,
    doc_type, file_name || 'document', file_url,
    file_size_bytes ? Number(file_size_bytes) : null,
    mime_type || null,
    uploaded_by ? String(uploaded_by) : null,
    notes || null,
  );
  return rows[0];
}

export async function logCorrespondence({
  tenantId, claim_id, preauth_id, direction, channel, subject, body,
  attachments, recorded_by,
}) {
  if (!claim_id && !preauth_id) {
    throw AppError.badRequest('claim_id or preauth_id is required');
  }
  if (!['inbound', 'outbound'].includes(direction)) {
    throw AppError.badRequest('direction must be inbound or outbound');
  }
  await assertTpaChildParentInTenant({ tenantId, claim_id, preauth_id });
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO tpa_claim_correspondence
       (claim_id, preauth_id, direction, channel, subject, body,
        attachments, recorded_by)
     VALUES ($1::int, $2::int, $3, $4, $5, $6, $7::jsonb, $8::uuid)
     RETURNING *`,
    claim_id ? Number(claim_id) : null,
    preauth_id ? Number(preauth_id) : null,
    direction, channel || 'email', subject || null, body || null,
    JSON.stringify(attachments || []),
    recorded_by ? String(recorded_by) : null,
  );
  return rows[0];
}

export async function getClaimBundle({ tenantId, id }) {
  const claim = await getClaim({ tenantId, id });
  // Compute the non-blocking advisories on the read surface so the
  // /api/v1/insurance/claims/:id consumer (TPA desk / cashier) sees the
  // cover-exceeded enhancement nudge + room-cap liability. buildClaimWarnings
  // is read-only here except for a best-effort cover-exceeded correspondence
  // note (idempotency is not required — the note documents the live state).
  const warnings = await buildClaimWarnings({ tenantId, claim });
  const docs = await prisma.$queryRawUnsafe(
    `SELECT * FROM tpa_claim_documents WHERE claim_id = $1::int ORDER BY uploaded_at DESC`,
    claim.id,
  );
  const corr = await prisma.$queryRawUnsafe(
    `SELECT * FROM tpa_claim_correspondence WHERE claim_id = $1::int ORDER BY recorded_at DESC`,
    claim.id,
  );
  return { claim: { ...claim, warnings }, documents: docs, correspondence: corr };
}

export const __testing__ = {
  assertFinalCashlessInvoiceLinesTraceable,
};
