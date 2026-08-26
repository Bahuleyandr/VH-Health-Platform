// src/services/clinical/nicuPicuChartingService.js — NL-14 P3
//
// PICU/NICU specialty views over the P1 ICU chart substrate (icu_admissions,
// icu_ventilation_episodes, icu_device_observation_links, icu_chart_audit_events)
// — additional views, not a parallel silo. Feeds/fluids, neonatal respiratory
// support, apnea/brady/desat events, jaundice/phototherapy, incubator/warmer
// observations, owner-governed neonatal/pediatric score outputs, and the
// maternity newborn-substrate link all chart against the same ICU admission.
//
// Governance posture (spec §3, §6.4, §6.5):
//   - Score FORMULAS are never computed here. Outputs require an ACTIVE
//     owner-approved nicu_picu_score_definitions row; otherwise the write
//     fails closed with "score unavailable" — no fallback math.
//   - Growth references consume NL-5 growth_reference_lms through
//     growthPercentileService; labelled approximations pass through as-is.
//   - Immunisation surfaces read NL-5 pack-governed vaccine_catalogue rows
//     (schedule_source/source_version provenance); no seeding writes happen
//     inside chart reads.
//   - The whole specialty surface is inert until the per-tenant
//     nicu_picu_chart_settings flag is enabled (fail closed).
//   - Device transport stays NL-7-owned: rows only reference
//     device_registry / device_vital_sample_observations and land
//     unverified until clinician review.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  recordClinicalAuditEvent,
  recordTimelineEvent
} from './canonicalClinicalPlatformService.js';
import { getIcuChartView } from './icuChartingService.js';
import {
  ageInDaysFrom,
  computePercentile,
  normaliseSex
} from './growthPercentileService.js';

export const NICU_PICU_UNITS = ['NICU', 'PICU'];

const PARENTERAL_FEED_TYPES = ['tpn', 'iv_fluid', 'medication_volume'];

// Allowlisted verification targets — resource key → physical table. Never
// interpolate caller-supplied table names. Exported so the route-level
// patient-access guard on PATCH /icu/nicu/:resource/:id/verify resolves the
// SAME table this service will serve (re-audit M) — a local copy in the
// router could drift.
export const VERIFIABLE_RESOURCES = Object.freeze({
  'feed-fluid': 'nicu_feed_fluid_entries',
  'respiratory-support': 'nicu_respiratory_support_observations',
  'cardioresp-events': 'nicu_cardiorespiratory_events',
  'jaundice-phototherapy': 'nicu_jaundice_phototherapy_events',
  'thermal-observations': 'nicu_thermal_environment_observations'
});

function tenantOr(tenantId) {
  return requireTenantId(tenantId);
}

function unwrap(rows) {
  return Array.isArray(rows) ? rows[0] : rows;
}

function toInt(value, field) {
  const n = parseInt(value, 10);
  if (!Number.isInteger(n)) throw AppError.badRequest(`${field} must be numeric`);
  return n;
}

function json(value, fallback = {}) {
  return JSON.stringify(value == null ? fallback : value);
}

function normalizeValue(value) {
  if (value == null) return value;
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value?.toNumber === 'function') return value.toNumber();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeValue(entry)])
    );
  }
  return value;
}

function normalizeRows(rows) {
  return (rows || []).map(row => normalizeValue(row));
}

function windowFrom({ hours = 24, at = null }) {
  const h = Math.min(Math.max(parseInt(hours, 10) || 24, 1), 168);
  const end = at ? new Date(at) : new Date();
  const start = new Date(end.getTime() - h * 60 * 60 * 1000);
  return { start, end, hours: h };
}

async function assertNicuAdmission(tx, tenantId, icuAdmissionId) {
  const id = toInt(icuAdmissionId, 'icu_admission_id');
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, tenant_id, patient_uid, admission_id, unit_code, bed_no, admitted_at,
            discharged_at, status, monitoring_interval_minutes
       FROM icu_admissions
      WHERE id = $1 AND tenant_id = $2::uuid
      LIMIT 1`,
    id,
    tenantOr(tenantId)
  );
  const admission = unwrap(rows);
  if (!admission) throw AppError.notFound('ICU admission not found');
  if (!NICU_PICU_UNITS.includes(String(admission.unit_code || '').toUpperCase())) {
    throw AppError.badRequest(
      'This ICU admission is not a NICU/PICU admission',
      'NICU_PICU_UNIT_REQUIRED'
    );
  }
  return admission;
}

// Fail-closed per-tenant gate (mig-351 / compositionFeatureService pattern):
// NICU/PICU specialty writes are rejected until an operator enables the
// tenant with an acceptance snapshot.
async function assertNicuChartingEnabled(tx, tenantId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT enabled FROM nicu_picu_chart_settings WHERE tenant_id = $1::uuid`,
    tenantOr(tenantId)
  );
  const settings = unwrap(rows);
  if (!settings || settings.enabled !== true) {
    throw AppError.forbidden(
      'NICU/PICU specialty charting is not enabled for this tenant',
      'NICU_PICU_CHART_DISABLED'
    );
  }
}

function deviceVerification(body) {
  const source = body.source === 'device' ? 'device' : 'manual';
  return {
    source,
    verificationStatus: source === 'device' ? 'unverified' : 'not_applicable'
  };
}

async function recordIcuAudit(tx, input) {
  await tx.$queryRawUnsafe(
    `INSERT INTO icu_chart_audit_events
       (tenant_id, patient_uid, icu_admission_id, action, actor_uid,
        resource_table, resource_id, before_state, after_state, metadata)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)`,
    tenantOr(input.tenantId),
    input.patientUid || null,
    input.icuAdmissionId ? toInt(input.icuAdmissionId, 'icu_admission_id') : null,
    input.action,
    input.actorUid || null,
    input.resourceTable || null,
    input.resourceId == null ? null : String(input.resourceId),
    json(input.beforeState, null),
    json(input.afterState, null),
    json(input.metadata)
  );
}

async function recordCanonicalPair(
  tx,
  {
    tenantId,
    admission,
    resourceTable,
    resourceId,
    eventType,
    action,
    actorUid,
    actorRole,
    summary,
    payload = {},
    beforeState = null,
    afterState = null
  }
) {
  const sourceId = String(resourceId);
  const timeline = await recordTimelineEvent(
    {
      tenantId,
      patientUid: admission.patient_uid,
      eventType,
      eventStatus: 'recorded',
      sourceTable: resourceTable,
      sourceId,
      resourceType: resourceTable,
      resourceId: sourceId,
      actorUid,
      actorRole,
      occurredAt: payload.occurred_at || null,
      summary,
      payload,
      tags: ['icu', 'nicu', 'nl14'],
      idempotencyKey: `${resourceTable}:${sourceId}:${eventType}`
    },
    { db: tx }
  );
  const audit = await recordClinicalAuditEvent(
    {
      tenantId,
      patientUid: admission.patient_uid,
      action,
      actionStatus: 'success',
      actorUid,
      actorRole,
      resourceType: resourceTable,
      resourceTable,
      resourceId: sourceId,
      beforeState,
      afterState,
      metadata: payload,
      idempotencyKey: `${resourceTable}:${sourceId}:${action}`
    },
    { db: tx }
  );
  if (!timeline || !audit) {
    throw AppError.internal(
      'Canonical NICU timeline/audit write failed',
      'NICU_CANONICAL_WRITE_FAILED'
    );
  }
}

// ── Settings (per-tenant fail-closed flag) ─────────────────────────────

