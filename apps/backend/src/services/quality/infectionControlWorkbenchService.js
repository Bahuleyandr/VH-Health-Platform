// src/services/quality/infectionControlWorkbenchService.js
//
// Roadmap D5 — infection-control workbench over data the hospital already
// captures. No new tables: this is the workflow layer on top of the existing
// infection_cases / admissions (ADT) / micro_isolates / micro_sensitivities.
//
//   * isolationBoard  — active infection cases joined to the live admission/
//     bed so the bed board can flag isolation at a glance
//   * traceContacts   — patients who shared a ward with the index patient
//     during the exposure window, derived from ADT admission history
//   * antibiogram     — organism x antibiotic susceptibility matrix plus a
//     resistance-flag summary (MRSA/ESBL/CRE/VRE/XDR) over a period
//
// All three are read-only aggregations; nothing here writes clinical data,
// so there is no canonical-timeline obligation. Every query is explicitly
// tenant-scoped (RLS on infection_cases ships with migration 296 as the
// backstop; explicit predicates keep dev/QA reads honest too).

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

function resolveTenantId(tenantId) {
  return requireTenantId(tenantId);
}

/** Active isolation board: who needs isolation and where they are lying. */
export async function isolationBoard({ ward = null, tenantId = null } = {}) {
  const tid = resolveTenantId(tenantId);
  const params = [tid];
  let wardFilter = '';
  if (ward) {
    params.push(ward);
    wardFilter = `AND a.ward = $${params.length}`;
  }
  return prisma.$queryRawUnsafe(
    `SELECT ic.id AS infection_case_id, ic.patient_uid, u.name AS patient_name,
            ic.organism, ic.infection_site, ic.isolation_required, ic.isolation_type,
            ic.detection_date, ic.status AS case_status,
            a.id AS admission_id, a.ward, a.bed_number, a.status AS admission_status
       FROM infection_cases ic
       JOIN users u ON u.uid = ic.patient_uid
       LEFT JOIN admissions a ON a.patient_uid = ic.patient_uid
            AND a.tenant_id = $1::uuid
            AND COALESCE(a.status, 'admitted') NOT IN ('discharged', 'cancelled')
      WHERE ic.tenant_id = $1::uuid
        AND COALESCE(ic.status, 'active') NOT IN ('resolved', 'closed')
        ${wardFilter}
      ORDER BY ic.isolation_required DESC, ic.detection_date DESC
      LIMIT 200`,
    ...params,
  );
}

/**
 * Contact tracing from ADT history: admissions that overlapped the index
 * patient's stays in the SAME ward inside the exposure window. The index
 * patient's own stays define the ward+time intervals; any other patient whose
 * admission intersects one of those intervals is a ward contact.
 */
export async function traceContacts({ patientUid, from, to, tenantId = null } = {}) {
  if (!patientUid || !from || !to) {
    throw AppError.badRequest('patient_uid, from and to are required', 'IC_TRACE_INPUT');
  }
  const tid = resolveTenantId(tenantId);
  return prisma.$queryRawUnsafe(
    `WITH index_stays AS (
       SELECT ward,
              GREATEST(admitted_at, $2::date::timestamptz) AS s,
              LEAST(COALESCE(discharged_at, NOW()), ($3::date + 1)::timestamptz) AS e
         FROM admissions
        WHERE patient_uid = $1::uuid
          AND tenant_id = $4::uuid
          AND admitted_at < ($3::date + 1)
          AND COALESCE(discharged_at, NOW()) >= $2::date
          AND ward IS NOT NULL
     )
     SELECT DISTINCT ON (a.patient_uid, a.ward)
            a.patient_uid, u.name AS patient_name, a.ward, a.bed_number,
            GREATEST(a.admitted_at, i.s) AS overlap_start,
            LEAST(COALESCE(a.discharged_at, NOW()), i.e) AS overlap_end,
            ROUND((EXTRACT(EPOCH FROM (LEAST(COALESCE(a.discharged_at, NOW()), i.e)
                  - GREATEST(a.admitted_at, i.s))) / 3600)::numeric, 1) AS overlap_hours,
            a.status AS admission_status
       FROM index_stays i
       JOIN admissions a ON a.ward = i.ward
            AND a.tenant_id = $4::uuid
            AND a.admitted_at < i.e
            AND COALESCE(a.discharged_at, NOW()) > i.s
            AND a.patient_uid <> $1::uuid
       JOIN users u ON u.uid = a.patient_uid
      ORDER BY a.patient_uid, a.ward, overlap_hours DESC
      LIMIT 500`,
    patientUid, from, to, tid,
  );
}

