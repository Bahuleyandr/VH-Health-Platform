import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  recordClinicalAuditEvent,
  recordTimelineEvent
} from './canonicalClinicalPlatformService.js';

const DENOMINATOR_KIND = {
  central_line: 'central_line',
  urinary_catheter: 'urinary_catheter',
  ventilator: 'ventilator',
  ett: 'ventilator',
  tracheostomy: 'ventilator'
};

const SEDATION_MAR_MATCHES = [
  '%propofol%',
  '%midazolam%',
  '%fentanyl%',
  '%dexmedetomidine%',
  '%morphine%',
  '%ketamine%',
  '%noradrenaline%',
  '%norepinephrine%',
  '%adrenaline%',
  '%epinephrine%',
  '%vasopressin%',
  '%dobutamine%'
];

function presentIcuNews2(row) {
  if (row?.partial_score !== true) return { ...row, risk_band_available: true };
  return {
    ...row,
    clinical_risk: null,
    escalation_action: null,
    risk_band_available: false,
    display: `NEWS2 ${row.total_score} (partial; risk band unavailable)`,
  };
}

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

function asIso(value) {
  return value ? new Date(value).toISOString() : null;
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

async function assertAdmission(tx, tenantId, icuAdmissionId) {
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
  return admission;
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
      tags: ['icu', 'nl14'],
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
      'Canonical ICU timeline/audit write failed',
      'ICU_CANONICAL_WRITE_FAILED'
    );
  }
}

function requireReviewerForScore(body) {
  const protocolAvailable =
    body.protocol_available !== false && body.review_status !== 'protocol_unavailable';
  if (!protocolAvailable) {
    if (!body.unavailable_reason) {
      throw AppError.badRequest('unavailable_reason required when protocol/score is unavailable');
    }
    return false;
  }
  if (!body.reference_source || !body.reference_version || !body.reviewer_uid) {
    throw AppError.badRequest(
      'reference_source, reference_version, and reviewer_uid are required for ICU score outputs',
      'ICU_SCORE_REFERENCE_REQUIRED'
    );
  }
  return true;
}

export async function getChartSettings({ tenantId }) {
  const rows = await setTenantTx(tenantOr(tenantId), tx =>
    tx.$queryRawUnsafe(
      `SELECT *
       FROM icu_chart_settings
      WHERE tenant_id = $1::uuid`,
      tenantOr(tenantId)
    )
  );
  return (
    normalizeValue(unwrap(rows)) || {
      tenant_id: tenantOr(tenantId),
      enabled: false,
      charting_policy: {},
      alarm_policy_snapshot: {},
      scoring_governance: {},
      protocol_content_source: 'unavailable'
    }
  );
}

