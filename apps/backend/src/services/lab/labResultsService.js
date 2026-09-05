// src/services/lab/labResultsService.js
//
// Sprint 3 — Lab results ingestion + critical alerts + pathologist
// worklist. Persists ORU^R01 messages from analyzers into lab_results,
// evaluates signed facility-bound threshold policies, routes unmatched
// results into owned exceptions, and exposes the pathologist sign-off workflow.

import crypto from 'node:crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { parseHL7 } from '../hl7/hl7Parser.js';
import { AppError } from '../../utils/AppError.js';
import {
  canIngestLabInterface,
  canSignOffLabResults,
  isAdmin,
} from '../../utils/roleHelpers.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { boundedInteger } from '../../utils/pagination.js';
import { sendStaffNotifications } from '../notification/staffNotificationService.js';
import { emitCriticalLabAlertAcknowledged } from '../clinical/canonicalOperationalBridgeService.js';
// A CRITICAL lab result, its alert, exact acknowledgement task/SLA, and
// canonical evidence are one clinical transaction. Only outward notification
// and realtime fan-out remain post-commit best-effort work.
import {
  materializeLabCriticalAlertGeneration,
  supersedeCriticalAlertWithDiagnosticGenerationTx,
} from './labCriticalAlertService.js';
import { evaluateCriticalThreshold } from './labCriticalThresholdService.js';
import { applyLabThresholdAssessmentTx } from './labThresholdExceptionService.js';
import { labThresholdAssessmentEvidence } from './labThresholdPolicyContract.js';
import {
  claimLabResultIngestCommand,
  completeLabResultIngestCommand,
  finaliseHttpIdempotencyInTx,
} from './labResultIngestCommandService.js';
import { applyLoincMappingEnrichment } from './labCodeMappingService.js';
import { lockResultsInboxResourceTx } from '../results/resultsInboxResourceLock.js';
import { emitLabEvent } from '../../utils/websocket/realtimeEmitter.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { resolveMergedPatientUidSet } from '../clinical/mergedPatientReadUnion.js';
import { publishInpatientDiagnosticResourceLinkedTx } from '../emr/inpatientPathwayDomainService.js';
import {
  acknowledgeLabCriticalAlertTaskFromTrustedWorkflow,
  LAB_CRITICAL_ALERT_ACK_CONTRACT_VERSION,
} from '../workflow/taskService.js';
import {
  isTaskHumanOwnerRole,
  resolveCurrentHumanActorTx,
} from '../workflow/workflowHumanOwnerService.js';
import { getResultEpisodeReleaseDecision } from '../portal/portalAccessService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  classifySignedLabEpisode as classifyDiagnosticLabEpisode,
} from '../diagnostics/diagnosticClassification.js';
import { createLabDiagnosticGenerationTx } from '../diagnostics/diagnosticResultGenerationService.js';
import { SIGN_OFF_DECISIONS, recordMarkersFromSignedResults } from '../clinical/bloodborneMarkerService.js';

// Cap on the CRITICAL-lab alert fan-out. The candidate set is "clinicians
// responsible for this patient" (ordering doctor, order placer, attending on an
// open admission or ED visit), which is realistically single digits — so this is
// a runaway guard, not a routine trim. Raised from a bare literal 10 and paired
// with an exact dropped-count report, because a critical value that never
// reaches a responsible clinician is a patient-safety event, not a log line.
const CRITICAL_ALERT_RECIPIENT_CAP = 50;

// Canonical clinical timeline invariant (docs/CANONICAL_CLINICAL_TIMELINE.md):
// lab result entry and pathologist sign-off are patient-facing clinical
// writes, so they persist the lab detail row plus one clinical_timeline_events
// row and one clinical_audit_events row in the SAME transaction. This helper
// runs on the transaction client (`tx`, required) and is NOT swallowed — a
// failure propagates and aborts the lab write so the audit layer can never
// lag the detail row (recordCanonicalClinicalEvent itself tolerates only a
// genuinely-absent canonical table, SQLSTATE 42P01). The legacy
// `investigations` table carries no encounter linkage, so these events attach
// to the patient timeline with encounter_id=null; the CPOE clinical_orders
// side of the same order carries the encounter-scoped events.
async function recordCanonicalLabEvent({
  tx, tenantId, patientUid, eventType, eventStatus = null,
  sourceTable = 'lab_results', resourceType = 'lab_result', resourceId,
  actorUid = null, actorRole = null,
  summary, payload = {}, afterState = null, occurredAt = null,
}) {
  const stamp = occurredAt?.toISOString?.() || new Date().toISOString();
  return recordCanonicalClinicalEvent({
    tenantId,
    patientUid,
    encounterId: null,
    eventType,
    eventSubtype: 'lab',
    eventStatus,
    sourceTable,
    sourceId: String(resourceId),
    resourceType,
    resourceId: String(resourceId),
    actorUid,
    actorRole,
    occurredAt,
    visibleToPatient: false,
    summary,
    payload,
    metadata: payload,
    afterState,
    tags: ['lab', 'lab_result'],
    timelineIdempotencyKey: `${sourceTable}:${resourceId}:${eventType}:${eventStatus || 'none'}:${patientUid}:${stamp}`,
    auditIdempotencyKey: `${sourceTable}:${resourceId}:audit:${eventType}:${eventStatus || 'none'}:${patientUid}:${stamp}`,
  }, { db: tx });
}

function asNumericOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Stage-3 chip G — investigations.status values from which the order
// is considered "pre-result" and should advance to IN_PROGRESS once a
// lab_results row is filed. Terminal states (COMPLETED/CANCELLED) and
// already-running (IN_PROGRESS) are left alone. See migration 217.
const INVESTIGATION_PRE_RESULT_STATUSES = ['REQUESTED', 'PENDING', 'SCHEDULED', 'COLLECTED'];
const RESULTABLE_INVESTIGATION_STATUSES = new Set([
  ...INVESTIGATION_PRE_RESULT_STATUSES,
  'IN_PROGRESS',
]);
const RESULTABLE_BOOKING_STATUSES = new Set([
  'BOOKED',
  'CONFIRMED',
  'DISPATCHED',
  'COLLECTED',
  'PROCESSING',
]);

// Sign-off decisions that mean "the value of record changed" (mig-151
// vocabulary is verified/rejected/corrected; 'amended' is accepted as the
// synonym upstream UIs use). These restart the critical-result safety loop in
// the sign-off transaction; only transport fan-out remains post-commit.
const CORRECTIVE_SIGNOFF_DECISIONS = new Set(['corrected', 'amended']);
const SUPPORTED_SIGNOFF_DECISIONS = new Set(['verified', ...CORRECTIVE_SIGNOFF_DECISIONS]);

// Statuses an UNSIGNED result may hold and still be eligible for the initial
// verified sign-off.
//
// 'final' is here because the ORU ingest stores OBX-11 = 'F' as status 'final'
// with signed_off_at NULL — an analyzer asserting SOURCE finality, which is a
// different thing from this hospital's LOCAL authorisation. Those rows were
// unsignable: the guard below demanded 'preliminary', and the stamping UPDATE's
// verified branch matched only 'preliminary', so a pathologist who selected one
// got LAB_SIGNOFF_ILLEGAL_INITIAL_STATE on every attempt and the result could
// never reach the patient, the report PDF or discharge terminality. Worse, one
// such row failed the WHOLE batch through the stamped.length !== ids.length
// check, so a single analyzer-final analyte blocked sign-off of every other
// result selected with it.
//
// listPendingSignOff already surfaces exactly this shape
// (signed_off_at IS NULL AND status IN ('preliminary','final')), so the
// worklist and the sign-off contract disagreed. The worklist encodes the
// intent; this set makes the contract agree with it.
//
// Signing an unsigned 'final' re-writes status to 'final' (idempotent) and
// stamps signed_off_at/by, so the source assertion is preserved and the local
// authorisation is recorded. This does NOT relax the corrective branch, which
// still requires an already-signed predecessor.
const INITIAL_SIGNOFF_ELIGIBLE_STATUSES = new Set(['preliminary', 'final']);

// Sign-off decisions the blood-borne marker recorder accepts (spec 2026-09-04
// §7.1). Kept as its own set so a sign-off vocabulary that later grows a
// decision the recorder rejects skips the hook instead of throwing inside it.
const BLOODBORNE_MARKER_DECISIONS = new Set(SIGN_OFF_DECISIONS);

const NORMAL_LAB_FLAGS = new Set(['N']);
const ABNORMAL_LAB_FLAGS = new Set(['L', 'H', 'A']);
const CRITICAL_LAB_FLAGS = new Set(['LL', 'HH', 'AA']);
const SUPPORTED_LAB_FLAGS = new Set([
  ...NORMAL_LAB_FLAGS,
  ...ABNORMAL_LAB_FLAGS,
  ...CRITICAL_LAB_FLAGS,
]);
const POSTGRES_INT4_MAX = 2_147_483_647;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUPPORTED_ORU_MESSAGE_TYPES = new Set(['ORU^R01', 'ORU^R01^ORU_R01']);
const NUMERIC_LOOKING_ORU_ORDER_ID = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const RESERVED_ORU_ORDER_NAMESPACE = /^(?:VHINV|VHBOOK)/i;
const VH_INVESTIGATION_ORDER_ID = /^VHINV-([1-9]\d*)$/;

function normalizeManualLabFlag(value) {
  if (value == null || String(value).trim() === '') return null;
  const flag = String(value).trim().toUpperCase();
  if (!SUPPORTED_LAB_FLAGS.has(flag)) {
    throw AppError.badRequest(
      'abnormal_flag is not in the supported lab source vocabulary',
      'LAB_RESULT_ABNORMAL_FLAG_UNSUPPORTED',
    );
  }
  return flag;
}

export function classifySignedLabEpisode(rows) {
  return classifyDiagnosticLabEpisode(rows);
}