/**
 * Antibiogram: % susceptible per organism x antibiotic over the period.
 * Susceptible = result whose first letter is S; intermediate (I) and
 * resistant (R) are counted but excluded from the susceptible tally. The
 * result column is a short code (S/I/R), so we key off its first character.
 * micro_isolates/micro_sensitivities carry no tenant column — scope rides
 * through the owning micro_orders row.
 */
export async function antibiogram({ from, to, minIsolates = 1, tenantId = null } = {}) {
  if (!from || !to) throw AppError.badRequest('from and to are required', 'IC_ABG_PERIOD');
  const tid = resolveTenantId(tenantId);
  const floor = Math.max(Number.parseInt(minIsolates, 10) || 1, 1);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT mi.organism_name,
            ms.antibiotic_name,
            COUNT(*)::int AS tested,
            COUNT(*) FILTER (WHERE UPPER(LEFT(TRIM(ms.result), 1)) = 'S')::int AS susceptible,
            COUNT(*) FILTER (WHERE UPPER(LEFT(TRIM(ms.result), 1)) = 'R')::int AS resistant,
            COUNT(*) FILTER (WHERE UPPER(LEFT(TRIM(ms.result), 1)) = 'I')::int AS intermediate
       FROM micro_sensitivities ms
       JOIN micro_isolates mi ON mi.id = ms.isolate_id
       JOIN micro_orders mo ON mo.id = mi.order_id AND mo.tenant_id = $4::uuid
      WHERE ms.created_at >= $1::date AND ms.created_at < ($2::date + 1)
      GROUP BY mi.organism_name, ms.antibiotic_name
     HAVING COUNT(*) >= $3::int
      ORDER BY mi.organism_name, ms.antibiotic_name`,
    from, to, floor, tid,
  );
  const organisms = {};
  for (const row of rows) {
    const tested = Number(row.tested);
    if (!organisms[row.organism_name]) organisms[row.organism_name] = {};
    organisms[row.organism_name][row.antibiotic_name] = {
      tested,
      susceptible: Number(row.susceptible),
      resistant: Number(row.resistant),
      intermediate: Number(row.intermediate),
      pct_susceptible: tested ? Number(((Number(row.susceptible) / tested) * 100).toFixed(1)) : 0,
    };
  }
  // Resistance-flag summary rides along: phenotype counts over the period.
  const flags = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) FILTER (WHERE mi.is_mrsa)::int AS mrsa,
            COUNT(*) FILTER (WHERE mi.is_esbl)::int AS esbl,
            COUNT(*) FILTER (WHERE mi.is_carbapenemase)::int AS cre,
            COUNT(*) FILTER (WHERE mi.is_vre)::int AS vre,
            COUNT(*) FILTER (WHERE mi.is_xdr)::int AS xdr,
            COUNT(*)::int AS isolates
       FROM micro_isolates mi
       JOIN micro_orders mo ON mo.id = mi.order_id AND mo.tenant_id = $3::uuid
      WHERE mi.created_at >= $1::date AND mi.created_at < ($2::date + 1)`,
    from, to, tid,
  );
  return { period: { from, to }, organisms, resistance_flags: flags[0] || {} };
}

export default { isolationBoard, traceContacts, antibiogram };