export async function setChartSettings({
  tenantId,
  enabled,
  charting_policy,
  alarm_policy_snapshot,
  scoring_governance,
  protocol_content_source,
  acceptance_snapshot,
  actorUid
}) {
  if (enabled === true && (!acceptance_snapshot || !actorUid)) {
    throw AppError.badRequest(
      'acceptance_snapshot and actorUid are required to enable ICU charting'
    );
  }
  return setTenantTx(tenantOr(tenantId), async tx => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO icu_chart_settings
         (tenant_id, enabled, charting_policy, alarm_policy_snapshot, scoring_governance,
          protocol_content_source, enabled_at, enabled_by, acceptance_snapshot, updated_at)
       VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6,
               CASE WHEN $2 THEN NOW() ELSE NULL END,
               CASE WHEN $2 THEN $7::uuid ELSE NULL END,
               CASE WHEN $2 THEN $8::jsonb ELSE NULL END,
               NOW())
       ON CONFLICT (tenant_id) DO UPDATE SET
         enabled = $2,
         charting_policy = $3::jsonb,
         alarm_policy_snapshot = $4::jsonb,
         scoring_governance = $5::jsonb,
         protocol_content_source = $6,
         enabled_at = CASE WHEN $2 THEN COALESCE(icu_chart_settings.enabled_at, NOW()) ELSE icu_chart_settings.enabled_at END,
         enabled_by = CASE WHEN $2 THEN $7::uuid ELSE icu_chart_settings.enabled_by END,
         acceptance_snapshot = CASE WHEN $2 THEN $8::jsonb ELSE icu_chart_settings.acceptance_snapshot END,
         updated_at = NOW()
       RETURNING *`,
      tenantOr(tenantId),
      enabled === true,
      json(charting_policy),
      json(alarm_policy_snapshot),
      json(scoring_governance),
      protocol_content_source || 'nl5_content_studio',
      actorUid || null,
      json(acceptance_snapshot, null)
    );
    await recordIcuAudit(tx, {
      tenantId,
      action: 'icu_chart.settings_updated',
      actorUid,
      resourceTable: 'icu_chart_settings',
      resourceId: tenantOr(tenantId),
      afterState: rows[0],
      metadata: { enabled: enabled === true }
    });
    return normalizeValue(rows[0]);
  });
}

export async function getIcuChartView({ tenantId, icuAdmissionId, hours = 24, at = null }) {
  const tenant = tenantOr(tenantId);
  const h = Math.min(Math.max(parseInt(hours, 10) || 24, 1), 168);
  const end = at ? new Date(at) : new Date();
  const start = new Date(end.getTime() - h * 60 * 60 * 1000);

  return setTenantTx(tenant, async tx => {
    const admission = await assertAdmission(tx, tenant, icuAdmissionId);
    const patientUid = admission.patient_uid;
    const [settings, manual, deviceVitals, news2, mar, ventilation, weaning, lines, scores, links] =
      await Promise.all([
        tx.$queryRawUnsafe(`SELECT * FROM icu_chart_settings WHERE tenant_id = $1::uuid`, tenant),
        tx.$queryRawUnsafe(
          `SELECT *
           FROM icu_flowsheet_entries
          WHERE tenant_id = $1::uuid
            AND icu_admission_id = $2
            AND recorded_at BETWEEN $3::timestamptz AND $4::timestamptz
          ORDER BY recorded_at ASC`,
          tenant,
          admission.id,
          start.toISOString(),
          end.toISOString()
        ),
        tx.$queryRawUnsafe(
          `SELECT id, patient_uid, recorded_at, heart_rate, systolic_bp, diastolic_bp,
                temperature, spo2, respiratory_rate, gcs_score, source_device,
                device_verified, verified_by, verified_at, notes
           FROM vitals_chart
          WHERE tenant_id = $1::uuid
            AND patient_uid = $2::uuid
            AND source = 'device'
            AND recorded_at BETWEEN $3::timestamptz AND $4::timestamptz
          ORDER BY recorded_at ASC`,
          tenant,
          patientUid,
          start.toISOString(),
          end.toISOString()
        ),
        tx.$queryRawUnsafe(
          `SELECT id, patient_uid, recorded_at, total_score, clinical_risk, escalation_action,
                  partial_score, missing_params
           FROM news2_scores
          WHERE tenant_id = $1::uuid
            AND patient_uid = $2::uuid
            AND superseded_at IS NULL
            AND recorded_at BETWEEN $3::timestamptz AND $4::timestamptz
          ORDER BY recorded_at DESC`,
          tenant,
          patientUid,
          start.toISOString(),
          end.toISOString()
        ),
        tx.$queryRawUnsafe(
          `SELECT id, medication_name, dose, dosage, route, scheduled_time, administered_at,
                administered_by, status, notes
           FROM medication_administrations
          WHERE tenant_id = $1::uuid
            AND patient_uid = $2::uuid
            AND COALESCE(administered_at, scheduled_time, created_at)
                BETWEEN $3::timestamptz AND $4::timestamptz
            AND lower(medication_name) LIKE ANY($5::text[])
          ORDER BY COALESCE(administered_at, scheduled_time, created_at) DESC`,
          tenant,
          patientUid,
          start.toISOString(),
          end.toISOString(),
          SEDATION_MAR_MATCHES
        ),
        tx.$queryRawUnsafe(
          `SELECT *
           FROM icu_ventilation_episodes
          WHERE tenant_id = $1::uuid
            AND icu_admission_id = $2
            AND started_at <= $4::timestamptz
            AND COALESCE(stopped_at, $4::timestamptz) >= $3::timestamptz
          ORDER BY started_at DESC`,
          tenant,
          admission.id,
          start.toISOString(),
          end.toISOString()
        ),
        tx.$queryRawUnsafe(
          `SELECT *
           FROM icu_weaning_trials
          WHERE tenant_id = $1::uuid
            AND icu_admission_id = $2
            AND created_at BETWEEN $3::timestamptz AND $4::timestamptz
          ORDER BY created_at DESC`,
          tenant,
          admission.id,
          start.toISOString(),
          end.toISOString()
        ),
        tx.$queryRawUnsafe(
          `SELECT *
           FROM icu_line_tube_drain_events
          WHERE tenant_id = $1::uuid
            AND icu_admission_id = $2
            AND started_at <= $4::timestamptz
            AND COALESCE(stopped_at, $4::timestamptz) >= $3::timestamptz
          ORDER BY COALESCE(stopped_at, started_at) DESC`,
          tenant,
          admission.id,
          start.toISOString(),
          end.toISOString()
        ),
        tx.$queryRawUnsafe(
          `SELECT *
           FROM icu_scoring_outputs
          WHERE tenant_id = $1::uuid
            AND icu_admission_id = $2
            AND recorded_at BETWEEN $3::timestamptz AND $4::timestamptz
          ORDER BY recorded_at DESC`,
          tenant,
          admission.id,
          start.toISOString(),
          end.toISOString()
        ),
        tx.$queryRawUnsafe(
          `SELECT l.*, vc.recorded_at AS vitals_recorded_at, vc.device_verified,
                obs.vital_name, obs.severity, obs.observed_at,
                dr.display_name AS device_name
           FROM icu_device_observation_links l
           LEFT JOIN vitals_chart vc ON vc.id = l.vitals_chart_id
           LEFT JOIN device_vital_sample_observations obs ON obs.id = l.sample_observation_id
           LEFT JOIN device_registry dr ON dr.id = COALESCE(l.device_registry_id, obs.device_registry_id)
          WHERE l.tenant_id = $1::uuid
            AND l.icu_admission_id = $2
          ORDER BY l.linked_at DESC`,
          tenant,
          admission.id
        )
      ]);

    const normalizedDeviceVitals = normalizeRows(deviceVitals);
    const normalizedLines = normalizeRows(lines);
    const unverified = normalizedDeviceVitals.filter(row => row.device_verified === false);
    const activeDenominator = normalizedLines.filter(
      row => row.denominator_device_type && !row.stopped_at
    );
    return normalizeValue({
      admission,
      window: { start: start.toISOString(), end: end.toISOString(), hours: h },
      policy: unwrap(settings) || {
        enabled: false,
        protocol_content_source: 'unavailable',
        charting_policy: {},
        scoring_governance: {}
      },
      manual_flowsheet: manual,
      device_vitals: normalizedDeviceVitals,
      news2_scores: news2.map(presentIcuNews2),
      mar_sedation_refs: mar,
      ventilation_episodes: ventilation,
      weaning_trials: weaning,
      line_presence: normalizedLines,
      scoring_outputs: scores,
      device_observation_links: links,
      summary: {
        manual_flowsheet_count: manual.length,
        device_vitals_count: normalizedDeviceVitals.length,
        unverified_device_vitals_count: unverified.length,
        active_line_count: normalizedLines.filter(row => !row.stopped_at).length,
        active_denominator_device_count: activeDenominator.length,
        ventilation_episode_count: ventilation.length,
        weaning_trial_count: weaning.length,
        scoring_output_count: scores.length
      }
    });
  });
}

export async function createVentilationEpisode({
  tenantId,
  icuAdmissionId,
  actorUid,
  actorRole,
  ...body
}) {
  if (!body.mode) throw AppError.badRequest('mode required');
  const tenant = tenantOr(tenantId);
  return setTenantTx(tenant, async tx => {
    const admission = await assertAdmission(tx, tenant, icuAdmissionId);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO icu_ventilation_episodes
         (tenant_id, icu_admission_id, admission_id, patient_uid, mode, oxygen_device,
          airway_type, started_at, start_reason, settings, responsible_clinician_uid,
          responsible_clinician_name, started_by, linked_mar_administration_ids, metadata)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7,
               COALESCE($8::timestamptz, NOW()), $9, $10::jsonb, $11::uuid,
               $12, $13::uuid, $14::integer[], $15::jsonb)
       RETURNING *`,
      tenant,
      admission.id,
      admission.admission_id || null,
      admission.patient_uid,
      body.mode,
      body.oxygen_device || null,
      body.airway_type || null,
      body.started_at || null,
      body.start_reason || null,
      json(body.settings),
      body.responsible_clinician_uid || null,
      body.responsible_clinician_name || null,
      actorUid || body.started_by || null,
      Array.isArray(body.linked_mar_administration_ids)
        ? body.linked_mar_administration_ids.map(Number)
        : [],
      json(body.metadata)
    );
    const row = rows[0];
    await recordCanonicalPair(tx, {
      tenantId: tenant,
      admission,
      resourceTable: 'icu_ventilation_episodes',
      resourceId: row.id,
      eventType: 'icu.ventilation_started',
      action: 'icu.ventilation.started',
      actorUid,
      actorRole,
      summary: `ICU ventilation started (${body.mode})`,
      payload: { mode: body.mode, oxygen_device: body.oxygen_device, occurred_at: row.started_at },
      afterState: row
    });
    await recordIcuAudit(tx, {
      tenantId: tenant,
      patientUid: admission.patient_uid,
      icuAdmissionId: admission.id,
      action: 'icu.ventilation.started',
      actorUid,
      resourceTable: 'icu_ventilation_episodes',
      resourceId: row.id,
      afterState: row
    });
    return normalizeValue(row);
  });
}