function resultSnapshotHash(rows) {
  const snapshot = rows.map((row) => ({
    id: Number(row.id),
    test_code: row.test_code ?? null,
    value_text: row.value_text ?? null,
    value_numeric: row.value_numeric == null ? null : String(row.value_numeric),
    unit: row.unit ?? null,
    abnormal_flag: row.abnormal_flag ?? null,
    is_critical: row.is_critical === true,
    criticality_status: row.criticality_status ?? null,
    facility_id: row.facility_id == null ? null : Number(row.facility_id),
    threshold_policy_bundle_id: row.threshold_policy_bundle_id ?? null,
    threshold_policy_rule_id: row.threshold_policy_rule_id ?? null,
    threshold_catalog_entry_id: row.threshold_catalog_entry_id ?? null,
    threshold_evaluated_at: row.threshold_evaluated_at?.toISOString?.()
      || row.threshold_evaluated_at
      || null,
    status: row.status ?? null,
    signed_off_at: row.signed_off_at?.toISOString?.() || row.signed_off_at || null,
  }));
  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function normalizeSignoffResultIds(resultIds) {
  if (!Array.isArray(resultIds) || resultIds.length === 0) {
    throw AppError.badRequest('result_ids[] is required');
  }
  const normalized = resultIds.map(Number);
  if (normalized.some((id) => (
    !Number.isSafeInteger(id) || id <= 0 || id > POSTGRES_INT4_MAX
  ))) {
    throw AppError.badRequest('result_ids[] must contain positive integer result ids');
  }
  return [...new Set(normalized)].sort((a, b) => a - b);
}

function deriveSignoffEpisode(rows) {
  const investigationIds = new Set(
    rows.filter((row) => row.investigation_id != null).map((row) => Number(row.investigation_id)),
  );
  const bookingIds = new Set(
    rows.filter((row) => row.booking_id != null).map((row) => Number(row.booking_id)),
  );
  const allInvestigationLinked = rows.every((row) => row.investigation_id != null);
  const allBookingFallback = rows.every(
    (row) => row.investigation_id == null && row.booking_id != null,
  );
  if (allInvestigationLinked && investigationIds.size === 1) {
    const id = [...investigationIds][0];
    return { type: 'investigation', id, key: `investigation:${id}` };
  }
  if (allBookingFallback && bookingIds.size === 1) {
    const id = [...bookingIds][0];
    return { type: 'booking', id, key: `booking:${id}` };
  }
  if (investigationIds.size === 0 && bookingIds.size === 0) {
    throw AppError.badRequest(
      'Lab results must be linked to an investigation order or booking before sign-off',
      'LAB_RESULT_ORDER_LINK_REQUIRED',
      { result_ids: rows.map((row) => Number(row.id)) },
    );
  }
  throw AppError.badRequest(
    'All result_ids in a sign-off must belong to one source episode',
    'LAB_SIGNOFF_MULTI_EPISODE_BATCH',
  );
}

function oruOrderNamespaceRequired() {
  return AppError.badRequest(
    'ORU order identifier requires an explicit supported namespace',
    'LAB_ORU_ORDER_NAMESPACE_REQUIRED',
  );
}

export function parseOruOrderIdentity(value) {
  const orderIdentity = String(value || '').trim();
  if (!orderIdentity) {
    return { kind: 'external', investigationId: null, externalOrderId: null };
  }

  if (NUMERIC_LOOKING_ORU_ORDER_ID.test(orderIdentity)) {
    throw oruOrderNamespaceRequired();
  }

  if (RESERVED_ORU_ORDER_NAMESPACE.test(orderIdentity)) {
    const match = VH_INVESTIGATION_ORDER_ID.exec(orderIdentity);
    const investigationId = match ? Number(match[1]) : null;
    if (
      !Number.isSafeInteger(investigationId)
      || investigationId <= 0
      || investigationId > POSTGRES_INT4_MAX
    ) {
      throw oruOrderNamespaceRequired();
    }
    return { kind: 'investigation', investigationId, externalOrderId: null };
  }

  return { kind: 'external', investigationId: null, externalOrderId: orderIdentity };
}

async function createCorrectedCriticalAlertGeneration({
  tx = null,
  tenantId,
  result,
  decision,
  signoffId,
  signedOffBy,
  orderingClinicianUid,
  criticality,
  preappliedThresholdAssessment,
}) {
  const materialized = await materializeLabCriticalAlertGeneration({
    tx,
    tenantId,
    resultId: result.id,
    expectedPatientUid: result.patient_uid,
    criticality,
    preappliedThresholdAssessment,
    orderingClinicianUid,
    source: 'lab_corrective_signoff',
    generationSignoffId: signoffId,
    generationDecision: decision,
    generationActorUid: signedOffBy,
  });
  return {
    ...materialized,
    skipped: !materialized.created,
    staleSignoff: materialized.skippedReason === 'stale_corrective_signoff'
      || materialized.skippedReason === 'corrective_signoff_already_materialized',
  };
}

function labResultSourceMismatch() {
  return AppError.badRequest(
    'Lab result source does not match the patient or investigation',
    'LAB_RESULT_SOURCE_MISMATCH',
  );
}

async function lockAndValidateOrderedResultSource({
  tx,
  tenantId,
  patientUid,
  bookingId,
  investigationId,
  allowMissingInvestigation = false,
}) {
  if (bookingId != null) {
    const bookingRows = await tx.$queryRawUnsafe(
      `SELECT booking.id, booking.patient_id, booking.investigation_id,
              booking.status AS booking_status
         FROM investigation_bookings AS booking
        WHERE booking.id = $1::bigint
          AND booking.tenant_id = $2::uuid
        LIMIT 1
        FOR SHARE OF booking`,
      bookingId,
      tenantId,
    );
    const booking = bookingRows[0];
    if (!booking) throw labResultSourceMismatch();
    if (!RESULTABLE_BOOKING_STATUSES.has(String(booking.booking_status || '').toUpperCase())) {
      throw labResultSourceMismatch();
    }

    const patientRows = await tx.$queryRawUnsafe(
      `SELECT patient.id, patient.uid, patient.name
         FROM users AS patient
        WHERE patient.id = $1::int
          AND patient.tenant_id = $2::uuid
          AND patient.role = 'PATIENT'
          AND patient.is_active = TRUE
          AND patient.status = 'active'
          AND patient.is_deleted = FALSE
        LIMIT 1
        FOR SHARE OF patient`,
      Number(booking.patient_id),
      tenantId,
    );
    const patient = patientRows[0];
    if (
      !patient
      || String(patient.uid).toLowerCase() !== String(patientUid).toLowerCase()
    ) {
      throw labResultSourceMismatch();
    }

    const bookingInvestigationId = booking.investigation_id == null
      ? null
      : Number(booking.investigation_id);
    if (bookingInvestigationId == null) {
      if (!allowMissingInvestigation) throw labResultSourceMismatch();
        return {
          bookingId: Number(booking.id),
          investigationId: null,
          admissionId: null,
          orderedTestCode: null,
        patientUid: String(patient.uid),
        patientName: patient.name ?? null,
      };
    }
    if (investigationId != null && Number(investigationId) !== bookingInvestigationId) {
      throw labResultSourceMismatch();
    }

    const investigationRows = await tx.$queryRawUnsafe(
      `SELECT investigation.id, investigation.patient_id,
              investigation.patient_uid, investigation.status,
              investigation.test_code, investigation.admission_id
         FROM investigations AS investigation
        WHERE investigation.id = $1::int
          AND investigation.tenant_id = $2::uuid
        LIMIT 1
        FOR UPDATE OF investigation`,
      bookingInvestigationId,
      tenantId,
    );
    const investigation = investigationRows[0];
    if (
      !investigation
      || String(investigation.patient_uid).toLowerCase() !== String(patient.uid).toLowerCase()
      || (investigation.patient_id != null
        && Number(investigation.patient_id) !== Number(patient.id))
      || !RESULTABLE_INVESTIGATION_STATUSES.has(
        String(investigation.status || '').toUpperCase(),
      )
    ) {
      throw labResultSourceMismatch();
    }

    return {
      bookingId: Number(booking.id),
      investigationId: Number(investigation.id),
      orderedTestCode: investigation.test_code ?? null,
      admissionId: investigation.admission_id == null
        ? null
        : Number(investigation.admission_id),
      patientUid: String(patient.uid),
      patientName: patient.name ?? null,
    };
  }

  const rows = await tx.$queryRawUnsafe(
      `SELECT investigation.id AS investigation_id,
             investigation.patient_uid AS investigation_patient_uid,
             investigation.status AS investigation_status,
             investigation.test_code AS investigation_test_code,
             investigation.admission_id AS investigation_admission_id,
             patient.name AS patient_name
       FROM investigations AS investigation
       JOIN users AS patient
        ON patient.uid = investigation.patient_uid
        AND patient.tenant_id = investigation.tenant_id
        AND patient.role = 'PATIENT'
        AND patient.is_active = TRUE
        AND patient.status = 'active'
        AND patient.is_deleted = FALSE
        AND (investigation.patient_id IS NULL OR investigation.patient_id = patient.id)
      WHERE investigation.id = $1::int
        AND investigation.tenant_id = $2::uuid
      LIMIT 1
      FOR UPDATE OF investigation
      FOR SHARE OF patient`,
    investigationId,
    tenantId,
  );
  const source = rows[0];
  if (
    !source
    || String(source.investigation_patient_uid).toLowerCase() !== String(patientUid).toLowerCase()
    || !RESULTABLE_INVESTIGATION_STATUSES.has(
      String(source.investigation_status || '').toUpperCase(),
    )
  ) {
    throw labResultSourceMismatch();
  }
  return {
    bookingId: null,
    investigationId: Number(source.investigation_id),
    orderedTestCode: source.investigation_test_code ?? null,
    admissionId: source.investigation_admission_id == null
      ? null
      : Number(source.investigation_admission_id),
    patientUid: String(patientUid),
    patientName: source.patient_name ?? null,
  };
}

function oruOrderAnalyteMismatch() {
  return AppError.badRequest(
    'ORU observation identity does not match the ordered investigation',
    'LAB_ORU_ORDER_ANALYTE_MISMATCH',
  );
}

function assertOruOrderedAnalyteContract({ orderedTestCode, obrTestIdentity, obxRows }) {
  const orderCode = String(orderedTestCode || '').trim();
  const obrCode = String(obrTestIdentity || '').split('^', 1)[0].trim();
  if (
    !orderCode
    || !obrCode
    || obrCode !== orderCode
    || obxRows.some(row => String(row.testCode || '').trim() !== orderCode)
  ) {
    throw oruOrderAnalyteMismatch();
  }
}

async function lockAndResolveOruResultSource({
  tx,
  tenantId,
  patientUid,
  requestedInvestigationId,
  obrTestIdentity,
  obxRows,
}) {
  if (requestedInvestigationId != null) {
    const resultSource = await lockAndValidateOrderedResultSource({
      tx,
      tenantId,
      patientUid,
      bookingId: null,
      investigationId: requestedInvestigationId,
    });
    assertOruOrderedAnalyteContract({
      orderedTestCode: resultSource.orderedTestCode,
      obrTestIdentity,
      obxRows,
    });
    return resultSource;
  }

  const rows = await tx.$queryRawUnsafe(
    `SELECT patient.uid, patient.name
       FROM users AS patient
      WHERE patient.uid = $1::uuid
        AND patient.tenant_id = $2::uuid
        AND patient.role = 'PATIENT'
        AND patient.is_active = TRUE
        AND patient.status = 'active'
        AND patient.is_deleted = FALSE
      LIMIT 1
      FOR SHARE OF patient`,
    patientUid,
    tenantId,
  );
  const patient = rows[0];
  if (!patient) throw labResultSourceMismatch();
  return {
    bookingId: null,
    investigationId: null,
    admissionId: null,
    orderedTestCode: null,
    patientUid: String(patient.uid),
    patientName: patient.name ?? null,
  };
}

export function normalizeOruObxRows(parsed) {
  const parsedRows = parsed.obx || [];
  const segments = (parsed.segments || []).filter((segment) => segment.type === 'OBX');
  if (segments.length !== parsedRows.length) {
    throw AppError.badRequest(
      'ORU message has inconsistent OBX segments',
      'LAB_ORU_SEGMENT_IDENTITY_REQUIRED',
    );
  }

  const seenSegmentIds = new Set();
  return parsedRows.map((obx, index) => {
    const fields = segments[index]?.fields || [];
    const rawSegmentId = String(fields[1] || '');
    const segmentId = Number(rawSegmentId);
    if (
      !/^\d+$/.test(rawSegmentId)
      || !Number.isSafeInteger(segmentId)
      || segmentId <= 0
      || segmentId > POSTGRES_INT4_MAX
      || seenSegmentIds.has(segmentId)
    ) {
      throw AppError.badRequest(
        'ORU message requires a unique positive OBX-1 for every result',
        'LAB_ORU_SEGMENT_IDENTITY_REQUIRED',
      );
    }
    seenSegmentIds.add(segmentId);

    const observationId = String(obx.observationId || fields[3] || '');
    const [code = '', text = '', codingSystem = ''] = observationId.split('^');
    const normalizedCodingSystem = codingSystem.trim().toUpperCase();
    const testCode = code.trim();
    const valueText = String(obx.value ?? '').trim();
    if (!testCode || !valueText) {
      throw AppError.badRequest(
        'Every ORU OBX requires a test code in OBX-3 and a value in OBX-5',
        'LAB_ORU_OBSERVATION_REQUIRED',
      );
    }
    return {
      ...obx,
      segmentId,
      raw: fields.join('|'),
      loincCode: ['LN', 'LOINC'].includes(normalizedCodingSystem) ? testCode : null,
      testCode,
      testName: text.trim() || testCode,
    };
  });
}

export function assertSupportedOruEnvelope(parsed) {
  const segments = parsed.segments || [];
  const positionsFor = type => segments
    .map((segment, index) => (segment.type === type ? index : -1))
    .filter(index => index >= 0);
  const mshPositions = positionsFor('MSH');
  const pidPositions = positionsFor('PID');
  const orcPositions = positionsFor('ORC');
  const obrPositions = positionsFor('OBR');
  const obxPositions = positionsFor('OBX');
  const pidPosition = pidPositions[0];
  const obrPosition = obrPositions[0];
  const groupIsUnambiguous = mshPositions.length === 1
    && mshPositions[0] === 0
    && pidPositions.length === 1
    && orcPositions.length <= 1
    && obrPositions.length === 1
    && obxPositions.length > 0
    && pidPosition < obrPosition
    && obxPositions.every(position => position > obrPosition)
    && (
      orcPositions.length === 0
      || (orcPositions[0] > pidPosition && orcPositions[0] < obrPosition)
    );
  if (!groupIsUnambiguous) {
    throw AppError.badRequest(
      'ORU message must contain exactly one patient/order observation group',
      'LAB_ORU_AMBIGUOUS_OBSERVATION_GROUP',
    );
  }
  if (!SUPPORTED_ORU_MESSAGE_TYPES.has(String(parsed.msh?.messageType || '').trim())) {
    throw AppError.badRequest(
      'Only ORU^R01 result messages are supported',
      'LAB_ORU_MESSAGE_TYPE_UNSUPPORTED',
    );
  }
}

function nullableId(value) {
  return value == null ? null : Number(value);
}

function isMatchingOruReplay(existing, expected) {
  return String(existing.patient_uid).toLowerCase() === String(expected.patientUid).toLowerCase()
    && nullableId(existing.booking_id) === nullableId(expected.bookingId)
    && nullableId(existing.investigation_id) === nullableId(expected.investigationId)
    && String(existing.performed_by_lab || '') === String(expected.performedByLab || '')
    && String(existing.raw_obx || '') === String(expected.rawObx || '');
}

function normalizeOruActorRoles(actorRole, actorRoles) {
  const supplied = [
    ...(Array.isArray(actorRoles) ? actorRoles : (actorRoles ? [actorRoles] : [])),
    actorRole,
  ];
  return [...new Set(supplied
    .map(role => String(role || '').trim().toUpperCase())
    .filter(Boolean))];
}

function configuredOruBindingValues(metadata, key) {
  const value = metadata && typeof metadata === 'object' ? metadata[key] : null;
  if (!Array.isArray(value)) return [];
  return value
    .map(item => String(item || '').trim().toLowerCase())
    .filter(Boolean);
}

export async function resolveTrustedOruChannel({
  tx,
  tenantId,
  sendingApp,
  actorUid,
  actorRole = null,
  actorRoles = [],
  apiClient: _apiClient = null,
  apiClientId = null,
  apiClientTenantId = null,
}) {
  const authenticatedActorRoles = normalizeOruActorRoles(actorRole, actorRoles);
  if (!UUID_PATTERN.test(String(actorUid || ''))) {
    throw AppError.forbidden(
      'ORU ingestion actor is not authorized',
      'LAB_ORU_ACTOR_NOT_AUTHORIZED',
    );
  }

  const actorRows = await tx.$queryRawUnsafe(
    `SELECT actor.uid, actor.role
       FROM users AS actor
      WHERE actor.tenant_id = $1::uuid
         AND actor.uid = $2::uuid
         AND actor.is_active = true
         AND actor.status = 'active'
         AND actor.is_deleted = false
      LIMIT 1
      FOR SHARE OF actor`,
    tenantId,
    actorUid,
  );
  const actor = actorRows[0];
  const databaseActorRole = String(actor?.role || '').trim().toUpperCase();
  if (
    !actor
    || !databaseActorRole
    || !authenticatedActorRoles.includes(databaseActorRole)
    || !canIngestLabInterface(databaseActorRole)
  ) {
    throw AppError.forbidden(
      'ORU ingestion actor is not authorized',
      'LAB_ORU_ACTOR_NOT_AUTHORIZED',
    );
  }

  const analyzerRows = await tx.$queryRawUnsafe(
    `SELECT analyzer.id, analyzer.analyzer_code, analyzer.facility_id,
            analyzer.metadata
       FROM lab_analyzers AS analyzer
      WHERE analyzer.tenant_id = $1::uuid
        AND analyzer.status = 'active'
        AND analyzer.interface_kind = 'hl7'
      ORDER BY analyzer.id
      FOR SHARE OF analyzer`,
    tenantId,
  );
  const analyzer = analyzerRows.find(row => row.analyzer_code === sendingApp) || null;
  if (!analyzer) {
    throw AppError.forbidden(
      'ORU sender is not configured for this tenant',
      'LAB_ORU_SENDER_NOT_AUTHORIZED',
    );
  }

  const normalizedApiClientId = apiClientId == null ? '' : String(apiClientId).trim();
  const hasDatabaseApiClient = normalizedApiClientId.length > 0;
  const apiClientTenantMatches = String(apiClientTenantId || '').toLowerCase()
    === String(tenantId).toLowerCase();
  if (hasDatabaseApiClient && !apiClientTenantMatches) {
    throw AppError.forbidden(
      'Authenticated ORU channel does not match the request tenant',
      'LAB_ORU_API_CLIENT_TENANT_MISMATCH',
    );
  }
  const normalizedActorUid = String(actorUid).toLowerCase();
  const apiClientMatches = hasDatabaseApiClient && apiClientTenantMatches
    ? analyzerRows.filter(row => configuredOruBindingValues(
      row.metadata,
      'hl7_api_client_ids',
    ).includes(normalizedApiClientId.toLowerCase()))
    : [];
  const actorMatches = analyzerRows.filter(row => configuredOruBindingValues(
    row.metadata,
    'hl7_actor_uids',
  ).includes(normalizedActorUid));
  const boundByApiClient = apiClientMatches.length === 1
    && Number(apiClientMatches[0].id) === Number(analyzer.id);
  const boundByActor = actorMatches.length === 1
    && Number(actorMatches[0].id) === Number(analyzer.id);
  const explicitActorBindingConflicts = actorMatches.length > 0 && !boundByActor;
  const channelIsTrusted = hasDatabaseApiClient
    ? boundByApiClient && !explicitActorBindingConflicts
    : boundByActor;
  if (!channelIsTrusted) {
    throw AppError.forbidden(
      'Authenticated ORU channel does not match the configured analyzer',
      'LAB_ORU_ANALYZER_UNTRUSTED',
    );
  }

  return {
    actor,
    analyzer,
    authenticatedActorRoles: [databaseActorRole],
    databaseActorRole,
    bindingMode: hasDatabaseApiClient ? 'api_client' : 'actor_uid',
    bindingIdentity: hasDatabaseApiClient ? normalizedApiClientId : String(actorUid),
  };
}

function isMatchingStoredOruResult(existing, expected, { analyzerId, claimId }) {
  const storedClaimId = existing.oru_ingest_message_id == null
    ? null
    : String(existing.oru_ingest_message_id);
  return isMatchingOruReplay(existing, expected)
    && (existing.analyzer_id == null || Number(existing.analyzer_id) === Number(analyzerId))
    && (storedClaimId == null || storedClaimId === String(claimId))
    && String(existing.loinc_code ?? '') === String(expected.loincCode ?? '')
    && String(existing.test_code || '') === String(expected.testCode || '')
    && String(existing.test_name || '') === String(expected.testName || '')
    && String(existing.value_text ?? '') === String(expected.valueText ?? '')
    && (
      existing.value_numeric == null
        ? expected.valueNumeric == null
        : expected.valueNumeric != null
          && Number(existing.value_numeric) === Number(expected.valueNumeric)
    )
    && String(existing.unit ?? '') === String(expected.unit ?? '')
    && String(existing.reference_range ?? '') === String(expected.referenceRange ?? '')
    && String(existing.abnormal_flag ?? '') === String(expected.abnormalFlag ?? '')
    && String(existing.status || '') === String(expected.status || '');
}

function isMatchingClaimedOruResultIdentity(existing, expected, { analyzerId, claimId }) {
  return isMatchingOruReplay(existing, expected)
    && Number(existing.analyzer_id) === Number(analyzerId)
    && String(existing.oru_ingest_message_id) === String(claimId)
    && String(existing.loinc_code ?? '') === String(expected.loincCode ?? '')
    && String(existing.test_code || '') === String(expected.testCode || '')
    && String(existing.test_name || '') === String(expected.testName || '');
}

function oruReplayConflict() {
  return AppError.conflict(
    'HL7 message replay does not match the stored result',
    'LAB_ORU_REPLAY_CONFLICT',
  );
}

export { evaluateCriticalThreshold } from './labCriticalThresholdService.js';

/**
 * Parse an HL7 ORU^R01 message and persist its OBX rows into
 * lab_results. Returns the created result rows + any critical alerts
 * that fired.
 *
 * Maps each OBX to a lab_results row. PID-3 is an identity assertion only:
 * the canonical patient uid/name come from the tenant-owned user/order rows.
 *
 * A local investigation reference must use `VHINV-<positive int>` in
 * ORC-2/OBR-2 and resolve exactly to the active patient/investigation in
 * PID-3. The investigation must also have a structured test_code that exactly
 * matches the code component of OBR-4 and every OBX-3; panels without a
 * structured component contract therefore fail closed. Bare numeric and
 * malformed reserved identifiers are rejected before the transaction starts.
 * Absent or unrecognized external alphanumeric order identities retain the
 * patient-only shadow path until governed external-order mapping is designed.
 *
 * Critical detection runs synchronously after persist; we don't fan
 * out notifications here (notification fan-out is the alert
 * consumer's job — see lab_critical_alerts subscribers).
 */
export async function ingestOruMessage(message, {
  tenantId,
  actorUid = null,
  actorRole = null,
  actorRoles = [],
  apiClient = null,
  apiClientId = null,
  apiClientTenantId = null,
} = {}) {
  if (!message || typeof message !== 'string') {
    throw AppError.badRequest('HL7 message is required');
  }
  const rawMessage = message;
  const parsed = parseHL7(message);
  if (!parsed.msh) throw AppError.badRequest('Missing MSH segment');
  assertSupportedOruEnvelope(parsed);

  const messageControlId = String(parsed.msh.messageControlId || '').trim();
  if (!messageControlId || messageControlId.length > 100) {
    throw AppError.badRequest(
      'ORU message requires an MSH-10 message control ID',
      'LAB_ORU_MESSAGE_CONTROL_REQUIRED',
    );
  }
  const sendingApp = String(parsed.msh.sendingApp || '').trim();
  if (!sendingApp || sendingApp.length > 120) {
    throw AppError.badRequest(
      'ORU message requires an MSH-3 sending application',
      'LAB_ORU_SENDING_APPLICATION_REQUIRED',
    );
  }

  // Patient identification — PID
  const assertedPatientUid = parsed.pid?.patientId || parsed.pid?.uid;
  if (!assertedPatientUid) throw AppError.badRequest('Missing patient identifier (PID-3)');
  if (!UUID_PATTERN.test(String(assertedPatientUid))) throw labResultSourceMismatch();

  if (!(parsed.obx || []).length) {
    throw AppError.badRequest(
      'ORU message requires at least one OBX segment',
      'LAB_ORU_OBX_REQUIRED',
    );
  }
  const obxRows = normalizeOruObxRows(parsed);

  // Terminology WP3 (migration 721) — dark LOINC enrichment. When the env
  // kill switch AND the tenant flag are both on and a curated mapping row
  // matches, stamp the OBX rows whose OBX-3 did not assert LN/LOINC itself.
  // Fail-open by contract (the helper never throws) and runs on the plain
  // pool BEFORE the ingest transaction, so it can never abort the clinical
  // write. Deterministic given the same curated rows, so exact replays of a
  // completed message still match the stored loinc_code.
  await applyLoincMappingEnrichment({
    tenantId,
    sourceKey: sendingApp,
    rows: obxRows,
    codeKey: 'testCode',
    loincKey: 'loincCode',
  });

  // ORC-2/OBR-2 local linkage is table-explicit. Never infer a local table
  // from a bare integer: investigation and booking sequences can collide.
  // `VHINV-<id>` links directly to investigations. VHBOOK is reserved but is
  // not accepted until a real producer and booking-namespace contract exist.
  const orcSegment = (parsed.segments || []).find((segment) => segment.type === 'ORC');
  const orcPlacerOrderId = String(orcSegment?.fields?.[2] || '').trim();
  const obrPlacerOrderId = String(parsed.obr?.placerOrderNumber || '').trim();
  if (orcPlacerOrderId && obrPlacerOrderId && orcPlacerOrderId !== obrPlacerOrderId) {
    throw AppError.badRequest(
      'ORU order identifiers do not agree',
      'LAB_ORU_ORDER_IDENTITY_MISMATCH',
    );
  }
  const placerOrderId = orcPlacerOrderId || obrPlacerOrderId;
  const orderIdentity = parseOruOrderIdentity(placerOrderId);
  const requestedInvestigationId = orderIdentity.investigationId;

  // One tenant transaction owns the immutable message claim, every OBX row,
  // canonical evidence, order advance, and all critical alert/task/SLA
  // obligations. Post-commit work is transport-only notification/realtime.
  const phaseOne = await setTenantTx(tenantId, async (tx) => {
    const {
      actor,
      analyzer,
      authenticatedActorRoles,
      databaseActorRole,
      bindingMode,
      bindingIdentity,
    } = await resolveTrustedOruChannel({
      tx,
      tenantId,
      actorUid,
      actorRole,
      actorRoles,
      apiClient,
      apiClientId,
      apiClientTenantId,
      sendingApp,
    });
    const insertedClaims = await tx.$queryRawUnsafe(
      `INSERT INTO lab_oru_ingest_messages
         (tenant_id, trusted_sender_identity, message_control_id, raw_message,
          obx_count, authenticated_actor_uid, authenticated_actor_roles,
          sender_binding_mode, sender_binding_identity)
       VALUES ($1::uuid, $2, $3, $4, $5::int, $6::uuid, $7::text[], $8, $9)
       ON CONFLICT (tenant_id, trusted_sender_identity, message_control_id)
       DO NOTHING
       RETURNING id, tenant_id, trusted_sender_identity, message_control_id,
                 raw_message, message_sha256, obx_count, status, result_ids,
                 critical_result_ids, active_critical_result_ids,
                 closed_critical_result_ids, alert_ids, task_ids, sla_instance_ids,
                 closed_alert_ids, closed_task_ids, closed_sla_instance_ids,
                 legacy_adoption, authenticated_actor_uid, authenticated_actor_roles,
                 sender_binding_mode, sender_binding_identity, completed_at`,
      tenantId,
      analyzer.analyzer_code,
      messageControlId,
      rawMessage,
      obxRows.length,
      actorUid,
      authenticatedActorRoles,
      bindingMode,
      bindingIdentity,
    );
    const claimCreated = Boolean(insertedClaims[0]);
    let claim = insertedClaims[0];
    if (!claim) {
      const existingClaims = await tx.$queryRawUnsafe(
        `SELECT id, tenant_id, trusted_sender_identity, message_control_id,
                raw_message, message_sha256, obx_count, status, result_ids,
                critical_result_ids, active_critical_result_ids,
                closed_critical_result_ids, alert_ids, task_ids, sla_instance_ids,
                closed_alert_ids, closed_task_ids, closed_sla_instance_ids,
                legacy_adoption, authenticated_actor_uid, authenticated_actor_roles,
                sender_binding_mode, sender_binding_identity, completed_at
           FROM lab_oru_ingest_messages
          WHERE tenant_id = $1::uuid
            AND trusted_sender_identity = $2
            AND message_control_id = $3
          LIMIT 1
          FOR UPDATE`,
        tenantId,
        analyzer.analyzer_code,
        messageControlId,
      );
      claim = existingClaims[0];
      if (
        !claim
        || claim.raw_message !== rawMessage
        || Number(claim.obx_count) !== obxRows.length
      ) {
        throw oruReplayConflict();
      }
      if (claim.status === 'completed') {
        const replayResults = await tx.$queryRawUnsafe(
          `SELECT id, tenant_id, booking_id, investigation_id, admission_id, patient_uid,
                  patient_name, hl7_message_id, hl7_segment_index,
                  oru_ingest_message_id::text AS oru_ingest_message_id,
                  loinc_code, test_code, test_name,
                  value_text, value_numeric, unit, reference_range,
                  reference_range_low, reference_range_high, abnormal_flag,
                  status, is_critical, criticality_status, facility_id, specimen_type,
                  threshold_policy_bundle_id, threshold_policy_rule_id,
                  threshold_catalog_entry_id, threshold_evaluated_at, performed_by_lab,
                  performed_at, received_at, created_at, updated_at, raw_obx,
                  analyzer_id
             FROM lab_results
            WHERE tenant_id = $1::uuid
              AND oru_ingest_message_id = $2::bigint
            ORDER BY hl7_segment_index ASC, id ASC`,
          tenantId,
          claim.id,
        );
        if (
          replayResults.length !== obxRows.length
          || replayResults.map(row => Number(row.id)).sort((a, b) => a - b).join(',')
            !== (claim.result_ids || []).map(Number).sort((a, b) => a - b).join(',')
        ) {
          throw oruReplayConflict();
        }
        const replayBySegmentId = new Map(replayResults.map(result => (
          [Number(result.hl7_segment_index), result]
        )));
        const replayBookingId = replayResults[0]?.booking_id ?? null;
        const replayInvestigationId = replayResults[0]?.investigation_id ?? null;
        if (
          replayBySegmentId.size !== obxRows.length
          || (requestedInvestigationId != null
            && (
              replayBookingId != null
              || replayInvestigationId == null
              || Number(replayInvestigationId) !== requestedInvestigationId
            ))
          || obxRows.some((obx) => {
            const result = replayBySegmentId.get(obx.segmentId);
            return !result || !isMatchingClaimedOruResultIdentity(result, {
              patientUid: String(assertedPatientUid),
              bookingId: replayBookingId,
              investigationId: replayInvestigationId,
              performedByLab: analyzer.analyzer_code,
              rawObx: obx.raw,
              loincCode: obx.loincCode,
              testCode: obx.testCode,
              testName: obx.testName,
            }, { analyzerId: analyzer.id, claimId: claim.id });
          })
        ) {
          throw oruReplayConflict();
        }
        const replayAlertIds = [
          ...(claim.alert_ids || []),
          ...(claim.closed_alert_ids || []),
        ];
        const replayAlerts = replayAlertIds.length
          ? await tx.$queryRawUnsafe(
            `SELECT id, tenant_id, result_id, patient_uid, test_name, value_text,
                    value_numeric, unit, threshold_breached, threshold_value,
                    fired_at, acknowledged_at, acknowledgement_task_id,
                    generation_metadata
               FROM lab_critical_alerts
              WHERE tenant_id = $1::uuid
                AND id = ANY($2::int[])
              ORDER BY array_position($2::int[], id)`,
            tenantId,
            replayAlertIds,
          )
          : [];
        if (replayAlerts.length !== replayAlertIds.length) {
          throw oruReplayConflict();
        }
        return {
          resultSource: {
            bookingId: replayResults[0]?.booking_id ?? null,
            investigationId: replayResults[0]?.investigation_id ?? null,
          },
          results: replayResults,
          alerts: replayAlerts,
          materializations: [],
          replayed: true,
          claim,
        };
      }
      if (claim.status !== 'processing') throw oruReplayConflict();
    }

    const resultSource = await lockAndResolveOruResultSource({
      tx,
      tenantId,
      patientUid: String(assertedPatientUid),
      requestedInvestigationId,
      obrTestIdentity: parsed.obr?.testCode,
      obxRows,
    });
    const existingRowIdProbe = await tx.$queryRawUnsafe(
      `SELECT id
         FROM lab_results
        WHERE tenant_id = $1::uuid
          AND performed_by_lab = $2
          AND hl7_message_id = $3
        ORDER BY id ASC`,
      tenantId,
      analyzer.analyzer_code,
      messageControlId,
    );
    const prelockedResultIds = existingRowIdProbe
      .map(row => Number(row.id))
      .sort((a, b) => a - b);
    for (const resultId of prelockedResultIds) {
      await lockResultsInboxResourceTx({
        tx,
        tenantId,
        resourceType: 'lab_result',
        resourceId: String(resultId),
      });
    }
    const prelockedResultIdSet = new Set(prelockedResultIds);
    const existingRows = await tx.$queryRawUnsafe(
      `SELECT id, tenant_id, booking_id, investigation_id, admission_id, patient_uid,
              patient_name, hl7_message_id, hl7_segment_index,
              oru_ingest_message_id::text AS oru_ingest_message_id,
              loinc_code, test_code, test_name,
              value_text, value_numeric, unit, reference_range, abnormal_flag,
              status, is_critical, performed_by_lab, performed_at, received_at,
              created_at, updated_at, raw_obx, analyzer_id
         FROM lab_results
        WHERE tenant_id = $1::uuid
          AND performed_by_lab = $2
          AND hl7_message_id = $3
        ORDER BY hl7_segment_index ASC, id ASC
        FOR UPDATE`,
      tenantId,
      analyzer.analyzer_code,
      messageControlId,
    );
    if (existingRows.some(row => !prelockedResultIdSet.has(Number(row.id)))) {
      throw oruReplayConflict();
    }
    if (claimCreated && existingRows.length > 0 && existingRows.length !== obxRows.length) {
      throw oruReplayConflict();
    }
    const bySegmentId = new Map();
    for (const existing of existingRows) {
      const segmentId = Number(existing.hl7_segment_index);
      if (bySegmentId.has(segmentId)) throw oruReplayConflict();
      bySegmentId.set(segmentId, existing);
    }
    if (existingRows.length > 0) {
      const existingSegmentIds = [...bySegmentId.keys()].sort((a, b) => a - b);
      const incomingSegmentIds = obxRows.map(obx => obx.segmentId).sort((a, b) => a - b);
      if (
        existingSegmentIds.length !== incomingSegmentIds.length
        || existingSegmentIds.some((segmentId, index) => segmentId !== incomingSegmentIds[index])
      ) {
        throw oruReplayConflict();
      }
    }

    const persistedResults = [];
    const adoptedLegacyResultIds = new Set();
    const thresholdAssessments = new Map();
    const thresholdPolicyMaterializations = new Map();
    for (const obx of obxRows) {
      const numeric = asNumericOrNull(obx.value);
      let persisted = bySegmentId.get(obx.segmentId) || null;
      if (persisted) {
        if (!isMatchingStoredOruResult(persisted, {
          patientUid: resultSource.patientUid,
          bookingId: resultSource.bookingId,
          investigationId: resultSource.investigationId,
          performedByLab: analyzer.analyzer_code,
          rawObx: obx.raw,
          loincCode: obx.loincCode,
          testCode: obx.testCode,
          testName: obx.testName,
          valueText: obx.value || null,
          valueNumeric: numeric,
          unit: obx.units || null,
          referenceRange: obx.referenceRange || null,
          abnormalFlag: obx.abnormalFlag || null,
          status: obx.resultStatus === 'F' ? 'final' : 'preliminary',
        }, { analyzerId: analyzer.id, claimId: claim.id })) {
          throw oruReplayConflict();
        }
        if (persisted.oru_ingest_message_id == null) {
          const adoptedRows = await tx.$queryRawUnsafe(
            `UPDATE lab_results
                SET analyzer_id = $3::int,
                    oru_ingest_message_id = $4::bigint,
                    admission_id = COALESCE(admission_id, $5::integer),
                    updated_at = NOW()
              WHERE tenant_id = $1::uuid
                AND id = $2::int
                AND oru_ingest_message_id IS NULL
                AND (analyzer_id IS NULL OR analyzer_id = $3::int)
              RETURNING id, tenant_id, booking_id, investigation_id, admission_id, patient_uid,
                        patient_name, hl7_message_id, hl7_segment_index,
                        oru_ingest_message_id, loinc_code, test_code, test_name,
                        value_text, value_numeric, unit, reference_range,
                        abnormal_flag, status, is_critical, performed_by_lab,
                        performed_at, received_at, created_at, updated_at,
                        raw_obx, analyzer_id`,
            tenantId,
            Number(persisted.id),
            Number(analyzer.id),
            claim.id,
            resultSource.admissionId,
          );
          persisted = adoptedRows[0];
          if (!persisted) throw oruReplayConflict();
          adoptedLegacyResultIds.add(Number(persisted.id));
        }
      } else {
        const insertedRows = await tx.$queryRawUnsafe(
          `INSERT INTO lab_results
            (tenant_id, booking_id, investigation_id, admission_id, patient_uid, patient_name,
             hl7_message_id, hl7_segment_index, oru_ingest_message_id,
             loinc_code, test_code, test_name, value_text, value_numeric, unit,
             reference_range, abnormal_flag, status, performed_by_lab,
             performed_at, raw_obx, analyzer_id, result_origin)
           VALUES ($1::uuid, $2::int, $3::int, $4::int, $5::uuid, $6, $7, $8::int,
                   $9::bigint, $10, $11, $12, $13, $14, $15, $16, $17, $18,
                   $19, NULL, $20, $21::int, 'analyzer')
           ON CONFLICT (tenant_id, performed_by_lab, hl7_message_id, hl7_segment_index)
             WHERE performed_by_lab IS NOT NULL
               AND hl7_message_id IS NOT NULL
               AND hl7_segment_index IS NOT NULL
           DO NOTHING
           RETURNING id, tenant_id, booking_id, investigation_id, admission_id, patient_uid,
                     patient_name, hl7_message_id, hl7_segment_index,
                     oru_ingest_message_id, loinc_code, test_code, test_name,
                     value_text, value_numeric, unit, reference_range,
                     abnormal_flag, status, is_critical, performed_by_lab,
                     performed_at, received_at, created_at, updated_at, raw_obx,
                     analyzer_id`,
          tenantId,
          resultSource.bookingId,
          resultSource.investigationId,
          resultSource.admissionId,
          resultSource.patientUid,
          resultSource.patientName,
          messageControlId,
          obx.segmentId,
          claim.id,
          obx.loincCode,
          obx.testCode,
          obx.testName,
          obx.value || null,
          numeric,
          obx.units || null,
          obx.referenceRange || null,
          obx.abnormalFlag || null,
          obx.resultStatus === 'F' ? 'final' : 'preliminary',
          analyzer.analyzer_code,
          obx.raw,
          Number(analyzer.id),
        );
        persisted = insertedRows[0];
        if (!persisted) throw oruReplayConflict();
      }

      const criticality = await evaluateCriticalThreshold({
        client: tx,
        tenantId,
        result: persisted,
      });
      const policyMaterialization = await applyLabThresholdAssessmentTx({
        tx,
        tenantId,
        result: persisted,
        assessment: criticality,
        source: 'lab_oru',
      });
      persisted = policyMaterialization.result;
      thresholdAssessments.set(Number(persisted.id), criticality);
      thresholdPolicyMaterializations.set(Number(persisted.id), policyMaterialization);

      const canonical = await recordCanonicalLabEvent({
        tx,
        tenantId,
        patientUid: persisted.patient_uid,
        eventType: 'lab.result_recorded',
        eventStatus: persisted.status,
        resourceId: persisted.id,
        actorUid: actor.uid,
        actorRole: databaseActorRole,
        occurredAt: persisted.performed_at || persisted.received_at || persisted.created_at || null,
        summary: `Lab result recorded from analyzer: ${persisted.test_name}`,
        afterState: {
          status: persisted.status,
          criticality_status: persisted.criticality_status,
          is_critical: persisted.is_critical,
        },
        payload: {
          investigation_id: persisted.investigation_id,
          booking_id: persisted.booking_id,
          test_code: persisted.test_code,
          test_name: persisted.test_name,
          value_text: persisted.value_text,
          unit: persisted.unit,
          abnormal_flag: persisted.abnormal_flag,
          status: persisted.status,
          hl7_message_id: persisted.hl7_message_id,
          hl7_segment_index: persisted.hl7_segment_index,
          performed_by_lab: persisted.performed_by_lab,
          sender_binding_mode: bindingMode,
          sender_binding_identity: bindingIdentity,
          threshold_assessment: labThresholdAssessmentEvidence(criticality),
        },
      });
      if (persisted.admission_id != null) {
        await publishInpatientDiagnosticResourceLinkedTx({
          tx,
          tenantId,
          admissionId: persisted.admission_id,
          patientUid: persisted.patient_uid,
          resourceType: 'lab_result',
          resourceId: persisted.id,
          canonicalTimelineEventId: canonical.timeline.id,
          canonicalAuditEventId: canonical.audit.id,
          occurredAt: persisted.performed_at || persisted.received_at || persisted.created_at,
        });
      }
      persistedResults.push(persisted);
    }

    if (persistedResults.length !== obxRows.length || bySegmentId.size > obxRows.length) {
      throw oruReplayConflict();
    }

    if (resultSource.investigationId != null) {
      await tx.$executeRawUnsafe(
        `UPDATE investigations
            SET status = 'IN_PROGRESS',
                result_uploaded_at = COALESCE(result_uploaded_at, NOW()),
                updated_at = NOW()
          WHERE id = $1
            AND tenant_id = $3::uuid
            AND status = ANY($2::text[])`,
        resultSource.investigationId,
        INVESTIGATION_PRE_RESULT_STATUSES,
        tenantId,
      );
    }
    const materializations = [];
    for (const result of [...persistedResults].sort((a, b) => Number(a.id) - Number(b.id))) {
      const materialized = await materializeLabCriticalAlertGeneration({
        tx,
        tenantId,
        resultId: result.id,
        expectedPatientUid: result.patient_uid,
        criticality: thresholdAssessments.get(Number(result.id)),
        preappliedThresholdAssessment: thresholdPolicyMaterializations.get(Number(result.id)),
        source: 'lab_oru',
      });
      if (materialized.skippedReason === 'alert_already_acknowledged') {
        if (!adoptedLegacyResultIds.has(Number(result.id))) throw oruReplayConflict();
        const closedRows = await tx.$queryRawUnsafe(
          `SELECT alert.id AS alert_id,
                  task.id AS task_id,
                  sla.id AS sla_instance_id
             FROM lab_critical_alerts AS alert
             JOIN tasks AS task
               ON task.tenant_id = alert.tenant_id
              AND task.id = alert.acknowledgement_task_id
              AND task.related_resource_type = 'lab_result'
              AND task.related_resource_id = alert.result_id::text
              AND task.sla_completion_semantics = 'acknowledgement'
              AND task.status = 'in_progress'
              AND task.completed_at IS NULL
              AND NULLIF(task.metadata->>'acknowledged_at', '') IS NOT NULL
              AND NULLIF(task.metadata->>'acknowledged_by', '') IS NOT NULL
              AND LOWER(task.metadata->>'acknowledged_by') = LOWER(alert.acknowledged_by::text)
             JOIN workflow_sla_instances AS sla
               ON sla.tenant_id = task.tenant_id
              AND sla.id = task.workflow_sla_instance_id
              AND sla.rule_code = 'critical_result_ack'
              AND sla.source_table = 'lab_result'
              AND sla.source_id = alert.result_id::text
              AND sla.status IN ('completed', 'breached', 'escalated')
              AND sla.completed_at IS NOT NULL
              AND sla.completed_at = (task.metadata->>'acknowledged_at')::timestamptz
              AND sla.metadata->>'completed_via' = 'task_ack'
              AND sla.metadata->>'completed_by_task' = task.id::text
              AND LOWER(sla.metadata->>'completed_by') = LOWER(alert.acknowledged_by::text)
            WHERE alert.tenant_id = $1::uuid
              AND alert.id = $2::int
              AND alert.result_id = $3::int
              AND alert.patient_uid = $4::uuid
              AND alert.acknowledged_at IS NOT NULL
              AND alert.acknowledged_by IS NOT NULL
              AND alert.acknowledged_at = sla.completed_at
              AND alert.superseded_at IS NULL
            LIMIT 1`,
          tenantId,
          Number(materialized.alert?.id),
          Number(result.id),
          result.patient_uid,
        );
        if (!closedRows[0]) {
          throw new Error('Legacy acknowledged ORU result has no exact closed alert/task/SLA evidence');
        }
        materialized.closedObligation = closedRows[0];
      }
      Object.assign(result, materialized.result);
      materializations.push({ ...materialized, result: materialized.result });
    }

    const completedResults = await tx.$queryRawUnsafe(
      `SELECT id, tenant_id, booking_id, investigation_id, admission_id, patient_uid,
              patient_name, hl7_message_id, hl7_segment_index,
              oru_ingest_message_id::text AS oru_ingest_message_id,
              loinc_code, test_code, test_name,
              value_text, value_numeric, unit, reference_range,
              reference_range_low, reference_range_high, abnormal_flag,
              status, is_critical, criticality_status, facility_id, specimen_type,
              threshold_policy_bundle_id, threshold_policy_rule_id,
              threshold_catalog_entry_id, threshold_evaluated_at, performed_by_lab,
              performed_at, received_at,
              created_at, updated_at, raw_obx, analyzer_id
         FROM lab_results
        WHERE tenant_id = $1::uuid
          AND oru_ingest_message_id = $2::bigint
        ORDER BY hl7_segment_index ASC, id ASC`,
      tenantId,
      claim.id,
    );
    if (completedResults.length !== obxRows.length) throw oruReplayConflict();

    const resultIds = completedResults.map(result => Number(result.id));
    const criticalResultIds = [];
    const activeCriticalResultIds = [];
    const closedCriticalResultIds = [];
    const alertIds = [];
    const taskIds = [];
    const slaInstanceIds = [];
    const closedAlertIds = [];
    const closedTaskIds = [];
    const closedSlaInstanceIds = [];
    const activeAlerts = [];
    const closedAlerts = [];
    for (const result of completedResults) {
      if (result.is_critical !== true) continue;
      const materialized = materializations.find(entry => (
        Number(entry.result?.id) === Number(result.id)
      ));
      if (materialized?.closedObligation) {
        criticalResultIds.push(Number(result.id));
        closedCriticalResultIds.push(Number(result.id));
        closedAlertIds.push(Number(materialized.closedObligation.alert_id));
        closedTaskIds.push(Number(materialized.closedObligation.task_id));
        closedSlaInstanceIds.push(String(materialized.closedObligation.sla_instance_id));
        closedAlerts.push(materialized.alert);
        continue;
      }
      if (
        !materialized?.alert
        || materialized.alert.acknowledged_at != null
        || !materialized.task?.taskId
        || !materialized.task?.slaInstanceId
      ) {
        throw new Error('Critical ORU result has no exact active alert/task/SLA obligation');
      }
      criticalResultIds.push(Number(result.id));
      activeCriticalResultIds.push(Number(result.id));
      alertIds.push(Number(materialized.alert.id));
      taskIds.push(Number(materialized.task.taskId));
      slaInstanceIds.push(String(materialized.task.slaInstanceId));
      activeAlerts.push(materialized.alert);
    }

    const completedClaims = await tx.$queryRawUnsafe(
      `UPDATE lab_oru_ingest_messages
          SET status = 'completed',
               result_ids = $3::int[],
               critical_result_ids = $4::int[],
               active_critical_result_ids = $5::int[],
               closed_critical_result_ids = $6::int[],
               alert_ids = $7::int[],
               task_ids = $8::int[],
               sla_instance_ids = $9::uuid[],
               closed_alert_ids = $10::int[],
               closed_task_ids = $11::int[],
               closed_sla_instance_ids = $12::uuid[],
               legacy_adoption = $13::boolean,
              completed_at = NOW(),
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
          AND status = 'processing'
        RETURNING id, tenant_id, trusted_sender_identity, message_control_id,
                  raw_message, message_sha256, obx_count, status, result_ids,
                   critical_result_ids, active_critical_result_ids,
                   closed_critical_result_ids, alert_ids, task_ids, sla_instance_ids,
                   closed_alert_ids, closed_task_ids, closed_sla_instance_ids,
                   legacy_adoption, authenticated_actor_uid, authenticated_actor_roles,
                  sender_binding_mode, sender_binding_identity, completed_at`,
      tenantId,
      claim.id,
      resultIds,
      criticalResultIds,
      activeCriticalResultIds,
      closedCriticalResultIds,
      alertIds,
      taskIds,
      slaInstanceIds,
      closedAlertIds,
      closedTaskIds,
      closedSlaInstanceIds,
      adoptedLegacyResultIds.size > 0,
    );
    if (!completedClaims[0]) throw oruReplayConflict();
    return {
      resultSource,
      results: completedResults,
      alerts: [...activeAlerts, ...closedAlerts],
      materializations,
      replayed: false,
      claim: completedClaims[0],
    };
  });
  const {
    resultSource,
    results,
    alerts,
    materializations,
    replayed,
    claim,
  } = phaseOne;

  if (!replayed) {
    try {
      await notifyCreatedCriticalLabAlerts({ tenantId, materializations });
    } catch (error) {
      logger.error(`Critical ORU notification fan-out failed after commit: ${error?.message}`);
    }
    try {
      emitLabEvent('result-pending', { tenantId });
    } catch (error) {
      logger.error(`Critical ORU realtime fan-out failed after commit: ${error?.message}`);
    }
    // Cath-lab readiness (spec 2026-09-04 §6). Post-commit, best-effort and
    // dynamically imported: the readiness module imports THIS one for the
    // manual-entry escape hatch, so a static import here would be a cycle. A
    // refresh that fails leaves the snapshot one event behind — the next
    // refresh repairs it — and must never unwind a lab write that has already
    // committed. One message can carry
    // results for more than one patient, so the loop is over the DISTINCT uids
    // of the rows this ingest actually wrote.
    try {
      const { refreshOpenCasesForPatient } = await import('../clinical/cathLabReadinessService.js');
      const ingestedPatientUids = [...new Set(
        (results || []).map((row) => row?.patient_uid).filter(Boolean).map(String),
      )];
      for (const patientUid of ingestedPatientUids) {
        await refreshOpenCasesForPatient({ tenantId, patientUid });
      }
    } catch (readinessErr) {
      logger.warn(`Cath lab readiness refresh after lab event failed (lab write stands): ${readinessErr?.message}`);
    }
  }

  logger.info(`[lab] Ingested ORU ${messageControlId}: ${results.length} results, ${alerts.length} criticals, replayed=${replayed}`);
  return {
    results,
    alerts,
    messageControlId,
    bookingId: resultSource.bookingId,
    investigationId: resultSource.investigationId,
    replayed,
    claimId: String(claim.id),
    messageSha256: claim.message_sha256,
  };
}

/**
 * Post-commit delivery for alert generations that were already materialized
 * atomically with their result/task/SLA. This function never creates clinical
 * obligations and ignores non-created materializer outcomes.
 */
export async function notifyCreatedCriticalLabAlerts({ tenantId, materializations = [] }) {
  const created = materializations.filter((entry) => (
    entry?.created === true
    && entry.result
    && entry.alert
    && entry.criticality?.breached === true
  ));
  for (const entry of created) {
    const r = entry.result;
    const alert = entry.alert;
    const {
      breachedSide,
      breachedValue,
      evaluatedValue: v,
    } = entry.criticality;

    // E-5 — push the critical alert to the ordering doctor (and any
    // other staff who should know). This transport-only fan-out is
    // best-effort; the alert/task/SLA already committed atomically.
    try {
      const { default: outbox } = await import('../../utils/notifications/notificationOutbox.js');
      // COUNT(*) OVER () is evaluated before SELECT DISTINCT, but `users.uid`
      // carries a UNIQUE index (users_uid_key), so the IN-subquery yields at most
      // one row per user and the DISTINCT is a no-op — the count is exact.
      const recipients = await prisma.$queryRawUnsafe(
        `SELECT DISTINCT u.id, u.uid, u.phone, u.name, COUNT(*) OVER () AS total_matched
           FROM users u
          WHERE u.tenant_id = $2::uuid
            AND u.uid IN (
                  SELECT DISTINCT requested_by FROM investigations
                   WHERE patient_uid = $1::uuid
                     AND tenant_id = $2::uuid
                     AND requested_by IS NOT NULL
                     AND status NOT IN ('CANCELLED')
                  UNION
                  SELECT DISTINCT ordered_by FROM clinical_orders
                   WHERE patient_uid = $1::uuid
                     AND tenant_id = $2::uuid
                     AND ordered_by IS NOT NULL
                     AND status NOT IN ('cancelled')
                  UNION
                  SELECT DISTINCT attending_doctor FROM admissions
                   WHERE patient_uid = $1::uuid
                     AND tenant_id = $2::uuid
                     AND attending_doctor IS NOT NULL
                     AND status IN ('admitted', 'transferred')
                  UNION
                  SELECT DISTINCT attending_doctor_uid FROM emergency_visits
                   WHERE patient_uid = $1::uuid
                     AND tenant_id = $2::uuid
                     AND attending_doctor_uid IS NOT NULL
                     AND status NOT IN ('discharged', 'left_without_being_seen')
                )
          ORDER BY u.id
          LIMIT $3::int`,
        r.patient_uid, tenantId, CRITICAL_ALERT_RECIPIENT_CAP,
      );
      // A CRITICAL lab value that fails to reach a responsible clinician is a
      // patient-safety event, so a silent trim is not acceptable here: report the
      // exact number of clinicians who were resolved but never told.
      const totalResponsible = recipients.length ? Number(recipients[0].total_matched) : 0;
      if (totalResponsible > recipients.length) {
        logger.error('CRITICAL lab alert fan-out truncated — responsible clinicians were NOT notified', {
          resultId: r.id,
          alertId: alert.id,
          tenantId,
          cap: CRITICAL_ALERT_RECIPIENT_CAP,
          totalResponsible,
          notified: recipients.length,
          dropped: totalResponsible - recipients.length,
        });
      }
      const alertTitle = `CRITICAL lab: ${r.test_name}`;
      const alertBody = `${r.test_name} = ${r.value_text}${r.unit ? ' ' + r.unit : ''} (threshold ${breachedSide} ${breachedValue}). Patient: ${r.patient_uid}.`;
      const alertData = {
        result_id: r.id,
        alert_id: alert.id,
        patient_uid: r.patient_uid,
        breachedSide,
        value: v,
        threshold: breachedValue,
      };
      for (const recipient of recipients) {
        await outbox.queue({
          type: 'lab_critical_alert',
          recipientId: recipient.id,
          recipientPhone: recipient.phone,
          title: alertTitle,
          body: alertBody,
          data: alertData,
        }).catch((e) => logger.error(`Critical lab alert outbox queue failed for user ${recipient.id}: ${e.message}`));
      }
      await sendStaffNotifications({
        tenantId,
        recipientUserIds: recipients.map(row => row.id),
        title: alertTitle,
        body: alertBody,
        type: 'LAB_CRITICAL_ALERT',
        priority: 'HIGH',
        relatedId: alert.id,
        data: alertData,
        dedupe: true,
      });
    } catch (e) {
      logger.error(`Critical lab alert recipient fan-out failed for result ${r.id}: ${e?.message}`);
    }
  }
  if (created.length) emitLabEvent('alert-fired', { tenantId });
  return created.map(entry => entry.alert);
}

/**
 * For each result row, look up the matching threshold (preferring
 * LOINC, falling back to test_code) and create a critical alert if
 * the value is out of bounds. Marks the lab_results row is_critical.
 */
export async function detectCriticalsForResults({ tenantId, results }) {
  const materializations = [];
  for (const r of results) {
    const materialized = await materializeLabCriticalAlertGeneration({
      tenantId,
      resultId: r.id,
      expectedPatientUid: r.patient_uid,
      evaluateCriticality: ({ tx, result }) => evaluateCriticalThreshold({
        client: tx,
        tenantId,
        result,
      }),
      source: r.hl7_message_id ? 'lab_oru' : 'lab_result',
    });
    if (!materialized.created) continue;
    r.is_critical = true;
    materializations.push({ ...materialized, result: r });
  }
  const alerts = await notifyCreatedCriticalLabAlerts({ tenantId, materializations });
  if (results.length) emitLabEvent('result-pending', { tenantId });
  return alerts;
}

// ── Manual entry path (when an analyzer doesn't speak HL7) ────────────

// One implementation, two entry points, and `external` is NOT a caller option.
// It used to be: recordResultManual took an `allowUnlinkedExternal` flag, and
// "only the cath checklist may file an outside-laboratory result" was a fact
// about the call graph rather than about the code -- a convention any new
// caller would inherit by copying an existing call and flipping a boolean it
// did not understand. The rule is structural now: the flag is a parameter of
// this PRIVATE function, and the only way to reach it with `external: true` is
// recordExternalLabResultRow below, which nothing on a public route imports
// (pinned by tests/unit/labExternalResultCallSites.test.js).
async function recordManualLabResultRow({
  tenantId,
  performed_by,
  performed_by_role,
  result,
  idempotencyKey,
  requestBodySha256,
  httpIdempotencyClaimId = null,
  requestId = null,
  external = false,
  qualitative = false,
}) {
  const fields = [
    'booking_id', 'investigation_id', 'admission_id', 'patient_uid', 'patient_name', 'loinc_code',
    'test_code', 'test_name', 'value_text', 'unit', 'reference_range',
    'reference_range_low', 'reference_range_high',
    'abnormal_flag', 'status', 'comments',
    'result_origin', 'external_lab_name', 'external_report_ref', 'external_reported_on',
    'performed_at',
  ];
  for (const f of ['patient_uid', 'test_code', 'test_name']) {
    if (!result[f]) throw AppError.badRequest(`${f} is required`);
  }
  // value_text is required — a result row with no value is not a result.
  // Previously the column was nullable in the payload and the row would
  // be inserted with value_text=null + value_numeric=null, which the
  // critical-detection loop silently skips (it gates on value_numeric).
  // That manifested as "lab endpoint accepts garbage, never fires
  // critical alerts" — see finding
  // 2026-05-08-lab-walk-in-lab-tech-results-no-validation-no-critical-alert.
  if (result.value_text === undefined || result.value_text === null
      || String(result.value_text).trim() === '') {
    throw AppError.badRequest('value_text is required');
  }

  // B-3 — lab techs cannot finalise a result by setting status='final'
  // in the manual-entry payload. The signoff path is the only way to
  // flip the status, and that path checks pathologist tier. The caller-
  // supplied status is downgraded to 'preliminary' here. Findings:
  // 2026-05-08-inpatient-admission-lab-tech-results-final-without-verification
  // 2026-05-08-inpatient-admission-lab-tech-signoff-no-pathologist-tier-check
  const sanitised = { ...result, status: 'preliminary' };
  // Provenance (migration 766). recordResultManual — the public entry point —
  // cannot reach this with `external` true, so an origin arriving on that path
  // is overwritten rather than trusted (labResultOriginGuard already rejects
  // those fields at the route; this is the second, in-service half of the same
  // rule). The cath readiness checklist is the only caller that may file an
  // outside-laboratory value, and it must name the lab and the day the lab
  // reported it: an external value that cannot say where it came from is not
  // evidence.
  const externalOrigin = external && sanitised.result_origin === 'external_lab';
  if (!external) {
    sanitised.result_origin = 'manual_in_house';
    sanitised.external_lab_name = null;
    sanitised.external_report_ref = null;
    sanitised.external_reported_on = null;
    sanitised.performed_at = null;
  } else if (!externalOrigin
    || !String(sanitised.external_lab_name ?? '').trim()
    || !sanitised.external_reported_on) {
    throw AppError.badRequest(
      'External results must carry result_origin=external_lab, external_lab_name and external_reported_on',
      'LAB_RESULT_EXTERNAL_PROVENANCE_REQUIRED',
    );
  }
  sanitised.abnormal_flag = normalizeManualLabFlag(sanitised.abnormal_flag);
  const numeric = asNumericOrNull(sanitised.value_text);

  const requestedInvestigationId = sanitised.investigation_id != null
    ? Number(sanitised.investigation_id)
    : null;
  const requestedBookingId = sanitised.booking_id != null
    ? Number(sanitised.booking_id)
    : null;
  // An outside-laboratory value has no in-house order to link to — that is the
  // whole reason it had no home before migration 766.
  if (!externalOrigin && requestedInvestigationId == null && requestedBookingId == null) {
    throw AppError.badRequest(
      'Manual lab results must be linked to an investigation order or booking before entry',
      'LAB_RESULT_ORDER_LINK_REQUIRED',
      {
        booking_id: sanitised.booking_id ?? null,
        investigation_id: sanitised.investigation_id ?? null,
      },
    );
  }
  if (
    (requestedInvestigationId != null && (
      !Number.isSafeInteger(requestedInvestigationId)
      || requestedInvestigationId <= 0
      || requestedInvestigationId > POSTGRES_INT4_MAX
    ))
    || (requestedBookingId != null && (
      !Number.isSafeInteger(requestedBookingId)
      || requestedBookingId <= 0
      || requestedBookingId > POSTGRES_INT4_MAX
    ))
  ) {
    throw labResultSourceMismatch();
  }
  sanitised.booking_id = requestedBookingId;

  // Command identity, source validation, result, threshold verdict, critical
  // alert/task/SLA obligation, order advance, and canonical evidence are one
  // tenant transaction. A panic value can never commit without its exact
  // acknowledgement rail, and a lost HTTP response replays the same result.
  const phaseOne = await setTenantTx(tenantId, async (tx) => {
    const commandClaim = await claimLabResultIngestCommand({
      tx,
      tenantId,
      actorUid: performed_by,
      scope: 'manual_result',
      commandKey: idempotencyKey,
      requestBodySha256,
    });
    if (commandClaim.replayed) {
      const replayData = commandClaim.command.response_data;
      await finaliseHttpIdempotencyInTx({
        tx,
        claimId: httpIdempotencyClaimId,
        responseData: replayData,
        requestId,
      });
      return { responseData: replayData, materializations: [], replayed: true };
    }

    if (externalOrigin) {
      // No order to lock, so the patient is validated directly: an outside
      // result still may not be filed against a uid this tenant does not own.
      const patientRows = await tx.$queryRawUnsafe(
        `SELECT name FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid LIMIT 1`,
        tenantId,
        sanitised.patient_uid,
      );
      if (!patientRows[0]) throw labResultSourceMismatch();
      sanitised.investigation_id = null;
      sanitised.admission_id = null;
      sanitised.patient_name = patientRows[0].name || null;
    } else {
      const source = await lockAndValidateOrderedResultSource({
        tx,
        tenantId,
        patientUid: sanitised.patient_uid,
        bookingId: requestedBookingId,
        investigationId: requestedInvestigationId,
      });
      sanitised.investigation_id = source.investigationId;
      sanitised.admission_id = source.admissionId;
      sanitised.patient_name = source.patientName;
    }

    // Guard against duplicate-analyte submission after sign-off. Holding the
    // investigation lock also serializes this check with manual entry for the
    // same order. An external result has no investigation_id, so the guard has
    // nothing to key on and is skipped: an outside value is allowed to sit
    // alongside the in-house one for the same analyte — that comparison is
    // exactly what the pre-cath checklist is for.
    if (sanitised.investigation_id != null) {
      const dupRows = await tx.$queryRawUnsafe(
        `SELECT id, status, value_text
           FROM lab_results
          WHERE investigation_id = $1::int
            AND UPPER(test_code) = UPPER($2)
            AND tenant_id = $3::uuid
            AND status IN ('final', 'corrected', 'verified', 'amended')
          ORDER BY id DESC
          LIMIT 1`,
        sanitised.investigation_id,
        sanitised.test_code,
        tenantId,
      );
      if (dupRows.length > 0) {
        throw AppError.conflict(
          `Investigation ${sanitised.investigation_id} already has a verified ${sanitised.test_code} result (id=${dupRows[0].id}, value="${dupRows[0].value_text ?? ''}"). Use the corrected-result workflow to amend or re-issue instead of submitting a duplicate preliminary entry.`,
          'LAB_RESULT_DUPLICATE_ANALYTE',
          {
            investigation_id: sanitised.investigation_id,
            test_code: sanitised.test_code,
            existing_result_id: dupRows[0].id,
            existing_status: dupRows[0].status,
          },
        );
      }
    }

    // The $n numbers below follow the FINAL array order: the sixteen original
    // `fields`, then the five provenance fields appended to `fields`, then the
    // four pushed extras. performed_by_lab names the outside laboratory for an
    // external row — it is the "who ran this" column, and for an outside value
    // that is the outside lab, not the clerk who typed it in.
    const values = fields.map((f) => sanitised[f] ?? null);
    values.push(
      numeric,
      sanitised.result_origin === 'external_lab'
        ? sanitised.external_lab_name
        : (performed_by ? String(performed_by) : null),
      tenantId,
      commandClaim.command.id,
    );
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO lab_results
        (booking_id, investigation_id, admission_id, patient_uid, patient_name, loinc_code, test_code,
         test_name, value_text, unit, reference_range,
         reference_range_low, reference_range_high,
         abnormal_flag, status, comments,
         result_origin, external_lab_name, external_report_ref, external_reported_on,
         performed_at, value_numeric, performed_by_lab,
         tenant_id, ingest_command_id)
       VALUES ($1, $2, $3::int, $4::uuid, $5, $6, $7, $8, $9, $10, $11,
               $12::numeric, $13::numeric,
                $14, $15, $16,
                $17, $18, $19, $20::date,
                $21::timestamptz, $22::numeric, $23, $24::uuid, $25::bigint)
       RETURNING id, tenant_id, booking_id, investigation_id, admission_id, patient_uid,
                 patient_name, loinc_code, test_code, test_name, value_text,
                 value_numeric, unit, reference_range, reference_range_low,
                 reference_range_high, abnormal_flag, status, is_critical,
                 performed_by_lab, performed_at, received_at, signed_off_at,
                 signed_off_by, comments, created_at, updated_at,
                 result_origin, external_lab_name, external_report_ref,
                 external_reported_on`,
      ...values,
    );
    const inserted = rows[0];

    if (inserted.investigation_id != null) {
      const advanced = await tx.$queryRawUnsafe(
        `UPDATE investigations
            SET status = 'IN_PROGRESS',
                result_uploaded_at = COALESCE(result_uploaded_at, NOW()),
                updated_at = NOW()
          WHERE id = $1
            AND tenant_id = $3::uuid
            AND status = ANY($2::text[])
          RETURNING id`,
        inserted.investigation_id,
        [...RESULTABLE_INVESTIGATION_STATUSES],
        tenantId,
      );
      if (!advanced[0]) throw labResultSourceMismatch();
    }

    const materialized = await materializeLabCriticalAlertGeneration({
      tx,
      tenantId,
      resultId: inserted.id,
      expectedPatientUid: inserted.patient_uid,
      evaluateCriticality: ({ tx: materializerTx, result: currentResult }) => (
        evaluateCriticalThreshold({
          client: materializerTx,
          tenantId,
          result: currentResult,
        })
      ),
      source: 'lab_result',
    });

    const materializedResult = materialized.result;
    if (!materializedResult || Number(materializedResult.id) !== Number(inserted.id)) {
      throw AppError.internal(
        'Manual lab result disappeared during criticality assessment',
        'LAB_RESULT_THRESHOLD_EVIDENCE_MISSING',
      );
    }
    // The threshold materializer re-reads a fixed column list that predates the
    // provenance columns, so carry them from the INSERT: a caller must be able
    // to see the origin that was actually stored, not the one it asked for.
    const finalResult = {
      ...materializedResult,
      result_origin: inserted.result_origin,
      external_lab_name: inserted.external_lab_name,
      external_report_ref: inserted.external_report_ref,
      external_reported_on: inserted.external_reported_on,
    };
    // A qualitative serology value ("Non-reactive") is not a failed numeric
    // parse; only a caller claiming a quantitative analyte is held to one.
    if (!qualitative && materialized.criticality?.unmatchedReason === 'non_numeric_value') {
      throw AppError.badRequest(
        'value_text must be numeric for the active governed laboratory policy',
        'LAB_RESULT_NUMERIC_VALUE_REQUIRED',
        {
          test_code: finalResult.test_code,
          catalog_entry_id: materialized.criticality.catalogEntryId || null,
          policy_bundle_id: materialized.criticality.policyBundleId || null,
        },
      );
    }

    const canonical = await recordCanonicalLabEvent({
      tx,
      tenantId,
      patientUid: inserted.patient_uid,
      eventType: 'lab.result_recorded',
      eventStatus: inserted.status,
      resourceId: inserted.id,
      actorUid: performed_by ? String(performed_by) : null,
      actorRole: performed_by_role || null,
      occurredAt: inserted.received_at || inserted.created_at || null,
      summary: `Lab result recorded: ${inserted.test_name}`,
      afterState: {
        status: finalResult.status,
        criticality_status: finalResult.criticality_status,
        is_critical: finalResult.is_critical,
      },
      payload: {
        investigation_id: finalResult.investigation_id,
        booking_id: finalResult.booking_id,
        test_code: finalResult.test_code,
        test_name: finalResult.test_name,
        value_text: finalResult.value_text,
        unit: finalResult.unit,
        abnormal_flag: finalResult.abnormal_flag,
        status: finalResult.status,
        is_critical: finalResult.is_critical,
        critical_state: materialized.state,
        threshold_assessment: labThresholdAssessmentEvidence(materialized.criticality),
      },
    });
    if (finalResult.admission_id != null) {
      await publishInpatientDiagnosticResourceLinkedTx({
        tx,
        tenantId,
        admissionId: finalResult.admission_id,
        patientUid: finalResult.patient_uid,
        resourceType: 'lab_result',
        resourceId: finalResult.id,
        canonicalTimelineEventId: canonical.timeline.id,
        canonicalAuditEventId: canonical.audit.id,
        occurredAt: finalResult.performed_at || finalResult.received_at || finalResult.created_at,
      });
    }

    const alerts = materialized.alert && finalResult.is_critical === true
      ? [materialized.alert]
      : [];
    const responseData = { result: finalResult, alerts };
    await completeLabResultIngestCommand({
      tx,
      tenantId,
      commandId: commandClaim.command.id,
      resultIds: [finalResult.id],
      responseData,
    });
    await finaliseHttpIdempotencyInTx({
      tx,
      claimId: httpIdempotencyClaimId,
      responseData,
      requestId,
    });
    return {
      responseData,
      materializations: [{ ...materialized, result: finalResult }],
      replayed: false,
    };
  });

  if (!phaseOne.replayed) {
    try {
      await notifyCreatedCriticalLabAlerts({
        tenantId,
        materializations: phaseOne.materializations,
      });
    } catch (error) {
      logger.error(`Critical manual-result notification fan-out failed after commit: ${error?.message}`);
    }
    try {
      emitLabEvent('result-pending', { tenantId });
    } catch (error) {
      logger.error(`Manual-result realtime fan-out failed after commit: ${error?.message}`);
    }
    // Cath-lab readiness (spec 2026-09-04 §6). Post-commit, best-effort and
    // dynamically imported: the readiness module imports THIS one for the
    // manual-entry escape hatch, so a static import here would be a cycle. A
    // refresh that fails leaves the snapshot one event behind — the next
    // refresh repairs it — and must never unwind a lab write that has already
    // committed.
    try {
      const { refreshOpenCasesForPatient } = await import('../clinical/cathLabReadinessService.js');
      await refreshOpenCasesForPatient({
        tenantId,
        patientUid: phaseOne.responseData.result.patient_uid,
      });
    } catch (readinessErr) {
      logger.warn(`Cath lab readiness refresh after lab event failed (lab write stands): ${readinessErr?.message}`);
    }
  }
  return phaseOne.responseData;
}

/**
 * Manual result entry -- the PUBLIC path (POST /api/v1/lab/results).
 *
 * Always in-house: result_origin is forced to `manual_in_house` and the four
 * provenance columns to null, whatever the body said. There is no option here
 * that changes that, which is the point -- see recordExternalLabResultRow. An
 * abnormal_flag in the body is still honoured (normalised against the supported
 * vocabulary) exactly as before; no reference range is looked up on this path.
 */
export async function recordResultManual({
  tenantId,
  performed_by,
  performed_by_role,
  result,
  idempotencyKey,
  requestBodySha256,
  httpIdempotencyClaimId = null,
  requestId = null,
  qualitative = false,
}) {
  return recordManualLabResultRow({
    tenantId,
    performed_by,
    performed_by_role,
    result,
    idempotencyKey,
    requestBodySha256,
    httpIdempotencyClaimId,
    requestId,
    qualitative,
    external: false,
  });
}

/**
 * Outside-laboratory result entry -- the INTERNAL path.
 *
 * Files a lab_results row with no in-house order behind it, on the same
 * ingest-command / idempotency rail and through the same critical-threshold and
 * canonical-evidence writes as the manual path. Provenance is REQUIRED:
 * result_origin `external_lab`, a non-blank external_lab_name and an
 * external_reported_on, or LAB_RESULT_EXTERNAL_PROVENANCE_REQUIRED. Everything
 * else about the row is scored exactly as an in-house one is, the governed
 * threshold assessment included -- which is what makes an outside H mean what
 * an in-house H means.
 *
 * NOT reachable from a route. The only permitted caller is
 * services/clinical/cathLabReadinessService.js; a test pins that set so a new
 * import fails the build rather than quietly inheriting the escape.
 *
 * @param {Object} input   { tenantId, performed_by, performed_by_role, result, qualitative }
 * @param {Object} context { idempotencyKey, requestBodySha256, httpIdempotencyClaimId, requestId }
 */
export async function recordExternalLabResultRow(input = {}, context = {}) {
  return recordManualLabResultRow({
    tenantId: input.tenantId,
    performed_by: input.performed_by,
    performed_by_role: input.performed_by_role,
    result: input.result,
    qualitative: input.qualitative === true,
    idempotencyKey: context.idempotencyKey,
    requestBodySha256: context.requestBodySha256,
    httpIdempotencyClaimId: context.httpIdempotencyClaimId ?? null,
    requestId: context.requestId ?? null,
    external: true,
  });
}

// ── Pathologist worklist ──────────────────────────────────────────────

export async function listPendingSignOff({ tenantId, limit = 100 }) {
  return prisma.$queryRawUnsafe(
    `SELECT id, booking_id, patient_uid, patient_name, test_code, test_name,
            value_text, unit, reference_range, abnormal_flag, is_critical,
            received_at, status
       FROM lab_results
      WHERE tenant_id = $1::uuid
        AND signed_off_at IS NULL
        AND status IN ('preliminary', 'final')
      ORDER BY is_critical DESC, received_at ASC
      LIMIT $2::int`,
    tenantId, boundedInteger(limit, { fallback: 100, min: 1, max: 500 }),
  );
}

// Patient-facing result-notification fan-out: the patient plus, for a
// dependent minor, the guardian (users.guardian_user_id, migration 202) each
// get an outbox push/SMS AND an in-app notifications feed row (what
// GET /api/v1/notifications/my reads). Shared by the verified sign-off
// ("results ready") and the corrected/amended sign-off ("results updated")
// paths. Callers wrap it best-effort: a notification failure must never
// abort a sign-off (the result rows are the canonical record).
export async function notifyPatientResultRecipients({
  tenantId, patientUid, type, title, patientBody, guardianBody, data,
}) {
  const recipients = await prisma.$queryRawUnsafe(
    `SELECT u.id, u.uid, u.phone, u.name, false AS is_guardian
       FROM users u
      WHERE u.uid = $1::uuid AND u.tenant_id = $2::uuid AND u.phone IS NOT NULL
      UNION
     SELECT g.id, g.uid, g.phone, g.name, true AS is_guardian
       FROM users p
       JOIN users g ON g.id = p.guardian_user_id
      WHERE p.uid = $1::uuid
        AND p.tenant_id = $2::uuid
        AND g.tenant_id = $2::uuid
        AND g.phone IS NOT NULL`,
    patientUid, tenantId,
  );
  const { default: outbox } = await import('../../utils/notifications/notificationOutbox.js');
  for (const rcpt of recipients) {
    const body = rcpt.is_guardian ? guardianBody : patientBody;
    await outbox.queue({
      type,
      recipientId: rcpt.id,
      recipientPhone: rcpt.phone,
      title,
      body,
      data,
    }).catch((e) => logger.warn(`Lab ${type} outbox queue failed for user ${rcpt.id}: ${e.message}`));

    // In-app feed row — what GET /api/v1/notifications/my reads.
    try {
      await prisma.$executeRawUnsafe(
        // tenant_id bound explicitly ($8) — the recipients above are already
        // tenant-filtered, and the column DEFAULT falls back to the literal
        // default tenant whenever app.current_tenant_id is unset, which would
        // hide the row from the patient's tenant-filtered inbox.
        `INSERT INTO notifications
           (tenant_id, uid, user_id, phone, title, body, type, priority,
            data, is_read, created_at, updated_at)
         VALUES ($8::uuid, $1::uuid, $2::int, $3, $4, $5, $6,
                 'NORMAL', $7::jsonb, false, NOW(), NOW())`,
        rcpt.uid, rcpt.id, normalizePhone(rcpt.phone),
        title, body, type, JSON.stringify(data), tenantId,
      );
    } catch (e) {
      logger.warn(`Lab ${type} in-app insert failed for user ${rcpt.id}: ${e.message}`);
    }
  }
}

export async function resolveCurrentLabSigner({
  tenantId,
  actorUid,
  actorRole,
  actorRoles = [],
  actorRawRole = null,
}) {
  const tid = requireTenantId(tenantId);
  return setTenantTx(tid, (tx) => resolveCurrentHumanActorTx({
    tx,
    tenantId: tid,
    actorUid,
    authenticatedRoles: actorRoles.length ? actorRoles : [actorRole],
    authenticatedPrimaryRole: actorRole,
    authenticatedRawRole: actorRawRole || actorRole,
    rolePredicate: canSignOffLabResults,
  }));
}

export async function signOffResults({
  tenantId, signed_off_by, signed_off_by_role,
  result_ids, decision = 'verified', comments,
  booking_id, patient_uid: assertedPatientUid,
  actorRoles = [], actorRawRole = null,
  idempotencyKey = null, requestBodySha256 = null,
  httpIdempotencyClaimId = null, requestId = null,
}) {
  const tid = requireTenantId(tenantId);
  const ids = normalizeSignoffResultIds(result_ids);
  if (!signed_off_by) throw AppError.badRequest('signed_off_by is required');
  const normalizedDecision = String(decision || '').trim().toLowerCase();
  if (!SUPPORTED_SIGNOFF_DECISIONS.has(normalizedDecision)) {
    throw AppError.badRequest(
      'decision must be verified, corrected, or amended',
      'LAB_SIGNOFF_DECISION_UNSUPPORTED',
    );
  }
  const hasBookingAssertion = booking_id !== undefined
    && booking_id !== null
    && String(booking_id).trim() !== '';
  const assertedBookingId = hasBookingAssertion ? Number(booking_id) : null;
  if (
    hasBookingAssertion
    && (
      !Number.isSafeInteger(assertedBookingId)
      || assertedBookingId <= 0
      || assertedBookingId > POSTGRES_INT4_MAX
    )
  ) {
    throw AppError.badRequest(
      'booking_id does not match the selected lab results',
      'LAB_SIGNOFF_BOOKING_MISMATCH',
    );
  }

  const phaseOne = await setTenantTx(tid, async (tx) => {
    const actor = await resolveCurrentHumanActorTx({
      tx,
      tenantId: tid,
      actorUid: signed_off_by,
      authenticatedRoles: actorRoles.length ? actorRoles : [signed_off_by_role],
      authenticatedPrimaryRole: signed_off_by_role,
      authenticatedRawRole: actorRawRole || signed_off_by_role,
      rolePredicate: canSignOffLabResults,
    });
    const selected = await tx.$queryRawUnsafe(
      `SELECT id, patient_uid, booking_id, investigation_id, loinc_code,
              test_code, test_name, value_text, value_numeric, unit,
              abnormal_flag, is_critical, release_hold, status, signed_off_at,
              signed_off_by, updated_at
         FROM lab_results
        WHERE id = ANY($1::int[])
          AND tenant_id = $2::uuid
        ORDER BY id`,
      ids, tid,
    );
    if (selected.length !== ids.length) {
      throw AppError.badRequest('Some result_ids are not in this tenant');
    }
    const episode = deriveSignoffEpisode(selected);
    await tx.$queryRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text AS lock_result',
      `${tid}:lab-signoff:${episode.key}`,
    );
    if (CORRECTIVE_SIGNOFF_DECISIONS.has(normalizedDecision)) {
      for (const resultId of ids) {
        await lockResultsInboxResourceTx({
          tx,
          tenantId: tid,
          resourceType: 'lab_result',
          resourceId: String(resultId),
        });
      }
    }
    const sourceColumn = episode.type === 'investigation' ? 'investigation_id' : 'booking_id';
    const panelRows = await tx.$queryRawUnsafe(
      `SELECT id, patient_uid, booking_id, investigation_id, loinc_code,
              test_code, test_name, value_text, value_numeric, unit,
              abnormal_flag, is_critical, release_hold, status, signed_off_at,
              signed_off_by, updated_at
         FROM lab_results
        WHERE tenant_id = $1::uuid
          AND ${sourceColumn} = $2::int
        ORDER BY id
        FOR UPDATE`,
      tid,
      episode.id,
    );
    const selectedIdSet = new Set(ids);
    const owned = panelRows.filter((row) => selectedIdSet.has(Number(row.id)));
    if (owned.length !== ids.length) {
      throw AppError.conflict('Selected result set changed concurrently', 'LAB_SIGNOFF_RESULT_SET_RACE');
    }
    const resultPatientUids = new Set(owned.map((row) => String(row.patient_uid).toLowerCase()));
    if (resultPatientUids.size !== 1) {
      throw AppError.badRequest(
        'All result_ids in a sign-off must belong to the same patient',
        'LAB_SIGNOFF_MULTI_PATIENT_BATCH',
      );
    }
    const resultPatientUid = String(owned[0].patient_uid);
    if (
      assertedPatientUid
      && String(assertedPatientUid).toLowerCase() !== resultPatientUid.toLowerCase()
    ) {
      throw AppError.badRequest(
        'patient_uid does not match the selected lab results',
        'LAB_SIGNOFF_PATIENT_MISMATCH',
      );
    }
    const selectedBookingIds = new Set(
      owned.filter((row) => row.booking_id != null).map((row) => Number(row.booking_id)),
    );
    const derivedBookingId = selectedBookingIds.size === 1
      ? [...selectedBookingIds][0]
      : null;
    if (
      hasBookingAssertion
      && (derivedBookingId == null || derivedBookingId !== assertedBookingId)
    ) {
      throw AppError.badRequest(
        'booking_id does not match the selected lab results',
        'LAB_SIGNOFF_BOOKING_MISMATCH',
      );
    }

    if (CORRECTIVE_SIGNOFF_DECISIONS.has(normalizedDecision)) {
      if (owned.some((row) => !row.signed_off_at || !['final', 'corrected', 'verified', 'amended'].includes(String(row.status || '').toLowerCase()))) {
        throw AppError.conflict(
          'Corrective sign-off requires an already signed current generation',
          'LAB_SIGNOFF_CORRECTION_PREDECESSOR_REQUIRED',
        );
      }
      // OVERLAP, not equality. The guard above has already proved every
      // selected result is signed and in a correctable status, so this query's
      // only job is to date the generation being corrected — it does not need
      // to re-prove coverage.
      //
      // `result_ids = $2::int[]` demanded that a PRIOR SIGN-OFF COVERED EXACTLY
      // THIS ID SET, which is a different and much stronger claim. Sign a panel
      // as one batch and then correct a single analyte, or sign two analytes
      // separately and then correct them together, and no stored row matched:
      // the correction failed LAB_SIGNOFF_CORRECTION_PROVENANCE_REQUIRED and no
      // retry could clear it, because the shape being demanded had never
      // existed. Both sequences are ordinary pathologist behaviour.
      //
      // (Array ORDER is not a factor: normalizeSignoffResultIds sorts and dedupes,
      // so stored and queried arrays are both ascending.)
      //
      // ORDER BY signed_at DESC LIMIT 1 over the overlapping set yields the
      // most recent sign-off touching any selected result, which is the
      // conservative baseline — the source must have changed after the LATEST
      // relevant sign-off, not merely after some older one. FOR SHARE is kept
      // rather than aggregated away; lab_pathologist_signoffs is append-only,
      // but the lock is cheap and losing it here would be a silent change.
      const predecessorRows = await tx.$queryRawUnsafe(
        `SELECT id, signed_at, decision
           FROM lab_pathologist_signoffs
          WHERE tenant_id = $1::uuid
            AND result_ids && $2::int[]
            AND decision IN ('verified', 'corrected', 'amended')
          ORDER BY signed_at DESC, id DESC
          LIMIT 1
          FOR SHARE`,
        tid,
        ids,
      );
      const predecessor = predecessorRows[0];
      const predecessorAt = predecessor?.signed_at ? new Date(predecessor.signed_at).getTime() : NaN;
      const changedAfterPredecessor = Number.isFinite(predecessorAt) && owned.some((row) => (
        row.updated_at && new Date(row.updated_at).getTime() > predecessorAt
      ));
      if (!predecessor || !changedAfterPredecessor) {
        throw AppError.conflict(
          'Corrective sign-off requires a changed source generation after its predecessor',
          'LAB_SIGNOFF_CORRECTION_PROVENANCE_REQUIRED',
        );
      }
    } else if (owned.some((row) => (
      row.signed_off_at
      || !INITIAL_SIGNOFF_ELIGIBLE_STATUSES.has(String(row.status || '').toLowerCase())
    ))) {
      throw AppError.conflict(
        'Initial verified sign-off requires unsigned preliminary or analyzer-final results',
        'LAB_SIGNOFF_ILLEGAL_INITIAL_STATE',
      );
    }

    const signerRows = await tx.$queryRawUnsafe(
      `SELECT users.name,
              (
                SELECT credential.registration_number
                  FROM staff_credentials AS credential
                 WHERE credential.tenant_id = users.tenant_id
                   AND credential.staff_uid = users.uid
                   AND credential.status = 'active'
                   AND credential.verified_at IS NOT NULL
                   AND credential.registration_number IS NOT NULL
                   AND (credential.valid_until IS NULL OR credential.valid_until >= CURRENT_DATE)
                 ORDER BY credential.verified_at DESC, credential.id DESC
                 LIMIT 1
              ) AS registration_number
         FROM users
        WHERE users.tenant_id = $1::uuid
          AND users.uid = $2::uuid
        LIMIT 1`,
      tid,
      actor.uid,
    );
    const signer = signerRows[0] || {};

    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO lab_pathologist_signoffs
        (tenant_id, booking_id, patient_uid, result_ids, signed_off_by,
         signed_off_by_name, signed_off_by_reg, decision, comments)
       VALUES ($1::uuid, $2, $3::uuid, $4::int[], $5::uuid, $6, $7, $8, $9)
       RETURNING *`,
      tid,
      derivedBookingId,
      resultPatientUid,
      ids, actor.uid, signer.name || null,
      signer.registration_number || null, normalizedDecision, comments || null,
    );
    const created = rows[0];

    const stamped = await tx.$queryRawUnsafe(
      `UPDATE lab_results
          SET signed_off_at = NOW(),
               signed_off_by = $1::uuid,
               status = CASE WHEN $2 = 'verified' THEN 'final' ELSE $2 END,
               updated_at = NOW()
        WHERE id = ANY($3::int[])
          AND tenant_id = $4::uuid
          AND (
            -- Must stay in step with INITIAL_SIGNOFF_ELIGIBLE_STATUSES above:
            -- if the guard admits a status this branch does not, the guard
            -- passes, the UPDATE matches no row, and the caller gets a
            -- LAB_SIGNOFF_STATE_RACE that no retry can clear.
            ($2 = 'verified' AND signed_off_at IS NULL
              AND LOWER(status) IN ('preliminary', 'final'))
            OR ($2 IN ('corrected', 'amended') AND signed_off_at IS NOT NULL
                AND LOWER(status) IN ('final', 'corrected', 'verified', 'amended'))
          )
        RETURNING id`,
      actor.uid, normalizedDecision, ids, tid,
    );
    if (stamped.length !== ids.length) {
      throw AppError.conflict('Lab result sign-off state changed concurrently', 'LAB_SIGNOFF_STATE_RACE');
    }

    const correctiveAssessments = new Map();
    const correctivePolicyMaterializations = new Map();
    if (CORRECTIVE_SIGNOFF_DECISIONS.has(normalizedDecision)) {
      for (const result of owned) {
        const assessment = await evaluateCriticalThreshold({
          client: tx,
          tenantId: tid,
          result,
        });
        correctiveAssessments.set(Number(result.id), assessment);
        const policyMaterialization = await applyLabThresholdAssessmentTx({
          tx,
          tenantId: tid,
          result,
          assessment,
          source: 'lab_corrective_signoff',
        });
        correctivePolicyMaterializations.set(Number(result.id), policyMaterialization);
        Object.assign(result, policyMaterialization.result);
      }
    }

    const signedPanel = await tx.$queryRawUnsafe(
      `SELECT id, admission_id, loinc_code, test_code, test_name, value_text, value_numeric,
              unit, reference_range, reference_range_low, reference_range_high,
              abnormal_flag, is_critical, criticality_status, facility_id,
              threshold_policy_bundle_id, threshold_policy_rule_id,
              threshold_catalog_entry_id, threshold_evaluated_at,
              status, signed_off_at
         FROM lab_results
        WHERE tenant_id = $1::uuid
          AND id = ANY($2::int[])
          AND ${sourceColumn} = $3::int
        ORDER BY id`,
      tid,
      ids,
      episode.id,
    );
    const classification = classifySignedLabEpisode(signedPanel);
    const snapshotSha256 = resultSnapshotHash(signedPanel);

    const diagnosticGeneration = await createLabDiagnosticGenerationTx({
      tx,
      tenantId: tid,
      patientUid: resultPatientUid,
      episode,
      signoff: created,
      signerRole: actor.rawRole,
      panelRows: signedPanel,
    });

    await recordCanonicalLabEvent({
      tx,
      tenantId: tid,
      patientUid: resultPatientUid,
      eventType: 'lab.result_signed_off',
      eventStatus: normalizedDecision,
      sourceTable: 'lab_pathologist_signoffs',
      resourceType: 'lab_signoff',
      resourceId: created.id,
      actorUid: actor.uid,
      actorRole: actor.rawRole,
      occurredAt: created.signed_at || created.created_at || null,
      summary: `Pathologist sign-off: ${ids.length} lab result${ids.length === 1 ? '' : 's'} ${normalizedDecision}`,
      afterState: {
        decision: normalizedDecision,
        result_ids: ids,
        episode_key: episode.key,
        classification,
        result_snapshot_sha256: snapshotSha256,
      },
      payload: {
        signoff_id: created.id,
        result_ids: ids,
        decision: normalizedDecision,
        booking_id: derivedBookingId,
        episode_key: episode.key,
        classification,
        result_snapshot_sha256: snapshotSha256,
        comments: comments || null,
      },
    });

    const correctiveGenerations = [];
    if (CORRECTIVE_SIGNOFF_DECISIONS.has(normalizedDecision)) {
      for (const result of owned) {
        const assessment = correctiveAssessments.get(Number(result.id));
        const preappliedThresholdAssessment = correctivePolicyMaterializations.get(
          Number(result.id),
        );
        const generation = assessment?.breached === true
          ? await createCorrectedCriticalAlertGeneration({
            tx,
            tenantId: tid,
            result,
            decision: normalizedDecision,
            signoffId: created.id,
            signedOffBy: actor.uid,
            orderingClinicianUid: null,
            criticality: assessment,
            preappliedThresholdAssessment,
          })
          : await supersedeCriticalAlertWithDiagnosticGenerationTx({
            tx,
            tenantId: tid,
            resultId: result.id,
            patientUid: resultPatientUid,
            signoffId: created.id,
            diagnosticGenerationId: diagnosticGeneration.id,
            supersededByActorUid: actor.uid,
            criticality: assessment,
            preappliedThresholdAssessment,
          });
        correctiveGenerations.push({ resultId: Number(result.id), ...generation });
      }
    }

    const signoffRow = {
      ...created,
      episode_key: episode.key,
      classification,
      result_snapshot_sha256: snapshotSha256,
      diagnostic_generation_id: diagnosticGeneration.id,
      diagnostic_generation_snapshot_sha256: diagnosticGeneration.snapshot_sha256,
      receipt: {
        idempotency_key: idempotencyKey,
        request_body_sha256: requestBodySha256,
      },
    };
    await finaliseHttpIdempotencyInTx({
      tx,
      claimId: httpIdempotencyClaimId,
      responseData: signoffRow,
      requestId,
    });
    return {
      signoffRow,
      resultPatientUid,
      derivedBookingId,
      episode,
      correctiveGenerations,
    };
  });
  const {
    signoffRow,
    resultPatientUid,
    episode,
    correctiveGenerations,
  } = phaseOne;
  emitLabEvent('result-signed', { tenantId: tid });

  // Blood-borne marker record (spec 2026-09-04 §7.1): signed HIV/HBSAG/HCV
  // results become patient marker rows. Post-commit and best-effort — the
  // sign-off stands whether or not the marker write succeeds. A miss is not
  // repaired by retrying the same request (idempotency replays the stored
  // response); a corrective sign-off or a reconciliation sweep re-drives the
  // recorder.
  if (BLOODBORNE_MARKER_DECISIONS.has(normalizedDecision)) {
    try {
      const markerSync = await recordMarkersFromSignedResults({
        tenantId: tid,
        resultIds: ids,
        decision: normalizedDecision,
        actorUid: signoffRow.signed_off_by,
      });
      if (markerSync.recorded.length || markerSync.voided || markerSync.failed.length) {
        logger.info('Blood-borne marker sync after lab sign-off', {
          tenantId: tid,
          recorded: markerSync.recorded.length,
          voided: markerSync.voided,
          skipped: markerSync.skipped.length,
          failed: markerSync.failed.length,
        });
      }
    } catch (markerErr) {
      logger.warn('Blood-borne marker sync failed after sign-off (sign-off stands)', {
        tenantId: tid,
        signoffId: signoffRow?.id ?? null,
        resultIds: ids,
        decision: normalizedDecision,
        code: markerErr?.code || null,
        error: markerErr?.message,
      });
    }
  }

  // Cath-lab readiness (spec 2026-09-04 §6). Post-commit, best-effort and
  // dynamically imported: the readiness module imports THIS one for the
  // manual-entry escape hatch, so a static import here would be a cycle. A
  // refresh that fails leaves the snapshot one event behind — the next
  // refresh repairs it — and must never unwind a lab write that has already
  // committed.
  try {
    const { refreshOpenCasesForPatient } = await import('../clinical/cathLabReadinessService.js');
    await refreshOpenCasesForPatient({ tenantId: tid, patientUid: resultPatientUid });
  } catch (readinessErr) {
    logger.warn(`Cath lab readiness refresh after lab event failed (lab write stands): ${readinessErr?.message}`);
  }

  if (CORRECTIVE_SIGNOFF_DECISIONS.has(normalizedDecision)) {
    for (const generation of correctiveGenerations || []) {
      if (generation.created) emitLabEvent('alert-fired', { tenantId: tid });
    }
  }

  const releaseDecision = await getResultEpisodeReleaseDecision({
    tenantId: tid,
    patientUid: resultPatientUid,
    investigationId: episode.type === 'investigation' ? episode.id : null,
    bookingId: episode.type === 'booking' ? episode.id : null,
  });
  if (releaseDecision.outcome === 'visible') {
    try {
      const corrected = CORRECTIVE_SIGNOFF_DECISIONS.has(normalizedDecision);
      await notifyPatientResultRecipients({
        tenantId: tid,
        patientUid: resultPatientUid,
        type: corrected ? 'lab_result_corrected' : 'lab_result_ready',
        title: corrected ? 'Lab results updated' : 'Lab results ready',
        patientBody: corrected
          ? 'Your lab results have been corrected and are ready to view.'
          : 'Your lab results are ready to view.',
        guardianBody: corrected
          ? 'Lab results for your dependent have been corrected and are ready to view.'
          : 'Lab results for your dependent are ready to view.',
        data: {
          episode_type: episode.type,
          episode_id: episode.id,
          patient_uid: resultPatientUid,
        },
      });
    } catch (e) {
      logger.warn(`Lab result visibility notification failed (sign-off stands): ${e?.message}`);
    }
  }

  // Move the linked lab orders (investigations) to COMPLETED once all of
  // their results are finalised. A verified result previously left the order
  // stuck at IN_PROGRESS, so the ordering screen never reflected that the lab
  // work was done. Only complete an order with no still-pending result — a
  // partial sign-off of a multi-analyte panel leaves it in progress. Best-
  // effort: failure must not abort the sign-off.
  // Finding: verified lab orders stay IN_PROGRESS after result.
  if (normalizedDecision === 'verified') {
    try {
      const invRows = await prisma.$queryRawUnsafe(
        `SELECT DISTINCT investigation_id
           FROM lab_results
          WHERE id = ANY($1::int[])
            AND tenant_id = $2::uuid
            AND investigation_id IS NOT NULL`,
        ids, tid,
      );
      for (const { investigation_id } of invRows) {
        const pending = await prisma.$queryRawUnsafe(
          `SELECT 1 FROM lab_results
            WHERE investigation_id = $1::int
              AND tenant_id = $2::uuid
              AND status IS DISTINCT FROM 'final'
              AND status IS DISTINCT FROM 'corrected'
            LIMIT 1`,
          investigation_id, tid,
        );
        if (pending.length === 0) {
          await prisma.$executeRawUnsafe(
            `UPDATE investigations
                SET status = 'COMPLETED',
                    completed_at = COALESCE(completed_at, NOW()),
                    updated_at = NOW()
              WHERE id = $1::int
                AND tenant_id = $2::uuid
                AND status NOT IN ('COMPLETED', 'CANCELLED')`,
            investigation_id, tid,
          );
          await prisma.$executeRawUnsafe(
            `WITH linked_order AS (
               SELECT DISTINCT ((regexp_match(notes, 'clinical_order_id:([0-9]+)'))[1])::int AS order_id
                 FROM investigations
                WHERE id = $1::int
                  AND tenant_id = $2::uuid
                  AND notes ~ 'clinical_order_id:[0-9]+'
             )
             UPDATE clinical_orders co
                SET status = 'completed',
                    completed_at = COALESCE(co.completed_at, NOW()),
                    completed_by = COALESCE(co.completed_by, $3::uuid),
                    updated_at = NOW()
               FROM linked_order lo
              WHERE co.id = lo.order_id
                AND co.tenant_id = $2::uuid
                AND co.order_type = 'investigation'
                AND co.status NOT IN ('completed', 'cancelled', 'discontinued')`,
            investigation_id, tid, String(signoffRow.signed_off_by),
          );
        }
      }
    } catch (e) {
      logger.warn(`Lab order completion update failed on signoff: ${e?.message}`);
    }
  }

  // Roadmap C2 (Phase 1.5, best-effort) — release the signed results to
  // subscribed third-party systems as ORU^R01.
  try {
    const { emitSignedResultsOru } = await import('../hl7/hl7OutboundService.js');
    await emitSignedResultsOru({
      resultIds: ids,
      tenantId: tid,
      patientUid: resultPatientUid,
    });
  } catch (feedErr) {
    logger.warn(`ORU feed emission failed on signoff (signoff stands): ${feedErr?.message}`);
  }

  return signoffRow;
}

