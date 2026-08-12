import prisma, { setTenantTx } from '../../lib/prisma.js';
import Sentry from '../sentry.js';
import logger from '../../logging/logger.js';
import { AppError } from '../AppError.js';
import { dispatch } from '../notifications/notificationDispatcher.js';
import { emitVitalAnomaly, emitCodeBlue } from '../websocket/realtimeEmitter.js';
// Results-inbox safety net (design docs/RESULTS_INBOX_ESCALATION_DESIGN.md §4.2):
// a CRITICAL vital-sign clinical_alert becomes an assigned, acknowledgement-tracked
// task. POST-COMMIT + best-effort (Phase 1.5) — must NEVER block the alert persist.
// This util operates on the int patient_id, not a tenant-scoped request, and
// clinical_alerts itself is not tenant-keyed. We therefore resolve the patient's
// tenant from users.tenant_id and create the task under THAT tenant (design
// §4.6), falling back to DEFAULT_TENANT_ID only when it can't be resolved.
import { enqueueCriticalResultTask } from '../../services/results/resultsInboxService.js';
import { requireTenantId } from '../../services/tenant/tenantService.js';

/**
 * Adult clinical reference ranges (default).
 */
const ADULT_RANGES = {
  heart_rate: { min: 40, max: 150, critical_min: 30, critical_max: 180, unit: 'bpm' },
  systolic_bp: { min: 80, max: 160, critical_min: 60, critical_max: 200, unit: 'mmHg' },
  diastolic_bp: { min: 50, max: 100, critical_min: 40, critical_max: 120, unit: 'mmHg' },
  temperature: { min: 35.5, max: 38.5, critical_min: 34.0, critical_max: 40.0, unit: '°C' },
  // SpO2 has NO upper critical band: 100% is a normal physiological value,
  // and the classifiers below treat `critical_max` as INCLUSIVE (>=), so a
  // finite 100 here classified a perfectly-oxygenated patient as CRITICAL
  // and fired the code-blue fan-out. `Infinity` is unreachable for every
  // finite reading, keeping SpO2 alerts low-side only. Implausible values
  // (>100) are rejected at the write path (utils/clinical/vitalPlausibility.js)
  // before they ever reach classification.
  oxygen_saturation: { min: 92, max: 100, critical_min: 85, critical_max: Infinity, unit: '%' },
  respiratory_rate: { min: 10, max: 24, critical_min: 6, critical_max: 35, unit: '/min' },
  blood_glucose: { min: 70, max: 180, critical_min: 50, critical_max: 400, unit: 'mg/dL' },
};

/**
 * Paediatric ranges (broad — covers 1y–12y as a single band; intentionally
 * permissive rather than wrong-direction strict). Refined per-age-band tables
 * are a follow-up; the immediate patient-safety fix is to stop applying adult
 * ranges to children. See finding
 * 2026-05-08-pediatric-opd-nurse-adult-vital-ranges.
 */
const PAEDIATRIC_RANGES = {
  heart_rate: { min: 70, max: 140, critical_min: 50, critical_max: 200, unit: 'bpm' },
  systolic_bp: { min: 75, max: 115, critical_min: 60, critical_max: 130, unit: 'mmHg' },
  diastolic_bp: { min: 45, max: 80, critical_min: 35, critical_max: 95, unit: 'mmHg' },
  temperature: { min: 35.5, max: 38.0, critical_min: 34.0, critical_max: 40.0, unit: '°C' },
  // No upper critical band — same rationale as the adult table above.
  oxygen_saturation: { min: 94, max: 100, critical_min: 88, critical_max: Infinity, unit: '%' },
  respiratory_rate: { min: 18, max: 40, critical_min: 10, critical_max: 60, unit: '/min' },
  blood_glucose: { min: 60, max: 180, critical_min: 40, critical_max: 400, unit: 'mg/dL' },
};