export async function stopVentilationEpisode({
  tenantId,
  episodeId,
  actorUid,
  actorRole,
  stopped_at,
  stop_reason
}) {
  const tenant = tenantOr(tenantId);
  const id = toInt(episodeId, 'episodeId');
  return setTenantTx(tenant, async tx => {
    const existing = unwrap(
      await tx.$queryRawUnsafe(
        `SELECT * FROM icu_ventilation_episodes WHERE id = $1 AND tenant_id = $2::uuid`,
        id,
        tenant
      )
    );
    if (!existing) throw AppError.notFound('ICU ventilation episode not found');
    const admission = await assertAdmission(tx, tenant, existing.icu_admission_id);
    const rows = await tx.$queryRawUnsafe(
      `UPDATE icu_ventilation_episodes
          SET stopped_at = COALESCE($3::timestamptz, NOW()),
              stop_reason = $4,
              stopped_by = $5::uuid,
              updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2::uuid
        RETURNING *`,
      id,
      tenant,
      stopped_at || null,
      stop_reason || null,
      actorUid || null
    );
    const row = rows[0];
    await recordCanonicalPair(tx, {
      tenantId: tenant,
      admission,
      resourceTable: 'icu_ventilation_episodes',
      resourceId: row.id,
      eventType: 'icu.ventilation_stopped',
      action: 'icu.ventilation.stopped',
      actorUid,
      actorRole,
      summary: 'ICU ventilation episode stopped',
      payload: { stop_reason, occurred_at: row.stopped_at },
      beforeState: existing,
      afterState: row
    });
    return normalizeValue(row);
  });
}

