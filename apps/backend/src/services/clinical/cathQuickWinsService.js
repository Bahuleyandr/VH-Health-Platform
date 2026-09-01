// NL-13 P1e: cath quick wins — live readiness evidence, workbench order sets,
// and post-procedure follow-up loops. This is a REUSE slice: it consumes the
// blood-bank rails (read-only), the NL-4 consent e-signature rails (read-only),
// the NL-5 content-studio order-set lifecycle (via the existing CPOE
// applyOrderSet path — no new ordering path), and the NL9-P3 follow-up loop
// rails. Every path is inert until the tenant owner publishes the matching
// mapping in tenants.settings.cathQuickWins; absent config or absent source
// rows leave the readiness workflow exactly as it is today. Evidence is only
// ever surfaced, NEVER used to auto-pass a readiness check.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  CATH_QUICK_WIN_SLOTS,
  getCathQuickWinSettings
} from '../tenant/tenantSettingsService.js';
import { applyOrderSet } from '../emr/orderEntryService.js';
import { recordClinicalAuditEvent } from './canonicalClinicalPlatformService.js';
import {
  insertFollowUpLoopEvent,
  insertFollowUpLoopStep
} from '../engagement/teleconsultFollowUpService.js';
import { createTask } from '../workflow/taskService.js';

export const CATH_FOLLOW_UP_SOURCE_TYPE = 'cath_procedure';
export const CATH_FOLLOW_UP_LOOP_TYPE = 'cath_procedure_follow_up';
export const CATH_FOLLOW_UP_CONSENT_TYPE = 'cath_followup';
const OPEN_LOOP_STATUSES = ['open', 'scheduled', 'waiting_patient', 'staff_review'];

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`, 'CATH_QW_BAD_ID');
  }
  return parsed;
}

function normalizeDbValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value?.toNumber === 'function') return value.toNumber();
  if (Array.isArray(value)) return value.map(normalizeDbValue);
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeDbValue(item)])
    );
  }
  return value;
}

async function caseByIdOrThrow(db, tenantId, caseId, { lock = false } = {}) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id, tenant_id, patient_uid, encounter_id, appointment_id,
            requested_procedure, status
       FROM cath_lab_cases
      WHERE id = $1::bigint
        AND tenant_id = $2::uuid
      ${lock ? 'FOR UPDATE' : ''}
      LIMIT 1`,
    normalizeId(caseId, 'case_id'),
    tenantId
  );
  if (!rows.length) throw AppError.notFound('Cath-lab case not found', 'CATH_LAB_CASE_NOT_FOUND');
  return rows[0];
}

// ---------------------------------------------------------------------------
// Scope 1 — live blood-readiness evidence (blood-bank rails, READ-ONLY)
// ---------------------------------------------------------------------------

// Latest live blood request for the patient. blood_requests.encounter_id is a
// legacy INTEGER column unrelated to the cath case's patient_encounters UUID,
// so evidence is patient-scoped by design (matches the blood-bank surface).
// No row -> null -> the readiness item stays fully manual.
export async function resolveBloodReadinessEvidence({ tenantId, patientUid }, { db = prisma } = {}) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id, blood_group, component, units, urgency, status,
            cross_match_status, cross_matched_at, issued_at, transfused_at, created_at
       FROM blood_requests
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND status <> 'cancelled'
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    tenantId,
    patientUid
  );
  const request = rows[0];
  if (!request) return null;
  return normalizeDbValue({
    evidence: 'blood_bank_crossmatch',
    blood_request_id: request.id,
    blood_group: request.blood_group,
    component: request.component,
    units: request.units,
    urgency: request.urgency,
    request_status: request.status,
    cross_match_status: request.cross_match_status,
    cross_matched_at: request.cross_matched_at,
    issued_at: request.issued_at,
    transfused_at: request.transfused_at,
    requested_at: request.created_at
  });
}

// ---------------------------------------------------------------------------
// Scope 2 — consent readiness evidence (NL-4 e-signature rails, READ-ONLY)
// ---------------------------------------------------------------------------