async function lockActivePatientForAlert(tx, tenantId, patientId) {
  const visited = new Set();
  let lookupById = true;
  let current = patientId;
  for (let depth = 0; depth <= 16; depth += 1) {
    const rows = lookupById
      ? await tx.$queryRawUnsafe(
        `SELECT id, uid::text AS uid, is_active, status,
                merged_into_uid::text AS merged_into_uid,
                COALESCE(is_deleted, false) AS is_deleted
           FROM users
          WHERE tenant_id = $1::uuid AND id = $2::int AND role = 'PATIENT'
          FOR UPDATE`,
        tenantId,
        current,
      )
      : await tx.$queryRawUnsafe(
        `SELECT id, uid::text AS uid, is_active, status,
                merged_into_uid::text AS merged_into_uid,
                COALESCE(is_deleted, false) AS is_deleted
           FROM users
          WHERE tenant_id = $1::uuid AND uid = $2::uuid AND role = 'PATIENT'
          FOR UPDATE`,
        tenantId,
        current,
      );
    const patient = rows[0];
    if (!patient) throw AppError.notFound('Patient not found');
    if (visited.has(patient.uid)) {
      throw AppError.conflict('Patient merge survivor chain is cyclic', 'ALERT_PATIENT_MERGE_CHAIN_INVALID');
    }
    visited.add(patient.uid);
    if (patient.merged_into_uid) {
      lookupById = false;
      current = patient.merged_into_uid;
      continue;
    }
    if (patient.is_active !== true || patient.is_deleted || patient.status === 'merged') {
      throw AppError.conflict(
        'Patient is inactive and has no active merge survivor',
        'ALERT_PATIENT_INACTIVE',
      );
    }
    return patient;
  }
  throw AppError.conflict('Patient merge survivor chain is too deep', 'ALERT_PATIENT_MERGE_CHAIN_INVALID');
}

/**
 * Pregnancy-specific BP thresholds. Gestational hypertension is ≥140
 * systolic OR ≥90 diastolic; severe / pre-eclampsia is ≥160 / ≥110. Other
 * vitals fall back to adult ranges. See findings
 * 2026-05-08-obstetric-anc-nurse-bp-no-preeclampsia-alert and
 * 2026-05-20-obstetric-anc-nurse-acf39daa.
 *
 * `max` is the last NORMAL value: the range check flags `value > max`, so
 * encoding 139/89 makes exactly 140/90 trip a WARNING (recheck BP / dipstick
 * urine) even without proteinuria — gestational hypertension is defined at
 * the ≥140/90 boundary. Severe pre-eclampsia (critical_max ≥160/110) and the
 * proteinuria-positive preeclampsia_screen are handled separately below.
 */
const PREGNANCY_BP_OVERRIDES = {
  systolic_bp: { min: 90, max: 139, critical_min: 70, critical_max: 160, unit: 'mmHg', preeclampsia: true },
  diastolic_bp: { min: 50, max: 89, critical_min: 40, critical_max: 110, unit: 'mmHg', preeclampsia: true },
};

/**
 * Resolve patient context (age, pregnancy state) for picking the right
 * range table. Best-effort — if the lookup fails we fall back to adult
 * ranges (caller is unaffected, no exception escapes).
 */
export async function resolvePatientContext(patientId, { db = prisma, strict = false } = {}) {
  if (!patientId) return { isPaediatric: false, isPregnant: false };
  try {
    const rows = await db.$queryRawUnsafe(
      `SELECT
         CASE WHEN u.birthday IS NOT NULL THEN
           DATE_PART('year', AGE(NOW()::date, u.birthday))::int
         ELSE NULL END AS age_years,
         (COALESCE(u.is_pregnant, FALSE) OR COALESCE(p.has_active_pregnancy, FALSE)) AS is_pregnant
       FROM users u
       LEFT JOIN LATERAL (
         SELECT TRUE AS has_active_pregnancy
           FROM maternity_pregnancies mp
          WHERE mp.patient_uid = u.uid
            AND mp.status = 'ongoing'
          LIMIT 1
       ) p ON TRUE
       WHERE u.id = $1
       LIMIT 1`,
      patientId,
    );
    const row = rows[0] ?? {};
    const ageYears = row.age_years ?? null;
    const isPaediatric = ageYears !== null && ageYears < 12;
    const isPregnant = row.is_pregnant === true;
    return { isPaediatric, isPregnant, ageYears };
  } catch (err) {
    if (strict) throw err;
    logger.warn(`vitalSignMonitor: patient context lookup failed for patient=${patientId}: ${err.message}`);
    return { isPaediatric: false, isPregnant: false };
  }
}