// ── Critical-alert acknowledgement workflow ───────────────────────────

const CRITICAL_ALERT_ACK_FORBIDDEN = 'Not authorized to acknowledge this critical alert';
const CRITICAL_ALERT_ACK_RECONCILIATION_REQUIRED =
  'Critical alert acknowledgement requires reconciliation';
const POSTGRES_INT_MAX = 2_147_483_647;

function criticalAlertAckForbidden(patientUid = null) {
  const err = AppError.forbidden(CRITICAL_ALERT_ACK_FORBIDDEN);
  if (patientUid) {
    Object.defineProperty(err, 'phiPatientUid', {
      value: String(patientUid),
      enumerable: false,
    });
  }
  return err;
}

function criticalAlertAckReconciliationRequired() {
  return AppError.conflict(
    CRITICAL_ALERT_ACK_RECONCILIATION_REQUIRED,
    'LAB_CRITICAL_ALERT_ACK_RECONCILIATION_REQUIRED',
  );
}

function canReplayAcknowledgedCriticalAlert(alert, { actorUid, actorRoles }) {
  const callerUid = actorUid ? String(actorUid).trim().toLowerCase() : null;
  const originalActorUid = alert?.acknowledged_by
    ? String(alert.acknowledged_by).trim().toLowerCase()
    : null;
  if (callerUid && originalActorUid && callerUid === originalActorUid) return true;

  const roles = (Array.isArray(actorRoles) ? actorRoles : [actorRoles])
    .map((role) => String(role || '').trim().toUpperCase())
    .filter(Boolean);
  return roles.some((role) => isAdmin(role) || role === 'SUPER_ADMIN');
}

