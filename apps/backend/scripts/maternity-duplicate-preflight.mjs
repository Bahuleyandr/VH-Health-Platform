#!/usr/bin/env node
// M-F F0 — deterministic, read-only, all-tenant maternity duplicate preflight.
//
// This script reports candidates for human review. It never selects a survivor,
// makes a clinical decision, or writes data. The operational path deliberately
// has no tenant-filtered mode: clearing the F0 gate requires a cross-tenant scan.
//
// Safety requirements:
//   * DATABASE_READ_URL must be configured (no primary-client fallback).
//   * the operator must pass --ack-all-tenant-read-only;
//   * the established super-admin RLS bypass is used for the cross-tenant read;
//   * transaction_read_only must be ON before any report query is issued.

import { pathToFileURL } from 'node:url';

export const ACKNOWLEDGEMENT_FLAG = '--ack-all-tenant-read-only';
export const EXACT_RETRY_WINDOW_SECONDS = 600;
export const EPISODE_SEPARATION_DAYS = 294;
export const PARTOGRAPH_WINDOW_SECONDS = 120;
export const POSTNATAL_WINDOW_SECONDS = 600;

export const SECTION_KEYS = Object.freeze([
  'duplicate_ongoing_pregnancies',
  'multiple_active_labour_admissions',
  'multiple_deliveries_per_pregnancy',
  'duplicate_newborn_slots',
  'invalid_supplement_date_ranges',
  'overlapping_supplement_courses',
  'partograph_near_duplicate_candidates',
  'postnatal_near_duplicate_candidates'
]);

export const READ_ONLY_CHECK_QUERY = `
  SELECT current_setting('transaction_read_only') AS transaction_read_only
`;

export const TENANT_INVENTORY_QUERY = `
  SELECT id AS tenant_id
    FROM tenants
   ORDER BY id
`;