export async function listVentilationEpisodes({ tenantId, icuAdmissionId }) {
  const tenant = tenantOr(tenantId);
  return setTenantTx(tenant, async tx => {
    const admission = await assertAdmission(tx, tenant, icuAdmissionId);
    const rows = await tx.$queryRawUnsafe(
      `SELECT *
         FROM icu_ventilation_episodes
        WHERE tenant_id = $1::uuid AND icu_admission_id = $2
        ORDER BY started_at DESC`,
      tenant,
      admission.id
    );
    return normalizeRows(rows);
  });
}

export async function recordWeaningTrial({
  tenantId,
  icuAdmissionId,
  actorUid,
  actorRole,
  ...body
}) {
  const tenant = tenantOr(tenantId);
  return setTenantTx(tenant, async tx => {
    const admission = await assertAdmission(tx, tenant, icuAdmissionId);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO icu_weaning_trials
         (tenant_id, icu_admission_id, ventilation_episode_id, patient_uid,
          trial_kind, readiness_status, started_at, ended_at, outcome, reason,
          criteria_snapshot, protocol_reference, reviewer_uid, reviewed_at,
          recorded_by, metadata)
       VALUES ($1::uuid, $2, $3, $4::uuid, COALESCE($5, 'sbt'), COALESCE($6, 'not_assessed'),
               $7::timestamptz, $8::timestamptz, $9, $10, $11::jsonb, $12::jsonb,
               $13::uuid, CASE WHEN $13::uuid IS NULL THEN NULL ELSE COALESCE($14::timestamptz, NOW()) END,
               $15::uuid, $16::jsonb)
       RETURNING *`,
      tenant,
      admission.id,
      body.ventilation_episode_id
        ? toInt(body.ventilation_episode_id, 'ventilation_episode_id')
        : null,
      admission.patient_uid,
      body.trial_kind || 'sbt',
      body.readiness_status || 'not_assessed',
      body.started_at || null,
      body.ended_at || null,
      body.outcome || null,
      body.reason || null,
      json(body.criteria_snapshot),
      json(body.protocol_reference),
      body.reviewer_uid || null,
      body.reviewed_at || null,
      actorUid || body.recorded_by || null,
      json(body.metadata)
    );
    const row = rows[0];
    await recordCanonicalPair(tx, {
      tenantId: tenant,
      admission,
      resourceTable: 'icu_weaning_trials',
      resourceId: row.id,
      eventType: 'icu.weaning_trial_recorded',
      action: 'icu.weaning_trial.recorded',
      actorUid,
      actorRole,
      summary: `ICU ${row.trial_kind} recorded (${row.readiness_status})`,
      payload: {
        readiness_status: row.readiness_status,
        outcome: row.outcome,
        occurred_at: row.created_at
      },
      afterState: row
    });
    return normalizeValue(row);
  });
}

export async function listWeaningTrials({ tenantId, icuAdmissionId }) {
  const tenant = tenantOr(tenantId);
  return setTenantTx(tenant, async tx => {
    const admission = await assertAdmission(tx, tenant, icuAdmissionId);
    return normalizeRows(
      await tx.$queryRawUnsafe(
        `SELECT *
         FROM icu_weaning_trials
        WHERE tenant_id = $1::uuid AND icu_admission_id = $2
        ORDER BY created_at DESC`,
        tenant,
        admission.id
      )
    );
  });
}

export async function startLinePresence({
  tenantId,
  icuAdmissionId,
  actorUid,
  actorRole,
  ...body
}) {
  const tenant = tenantOr(tenantId);
  const presenceKind = body.presence_kind;
  if (!presenceKind) throw AppError.badRequest('presence_kind required');
  const denominatorType =
    body.denominator_device_type === null
      ? null
      : body.denominator_device_type || DENOMINATOR_KIND[presenceKind] || null;

  return setTenantTx(tenant, async tx => {
    const admission = await assertAdmission(tx, tenant, icuAdmissionId);
    if (denominatorType && !admission.admission_id) {
      throw AppError.badRequest(
        'ICU admission must be linked to an inpatient admission before denominator device presence can be charted',
        'ICU_DENOMINATOR_ADMISSION_REQUIRED'
      );
    }

    let presenceLogId = null;
    if (denominatorType) {
      const logRows = await tx.$queryRawUnsafe(
        `INSERT INTO device_presence_logs
           (tenant_id, admission_id, patient_uid, device_type, device_label,
            started_at, inserted_by, notes)
         VALUES ($1::uuid, $2, $3::uuid, $4, $5, COALESCE($6::timestamptz, NOW()), $7::uuid, $8)
         RETURNING id`,
        tenant,
        admission.admission_id,
        admission.patient_uid,
        denominatorType,
        body.display_label || body.site || presenceKind,
        body.started_at || null,
        actorUid || body.inserted_by || null,
        body.start_reason || null
      );
      presenceLogId = logRows[0]?.id || null;
    }

    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO icu_line_tube_drain_events
         (tenant_id, icu_admission_id, admission_id, patient_uid, presence_kind,
          display_label, site, denominator_device_type, started_at, start_reason,
          inserted_by, source, device_presence_log_id, evidence, metadata)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7, $8,
               COALESCE($9::timestamptz, NOW()), $10, $11::uuid, COALESCE($12, 'manual'),
               $13, $14::jsonb, $15::jsonb)
       RETURNING *`,
      tenant,
      admission.id,
      admission.admission_id || null,
      admission.patient_uid,
      presenceKind,
      body.display_label || null,
      body.site || null,
      denominatorType,
      body.started_at || null,
      body.start_reason || null,
      actorUid || body.inserted_by || null,
      body.source || 'manual',
      presenceLogId,
      json(body.evidence),
      json(body.metadata)
    );
    const row = rows[0];
    await recordCanonicalPair(tx, {
      tenantId: tenant,
      admission,
      resourceTable: 'icu_line_tube_drain_events',
      resourceId: row.id,
      eventType: 'icu.line_presence_started',
      action: 'icu.line_presence.started',
      actorUid,
      actorRole,
      summary: `ICU ${presenceKind.replaceAll('_', ' ')} started`,
      payload: {
        presence_kind: presenceKind,
        denominator_device_type: denominatorType,
        device_presence_log_id: presenceLogId,
        occurred_at: row.started_at
      },
      afterState: row
    });
    return normalizeValue(row);
  });
}