async function recordCriticalAlertAcknowledgementReceipt({
  tx,
  tenantId,
  alertId,
  taskId,
}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT record_lab_critical_alert_acknowledgement_receipt(
              $1::uuid,
              $2::int,
              $3::int
            ) AS recorded`,
    tenantId,
    Number(alertId),
    Number(taskId),
  );
  if (rows[0]?.recorded !== true) {
    throw new Error('Critical alert acknowledgement receipt was not recorded');
  }
  return true;
}

async function loadClosedCriticalAlertAcknowledgementContract({ tx, tenantId, alert }) {
  const taskId = Number(alert?.acknowledgement_task_id);
  const acknowledgedAt = alert?.acknowledged_at;
  const acknowledgedBy = String(alert?.acknowledged_by || '').trim().toLowerCase();
  const generationState = alert?.generation_metadata?.corrected_state;
  if (
    !Number.isSafeInteger(taskId)
    || taskId <= 0
    || taskId > POSTGRES_INT_MAX
    || !acknowledgedAt
    || Number.isNaN(new Date(acknowledgedAt).getTime())
    || !UUID_PATTERN.test(acknowledgedBy)
    || !generationState
  ) {
    return null;
  }

  // The migration-owned recorder validates the exact v2 source chain before
  // creating a receipt and validates the immutable receipt on every replay.
  // Historical mutable SLA metadata is deliberately not the replay source:
  // corrected generations reuse that SLA while the per-alert receipt remains.
  await recordCriticalAlertAcknowledgementReceipt({
    tx,
    tenantId,
    alertId: Number(alert.id),
    taskId,
  });

  const taskRows = await tx.$queryRawUnsafe(
    `SELECT task.id,
            task.status,
            task.workflow_sla_instance_id,
            task.metadata
       FROM lab_critical_alert_acknowledgement_receipts AS receipt
       JOIN tasks AS task
         ON task.tenant_id = receipt.tenant_id
        AND task.id = receipt.acknowledgement_task_id
      WHERE receipt.tenant_id = $1::uuid
        AND receipt.alert_id = $2::int
        AND receipt.acknowledgement_task_id = $3::int
        AND receipt.result_id = $4::int
        AND receipt.patient_uid = $5::uuid
        AND receipt.generation_signoff_id IS NOT DISTINCT FROM $6::int
        AND receipt.generation_state = $7::text
        AND receipt.acknowledged_at = $8::timestamptz
        AND receipt.acknowledged_by = $9::uuid
        AND receipt.ack_contract_version = 2
      LIMIT 1
      FOR UPDATE OF task`,
    tenantId,
    Number(alert.id),
    taskId,
    Number(alert.result_id),
    alert.patient_uid,
    alert.generation_signoff_id == null ? null : Number(alert.generation_signoff_id),
    String(generationState),
    acknowledgedAt,
    acknowledgedBy,
  );
  const task = taskRows[0];
  if (!task) return null;
  return { task };
}

export async function listOpenCriticalAlerts({ tenantId, limit = 50 }) {
  return prisma.$queryRawUnsafe(
    `SELECT id, result_id, patient_uid, test_name, value_text,
            value_numeric, unit, threshold_breached, threshold_value, fired_at
       FROM lab_critical_alerts
      WHERE tenant_id = $1::uuid
        AND acknowledged_at IS NULL
        AND superseded_at IS NULL
      ORDER BY fired_at DESC, id DESC
      LIMIT $2::int`,
    tenantId, boundedInteger(limit, { fallback: 50, min: 1, max: 500 }),
  );
}

async function acknowledgeAlertTransition(alertId, {
  tenantId,
  acknowledged_by,
  acknowledged_by_name,
  actorRoles = [],
  actorRole = null,
  actorRawRole = null,
  breakGlassId = null,
  read_back_method,
  notes,
  expectedTaskId = null,
}) {
  const numericAlertId = Number(alertId);
  if (
    !Number.isSafeInteger(numericAlertId)
    || numericAlertId <= 0
    || numericAlertId > POSTGRES_INT_MAX
  ) {
    throw criticalAlertAckForbidden();
  }
  const authenticatedRoles = Array.isArray(actorRoles) ? actorRoles : [actorRoles];
  const authenticatedPrimaryRole = actorRole || authenticatedRoles.find(Boolean) || null;
  const numericExpectedTaskId = expectedTaskId == null ? null : Number(expectedTaskId);
  if (
    numericExpectedTaskId !== null
    && (
      !Number.isSafeInteger(numericExpectedTaskId)
      || numericExpectedTaskId <= 0
      || numericExpectedTaskId > POSTGRES_INT_MAX
    )
  ) {
    throw criticalAlertAckForbidden();
  }

  const result = await setTenantTx(tenantId, async (tx) => {
    const currentActor = await resolveCurrentHumanActorTx({
      tx,
      tenantId,
      actorUid: acknowledged_by,
      authenticatedRoles,
      authenticatedPrimaryRole,
      authenticatedRawRole: actorRawRole || authenticatedPrimaryRole,
      rolePredicate: isTaskHumanOwnerRole,
    });
    const verifiedActorUid = currentActor.uid;
    const normalizedRoles = [currentActor.role];
    const canonicalActorRole = currentActor.role;

    // Resolve only the non-PHI resource identity before taking any row lock.
    // Corrected-signoff generation creation locks in the opposite direction
    // (resource advisory lock, then prior alert row), so locking the alert
    // first here would create an A-row/advisory deadlock.
    const pointers = await tx.$queryRawUnsafe(
      `SELECT result_id
         FROM lab_critical_alerts
        WHERE id = $1::int
          AND tenant_id = $2::uuid
        LIMIT 1`,
      numericAlertId,
      tenantId,
    );
    if (!pointers[0]) throw criticalAlertAckForbidden();

    await lockResultsInboxResourceTx({
      tx,
      tenantId,
      resourceType: 'lab_result',
      resourceId: String(pointers[0].result_id),
    });

    const alertRows = await tx.$queryRawUnsafe(
      `SELECT alert.id,
              alert.tenant_id,
              alert.result_id,
              alert.patient_uid,
              alert.test_name,
              alert.value_text,
              alert.value_numeric,
              alert.unit,
              alert.threshold_breached,
              alert.threshold_value,
              alert.fired_at,
              (EXTRACT(EPOCH FROM alert.fired_at) * 1000)::bigint
                AS fired_at_epoch_ms,
              alert.acknowledged_at,
              alert.acknowledged_by,
              alert.acknowledged_by_name,
              alert.read_back_method,
              alert.notes,
              alert.superseded_at,
              alert.superseded_by_alert_id,
              alert.superseded_by_signoff_id,
              alert.generation_signoff_id,
              alert.acknowledgement_task_id,
              alert.generation_metadata,
              alert.created_at,
              result.investigation_id
         FROM lab_critical_alerts AS alert
         JOIN lab_results AS result
           ON result.id = alert.result_id
          AND result.tenant_id = alert.tenant_id
          AND result.patient_uid = alert.patient_uid
        WHERE alert.id = $1::int
          AND alert.tenant_id = $2::uuid
        LIMIT 1
        FOR UPDATE OF alert`,
      numericAlertId,
      tenantId,
    );
    const alert = alertRows[0];
    if (!alert) throw criticalAlertAckForbidden();
    if (alert.superseded_at) throw criticalAlertAckForbidden(alert.patient_uid);

    const latestCorrectiveSignoffs = await tx.$queryRawUnsafe(
      `SELECT id
         FROM lab_pathologist_signoffs
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND $3::int = ANY(result_ids)
          AND decision IN ('corrected', 'amended')
        ORDER BY id DESC
        LIMIT 1`,
      tenantId,
      alert.patient_uid,
      Number(alert.result_id),
    );
    const latestCorrectiveSignoffId = Number(latestCorrectiveSignoffs[0]?.id || 0);
    if (
      latestCorrectiveSignoffId > 0
      && Number(alert.generation_signoff_id || 0) !== latestCorrectiveSignoffId
    ) {
      throw criticalAlertAckForbidden(alert.patient_uid);
    }

    // An acknowledged alert belongs to the historical acknowledgement window.
    // Replay succeeds only from its immutable, versioned alert/task/SLA/comment/
    // canonical contract. Never search by resource and accidentally stop a newer
    // corrected-result window; an unbound or weak historical receipt requires
    // explicit owner reconciliation instead of an inferred task acknowledgement.
    if (alert.acknowledged_at) {
      if (numericExpectedTaskId !== null) {
        if (Number(alert.acknowledgement_task_id) !== numericExpectedTaskId) {
          throw criticalAlertAckForbidden(alert.patient_uid);
        }
      } else if (!canReplayAcknowledgedCriticalAlert(alert, {
        actorUid: verifiedActorUid,
        actorRoles: normalizedRoles,
      })) {
        throw criticalAlertAckForbidden(alert.patient_uid);
      }

      let closedContract;
      try {
        closedContract = await loadClosedCriticalAlertAcknowledgementContract({
          tx,
          tenantId,
          alert,
        });
      } catch {
        if (numericExpectedTaskId !== null) {
          throw criticalAlertAckForbidden(alert.patient_uid);
        }
        throw criticalAlertAckReconciliationRequired();
      }
      if (!closedContract) {
        if (numericExpectedTaskId !== null) {
          throw criticalAlertAckForbidden(alert.patient_uid);
        }
        throw criticalAlertAckReconciliationRequired();
      }

      if (numericExpectedTaskId !== null) {
        let replayedTask;
        try {
          replayedTask = await acknowledgeLabCriticalAlertTaskFromTrustedWorkflow({
            tenantId,
            id: numericExpectedTaskId,
            alertId: numericAlertId,
            resultId: alert.result_id,
            patientUid: alert.patient_uid,
            actorUid: verifiedActorUid,
            actorRoles: normalizedRoles,
            actorPrimaryRole: canonicalActorRole,
            actorRawRole: currentActor.rawRole,
            breakGlassId,
            tx,
          });
        } catch (err) {
          if (err?.statusCode === 403 || err?.statusCode === 404) {
            throw criticalAlertAckForbidden(alert.patient_uid);
          }
          throw err;
        }
        return { alert, task: replayedTask, newlyAcknowledged: false };
      }
      return { alert, task: null, newlyAcknowledged: false };
    }

    const linkedTasks = await tx.$queryRawUnsafe(
      `SELECT task.id,
              task.status,
              task.workflow_sla_instance_id,
              task.metadata
         FROM tasks AS task
        WHERE task.tenant_id = $1::uuid
          AND task.related_resource_type = 'lab_result'
          AND task.related_resource_id = $2::text
          AND task.patient_uid = $3::uuid
          AND task.sla_completion_semantics = 'acknowledgement'
          AND task.workflow_sla_instance_id IS NOT NULL
          AND task.status IN ('open', 'blocked', 'overdue', 'in_progress')
          AND ($6::int IS NULL OR task.id = $6::int)
          AND NOT EXISTS (
                SELECT 1
                  FROM lab_critical_alerts AS newer_alert
                 WHERE newer_alert.tenant_id = $1::uuid
                   AND newer_alert.result_id = $2::int
                   AND newer_alert.patient_uid = $3::uuid
                   AND newer_alert.id > $4::int
              )
          AND NOT EXISTS (
                SELECT 1
                  FROM lab_pathologist_signoffs AS newer_signoff
                 WHERE newer_signoff.tenant_id = $1::uuid
                   AND $2::int = ANY(newer_signoff.result_ids)
                   AND newer_signoff.decision IN ('corrected', 'amended')
                   AND newer_signoff.signed_at > $5::timestamptz
              )
        ORDER BY task.id DESC
        LIMIT 1
        FOR UPDATE OF task`,
      tenantId,
      String(alert.result_id),
      alert.patient_uid,
      numericAlertId,
      alert.fired_at,
      alert.acknowledgement_task_id,
    );
    const linkedTask = linkedTasks[0];
    if (!linkedTask) throw criticalAlertAckForbidden(alert.patient_uid);
    if (numericExpectedTaskId !== null && Number(linkedTask.id) !== numericExpectedTaskId) {
      throw criticalAlertAckForbidden(alert.patient_uid);
    }

    // Corrected-result reopen takes task then SLA locks. Preserve that exact
    // order explicitly; a joined FOR UPDATE leaves row-lock acquisition to the
    // query plan and can deadlock against the reopen transaction.
    // The receipt is millisecond-precision. Round the database clock upward so
    // it cannot precede a microsecond-precision fired_at in the same millisecond.
    const linkedSlas = await tx.$queryRawUnsafe(
      `SELECT sla.id,
              sla.status,
               sla.completed_at,
               (EXTRACT(EPOCH FROM sla.completed_at) * 1000)::bigint
                 AS completed_at_epoch_ms,
               to_char(
                 (
                   date_trunc(
                     'milliseconds',
                     GREATEST(clock_timestamp(), $4::timestamptz)
                   ) + INTERVAL '1 millisecond'
                 ) AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
               ) AS acknowledgement_clock,
               sla.metadata
         FROM workflow_sla_instances AS sla
        WHERE sla.tenant_id = $1::uuid
          AND sla.id = $2::uuid
          AND sla.rule_code = 'critical_result_ack'
          AND sla.source_table = 'lab_result'
          AND sla.source_id = $3::text
        LIMIT 1
        FOR UPDATE OF sla`,
      tenantId,
      linkedTask.workflow_sla_instance_id,
      String(alert.result_id),
      alert.fired_at,
    );
    const linkedSla = linkedSlas[0];
    if (!linkedSla) throw criticalAlertAckForbidden(alert.patient_uid);

    // Before the authorization boundary, a broad staff route could acknowledge
    // only one half of this contract. Never infer present task authority from
    // that unversioned receipt, even when its timestamps happen to align.
    if (linkedTask.status === 'in_progress') {
      if (numericExpectedTaskId !== null) {
        throw criticalAlertAckForbidden(alert.patient_uid);
      }
      throw criticalAlertAckReconciliationRequired();
    }
    if (
      !['active', 'breached', 'escalated'].includes(String(linkedSla.status || ''))
      || linkedSla.completed_at
    ) {
      throw criticalAlertAckForbidden(alert.patient_uid);
    }

    let acknowledgedTask;
    try {
      acknowledgedTask = await acknowledgeLabCriticalAlertTaskFromTrustedWorkflow({
        tenantId,
        id: linkedTask.id,
        alertId: numericAlertId,
        resultId: alert.result_id,
        patientUid: alert.patient_uid,
        actorUid: verifiedActorUid,
        actorRoles: normalizedRoles,
        actorPrimaryRole: canonicalActorRole,
        actorRawRole: currentActor.rawRole,
        breakGlassId,
        acknowledgedAt: linkedSla.acknowledgement_clock,
        tx,
      });
    } catch (err) {
      if (err?.statusCode === 403 || err?.statusCode === 404) {
        throw criticalAlertAckForbidden(alert.patient_uid);
      }
      throw err;
    }
    const durableAcknowledgedAt = acknowledgedTask?.metadata?.acknowledged_at || null;
    if (!durableAcknowledgedAt || Number.isNaN(Date.parse(durableAcknowledgedAt))) {
      throw new Error('Critical alert task acknowledgement has no durable timestamp');
    }
    const durableAcknowledgedBy = verifiedActorUid;
    if (!UUID_PATTERN.test(String(durableAcknowledgedBy || ''))) {
      throw criticalAlertAckForbidden(alert.patient_uid);
    }
    const durableAcknowledgedByName = acknowledged_by_name || null;
    const durableReadBackMethod = read_back_method || null;
    const durableNotes = notes || null;
    if (
      Number(acknowledgedTask?.metadata?.ack_contract_version)
        !== LAB_CRITICAL_ALERT_ACK_CONTRACT_VERSION
    ) {
      throw new Error('Critical alert acknowledgement contract version was not recorded');
    }

    const canonicalAcknowledgedAlert = {
      ...alert,
      acknowledged_at: durableAcknowledgedAt,
      acknowledged_by: durableAcknowledgedBy,
      acknowledged_by_name: durableAcknowledgedByName,
      read_back_method: durableReadBackMethod,
      notes: durableNotes ?? alert.notes,
    };
    // Migration 581 validates the entire closed acknowledgement contract when
    // the alert row changes. Persist the canonical pair first in this same
    // transaction; any later alert/receipt failure rolls the pair back too.
    await emitCriticalLabAlertAcknowledged({
      db: tx,
      alert: canonicalAcknowledgedAlert,
      actorUid: durableAcknowledgedBy,
      actorRole: canonicalActorRole,
      payload: {
        acknowledged_by_name: durableAcknowledgedByName,
        read_back_method: durableReadBackMethod,
        ack_contract_version: LAB_CRITICAL_ALERT_ACK_CONTRACT_VERSION,
        acknowledgement_authorization: acknowledgedTask?.metadata?.acknowledged_via || null,
        acknowledge_override_source: acknowledgedTask?.metadata?.acknowledge_override_source || null,
        acknowledge_override_id: acknowledgedTask?.metadata?.acknowledge_override_id || null,
        acknowledge_override_reason: acknowledgedTask?.metadata?.acknowledge_override_reason || null,
        legacy_task_ack_reconciled: false,
        reconciled_by: null,
      },
    });

    const acknowledgedRows = await tx.$queryRawUnsafe(
      `UPDATE lab_critical_alerts AS target_alert
          SET acknowledged_at = (ack_task.metadata->>'acknowledged_at')::timestamptz,
              acknowledged_by = $1::uuid,
              acknowledged_by_name = $2,
              read_back_method = $3,
              notes = COALESCE($4, notes)
         FROM tasks AS ack_task
        WHERE target_alert.id = $5::int
          AND target_alert.tenant_id = $6::uuid
          AND target_alert.acknowledged_at IS NULL
          AND target_alert.superseded_at IS NULL
          AND ack_task.tenant_id = target_alert.tenant_id
          AND ack_task.id = $7::int
          AND ack_task.id = target_alert.acknowledgement_task_id
          AND ack_task.metadata->>'acknowledged_at' = $8::text
        RETURNING target_alert.id, target_alert.tenant_id,
                  target_alert.result_id, target_alert.patient_uid,
                  target_alert.test_name, target_alert.value_text,
                  target_alert.value_numeric, target_alert.unit,
                  target_alert.threshold_breached, target_alert.threshold_value,
                  target_alert.fired_at, target_alert.acknowledged_at,
                  target_alert.acknowledged_by,
                  target_alert.acknowledged_by_name,
                  target_alert.read_back_method, target_alert.notes,
                  target_alert.superseded_at,
                  target_alert.superseded_by_alert_id,
                  target_alert.superseded_by_signoff_id,
                  target_alert.generation_signoff_id,
                  target_alert.acknowledgement_task_id,
                  target_alert.generation_metadata, target_alert.created_at`,
      String(durableAcknowledgedBy),
      durableAcknowledgedByName,
      durableReadBackMethod,
      durableNotes,
      numericAlertId,
      tenantId,
      linkedTask.id,
      durableAcknowledgedAt,
    );
    if (!acknowledgedRows[0]) {
      throw AppError.conflict(
        'Critical alert acknowledgement changed concurrently',
        'CRITICAL_ALERT_ACK_CONCURRENT_CHANGE',
      );
    }
    const acknowledgedAlert = {
      ...acknowledgedRows[0],
      investigation_id: alert.investigation_id || null,
    };
    await recordCriticalAlertAcknowledgementReceipt({
      tx,
      tenantId,
      alertId: numericAlertId,
      taskId: Number(linkedTask.id),
    });
    return { alert: acknowledgedAlert, task: acknowledgedTask, newlyAcknowledged: true };
  });

  if (result.newlyAcknowledged) emitLabEvent('alert-acked', { tenantId });
  return result;
}

async function resolveCurrentCriticalAlertIdForInboxTask({ tenantId, taskId }) {
  const numericTaskId = Number(taskId);
  if (
    !Number.isSafeInteger(numericTaskId)
    || numericTaskId <= 0
    || numericTaskId > POSTGRES_INT_MAX
  ) {
    return null;
  }

  return setTenantTx(tenantId, async (tx) => {
    // This classification query deliberately selects no patient identity or
    // task title. Missing and unauthorized task-id probes therefore remain
    // non-enumerating; actor authorization still happens inside the atomic
    // transition before any PHI-bearing result is returned.
    const rows = await tx.$queryRawUnsafe(
      `SELECT task.id,
              task.related_resource_type,
              task.related_resource_id,
              task.sla_completion_semantics,
              task.metadata->>'lab_critical_alert_id' AS metadata_alert_id,
              sla.rule_code AS sla_rule_code,
              sla.source_table AS sla_source_table,
              sla.source_id AS sla_source_id,
              alert.id AS alert_id,
              alert.result_id AS alert_result_id,
              (
                task.metadata->>'lab_critical_alert_id' = alert.id::text
                AND (
                  alert.generation_signoff_id IS NULL
                  OR task.metadata->>'lab_alert_generation_signoff_id'
                       = alert.generation_signoff_id::text
                )
                AND task.metadata->>'lab_alert_generation_state'
                     = alert.generation_metadata->>'corrected_state'
              ) AS generation_binding_ok
         FROM tasks AS task
         LEFT JOIN workflow_sla_instances AS sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
         LEFT JOIN lab_critical_alerts AS alert
           ON alert.tenant_id = task.tenant_id
          AND alert.acknowledgement_task_id = task.id
          AND alert.result_id::text = task.related_resource_id
          AND alert.patient_uid = task.patient_uid
          AND alert.superseded_at IS NULL
        WHERE task.tenant_id = $1::uuid
          AND task.id = $2::int
        ORDER BY alert.id`,
      tenantId,
      numericTaskId,
    );
    if (!rows[0]) return null;

    const row = rows[0];
    const isCriticalRail = rows.some((candidate) => candidate.alert_id != null)
      || row.metadata_alert_id != null
      || (
        row.related_resource_type === 'lab_result'
        && row.sla_completion_semantics === 'acknowledgement'
        && row.sla_rule_code === 'critical_result_ack'
      );
    if (!isCriticalRail) return null;

    const exactBinding = rows.length === 1
      && row.alert_id != null
      && row.related_resource_type === 'lab_result'
      && row.sla_completion_semantics === 'acknowledgement'
      && row.sla_rule_code === 'critical_result_ack'
      && row.sla_source_table === 'lab_result'
      && String(row.sla_source_id) === String(row.alert_result_id)
      && String(row.related_resource_id) === String(row.alert_result_id)
      && row.generation_binding_ok === true;
    if (!exactBinding) throw criticalAlertAckForbidden();
    return Number(row.alert_id);
  });
}

export async function acknowledgeAlert(alertId, options) {
  const result = await acknowledgeAlertTransition(alertId, options);
  return result.alert;
}

export async function acknowledgeCriticalAlertForInboxTask(taskId, {
  tenantId,
  actorUid,
  actorName = null,
  actorRoles = [],
  actorRole = null,
  actorRawRole = null,
  breakGlassId = null,
  readBackMethod = null,
  notes = null,
}) {
  const alertId = await resolveCurrentCriticalAlertIdForInboxTask({ tenantId, taskId });
  if (alertId === null) return { handled: false, task: null };

  const result = await acknowledgeAlertTransition(alertId, {
    tenantId,
    acknowledged_by: actorUid,
    acknowledged_by_name: actorName,
    actorRoles,
    actorRole,
    actorRawRole,
    breakGlassId,
    read_back_method: readBackMethod,
    notes,
    expectedTaskId: taskId,
  });
  if (!result.task) throw criticalAlertAckForbidden();
  return { handled: true, task: result.task };
}

export async function getResultsForBooking({ tenantId, booking_id }) {
  return prisma.$queryRawUnsafe(
    `SELECT * FROM lab_results
      WHERE tenant_id = $1::uuid AND booking_id = $2::int
      ORDER BY received_at ASC, hl7_segment_index ASC`,
    tenantId, Number(booking_id),
  );
}

export async function getResultsForPatient({
  tenantId, patient_uid, limit = 200, include_preliminary = false,
}) {
  // Wave-2 fix: a preliminary (unsigned) lab result is medico-legally
  // unverified and must not be returned on the patient-lookup read API
  // unless the caller explicitly asks for it via include_preliminary.
  // Every returned row now carries `verified` so any consumer (patient
  // app, clinical UI) can plainly distinguish signed from unsigned.
  // Finding:
  // 2026-05-09-inpatient-admission-lab-tech-preliminary-results-visible-before-signoff.
  const wantPreliminary = include_preliminary === true
    || include_preliminary === 'true'
    || include_preliminary === 1
    || include_preliminary === '1';
  const patientUids = await resolveMergedPatientUidSet(prisma, {
    tenantId,
    patientUid: patient_uid,
  });
  const filters = ['tenant_id = $1::uuid', 'patient_uid = ANY($2::uuid[])'];
  if (!wantPreliminary) {
    filters.push(`status NOT IN ('preliminary')`);
    filters.push('signed_off_at IS NOT NULL');
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, booking_id, patient_uid, patient_name,
            hl7_message_id, hl7_segment_index,
            loinc_code, test_code, test_name,
            value_text, value_numeric, unit, reference_range,
            abnormal_flag, status, is_critical,
            performed_by_lab, performed_at, received_at,
            signed_off_at, signed_off_by,
            comments, raw_obx, panel_id, panel_code,
            reference_range_low, reference_range_high,
            created_at, updated_at
       FROM lab_results
      WHERE ${filters.join(' AND ')}
      ORDER BY received_at DESC
      LIMIT $3::int`,
    tenantId, patientUids, boundedInteger(limit, { fallback: 200, min: 1, max: 500 }),
  );
  return rows.map((r) => ({
    ...r,
    verified: r.status === 'final' && r.signed_off_at != null,
  }));
}