export async function getNicuChartSettings({ tenantId }) {
  const rows = await setTenantTx(tenantOr(tenantId), tx =>
    tx.$queryRawUnsafe(
      `SELECT *
       FROM nicu_picu_chart_settings
      WHERE tenant_id = $1::uuid`,
      tenantOr(tenantId)
    )
  );
  return (
    normalizeValue(unwrap(rows)) || {
      tenant_id: tenantOr(tenantId),
      enabled: false,
      specialty_view_policy: {},
      scoring_governance: {},
      device_fleet_snapshot: {},
      content_source: 'unavailable'
    }
  );
}

export async function setNicuChartSettings({
  tenantId,
  enabled,
  specialty_view_policy,
  scoring_governance,
  device_fleet_snapshot,
  content_source,
  acceptance_snapshot,
  actorUid
}) {
  if (enabled === true && (!acceptance_snapshot || !actorUid)) {
    throw AppError.badRequest(
      'acceptance_snapshot and actorUid are required to enable NICU/PICU charting'
    );
  }
  return setTenantTx(tenantOr(tenantId), async tx => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO nicu_picu_chart_settings
         (tenant_id, enabled, specialty_view_policy, scoring_governance,
          device_fleet_snapshot, content_source, enabled_at, enabled_by,
          acceptance_snapshot, updated_at)
       VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6,
               CASE WHEN $2 THEN NOW() ELSE NULL END,
               CASE WHEN $2 THEN $7::uuid ELSE NULL END,
               CASE WHEN $2 THEN $8::jsonb ELSE NULL END,
               NOW())
       ON CONFLICT (tenant_id) DO UPDATE SET
         enabled = $2,
         specialty_view_policy = $3::jsonb,
         scoring_governance = $4::jsonb,
         device_fleet_snapshot = $5::jsonb,
         content_source = $6,
         enabled_at = CASE WHEN $2 THEN COALESCE(nicu_picu_chart_settings.enabled_at, NOW()) ELSE nicu_picu_chart_settings.enabled_at END,
         enabled_by = CASE WHEN $2 THEN $7::uuid ELSE nicu_picu_chart_settings.enabled_by END,
         acceptance_snapshot = CASE WHEN $2 THEN $8::jsonb ELSE nicu_picu_chart_settings.acceptance_snapshot END,
         updated_at = NOW()
       RETURNING *`,
      tenantOr(tenantId),
      enabled === true,
      json(specialty_view_policy),
      json(scoring_governance),
      json(device_fleet_snapshot),
      content_source || 'nl5_content_studio',
      actorUid || null,
      json(acceptance_snapshot, null)
    );
    await recordIcuAudit(tx, {
      tenantId,
      action: 'nicu_chart.settings_updated',
      actorUid,
      resourceTable: 'nicu_picu_chart_settings',
      resourceId: tenantOr(tenantId),
      afterState: rows[0],
      metadata: { enabled: enabled === true }
    });
    return normalizeValue(rows[0]);
  });
}

// ── Feed / fluid chart ─────────────────────────────────────────────────

export async function recordFeedFluidEntry({
  tenantId,
  icuAdmissionId,
  actorUid,
  actorRole,
  ...body
}) {
  if (!body.entry_kind) throw AppError.badRequest('entry_kind required');
  const tenant = tenantOr(tenantId);
  const { source, verificationStatus } = deviceVerification(body);
  return setTenantTx(tenant, async tx => {
    await assertNicuChartingEnabled(tx, tenant);
    const admission = await assertNicuAdmission(tx, tenant, icuAdmissionId);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO nicu_feed_fluid_entries
         (tenant_id, icu_admission_id, admission_id, patient_uid, entry_kind,
          recorded_at, feed_type, feed_route, volume_ml, duration_minutes,
          fortifier_added, fortifier_detail, output_kind, output_volume_ml,
          diaper_weight_based, glucose_mgdl, glucose_source, weight_grams,
          source, device_registry_id, sample_observation_id,
          verification_status, recorded_by, notes, metadata)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5,
               COALESCE($6::timestamptz, NOW()), $7, $8, $9, $10,
               COALESCE($11, FALSE), $12, $13, $14,
               $15, $16, $17, $18,
               $19, $20, $21, $22, $23::uuid, $24, $25::jsonb)
       RETURNING *`,
      tenant,
      admission.id,
      admission.admission_id || null,
      admission.patient_uid,
      body.entry_kind,
      body.recorded_at || null,
      body.feed_type || null,
      body.feed_route || null,
      body.volume_ml ?? null,
      body.duration_minutes == null ? null : toInt(body.duration_minutes, 'duration_minutes'),
      body.fortifier_added === true,
      body.fortifier_detail || null,
      body.output_kind || null,
      body.output_volume_ml ?? null,
      body.diaper_weight_based ?? null,
      body.glucose_mgdl ?? null,
      body.glucose_source || null,
      body.weight_grams == null ? null : toInt(body.weight_grams, 'weight_grams'),
      source,
      body.device_registry_id == null ? null : toInt(body.device_registry_id, 'device_registry_id'),
      body.sample_observation_id == null
        ? null
        : toInt(body.sample_observation_id, 'sample_observation_id'),
      verificationStatus,
      actorUid || body.recorded_by || null,
      body.notes || null,
      json(body.metadata)
    );
    const row = rows[0];
    await recordCanonicalPair(tx, {
      tenantId: tenant,
      admission,
      resourceTable: 'nicu_feed_fluid_entries',
      resourceId: row.id,
      eventType: 'nicu.feed_fluid_recorded',
      action: 'nicu.feed_fluid.recorded',
      actorUid,
      actorRole,
      summary: `NICU/PICU ${String(body.entry_kind).replaceAll('_', ' ')} recorded`,
      payload: {
        entry_kind: body.entry_kind,
        feed_type: body.feed_type || null,
        volume_ml: body.volume_ml ?? null,
        output_kind: body.output_kind || null,
        output_volume_ml: body.output_volume_ml ?? null,
        source,
        verification_status: verificationStatus,
        occurred_at: row.recorded_at
      },
      afterState: row
    });
    return normalizeValue(row);
  });
}

export async function listFeedFluidEntries({ tenantId, icuAdmissionId, kind = null, hours, at }) {
  const tenant = tenantOr(tenantId);
  const { start, end } = windowFrom({ hours, at });
  return setTenantTx(tenant, async tx => {
    const admission = await assertNicuAdmission(tx, tenant, icuAdmissionId);
    const params = [tenant, admission.id, start.toISOString(), end.toISOString()];
    let kindFilter = '';
    if (kind) {
      params.push(kind);
      kindFilter = ` AND entry_kind = $${params.length}`;
    }
    const rows = await tx.$queryRawUnsafe(
      `SELECT *
         FROM nicu_feed_fluid_entries
        WHERE tenant_id = $1::uuid
          AND icu_admission_id = $2
          AND recorded_at BETWEEN $3::timestamptz AND $4::timestamptz
          ${kindFilter}
        ORDER BY recorded_at DESC`,
      ...params
    );
    return normalizeRows(rows);
  });
}