function pickRanges({ isPaediatric, isPregnant }) {
  let table = isPaediatric ? PAEDIATRIC_RANGES : ADULT_RANGES;
  if (isPregnant) {
    // Pregnancy BP overrides on top of the adult table.
    table = { ...table, ...PREGNANCY_BP_OVERRIDES };
  }
  return table;
}

function proteinuriaIsPositive(value) {
  if (value == null) return false;
  const v = String(value).trim().toLowerCase();
  return ['1+', '2+', '3+', '4+'].includes(v);
}

export async function classifyVitalAnomalyCandidates(patientId, vitals) {
  const patientCtx = await resolvePatientContext(patientId);
  const ranges = pickRanges(patientCtx);
  const candidates = [];
  for (const [vitalName, value] of Object.entries(vitals || {})) {
    if (value === null || value === undefined || !ranges[vitalName]) continue;
    const rawValue = vitalName === 'temperature'
      ? normalizeTemperatureC(value, vitals.temperature_unit)
      : value;
    const numValue = parseFloat(rawValue);
    if (Number.isNaN(numValue)) continue;
    const range = ranges[vitalName];
    let severity = null;
    if (numValue <= range.critical_min || numValue >= range.critical_max) {
      severity = 'CRITICAL';
    } else if (numValue < range.min || numValue > range.max) {
      severity = 'WARNING';
    }
    if (severity) {
      candidates.push({
        vital_name: vitalName,
        value: numValue,
        severity,
        unit: range.unit,
        normal_range: `${range.min}-${range.max}`,
      });
    }
  }
  return candidates;
}

/**
 * Normalize a temperature reading to Celsius — the unit the threshold tables
 * above use (critical_max 40.0, etc.). The alert engine compares against
 * Celsius limits, so a Fahrenheit-valued reading must be converted first or a
 * normothermic patient (e.g. 100.4°F ≈ 38°C) trips a false CRITICAL
 * hyperthermia alert. Finding 2026-05-21-walk-in-opd-doctor-126619d3.
 *
 * Resolution order:
 *   1. Honor an explicit unit hint ('F'/'FAHRENHEIT' → convert; 'C'/'CELSIUS' → as-is).
 *   2. With no hint, infer by plausible human body-temperature range: a value
 *      in the Fahrenheit band (≥ 60) is treated as Fahrenheit and converted;
 *      a value below that is already Celsius. 60 sits well above any survivable
 *      Celsius temperature (~45 max) and below any plausible Fahrenheit body
 *      temp (~95+), so the split is unambiguous for real readings.
 *
 * Pure + exported for unit testing. Returns the input unchanged for
 * null/undefined/non-numeric so callers can pass sparse payloads safely.
 * @param {number|string|null|undefined} value
 * @param {string} [unit] - 'C' | 'F' | 'celsius' | 'fahrenheit' (case-insensitive)
 * @returns {number|null|undefined} Celsius value, or the original non-numeric input
 */
export function normalizeTemperatureC(value, unit) {
  if (value === undefined || value === null) return value;
  const num = typeof value === 'number' ? value : parseFloat(value);
  if (Number.isNaN(num)) return value;

  const u = unit == null ? '' : String(unit).trim().toUpperCase();
  if (u === 'F' || u === 'FAHRENHEIT') return ((num - 32) * 5) / 9;
  if (u === 'C' || u === 'CELSIUS') return num;

  // No (or unrecognized) unit hint — infer from the value's magnitude.
  // ≥ 60 can only be Fahrenheit for a human body temperature.
  if (num >= 60) return ((num - 32) * 5) / 9;
  return num;
}