/**
 * E-5 — IPD lab worklist. Pending lab orders for currently-admitted
 * patients only. Joins investigations -> admissions(active) so the
 * lab tech sees only inpatients, not the OPD walk-ins. Finding:
 * 2026-05-08-inpatient-admission-lab-tech-ipd-orders-not-on-worklist.
 *
 * Excludes radiology orders — without the test_type filter the lab
 * worklist surfaced ultrasounds/CT scans alongside CBC samples, forcing
 * the lab tech to triage radiology work that wasn't theirs. Findings:
 *   2026-05-10-inpatient-admission-lab-tech-ipd-worklist-includes-radiology
 *   2026-05-12-dynamic-acute-abdomen-lab-tech-a1b49f2b
 *
 * COALESCEs bed_number from admissions.bed_number (legacy) → beds.bed_number
 * (current source-of-truth, since IPD admit flow stores bed_id rather
 * than the bed_number string). Without this the phlebotomist hit a
 * null bed_number on the worklist even when bed assignment was complete.
 * Finding: 2026-05-12-inpatient-admission-lab-tech-48e85048.
 */
export async function listIpdLabWorklist({ tenantId, limit = 100 } = {}) {
  const lim = boundedInteger(limit, { fallback: 100, min: 1, max: 500 });
  return prisma.$queryRawUnsafe(
    `SELECT i.id, i.test_name, i.test_type, i.status, i.priority,
            i.requested_at, i.created_at,
            u.name AS patient_name, u.phone AS patient_phone, u.uid AS patient_uid,
            a.id AS admission_id, a.ward,
            COALESCE(a.bed_number, b.bed_number) AS bed_number,
            a.bed_id, a.room_category, a.attending_doctor
       FROM investigations i
       JOIN users u ON u.id = i.patient_id
            AND u.tenant_id = $1::uuid
       JOIN admissions a ON a.patient_uid = u.uid
            AND a.tenant_id = $1::uuid
            AND a.status IN ('admitted', 'transferred')
  LEFT JOIN beds b ON b.id = a.bed_id
        AND b.tenant_id = $1::uuid
      WHERE i.tenant_id = $1::uuid
        AND i.status NOT IN ('COMPLETED', 'CANCELLED')
        AND UPPER(COALESCE(i.test_type, 'LAB')) IN ('LAB', 'PATHOLOGY', 'BLOOD',
                                                     'BIOCHEM', 'BIOCHEMISTRY',
                                                     'HEMATOLOGY', 'HAEMATOLOGY',
                                                     'MICROBIOLOGY', 'SEROLOGY', 'URINE')
      ORDER BY
        CASE i.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2
                       WHEN 'NORMAL' THEN 3 ELSE 4 END,
        i.requested_at ASC
      LIMIT $2::int`,
    tenantId, lim,
  );
}

