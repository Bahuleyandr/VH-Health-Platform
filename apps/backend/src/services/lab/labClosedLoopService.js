// src/services/lab/labClosedLoopService.js
//
// Roadmap B3 — closed-loop lab foundations on top of the existing specimen
// tables (260), ORU ingestion (labResultsService) and autoverification rule
// helpers (labAutoverificationService):
//
//   * specimen barcode label at collection (Code 39, printable HTML)
//   * scan-on-receipt in the lab (status transition + history + canonical
//     timeline/audit events)
//   * analyzer interface inbox: raw ASTM E1394 / HL7v2 payloads persisted
//     with parse/ingest outcome; ASTM results land in lab_results linked to
//     the scanned specimen, run through critical detection AND the
//     rules-authoritative delta/critical-band verdicts at ingestion time.
//
// Physical analyzer transports (serial/MLLP listeners) are owner-side
// deployment work; middleware-capable analyzers POST the same payloads to
// the HTTP bridge endpoint.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { code39Svg } from '../../utils/barcode/code39.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { ingestOruMessage, detectCriticalsForResults } from './labResultsService.js';
import {
  calculateDelta,
  classifyCriticalBand,
  buildAutoverificationDecision,
  lookupReferenceRange,
} from '../ai/labAutoverificationService.js';