// Pure balance math over normalized feed/fluid rows. This is chart
// bookkeeping (totals and mL/kg over the window), not a clinical score —
// score formulas stay owner-governed in nicu_picu_score_definitions.
export function computeFeedFluidBalance(entries, { windowHours = 24 } = {}) {
  const rows = Array.isArray(entries) ? entries.map(normalizeValue) : [];
  const num = value => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };

  const weights = rows
    .filter(row => row.entry_kind === 'weight' && row.weight_grams != null)
    .sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));
  const latestWeight = weights.length ? weights[weights.length - 1] : null;
  const weightGrams = latestWeight ? Number(latestWeight.weight_grams) : null;

  const intakeRows = rows.filter(
    row => row.entry_kind === 'feed' || row.entry_kind === 'fluid_intake'
  );
  const outputRows = rows.filter(row => row.entry_kind === 'fluid_output');

  const byFeedType = {};
  let intakeTotal = 0;
  let enteralTotal = 0;
  let parenteralTotal = 0;
  for (const row of intakeRows) {
    const volume = num(row.volume_ml);
    intakeTotal += volume;
    const feedType = row.feed_type || 'unspecified';
    byFeedType[feedType] = +(num(byFeedType[feedType]) + volume).toFixed(2);
    if (PARENTERAL_FEED_TYPES.includes(feedType)) parenteralTotal += volume;
    else enteralTotal += volume;
  }

  const byOutputKind = {};
  let outputTotal = 0;
  for (const row of outputRows) {
    const volume = num(row.output_volume_ml);
    outputTotal += volume;
    const outputKind = row.output_kind || 'unspecified';
    byOutputKind[outputKind] = +(num(byOutputKind[outputKind]) + volume).toFixed(2);
  }

  const glucoseRows = rows
    .filter(row => row.entry_kind === 'glucose' && row.glucose_mgdl != null)
    .sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));
  const latestGlucose = glucoseRows.length ? glucoseRows[glucoseRows.length - 1] : null;

  const netMl = +(intakeTotal - outputTotal).toFixed(2);
  const weightKg = weightGrams ? weightGrams / 1000 : null;
  const perKg =
    weightKg && weightKg > 0
      ? {
          intake_ml_per_kg: +(intakeTotal / weightKg).toFixed(2),
          output_ml_per_kg: +(outputTotal / weightKg).toFixed(2),
          net_ml_per_kg: +(netMl / weightKg).toFixed(2)
        }
      : null;

  return {
    window_hours: windowHours,
    weight_grams: weightGrams,
    weight_basis: latestWeight
      ? { source: 'latest_weight_entry', recorded_at: latestWeight.recorded_at }
      : null,
    intake: {
      total_ml: +intakeTotal.toFixed(2),
      enteral_ml: +enteralTotal.toFixed(2),
      parenteral_ml: +parenteralTotal.toFixed(2),
      entry_count: intakeRows.length,
      by_feed_type: byFeedType
    },
    output: {
      total_ml: +outputTotal.toFixed(2),
      entry_count: outputRows.length,
      by_kind: byOutputKind
    },
    net_ml: netMl,
    per_kg: perKg,
    latest_glucose: latestGlucose
      ? { glucose_mgdl: Number(latestGlucose.glucose_mgdl), recorded_at: latestGlucose.recorded_at }
      : null
  };
}

export async function getFeedFluidBalance({ tenantId, icuAdmissionId, hours = 24, at = null }) {
  const tenant = tenantOr(tenantId);
  const { start, end, hours: h } = windowFrom({ hours, at });
  return setTenantTx(tenant, async tx => {
    const admission = await assertNicuAdmission(tx, tenant, icuAdmissionId);
    const rows = await tx.$queryRawUnsafe(
      `SELECT *
         FROM nicu_feed_fluid_entries
        WHERE tenant_id = $1::uuid
          AND icu_admission_id = $2
          AND recorded_at BETWEEN $3::timestamptz AND $4::timestamptz
        ORDER BY recorded_at ASC`,
      tenant,
      admission.id,
      start.toISOString(),
      end.toISOString()
    );
    return {
      window: { start: start.toISOString(), end: end.toISOString(), hours: h },
      balance: computeFeedFluidBalance(normalizeRows(rows), { windowHours: h })
    };
  });
}

// ── Respiratory support + cardiorespiratory events ─────────────────────

export async function recordRespiratorySupportObservation({
  tenantId,
  icuAdmissionId,
  actorUid,
  actorRole,
  ...body
}) {
  if (!body.support_mode) throw AppError.badRequest('support_mode required');
  const tenant = tenantOr(tenantId);
  const { source, verificationStatus } = deviceVerification(body);
  return setTenantTx(tenant, async tx => {
    await assertNicuChartingEnabled(tx, tenant);
    const admission = await assertNicuAdmission(tx, tenant, icuAdmissionId);
    if (body.ventilation_episode_id != null) {
      const episode = unwrap(
        await tx.$queryRawUnsafe(
          `SELECT id FROM icu_ventilation_episodes
          WHERE id = $1 AND tenant_id = $2::uuid AND icu_admission_id = $3
          LIMIT 1`,
          toInt(body.ventilation_episode_id, 'ventilation_episode_id'),
          tenant,
          admission.id
        )
      );
      if (!episode) {
        throw AppError.notFound('Ventilation episode not found for this NICU/PICU admission');
      }
    }
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO nicu_respiratory_support_observations
         (tenant_id, icu_admission_id, patient_uid, ventilation_episode_id,
          observed_at, support_mode, fio2_pct, flow_lpm, peep_cm_h2o,
          pip_cm_h2o, mean_airway_pressure_cm_h2o, set_rate_per_min,
          source, device_registry_id, sample_observation_id,
          verification_status, recorded_by, notes, metadata)
       VALUES ($1::uuid, $2, $3::uuid, $4,
               COALESCE($5::timestamptz, NOW()), $6, $7, $8, $9,
               $10, $11, $12, $13, $14, $15, $16, $17::uuid, $18, $19::jsonb)
       RETURNING *`,
      tenant,
      admission.id,
      admission.patient_uid,
      body.ventilation_episode_id == null
        ? null
        : toInt(body.ventilation_episode_id, 'ventilation_episode_id'),
      body.observed_at || null,
      body.support_mode,
      body.fio2_pct ?? null,
      body.flow_lpm ?? null,
      body.peep_cm_h2o ?? null,
      body.pip_cm_h2o ?? null,
      body.mean_airway_pressure_cm_h2o ?? null,
      body.set_rate_per_min == null ? null : toInt(body.set_rate_per_min, 'set_rate_per_min'),
      source,
      body.device_registry_id == null ? null : toInt(body.device_registry_id, 'device_registry_id'),
      body.sample_observation_id == null
        ? null
        : toInt(body.sample_observation_id, 'sample_observation_id'),
      verificationStatus,
      actorUid || body.recorded_by || null,
      body.notes || null,
      json(body.metadata)
    );
    const row = rows[0];
    await recordCanonicalPair(tx, {
      tenantId: tenant,
      admission,
      resourceTable: 'nicu_respiratory_support_observations',
      resourceId: row.id,
      eventType: 'nicu.respiratory_support_recorded',
      action: 'nicu.respiratory_support.recorded',
      actorUid,
      actorRole,
      summary: `NICU respiratory support recorded (${body.support_mode})`,
      payload: {
        support_mode: body.support_mode,
        fio2_pct: body.fio2_pct ?? null,
        source,
        verification_status: verificationStatus,
        occurred_at: row.observed_at
      },
      afterState: row
    });
    return normalizeValue(row);
  });
}

export async function listRespiratorySupportObservations({
  tenantId,
  icuAdmissionId,
  hours,
  at
}) {
  const tenant = tenantOr(tenantId);
  const { start, end } = windowFrom({ hours, at });
  return setTenantTx(tenant, async tx => {
    const admission = await assertNicuAdmission(tx, tenant, icuAdmissionId);
    const rows = await tx.$queryRawUnsafe(
      `SELECT *
         FROM nicu_respiratory_support_observations
        WHERE tenant_id = $1::uuid
          AND icu_admission_id = $2
          AND observed_at BETWEEN $3::timestamptz AND $4::timestamptz
        ORDER BY observed_at DESC`,
      tenant,
      admission.id,
      start.toISOString(),
      end.toISOString()
    );
    return normalizeRows(rows);
  });
}

export async function recordCardiorespiratoryEvent({
  tenantId,
  icuAdmissionId,
  actorUid,
  actorRole,
  ...body
}) {
  if (!body.event_kind) throw AppError.badRequest('event_kind required');
  const tenant = tenantOr(tenantId);
  const { source, verificationStatus } = deviceVerification(body);
  return setTenantTx(tenant, async tx => {
    await assertNicuChartingEnabled(tx, tenant);
    const admission = await assertNicuAdmission(tx, tenant, icuAdmissionId);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO nicu_cardiorespiratory_events
         (tenant_id, icu_admission_id, patient_uid, event_kind, started_at,
          duration_seconds, lowest_heart_rate, lowest_spo2_pct, self_resolved,
          intervention, intervention_detail, source, device_registry_id,
          sample_observation_id, verification_status, recorded_by, notes, metadata)
       VALUES ($1::uuid, $2, $3::uuid, $4, COALESCE($5::timestamptz, NOW()),
               $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::uuid, $17, $18::jsonb)
       RETURNING *`,
      tenant,
      admission.id,
      admission.patient_uid,
      body.event_kind,
      body.started_at || null,
      body.duration_seconds == null ? null : toInt(body.duration_seconds, 'duration_seconds'),
      body.lowest_heart_rate == null ? null : toInt(body.lowest_heart_rate, 'lowest_heart_rate'),
      body.lowest_spo2_pct == null ? null : toInt(body.lowest_spo2_pct, 'lowest_spo2_pct'),
      body.self_resolved ?? null,
      body.intervention || null,
      body.intervention_detail || null,
      source,
      body.device_registry_id == null ? null : toInt(body.device_registry_id, 'device_registry_id'),
      body.sample_observation_id == null
        ? null
        : toInt(body.sample_observation_id, 'sample_observation_id'),
      verificationStatus,
      actorUid || body.recorded_by || null,
      body.notes || null,
      json(body.metadata)
    );
    const row = rows[0];
    await recordCanonicalPair(tx, {
      tenantId: tenant,
      admission,
      resourceTable: 'nicu_cardiorespiratory_events',
      resourceId: row.id,
      eventType: 'nicu.cardiorespiratory_event_recorded',
      action: 'nicu.cardiorespiratory_event.recorded',
      actorUid,
      actorRole,
      summary: `NICU ${String(body.event_kind).replaceAll('_', ' ')} event recorded`,
      payload: {
        event_kind: body.event_kind,
        duration_seconds: body.duration_seconds ?? null,
        intervention: body.intervention || null,
        source,
        verification_status: verificationStatus,
        occurred_at: row.started_at
      },
      afterState: row
    });
    return normalizeValue(row);
  });
}

