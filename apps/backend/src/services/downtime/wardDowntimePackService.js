// src/services/downtime/wardDowntimePackService.js
//
// Roadmap A3 — downtime mode (Epic "BCA" equivalent).
//
// Every N minutes the scheduler regenerates a per-ward "downtime pack":
// the minimum chart a ward can safely run on for a few hours when the
// backend / network is down — census per occupied bed with allergies
// (unified four-store read), code status, attending, chief complaint,
// active orders, the MAR due-list for the next window, and latest vitals.
// Each pack is stored as JSON + a fully self-contained printable HTML
// document in downtime_snapshots (scope 'ward_pack'), so the ops procedure
// is simply: open/print the latest pack per ward (see
// docs/DOWNTIME_PROCEDURE.md). Generation must never take the app down —
// every per-ward failure is logged and skipped.

import fs from 'fs/promises';
import path from 'path';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { getUnifiedActiveAllergies } from '../clinical/allergySourceService.js';
import { getDowntimeMirrorDir } from '../../config/downtimeConfig.js';

export const WARD_PACK_SCOPE = 'ward_pack';
const MAR_WINDOW_HOURS = 12;
const PACK_EXPIRY_HOURS = 24;
const ACTIVE_ADMISSION_STATUSES = ['admitted', 'transferred', 'discharge_pending'];
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

