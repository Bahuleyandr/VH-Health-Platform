// src/services/lab/labClosedLoopService.js
//
// Roadmap B3 — closed-loop lab foundations on top of the existing specimen
// tables (260), ORU ingestion (labResultsService) and autoverification rule
// helpers (labAutoverificationService):
//
//   * specimen barcode label at collection (Code 39, printable HTML)
//   * scan-on-receipt in the lab (status transition + history + canonical
//     timeline/audit events)
//   * analyzer interface inbox: raw ASTM E1394 payloads persist with
//     parse/ingest outcome; HL7 ORU uses the separate immutable 582 claim.
//     ASTM results land in lab_results linked to
//     the scanned specimen, run through critical detection AND the
//     rules-authoritative delta/critical-band verdicts at ingestion time.
//
// Physical analyzer transports (serial/MLLP listeners) are owner-side
// deployment work; middleware-capable analyzers POST the same payloads to
// the HTTP bridge endpoint.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { code39Svg } from '../../utils/barcode/code39.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { publishInpatientDiagnosticResourceLinkedTx } from '../emr/inpatientPathwayDomainService.js';
import { notifyCreatedCriticalLabAlerts } from './labResultsService.js';
import { materializeLabCriticalAlertGeneration } from './labCriticalAlertService.js';
import {
  assertConfiguredCriticalAnalytesNumeric,
  evaluateCriticalThreshold,
} from './labCriticalThresholdService.js';
import { emitLabEvent } from '../../utils/websocket/realtimeEmitter.js';
import {
  calculateDelta,
  classifyCriticalBand,
  buildAutoverificationDecision,
  lookupReferenceRange,
} from '../ai/labAutoverificationService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { LAB_INTERFACE_INGEST_ROLES } from '../../utils/roleHelpers.js';

const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';
const ASTM_PRE_RESULT_STATUSES = ['REQUESTED', 'PENDING', 'SCHEDULED', 'COLLECTED'];
const ASTM_ANALYZER_READY_SPECIMEN_STATUSES = new Set(['received', 'processing']);
const ASTM_NONTERMINAL_BOOKING_STATUSES = new Set([
  'BOOKED', 'CONFIRMED', 'DISPATCHED', 'COLLECTED', 'PROCESSING',
]);
const ASTM_NONTERMINAL_INVESTIGATION_STATUSES = new Set([
  ...ASTM_PRE_RESULT_STATUSES,
  'IN_PROGRESS',
]);
const STRICT_NUMERIC_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MACHINE_INTERFACE_ROLES = new Set(['WEBHOOK_CLIENT', 'DEVICE_GATEWAY']);
const ASTM_ACTOR_DENIAL_CODES = new Set([
  'LAB_INTERFACE_ACTOR_REQUIRED',
  'LAB_INTERFACE_ACTOR_FORBIDDEN',
  'LAB_INTERFACE_API_CLIENT_TENANT_MISMATCH',
]);

function strictNumericOrNull(value) {
  const text = String(value ?? '').trim();
  if (!text || !STRICT_NUMERIC_PATTERN.test(text)) return null;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

function thresholdAssessmentEvidence(criticality = {}) {
  return {
    matched: criticality.matched === true,
    breached: criticality.breached === true,
    threshold_id: criticality.thresholdId ?? null,
    threshold_test_code: criticality.thresholdTestCode ?? null,
    threshold_loinc_code: criticality.thresholdLoincCode ?? null,
    threshold_unit: criticality.thresholdUnit ?? null,
    threshold_applies_to: criticality.thresholdAppliesTo ?? null,
    critical_low: criticality.criticalLow ?? null,
    critical_high: criticality.criticalHigh ?? null,
    breached_side: criticality.breachedSide ?? null,
    breached_value: criticality.breachedValue ?? null,
    evaluated_value: criticality.evaluatedValue ?? null,
    conversion: criticality.conversion ?? null,
  };
}

// ── ASTM E1394 parsing (pure) ──────────────────────────────────────────────
//
// Records arrive CR-separated (E1381 frames stripped by the transport):
//   H|\^&|||Mindray^BS-240|...        header (sender in field 5)
//   P|1|...                           patient (ignored — specimen links us)
//   O|1|ACC-0001||^^^GLU|R|...        order (specimen/accession in field 3)
//   R|1|^^^GLU|5.8|mmol/L|3.9^6.1|N||F|...   result
//   L|1|N                             terminator
export function parseAstmMessage(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    return {
      sender: null,
      sender_identity: null,
      accession: null,
      order_count: 0,
      results: [],
      errors: ['empty message'],
    };
  }
  const records = text.split(/\r\n|\r|\n/).map((r) => r.trim()).filter(Boolean);
  const out = {
    sender: null,
    sender_identity: null,
    accession: null,
    ordered_test_code: null,
    order_count: 0,
    results: [],
    errors: [],
  };
  const headerPositions = [];
  const orderPositions = [];
  const resultPositions = [];
  const terminatorPositions = [];
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const record = records[recordIndex];
    const f = record.split('|');
    const type = (f[0] || '').trim();
    if (type === 'H') {
      headerPositions.push(recordIndex);
      out.sender_identity = (f[4] || '').trim() || null;
      out.sender = out.sender_identity?.split('^').filter(Boolean).join(' ') || null;
    } else if (type === 'O') {
      orderPositions.push(recordIndex);
      out.order_count += 1;
      if ((f[1] || '').trim() !== '1') {
        out.errors.push('single-specimen ASTM O record must use sequence 1');
      }
      const accession = (f[2] || '').trim() || null;
      const orderedTestCode = (f[4] || '')
        .split('^')
        .map(component => component.trim())
        .filter(Boolean)
        .pop() || null;
      if (!out.accession) out.accession = accession;
      if (!out.ordered_test_code) out.ordered_test_code = orderedTestCode;
      if (out.order_count > 1) {
        out.errors.push('multiple ASTM O records are not supported by the single-specimen endpoint');
      }
    } else if (type === 'R') {
      resultPositions.push(recordIndex);
      if ((f[1] || '').trim() !== String(resultPositions.length)) {
        out.errors.push('ASTM R record sequences must be positive, unique, and contiguous');
      }
      const code = (f[2] || '')
        .split('^')
        .map(component => component.trim())
        .filter(Boolean)
        .pop() || null;
      const valueRaw = (f[3] || '').trim();
      const range = (f[5] || '').trim();
      const [rangeLowRaw = '', rangeHighRaw = ''] = range.includes('^')
        ? range.split('^', 2)
        : [];
      out.results.push({
        test_code: code,
        value_text: valueRaw || null,
        value_numeric: strictNumericOrNull(valueRaw),
        unit: (f[4] || '').trim() || null,
        reference_range: range ? range.replace('^', '-') : null,
        reference_low: strictNumericOrNull(rangeLowRaw),
        reference_high: strictNumericOrNull(rangeHighRaw),
        abnormal_flag: (f[6] || '').trim() || null,
        result_status: (f[8] || '').trim() || null,
      });
      if (!code) out.errors.push(`R record without a test code: ${record.slice(0, 40)}`);
      if (!valueRaw) out.errors.push(`R record ${code || '?'} has no result value`);
      if (String((f[8] || '').trim()).toUpperCase() !== 'F') {
        out.errors.push(`R record ${code || '?'} is not a supported final result`);
      }
    } else if (type === 'L') {
      terminatorPositions.push(recordIndex);
      if ((f[1] || '').trim() !== '1') {
        out.errors.push('single-message ASTM L record must use sequence 1');
      }
    } else if (type !== 'P' && type !== 'C') {
      out.errors.push(`unsupported ASTM record type '${type || '?'}'`);
    }
  }
  const headerPosition = headerPositions[0];
  const orderPosition = orderPositions[0];
  const terminatorPosition = terminatorPositions[0];
  const envelopeIsComplete = headerPositions.length === 1
    && orderPositions.length === 1
    && resultPositions.length > 0
    && terminatorPositions.length === 1
    && headerPosition === 0
    && orderPosition > headerPosition
    && resultPositions.every(position => position > orderPosition && position < terminatorPosition)
    && terminatorPosition === records.length - 1
    && records.every((record, position) => {
      const type = (record.split('|')[0] || '').trim();
      if (type === 'P') return position > headerPosition && position < orderPosition;
      if (type === 'C') return position > orderPosition && position < terminatorPosition;
      return true;
    });
  if (!envelopeIsComplete) {
    out.errors.push('ASTM message must be one complete ordered H/(P)/O/R.../L envelope');
  }
  if (!out.accession) out.errors.push('no O record with a specimen/accession id');
  if (!out.ordered_test_code) out.errors.push('O record requires an ordered test code');
  if (out.results.length === 0) out.errors.push('no R records');
  if (out.results.length > 1) {
    out.errors.push(
      'multi-result ASTM messages require an explicit ordered-panel analyte contract',
    );
  }
  if (
    out.results.length === 1
    && String(out.results[0].test_code).toUpperCase()
      !== String(out.ordered_test_code).toUpperCase()
  ) {
    out.errors.push('single-result ASTM analyte does not match its O record');
  }
  return out;
}