/**
 * General lab worklist — surfaces every open investigation regardless
 * of admission state, so an ER STAT troponin (no admission yet) or an
 * OPD walk-in CBC shows up alongside the IPD orders. The IPD-only
 * worklist had filtered them out via the inner join on admissions,
 * leaving the lab tech blind to anything ordered before admission.
 *
 * Joined left to admissions so the ward / bed columns are present
 * when the patient is admitted (helpful for sample-collection routing)
 * and null otherwise. The `source` column distinguishes ER / IPD /
 * OPD so the lab UI can colour-code the row. STAT/URGENT orders sort
 * to the top regardless of source.
 *
 * Findings:
 *   2026-05-10-emergency-walk-in-lab-tech-stat-er-order-not-on-worklist
 *   2026-05-08-obstetric-anc-lab-tech-no-worklist-endpoint
 */
export async function listLabWorklist({
  tenantId,
  limit = 100,
  priority,
  source,
} = {}) {
  const lim = boundedInteger(limit, { fallback: 100, min: 1, max: 500 });
  const params = [tenantId];
  // Lab worklist is lab-only — radiology orders belong on the radiology
  // worklist, and surfacing them here forces lab techs to triage work
  // that isn't theirs. Same defence as listIpdLabWorklist. Finding:
  // 2026-05-10-inpatient-admission-lab-tech-ipd-worklist-includes-radiology.
  const filters = [
    `i.tenant_id = $1::uuid`,
    `i.status NOT IN ('COMPLETED', 'CANCELLED')`,
    // Lab worklist allowlist — matches what the manual driver findings
    // call "laboratory/pathology" while preserving the legacy lowercase
    // 'blood' / 'urine' values older test seeds and walk-in tooling
    // emit. Default of LAB so investigations with NULL test_type still
    // land on the lab worklist (historic OPD walk-ins where the column
    // was never populated). Excludes RADIOLOGY/CARDIOLOGY/PULMONARY/
    // ENDOSCOPY, which have their own worklists.
    `UPPER(COALESCE(i.test_type, 'LAB')) IN ('LAB', 'PATHOLOGY', 'BLOOD',
                                              'BIOCHEM', 'BIOCHEMISTRY',
                                              'HEMATOLOGY', 'HAEMATOLOGY',
                                              'MICROBIOLOGY', 'SEROLOGY',
                                              'URINE')`,
  ];

  if (priority) {
    params.push(String(priority).toUpperCase());
    filters.push(`UPPER(COALESCE(i.priority, 'NORMAL')) = $${params.length}`);
  }
  if (source) {
    const src = String(source).toLowerCase();
    if (!['ipd', 'er', 'opd'].includes(src)) {
      throw AppError.badRequest('source must be one of: ipd, er, opd');
    }
    if (src === 'ipd') {
      filters.push(`a.id IS NOT NULL AND a.status IN ('admitted', 'transferred')`);
    } else if (src === 'er') {
      filters.push(`ev.id IS NOT NULL`);
    } else {
      filters.push(
        `a.id IS NULL AND ev.id IS NULL`,
      );
    }
  }

  params.push(lim);
  const limitPos = params.length;

  return prisma.$queryRawUnsafe(
    `SELECT i.id, i.test_name, i.test_type, i.status, i.priority,
            i.requested_at, i.created_at,
            u.name AS patient_name, u.phone AS patient_phone, u.uid AS patient_uid,
            a.id AS admission_id, a.ward,
            COALESCE(a.bed_number, b.bed_number) AS bed_number,
            a.bed_id, a.room_category, a.attending_doctor,
            ev.id AS er_visit_id, ev.visit_number AS er_visit_number,
            CASE
              WHEN a.id IS NOT NULL AND a.status IN ('admitted', 'transferred') THEN 'ipd'
              WHEN ev.id IS NOT NULL THEN 'er'
              ELSE 'opd'
            END AS source
       FROM investigations i
       JOIN users u ON u.id = i.patient_id
            AND u.tenant_id = $1::uuid
  LEFT JOIN admissions a
         ON a.patient_uid = u.uid
        AND a.tenant_id = $1::uuid
        AND a.status IN ('admitted', 'transferred')
  LEFT JOIN beds b ON b.id = a.bed_id
        AND b.tenant_id = $1::uuid
  LEFT JOIN emergency_visits ev
         ON ev.patient_uid = u.uid
        AND ev.tenant_id = $1::uuid
        AND ev.status NOT IN ('discharged', 'transferred', 'left_against_advice',
                              'lwbs', 'expired', 'archived')
      WHERE ${filters.join(' AND ')}
      ORDER BY
        CASE UPPER(COALESCE(i.priority, 'NORMAL'))
          WHEN 'URGENT' THEN 1
          WHEN 'STAT' THEN 1
          WHEN 'HIGH' THEN 2
          WHEN 'NORMAL' THEN 3
          ELSE 4
        END,
        -- D45 — within the STAT/URGENT bucket, sort NEWEST-first so a
        -- fresh ER STAT troponin is never hidden behind a stale
        -- abandoned STAT row from a previous patient/shift. The
        -- abandoned row stays visible (just below the fresh one) so
        -- somebody can still pick it up / escalate it. Non-STAT
        -- buckets keep oldest-first (fair FIFO for routine work).
        -- Finding 2026-05-22-emergency-walk-in-lab-tech (D45).
        CASE
          WHEN UPPER(COALESCE(i.priority, 'NORMAL')) IN ('STAT', 'URGENT')
            THEN i.requested_at
        END DESC NULLS LAST,
        i.requested_at ASC
      LIMIT $${limitPos}::int`,
    ...params,
  );
}