export async function listCardiorespiratoryEvents({ tenantId, icuAdmissionId, hours, at }) {
  const tenant = tenantOr(tenantId);
  const { start, end } = windowFrom({ hours, at });
  return setTenantTx(tenant, async tx => {
    const admission = await assertNicuAdmission(tx, tenant, icuAdmissionId);
    const rows = await tx.$queryRawUnsafe(
      `SELECT *
         FROM nicu_cardiorespiratory_events
        WHERE tenant_id = $1::uuid
          AND icu_admission_id = $2
          AND started_at BETWEEN $3::timestamptz AND $4::timestamptz
        ORDER BY started_at DESC`,
      tenant,
      admission.id,
      start.toISOString(),
      end.toISOString()
    );
    return normalizeRows(rows);
  });
}

// ── Jaundice / phototherapy ────────────────────────────────────────────

export async function recordJaundicePhototherapyEvent({
  tenantId,
  icuAdmissionId,
  actorUid,
  actorRole,
  ...body
}) {
  if (!body.event_kind) throw AppError.badRequest('event_kind required');
  const tenant = tenantOr(tenantId);
  const { source, verificationStatus } = deviceVerification(body);
  return setTenantTx(tenant, async tx => {
    await assertNicuChartingEnabled(tx, tenant);
    const admission = await assertNicuAdmission(tx, tenant, icuAdmissionId);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO nicu_jaundice_phototherapy_events
         (tenant_id, icu_admission_id, patient_uid, event_kind, occurred_at,
          bilirubin_total_mgdl, bilirubin_direct_mgdl, measurement_method,
          phototherapy_type, device_label, irradiance_uw_cm2_nm,
          eye_protection_confirmed, threshold_reference_source,
          threshold_reference_version, source, device_registry_id,
          sample_observation_id, verification_status, recorded_by, notes, metadata)
       VALUES ($1::uuid, $2, $3::uuid, $4, COALESCE($5::timestamptz, NOW()),
               $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
               $19::uuid, $20, $21::jsonb)
       RETURNING *`,
      tenant,
      admission.id,
      admission.patient_uid,
      body.event_kind,
      body.occurred_at || null,
      body.bilirubin_total_mgdl ?? null,
      body.bilirubin_direct_mgdl ?? null,
      body.measurement_method || null,
      body.phototherapy_type || null,
      body.device_label || null,
      body.irradiance_uw_cm2_nm ?? null,
      body.eye_protection_confirmed ?? null,
      body.threshold_reference_source || null,
      body.threshold_reference_version || null,
      source,
      body.device_registry_id == null ? null : toInt(body.device_registry_id, 'device_registry_id'),
      body.sample_observation_id == null
        ? null
        : toInt(body.sample_observation_id, 'sample_observation_id'),
      verificationStatus,
      actorUid || body.recorded_by || null,
      body.notes || null,
      json(body.metadata)
    );
    const row = rows[0];
    await recordCanonicalPair(tx, {
      tenantId: tenant,
      admission,
      resourceTable: 'nicu_jaundice_phototherapy_events',
      resourceId: row.id,
      eventType: 'nicu.jaundice_phototherapy_recorded',
      action: 'nicu.jaundice_phototherapy.recorded',
      actorUid,
      actorRole,
      summary: `NICU ${String(body.event_kind).replaceAll('_', ' ')} recorded`,
      payload: {
        event_kind: body.event_kind,
        bilirubin_total_mgdl: body.bilirubin_total_mgdl ?? null,
        phototherapy_type: body.phototherapy_type || null,
        threshold_reference_source: body.threshold_reference_source || null,
        threshold_reference_version: body.threshold_reference_version || null,
        source,
        verification_status: verificationStatus,
        occurred_at: row.occurred_at
      },
      afterState: row
    });
    return normalizeValue(row);
  });
}

export async function listJaundicePhototherapyEvents({ tenantId, icuAdmissionId, hours, at }) {
  const tenant = tenantOr(tenantId);
  const { start, end } = windowFrom({ hours, at });
  return setTenantTx(tenant, async tx => {
    const admission = await assertNicuAdmission(tx, tenant, icuAdmissionId);
    const rows = await tx.$queryRawUnsafe(
      `SELECT *
         FROM nicu_jaundice_phototherapy_events
        WHERE tenant_id = $1::uuid
          AND icu_admission_id = $2
          AND occurred_at BETWEEN $3::timestamptz AND $4::timestamptz
        ORDER BY occurred_at DESC`,
      tenant,
      admission.id,
      start.toISOString(),
      end.toISOString()
    );
    return normalizeRows(rows);
  });
}

// ── Thermal environment (incubator / warmer) ───────────────────────────

export async function recordThermalObservation({
  tenantId,
  icuAdmissionId,
  actorUid,
  actorRole,
  ...body
}) {
  if (!body.care_environment) throw AppError.badRequest('care_environment required');
  const tenant = tenantOr(tenantId);
  const { source, verificationStatus } = deviceVerification(body);
  return setTenantTx(tenant, async tx => {
    await assertNicuChartingEnabled(tx, tenant);
    const admission = await assertNicuAdmission(tx, tenant, icuAdmissionId);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO nicu_thermal_environment_observations
         (tenant_id, icu_admission_id, patient_uid, observed_at,
          care_environment, control_mode, set_temperature_c, air_temperature_c,
          skin_temperature_c, axillary_temperature_c, humidity_pct, source,
          device_registry_id, sample_observation_id, verification_status,
          recorded_by, notes, metadata)
       VALUES ($1::uuid, $2, $3::uuid, COALESCE($4::timestamptz, NOW()),
               $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::uuid, $17, $18::jsonb)
       RETURNING *`,
      tenant,
      admission.id,
      admission.patient_uid,
      body.observed_at || null,
      body.care_environment,
      body.control_mode || null,
      body.set_temperature_c ?? null,
      body.air_temperature_c ?? null,
      body.skin_temperature_c ?? null,
      body.axillary_temperature_c ?? null,
      body.humidity_pct ?? null,
      source,
      body.device_registry_id == null ? null : toInt(body.device_registry_id, 'device_registry_id'),
      body.sample_observation_id == null
        ? null
        : toInt(body.sample_observation_id, 'sample_observation_id'),
      verificationStatus,
      actorUid || body.recorded_by || null,
      body.notes || null,
      json(body.metadata)
    );
    const row = rows[0];
    await recordCanonicalPair(tx, {
      tenantId: tenant,
      admission,
      resourceTable: 'nicu_thermal_environment_observations',
      resourceId: row.id,
      eventType: 'nicu.thermal_observation_recorded',
      action: 'nicu.thermal_observation.recorded',
      actorUid,
      actorRole,
      summary: `NICU thermal environment recorded (${body.care_environment})`,
      payload: {
        care_environment: body.care_environment,
        control_mode: body.control_mode || null,
        source,
        verification_status: verificationStatus,
        occurred_at: row.observed_at
      },
      afterState: row
    });
    return normalizeValue(row);
  });
}