// ── Specimen labels ────────────────────────────────────────────────────────

async function loadSpecimen(where, params = []) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT s.id, s.tenant_id, s.specimen_uid, s.patient_uid, s.booking_id, s.accession_number,
            s.barcode, s.specimen_type, s.container_type, s.priority, s.status,
            s.collected_at, s.received_at, s.label_printed_at,
            u.name AS patient_name
       FROM lab_specimens s
       LEFT JOIN users u ON u.uid = s.patient_uid
      WHERE ${where}
      LIMIT 1`,
    ...params,
  );
  return rows[0] || null;
}

/**
 * Specimen label payload (idempotent barcode issue). The barcode is the
 * accession number — already unique per specimen — uppercased for Code 39.
 */
export async function getSpecimenLabel(specimenId, { actorUid = null, tenantId = DEFAULT_TENANT } = {}) {
  const specimen = await loadSpecimen(
    's.id = $1::int AND s.tenant_id = $2::uuid',
    [specimenId, tenantId],
  );
  if (!specimen) throw AppError.notFound('Specimen not found', 'LAB_SPECIMEN_NOT_FOUND');
  const barcode = (specimen.barcode || specimen.accession_number || '').toUpperCase();
  await prisma.$executeRawUnsafe(
    `UPDATE lab_specimens SET
       barcode = COALESCE(barcode, accession_number),
       label_printed_at = NOW(), label_printed_by = $2::uuid, updated_at = NOW()
     WHERE id = $1::int AND tenant_id = $3::uuid`,
    specimenId, actorUid, tenantId,
  );
  return {
    specimen_id: specimen.id,
    barcode,
    accession_number: specimen.accession_number,
    specimen_type: specimen.specimen_type,
    container_type: specimen.container_type,
    priority: specimen.priority,
    patient: { uid: specimen.patient_uid, name: specimen.patient_name || null },
    collected_at: specimen.collected_at,
    barcode_symbology: 'code39',
    svg: code39Svg(barcode, { module: 2, height: 44 }),
    generated_at: new Date().toISOString(),
  };
}

/**
 * Scan-on-receipt: the lab scans the tube barcode; specimen transitions
 * collected/in_transit → received with history + canonical events.
 */
export async function scanReceiveSpecimen({ barcode, actorUid = null, actorRole = null, tenantId = DEFAULT_TENANT } = {}) {
  const cleaned = (barcode || '').trim();
  if (!cleaned) throw AppError.badRequest('barcode is required', 'LAB_BARCODE_REQUIRED');
  const specimen = await loadSpecimen(
    'UPPER(s.barcode) = UPPER($1) AND s.tenant_id = $2::uuid',
    [cleaned, tenantId],
  );
  if (!specimen) throw AppError.notFound('No specimen carries this barcode', 'LAB_SPECIMEN_NOT_FOUND');
  if (specimen.status === 'received' || specimen.status === 'processing') {
    throw AppError.conflict(`Specimen already ${specimen.status}`, 'LAB_SPECIMEN_ALREADY_RECEIVED', {
      specimen_id: specimen.id, received_at: specimen.received_at,
    });
  }
  if (!['collected', 'in_transit', 'ordered'].includes(specimen.status)) {
    throw AppError.conflict(`Specimen is ${specimen.status} — cannot receive`, 'LAB_SPECIMEN_WRONG_STATUS');
  }

  return setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE lab_specimens SET
         status = 'received', received_at = NOW(), received_by = $2::uuid, updated_at = NOW()
       WHERE id = $1::int AND tenant_id = $3::uuid
       RETURNING id, tenant_id, patient_uid, booking_id, accession_number, barcode, status, received_at`,
      specimen.id, actorUid, tenantId,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO lab_specimen_status_history (tenant_id, specimen_id, from_status, to_status, reason, changed_by)
       VALUES ($1::uuid, $2, $3, 'received', 'barcode scan on receipt', $4::uuid)`,
      requireTenantId(specimen.tenant_id), specimen.id, specimen.status, actorUid,
    );
    await recordCanonicalClinicalEvent({
      tenantId: specimen.tenant_id,
      patientUid: specimen.patient_uid,
      eventType: 'lab.specimen_received',
      eventStatus: 'received',
      sourceTable: 'lab_specimens',
      sourceId: String(specimen.id),
      resourceType: 'lab_specimen',
      resourceId: String(specimen.id),
      actorUid,
      actorRole,
      summary: `Specimen ${specimen.accession_number} received in lab (barcode scan)`,
      payload: {
        specimen_id: specimen.id,
        accession_number: specimen.accession_number,
        barcode: specimen.barcode,
        previous_status: specimen.status,
      },
      beforeState: { status: specimen.status },
      afterState: { status: 'received' },
      tags: ['lab', 'specimen', 'barcode'],
      timelineIdempotencyKey: `lab_specimens:${specimen.id}:lab.specimen_received`,
      auditIdempotencyKey: `lab_specimens:${specimen.id}:audit:lab.specimen_received`,
    }, { db: tx });
    return rows[0];
  });
}

// ── Analyzer interface inbox ───────────────────────────────────────────────

function configuredStringArray(metadata, key) {
  const value = metadata && typeof metadata === 'object' ? metadata[key] : null;
  if (!Array.isArray(value)) return [];
  return value
    .map(item => String(item || '').trim().toLowerCase())
    .filter(Boolean);
}

async function resolveTrustedAstmAnalyzer({
  tx,
  tenantId,
  analyzerCode,
  parsed,
  apiClientId = null,
  apiClientTenantId = null,
  actorUid,
  actorRoles = [],
}) {
  const analyzerRows = await tx.$queryRawUnsafe(
    `SELECT id, analyzer_code, display_name, interface_kind, status, metadata
       FROM lab_analyzers
      WHERE tenant_id = $1::uuid
        AND status = 'active'
        AND interface_kind = 'astm'
      ORDER BY id
      FOR SHARE`,
    tenantId,
  );
  const requestedCode = String(analyzerCode || '').trim();
  const analyzer = analyzerRows.find(row => row.analyzer_code === requestedCode) || null;
  if (!analyzer) {
    throw AppError.notFound('Active ASTM analyzer not found', 'LAB_ANALYZER_NOT_FOUND');
  }

  const senderIdentity = String(parsed.sender_identity || '').trim().toLowerCase();
  const normalizedActorUid = String(actorUid || '').trim().toLowerCase();
  const normalizedApiClientId = apiClientId == null ? '' : String(apiClientId).trim();
  const hasDatabaseApiClient = normalizedApiClientId.length > 0;
  const apiClientTenantMatches = String(apiClientTenantId || '').toLowerCase()
    === String(tenantId).toLowerCase();
  if (hasDatabaseApiClient && !apiClientTenantMatches) {
    throw AppError.forbidden(
      'Authenticated API client does not belong to the resolved tenant',
      'LAB_INTERFACE_API_CLIENT_TENANT_MISMATCH',
    );
  }
  const senderMatches = senderIdentity
    ? analyzerRows.filter(row => configuredStringArray(
      row.metadata,
      'astm_sender_aliases',
    ).includes(senderIdentity))
    : [];
  const clientMatches = hasDatabaseApiClient
    ? analyzerRows.filter(row => configuredStringArray(
      row.metadata,
      'astm_api_client_ids',
    ).includes(normalizedApiClientId.toLowerCase()))
    : [];
  const manualActorMatches = normalizedActorUid
    ? analyzerRows.filter(row => configuredStringArray(
      row.metadata,
      'astm_manual_import_actor_uids',
    ).includes(normalizedActorUid))
    : [];
  const uniquelyBoundBySender = senderMatches.length === 1
    && Number(senderMatches[0].id) === Number(analyzer.id);
  const uniquelyBoundByClient = clientMatches.length === 1
    && Number(clientMatches[0].id) === Number(analyzer.id);
  const uniquelyBoundManualActor = manualActorMatches.length === 1
    && Number(manualActorMatches[0].id) === Number(analyzer.id);
  const explicitManualActorBindingConflicts = manualActorMatches.length > 0
    && !uniquelyBoundManualActor;
  const isMachineActor = actorRoles.some(role => MACHINE_INTERFACE_ROLES.has(role));
  if (
    !uniquelyBoundBySender
    || (hasDatabaseApiClient && (!uniquelyBoundByClient || explicitManualActorBindingConflicts))
    || (!hasDatabaseApiClient && isMachineActor)
    || (!hasDatabaseApiClient && !isMachineActor && !uniquelyBoundManualActor)
  ) {
    throw AppError.forbidden(
      'Authenticated ASTM channel does not match the configured analyzer',
      'LAB_ASTM_ANALYZER_UNTRUSTED',
    );
  }
  const bindingMode = hasDatabaseApiClient ? 'api_client' : 'manual_import_actor';
  const bindingIdentity = hasDatabaseApiClient
    ? normalizedApiClientId
    : String(actorUid).toLowerCase();
  return {
    analyzer,
    bindingMode,
    bindingIdentity,
    senderIdentity: String(parsed.sender_identity).trim(),
  };
}

async function groundLabInterfaceActor({ tx, tenantId, context }) {
  const actorUid = String(context.actorUid || '').trim();
  if (!UUID_PATTERN.test(actorUid)) {
    throw AppError.forbidden(
      'Authenticated lab interface actor is required',
      'LAB_INTERFACE_ACTOR_REQUIRED',
    );
  }
  const suppliedRoles = [...new Set([
    ...(Array.isArray(context.actorRoles) ? context.actorRoles : []),
    context.actorRole,
  ].map(role => String(role || '').trim().toUpperCase()).filter(Boolean))];
  const actorRows = await tx.$queryRawUnsafe(
    `SELECT uid, role
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND is_active = TRUE
        AND status = 'active'
        AND is_deleted = FALSE
      LIMIT 1
      FOR SHARE`,
    tenantId,
    actorUid,
  );
  const actor = actorRows[0];
  const groundedRole = String(actor?.role || '').trim().toUpperCase();
  if (
    !actor
    || !suppliedRoles.includes(groundedRole)
    || !LAB_INTERFACE_INGEST_ROLES.includes(groundedRole)
  ) {
    throw AppError.forbidden(
      'Authenticated actor cannot ingest analyzer results',
      'LAB_INTERFACE_ACTOR_FORBIDDEN',
    );
  }
  return {
    actorUid: String(actor.uid),
    actorRole: groundedRole,
    actorRoles: [groundedRole],
  };
}

async function priorNumericValue({
  client,
  tenantId,
  patientUid,
  testCode,
  interfaceMessageId,
}) {
  const rows = await client.$queryRawUnsafe(
    `SELECT value_numeric
       FROM lab_results
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND UPPER(test_code) = UPPER($3)
        AND value_numeric IS NOT NULL
        AND (interface_message_id IS NULL OR interface_message_id <> $4::int)
      ORDER BY COALESCE(performed_at, received_at) DESC, id DESC
      LIMIT 1
      FOR SHARE`,
    tenantId,
    patientUid,
    testCode,
    interfaceMessageId,
  );
  return rows[0]?.value_numeric != null ? Number(rows[0].value_numeric) : null;
}

/**
 * Rules-authoritative ingestion verdict for one result (delta + critical
 * band via the autoverification helpers). Database failures propagate so the
 * surrounding clinical transaction cannot commit a degraded partial result.
 */
async function verdictForResult({
  client,
  tenantId,
  interfaceMessageId,
  patientUid,
  testCode,
  testName,
  valueNumeric,
  abnormalFlag,
  referenceLow,
  referenceHigh,
  criticality,
}) {
  const prior = await priorNumericValue({
    client,
    tenantId,
    patientUid,
    testCode,
    interfaceMessageId,
  });
  const { delta_pct: deltaPct } = calculateDelta({ currentValue: valueNumeric, priorValue: prior });
  const builtin = lookupReferenceRange(testName || testCode) || {};
  const band = criticality?.breached
    ? `critical_${criticality.breachedSide}`
    : classifyCriticalBand({
      value: valueNumeric,
      referenceLow: referenceLow ?? builtin.referenceLow ?? builtin.reference_low ?? null,
      referenceHigh: referenceHigh ?? builtin.referenceHigh ?? builtin.reference_high ?? null,
    });
  const decision = buildAutoverificationDecision({
    criticalBand: band,
    deltaPct,
    priorValue: prior,
    hasAbnormalFlags: Boolean(abnormalFlag && abnormalFlag !== 'N'),
  });
  return {
    test_code: testCode,
    critical_band: band,
    delta_pct: deltaPct,
    prior_value: prior,
    critical_threshold_matched: criticality?.matched === true,
    threshold_assessment: thresholdAssessmentEvidence(criticality),
    ...decision,
  };
}

function labResultSourceMismatch() {
  return AppError.badRequest(
    'ASTM result source does not match the specimen, booking, investigation, or patient',
    'LAB_RESULT_SOURCE_MISMATCH',
  );
}

function astmReplayConflict() {
  return AppError.conflict(
    'ASTM message replay does not match the stored analyzer receipt',
    'LAB_ASTM_REPLAY_CONFLICT',
  );
}

async function lockAndResolveAstmSource({ tx, tenantId, accession }) {
  const specimenRows = await tx.$queryRawUnsafe(
    `SELECT specimen.id,
            specimen.tenant_id,
            specimen.patient_uid,
            specimen.booking_id,
            specimen.accession_number,
            specimen.barcode,
            specimen.status,
            patient.name AS patient_name
       FROM lab_specimens AS specimen
       JOIN users AS patient
         ON patient.tenant_id = specimen.tenant_id
        AND patient.uid = specimen.patient_uid
        AND UPPER(patient.role) = 'PATIENT'
        AND patient.is_active = TRUE
        AND patient.status = 'active'
        AND patient.is_deleted = FALSE
      WHERE specimen.tenant_id = $1::uuid
        AND (
          UPPER(specimen.accession_number) = UPPER($2)
          OR UPPER(specimen.barcode) = UPPER($2)
        )
      ORDER BY specimen.id
      LIMIT 2
      FOR UPDATE OF specimen
      FOR SHARE OF patient`,
    tenantId,
    accession,
  );
  if (specimenRows.length === 0) {
    throw AppError.notFound(
      `No specimen matches accession '${accession}' — closed loop requires the labelled specimen to exist`,
      'LAB_SPECIMEN_NOT_FOUND',
    );
  }
  if (specimenRows.length !== 1) throw labResultSourceMismatch();
  const specimen = specimenRows[0];
  if (!ASTM_ANALYZER_READY_SPECIMEN_STATUSES.has(String(specimen.status).toLowerCase())) {
    throw AppError.conflict(
      `Specimen is ${specimen.status} and is not analyzer-ready`,
      'LAB_SPECIMEN_NOT_ANALYZER_READY',
    );
  }

  if (specimen.booking_id == null) {
    // Patient-only/external specimens remain ingestible until governance defines
    // an authoritative order mapping; care-pathway activation preflight treats
    // this unresolved linkage as a cutover blocker.
    return {
      specimen,
      bookingId: null,
      investigationId: null,
      admissionId: null,
      orderingClinicianUid: null,
    };
  }

  const bookingRows = await tx.$queryRawUnsafe(
    `SELECT booking.id, booking.patient_id, booking.investigation_id, booking.status,
            booking_patient.uid AS booking_patient_uid
       FROM investigation_bookings AS booking
       JOIN users AS booking_patient
         ON booking_patient.tenant_id = booking.tenant_id
         AND booking_patient.id = booking.patient_id
         AND UPPER(booking_patient.role) = 'PATIENT'
         AND booking_patient.is_active = TRUE
         AND booking_patient.status = 'active'
         AND booking_patient.is_deleted = FALSE
      WHERE booking.tenant_id = $1::uuid
        AND booking.id = $2::bigint
      LIMIT 1
      FOR SHARE OF booking, booking_patient`,
    tenantId,
    Number(specimen.booking_id),
  );
  const booking = bookingRows[0];
  if (
    !booking
    || String(booking.booking_patient_uid).toLowerCase()
      !== String(specimen.patient_uid).toLowerCase()
    || !ASTM_NONTERMINAL_BOOKING_STATUSES.has(String(booking.status).toUpperCase())
  ) {
    throw labResultSourceMismatch();
  }

  if (booking.investigation_id == null) {
    return {
      specimen,
      bookingId: Number(booking.id),
      investigationId: null,
      admissionId: null,
      orderingClinicianUid: null,
    };
  }

  const investigationRows = await tx.$queryRawUnsafe(
    `SELECT investigation.id,
            investigation.patient_uid,
            investigation.requested_by,
            investigation.status,
            investigation.admission_id
       FROM investigations AS investigation
      WHERE investigation.tenant_id = $1::uuid
        AND investigation.id = $2::int
      LIMIT 1
      FOR UPDATE OF investigation`,
    tenantId,
    Number(booking.investigation_id),
  );
  const investigation = investigationRows[0];
  if (
    !investigation
    || String(investigation.patient_uid).toLowerCase()
      !== String(specimen.patient_uid).toLowerCase()
    || !ASTM_NONTERMINAL_INVESTIGATION_STATUSES.has(
      String(investigation.status).toUpperCase(),
    )
  ) {
    throw labResultSourceMismatch();
  }

  return {
    specimen,
    bookingId: Number(booking.id),
    investigationId: Number(investigation.id),
    admissionId: investigation.admission_id == null
      ? null
      : Number(investigation.admission_id),
    orderingClinicianUid: investigation.requested_by || null,
  };
}

async function loadAstmReplayOutcome({ tx, tenantId, message }) {
  const results = await tx.$queryRawUnsafe(
    `SELECT *
       FROM lab_results
      WHERE tenant_id = $1::uuid
        AND interface_message_id = $2::int
      ORDER BY interface_result_index`,
    tenantId,
    Number(message.id),
  );
  if (
    results.length !== Number(message.result_count)
    || results.some((result, index) => Number(result.interface_result_index) !== index + 1)
  ) {
    throw astmReplayConflict();
  }
  return {
    message_id: Number(message.id),
    status: 'ingested',
    protocol: 'astm_e1394',
    specimen_id: Number(message.specimen_id),
    results: results.map(result => ({ id: result.id, test_code: result.test_code })),
    verdicts: Array.isArray(message.verdicts) ? message.verdicts : [],
    replayed: true,
  };
}

async function claimAstmReceipt({
  tx,
  tenantId,
  analyzer,
  rawMessage,
  actor,
  bindingMode,
  bindingIdentity,
  senderIdentity,
}) {
  const inserted = await tx.$queryRawUnsafe(
    `INSERT INTO lab_interface_messages
       (tenant_id, analyzer_id, analyzer_code, direction, protocol,
        message_type, raw_message, status, ingest_contract_version,
        authenticated_actor_uid, authenticated_actor_roles,
        analyzer_binding_mode, analyzer_binding_identity,
        analyzer_sender_identity)
     VALUES ($1::uuid, $2::int, $3, 'inbound', 'astm_e1394',
             'ASTM-RESULT', $4, 'received', 1, $5::uuid, $6::text[], $7, $8, $9)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    tenantId,
    Number(analyzer.id),
    analyzer.analyzer_code,
    rawMessage,
    actor.actorUid,
    actor.actorRoles,
    bindingMode,
    bindingIdentity,
    senderIdentity,
  );
  if (inserted[0]) return { message: inserted[0], replayOutcome: null };

  const existingRows = await tx.$queryRawUnsafe(
    `SELECT *
       FROM lab_interface_messages
      WHERE tenant_id = $1::uuid
        AND analyzer_id = $2::int
        AND direction = 'inbound'
        AND protocol = 'astm_e1394'
        AND astm_message_sha256 = encode(
              digest(lab_astm_canonical_message($3::text), 'sha256'),
              'hex'
            )
      LIMIT 1
      FOR UPDATE`,
    tenantId,
    Number(analyzer.id),
    rawMessage,
  );
  const existing = existingRows[0];
  if (!existing) throw astmReplayConflict();
  const canonicalRows = await tx.$queryRawUnsafe(
    `SELECT lab_astm_canonical_message($1::text) =
            lab_astm_canonical_message($2::text) AS matches`,
    existing.raw_message,
    rawMessage,
  );
  if (canonicalRows[0]?.matches !== true) throw astmReplayConflict();
  if (Number(existing.ingest_contract_version) !== 1) {
    throw AppError.conflict(
      'Legacy ASTM receipt requires reconciliation before retry',
      'LAB_ASTM_LEGACY_RECEIPT_RECONCILIATION_REQUIRED',
    );
  }
  if (existing.status === 'ingested') {
    return {
      message: existing,
      replayOutcome: await loadAstmReplayOutcome({ tx, tenantId, message: existing }),
    };
  }
  if (existing.status !== 'failed') {
    throw AppError.conflict(
      'ASTM message is already being processed',
      'LAB_ASTM_REPLAY_IN_PROGRESS',
    );
  }
  if (
    String(existing.authenticated_actor_uid || '').toLowerCase()
      !== String(actor.actorUid).toLowerCase()
    || JSON.stringify([...(existing.authenticated_actor_roles || [])].sort())
      !== JSON.stringify([...actor.actorRoles].sort())
    || existing.analyzer_binding_mode !== bindingMode
    || String(existing.analyzer_binding_identity || '').toLowerCase()
      !== String(bindingIdentity).toLowerCase()
    || String(existing.analyzer_sender_identity || '').toLowerCase()
      !== String(senderIdentity).toLowerCase()
  ) {
    throw AppError.conflict(
      'Failed ASTM receipt can only be retried by its original authenticated channel',
      'LAB_ASTM_RETRY_PROVENANCE_MISMATCH',
    );
  }

  const linkedCounts = await tx.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count
       FROM lab_results
      WHERE tenant_id = $1::uuid
        AND interface_message_id = $2::int`,
    tenantId,
    Number(existing.id),
  );
  if (Number(linkedCounts[0]?.count || 0) !== 0) throw astmReplayConflict();
  const resetRows = await tx.$queryRawUnsafe(
    `UPDATE lab_interface_messages
        SET status = 'received',
            error = NULL,
            result_count = NULL,
            specimen_id = NULL,
            verdicts = NULL,
            processed_at = NULL
      WHERE tenant_id = $1::uuid
        AND id = $2::int
        AND status = 'failed'
      RETURNING *`,
    tenantId,
    Number(existing.id),
  );
  if (!resetRows[0]) throw astmReplayConflict();
  return { message: resetRows[0], replayOutcome: null };
}

async function persistFailedAstmReceipt({
  tenantId,
  analyzerCode,
  rawMessage,
  error,
  context,
}) {
  return setTenantTx(tenantId, async (tx) => {
    const actor = await groundLabInterfaceActor({ tx, tenantId, context });
    const parsed = parseAstmMessage(rawMessage);
    const trusted = await resolveTrustedAstmAnalyzer({
      tx,
      analyzerCode: String(analyzerCode || '').trim(),
      tenantId,
      parsed,
      apiClientId: context.apiClientId || null,
      apiClientTenantId: context.apiClientTenantId || null,
      actorUid: actor.actorUid,
      actorRoles: actor.actorRoles,
    });
    const {
      analyzer, bindingMode, bindingIdentity, senderIdentity,
    } = trusted;
    const errorText = String(error?.message || error || 'ASTM message could not be processed');
    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO lab_interface_messages
         (tenant_id, analyzer_id, analyzer_code, direction, protocol,
          message_type, raw_message, status, error, processed_at,
          ingest_contract_version, authenticated_actor_uid,
          authenticated_actor_roles, analyzer_binding_mode,
          analyzer_binding_identity, analyzer_sender_identity)
       VALUES ($1::uuid, $2::int, $3, 'inbound', 'astm_e1394',
               'ASTM-RESULT', $4, 'failed', $5, NOW(), 1,
               $6::uuid, $7::text[], $8, $9, $10)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      tenantId,
      Number(analyzer.id),
      analyzer.analyzer_code,
      rawMessage,
      errorText,
      actor.actorUid,
      actor.actorRoles,
      bindingMode,
      bindingIdentity,
      senderIdentity,
    );
    if (inserted[0]) return Number(inserted[0].id);

    const existingRows = await tx.$queryRawUnsafe(
      `SELECT message.id, message.status, message.ingest_contract_version,
              message.authenticated_actor_uid,
              message.authenticated_actor_roles,
              message.analyzer_binding_mode,
              message.analyzer_binding_identity,
              message.analyzer_sender_identity,
              (SELECT COUNT(*)::int
                 FROM lab_results AS result
                WHERE result.tenant_id = message.tenant_id
                  AND result.interface_message_id = message.id) AS linked_result_count
         FROM lab_interface_messages AS message
        WHERE message.tenant_id = $1::uuid
          AND message.direction = 'inbound'
          AND message.protocol = 'astm_e1394'
          AND message.astm_message_sha256 = encode(
                digest(lab_astm_canonical_message($4::text), 'sha256'),
                'hex'
              )
          AND message.analyzer_id = $2::int
        LIMIT 1
        FOR UPDATE OF message`,
      tenantId,
      Number(analyzer.id),
      analyzer.analyzer_code,
      rawMessage,
    );
    const existing = existingRows[0];
    if (!existing) throw astmReplayConflict();
    if (Number(existing.ingest_contract_version) !== 1) {
      throw AppError.conflict(
        'Legacy ASTM receipt requires reconciliation before retry',
        'LAB_ASTM_LEGACY_RECEIPT_RECONCILIATION_REQUIRED',
      );
    }
    if (existing.status !== 'failed') throw astmReplayConflict();
    if (Number(existing.linked_result_count || 0) !== 0) throw astmReplayConflict();
    if (
      String(existing.authenticated_actor_uid || '').toLowerCase()
        !== String(actor.actorUid).toLowerCase()
      || JSON.stringify([...(existing.authenticated_actor_roles || [])].sort())
        !== JSON.stringify([...actor.actorRoles].sort())
      || existing.analyzer_binding_mode !== bindingMode
      || String(existing.analyzer_binding_identity || '').toLowerCase()
        !== String(bindingIdentity).toLowerCase()
      || String(existing.analyzer_sender_identity || '').toLowerCase()
        !== String(senderIdentity).toLowerCase()
    ) {
      throw AppError.conflict(
        'Failed ASTM receipt is owned by another authenticated channel',
        'LAB_ASTM_RETRY_PROVENANCE_MISMATCH',
      );
    }
    return Number(existing.id);
  });
}

async function recordAstmResultCanonicalEvent({
  tx,
  tenantId,
  result,
  messageId,
  actorUid,
  actorRole,
  criticality,
  verdict,
  actorRoles,
  bindingMode,
  bindingIdentity,
  senderIdentity,
}) {
  return recordCanonicalClinicalEvent({
    tenantId,
    patientUid: result.patient_uid,
    encounterId: null,
    eventType: 'lab.result_recorded',
    eventSubtype: 'lab',
    eventStatus: result.status,
    sourceTable: 'lab_results',
    sourceId: String(result.id),
    resourceType: 'lab_result',
    resourceId: String(result.id),
    actorUid,
    actorRole,
    occurredAt: result.received_at || result.created_at || null,
    visibleToPatient: false,
    summary: `Lab result recorded from ASTM analyzer: ${result.test_name}`,
    payload: {
      interface_message_id: messageId,
      interface_result_index: result.interface_result_index,
      investigation_id: result.investigation_id,
      booking_id: result.booking_id,
      specimen_id: result.specimen_id,
      test_code: result.test_code,
      test_name: result.test_name,
      value_text: result.value_text,
      unit: result.unit,
      abnormal_flag: result.abnormal_flag,
      status: result.status,
      performed_by_lab: result.performed_by_lab,
      threshold_assessment: thresholdAssessmentEvidence(criticality),
      autoverification_verdict: verdict,
      authenticated_actor_uid: actorUid,
      authenticated_actor_roles: actorRoles,
      analyzer_binding_mode: bindingMode,
      analyzer_binding_identity: bindingIdentity,
      analyzer_sender_identity: senderIdentity,
    },
    metadata: {
      interface_message_id: messageId,
      interface_result_index: result.interface_result_index,
      threshold_assessment: thresholdAssessmentEvidence(criticality),
      autoverification_verdict: verdict,
      authenticated_actor_uid: actorUid,
      authenticated_actor_roles: actorRoles,
      analyzer_binding_mode: bindingMode,
      analyzer_binding_identity: bindingIdentity,
      analyzer_sender_identity: senderIdentity,
    },
    afterState: { status: result.status },
    tags: ['lab', 'lab_result', 'astm'],
    timelineIdempotencyKey: `lab_results:${result.id}:lab.result_recorded:astm:${messageId}`,
    auditIdempotencyKey: `lab_results:${result.id}:audit:lab.result_recorded:astm:${messageId}`,
  }, { db: tx });
}

async function ingestAstmInterfaceMessage({
  rawMessage,
  analyzerCode,
  tenantId,
}, context) {
  const hasApiClientId = context.apiClientId != null && String(context.apiClientId).trim() !== '';
  const hasApiClientTenant = context.apiClientTenantId != null
    && String(context.apiClientTenantId).trim() !== '';
  if (
    hasApiClientId !== hasApiClientTenant
    || (
      hasApiClientTenant
      && String(context.apiClientTenantId).toLowerCase() !== String(tenantId).toLowerCase()
    )
  ) {
    throw AppError.forbidden(
      'Authenticated API client does not belong to the resolved tenant',
      'LAB_INTERFACE_API_CLIENT_TENANT_MISMATCH',
    );
  }
  if (!analyzerCode || !String(analyzerCode).trim()) {
    throw AppError.badRequest(
      'analyzer_code is required for ASTM ingestion',
      'LAB_INTERFACE_ANALYZER_REQUIRED',
    );
  }

  const phaseOne = await setTenantTx(tenantId, async (tx) => {
    const actor = await groundLabInterfaceActor({ tx, tenantId, context });
    const parsed = parseAstmMessage(rawMessage);
    if (parsed.errors.length > 0) {
      throw AppError.badRequest(
        `ASTM message unusable: ${parsed.errors.join('; ')}`,
        'LAB_INTERFACE_ASTM_INVALID',
      );
    }
    const trusted = await resolveTrustedAstmAnalyzer({
      tx,
      analyzerCode: String(analyzerCode).trim(),
      tenantId,
      parsed,
      apiClientId: context.apiClientId || null,
      apiClientTenantId: context.apiClientTenantId || null,
      actorUid: actor.actorUid,
      actorRoles: actor.actorRoles,
    });
    const {
      analyzer, bindingMode, bindingIdentity, senderIdentity,
    } = trusted;
    const claimed = await claimAstmReceipt({
      tx,
      tenantId,
      analyzer,
      rawMessage,
      actor,
      bindingMode,
      bindingIdentity,
      senderIdentity,
    });
    if (claimed.replayOutcome) {
      return { outcome: claimed.replayOutcome, materializations: [], replayed: true };
    }

    const messageId = Number(claimed.message.id);
    const source = await lockAndResolveAstmSource({
      tx,
      tenantId,
      accession: parsed.accession,
    });
    await assertConfiguredCriticalAnalytesNumeric({
      client: tx,
      tenantId,
      results: parsed.results,
    });
    const insertedResults = [];
    const verdicts = [];
    const materializations = [];

    for (let index = 0; index < parsed.results.length; index += 1) {
      const parsedResult = parsed.results[index];
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO lab_results
           (tenant_id, booking_id, investigation_id, admission_id, patient_uid, patient_name,
            test_code, test_name, value_text, value_numeric, unit,
            reference_range, reference_range_low, reference_range_high,
            abnormal_flag, status, performed_by_lab, specimen_id, analyzer_id,
            raw_obx, received_at, interface_message_id, interface_result_index)
         VALUES ($1::uuid, $2::int, $3::int, $4::int, $5::uuid, $6,
                 $7, $8, $9, $10::numeric, $11,
                 $12, $13::numeric, $14::numeric,
                 $15, 'preliminary', $16, $17::int, $18::int,
                 $19, NOW(), $20::int, $21::int)
         RETURNING *`,
        tenantId,
        source.bookingId,
        source.investigationId,
        source.admissionId,
        source.specimen.patient_uid,
        source.specimen.patient_name || null,
        parsedResult.test_code,
        parsedResult.test_code,
        parsedResult.value_text,
        parsedResult.value_numeric,
        parsedResult.unit,
        parsedResult.reference_range,
        parsedResult.reference_low,
        parsedResult.reference_high,
        parsedResult.abnormal_flag,
        analyzer.display_name || analyzer.analyzer_code,
        Number(source.specimen.id),
        Number(analyzer.id),
        JSON.stringify(parsedResult),
        messageId,
        index + 1,
      );
      const result = rows[0];
      if (!result) throw new Error('ASTM lab result was not persisted');

      const criticality = await evaluateCriticalThreshold({ client: tx, tenantId, result });
      const materialized = await materializeLabCriticalAlertGeneration({
        tx,
        tenantId,
        resultId: result.id,
        expectedPatientUid: source.specimen.patient_uid,
        criticality,
        orderingClinicianUid: source.orderingClinicianUid,
        source: 'lab_astm',
      });
      if (materialized.created) {
        result.is_critical = true;
        materializations.push({ ...materialized, result });
      }
      const verdict = {
        ...await verdictForResult({
        client: tx,
        tenantId,
        interfaceMessageId: messageId,
        patientUid: source.specimen.patient_uid,
        testCode: result.test_code,
        testName: result.test_name,
        valueNumeric: result.value_numeric == null ? null : Number(result.value_numeric),
        abnormalFlag: result.abnormal_flag,
        referenceLow: result.reference_range_low == null
          ? null
          : Number(result.reference_range_low),
        referenceHigh: result.reference_range_high == null
          ? null
          : Number(result.reference_range_high),
        criticality,
        }),
        interface_result_index: index + 1,
      };
      const canonical = await recordAstmResultCanonicalEvent({
        tx,
        tenantId,
        result,
        messageId,
        actorUid: actor.actorUid,
        actorRole: actor.actorRole,
        criticality,
        verdict,
        actorRoles: actor.actorRoles,
        bindingMode,
        bindingIdentity,
        senderIdentity,
      });
      if (result.admission_id != null) {
        await publishInpatientDiagnosticResourceLinkedTx({
          tx,
          tenantId,
          admissionId: result.admission_id,
          patientUid: result.patient_uid,
          resourceType: 'lab_result',
          resourceId: result.id,
          canonicalTimelineEventId: canonical.timeline.id,
          canonicalAuditEventId: canonical.audit.id,
          occurredAt: result.received_at || result.created_at,
        });
      }
      insertedResults.push(result);
      verdicts.push(verdict);
    }

    if (source.investigationId != null) {
      const transitionedInvestigations = await tx.$queryRawUnsafe(
        `UPDATE investigations
            SET status = 'IN_PROGRESS',
                result_uploaded_at = COALESCE(result_uploaded_at, NOW()),
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND id = $2::int
            AND status = ANY($3::text[])
          RETURNING id`,
        tenantId,
        source.investigationId,
        [...ASTM_PRE_RESULT_STATUSES, 'IN_PROGRESS'],
      );
      if (transitionedInvestigations.length !== 1) throw labResultSourceMismatch();
    }

    const completed = await tx.$queryRawUnsafe(
      `UPDATE lab_interface_messages
          SET status = 'ingested',
              error = NULL,
              result_count = $3::int,
              specimen_id = $4::int,
              verdicts = $5::jsonb,
              processed_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::int
          AND status = 'received'
        RETURNING id`,
      tenantId,
      messageId,
      insertedResults.length,
      Number(source.specimen.id),
      JSON.stringify(verdicts),
    );
    if (!completed[0]) throw astmReplayConflict();

    await recordCanonicalClinicalEvent({
      tenantId,
      patientUid: source.specimen.patient_uid,
      encounterId: null,
      eventType: 'lab.analyzer_results_ingested',
      eventSubtype: 'lab',
      eventStatus: 'ingested',
      sourceTable: 'lab_interface_messages',
      sourceId: String(messageId),
      resourceType: 'lab_interface_message',
      resourceId: String(messageId),
      actorUid: actor.actorUid,
      actorRole: actor.actorRole,
      visibleToPatient: false,
      summary: `${insertedResults.length} analyzer result(s) ingested for specimen ${source.specimen.accession_number}`
        + (verdicts.some(verdict => verdict.decision === 'critical') ? ' — CRITICAL band present' : ''),
      payload: {
        interface_message_id: messageId,
        specimen_id: Number(source.specimen.id),
        booking_id: source.bookingId,
        investigation_id: source.investigationId,
        analyzer_id: Number(analyzer.id),
        analyzer_code: analyzer.analyzer_code,
        analyzer_binding_mode: bindingMode,
        analyzer_binding_identity: bindingIdentity,
        analyzer_sender_identity: senderIdentity,
        authenticated_actor_uid: actor.actorUid,
        authenticated_actor_roles: actor.actorRoles,
        result_count: insertedResults.length,
        result_ids: insertedResults.map(result => Number(result.id)),
        decisions: verdicts.map(verdict => ({
          test_code: verdict.test_code,
          decision: verdict.decision,
          delta_pct: verdict.delta_pct ?? null,
        })),
      },
      metadata: {
        interface_message_id: messageId,
        authenticated_actor_uid: actor.actorUid,
        authenticated_actor_roles: actor.actorRoles,
        analyzer_binding_mode: bindingMode,
        analyzer_binding_identity: bindingIdentity,
        analyzer_sender_identity: senderIdentity,
      },
      afterState: { status: 'ingested', result_count: insertedResults.length },
      tags: ['lab', 'analyzer', 'interface', 'astm'],
      timelineIdempotencyKey: `lab_interface_messages:${messageId}:ingested`,
      auditIdempotencyKey: `lab_interface_messages:${messageId}:audit:ingested`,
    }, { db: tx });

    return {
      replayed: false,
      materializations,
      outcome: {
        message_id: messageId,
        status: 'ingested',
        protocol: 'astm_e1394',
        specimen_id: Number(source.specimen.id),
        results: insertedResults.map(result => ({ id: result.id, test_code: result.test_code })),
        verdicts,
        replayed: false,
      },
    };
  });

  if (!phaseOne.replayed) {
    await notifyCreatedCriticalLabAlerts({
      tenantId,
      materializations: phaseOne.materializations,
    }).catch((err) => logger.error('ASTM critical-result notification fan-out failed', {
      tenantId,
      messageId: phaseOne.outcome.message_id,
      error: err?.message,
    }));
    emitLabEvent('result-pending', { tenantId });
  }
  return phaseOne.outcome;
}