export const REPORT_QUERIES = Object.freeze({
  duplicate_ongoing_pregnancies: `
    WITH duplicate_groups AS (
      SELECT tenant_id, patient_uid
        FROM maternity_pregnancies
       WHERE status = 'ongoing'
       GROUP BY tenant_id, patient_uid
      HAVING COUNT(*) > 1
    ),
    candidate_rows AS (
      SELECT
        p.tenant_id,
        p.patient_uid,
        p.id,
        p.pregnancy_number,
        p.lmp_date::text AS lmp_date,
        p.edd_date::text AS edd_date,
        p.gravida,
        p.parity,
        p.living_children,
        p.abortions,
        p.booking_status,
        p.high_risk,
        p.created_at,
        p.created_by,
        (
          SELECT COUNT(*)::int
            FROM maternity_anc_visits v
           WHERE v.tenant_id = p.tenant_id
             AND v.pregnancy_id = p.id
        ) AS anc_visit_count,
        (
          SELECT MAX(v.visit_date)::text
            FROM maternity_anc_visits v
           WHERE v.tenant_id = p.tenant_id
             AND v.pregnancy_id = p.id
        ) AS latest_anc_visit_date,
        (
          SELECT COUNT(*)::int
            FROM maternity_labor_admissions l
           WHERE l.tenant_id = p.tenant_id
             AND l.pregnancy_id = p.id
        ) AS labour_admission_count,
        (
          SELECT COUNT(*)::int
            FROM maternity_deliveries d
           WHERE d.tenant_id = p.tenant_id
             AND d.pregnancy_id = p.id
        ) AS delivery_count,
        (
          SELECT COUNT(*)::int
            FROM maternity_supplements s
           WHERE s.tenant_id = p.tenant_id
             AND s.pregnancy_id = p.id
        ) AS supplement_count,
        (
          SELECT COUNT(*)::int
            FROM maternity_fetal_kicks k
           WHERE k.tenant_id = p.tenant_id
             AND k.pregnancy_id = p.id
        ) AS fetal_kick_count
      FROM maternity_pregnancies p
      JOIN duplicate_groups g
        ON g.tenant_id = p.tenant_id
       AND g.patient_uid = p.patient_uid
     WHERE p.status = 'ongoing'
    )
    SELECT
      tenant_id,
      patient_uid,
      COUNT(*)::int AS ongoing_count,
      JSONB_AGG(
        JSONB_BUILD_OBJECT(
          'id', id,
          'pregnancy_number', pregnancy_number,
          'lmp_date', lmp_date,
          'edd_date', edd_date,
          'gravida', gravida,
          'parity', parity,
          'living_children', living_children,
          'abortions', abortions,
          'booking_status', booking_status,
          'high_risk', high_risk,
          'created_at', created_at,
          'created_by', created_by,
          'anc_visit_count', anc_visit_count,
          'latest_anc_visit_date', latest_anc_visit_date,
          'labour_admission_count', labour_admission_count,
          'delivery_count', delivery_count,
          'supplement_count', supplement_count,
          'fetal_kick_count', fetal_kick_count
        ) ORDER BY created_at, id
      ) AS candidates
    FROM candidate_rows
    GROUP BY tenant_id, patient_uid
    ORDER BY tenant_id, patient_uid
  `,

  multiple_active_labour_admissions: `
    SELECT
      tenant_id,
      pregnancy_id,
      COUNT(*)::int AS active_count,
      ARRAY_AGG(id ORDER BY admitted_at, id) AS labour_admission_ids,
      ARRAY_AGG(admitted_at ORDER BY admitted_at, id) AS admitted_ats
    FROM maternity_labor_admissions
    WHERE status = 'active'
    GROUP BY tenant_id, pregnancy_id
    HAVING COUNT(*) > 1
    ORDER BY tenant_id, pregnancy_id
  `,

  multiple_deliveries_per_pregnancy: `
    SELECT
      tenant_id,
      pregnancy_id,
      COUNT(*)::int AS delivery_count,
      ARRAY_AGG(id ORDER BY delivery_datetime, id) AS delivery_ids,
      ARRAY_AGG(delivery_datetime ORDER BY delivery_datetime, id) AS delivery_datetimes
    FROM maternity_deliveries
    GROUP BY tenant_id, pregnancy_id
    HAVING COUNT(*) > 1
    ORDER BY tenant_id, pregnancy_id
  `,

  duplicate_newborn_slots: `
    SELECT
      tenant_id,
      delivery_id,
      birth_order,
      COUNT(*)::int AS newborn_count,
      ARRAY_AGG(id ORDER BY created_at, id) AS newborn_ids,
      ARRAY_AGG(birth_datetime ORDER BY created_at, id) AS birth_datetimes
    FROM maternity_newborns
    GROUP BY tenant_id, delivery_id, birth_order
    HAVING COUNT(*) > 1
    ORDER BY tenant_id, delivery_id, birth_order
  `,

  invalid_supplement_date_ranges: `
    SELECT
      tenant_id,
      pregnancy_id,
      id AS supplement_course_id,
      supplement,
      start_date::text AS start_date,
      end_date::text AS end_date
    FROM maternity_supplements
    WHERE end_date IS NOT NULL
      AND end_date < start_date
    ORDER BY tenant_id, pregnancy_id, supplement, start_date, id
  `,

  overlapping_supplement_courses: `
    SELECT
      a.tenant_id,
      a.pregnancy_id,
      a.supplement,
      a.id AS earlier_course_id,
      b.id AS later_course_id,
      a.start_date::text AS earlier_start_date,
      a.end_date::text AS earlier_end_date,
      b.start_date::text AS later_start_date,
      b.end_date::text AS later_end_date
    FROM maternity_supplements a
    JOIN maternity_supplements b
      ON b.tenant_id = a.tenant_id
     AND b.pregnancy_id = a.pregnancy_id
     AND b.supplement = a.supplement
     AND b.id > a.id
     AND (a.end_date IS NULL OR a.end_date >= a.start_date)
     AND (b.end_date IS NULL OR b.end_date >= b.start_date)
     AND DATERANGE(
           a.start_date,
           COALESCE(a.end_date, 'infinity'::date),
           '[]'
         ) && DATERANGE(
           b.start_date,
           COALESCE(b.end_date, 'infinity'::date),
           '[]'
         )
    ORDER BY a.tenant_id, a.pregnancy_id, a.supplement,
             a.start_date, a.id, b.start_date, b.id
  `,

  partograph_near_duplicate_candidates: `
    WITH payloads AS (
      SELECT
        id,
        tenant_id,
        labor_admission_id,
        recorded_at,
        recorded_by,
        JSONB_BUILD_ARRAY(
          bp_systolic,
          bp_diastolic,
          pulse_bpm,
          temperature_c,
          urine_output_ml,
          urine_protein,
          urine_acetone,
          cervix_dilation_cm,
          descent_fifths_above_brim,
          contractions_per_10min,
          contractions_duration_sec,
          contractions_intensity,
          fetal_heart_rate_bpm,
          fetal_decel,
          amniotic_fluid,
          moulding,
          oxytocin_units_l,
          oxytocin_drops_min,
          drugs_given,
          iv_fluids,
          on_alert_line,
          on_action_line,
          notes
        ) AS clinical_payload
      FROM maternity_partograph_entries
    )
    SELECT
      a.tenant_id,
      a.labor_admission_id,
      a.id AS earlier_entry_id,
      b.id AS later_entry_id,
      a.recorded_at AS earlier_recorded_at,
      b.recorded_at AS later_recorded_at,
      EXTRACT(EPOCH FROM (b.recorded_at - a.recorded_at))::int AS gap_seconds,
      (a.recorded_by IS NOT DISTINCT FROM b.recorded_by) AS same_author
    FROM payloads a
    JOIN payloads b
      ON b.tenant_id = a.tenant_id
     AND b.labor_admission_id = a.labor_admission_id
     AND b.id > a.id
     AND b.recorded_at >= a.recorded_at
     AND b.recorded_at < a.recorded_at + INTERVAL '120 seconds'
     AND b.clinical_payload = a.clinical_payload
    ORDER BY a.tenant_id, a.labor_admission_id,
             a.recorded_at, a.id, b.id
  `,

  postnatal_near_duplicate_candidates: `
    WITH payloads AS (
      SELECT
        id,
        tenant_id,
        delivery_id,
        visit_kind,
        newborn_id,
        visit_at,
        recorded_by,
        JSONB_BUILD_ARRAY(
          mother_temp_c,
          mother_pulse_bpm,
          mother_bp_systolic,
          mother_bp_diastolic,
          uterine_involution,
          lochia,
          perineum_status,
          breastfeeding_status,
          baby_weight_g,
          baby_temperature_c,
          baby_feeding,
          baby_jaundice,
          baby_passed_meconium,
          baby_passed_urine,
          baby_cord_status,
          red_flags,
          notes
        ) AS clinical_payload
      FROM maternity_postnatal_visits
    )
    SELECT
      a.tenant_id,
      a.delivery_id,
      a.visit_kind,
      a.newborn_id,
      a.id AS earlier_visit_id,
      b.id AS later_visit_id,
      a.visit_at AS earlier_visit_at,
      b.visit_at AS later_visit_at,
      EXTRACT(EPOCH FROM (b.visit_at - a.visit_at))::int AS gap_seconds,
      (a.recorded_by IS NOT DISTINCT FROM b.recorded_by) AS same_author
    FROM payloads a
    JOIN payloads b
      ON b.tenant_id = a.tenant_id
     AND b.delivery_id = a.delivery_id
     AND b.visit_kind = a.visit_kind
     AND b.newborn_id IS NOT DISTINCT FROM a.newborn_id
     AND b.id > a.id
     AND b.visit_at >= a.visit_at
     AND b.visit_at < a.visit_at + INTERVAL '600 seconds'
     AND b.clinical_payload = a.clinical_payload
    ORDER BY a.tenant_id, a.delivery_id, a.visit_kind,
             a.newborn_id NULLS FIRST, a.visit_at, a.id, b.id
  `
});