// A signed consent artifact = an active granted patient_consents row of the
// owner-mapped consent_type PLUS at least one immutable patient-role
// consent_signatures row. Unmapped tenant or missing/unsigned consent -> null.
export async function resolveConsentReadinessEvidence(
  { tenantId, patientUid, consentType },
  { db = prisma } = {}
) {
  if (!consentType) return null;
  const rows = await db.$queryRawUnsafe(
    `SELECT pc.id AS consent_id, pc.consent_type, pc.granted_at, pc.expires_at,
            cs.id AS signature_id, cs.version AS signature_version,
            cs.captured_at, cs.mime_type
       FROM patient_consents pc
       JOIN consent_signatures cs
         ON cs.consent_id = pc.id
        AND cs.tenant_id = pc.tenant_id
        AND cs.signature_role = 'patient'
      WHERE pc.tenant_id = $1::uuid
        AND pc.patient_uid = $2::uuid
        AND pc.consent_type = $3
        AND pc.granted = true
        AND pc.status = 'active'
        AND pc.revoked_at IS NULL
        AND (pc.expires_at IS NULL OR pc.expires_at > NOW())
      ORDER BY pc.granted_at DESC NULLS LAST, cs.version DESC, cs.id DESC
      LIMIT 1`,
    tenantId,
    patientUid,
    consentType
  );
  const signed = rows[0];
  if (!signed) return null;
  return normalizeDbValue({
    evidence: 'signed_consent',
    consent_id: signed.consent_id,
    consent_type: signed.consent_type,
    signature_id: signed.signature_id,
    signature_version: signed.signature_version,
    signature_mime_type: signed.mime_type,
    granted_at: signed.granted_at,
    captured_at: signed.captured_at,
    artifact_path: `/api/v1/consent/${signed.consent_id}/pdf`
  });
}

// ---------------------------------------------------------------------------
// Scope 3 — owner-published order sets per workbench slot (NL-5 content studio)
// ---------------------------------------------------------------------------

function assertSlot(slot) {
  const clean = String(slot || '').trim().toLowerCase();
  if (!CATH_QUICK_WIN_SLOTS.includes(clean)) {
    throw AppError.badRequest(
      `slot must be one of: ${CATH_QUICK_WIN_SLOTS.join(', ')}`,
      'CATH_QW_BAD_SLOT'
    );
  }
  return clean;
}

// The deployed set for a family is unique per tenant
// (uniq_clinical_order_sets_deployed_family): status='approved' AND active.
async function resolveDeployedOrderSet({ tenantId, familyKey }) {
  if (!familyKey) return null;
  const set = await prisma.clinical_order_sets.findFirst({
    where: {
      tenant_id: tenantId,
      family_key: familyKey,
      status: 'approved',
      active: true
    },
    select: {
      id: true,
      code: true,
      family_key: true,
      title: true,
      description: true,
      specialty: true,
      version: true
    }
  });
  if (!set) return null;
  const itemCount = await prisma.clinical_order_set_items.count({
    where: { order_set_id: set.id }
  });
  return {
    order_set_id: set.id,
    code: set.code,
    family_key: set.family_key,
    title: set.title,
    description: set.description ?? null,
    specialty: set.specialty ?? null,
    version: set.version ?? 1,
    item_count: itemCount
  };
}