export async function listThermalObservations({ tenantId, icuAdmissionId, hours, at }) {
  const tenant = tenantOr(tenantId);
  const { start, end } = windowFrom({ hours, at });
  return setTenantTx(tenant, async tx => {
    const admission = await assertNicuAdmission(tx, tenant, icuAdmissionId);
    const rows = await tx.$queryRawUnsafe(
      `SELECT *
         FROM nicu_thermal_environment_observations
        WHERE tenant_id = $1::uuid
          AND icu_admission_id = $2
          AND observed_at BETWEEN $3::timestamptz AND $4::timestamptz
        ORDER BY observed_at DESC`,
      tenant,
      admission.id,
      start.toISOString(),
      end.toISOString()
    );
    return normalizeRows(rows);
  });
}

// ── Device-sourced observation review (unverified → verified) ──────────

export async function verifyNicuObservation({ tenantId, resource, id, actorUid, actorRole }) {
  // Object.hasOwn: a bare bracket lookup resolves prototype keys
  // ('constructor', '__proto__') to functions, which then interpolate into
  // the FROM clause and 500. Own-key check keeps the allowlist an allowlist.
  const table = Object.hasOwn(VERIFIABLE_RESOURCES, resource)
    ? VERIFIABLE_RESOURCES[resource]
    : undefined;
  if (!table) {
    throw AppError.badRequest(
      `resource must be one of: ${Object.keys(VERIFIABLE_RESOURCES).join(', ')}`,
      'NICU_VERIFY_RESOURCE_INVALID'
    );
  }
  const tenant = tenantOr(tenantId);
  const rowId = toInt(id, 'id');
  return setTenantTx(tenant, async tx => {
    await assertNicuChartingEnabled(tx, tenant);
    const existing = unwrap(
      await tx.$queryRawUnsafe(
        `SELECT * FROM ${table} WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
        rowId,
        tenant
      )
    );
    if (!existing) throw AppError.notFound('NICU observation not found');
    if (existing.verification_status !== 'unverified') {
      throw AppError.conflict(
        'Only device-sourced unverified observations can be verified',
        'NICU_VERIFY_NOT_UNVERIFIED'
      );
    }
    const admission = await assertNicuAdmission(tx, tenant, existing.icu_admission_id);
    const rows = await tx.$queryRawUnsafe(
      `UPDATE ${table}
          SET verification_status = 'verified',
              verified_by = $3::uuid,
              verified_at = NOW(),
              updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2::uuid
        RETURNING *`,
      rowId,
      tenant,
      actorUid || null
    );
    const row = rows[0];
    await recordCanonicalPair(tx, {
      tenantId: tenant,
      admission,
      resourceTable: table,
      resourceId: row.id,
      eventType: 'nicu.observation_verified',
      action: 'nicu.observation.verified',
      actorUid,
      actorRole,
      summary: 'NICU device-sourced observation verified by clinician',
      payload: { resource, occurred_at: row.verified_at },
      beforeState: existing,
      afterState: row
    });
    return normalizeValue(row);
  });
}

// ── Newborn substrate link (maternity reuse) ───────────────────────────

export async function linkNewbornToAdmission({
  tenantId,
  icuAdmissionId,
  newbornId,
  actorUid,
  actorRole,
  metadata
}) {
  const tenant = tenantOr(tenantId);
  const newborn_id = toInt(newbornId, 'newborn_id');
  return setTenantTx(tenant, async tx => {
    await assertNicuChartingEnabled(tx, tenant);
    const admission = await assertNicuAdmission(tx, tenant, icuAdmissionId);
    const newborn = unwrap(
      await tx.$queryRawUnsafe(
        `SELECT id, delivery_id, birth_order, birth_datetime, newborn_patient_uid,
                outcome, resuscitation_done, resuscitation_type,
                breastfeeding_initiated_min, gestational_age_weeks, birth_weight_g
           FROM maternity_newborns
          WHERE id = $1 AND tenant_id = $2::uuid
          LIMIT 1`,
        newborn_id,
        tenant
      )
    );
    if (!newborn) throw AppError.notFound('Newborn record not found');
    if (!newborn.newborn_patient_uid) {
      throw AppError.conflict(
        'Newborn record has no linked patient yet — link the newborn patient in the maternity workflow first',
        'NICU_NEWBORN_PATIENT_LINK_REQUIRED'
      );
    }
    if (String(newborn.newborn_patient_uid) !== String(admission.patient_uid)) {
      throw AppError.conflict(
        'Newborn record belongs to a different patient than this NICU admission',
        'NICU_NEWBORN_PATIENT_MISMATCH'
      );
    }
    const existing = unwrap(
      await tx.$queryRawUnsafe(
        `SELECT id FROM nicu_admission_newborn_links
        WHERE tenant_id = $1::uuid AND icu_admission_id = $2 AND unlinked_at IS NULL
        LIMIT 1`,
        tenant,
        admission.id
      )
    );
    if (existing) {
      throw AppError.conflict(
        'This NICU admission already has an active newborn link',
        'NICU_NEWBORN_ALREADY_LINKED'
      );
    }
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO nicu_admission_newborn_links
         (tenant_id, icu_admission_id, newborn_id, patient_uid, linked_by, metadata)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6::jsonb)
       RETURNING *`,
      tenant,
      admission.id,
      newborn_id,
      admission.patient_uid,
      actorUid || null,
      json(metadata)
    );
    const row = rows[0];
    await recordCanonicalPair(tx, {
      tenantId: tenant,
      admission,
      resourceTable: 'nicu_admission_newborn_links',
      resourceId: row.id,
      eventType: 'nicu.newborn_linked',
      action: 'nicu.newborn.linked',
      actorUid,
      actorRole,
      summary: 'NICU admission linked to newborn birth record',
      payload: {
        newborn_id,
        delivery_id: newborn.delivery_id,
        birth_order: newborn.birth_order,
        occurred_at: row.linked_at
      },
      afterState: row
    });
    return normalizeValue(row);
  });
}

async function loadNewbornContext(tx, tenant, admission) {
  const link = unwrap(
    await tx.$queryRawUnsafe(
      `SELECT * FROM nicu_admission_newborn_links
      WHERE tenant_id = $1::uuid AND icu_admission_id = $2 AND unlinked_at IS NULL
      LIMIT 1`,
      tenant,
      admission.id
    )
  );
  if (!link) return { linked: false };
  const newborn = unwrap(
    await tx.$queryRawUnsafe(
      `SELECT id, delivery_id, birth_order, birth_datetime, sex, birth_weight_g,
              birth_length_cm, head_circumference_cm, gestational_age_weeks,
              outcome, resuscitation_done, resuscitation_type, newborn_patient_uid,
              cord_clamped_at_min, skin_to_skin_done, breastfeeding_initiated_min,
              vit_k_given, bcg_given, hep_b_given, opv_given,
              congenital_anomaly, congenital_anomaly_desc
         FROM maternity_newborns
        WHERE id = $1 AND tenant_id = $2::uuid
        LIMIT 1`,
      link.newborn_id,
      tenant
    )
  );
  const apgarScores = await tx.$queryRawUnsafe(
    `SELECT time_minute, appearance, pulse, grimace, activity, respiration,
            total_score, recorded_at
       FROM maternity_apgar_scores
      WHERE newborn_id = $1
      ORDER BY time_minute ASC`,
    link.newborn_id
  );
  const newbornImmunisations = await tx.$queryRawUnsafe(
    `SELECT ni.id, ni.due_date, ni.status, ni.given_at, vc.code, vc.display_name,
            vc.dose_number, vc.schedule_source, vc.source_version
       FROM newborn_immunisations ni
       JOIN vaccine_catalogue vc
         ON vc.id = ni.vaccine_catalogue_id AND vc.tenant_id = ni.tenant_id
      WHERE ni.newborn_id = $1 AND ni.tenant_id = $2::uuid
      ORDER BY ni.due_date ASC`,
    link.newborn_id,
    tenant
  );
  return {
    linked: true,
    link,
    record: newborn || null,
    apgar_scores: apgarScores || [],
    immunisations: newbornImmunisations || []
  };
}

export async function getNewbornContext({ tenantId, icuAdmissionId }) {
  const tenant = tenantOr(tenantId);
  return setTenantTx(tenant, async tx => {
    const admission = await assertNicuAdmission(tx, tenant, icuAdmissionId);
    return normalizeValue(await loadNewbornContext(tx, tenant, admission));
  });
}

// ── Owner-governed score definitions + outputs (decision support only) ──

export async function listScoreDefinitions({ tenantId, includeInactive = false }) {
  const tenant = tenantOr(tenantId);
  return setTenantTx(tenant, async tx => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT *
         FROM nicu_picu_score_definitions
        WHERE tenant_id = $1::uuid
          AND ($2::boolean = TRUE OR active = TRUE)
        ORDER BY score_kind ASC, created_at DESC`,
      tenant,
      includeInactive === true
    );
    return normalizeRows(rows);
  });
}

export async function upsertScoreDefinition({ tenantId, actorUid, ...body }) {
  if (!body.score_kind) throw AppError.badRequest('score_kind required');
  if (!body.display_name) throw AppError.badRequest('display_name required');
  const activate = body.active === true;
  if (activate && (!body.reference_source || !body.reference_version)) {
    throw AppError.badRequest(
      'reference_source and reference_version are required to activate a NICU/PICU score definition',
      'NICU_SCORE_REFERENCE_REQUIRED'
    );
  }
  // Sol Ultra Wave-E (NICU): activating a score definition attests the approver's
  // OWN decision — bind it to the authenticated actor, not a caller-supplied uid.
  const approvedBy = actorUid || null;
  if (activate && !approvedBy) {
    throw AppError.badRequest(
      'approved_by is required to activate a NICU/PICU score definition',
      'NICU_SCORE_APPROVER_REQUIRED'
    );
  }
  const tenant = tenantOr(tenantId);
  return setTenantTx(tenant, async tx => {
    if (activate) {
      await tx.$executeRawUnsafe(
        `UPDATE nicu_picu_score_definitions
            SET active = FALSE, retired_at = COALESCE(retired_at, NOW()), updated_at = NOW()
          WHERE tenant_id = $1::uuid AND score_kind = $2 AND active = TRUE`,
        tenant,
        body.score_kind
      );
    }
    const existing = unwrap(
      await tx.$queryRawUnsafe(
        `SELECT id FROM nicu_picu_score_definitions
        WHERE tenant_id = $1::uuid AND score_kind = $2
          AND COALESCE(reference_version, '') = COALESCE($3, '')
        LIMIT 1`,
        tenant,
        body.score_kind,
        body.reference_version || null
      )
    );
    let rows;
    if (existing) {
      rows = await tx.$queryRawUnsafe(
        `UPDATE nicu_picu_score_definitions
            SET display_name = $3,
                description = $4,
                age_scope = COALESCE($5, age_scope),
                source = COALESCE($6, source),
                reference_source = $7,
                reference_snapshot = $8::jsonb,
                approved_by = CASE WHEN $9 THEN $10::uuid ELSE approved_by END,
                approved_at = CASE WHEN $9 THEN NOW() ELSE approved_at END,
                active = $9,
                retired_at = CASE WHEN $9 THEN NULL ELSE retired_at END,
                metadata = $11::jsonb,
                updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2::uuid
          RETURNING *`,
        existing.id,
        tenant,
        body.display_name,
        body.description || null,
        body.age_scope || null,
        body.source || null,
        body.reference_source || null,
        json(body.reference_snapshot),
        activate,
        approvedBy,
        json(body.metadata)
      );
    } else {
      rows = await tx.$queryRawUnsafe(
        `INSERT INTO nicu_picu_score_definitions
           (tenant_id, score_kind, display_name, description, age_scope, source,
            reference_source, reference_version, reference_snapshot,
            approved_by, approved_at, active, metadata)
         VALUES ($1::uuid, $2, $3, $4, COALESCE($5, 'neonatal'),
                 COALESCE($6, 'operator_supplied'), $7, $8, $9::jsonb,
                 CASE WHEN $10 THEN $11::uuid ELSE NULL END,
                 CASE WHEN $10 THEN NOW() ELSE NULL END,
                 $10, $12::jsonb)
         RETURNING *`,
        tenant,
        body.score_kind,
        body.display_name,
        body.description || null,
        body.age_scope || null,
        body.source || null,
        body.reference_source || null,
        body.reference_version || null,
        json(body.reference_snapshot),
        activate,
        approvedBy,
        json(body.metadata)
      );
    }
    const row = rows[0];
    await recordIcuAudit(tx, {
      tenantId: tenant,
      action: activate ? 'nicu_score_definition.activated' : 'nicu_score_definition.upserted',
      actorUid,
      resourceTable: 'nicu_picu_score_definitions',
      resourceId: row.id,
      afterState: row,
      metadata: { score_kind: body.score_kind, active: activate }
    });
    return normalizeValue(row);
  });
}

export async function recordScoreOutput({
  tenantId,
  icuAdmissionId,
  actorUid,
  actorRole,
  ...body
}) {
  if (!body.score_kind) throw AppError.badRequest('score_kind required');
  const wantsUnavailable =
    body.score_available === false || body.review_status === 'score_unavailable';
  if (wantsUnavailable && !body.unavailable_reason) {
    throw AppError.badRequest(
      'unavailable_reason required when recording a score-unavailable row'
    );
  }
  const tenant = tenantOr(tenantId);
  return setTenantTx(tenant, async tx => {
    await assertNicuChartingEnabled(tx, tenant);
    const admission = await assertNicuAdmission(tx, tenant, icuAdmissionId);

    let definition = null;
    if (!wantsUnavailable) {
      definition = unwrap(
        await tx.$queryRawUnsafe(
          `SELECT id, score_kind, reference_source, reference_version
           FROM nicu_picu_score_definitions
          WHERE tenant_id = $1::uuid AND score_kind = $2 AND active = TRUE
          LIMIT 1`,
          tenant,
          body.score_kind
        )
      );
      // Fail closed: no owner-approved definition means no score value —
      // never fall back to locally computed or caller-supplied references.
      if (!definition) {
        throw AppError.conflict(
          'Score unavailable — no owner-approved definition for this score kind',
          'NICU_SCORE_UNAVAILABLE'
        );
      }
      // Sol Ultra Wave-E (NICU): a score review attests the reviewer's OWN
      // reading — bind reviewer_uid to the authenticated actor, not a
      // caller-supplied value.
      if (!actorUid) {
        throw AppError.badRequest(
          'an authenticated reviewer is required for NICU/PICU score outputs',
          'NICU_SCORE_REVIEWER_REQUIRED'
        );
      }
      if (body.score_value == null) {
        throw AppError.badRequest('score_value required for available score outputs');
      }
    }

    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO nicu_picu_scoring_outputs
         (tenant_id, icu_admission_id, patient_uid, score_definition_id,
          score_kind, recorded_at, input_facts, score_value, score_label,
          output_payload, reference_source, reference_version, reviewer_uid,
          reviewer_role, reviewed_at, review_status, score_available,
          unavailable_reason, order_mutation_performed, recorded_by, metadata)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, COALESCE($6::timestamptz, NOW()),
               $7::jsonb, $8, $9, $10::jsonb, $11, $12, $13::uuid, $14,
               CASE WHEN $13::uuid IS NULL THEN NULL ELSE COALESCE($15::timestamptz, NOW()) END,
               $16, $17, $18, FALSE, $19::uuid, $20::jsonb)
       RETURNING *`,
      tenant,
      admission.id,
      admission.patient_uid,
      definition ? Number(definition.id) : null,
      body.score_kind,
      body.recorded_at || null,
      json(body.input_facts),
      wantsUnavailable ? null : (body.score_value ?? null),
      body.score_label || null,
      json(body.output_payload),
      definition ? definition.reference_source : null,
      definition ? definition.reference_version : null,
      wantsUnavailable ? null : (actorUid || null),
      body.reviewer_role || null,
      body.reviewed_at || null,
      wantsUnavailable ? 'score_unavailable' : body.review_status || 'reviewed',
      !wantsUnavailable,
      wantsUnavailable ? body.unavailable_reason : null,
      actorUid || body.recorded_by || null,
      json(body.metadata)
    );
    const row = rows[0];
    await recordCanonicalPair(tx, {
      tenantId: tenant,
      admission,
      resourceTable: 'nicu_picu_scoring_outputs',
      resourceId: row.id,
      eventType: 'nicu.score_recorded',
      action: 'nicu.score.recorded',
      actorUid,
      actorRole,
      summary: `NICU/PICU ${body.score_kind} decision-support output recorded`,
      payload: {
        score_kind: body.score_kind,
        score_available: !wantsUnavailable,
        review_status: row.review_status,
        reference_version: definition ? definition.reference_version : null,
        order_mutation_performed: false,
        occurred_at: row.recorded_at
      },
      afterState: row
    });
    return normalizeValue(row);
  });
}