function buildVitalAlerts(patientId, vitals, context, patientCtx) {
  const alerts = [];
  const ranges = pickRanges(patientCtx);
  for (const [vitalName, value] of Object.entries(vitals)) {
    if (value === null || !ranges[vitalName]) continue;
    const range = ranges[vitalName];
    const rawValue = vitalName === 'temperature'
      ? normalizeTemperatureC(value, vitals.temperature_unit)
      : value;
    const numValue = parseFloat(rawValue);
    if (Number.isNaN(numValue)) continue;

    let severity = null;
    if (numValue <= range.critical_min || numValue >= range.critical_max) {
      severity = 'CRITICAL';
    } else if (numValue < range.min || numValue > range.max) {
      severity = 'WARNING';
    }
    if (!severity) continue;

    const cohortLabel = patientCtx.isPaediatric
      ? `paediatric${patientCtx.ageYears != null ? `, age ${patientCtx.ageYears}y` : ''}`
      : patientCtx.isPregnant
        ? 'pregnant'
        : 'adult';
    const direction = numValue < range.min ? 'low' : 'high';
    const isPreeclampsiaSignal = range.preeclampsia === true && direction === 'high';
    const message = isPreeclampsiaSignal
      ? `Pregnancy-induced hypertension: ${vitalName.replace(/_/g, ' ')} ${numValue}${range.unit} is ${severity === 'CRITICAL' ? 'critically high — possible severe pre-eclampsia' : 'high — recheck BP and dipstick urine for proteinuria'} (${cohortLabel} normal: ${range.min}-${range.max}${range.unit}).`
      : `${vitalName.replace(/_/g, ' ')} ${numValue}${range.unit} is ${severity === 'CRITICAL' ? 'critically' : ''} ${direction} (${cohortLabel} normal: ${range.min}-${range.max}${range.unit})`;
    alerts.push({
      patient_id: patientId,
      vital_name: vitalName,
      value: numValue,
      unit: range.unit,
      severity,
      normal_range: `${range.min}-${range.max}`,
      cohort: cohortLabel,
      message,
      recorded_by: context.recordedBy,
      is_pregnancy_bp_signal: isPreeclampsiaSignal,
    });
  }

  const systolic = vitals.systolic_bp == null ? null : Number(vitals.systolic_bp);
  const diastolic = vitals.diastolic_bp == null ? null : Number(vitals.diastolic_bp);
  const hypertensive = (Number.isFinite(systolic) && systolic >= 140)
    || (Number.isFinite(diastolic) && diastolic >= 90);
  if (patientCtx.isPregnant && hypertensive && proteinuriaIsPositive(vitals.urine_albumin)) {
    alerts.push({
      patient_id: patientId,
      vital_name: 'preeclampsia_screen',
      value: Math.max(systolic ?? 0, diastolic ?? 0),
      unit: 'risk',
      severity: 'CRITICAL',
      normal_range: 'BP <140/90 and urine protein negative/trace',
      cohort: 'pregnant',
      message: `Positive pre-eclampsia screen: BP ${systolic ?? '?'}/${diastolic ?? '?'} with urine protein ${vitals.urine_albumin}. Escalate for obstetric review and repeat BP/protein assessment.`,
      recorded_by: context.recordedBy,
      is_pregnancy_bp_signal: true,
    });
  }
  return alerts;
}

/**
 * Check vitals against reference ranges and generate alerts for abnormal values.
 * Call this after any vital sign is recorded.
 * @param {number} patientId - Patient DB ID
 * @param {Object} vitals - { heart_rate, systolic_bp, diastolic_bp, temperature, oxygen_saturation, ... }
 * @param {Object} context - { recordedBy, requestId, tenantId?, sourceVitalsChartId?, classifyOnly?, onClinicalAlertsPersisted? } — tenantId,
 *   when supplied by a caller that already resolved the patient's tenant,
 *   scopes the alert persistence without a users lookup. The optional
 *   onClinicalAlertsPersisted hook runs in the same transaction as alert
 *   persistence (or in an empty tenant transaction when there are no alerts).
 * @returns {Array} alerts - Array of generated alerts
 */
