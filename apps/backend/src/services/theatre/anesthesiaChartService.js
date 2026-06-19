// src/services/theatre/anesthesiaChartService.js
//
// Sprint 17 — Anesthesia time-series chart. Companion to migration 116's
// anesthesia_records (which is one row per case); this is the every-5-min
// chart entries the anaesthetist fills during surgery.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

function tenantOr(value) {
  return requireTenantId(String(value || '').trim());
}

// Recompute the case-level anaesthesia_records rollup DETERMINISTICALLY from
// the full set of anesthesia_chart_entries for the case, inside the caller's
// transaction (audit §3 fix #5). The previous implementation incrementally
// added each new entry's fluids/blood-loss/urine onto the accumulator and
// appended drug/event arrays with `||`; because the chart-entry INSERT and the
// accumulator UPDATE were two separate, untransacted statements, a partial
// failure (entry persisted, accumulator not — or vice versa) left the totals
// permanently out of step with the chart, and a re-applied/retried entry could
// double-count. The recompute-from-SUM design that replaced it fixed the
// untransacted drift but introduced a CONCURRENCY lost-update: under READ
// COMMITTED each concurrent recordEntry's SUM() could not see the others'
// still-uncommitted entries, and `DO UPDATE SET total = EXCLUDED.total` then
// overwrote the rollup with that stale sum (last-writer-wins), so concurrent
// inserts silently undercounted the totals.
//
// The correct synthesis is an ATOMIC INCREMENT keyed on the single just-inserted
// entry (entryId), run in the SAME transaction as that entry's INSERT:
//   - Atomicity (insert + increment commit or roll back together) fixes the
//     original untransacted drift.
//   - `DO UPDATE SET total = anesthesia_records.total + EXCLUDED.delta` re-reads
//     the CURRENT committed rollup under the ON CONFLICT row lock — re-evaluated
//     when a concurrent writer commits — and adds only THIS entry's delta, so
//     concurrent inserts can never lose each other's contribution.
//   - It touches ONE row (no serialized SUM over the whole chart), so it stays
//     well inside the Prisma interactive-transaction budget under heavy
//     concurrency (a blocking serialize-the-recompute approach times out).
//   - Each entry increments exactly once; a retry inserts a NEW entry → a new,
//     correct delta, so there is no double-count. Finalized records are untouched.
async function syncCaseAnesthesiaRecord(tx, { tenantId, otScheduleId, entryId }) {
  await tx.$queryRawUnsafe(
    `WITH entry AS (
       SELECT
         COALESCE(e.iv_fluids_ml, 0)::int    AS fluids_in_ml,
         COALESCE(e.blood_loss_ml, 0)::int   AS blood_loss_ml,
         COALESCE(e.urine_output_ml, 0)::int AS urine_output_ml,
         CASE WHEN jsonb_typeof(e.drugs_given) = 'array'
              THEN e.drugs_given ELSE '[]'::jsonb END AS agents_used,
         CASE WHEN e.event_note IS NOT NULL AND TRIM(e.event_note) <> ''
              THEN jsonb_build_array(jsonb_build_object(
                     'note', e.event_note,
                     'recorded_at', e.recorded_at,
                     'recorded_by', e.recorded_by))
              ELSE '[]'::jsonb END AS events
       FROM anesthesia_chart_entries e
       WHERE e.id = $3::int AND e.tenant_id = $1::uuid AND e.ot_schedule_id = $2::int
     )
     INSERT INTO anesthesia_records
       (tenant_id, ot_schedule_id, patient_uid, anesthetist,
        agents_used, fluids_in_ml, blood_loss_ml, urine_output_ml,
        events, status, created_at, updated_at)
     SELECT
       $1::uuid, s.id, s.patient_uid, s.anesthetist,
       entry.agents_used, entry.fluids_in_ml, entry.blood_loss_ml, entry.urine_output_ml,
       entry.events, 'draft', NOW(), NOW()
     FROM ot_schedules s, entry
     WHERE s.id = $2::int
     ON CONFLICT (tenant_id, ot_schedule_id) DO UPDATE SET
       patient_uid = COALESCE(anesthesia_records.patient_uid, EXCLUDED.patient_uid),
       anesthetist = COALESCE(anesthesia_records.anesthetist, EXCLUDED.anesthetist),
       agents_used = anesthesia_records.agents_used || EXCLUDED.agents_used,
       fluids_in_ml = anesthesia_records.fluids_in_ml + EXCLUDED.fluids_in_ml,
       blood_loss_ml = anesthesia_records.blood_loss_ml + EXCLUDED.blood_loss_ml,
       urine_output_ml = anesthesia_records.urine_output_ml + EXCLUDED.urine_output_ml,
       events = anesthesia_records.events || EXCLUDED.events,
       updated_at = NOW()
     WHERE anesthesia_records.status <> 'finalized'`,
    tenantId,
    Number(otScheduleId),
    Number(entryId),
  );
}