const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';

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
  if (!text) return { sender: null, accession: null, results: [], errors: ['empty message'] };
  const records = text.split(/\r\n|\r|\n/).map((r) => r.trim()).filter(Boolean);
  const out = { sender: null, accession: null, results: [], errors: [] };
  for (const record of records) {
    const type = record[0]?.toUpperCase();
    const f = record.split('|');
    if (type === 'H') {
      out.sender = (f[4] || '').split('^').filter(Boolean).join(' ') || null;
    } else if (type === 'O') {
      if (!out.accession) out.accession = (f[2] || '').trim() || null;
    } else if (type === 'R') {
      const code = (f[2] || '').split('^').filter(Boolean).pop() || null;
      const valueRaw = (f[3] || '').trim();
      const valueNumeric = Number.parseFloat(valueRaw);
      const range = (f[5] || '').trim();
      out.results.push({
        test_code: code,
        value_text: valueRaw || null,
        value_numeric: Number.isFinite(valueNumeric) ? valueNumeric : null,
        unit: (f[4] || '').trim() || null,
        reference_range: range ? range.replace('^', '-') : null,
        reference_low: range.includes('^') ? Number.parseFloat(range.split('^')[0]) : null,
        reference_high: range.includes('^') ? Number.parseFloat(range.split('^')[1]) : null,
        abnormal_flag: (f[6] || '').trim() || null,
        result_status: (f[8] || '').trim() || null,
      });
      if (!code) out.errors.push(`R record without a test code: ${record.slice(0, 40)}`);
    }
  }
  if (!out.accession) out.errors.push('no O record with a specimen/accession id');
  if (out.results.length === 0) out.errors.push('no R records');
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

  return prisma.$transaction(async (tx) => {
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
      specimen.tenant_id || DEFAULT_TENANT, specimen.id, specimen.status, actorUid,
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

async function resolveAnalyzer(analyzerCode) {
  if (!analyzerCode) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, analyzer_code, display_name FROM lab_analyzers
      WHERE analyzer_code = $1 LIMIT 1`,
    analyzerCode,
  );
  return rows[0] || null;
}

async function priorNumericValue(patientUid, testCode, beforeResultId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT value_numeric FROM lab_results
      WHERE patient_uid = $1::uuid AND test_code = $2 AND value_numeric IS NOT NULL
        AND ($3::int IS NULL OR id <> $3::int)
      ORDER BY received_at DESC, id DESC LIMIT 1`,
    patientUid, testCode, beforeResultId,
  );
  return rows[0]?.value_numeric != null ? Number(rows[0].value_numeric) : null;
}

/**
 * Rules-authoritative ingestion verdict for one result (delta + critical
 * band via the autoverification helpers). Never throws.
 */
async function verdictForResult({ patientUid, testCode, testName, valueNumeric, abnormalFlag, referenceLow, referenceHigh, resultId }) {
  try {
    const prior = await priorNumericValue(patientUid, testCode, resultId);
    const { delta_pct: deltaPct } = calculateDelta({ currentValue: valueNumeric, priorValue: prior });
    const builtin = lookupReferenceRange(testName || testCode) || {};
    const band = classifyCriticalBand({
      value: valueNumeric,
      referenceLow: referenceLow ?? builtin.referenceLow ?? builtin.reference_low ?? null,
      referenceHigh: referenceHigh ?? builtin.referenceHigh ?? builtin.reference_high ?? null,
      criticalLow: builtin.criticalLow ?? builtin.critical_low ?? null,
      criticalHigh: builtin.criticalHigh ?? builtin.critical_high ?? null,
    });
    const decision = buildAutoverificationDecision({
      criticalBand: band,
      deltaPct,
      priorValue: prior,
      hasAbnormalFlags: Boolean(abnormalFlag && abnormalFlag !== 'N'),
    });
    return { test_code: testCode, critical_band: band, delta_pct: deltaPct, prior_value: prior, ...decision };
  } catch (err) {
    logger.warn('Lab ingestion verdict failed (result keeps default review path)', { error: err.message });
    return { test_code: testCode, decision: 'hold_for_review', decision_reason: 'verdict_engine_error' };
  }
}

/**
 * Persist + process one inbound analyzer payload.
 *   protocol 'hl7v2'      → delegates to the existing ORU ingestion.
 *   protocol 'astm_e1394' → parses records, links the specimen by
 *     accession/barcode, writes lab_results rows, runs critical detection
 *     and per-result delta/critical verdicts.
 */
export async function ingestInterfaceMessage({
  protocol, rawMessage, analyzerCode = null, tenantId = DEFAULT_TENANT,
} = {}, context = {}) {
  if (!['hl7v2', 'astm_e1394'].includes(protocol)) {
    throw AppError.badRequest("protocol must be 'hl7v2' or 'astm_e1394'", 'LAB_INTERFACE_BAD_PROTOCOL');
  }
  if (!rawMessage || !String(rawMessage).trim()) {
    throw AppError.badRequest('message is required', 'LAB_INTERFACE_EMPTY');
  }
  const analyzer = await resolveAnalyzer(analyzerCode);
  const inserted = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_interface_messages
       (tenant_id, analyzer_id, analyzer_code, direction, protocol, message_type, raw_message, status)
     VALUES ($1::uuid, $2::int, $3, 'inbound', $4, $5, $6, 'received')
     RETURNING id`,
    tenantId, analyzer?.id || null, analyzerCode, protocol,
    protocol === 'hl7v2' ? 'ORU^R01' : 'ASTM-RESULT', String(rawMessage),
  );
  const messageId = Number(inserted[0].id);

  try {
    if (protocol === 'hl7v2') {
      const outcome = await ingestOruMessage(String(rawMessage), { tenantId, source: analyzerCode || 'interface' });
      const resultCount = outcome?.results?.length ?? outcome?.inserted ?? null;
      await prisma.$executeRawUnsafe(
        `UPDATE lab_interface_messages SET status = 'ingested', result_count = $2::int, processed_at = NOW() WHERE id = $1`,
        messageId, resultCount,
      );
      return { message_id: messageId, status: 'ingested', protocol, outcome };
    }

    // ASTM path.
    const parsed = parseAstmMessage(rawMessage);
    if (!parsed.accession || parsed.results.length === 0) {
      throw AppError.badRequest(
        `ASTM message unusable: ${parsed.errors.join('; ')}`,
        'LAB_INTERFACE_ASTM_INVALID',
      );
    }
    const specimen = await loadSpecimen(
      'UPPER(COALESCE(s.barcode, s.accession_number)) = UPPER($1) AND s.tenant_id = $2::uuid',
      [parsed.accession, tenantId],
    );
    if (!specimen) {
      throw AppError.notFound(
        `No specimen matches accession '${parsed.accession}' — closed loop requires the labelled specimen to exist`,
        'LAB_SPECIMEN_NOT_FOUND',
      );
    }

    const insertedResults = [];
    for (const r of parsed.results) {
      const rows = await prisma.$queryRawUnsafe(
        `INSERT INTO lab_results
           (tenant_id, booking_id, patient_uid, patient_name, test_code, test_name,
            value_text, value_numeric, unit, reference_range, reference_range_low,
            reference_range_high, abnormal_flag, status, performed_by_lab, specimen_id,
            analyzer_id, raw_obx, received_at)
         VALUES ($1::uuid, $2::int, $3::uuid, $4, $5, $6, $7, $8, $9, $10,
                 $11, $12, $13, 'preliminary', $14, $15::int, $16::int, $17, NOW())
         RETURNING id, test_code, test_name, value_numeric, abnormal_flag`,
        specimen.tenant_id || tenantId, specimen.booking_id, specimen.patient_uid,
        specimen.patient_name || null, r.test_code, r.test_code, r.value_text,
        r.value_numeric, r.unit, r.reference_range, r.reference_low, r.reference_high,
        r.abnormal_flag, parsed.sender || analyzerCode || 'analyzer', specimen.id,
        analyzer?.id || null, JSON.stringify(r),
      );
      insertedResults.push({ ...rows[0], reference_low: r.reference_low, reference_high: r.reference_high });
    }

    // Critical detection (fires lab_critical_alerts) — best-effort.
    try {
      await detectCriticalsForResults({
        tenantId: specimen.tenant_id || tenantId,
        results: insertedResults.map((r) => ({ id: r.id })),
      });
    } catch (criticalErr) {
      logger.warn('Critical detection failed for interface results', { error: criticalErr.message });
    }

    // Per-result rules verdicts (delta + critical band) stored on the inbox row.
    const verdicts = [];
    for (const r of insertedResults) {
      verdicts.push(await verdictForResult({
        patientUid: specimen.patient_uid,
        testCode: r.test_code,
        testName: r.test_name,
        valueNumeric: r.value_numeric != null ? Number(r.value_numeric) : null,
        abnormalFlag: r.abnormal_flag,
        referenceLow: r.reference_low,
        referenceHigh: r.reference_high,
        resultId: r.id,
      }));
    }

    await prisma.$executeRawUnsafe(
      `UPDATE lab_interface_messages SET
         status = 'ingested', result_count = $2::int, specimen_id = $3::int,
         verdicts = $4::jsonb, processed_at = NOW()
       WHERE id = $1`,
      messageId, insertedResults.length, specimen.id, JSON.stringify(verdicts),
    );

    await recordCanonicalClinicalEvent({
      tenantId: specimen.tenant_id || tenantId,
      patientUid: specimen.patient_uid,
      eventType: 'lab.analyzer_results_ingested',
      eventStatus: 'ingested',
      sourceTable: 'lab_interface_messages',
      sourceId: String(messageId),
      resourceType: 'lab_interface_message',
      resourceId: String(messageId),
      actorUid: context.actorUid || null,
      actorRole: context.actorRole || null,
      summary: `${insertedResults.length} analyzer result(s) ingested for specimen ${specimen.accession_number}`
        + (verdicts.some((v) => v.decision === 'critical') ? ' — CRITICAL band present' : ''),
      payload: {
        interface_message_id: messageId,
        specimen_id: specimen.id,
        analyzer_code: analyzerCode,
        result_count: insertedResults.length,
        decisions: verdicts.map((v) => ({ test_code: v.test_code, decision: v.decision, delta_pct: v.delta_pct ?? null })),
      },
      tags: ['lab', 'analyzer', 'interface'],
      timelineIdempotencyKey: `lab_interface_messages:${messageId}:ingested`,
      auditIdempotencyKey: `lab_interface_messages:${messageId}:audit:ingested`,
    });

    return {
      message_id: messageId,
      status: 'ingested',
      protocol,
      specimen_id: specimen.id,
      results: insertedResults.map((r) => ({ id: r.id, test_code: r.test_code })),
      verdicts,
    };
  } catch (err) {
    await prisma.$executeRawUnsafe(
      `UPDATE lab_interface_messages SET status = 'failed', error = $2, processed_at = NOW() WHERE id = $1`,
      messageId, err?.message || String(err),
    ).catch(() => {});
    if (err instanceof AppError) {
      err.details = { ...(err.details || {}), interface_message_id: messageId };
      throw err;
    }
    logger.error('Interface message ingestion failed:', err);
    throw AppError.badRequest('Interface message could not be processed', 'LAB_INTERFACE_INGEST_FAILED', {
      interface_message_id: messageId,
    });
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