export async function checkVitalAnomalies(patientId, vitals, context = {}) {
  if (context.classifyOnly) {
    const patientCtx = await resolvePatientContext(patientId, {
      db: context.db || prisma,
      strict: context.strictPatientContext === true,
    });
    return buildVitalAlerts(patientId, vitals, context, patientCtx);
  }

  const contextTenantId = typeof context.tenantId === 'string' && context.tenantId.trim() !== ''
    ? context.tenantId
    : null;
  let alertPatientTenantId = contextTenantId;
  if (!alertPatientTenantId) {
    const tenantRows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id FROM users WHERE id = $1::int LIMIT 1`,
      patientId,
    );
    alertPatientTenantId = tenantRows[0]?.tenant_id ?? null;
  }
  const persistTenantId = requireTenantId(alertPatientTenantId);
  let alerts = [];
  let persisted = [];
  let classificationCompleted = false;
  let patientCtx = { isPaediatric: false, isPregnant: false, ageYears: null };
  let alertPatientUid = null;
  try {
    persisted = await setTenantTx(persistTenantId, async (tx) => {
      const activePatient = await lockActivePatientForAlert(tx, persistTenantId, patientId);
      alertPatientUid = activePatient.uid;
      patientCtx = await resolvePatientContext(activePatient.id, { db: tx, strict: true });
      alerts = buildVitalAlerts(activePatient.id, vitals, context, patientCtx);
      classificationCompleted = true;

      if (alerts.length > 0 && context.source === 'device') {
        const filteredAlerts = [];
        for (const alert of alerts) {
          const artifactVerdict = context.artifactVerdicts?.[alert.vital_name];
          if (artifactVerdict && artifactVerdict.corroborated === false) continue;
          if (await hasOpenDeviceRepeat(alert, context, tx)) continue;
          filteredAlerts.push(alert);
        }
        alerts = filteredAlerts;
      }

      const rows = context.persistedClinicalAlertIdsByVitalName
        ? alerts.map((alert) => {
          const clinicalAlertId = context.persistedClinicalAlertIdsByVitalName[alert.vital_name];
          if (clinicalAlertId == null) {
            throw new Error(`Missing reconciled clinical alert for ${alert.vital_name}`);
          }
          return { alert, clinicalAlertId };
        })
        : [];
      if (!context.persistedClinicalAlertIdsByVitalName) {
        for (const alert of alerts) {
          const alertRows = await tx.$queryRawUnsafe(
            `INSERT INTO clinical_alerts
               (patient_id, alert_type, vital_name, vital_value, severity, message,
                created_by, source_vitals_chart_id, created_at)
             VALUES ($1, 'VITAL_ANOMALY', $2, $3, $4, $5, $6, $7::int, NOW())
             RETURNING id`,
            alert.patient_id,
            alert.vital_name,
            alert.value,
            alert.severity,
            alert.message,
            alert.recorded_by,
            context.sourceVitalsChartId == null ? null : Number(context.sourceVitalsChartId),
          );
          rows.push({ alert, clinicalAlertId: alertRows[0]?.id ?? null });
        }
      }
      if (typeof context.onClinicalAlertsPersisted === 'function') {
        await context.onClinicalAlertsPersisted({ tx, alerts: rows });
      }
      return rows;
    });
  } catch (persistErr) {
    const hasCritical = !classificationCompleted
      || alerts.some((alert) => alert.severity === 'CRITICAL');
    const detail = alerts.map((alert) => `${alert.vital_name}=${alert.value} (${alert.severity})`).join(', ');
    logger.error(
      `${hasCritical ? 'vitalSignMonitor: CRITICAL clinical alert' : 'vitalSignMonitor: clinical alert'} persistence FAILED for patient ${patientId} [${detail}]: ${persistErr?.message}`,
    );
    Sentry.captureException(persistErr, {
      level: hasCritical ? 'fatal' : 'error',
      tags: {
        subsystem: 'clinical_alerts',
        ...(hasCritical ? { severity: 'CRITICAL' } : {}),
      },
      extra: { patientId, alerts: detail },
    });
    throw persistErr;
  }

  if (alerts.length > 0) {

    // ---- Phase 1.5: post-commit best-effort fan-out ----
    // The clinical_alerts rows are now durably committed. Each side effect
    // below is independently best-effort: a failure here must not undo the
    // persisted alerts (and must not throw past this point for non-CRITICAL
    // mirrors), so each is wrapped in its own try/catch.
    for (const { alert, clinicalAlertId } of persisted) {
      // D26 — Mirror pregnancy-hypertension and pre-eclampsia screen
      // alerts to cds_alerts so they surface on the doctor's CDS
      // dashboard alongside the existing drug-interaction / allergy /
      // duplicate-order alerts the dashboard already reads. Best-effort:
      // a mirror failure must not undo the committed clinical_alerts row
      // or block the alert dispatch. Finding b6dc4ea4.
      if (
        alert.is_pregnancy_bp_signal
        && alertPatientUid
        && !context.persistedClinicalAlertIdsByVitalName
      ) {
        try {
          await setTenantTx(persistTenantId, async (tx) => tx.$executeRawUnsafe(
            `INSERT INTO cds_alerts
               (patient_uid, alert_type, severity, title, description, source_data)
             VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb)`,
            alertPatientUid,
            alert.vital_name === 'preeclampsia_screen'
              ? 'PREECLAMPSIA_SCREEN_POSITIVE'
              : 'PREGNANCY_HYPERTENSION',
            alert.severity,
            alert.vital_name === 'preeclampsia_screen'
              ? 'Positive pre-eclampsia screen'
              : `Gestational hypertension (${alert.vital_name.replace(/_/g, ' ')} ${alert.value}${alert.unit})`,
            alert.message,
            JSON.stringify({
              vital_name: alert.vital_name,
              value: alert.value,
              unit: alert.unit,
              normal_range: alert.normal_range,
              cohort: alert.cohort,
              clinical_alert_id: clinicalAlertId,
              source_vitals_chart_id: context.sourceVitalsChartId == null
                ? null
                : Number(context.sourceVitalsChartId),
              source: 'vitalSignMonitor.checkVitalAnomalies',
            }),
          ));
        } catch (cdsErr) {
          logger.warn(`vitalSignMonitor: cds_alerts mirror failed for patient_id=${patientId}: ${cdsErr.message}`);
        }
      }

      // Realtime fabric: push to staff clinical-alerts channel (all severities);
      // CRITICAL also fans out on staff:code-blue for full-screen staff-app alerts.
      emitVitalAnomaly(alert);
      if (alert.severity === 'CRITICAL' && isCodeBlueVital(alert.vital_name)) {
        // NL-14 P2: persist the DURABLE resuscitation event first — it is the
        // source of truth with ward/bed/reason snapshot; the WS push below is
        // notification-only. Flag-gated per tenant (fail-closed no-op when
        // disabled) and never-throws, so the alert fan-out is never blocked.
        // Lazy import keeps the resus module out of this hot path's static
        // graph (and out of every consumer's mock surface) until a code-blue
        // vital actually fires.
        let resusEvent = null;
        try {
          const { createEventFromCriticalVital } = await import(
            '../../services/clinical/resuscitationEventService.js'
          );
          resusEvent = await createEventFromCriticalVital({
            tenantId: alertPatientTenantId,
            patientUid: alertPatientUid,
            clinicalAlertId,
            reason: alert.message,
            recordedBy: alert.recorded_by ? String(alert.recorded_by) : null,
          });
        } catch (resusErr) {
          logger.error(
            `vitalSignMonitor: durable resus event hook failed (alert=${clinicalAlertId}): ${resusErr?.message}`,
          );
        }
        emitCodeBlue({
          tenantId: alertPatientTenantId,
          patientId: alert.patient_id,
          bedNumber: resusEvent?.bed_snapshot || null,
          ward: resusEvent?.ward_snapshot || null,
          triggeredBy: alert.recorded_by,
          reason: alert.message,
          eventId: resusEvent?.id ?? null,
        });
      }

      // Dispatch notification to the responsible clinician for CRITICAL alerts.
      // Device-originated vitals deliberately skip recorded_by push delivery:
      // the results-inbox DUTY-role task below is the ownership surface for
      // monitor feeds, and DEVICE_GATEWAY must never become a clinician target.
      if (alert.severity === 'CRITICAL') {
        if (context.source !== 'device') {
          try {
            await dispatch({
              userId: String(alert.recorded_by),
              title: `CRITICAL Vital Alert — Patient #${alert.patient_id}`,
              body: alert.message,
              channels: ['push', 'inapp'],
              data: { patient_id: String(alert.patient_id), vital_name: alert.vital_name, severity: 'CRITICAL' },
              type: 'clinical_alert',
            });
          } catch (notifyErr) {
            // Notification failure must not block alert persistence — log and continue
            logger.error(`Failed to dispatch CRITICAL alert notification for patient ${alert.patient_id}:`, notifyErr.message);
          }
        }

        // Results-inbox producer hook (design §4.2 — deterministic core). The
        // clinical_alerts row above is already committed (Phase 1 tx), so this is
        // a post-commit, Phase-1.5 best-effort enqueue: the CRITICAL vital
        // becomes an assigned, acknowledgement-tracked task the escalation engine
        // will chase if it goes unacked. CRITICAL: must never throw or slow the
        // alert persist — enqueueCriticalResultTask is never-throws, and we still
        // swallow defensively here. Idempotent via the mig-312 open-task index
        // (keyed on the clinical_alert id), so a re-run never duplicates the task.
        if (clinicalAlertId != null) {
          try {
            await enqueueCriticalResultTask({
              // Land the task under the PATIENT's tenant (resolved from
              // users.tenant_id above); fall back to the default tenant only
              // when the lookup failed / the user row had no tenant.
              tenantId: requireTenantId(alertPatientTenantId),
              patientUid: alertPatientUid,
              source: 'vital_alert',
              resourceType: 'clinical_alert',
              resourceId: clinicalAlertId,
              severity: 'critical',
              title: `Critical vital: ${alert.vital_name.replace(/_/g, ' ')}`,
              summary: alert.message,
              // The recording clinician is the natural first owner; null falls
              // the producer back to the DUTY role.
              orderingClinicianUid: null,
              resolveMergedPatient: true,
            });
          } catch (enqueueErr) {
            logger.error(`vitalSignMonitor: results-inbox enqueue failed for critical alert (patient_id=${alert.patient_id}): ${enqueueErr?.message}`);
          }
        }
      }
    }
    logger.warn(`Clinical alerts generated for patient ${patientId} (${patientCtx.isPaediatric ? 'paediatric' : patientCtx.isPregnant ? 'pregnant' : 'adult'}):`, alerts.map(a => `${a.vital_name}=${a.value} (${a.severity})`).join(', '));
  }

  return alerts;
}