export async function recordEntry({
  tenantId, ot_schedule_id, recorded_at,
  hr, sbp, dbp, map: mapValue, spo2, etco2, rr, temp_c,
  vent_mode, fio2_pct, tidal_volume_ml, peep_cmh2o, airway_pressure,
  drugs_given, iv_fluids_ml, blood_loss_ml, urine_output_ml,
  event_note, recorded_by,
  // Top-level shorthand fields the intra-op UI / API clients send when
  // logging a single drug per entry (entry_type='drug' workflow). The
  // anesthesia_chart_entries table stores drugs as a jsonb array, so
  // synthesise the array entry below rather than dropping the fields.
  entry_type, drug_name, dose, route,
}) {
  if (!ot_schedule_id) throw AppError.badRequest('ot_schedule_id is required');
  // Compute MAP if it wasn't supplied but SBP+DBP were.
  let computedMap = mapValue;
  if (computedMap == null && sbp != null && dbp != null) {
    computedMap = Math.round(Number(dbp) + (Number(sbp) - Number(dbp)) / 3);
  }

  // Map the single-drug shorthand into the drugs_given jsonb array.
  // Caller can also pass `drugs_given: [...]` directly; if both are
  // provided, the shorthand entry is appended (consistent with logging
  // a drug given concurrently with vitals on the same chart row).
  const drugsArr = Array.isArray(drugs_given) ? [...drugs_given] : [];
  const hasShorthand =
    (drug_name && String(drug_name).trim() !== '') ||
    (entry_type === 'drug' && (dose || route));
  if (hasShorthand) {
    drugsArr.push({
      name: drug_name ? String(drug_name).trim() : null,
      dose: dose ?? null,
      route: route ?? null,
      time: recorded_at || new Date().toISOString(),
    });
  }
  const entryRecordedAt = recorded_at || new Date().toISOString();
  // Atomic (audit §3 fix #5): the chart-entry INSERT and the case-record
  // rollup recompute run in ONE tenant-scoped transaction. Either both land or
  // neither does, so the anaesthesia_records totals can never drift from the
  // chart entries (e.g. blood-loss/fluid totals undercounting because the
  // accumulator update failed after the entry committed).
  const tid = tenantOr(tenantId);
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
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
      entryRecordedAt,
      hr ?? null, sbp ?? null, dbp ?? null, computedMap ?? null,
      spo2 ?? null, etco2 ?? null, rr ?? null, temp_c ?? null,
      vent_mode || null, fio2_pct ?? null, tidal_volume_ml ?? null,
      peep_cmh2o ?? null, airway_pressure ?? null,
      JSON.stringify(drugsArr),
      iv_fluids_ml ?? null, blood_loss_ml ?? null, urine_output_ml ?? null,
      event_note || null,
      recorded_by ? String(recorded_by) : null,
      tid,
    );
    await syncCaseAnesthesiaRecord(tx, { tenantId: tid, otScheduleId: ot_schedule_id, entryId: rows[0].id });
    return rows[0];
  });
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