/**
 * Persist + process one inbound analyzer payload.
 *   protocol 'astm_e1394' parses records, links the specimen by
 *     accession/barcode, writes lab_results rows, runs critical detection
 *     and per-result delta/critical verdicts.
 * HL7 ORU callers use /api/v1/lab/oru/ingest, whose migration-582 claim is
 * the only durable receipt and replay authority for that protocol.
 */
export async function ingestInterfaceMessage({
  protocol, rawMessage, analyzerCode = null, tenantId = null,
} = {}, context = {}) {
  tenantId = requireTenantId(tenantId);
  if (!['hl7v2', 'astm_e1394'].includes(protocol)) {
    throw AppError.badRequest("protocol must be 'hl7v2' or 'astm_e1394'", 'LAB_INTERFACE_BAD_PROTOCOL');
  }
  if (!rawMessage || !String(rawMessage).trim()) {
    throw AppError.badRequest('message is required', 'LAB_INTERFACE_EMPTY');
  }
  const text = String(rawMessage);
  if (protocol === 'hl7v2') {
    throw AppError.badRequest(
      'HL7 ORU messages must use /api/v1/lab/oru/ingest',
      'LAB_INTERFACE_HL7_ROUTE_REQUIRED',
    );
  }

  try {
    return await ingestAstmInterfaceMessage({
      rawMessage: text,
      analyzerCode,
      tenantId,
    }, context);
  } catch (err) {
    let messageId = err?.details?.interface_message_id || null;
    if (!ASTM_ACTOR_DENIAL_CODES.has(err?.code)) {
      try {
        messageId = await persistFailedAstmReceipt({
          tenantId,
          analyzerCode,
          rawMessage: text,
          error: err,
          context,
        });
      } catch (receiptErr) {
        logger.error('ASTM failed-receipt persistence failed', {
          tenantId,
          analyzerCode,
          ingestionError: err?.message,
          receiptError: receiptErr?.message,
        });
      }
    }
    if (err instanceof AppError) {
      err.details = { ...(err.details || {}), interface_message_id: messageId };
      throw err;
    }
    logger.error('ASTM interface message ingestion failed', {
      tenantId,
      analyzerCode,
      interfaceMessageId: messageId,
      error: err?.message,
    });
    throw new AppError(
      'Interface message could not be processed',
      500,
      'LAB_INTERFACE_INGEST_FAILED',
      { interface_message_id: messageId },
    );
  }
}

export async function listInterfaceMessages({ status = null, limit = 50, tenantId = DEFAULT_TENANT } = {}) {
  const params = [tenantId];
  let where = 'tenant_id = $1::uuid';
  if (status) { params.push(status); where += ` AND status = $${params.length}`; }
  params.push(Math.min(Number.parseInt(limit, 10) || 50, 200));
  return prisma.$queryRawUnsafe(
    `SELECT id, analyzer_id, analyzer_code, direction, protocol, message_type, status,
            error, result_count, specimen_id, verdicts, processed_at, created_at
       FROM lab_interface_messages
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length}::int`,
    ...params,
  );
}

export default {
  parseAstmMessage,
  getSpecimenLabel,
  scanReceiveSpecimen,
  ingestInterfaceMessage,
  listInterfaceMessages,
};