export async function listScoreOutputs({ tenantId, icuAdmissionId, scoreKind = null }) {
  const tenant = tenantOr(tenantId);
  return setTenantTx(tenant, async tx => {
    const admission = await assertNicuAdmission(tx, tenant, icuAdmissionId);
    const params = [tenant, admission.id];
    let kindFilter = '';
    if (scoreKind) {
      params.push(scoreKind);
      kindFilter = ` AND score_kind = $${params.length}`;
    }
    const rows = await tx.$queryRawUnsafe(
      `SELECT *
         FROM nicu_picu_scoring_outputs
        WHERE tenant_id = $1::uuid
          AND icu_admission_id = $2
          ${kindFilter}
        ORDER BY recorded_at DESC`,
      ...params
    );
    return normalizeRows(rows);
  });
}

// ── NL-5 growth pack consumption ───────────────────────────────────────

async function loadGrowthSnapshot(tx, tenant, admission) {
  const patient = unwrap(
    await tx.$queryRawUnsafe(
      `SELECT uid, birthday, gender FROM users WHERE uid = $1::uuid LIMIT 1`,
      admission.patient_uid
    )
  );
  const weightRow = unwrap(
    await tx.$queryRawUnsafe(
      `SELECT weight_grams, recorded_at
         FROM nicu_feed_fluid_entries
        WHERE tenant_id = $1::uuid
          AND icu_admission_id = $2
          AND entry_kind = 'weight'
        ORDER BY recorded_at DESC
        LIMIT 1`,
      tenant,
      admission.id
    )
  );
  const sex = normaliseSex(patient?.gender);
  if (!patient?.birthday || !sex || !weightRow?.weight_grams) {
    return {
      available: false,
      reason: !weightRow?.weight_grams
        ? 'no_weight_entry'
        : !patient?.birthday
          ? 'missing_date_of_birth'
          : 'missing_sex'
    };
  }
  const ageInDays = ageInDaysFrom(patient.birthday, weightRow.recorded_at || new Date());
  const weightKg = Number(weightRow.weight_grams) / 1000;
  // NL-5 pack consumption: growth_reference_lms rows when imported; the
  // service labels its embedded approximation fallback explicitly
  // (source 'WHO_0_5_approx' + note) and that label passes through untouched.
  const percentile = await computePercentile({
    sex,
    ageInDays,
    metric: 'weight_kg',
    value: weightKg
  });
  return {
    available: true,
    metric: 'weight_kg',
    value_kg: +weightKg.toFixed(3),
    age_in_days: ageInDays,
    sex,
    weight_recorded_at: weightRow.recorded_at,
    ...percentile
  };
}