const PREGNANCY_COMPARISON_FIELDS = Object.freeze([
  'pregnancy_number',
  'lmp_date',
  'edd_date',
  'gravida',
  'parity',
  'living_children',
  'abortions',
  'booking_status',
  'high_risk'
]);

function comparable(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  return String(value);
}

function timestamp(value) {
  if (value == null) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function dateSpanDays(values) {
  const parsed = values.map(timestamp).filter(value => value != null);
  if (parsed.length < 2) return 0;
  return (Math.max(...parsed) - Math.min(...parsed)) / 86_400_000;
}

function nullSafeAllEqual(values) {
  if (!values.length) return true;
  const first = comparable(values[0]);
  return values.every(value => comparable(value) === first);
}

function referenceCounts(candidate) {
  return {
    anc_visits: Number(candidate.anc_visit_count || 0),
    labour_admissions: Number(candidate.labour_admission_count || 0),
    deliveries: Number(candidate.delivery_count || 0),
    supplements: Number(candidate.supplement_count || 0),
    fetal_kicks: Number(candidate.fetal_kick_count || 0)
  };
}

function totalReferences(candidate) {
  return Object.values(referenceCounts(candidate)).reduce((sum, count) => sum + count, 0);
}

function differingPregnancyFields(a, b) {
  return PREGNANCY_COMPARISON_FIELDS.filter(field => comparable(a[field]) !== comparable(b[field]));
}

/**
 * Deterministic evidence classification for an ongoing-pregnancy duplicate
 * group. Every result remains a candidate for clinical review; no code implies
 * a survivor or remediation action.
 */
export function classifyDuplicatePregnancyGroup(candidates) {
  if (!Array.isArray(candidates) || candidates.length < 2) {
    throw new Error('duplicate pregnancy classification requires at least two candidates');
  }

  const createdSpanSeconds = dateSpanDays(candidates.map(row => row.created_at)) * 86_400;
  const lmpSpanDays = dateSpanDays(candidates.map(row => row.lmp_date));
  const sameLmp = nullSafeAllEqual(candidates.map(row => row.lmp_date));
  const sameAuthor = nullSafeAllEqual(candidates.map(row => row.created_by));

  if (sameLmp && sameAuthor && createdSpanSeconds <= EXACT_RETRY_WINDOW_SECONDS) {
    return {
      code: 'C-exact-retry',
      evidence: [
        'lmp_dates_null_safe_equal',
        `created_span_seconds_lte_${EXACT_RETRY_WINDOW_SECONDS}`,
        'created_by_ids_null_safe_equal'
      ]
    };
  }

  const byCreatedAt = [...candidates].sort(
    (a, b) =>
      (timestamp(a.created_at) ?? Number.MAX_SAFE_INTEGER) -
        (timestamp(b.created_at) ?? Number.MAX_SAFE_INTEGER) || Number(a.id) - Number(b.id)
  );
  const oldest = byCreatedAt[0];
  const staleCreatedEpisode =
    dateSpanDays(candidates.map(row => row.created_at)) >= EPISODE_SEPARATION_DAYS &&
    totalReferences(oldest) > 0;
  const byLmp = candidates
    .filter(row => timestamp(row.lmp_date) != null)
    .sort((a, b) => timestamp(a.lmp_date) - timestamp(b.lmp_date) || Number(a.id) - Number(b.id));
  const staleLmpEpisode =
    lmpSpanDays >= EPISODE_SEPARATION_DAYS && byLmp.length >= 2 && totalReferences(byLmp[0]) > 0;

  if (staleCreatedEpisode || staleLmpEpisode) {
    return {
      code: 'C-stale-prior',
      evidence: [
        staleCreatedEpisode
          ? `created_span_days_gte_${EPISODE_SEPARATION_DAYS}_with_older_references`
          : `lmp_span_days_gte_${EPISODE_SEPARATION_DAYS}_with_older_references`
      ]
    };
  }

  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const differences = differingPregnancyFields(candidates[i], candidates[j]);
      if (
        differences.length === 1 &&
        totalReferences(candidates[i]) > 0 &&
        totalReferences(candidates[j]) > 0
      ) {
        return {
          code: 'C-typo/merge',
          evidence: [
            `one_core_field_diff:${differences[0]}`,
            'downstream_references_split_across_candidates'
          ]
        };
      }
    }
  }

  const nonNullLmps = candidates.filter(row => row.lmp_date != null);
  const differentLmps = !nullSafeAllEqual(candidates.map(row => row.lmp_date));
  const overlappingLmpWindows = nonNullLmps.length >= 2 && lmpSpanDays < EPISODE_SEPARATION_DAYS;
  const candidatesWithAnc = candidates.filter(row => Number(row.anc_visit_count || 0) > 0).length;
  const evidence = [];
  if (differentLmps) evidence.push('different_lmp_dates');
  if (overlappingLmpWindows) evidence.push('lmp_windows_overlap');
  if (candidatesWithAnc >= 2) evidence.push('anc_references_on_multiple_candidates');
  if (!evidence.length) evidence.push('no_low_ambiguity_signature');

  return { code: 'C-ambiguous', evidence };
}