async function resolveOrderSetSlots(tenantId, settings) {
  const slots = {};
  for (const slot of CATH_QUICK_WIN_SLOTS) {
    slots[slot] = await resolveDeployedOrderSet({
      tenantId,
      familyKey: settings.orderSetFamilies[slot]
    });
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Quick-wins read model (no writes; safe to call from the workbench any time)
// ---------------------------------------------------------------------------

export async function getCaseQuickWins(caseId, { tenantId } = {}) {
  const tid = requireTenantId(tenantId);
  const cathCase = await caseByIdOrThrow(prisma, tid, caseId);
  const settings = await getCathQuickWinSettings(tid);
  const bloodEvidence = await resolveBloodReadinessEvidence({
    tenantId: tid,
    patientUid: cathCase.patient_uid
  });
  const consentEvidence = await resolveConsentReadinessEvidence({
    tenantId: tid,
    patientUid: cathCase.patient_uid,
    consentType: settings.consentType
  });
  const orderSets = await resolveOrderSetSlots(tid, settings);
  return {
    case_id: cathCase.id,
    readiness_evidence: {
      blood_bank: bloodEvidence,
      consent: consentEvidence
    },
    consent_mapping: { consent_type: settings.consentType },
    order_sets: orderSets,
    follow_up: { configured_template_count: settings.followUpTemplates.length }
  };
}

// ---------------------------------------------------------------------------
// Evidence attach/refresh — persists the current live snapshot onto the
// existing readiness-check rows (evidence columns + metadata only; the check
// STATUS is never touched, so readiness stays a human decision).
// ---------------------------------------------------------------------------

function evidenceFingerprint(evidence) {
  if (!evidence) return 'none';
  if (evidence.evidence === 'blood_bank_crossmatch') {
    return [
      'blood', evidence.blood_request_id, evidence.request_status,
      evidence.cross_match_status, evidence.cross_matched_at || ''
    ].join(':');
  }
  return [
    'consent', evidence.consent_id, evidence.signature_id, evidence.signature_version
  ].join(':');
}

async function attachEvidenceToCheck(tx, {
  tenantId,
  caseId,
  checkType,
  evidence,
  evidenceOwner,
  sourceName,
  attachmentRef
}) {
  const rows = await tx.$queryRawUnsafe(
    `UPDATE cath_lab_readiness_checks
        SET evidence_owner = $4,
            source_name = $5,
            attachment_ref = $6,
            metadata = metadata || jsonb_build_object(
              'live_evidence', $7::jsonb,
              'live_evidence_refreshed_at', to_jsonb(NOW())
            ),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND case_id = $2::bigint
        AND check_type = $3
      RETURNING id, check_type, status, evidence_owner, source_name, attachment_ref, metadata`,
    tenantId,
    caseId,
    checkType,
    evidenceOwner,
    sourceName,
    attachmentRef,
    JSON.stringify(evidence)
  );
  return rows[0] || null;
}

export async function refreshReadinessEvidence(caseId, { tenantId } = {}, context = {}) {
  const tid = requireTenantId(tenantId);
  const settings = await getCathQuickWinSettings(tid);
  return setTenantTx(tid, async tx => {
    const cathCase = await caseByIdOrThrow(tx, tid, caseId, { lock: true });
    const bloodEvidence = await resolveBloodReadinessEvidence(
      { tenantId: tid, patientUid: cathCase.patient_uid },
      { db: tx }
    );
    const consentEvidence = await resolveConsentReadinessEvidence(
      { tenantId: tid, patientUid: cathCase.patient_uid, consentType: settings.consentType },
      { db: tx }
    );

    const attached = [];
    const skipped = [];
    const targets = [
      {
        checkType: 'blood_bank',
        evidence: bloodEvidence,
        evidenceOwner: 'blood_bank',
        sourceName: 'blood_requests',
        attachmentRef: bloodEvidence ? `blood_request:${bloodEvidence.blood_request_id}` : null
      },
      {
        checkType: 'consent',
        evidence: consentEvidence,
        evidenceOwner: 'consent_esign',
        sourceName: 'consent_signatures',
        attachmentRef: consentEvidence ? consentEvidence.artifact_path : null
      }
    ];

    for (const target of targets) {
      if (!target.evidence) {
        skipped.push({ check_type: target.checkType, reason: 'no_live_evidence' });
        continue;
      }
      const check = await attachEvidenceToCheck(tx, {
        tenantId: tid,
        caseId: cathCase.id,
        checkType: target.checkType,
        evidence: target.evidence,
        evidenceOwner: target.evidenceOwner,
        sourceName: target.sourceName,
        attachmentRef: target.attachmentRef
      });
      if (!check) {
        skipped.push({ check_type: target.checkType, reason: 'readiness_check_missing' });
        continue;
      }
      await recordClinicalAuditEvent(
        {
          tenantId: tid,
          patientUid: cathCase.patient_uid,
          encounterId: cathCase.encounter_id,
          action: 'cath_lab.readiness_evidence_attached',
          actorUid: context.actorUid,
          actorRole: context.actorRole,
          resourceType: 'cath_lab_readiness_checks',
          resourceTable: 'cath_lab_readiness_checks',
          resourceId: String(check.id),
          requestId: context.requestId,
          metadata: {
            case_id: cathCase.id,
            check_type: target.checkType,
            evidence: target.evidence
          },
          idempotencyKey: `cath_qw_evidence:${tid}:${check.id}:${evidenceFingerprint(target.evidence)}`
        },
        { db: tx }
      );
      attached.push(normalizeDbValue({ ...check, live_evidence: target.evidence }));
    }

    return { case_id: cathCase.id, attached, skipped };
  });
}

// ---------------------------------------------------------------------------
// Order-set application — stages orders through the EXISTING CPOE path only.
// ---------------------------------------------------------------------------

export async function applyCathOrderSetSlot(caseId, slot, { tenantId } = {}, context = {}) {
  const tid = requireTenantId(tenantId);
  const cleanSlot = assertSlot(slot);
  const settings = await getCathQuickWinSettings(tid);
  const familyKey = settings.orderSetFamilies[cleanSlot];
  if (!familyKey) {
    throw AppError.badRequest(
      `No ${cleanSlot} order set is mapped for this tenant`,
      'CATH_QW_ORDER_SET_UNMAPPED'
    );
  }
  const deployed = await resolveDeployedOrderSet({ tenantId: tid, familyKey });
  if (!deployed) {
    throw AppError.badRequest(
      `The mapped ${cleanSlot} order-set family has no deployed version`,
      'CATH_QW_ORDER_SET_NOT_DEPLOYED'
    );
  }
  const cathCase = await caseByIdOrThrow(prisma, tid, caseId);
  if (cathCase.status === 'cancelled') {
    throw AppError.badRequest(
      'Order sets cannot be applied to a cancelled cath case',
      'CATH_QW_CASE_CANCELLED'
    );
  }

  // Standard CPOE validation/signing applies inside applyOrderSet's atomic
  // bulk transaction; no timeline events are written here (audit-only
  // breadcrumb below).
  const orders = await applyOrderSet(
    cathCase.patient_uid,
    cathCase.encounter_id || null,
    deployed.order_set_id,
    context.actorUid,
    tid
  );

  await recordClinicalAuditEvent({
    tenantId: tid,
    patientUid: cathCase.patient_uid,
    encounterId: cathCase.encounter_id,
    action: 'cath_lab.order_set_applied',
    actorUid: context.actorUid,
    actorRole: context.actorRole,
    resourceType: 'cath_lab_cases',
    resourceTable: 'cath_lab_cases',
    resourceId: String(cathCase.id),
    requestId: context.requestId,
    metadata: {
      slot: cleanSlot,
      order_set_id: deployed.order_set_id,
      order_set_code: deployed.code,
      order_set_version: deployed.version,
      staged_count: orders.length,
      failed_count: 0
    },
    idempotencyKey: `cath_qw_order_set:${tid}:${cathCase.id}:${cleanSlot}:${deployed.order_set_id}:${Date.now()}`
  });

  return {
    case_id: cathCase.id,
    slot: cleanSlot,
    order_set: deployed,
    orders: normalizeDbValue(orders)
  };
}

// ---------------------------------------------------------------------------
// Scope 4 — post-procedure follow-up loops (NL9-P3 rails)
// ---------------------------------------------------------------------------

function addDaysIso(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString();
}

async function findOpenCathLoop(tx, { tenantId, sourceRef }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, status
       FROM engagement_follow_up_loops
      WHERE tenant_id = $1::uuid
        AND source_type = '${CATH_FOLLOW_UP_SOURCE_TYPE}'
        AND source_ref = $2
        AND loop_type = '${CATH_FOLLOW_UP_LOOP_TYPE}'
        AND status IN (${OPEN_LOOP_STATUSES.map(status => `'${status}'`).join(', ')})
      LIMIT 1`,
    tenantId,
    sourceRef
  );
  return rows[0] || null;
}

// Emits the cath completion fact into the NL9-P3 rails. For every
// owner-published template whose procedureTypes list matches the finalized
// procedure, one staff-review loop + staff task is created. There is NO
// patient-outreach step here: patient-outbound content stays owner-authored
// inside the engagement campaign rails; cath templates only drive staff
// review loops (e.g. post-PCI review, DAPT review). No templates -> no-op.
export async function emitCathProcedureCompletionFollowUps({
  tenantId,
  procedureLogId,
  actorUid = null
} = {}) {
  const tid = requireTenantId(tenantId);
  const settings = await getCathQuickWinSettings(tid);
  if (!settings.followUpTemplates.length) {
    return { created: [], skipped: [], reason: 'no_templates_configured' };
  }

  const logId = normalizeId(procedureLogId, 'procedure_log_id');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT p.id, p.case_id, p.patient_uid, p.encounter_id, p.procedure_type, p.status,
            c.appointment_id
       FROM cath_procedure_logs p
       JOIN cath_lab_cases c
         ON c.id = p.case_id
        AND c.tenant_id = p.tenant_id
      WHERE p.id = $1::bigint
        AND p.tenant_id = $2::uuid
      LIMIT 1`,
    logId,
    tid
  );
  const procedure = rows[0];
  if (!procedure) {
    throw AppError.notFound('Cath procedure log not found', 'CATH_QW_PROCEDURE_NOT_FOUND');
  }
  if (procedure.status !== 'finalized') {
    return { created: [], skipped: [], reason: 'procedure_not_finalized' };
  }

  const procedureType = String(procedure.procedure_type || '').trim().toLowerCase();
  const matches = settings.followUpTemplates.filter(
    template => template.procedureTypes.includes(procedureType)
  );
  if (!matches.length) {
    return { created: [], skipped: [], reason: 'no_matching_template' };
  }

  return setTenantTx(tid, async tx => {
    const created = [];
    const skipped = [];
    for (const template of matches) {
      const sourceRef = `${procedure.id}:${template.templateKey}`.slice(0, 120);
      const existing = await findOpenCathLoop(tx, { tenantId: tid, sourceRef });
      if (existing) {
        skipped.push({ template_key: template.templateKey, reason: 'open_loop_exists', loop_id: existing.id });
        continue;
      }
      const dueAt = addDaysIso(template.offsetDays);
      const duePolicy = {
        source: 'cath_procedure_template',
        template_key: template.templateKey,
        offset_days: template.offsetDays
      };
      const loopRows = await tx.$queryRawUnsafe(
        `INSERT INTO engagement_follow_up_loops
           (tenant_id, source_type, source_ref, appointment_id, patient_uid,
            owner_uid, loop_type, status, consent_type, due_policy, due_at,
            safe_link_path, created_by, metadata)
         VALUES ($1::uuid, '${CATH_FOLLOW_UP_SOURCE_TYPE}', $2, $3::int, $4::uuid,
                 NULL, '${CATH_FOLLOW_UP_LOOP_TYPE}', 'scheduled', $5, $6::jsonb, $7::timestamptz,
                 '/appointments', $8::uuid, $9::jsonb)
         RETURNING id, tenant_id, source_type, source_ref, appointment_id,
                   patient_uid::text AS patient_uid, loop_type, status, consent_type,
                   due_policy, due_at, safe_link_path, metadata, created_at`,
        tid,
        sourceRef,
        procedure.appointment_id || null,
        procedure.patient_uid,
        CATH_FOLLOW_UP_CONSENT_TYPE,
        JSON.stringify(duePolicy),
        dueAt,
        actorUid,
        JSON.stringify({
          source: 'nl13_p1e_cath_quick_wins',
          case_id: procedure.case_id,
          procedure_log_id: procedure.id,
          procedure_type: procedure.procedure_type,
          template_key: template.templateKey,
          template_title: template.title,
          patient_outreach_policy: 'staff_review_only'
        })
      );
      const loop = loopRows[0];

      await insertFollowUpLoopEvent(tx, {
        tenantId: tid,
        loopId: loop.id,
        eventKind: 'created',
        nextStatus: 'scheduled',
        actorUid,
        reason: CATH_FOLLOW_UP_LOOP_TYPE,
        metadata: duePolicy
      });

      const task = await createTask({
        tenantId: tid,
        taskKind: 'follow_up',
        title: template.title,
        description: template.description,
        patientUid: procedure.patient_uid,
        encounterId: procedure.encounter_id || null,
        relatedResourceType: 'engagement_follow_up_loop',
        relatedResourceId: String(loop.id),
        priority: 'normal',
        assignedToRole: template.staffTaskRole,
        createdBy: actorUid,
        dueAt,
        metadata: {
          source: 'nl13_p1e_cath_quick_wins',
          case_id: procedure.case_id,
          procedure_log_id: procedure.id,
          template_key: template.templateKey
        },
        tx,
        onConflictResourceDoNothing: true
      });

      const step = await insertFollowUpLoopStep(tx, {
        tenantId: tid,
        loopId: loop.id,
        stepKind: 'staff_task',
        status: task ? 'scheduled' : 'suppressed',
        scheduledAt: dueAt,
        templateKey: template.templateKey,
        staffTaskId: task?.id || null,
        result: task ? { task_id: task.id } : {},
        suppressionReason: task ? null : 'open_staff_task_exists',
        metadata: { trigger: CATH_FOLLOW_UP_LOOP_TYPE, template_key: template.templateKey }
      });
      await insertFollowUpLoopEvent(tx, {
        tenantId: tid,
        loopId: loop.id,
        eventKind: task ? 'task_created' : 'step_suppressed',
        actorUid,
        reason: step.suppression_reason || 'staff_task',
        metadata: { staff_task_id: task?.id || null }
      });

      created.push(normalizeDbValue({ loop, task: task || null, step }));
    }
    return { created, skipped };
  });
}

export const __testing__ = {
  evidenceFingerprint,
  assertSlot
};

export default {
  getCaseQuickWins,
  refreshReadinessEvidence,
  applyCathOrderSetSlot,
  resolveBloodReadinessEvidence,
  resolveConsentReadinessEvidence,
  emitCathProcedureCompletionFollowUps
};