// Vitals whose CRITICAL breach constitutes a Code Blue event
// (cardiopulmonary failure signals — HR, SpO2, respiratory rate, systolic BP collapse).
const CODE_BLUE_VITALS = new Set(['heart_rate', 'oxygen_saturation', 'respiratory_rate', 'systolic_bp']);
function isCodeBlueVital(name) {
  return CODE_BLUE_VITALS.has(name);
}

async function hasOpenDeviceRepeat(alert, context, db = prisma) {
  if (!context.suppressRepeats) return false;
  const windows = context.suppressionWindows || {};
  const fallback = alert.severity === 'CRITICAL' ? 10 : 30;
  const windowMinutes = Math.max(1, Math.min(Number.parseInt(windows[alert.severity] ?? fallback, 10) || fallback, 240));
  try {
    const rows = await db.$queryRawUnsafe(
      `SELECT id
         FROM clinical_alerts
        WHERE patient_id = $1::int
          AND vital_name = $2
          AND severity = $3
          AND COALESCE(acknowledged, false) = false
          AND acknowledged_at IS NULL
          AND created_at >= NOW() - ($4::int * INTERVAL '1 minute')
        LIMIT 1`,
      alert.patient_id,
      alert.vital_name,
      alert.severity,
      windowMinutes,
    );
    return rows.length > 0;
  } catch (err) {
    logger.warn(`vitalSignMonitor: repeat-suppression lookup failed for patient=${alert.patient_id}: ${err.message}`);
    return false;
  }
}

// Backward-compat export — callers used to read VITAL_REFERENCE_RANGES
// directly. Keep it as the adult table since that was the previous single
// source of truth.
const VITAL_REFERENCE_RANGES = ADULT_RANGES;
export { VITAL_REFERENCE_RANGES, ADULT_RANGES, PAEDIATRIC_RANGES, PREGNANCY_BP_OVERRIDES };
export default { checkVitalAnomalies, classifyVitalAnomalyCandidates, resolvePatientContext, normalizeTemperatureC, VITAL_REFERENCE_RANGES, ADULT_RANGES, PAEDIATRIC_RANGES, PREGNANCY_BP_OVERRIDES };
