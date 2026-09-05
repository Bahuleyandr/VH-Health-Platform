// src/services/clinical/dialysisMachineService.js
//
// Roadmap D7 — dialysis machine-data ingestion.
//
// Mirrors the C5 monitor-vitals pattern: every raw payload persists to the
// B3 `lab_interface_messages` inbox first (status received → ingested |
// failed, replayable), then observations land through the STANDARD
// `logObservation` path tagged source='device'. Matching is by machine_no
// against the patient's in-progress session — machines don't know patient
// identity, the session board does.
//
// Payload shape (middleware-capable machines POST JSON; serial/proprietary
// transports terminate into a bridge owner-side, as with B3 analyzers):
//   {
//     "machine_no": "FRES-4008-07",
//     "observations": [
//       { "recorded_at": "...", "bp_systolic": 110, "bp_diastolic": 70,
//         "pulse": 78, "blood_flow_ml_min": 300, "uf_rate_ml_hr": 800,
//         "uf_total_ml": 1200, "tmp_mmhg": 120, "venous_pressure": 140,
//         "arterial_pressure": -180, "conductivity_ms_cm": 14.1 }
//     ]
//   }

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { logObservation } from './dialysisService.js';
import { requireTenantId } from '../tenant/tenantService.js';

// Numeric fields a machine may report — anything else is dropped.
const MACHINE_FIELDS = [
  'bp_systolic', 'bp_diastolic', 'pulse', 'spo2', 'temp_c',
  'blood_flow_ml_min', 'uf_rate_ml_hr', 'tmp_mmhg',
  'arterial_pressure', 'venous_pressure', 'conductivity_ms_cm', 'uf_total_ml',
];

async function markInbox(id, { status, error = null, resultCount = null }) {
  await prisma.$queryRawUnsafe(
    `UPDATE lab_interface_messages
     SET status = $2, error = $3, result_count = COALESCE($4, result_count), processed_at = NOW()
     WHERE id = $1`,
    id, status, error, resultCount,
  ).catch((err) => logger.warn('dialysis inbox update failed', { id, error: err.message }));
}

export async function ingestMachineObservations({ payload, machineCode = null, tenantId = null }, context = {}) {
  if (!payload || typeof payload !== 'object') {
    throw AppError.badRequest('JSON payload required', 'DIALYSIS_MACHINE_PAYLOAD_REQUIRED');
  }
  const machineNo = String(machineCode || payload.machine_no || '').trim();

  // Resolve ONCE, so the inbox row and the session match cannot disagree about
  // which tenant this ingestion belongs to.
  const resolvedTenantId = requireTenantId(tenantId);

  // 1. Persist the raw payload FIRST — failures stay visible + replayable.
  const inserted = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_interface_messages
       (tenant_id, analyzer_code, direction, protocol, message_type, raw_message, status)
     VALUES ($1::uuid, $2, 'inbound', 'other', 'OBX^DIALYSIS', $3, 'received')
     RETURNING id`,
    resolvedTenantId,
    machineNo || 'unknown-machine',
    JSON.stringify(payload),
  );
  const inboxId = inserted[0].id;

  try {
    if (!machineNo) {
      throw AppError.badRequest('machine_no is required (payload or device code)', 'DIALYSIS_MACHINE_NO_REQUIRED');
    }
    const observations = Array.isArray(payload.observations) ? payload.observations : [];
    if (!observations.length) {
      throw AppError.badRequest('observations[] is required and must be non-empty', 'DIALYSIS_MACHINE_OBS_REQUIRED');
    }

    // 2. Match the machine to its in-progress session (latest wins).
    //
    // The tenant predicate is LOAD-BEARING, not belt-and-braces. This runs on a
    // plain `prisma` client with no transaction-local app.current_tenant_id, and
    // dialysis_sessions carries only the PERMISSIVE tenant_isolation policy,
    // which explicitly permits every row when that GUC is unset. Without the
    // predicate a machine_no reused across tenants — a device code, not a
    // globally unique key — matches another tenant's in-progress session and the
    // observations land on THEIR patient. Proven against the live schema as the
    // vhhealth_app runtime role. Do not remove it expecting RLS to backstop.
    const sessRows = await prisma.$queryRawUnsafe(
      `SELECT id, dialysis_patient_id FROM dialysis_sessions
       WHERE machine_no = $1 AND status = 'in_progress'
         AND tenant_id = $2::uuid
       ORDER BY actual_start_at DESC NULLS LAST
       LIMIT 1`,
      machineNo,
      resolvedTenantId,
    );
    if (!sessRows.length) {
      throw AppError.notFound(
        `No in-progress dialysis session on machine ${machineNo}`,
        'DIALYSIS_MACHINE_SESSION_NOT_FOUND',
      );
    }
    const session = sessRows[0];

    // 3. Land each observation through the standard path, tagged device.
    const rows = [];
    for (const obs of observations) {
      const cleaned = {};
      for (const field of MACHINE_FIELDS) {
        const value = obs?.[field];
        if (value !== undefined && value !== null && Number.isFinite(Number(value))) {
          cleaned[field] = Number(value);
        }
      }
      if (!Object.keys(cleaned).length) continue;
      const row = await logObservation({
        // logObservation re-checks the session INSIDE the tenant via
        // getDialysisSessionInTenant. Omitting tenantId here handed it
        // `undefined`, which requireTenantId resolves to DEFAULT_TENANT_ID while
        // ALLOW_DEFAULT_TENANT=true and THROWS 403 once that flips false at the
        // multi-tenant cutover — i.e. today it can write to the default tenant's
        // session, and after the cutover machine ingestion stops working
        // entirely. Pass the resolved tenant so neither happens.
        tenantId: resolvedTenantId,
        session_id: session.id,
        recorded_by: context.actorUid || null,
        recorded_at: obs?.recorded_at || null,
        source: 'device',
        source_device: machineNo,
        ...cleaned,
      });
      rows.push(row);
    }
    if (!rows.length) {
      throw AppError.badRequest('No usable numeric observations in payload', 'DIALYSIS_MACHINE_OBS_EMPTY');
    }

    await markInbox(inboxId, { status: 'ingested', resultCount: rows.length });
    logger.info('Dialysis machine observations ingested', {
      machineNo, sessionId: session.id, count: rows.length, inboxId,
    });
    return {
      interface_message_id: inboxId,
      session_id: session.id,
      ingested: rows.length,
      observations: rows,
    };
  } catch (err) {
    await markInbox(inboxId, {
      status: 'failed',
      error: String(err.message).slice(0, 500),
    });
    throw err;
  }
}

export default { ingestMachineObservations };
