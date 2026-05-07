// src/services/theatre/anesthesiaChartService.js
//
// Sprint 17 — Anesthesia time-series chart. Companion to migration 116's
// anesthesia_records (which is one row per case); this is the every-5-min
// chart entries the anaesthetist fills during surgery.

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';

export async function recordEntry({
  tenantId, ot_schedule_id, recorded_at,
  hr, sbp, dbp, map: mapValue, spo2, etco2, rr, temp_c,
  vent_mode, fio2_pct, tidal_volume_ml, peep_cmh2o, airway_pressure,
  drugs_given, iv_fluids_ml, blood_loss_ml, urine_output_ml,
  event_note, recorded_by,
}) {
  if (!ot_schedule_id) throw AppError.badRequest('ot_schedule_id is required');
  // Compute MAP if it wasn't supplied but SBP+DBP were.
  let computedMap = mapValue;
  if (computedMap == null && sbp != null && dbp != null) {
    computedMap = Math.round(Number(dbp) + (Number(sbp) - Number(dbp)) / 3);
  }
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO anesthesia_chart_entries
       (ot_schedule_id, recorded_at, hr, sbp, dbp, map, spo2, etco2, rr, temp_c,
        vent_mode, fio2_pct, tidal_volume_ml, peep_cmh2o, airway_pressure,
        drugs_given, iv_fluids_ml, blood_loss_ml, urine_output_ml,
        event_note, recorded_by, tenant_id)
     VALUES ($1::int, $2::timestamptz, $3::int, $4::int, $5::int, $6::int,
             $7::int, $8::int, $9::int, $10::numeric,
             $11, $12::int, $13::int, $14::numeric, $15::int,
             $16::jsonb, $17::int, $18::int, $19::int,
             $20, $21::uuid, $22::uuid)
     RETURNING *`,
    Number(ot_schedule_id),
    recorded_at || new Date().toISOString(),
    hr ?? null, sbp ?? null, dbp ?? null, computedMap ?? null,
    spo2 ?? null, etco2 ?? null, rr ?? null, temp_c ?? null,
    vent_mode || null, fio2_pct ?? null, tidal_volume_ml ?? null,
    peep_cmh2o ?? null, airway_pressure ?? null,
    JSON.stringify(drugs_given ?? []),
    iv_fluids_ml ?? null, blood_loss_ml ?? null, urine_output_ml ?? null,
    event_note || null,
    recorded_by ? String(recorded_by) : null,
    tenantId,
  );
  return rows[0];
}

export async function listForCase({ tenantId, ot_schedule_id }) {
  return prisma.$queryRawUnsafe(
    `SELECT id, recorded_at, hr, sbp, dbp, map, spo2, etco2, rr, temp_c,
            vent_mode, fio2_pct, tidal_volume_ml, peep_cmh2o, airway_pressure,
            drugs_given, iv_fluids_ml, blood_loss_ml, urine_output_ml,
            event_note
       FROM anesthesia_chart_entries
      WHERE tenant_id = $1::uuid AND ot_schedule_id = $2::int
      ORDER BY recorded_at`,
    tenantId, Number(ot_schedule_id),
  );
}

// Roll up totals for the post-op summary block.
export async function totalsForCase({ tenantId, ot_schedule_id }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT
       COUNT(*)::int AS entries,
       MIN(recorded_at) AS started,
       MAX(recorded_at) AS ended,
       COALESCE(SUM(iv_fluids_ml), 0)::int AS total_iv_fluids_ml,
       COALESCE(SUM(blood_loss_ml), 0)::int AS total_blood_loss_ml,
       COALESCE(SUM(urine_output_ml), 0)::int AS total_urine_output_ml,
       MIN(map) AS min_map,
       MAX(map) AS max_map,
       MIN(spo2) AS min_spo2,
       MAX(hr) AS max_hr,
       MIN(hr) AS min_hr
     FROM anesthesia_chart_entries
     WHERE tenant_id = $1::uuid AND ot_schedule_id = $2::int`,
    tenantId, Number(ot_schedule_id),
  );
  return rows[0] || {};
}