function normalized(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(normalized);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, normalized(value[key])])
    );
  }
  return value;
}

function stableRecord(record) {
  return JSON.stringify(record);
}

function sectionRecords(rows, tenantId) {
  return (rows || [])
    .filter(row => String(row.tenant_id) === tenantId)
    .map(row => {
      const { tenant_id: _tenantId, ...candidate } = row;
      return normalized(candidate);
    })
    .sort((a, b) => stableRecord(a).localeCompare(stableRecord(b)));
}

function pregnancySectionRecords(rows, tenantId) {
  return (rows || [])
    .filter(row => String(row.tenant_id) === tenantId)
    .map(row => {
      const candidates = (row.candidates || []).map(candidate => ({ ...candidate }));
      const classification = classifyDuplicatePregnancyGroup(candidates);
      const evidenceCandidates = candidates
        .map(candidate => ({
          pregnancy_id: Number(candidate.id),
          lmp_date: normalized(candidate.lmp_date),
          created_at: normalized(candidate.created_at),
          created_by: normalized(candidate.created_by),
          latest_anc_visit_date: normalized(candidate.latest_anc_visit_date),
          downstream_reference_counts: referenceCounts(candidate)
        }))
        .sort(
          (a, b) =>
            String(a.created_at).localeCompare(String(b.created_at)) ||
            a.pregnancy_id - b.pregnancy_id
        );
      return {
        patient_uid: String(row.patient_uid),
        ongoing_count: Number(row.ongoing_count),
        classification: classification.code,
        classification_evidence: classification.evidence,
        candidates: evidenceCandidates
      };
    })
    .sort((a, b) => a.patient_uid.localeCompare(b.patient_uid));
}