export async function getGrowthSnapshot({ tenantId, icuAdmissionId }) {
  const tenant = tenantOr(tenantId);
  return setTenantTx(tenant, async tx => {
    const admission = await assertNicuAdmission(tx, tenant, icuAdmissionId);
    return normalizeValue(await loadGrowthSnapshot(tx, tenant, admission));
  });
}

// ── Composite NICU/PICU chart view (extends the P1 ICU chart view) ─────

export async function getNicuPicuChartView({ tenantId, icuAdmissionId, hours = 24, at = null }) {
  const tenant = tenantOr(tenantId);
  // Unit gate first (Phase 0 pre-flight on plain prisma, tenant-scoped predicate).
  await assertNicuAdmission(prisma, tenant, icuAdmissionId);
  // P1 substrate view: manual flowsheet, device vitals (with unverified
  // badges), NEWS2, MAR sedation refs, ventilation, weaning, lines, ICU
  // scores, device observation links.
  const substrate = await getIcuChartView({ tenantId: tenant, icuAdmissionId, hours, at });
  const { start, end, hours: h } = windowFrom({ hours, at });

  const nicu = await setTenantTx(tenant, async tx => {
    const admission = await assertNicuAdmission(tx, tenant, icuAdmissionId);
    const [settings, feedFluid, respSupport, cardioresp, jaundice, thermal, scoreDefs, scores] =
      await Promise.all([
        tx.$queryRawUnsafe(
          `SELECT * FROM nicu_picu_chart_settings WHERE tenant_id = $1::uuid`,
          tenant
        ),
        tx.$queryRawUnsafe(
          `SELECT *
           FROM nicu_feed_fluid_entries
          WHERE tenant_id = $1::uuid AND icu_admission_id = $2
            AND recorded_at BETWEEN $3::timestamptz AND $4::timestamptz
          ORDER BY recorded_at ASC`,
          tenant,
          admission.id,
          start.toISOString(),
          end.toISOString()
        ),
        tx.$queryRawUnsafe(
          `SELECT *
           FROM nicu_respiratory_support_observations
          WHERE tenant_id = $1::uuid AND icu_admission_id = $2
            AND observed_at BETWEEN $3::timestamptz AND $4::timestamptz
          ORDER BY observed_at DESC`,
          tenant,
          admission.id,
          start.toISOString(),
          end.toISOString()
        ),
        tx.$queryRawUnsafe(
          `SELECT *
           FROM nicu_cardiorespiratory_events
          WHERE tenant_id = $1::uuid AND icu_admission_id = $2
            AND started_at BETWEEN $3::timestamptz AND $4::timestamptz
          ORDER BY started_at DESC`,
          tenant,
          admission.id,
          start.toISOString(),
          end.toISOString()
        ),
        tx.$queryRawUnsafe(
          `SELECT *
           FROM nicu_jaundice_phototherapy_events
          WHERE tenant_id = $1::uuid AND icu_admission_id = $2
            AND occurred_at BETWEEN $3::timestamptz AND $4::timestamptz
          ORDER BY occurred_at DESC`,
          tenant,
          admission.id,
          start.toISOString(),
          end.toISOString()
        ),
        tx.$queryRawUnsafe(
          `SELECT *
           FROM nicu_thermal_environment_observations
          WHERE tenant_id = $1::uuid AND icu_admission_id = $2
            AND observed_at BETWEEN $3::timestamptz AND $4::timestamptz
          ORDER BY observed_at DESC`,
          tenant,
          admission.id,
          start.toISOString(),
          end.toISOString()
        ),
        tx.$queryRawUnsafe(
          `SELECT id, score_kind, display_name, age_scope, source,
                reference_source, reference_version, approved_by, approved_at, active
           FROM nicu_picu_score_definitions
          WHERE tenant_id = $1::uuid AND active = TRUE
          ORDER BY score_kind ASC`,
          tenant
        ),
        tx.$queryRawUnsafe(
          `SELECT *
           FROM nicu_picu_scoring_outputs
          WHERE tenant_id = $1::uuid AND icu_admission_id = $2
            AND recorded_at BETWEEN $3::timestamptz AND $4::timestamptz
          ORDER BY recorded_at DESC`,
          tenant,
          admission.id,
          start.toISOString(),
          end.toISOString()
        )
      ]);

    // NL-5 immunisation pack consumption: read-only view of the patient's
    // scheduled doses with pack provenance. Walk-ins/transfers surface via
    // patient_immunisations (mig 179); no seeding writes inside a chart read.
    const immunisationsDue = await tx.$queryRawUnsafe(
      `SELECT pi.id, pi.due_date, pi.status, vc.code, vc.display_name,
              vc.dose_number, vc.schedule_source, vc.source_version
         FROM patient_immunisations pi
         JOIN vaccine_catalogue vc
           ON vc.id = pi.vaccine_catalogue_id AND vc.tenant_id = pi.tenant_id
        WHERE pi.patient_uid = $1::uuid
          AND pi.tenant_id = $2::uuid
          AND pi.status = 'scheduled'
        ORDER BY pi.due_date ASC
        LIMIT 50`,
      admission.patient_uid,
      tenant
    );

    const newborn = await loadNewbornContext(tx, tenant, admission);
    const growth = await loadGrowthSnapshot(tx, tenant, admission);

    const feedFluidRows = normalizeRows(feedFluid);
    const balance = computeFeedFluidBalance(feedFluidRows, { windowHours: h });
    const allDeviceRows = [
      ...normalizeRows(respSupport),
      ...normalizeRows(cardioresp),
      ...normalizeRows(jaundice),
      ...normalizeRows(thermal),
      ...feedFluidRows
    ];
    const unverifiedCount = allDeviceRows.filter(
      row => row.verification_status === 'unverified'
    ).length;

    return normalizeValue({
      settings: unwrap(settings) || {
        enabled: false,
        content_source: 'unavailable',
        specialty_view_policy: {},
        scoring_governance: {},
        device_fleet_snapshot: {}
      },
      feed_fluid: { entries: feedFluidRows, balance },
      respiratory_support: respSupport,
      cardiorespiratory_events: cardioresp,
      jaundice_phototherapy: jaundice,
      thermal_observations: thermal,
      scoring: { definitions: scoreDefs, outputs: scores },
      newborn,
      growth,
      immunisations_due: immunisationsDue,
      summary: {
        feed_fluid_entry_count: feedFluidRows.length,
        respiratory_support_count: respSupport.length,
        cardiorespiratory_event_count: cardioresp.length,
        jaundice_phototherapy_count: jaundice.length,
        thermal_observation_count: thermal.length,
        score_output_count: scores.length,
        approved_score_definition_count: scoreDefs.length,
        unverified_nicu_observation_count: unverifiedCount,
        intake_ml_per_kg: balance.per_kg ? balance.per_kg.intake_ml_per_kg : null,
        net_ml_per_kg: balance.per_kg ? balance.per_kg.net_ml_per_kg : null
      }
    });
  });

  return { ...substrate, nicu };
}

export default {
  getNicuChartSettings,
  setNicuChartSettings,
  recordFeedFluidEntry,
  listFeedFluidEntries,
  computeFeedFluidBalance,
  getFeedFluidBalance,
  recordRespiratorySupportObservation,
  listRespiratorySupportObservations,
  recordCardiorespiratoryEvent,
  listCardiorespiratoryEvents,
  recordJaundicePhototherapyEvent,
  listJaundicePhototherapyEvents,
  recordThermalObservation,
  listThermalObservations,
  verifyNicuObservation,
  linkNewbornToAdmission,
  getNewbornContext,
  listScoreDefinitions,
  upsertScoreDefinition,
  recordScoreOutput,
  listScoreOutputs,
  getGrowthSnapshot,
  getNicuPicuChartView
};