export async function stopLinePresence({
  tenantId,
  lineEventId,
  actorUid,
  actorRole,
  stopped_at,
  stop_reason
}) {
  const tenant = tenantOr(tenantId);
  const id = toInt(lineEventId, 'lineEventId');
  return setTenantTx(tenant, async tx => {
    const existing = unwrap(
      await tx.$queryRawUnsafe(
        `SELECT * FROM icu_line_tube_drain_events
        WHERE id = $1 AND tenant_id = $2::uuid`,
        id,
        tenant
      )
    );
    if (!existing) throw AppError.notFound('ICU line/tube/drain event not found');
    if (existing.stopped_at)
      throw AppError.conflict('ICU line/tube/drain event is already stopped');
    const admission = await assertAdmission(tx, tenant, existing.icu_admission_id);
    const rows = await tx.$queryRawUnsafe(
      `UPDATE icu_line_tube_drain_events
          SET stopped_at = COALESCE($3::timestamptz, NOW()),
              stop_reason = $4,
              removed_by = $5::uuid,
              updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2::uuid
        RETURNING *`,
      id,
      tenant,
      stopped_at || null,
      stop_reason || null,
      actorUid || null
    );
    const row = rows[0];
    if (row.device_presence_log_id) {
      await tx.$queryRawUnsafe(
        `UPDATE device_presence_logs
            SET stopped_at = COALESCE($3::timestamptz, NOW()),
                removed_by = $4::uuid,
                notes = COALESCE($5, notes),
                updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2::uuid`,
        row.device_presence_log_id,
        tenant,
        stopped_at || null,
        actorUid || null,
        stop_reason || null
      );
    }
    await recordCanonicalPair(tx, {
      tenantId: tenant,
      admission,
      resourceTable: 'icu_line_tube_drain_events',
      resourceId: row.id,
      eventType: 'icu.line_presence_stopped',
      action: 'icu.line_presence.stopped',
      actorUid,
      actorRole,
      summary: `ICU ${row.presence_kind.replaceAll('_', ' ')} stopped`,
      payload: {
        presence_kind: row.presence_kind,
        denominator_device_type: row.denominator_device_type,
        device_presence_log_id: row.device_presence_log_id,
        occurred_at: row.stopped_at
      },
      beforeState: existing,
      afterState: row
    });
    return normalizeValue(row);
  });
}