/** Build a stable, tenant-grouped, candidate-only report from query rows. */
export function buildPreflightReport({ tenantRows = [], rowsBySection = {} } = {}) {
  const tenantIds = new Set((tenantRows || []).map(row => String(row.tenant_id)));
  for (const key of SECTION_KEYS) {
    for (const row of rowsBySection[key] || []) {
      if (row.tenant_id != null) tenantIds.add(String(row.tenant_id));
    }
  }

  const tenants = [...tenantIds].sort().map(tenantId => {
    const sections = {};
    for (const key of SECTION_KEYS) {
      const candidates =
        key === 'duplicate_ongoing_pregnancies'
          ? pregnancySectionRecords(rowsBySection[key], tenantId)
          : sectionRecords(rowsBySection[key], tenantId);
      sections[key] = { candidate_count: candidates.length, candidates };
    }
    return { tenant_id: tenantId, sections };
  });

  const totals = Object.fromEntries(
    SECTION_KEYS.map(key => [
      key,
      tenants.reduce((sum, tenant) => sum + tenant.sections[key].candidate_count, 0)
    ])
  );

  return {
    schema_version: 1,
    scope: 'all_tenants',
    access_mode: 'read_only_replica_super_admin_bypass',
    candidate_only: true,
    classification_thresholds: {
      exact_retry_window_seconds: EXACT_RETRY_WINDOW_SECONDS,
      stale_episode_separation_days: EPISODE_SEPARATION_DAYS
    },
    near_duplicate_windows_seconds: {
      partograph: PARTOGRAPH_WINDOW_SECONDS,
      postnatal: POSTNATAL_WINDOW_SECONDS
    },
    tenants_scanned: tenants.length,
    tenants,
    totals
  };
}