function tenantOr(value) {
  return value || DEFAULT_TENANT_ID;
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

/**
 * Render a ward pack payload as a fully self-contained printable HTML
 * document (inline CSS, zero scripts, zero external assets — it must render
 * from a file:// open on a ward PC). Pure; exported for unit tests.
 */
export function buildWardPackHtml(pack) {
  const beds = (pack.beds || []).map((bed) => {
    const allergies = (bed.allergies || []).length
      ? bed.allergies.map((a) => `${esc(a.allergen)}${a.severity ? ` (${esc(a.severity)})` : ''}`).join('; ')
      : 'NKDA / none recorded';
    const meds = (bed.mar_due || []).map((m) =>
      `<tr><td>${fmtTime(m.scheduled_time)}</td><td>${esc(m.medication_name)}</td>` +
      `<td>${esc(m.dose || m.dosage || '')}</td><td>${esc(m.route || '')}</td><td>${esc(m.status || '')}</td></tr>`).join('')
      || '<tr><td colspan="5">No doses scheduled in window</td></tr>';
    const orders = (bed.active_orders || []).map((o) =>
      `<tr><td>${esc(o.order_type)}</td><td>${esc(o.summary)}</td><td>${esc(o.priority || '')}</td><td>${esc(o.status || '')}</td></tr>`).join('')
      || '<tr><td colspan="4">No active orders</td></tr>';
    const v = bed.latest_vitals || null;
    const vitals = v
      ? `BP ${esc(v.bp ?? '—')} · HR ${esc(v.heart_rate ?? '—')} · RR ${esc(v.respiratory_rate ?? '—')} · ` +
        `SpO₂ ${esc(v.spo2 ?? '—')} · T ${esc(v.temperature ?? '—')} · NEWS2 ${esc(v.news2 ?? '—')} (${fmtTime(v.recorded_at)})`
      : 'No vitals recorded';
    return `
  <section class="bed">
    <h3>Bed ${esc(bed.bed_number)} — ${esc(bed.patient_name || 'Unknown')}
      <span class="meta">${esc(bed.age != null ? bed.age + 'y' : '')} ${esc(bed.gender || '')} · MRN/UID ${esc(bed.patient_uid || '')}</span></h3>
    <p><strong class="${(bed.code_status || 'full_code') === 'full_code' ? 'ok' : 'alert'}">Code: ${esc(bed.code_status || 'full_code')}</strong>
       · Attending: ${esc(bed.attending_name || '—')}
       · Dx: ${esc(bed.admitting_diagnosis || bed.chief_complaint || '—')}</p>
    <p class="allergies"><strong>ALLERGIES:</strong> ${allergies}</p>
    <p class="vitals">${vitals}</p>
    <h4>Medications due (next ${MAR_WINDOW_HOURS}h)</h4>
    <table><thead><tr><th>Due</th><th>Medication</th><th>Dose</th><th>Route</th><th>Status</th></tr></thead><tbody>${meds}</tbody></table>
    <h4>Active orders</h4>
    <table><thead><tr><th>Type</th><th>Detail</th><th>Priority</th><th>Status</th></tr></thead><tbody>${orders}</tbody></table>
  </section>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Downtime pack — ${esc(pack.ward_name)} — ${fmtTime(pack.generated_at)}</title>
<style>
  body{font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;margin:24px;color:#111}
  h1{font-size:20px;margin:0 0 2px} .sub{color:#555;margin:0 0 18px}
  h3{margin:0 0 4px;border-top:2px solid #111;padding-top:10px}
  h3 .meta{font-weight:normal;font-size:12px;color:#555}
  h4{margin:10px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  table{border-collapse:collapse;width:100%;margin-bottom:6px}
  th,td{border:1px solid #999;padding:3px 6px;text-align:left;font-size:12px}
  th{background:#eee}
  .allergies{background:#fff3cd;border:1px solid #d9a40e;padding:4px 8px}
  .alert{color:#b00020}.ok{color:#0a7a2f}
  .bed{page-break-inside:avoid;margin-bottom:14px}
  @media print {.bed{page-break-inside:avoid}}
</style></head><body>
<h1>DOWNTIME PACK — ${esc(pack.ward_name)}</h1>
<p class="sub">Generated ${fmtTime(pack.generated_at)} · ${pack.beds?.length || 0} occupied bed(s) ·
  Valid as a read-only reference only — record all care on paper downtime forms and
  back-enter after recovery (docs/DOWNTIME_PROCEDURE.md).</p>
${beds || '<p>No occupied beds at generation time.</p>'}
</body></html>`;
}

/**
 * Render the static-mirror index: a zero-script, self-contained list of the
 * wards whose packs were written this pass, linking to each ward-<id>.html.
 * Served by the DB-free static route's `GET /`. Pure; exported for tests.
 *
 * @param {Array<{ward_id:(number|string), ward_name:string, beds:number}>} wards
 */
export function buildMirrorIndexHtml(wards = []) {
  const rows = (wards || []).map((w) =>
    `<li><a href="wards/${esc(w.ward_id)}">Ward ${esc(w.ward_id)} — ${esc(w.ward_name || '')}</a>` +
    ` <span class="meta">(${Number(w.beds) || 0} occupied bed(s))</span></li>`).join('\n');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Downtime ward packs — index</title>
<style>
  body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:24px;color:#111}
  h1{font-size:20px;margin:0 0 4px} .sub{color:#555;margin:0 0 16px}
  ul{padding-left:20px} li{margin:4px 0} .meta{color:#555;font-size:12px}
</style></head><body>
<h1>DOWNTIME WARD PACKS</h1>
<p class="sub">Static read-only mirror · refreshed ${fmtTime(new Date().toISOString())} ·
  Record all care on paper downtime forms and back-enter after recovery
  (docs/DOWNTIME_PROCEDURE.md).</p>
${rows ? `<ul>\n${rows}\n</ul>` : '<p>No ward packs available in this mirror yet.</p>'}
</body></html>`;
}

/**
 * Best-effort: write one ward's self-contained HTML to the mirror dir as
 * ward-<wardId>.html. A failure here (read-only FS, permissions, disk full)
 * must NEVER break pack generation or the surrounding transaction — it is
 * logged and swallowed. The dir is created with { recursive: true } first.
 */
async function writeWardPackToMirror(mirrorDir, wardId, html) {
  try {
    await fs.mkdir(mirrorDir, { recursive: true });
    await fs.writeFile(path.join(mirrorDir, `ward-${wardId}.html`), html, 'utf8');
    return true;
  } catch (err) {
    logger.warn('Downtime mirror: failed to write ward pack file (pack generation unaffected)', {
      ward_id: wardId,
      mirror_dir: mirrorDir,
      error: err?.message,
    });
    return false;
  }
}

/** Best-effort: write/refresh the mirror index.html. Never throws. */
async function writeMirrorIndex(mirrorDir, wards) {
  try {
    await fs.mkdir(mirrorDir, { recursive: true });
    await fs.writeFile(path.join(mirrorDir, 'index.html'), buildMirrorIndexHtml(wards), 'utf8');
    return true;
  } catch (err) {
    logger.warn('Downtime mirror: failed to write index.html (pack generation unaffected)', {
      mirror_dir: mirrorDir,
      error: err?.message,
    });
    return false;
  }
}

async function collectBedEntry(bed, { tenantId } = {}) {
  const tid = tenantOr(tenantId);
  const patientUid = bed.patient_uid || null;

  const [patientRows, marRows, orderRows, vitalsRows] = await Promise.all([
    patientUid
      ? prisma.$queryRawUnsafe(
        `SELECT u.uid, u.name, u.gender,
                date_part('year', age(u.birthday))::int AS age,
                a.code_status, a.chief_complaint, a.admitting_diagnosis,
                att.name AS attending_name
           FROM users u
           LEFT JOIN LATERAL (
             SELECT * FROM admissions a2
              WHERE a2.patient_uid = u.uid
                AND a2.tenant_id = $2::uuid
                AND COALESCE(a2.status, 'admitted') = ANY($3::text[])
              ORDER BY a2.created_at DESC LIMIT 1
           ) a ON TRUE
           LEFT JOIN users att ON att.uid = a.attending_doctor AND att.tenant_id = $2::uuid
          WHERE u.uid = $1::uuid
            AND u.tenant_id = $2::uuid`,
        patientUid, tid, ACTIVE_ADMISSION_STATUSES,
      )
      : Promise.resolve([]),
    patientUid
      ? prisma.$queryRawUnsafe(
        `SELECT medication_name, dose, dosage, route, scheduled_time, status
           FROM medication_administrations
          WHERE patient_uid = $1::uuid
            AND tenant_id = $2::uuid
            AND COALESCE(status, 'scheduled') IN ('scheduled', 'due', 'held')
            AND scheduled_time BETWEEN NOW() - INTERVAL '1 hour'
                                   AND NOW() + ($3::int * INTERVAL '1 hour')
          ORDER BY scheduled_time ASC
          LIMIT 60`,
        patientUid, tid, MAR_WINDOW_HOURS,
      )
      : Promise.resolve([]),
    patientUid
      ? prisma.$queryRawUnsafe(
        `SELECT order_type, priority, status,
                COALESCE(details->>'summary', details->>'name', details->>'medication_name',
                         details->>'test_name', order_number) AS summary
           FROM clinical_orders
          WHERE patient_uid = $1::uuid
            AND tenant_id = $2::uuid
            AND COALESCE(status, 'ordered') IN ('ordered', 'verified', 'in_progress', 'active')
          ORDER BY created_at DESC
          LIMIT 40`,
        patientUid, tid,
      )
      : Promise.resolve([]),
    patientUid
      ? prisma.$queryRawUnsafe(
        `SELECT (systolic_bp::text || '/' || diastolic_bp::text) AS bp,
                heart_rate, respiratory_rate, spo2,
                temperature, recorded_at,
                (SELECT n.total_score FROM news2_scores n
                  WHERE n.patient_uid = vc.patient_uid
                    AND n.tenant_id = vc.tenant_id
                  ORDER BY n.created_at DESC LIMIT 1) AS news2
           FROM vitals_chart vc
          WHERE vc.patient_uid = $1::uuid
            AND vc.tenant_id = $2::uuid
          ORDER BY vc.recorded_at DESC NULLS LAST
          LIMIT 1`,
        patientUid, tid,
      )
      : Promise.resolve([]),
  ]);

  const patient = patientRows[0] || {};
  const allergies = patientUid
    ? await getUnifiedActiveAllergies(prisma, { patientUid })
    : [];

  return {
    bed_number: bed.bed_number,
    patient_uid: patientUid,
    patient_name: patient.name || bed.patient_name || null,
    age: patient.age ?? null,
    gender: patient.gender || null,
    code_status: patient.code_status || null,
    attending_name: patient.attending_name || null,
    chief_complaint: patient.chief_complaint || null,
    admitting_diagnosis: patient.admitting_diagnosis || null,
    allergies,
    mar_due: marRows,
    active_orders: orderRows,
    latest_vitals: vitalsRows[0] || null,
  };
}

/**
 * Generate (and persist) one downtime pack per ward that currently has
 * occupied beds. Returns summaries of the packs written. Per-ward failures
 * are logged and skipped — generation never throws.
 */
export async function generateWardDowntimePacks({ tenantId, generatedBy = null } = {}) {
  const tid = tenantOr(tenantId);
  let wards;
  try {
    wards = await prisma.$queryRawUnsafe(
      `SELECT w.id, w.name, b.tenant_id,
              COALESCE(json_agg(json_build_object(
                'bed_number', b.bed_number,
                'patient_uid', b.patient_uid,
                'patient_name', b.patient_name
              ) ORDER BY b.bed_number) FILTER (WHERE b.id IS NOT NULL), '[]'::json) AS beds
         FROM wards w
         JOIN beds b ON b.ward_id = w.id
        WHERE LOWER(COALESCE(b.status, '')) = 'occupied'
          AND b.patient_uid IS NOT NULL
          AND b.tenant_id = $1::uuid
        GROUP BY w.id, w.name, b.tenant_id
        ORDER BY w.id`,
      tid,
    );
  } catch (err) {
    logger.error('Ward downtime pack sweep failed at census query', { error: err.message });
    return [];
  }

  // WS2 / REL-5: mirror each pack's self-contained HTML to a static dir so the
  // DB-free downtime route can serve it (and an ops-box can LAN-sync it) when
  // the backend/DB is down. All mirror I/O is best-effort and self-contained in
  // its helper — a write failure logs a warning and NEVER breaks generation.
  const mirrorDir = getDowntimeMirrorDir();
  const results = [];
  for (const ward of wards) {
    try {
      const bedsRaw = Array.isArray(ward.beds) ? ward.beds : JSON.parse(ward.beds || '[]');
      const beds = [];
      for (const bed of bedsRaw) {
        // Sequential on purpose: bounded load on the primary during the sweep.
        beds.push(await collectBedEntry(bed, { tenantId: tid }));
      }
      const pack = {
        scope: WARD_PACK_SCOPE,
        tenant_id: tid,
        ward_id: ward.id,
        ward_name: ward.name,
        generated_at: new Date().toISOString(),
        mar_window_hours: MAR_WINDOW_HOURS,
        beds,
      };
      pack.html = buildWardPackHtml(pack);

      const row = await prisma.downtime_snapshots.create({
        data: {
          ward_id: ward.id,
          label: `Ward pack — ${ward.name}`,
          scope: WARD_PACK_SCOPE,
          tenant_id: tid,
          generated_by: generatedBy,
          payload: pack,
          expires_at: new Date(Date.now() + PACK_EXPIRY_HOURS * 3600 * 1000),
        },
        select: { id: true, ward_id: true, created_at: true },
      });
      results.push({ snapshot_id: row.id, ward_id: ward.id, ward_name: ward.name, beds: beds.length });

      // Best-effort static-mirror write (never throws — see helper).
      await writeWardPackToMirror(mirrorDir, ward.id, pack.html);
    } catch (err) {
      logger.error('Ward downtime pack generation failed for ward — skipped', {
        ward_id: ward.id,
        ward_name: ward.name,
        error: err.message,
      });
    }
  }

  // Refresh the mirror index listing every ward written this pass (best-effort).
  if (results.length) {
    await writeMirrorIndex(mirrorDir, results);
  }

  // Retention: drop expired ward packs so the table can't grow unbounded.
  try {
    await prisma.$executeRawUnsafe(
      `DELETE FROM downtime_snapshots
        WHERE scope = $1 AND tenant_id = $2::uuid
          AND expires_at IS NOT NULL AND expires_at < NOW() - INTERVAL '24 hours'`,
      WARD_PACK_SCOPE, tid,
    );
  } catch (err) {
    logger.warn('Ward downtime pack retention sweep failed', { error: err.message });
  }

  if (results.length) {
    logger.info(`Ward downtime packs regenerated for ${results.length} ward(s)`);
  }
  return results;
}

/** Latest pack metadata for every ward that has one. */
export async function listLatestWardPacks({ tenantId } = {}) {
  return prisma.$queryRawUnsafe(
    `SELECT DISTINCT ON (ward_id)
            id AS snapshot_id, ward_id, label, created_at, expires_at,
            jsonb_array_length(COALESCE(payload->'beds', '[]'::jsonb)) AS bed_count
       FROM downtime_snapshots
      WHERE scope = $1 AND tenant_id = $2::uuid AND ward_id IS NOT NULL
      ORDER BY ward_id, created_at DESC`,
    WARD_PACK_SCOPE, tenantOr(tenantId),
  );
}

/** Latest pack (full payload) for one ward, or null. */
export async function getLatestWardPack(wardId, { tenantId } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id AS snapshot_id, ward_id, label, payload, created_at, expires_at
       FROM downtime_snapshots
      WHERE scope = $1 AND tenant_id = $2::uuid AND ward_id = $3::int
      ORDER BY created_at DESC
      LIMIT 1`,
    WARD_PACK_SCOPE, tenantOr(tenantId), wardId,
  );
  return rows[0] || null;
}

export default {
  generateWardDowntimePacks,
  listLatestWardPacks,
  getLatestWardPack,
  buildWardPackHtml,
  buildMirrorIndexHtml,
  WARD_PACK_SCOPE,
};