export async function listLinePresence({ tenantId, icuAdmissionId, activeOnly = false }) {
  const tenant = tenantOr(tenantId);
  return setTenantTx(tenant, async tx => {
    const admission = await assertAdmission(tx, tenant, icuAdmissionId);
    const rows = await tx.$queryRawUnsafe(
      `SELECT *
         FROM icu_line_tube_drain_events
        WHERE tenant_id = $1::uuid
          AND icu_admission_id = $2
          AND ($3::boolean = FALSE OR stopped_at IS NULL)
        ORDER BY COALESCE(stopped_at, started_at) DESC`,
      tenant,
      admission.id,
      activeOnly === true
    );
    return normalizeRows(rows);
  });
}

export async function linkDeviceObservation({
  tenantId,
  icuAdmissionId,
  actorUid,
  actorRole,
  ...body
}) {
  const tenant = tenantOr(tenantId);
  return setTenantTx(tenant, async tx => {
    const admission = await assertAdmission(tx, tenant, icuAdmissionId);
    let linkKind = body.link_kind;
    const vitalsId = body.vitals_chart_id ? toInt(body.vitals_chart_id, 'vitals_chart_id') : null;
    const sampleId = body.sample_observation_id
      ? toInt(body.sample_observation_id, 'sample_observation_id')
      : null;
    const associationId = body.device_association_id
      ? toInt(body.device_association_id, 'device_association_id')
      : null;
    let deviceRegistryId = body.device_registry_id
      ? toInt(body.device_registry_id, 'device_registry_id')
      : null;
    if (!linkKind) {
      if (vitalsId) linkKind = 'vitals_chart';
      else if (sampleId) linkKind = 'sample_observation';
      else if (associationId) linkKind = 'device_association';
    }
    if (!linkKind || [vitalsId, sampleId, associationId].filter(Boolean).length !== 1) {
      throw AppError.badRequest('Provide exactly one ICU device observation source');
    }
    const expectedKind = vitalsId
      ? 'vitals_chart'
      : sampleId
        ? 'sample_observation'
        : 'device_association';
    if (linkKind !== expectedKind) {
      throw AppError.badRequest('link_kind must match the provided ICU device observation source');
    }
    if (vitalsId) {
      const source = unwrap(
        await tx.$queryRawUnsafe(
          `SELECT id
           FROM vitals_chart
          WHERE id = $1
            AND tenant_id = $2::uuid
            AND patient_uid = $3::uuid
            AND source = 'device'
          LIMIT 1`,
          vitalsId,
          tenant,
          admission.patient_uid
        )
      );
      if (!source)
        throw AppError.notFound('Device vitals row not found for this ICU admission patient');
    }
    if (sampleId) {
      const source = unwrap(
        await tx.$queryRawUnsafe(
          `SELECT id, device_registry_id
           FROM device_vital_sample_observations
          WHERE id = $1
            AND tenant_id = $2::uuid
            AND patient_uid = $3::uuid
          LIMIT 1`,
          sampleId,
          tenant,
          admission.patient_uid
        )
      );
      if (!source)
        throw AppError.notFound(
          'Device sample observation not found for this ICU admission patient'
        );
      if (deviceRegistryId && Number(source.device_registry_id) !== deviceRegistryId) {
        throw AppError.badRequest(
          'device_registry_id does not match the sample observation source'
        );
      }
      deviceRegistryId = Number(source.device_registry_id);
    }
    if (associationId) {
      const source = unwrap(
        await tx.$queryRawUnsafe(
          `SELECT id, device_registry_id
           FROM device_patient_associations
          WHERE id = $1
            AND tenant_id = $2::uuid
            AND patient_uid = $3::uuid
          LIMIT 1`,
          associationId,
          tenant,
          admission.patient_uid
        )
      );
      if (!source)
        throw AppError.notFound('Device association not found for this ICU admission patient');
      if (deviceRegistryId && Number(source.device_registry_id) !== deviceRegistryId) {
        throw AppError.badRequest(
          'device_registry_id does not match the device association source'
        );
      }
      deviceRegistryId = Number(source.device_registry_id);
    }
    if (deviceRegistryId) {
      const registry = unwrap(
        await tx.$queryRawUnsafe(
          `SELECT id FROM device_registry WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
          deviceRegistryId,
          tenant
        )
      );
      if (!registry) throw AppError.notFound('Device registry row not found for this tenant');
    }
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO icu_device_observation_links
         (tenant_id, icu_admission_id, patient_uid, link_kind, vitals_chart_id,
          sample_observation_id, device_registry_id, device_association_id,
          linked_by, context, metadata)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9::uuid, $10, $11::jsonb)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      tenant,
      admission.id,
      admission.patient_uid,
      linkKind,
      vitalsId,
      sampleId,
      deviceRegistryId,
      associationId,
      actorUid || null,
      body.context || null,
      json(body.metadata)
    );
    const row =
      rows[0] ||
      unwrap(
        await tx.$queryRawUnsafe(
          `SELECT *
         FROM icu_device_observation_links
        WHERE tenant_id = $1::uuid
          AND icu_admission_id = $2
          AND (
            ($3::int IS NOT NULL AND vitals_chart_id = $3)
            OR ($4::int IS NOT NULL AND sample_observation_id = $4)
            OR ($5::int IS NOT NULL AND device_association_id = $5)
          )
        LIMIT 1`,
          tenant,
          admission.id,
          vitalsId,
          sampleId,
          associationId
        )
      );
    await recordCanonicalPair(tx, {
      tenantId: tenant,
      admission,
      resourceTable: 'icu_device_observation_links',
      resourceId: row.id,
      eventType: 'icu.device_observation_linked',
      action: 'icu.device_observation.linked',
      actorUid,
      actorRole,
      summary: 'ICU chart linked to governed device observation',
      payload: { link_kind: linkKind, vitals_chart_id: vitalsId, sample_observation_id: sampleId },
      afterState: row
    });
    return normalizeValue(row);
  });
}

export async function recordScoringOutput({
  tenantId,
  icuAdmissionId,
  actorUid,
  actorRole,
  ...body
}) {
  if (!body.scoring_kind) throw AppError.badRequest('scoring_kind required');
  const protocolAvailable = requireReviewerForScore(body);
  const tenant = tenantOr(tenantId);
  return setTenantTx(tenant, async tx => {
    const admission = await assertAdmission(tx, tenant, icuAdmissionId);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO icu_scoring_outputs
         (tenant_id, icu_admission_id, patient_uid, scoring_kind, recorded_at,
          input_facts, score_value, score_label, output_payload, reference_source,
          reference_version, policy_version_id, reviewer_uid, reviewer_role,
          reviewed_at, review_status, protocol_available, unavailable_reason,
          order_mutation_performed, recorded_by, metadata)
       VALUES ($1::uuid, $2, $3::uuid, $4, COALESCE($5::timestamptz, NOW()),
               $6::jsonb, $7, $8, $9::jsonb, $10, $11, $12, $13::uuid, $14,
               CASE WHEN $13::uuid IS NULL THEN NULL ELSE COALESCE($15::timestamptz, NOW()) END,
               $16, $17, $18, FALSE, $19::uuid, $20::jsonb)
       RETURNING *`,
      tenant,
      admission.id,
      admission.patient_uid,
      body.scoring_kind,
      body.recorded_at || null,
      json(body.input_facts),
      body.score_value ?? null,
      body.score_label || null,
      json(body.output_payload),
      body.reference_source || null,
      body.reference_version || null,
      body.policy_version_id ? toInt(body.policy_version_id, 'policy_version_id') : null,
      body.reviewer_uid || null,
      body.reviewer_role || null,
      body.reviewed_at || null,
      protocolAvailable ? body.review_status || 'reviewed' : 'protocol_unavailable',
      protocolAvailable,
      body.unavailable_reason || null,
      actorUid || body.recorded_by || null,
      json(body.metadata)
    );
    const row = rows[0];
    await recordCanonicalPair(tx, {
      tenantId: tenant,
      admission,
      resourceTable: 'icu_scoring_outputs',
      resourceId: row.id,
      eventType: 'icu.score_recorded',
      action: 'icu.score.recorded',
      actorUid,
      actorRole,
      summary: `ICU ${body.scoring_kind} decision-support output recorded`,
      payload: {
        scoring_kind: body.scoring_kind,
        protocol_available: protocolAvailable,
        review_status: row.review_status,
        order_mutation_performed: false,
        occurred_at: row.recorded_at
      },
      afterState: row
    });
    return normalizeValue(row);
  });
}

export async function listScoringOutputs({ tenantId, icuAdmissionId, scoringKind = null }) {
  const tenant = tenantOr(tenantId);
  return setTenantTx(tenant, async tx => {
    const admission = await assertAdmission(tx, tenant, icuAdmissionId);
    const params = [tenant, admission.id];
    let kindFilter = '';
    if (scoringKind) {
      params.push(scoringKind);
      kindFilter = ` AND scoring_kind = $${params.length}`;
    }
    const rows = await tx.$queryRawUnsafe(
      `SELECT *
         FROM icu_scoring_outputs
        WHERE tenant_id = $1::uuid
          AND icu_admission_id = $2
          ${kindFilter}
        ORDER BY recorded_at DESC`,
      ...params
    );
    return normalizeRows(rows);
  });
}

export async function closeIcuDeviceAssociationsForAdmission({
  tx,
  tenantId,
  icuAdmissionId,
  actorUid = null,
  reason = 'discharge',
  stoppedAt = null
}) {
  const db = tx || prisma;
  const tenant = tenantOr(tenantId);
  const admission = await assertAdmission(db, tenant, icuAdmissionId);
  const endedAt = asIso(stoppedAt) || new Date().toISOString();
  await db.$executeRawUnsafe(
    `UPDATE device_patient_associations
        SET ended_at = COALESCE(ended_at, $3::timestamptz),
            ended_by = COALESCE(ended_by, $4::uuid),
            end_reason = COALESCE(end_reason, $5),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND ended_at IS NULL
        AND started_at <= $3::timestamptz`,
    tenant,
    admission.patient_uid,
    endedAt,
    actorUid,
    reason === 'transfer' ? 'transfer' : 'discharge'
  );
  await db.$executeRawUnsafe(
    `UPDATE icu_line_tube_drain_events
        SET stopped_at = COALESCE(stopped_at, $3::timestamptz),
            stop_reason = COALESCE(stop_reason, $4),
            removed_by = COALESCE(removed_by, $5::uuid),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND icu_admission_id = $2
        AND stopped_at IS NULL`,
    tenant,
    admission.id,
    endedAt,
    reason,
    actorUid
  );
  await db.$executeRawUnsafe(
    `UPDATE device_presence_logs
        SET stopped_at = COALESCE(stopped_at, $4::timestamptz),
            removed_by = COALESCE(removed_by, $5::uuid),
            notes = COALESCE(notes, $6),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND ($3::int IS NULL OR admission_id = $3)
        AND stopped_at IS NULL`,
    tenant,
    admission.patient_uid,
    admission.admission_id || null,
    endedAt,
    actorUid,
    `Closed by ICU ${reason}`
  );
  logger.info(`Closed ICU device associations for admission ${admission.id} (${reason})`);
  return normalizeValue(admission);
}

export default {
  getChartSettings,
  setChartSettings,
  getIcuChartView,
  createVentilationEpisode,
  stopVentilationEpisode,
  listVentilationEpisodes,
  recordWeaningTrial,
  listWeaningTrials,
  startLinePresence,
  stopLinePresence,
  listLinePresence,
  linkDeviceObservation,
  recordScoringOutput,
  listScoringOutputs,
  closeIcuDeviceAssociationsForAdmission
};