function transactionIsReadOnly(value) {
  return value === true || value === 'on' || value === 'true' || value === '1';
}

/**
 * Run all report queries in one established super-admin, read-replica tenant
 * transaction. Dependency injection keeps focused tests database-free.
 */
export async function collectAllTenantPreflight({ setTenantFn } = {}) {
  if (typeof setTenantFn !== 'function') {
    throw new Error('collectAllTenantPreflight requires setTenantFn');
  }
  return setTenantFn(
    null,
    async tx => {
      const stateRows = await tx.$queryRawUnsafe(READ_ONLY_CHECK_QUERY);
      if (!transactionIsReadOnly(stateRows?.[0]?.transaction_read_only)) {
        throw new Error(
          'DATABASE_READ_URL transaction is writable; refusing all-tenant maternity scan'
        );
      }

      const tenantRows = await tx.$queryRawUnsafe(TENANT_INVENTORY_QUERY);
      const rowsBySection = {};
      for (const key of SECTION_KEYS) {
        rowsBySection[key] = await tx.$queryRawUnsafe(REPORT_QUERIES[key]);
      }
      return buildPreflightReport({ tenantRows, rowsBySection });
    },
    { superAdmin: true, readOnly: true }
  );
}

export function parseArgs(argv) {
  const options = { acknowledged: false, json: false, help: false };
  for (const arg of argv) {
    if (arg === ACKNOWLEDGEMENT_FLAG) options.acknowledged = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export function assertOperationalSafety({ acknowledged, env = process.env } = {}) {
  if (!acknowledged) {
    throw new Error(`Explicit operator acknowledgement required: ${ACKNOWLEDGEMENT_FLAG}`);
  }
  if (!env.DATABASE_READ_URL) {
    throw new Error('DATABASE_READ_URL is required; writable-primary fallback is forbidden');
  }
}

function usage() {
  return [
    'Usage:',
    '  DATABASE_READ_URL=... node scripts/maternity-duplicate-preflight.mjs',
    `    ${ACKNOWLEDGEMENT_FLAG} [--json]`,
    '',
    'All-tenant, read-only candidate report. There is intentionally no --tenant mode.'
  ].join('\n');
}

function writeTextReport(report) {
  process.stdout.write('M-F F0 maternity duplicate preflight\n');
  process.stdout.write(`  tenants scanned: ${report.tenants_scanned}\n`);
  for (const tenant of report.tenants) {
    process.stdout.write(`  tenant ${tenant.tenant_id}\n`);
    for (const key of SECTION_KEYS) {
      process.stdout.write(`    ${key}: ${tenant.sections[key].candidate_count} candidate(s)\n`);
    }
  }
  process.stdout.write('  candidate-only; no rows were modified and no survivor was selected\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  assertOperationalSafety(options);

  // prisma.js always constructs its primary client at import time. Pin that
  // bootstrap URL to the already-required replica too, so even an accidental
  // default-client call in this process cannot reach the configured primary.
  process.env.DATABASE_URL = process.env.DATABASE_READ_URL;
  const prismaModule = await import('../src/lib/prisma.js');
  try {
    const report = await collectAllTenantPreflight({ setTenantFn: prismaModule.setTenant });
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else writeTextReport(report);
  } finally {
    const clients = new Set([prismaModule.default, prismaModule.prismaReadOnly]);
    await Promise.allSettled([...clients].map(client => client.$disconnect()));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    process.stderr.write(`[maternity-duplicate-preflight] fatal: ${error.message}\n`);
    process.exitCode = 1;
  });
}
