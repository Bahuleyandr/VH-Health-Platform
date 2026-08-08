import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import {
  startWorkflowSla,
  completeWorkflowSla,
} from './canonicalClinicalPlatformService.js';

const DEFAULT_TIMEZONE = process.env.APP_TIMEZONE || process.env.TZ || 'Asia/Kolkata';
const DEFAULT_GRACE_MINUTES = 60;
const DEFAULT_SWEEP_LIMIT = 100;

export const DRUG_CHART_MISSING_ALERT_TYPE = 'DRUG_CHART_MISSING';
export const DRUG_CHART_MISSING_AUDIT_ACTION = 'DRUG_CHART_MISSING_ALERT_RAISED';
export const DRUG_CHART_FIRST_ENTERED_AUDIT_ACTION = 'DRUG_CHART_FIRST_ENTERED';
// Canonical SLA rule this sweep starts/completes (seeded as a global default by
// migration 641). The workflow_sla_instances row keyed
// (tenant, rule, 'admissions', admission_id) is BOTH the escalation-proof
// record and the sweep's dedupe: an OPEN clock (completed_at IS NULL) means
// "already alerted, unresolved" and suppresses re-processing; a completed
// clock re-arms when the chart empties again.
export const DRUG_CHART_SLA_RULE_CODE = 'drug_chart_first_entry';

const ACTIVE_ADMISSION_STATUSES = ['admitted', 'transferred'];
const ACTIVE_MEDICATION_STATUS_RE =
  '(cancelled|canceled|discontinued|stopped|\\bheld\\b|on[\\s_-]?hold|suspended|completed)';

const DOCTOR_ROLES = [
  'DOCTOR',
  'DUTY_DOCTOR',
  'CONSULTANT',
  'JUNIOR_DOCTOR',
  'SENIOR_DOCTOR',
  'RESIDENT',
  'MEDICAL_SUPERINTENDENT',
];

const NURSING_ROLES = [
  'NURSING_STAFF',
  'NURSING_INCHARGE',
  'IP_STAFF_NURSE',
  'IP_INCHARGE',
  'ICU_NURSE',
  'ICU_INCHARGE',
  'OT_NURSE',
  'OT_INCHARGE',
  'CNO',
];

function normalizeLimit(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_SWEEP_LIMIT;
  return Math.min(parsed, 500);
}

function normalizeGraceMinutes(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_GRACE_MINUTES;
  return Math.min(parsed, 24 * 60);
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function minutesBetween(start, end) {
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null;
  return Math.max(0, Math.round((e.getTime() - s.getTime()) / 60000));
}

function uniqueUids(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function uniqueRecipients(rows = []) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const id = Number(row?.id);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      uid: row.uid || null,
      name: row.name || null,
      phone: row.phone || null,
      role: row.role || null,
      recipient_kind: row.recipient_kind || 'recipient',
      source: row.source || 'drug_chart_sla',
    });
  }
  return out;
}

function admissionLabel(admission) {
  return [
    admission.patient_name || 'Patient',
    admission.ward_name,
    admission.bed_number ? `Bed ${admission.bed_number}` : null,
  ].filter(Boolean).join(' - ');
}

function notificationData(admission, extra = {}) {
  return {
    source: 'drug_chart_sla',
    admission_id: admission.admission_id,
    patient_uid: admission.patient_uid,
    encounter_id: admission.encounter_id || null,
    tenant_id: admission.tenant_id || null,
    bed_id: admission.bed_id || null,
    ward_id: admission.ward_id || null,
    ward_name: admission.ward_name || null,
    route: `/drug-chart/${admission.admission_id}`,
    ...extra,
  };
}

export async function findAdmissionsMissingDrugChart({
  now = new Date(),
  graceMinutes = DEFAULT_GRACE_MINUTES,
  limit = DEFAULT_SWEEP_LIMIT,
} = {}) {
  const safeGrace = normalizeGraceMinutes(graceMinutes);
  const safeLimit = normalizeLimit(limit);
  const nowIso = toIso(now);

  return prisma.$queryRawUnsafe(
    `WITH active_bedded_admissions AS (
       SELECT a.id AS admission_id,
              a.tenant_id,
              a.patient_uid,
              a.encounter_id,
              a.admitting_doctor,
              a.attending_doctor,
              a.admitted_at,
              COALESCE(b.assigned_at, b.admitted_at, a.admitted_at, a.created_at) AS ward_arrived_at,
              b.id AS bed_id,
              b.bed_number,
              b.ward_id,
              COALESCE(w.name, b.ward_name, a.ward) AS ward_name,
              COALESCE(w.floor::text, b.floor::text) AS floor,
              u.name AS patient_name
         FROM admissions a
         JOIN beds b ON b.id = a.bed_id
          AND b.status = 'occupied'
          AND b.patient_uid = a.patient_uid
    LEFT JOIN wards w ON w.id = b.ward_id
    LEFT JOIN users u ON u.uid = a.patient_uid
        WHERE a.status = ANY($3::text[])
          AND COALESCE(b.assigned_at, b.admitted_at, a.admitted_at, a.created_at)
              <= ($1::timestamptz - ($2::int * INTERVAL '1 minute'))
     )
     SELECT *,
            FLOOR(EXTRACT(EPOCH FROM ($1::timestamptz - ward_arrived_at)) / 60)::int
              AS minutes_since_ward_arrival
       FROM active_bedded_admissions aba
      WHERE NOT EXISTS (
              SELECT 1
                FROM clinical_orders co
               WHERE co.tenant_id = aba.tenant_id
                 AND co.patient_uid = aba.patient_uid
                 AND co.order_type = 'medication'
                 AND COALESCE(co.status, 'ordered') !~* $4
                 AND (
                   (aba.encounter_id IS NOT NULL AND co.encounter_id = aba.encounter_id)
                   OR co.created_at >= COALESCE(aba.admitted_at, aba.ward_arrived_at)
                 )
            )
        AND NOT EXISTS (
              -- C-M6: dedupe on the canonical SLA clock, not the legacy
              -- audit_logs marker (which was permanently one-shot). An OPEN
              -- clock means the alert already fired and the chart is still
              -- missing; a COMPLETED clock (chart was entered, then emptied
              -- again) lets the admission re-select so the sweep can re-arm.
              SELECT 1
                FROM workflow_sla_instances wsi
               WHERE wsi.tenant_id = aba.tenant_id
                 AND wsi.rule_code = $5
                 AND wsi.source_table = 'admissions'
                 AND wsi.source_id = aba.admission_id::text
                 AND wsi.completed_at IS NULL
            )
      ORDER BY ward_arrived_at ASC, admission_id ASC
      LIMIT $6::int`,
    nowIso,
    safeGrace,
    ACTIVE_ADMISSION_STATUSES,
    ACTIVE_MEDICATION_STATUS_RE,
    DRUG_CHART_SLA_RULE_CODE,
    safeLimit,
  );
}

async function findDoctorRecipients(admission) {
  const doctorUids = uniqueUids([
    admission.attending_doctor,
    admission.admitting_doctor,
  ]);
  if (!doctorUids.length || !admission.tenant_id) return [];

  // The doctor UIDs come from the admission row itself (already tenant-bound),
  // but we still scope by users.tenant_id ($4) so recipient resolution is
  // uniformly tenant-internal and cannot leak across tenants.
  return prisma.$queryRawUnsafe(
    `SELECT id,
            uid,
            name,
            phone,
            role,
            CASE
              WHEN uid = $2::uuid THEN 'attending_doctor'
              ELSE 'admitting_doctor'
            END AS recipient_kind,
            'admission_doctor'::text AS source
       FROM users
      WHERE uid = ANY($1::uuid[])
        AND is_active = true
        AND tenant_id = $4::uuid
        AND role = ANY($3::text[])
      ORDER BY CASE WHEN uid = $2::uuid THEN 0 ELSE 1 END, id`,
    doctorUids,
    admission.attending_doctor || admission.admitting_doctor || null,
    DOCTOR_ROLES,
    admission.tenant_id,
  );
}

async function findRosterNurseRecipients({
  tenantId = null,
  wardId = null,
  wardName = null,
  now = new Date(),
  timezone = DEFAULT_TIMEZONE,
} = {}) {
  if (!tenantId) return [];
  if (!wardId && !wardName) return [];
  // The staff_shift_roster_* tables carry no tenant_id; the admission's tenant
  // is enforced through users.tenant_id ($6) so a nurse rostered in another
  // tenant (even on a same-id / same-named ward) is never selected.
  return prisma.$queryRawUnsafe(
    `WITH ctx AS (
       SELECT $3::timestamptz AS ts,
              ($3::timestamptz AT TIME ZONE $4)::date AS local_date,
              ($3::timestamptz AT TIME ZONE $4)::time AS local_time
     )
     SELECT DISTINCT ON (u.id)
            u.id,
            u.uid,
            u.name,
            u.phone,
            u.role,
            CASE WHEN a.is_lead THEN 'ward_nurse_lead' ELSE 'ward_nurse' END
              AS recipient_kind,
            'published_nursing_roster'::text AS source
       FROM ctx
       JOIN staff_shift_roster_boards b
         ON b.department = 'nursing'
        AND b.status = 'published'
        AND b.roster_date IN (ctx.local_date, ctx.local_date - 1)
       JOIN staff_shift_roster_assignments a
         ON a.roster_id = b.id
        AND a.status = 'published'
        AND a.assignment_target_type = 'ward'
       JOIN users u ON u.id = a.staff_id
      WHERE u.is_active = true
        AND u.tenant_id = $6::uuid
        AND u.role = ANY($5::text[])
        AND (
          ($1::int IS NOT NULL AND a.assignment_target_id = $1::int)
          OR ($2::text IS NOT NULL AND LOWER(a.assignment_target_label) = LOWER($2::text))
        )
        AND (
          (
            b.shift_end > b.shift_start
            AND b.roster_date = ctx.local_date
            AND ctx.local_time >= b.shift_start
            AND ctx.local_time < b.shift_end
          )
          OR (
            b.shift_end <= b.shift_start
            AND (
              (b.roster_date = ctx.local_date AND ctx.local_time >= b.shift_start)
              OR (b.roster_date = ctx.local_date - 1 AND ctx.local_time < b.shift_end)
            )
          )
        )
      ORDER BY u.id, a.is_lead DESC, b.shift_start ASC`,
    wardId || null,
    wardName || null,
    toIso(now),
    timezone,
    NURSING_ROLES,
    tenantId,
  );
}

async function findNursingInchargeFallbackRecipients({ tenantId = null } = {}) {
  if (!tenantId) return [];
  // Tenant-scope the escalation fallback through users.tenant_id ($1) so a
  // super-admin cron sweep never pages an in-charge from a different tenant.
  return prisma.$queryRawUnsafe(
    `SELECT id,
            uid,
            name,
            phone,
            role,
            'nursing_incharge_fallback'::text AS recipient_kind,
            'nursing_escalation_fallback'::text AS source
       FROM users
      WHERE is_active = true
        AND tenant_id = $1::uuid
        AND role IN ('NURSING_INCHARGE', 'ICU_INCHARGE', 'CNO')
      ORDER BY CASE role
                 WHEN 'NURSING_INCHARGE' THEN 0
                 WHEN 'ICU_INCHARGE' THEN 1
                 ELSE 2
               END,
               name NULLS LAST,
               id`,
    tenantId,
  );
}

export async function resolveDrugChartAlertRecipients({
  admission,
  now = new Date(),
  timezone = DEFAULT_TIMEZONE,
} = {}) {
  const [doctors, nurses] = await Promise.all([
    findDoctorRecipients(admission),
    findRosterNurseRecipients({
      tenantId: admission.tenant_id,
      wardId: admission.ward_id,
      wardName: admission.ward_name,
      now,
      timezone,
    }),
  ]);

  const fallbackNursing = nurses.length
    ? []
    : await findNursingInchargeFallbackRecipients({ tenantId: admission.tenant_id });

  return uniqueRecipients([...doctors, ...nurses, ...fallbackNursing]);
}

async function insertDrugChartNotifications({
  admission,
  recipients,
  now = new Date(),
  graceMinutes = DEFAULT_GRACE_MINUTES,
  db = null,
} = {}) {
  const ids = uniqueRecipients(recipients).map(row => row.id);
  if (!ids.length || !admission.tenant_id) return [];

  const title = 'Drug chart pending after admission';
  const body = `${admissionLabel(admission)} has no inpatient drug chart after ${graceMinutes} minutes. Please review and enter orders or document the plan.`;
  const data = notificationData(admission, {
    grace_minutes: graceMinutes,
    minutes_since_ward_arrival: admission.minutes_since_ward_arrival ?? null,
    ward_arrived_at: admission.ward_arrived_at || null,
    alert_state: 'open',
  });

  // The sweep runs under a super-admin cron context, so the GUC-reading
  // tenant_id DEFAULT on `notifications` would resolve to the literal default
  // tenant. Write the admission's true tenant_id explicitly ($8) AND scope the
  // recipient sub-select by u.tenant_id so a stray cross-tenant recipient id is
  // never inserted; setTenantTx pins the GUC so the dedup/WITH CHECK both apply
  // to the admission's tenant. When the caller already holds a tenant-scoped
  // transaction (`db`), ride on it so the notifications commit atomically with
  // the canonical SLA clock.
  const run = (tx) => tx.$queryRawUnsafe(
    `INSERT INTO notifications
       (uid, user_id, phone, title, body, type, priority, data, is_read,
        created_at, updated_at, related_id, recipient_role, tenant_id)
     SELECT u.uid,
            u.id,
            u.phone,
            $2,
            $3,
            $4::varchar,
            'HIGH',
            $5::jsonb,
            false,
            $6::timestamptz,
            $6::timestamptz,
            $1::int,
            u.role,
            $8::uuid
       FROM users u
      WHERE u.id = ANY($7::int[])
        AND u.is_active = true
        AND u.tenant_id = $8::uuid
        AND u.phone IS NOT NULL
        AND TRIM(u.phone) <> ''
        AND NOT EXISTS (
          SELECT 1
            FROM notifications n
           WHERE n.user_id = u.id
             AND n.type = $4::varchar
             AND n.related_id = $1::int
        )
      RETURNING id, user_id`,
    admission.admission_id,
    title,
    body,
    DRUG_CHART_MISSING_ALERT_TYPE,
    JSON.stringify(data),
    toIso(now),
    ids,
    admission.tenant_id,
  );
  return db ? run(db) : setTenantTx(admission.tenant_id, run);
}

// Start (or re-arm) the canonical drug-chart-missing SLA clock inside the
// caller's tenant transaction. Modeled on admissionService.startBedCleaningSlaInTx
// (PR #768): startWorkflowSla's ON CONFLICT deliberately preserves an existing
// clock, so a chart that was entered (clock completed) and later emptied again
// conflicts with the closed clock — re-arm it (domain-owned reopen, per the
// startWorkflowSla contract). A prior clock that is still open
// (completed_at IS NULL) is left untouched, which is exactly the sweep's
// dedupe. strict: an SLA write failure has already aborted the Postgres tx, so
// swallowing it would only convert the rollback into a misleading 25P02.
async function startDrugChartSlaInTx(tx, {
  admission,
  recipients = [],
  now = new Date(),
  graceMinutes = DEFAULT_GRACE_MINUTES,
} = {}) {
  const instance = await startWorkflowSla({
    tenantId: admission.tenant_id,
    ruleCode: DRUG_CHART_SLA_RULE_CODE,
    patientUid: admission.patient_uid,
    encounterId: admission.encounter_id || null,
    sourceTable: 'admissions',
    sourceId: String(admission.admission_id),
    priority: 'high',
    metadata: {
      source: 'drug_chart_sla',
      grace_minutes: graceMinutes,
      ward_arrived_at: admission.ward_arrived_at || null,
      minutes_since_ward_arrival: admission.minutes_since_ward_arrival ?? null,
      detected_at: toIso(now),
      recipient_count: recipients.length,
    },
  }, { db: tx, strict: true });

  if (instance && instance.completed_at) {
    const rearmed = await tx.$queryRawUnsafe(
      `UPDATE workflow_sla_instances i
          SET status = 'active',
              completed_at = NULL,
              breached_at = NULL,
              escalated_at = NULL,
              started_at = NOW(),
              due_at = NOW() + (
                SELECT r.target_minutes FROM workflow_sla_rules r WHERE r.id = i.rule_id
              ) * INTERVAL '1 minute',
              metadata = COALESCE(i.metadata, '{}'::jsonb) || jsonb_build_object(
                'reopened_at', NOW(),
                'prior_completed_at', i.completed_at
              ),
              updated_at = NOW()
        WHERE i.id = $1::uuid
          AND i.tenant_id = $2::uuid
        RETURNING i.*`,
      instance.id,
      admission.tenant_id,
    );
    return rearmed[0] ?? instance;
  }
  return instance;
}

async function insertMissingDrugChartAudit({
  admission,
  recipients,
  notificationRows,
  now = new Date(),
  graceMinutes = DEFAULT_GRACE_MINUTES,
} = {}) {
  const metadata = notificationData(admission, {
    grace_minutes: graceMinutes,
    minutes_since_ward_arrival: admission.minutes_since_ward_arrival ?? null,
    ward_arrived_at: admission.ward_arrived_at || null,
    detected_at: toIso(now),
    recipient_count: recipients.length,
    notification_count: notificationRows.length,
    recipients: recipients.map(row => ({
      id: row.id,
      uid: row.uid,
      role: row.role,
      recipient_kind: row.recipient_kind,
      source: row.source,
    })),
    metric_key: 'drug_chart_missing_after_ward_arrival',
  });

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO audit_logs
       (uid, role, action, resource, resource_id, metadata, created_at)
     SELECT NULL::uuid,
            'system',
            $2::varchar,
            'admission',
            $1::text,
            $3::jsonb,
            $4::timestamp
      WHERE NOT EXISTS (
        SELECT 1
          FROM audit_logs
         WHERE action = $2::varchar
           AND resource = 'admission'
           AND resource_id = $1::text
      )
     RETURNING id`,
    String(admission.admission_id),
    DRUG_CHART_MISSING_AUDIT_ACTION,
    JSON.stringify(metadata),
    toIso(now),
  );
  return rows[0] || null;
}

export async function processMissingDrugChartAdmission({
  admission,
  now = new Date(),
  graceMinutes = DEFAULT_GRACE_MINUTES,
  timezone = DEFAULT_TIMEZONE,
} = {}) {
  const recipients = await resolveDrugChartAlertRecipients({
    admission,
    now,
    timezone,
  });

  // Phase 1 — atomic + tenant-scoped: the canonical SLA clock (start or
  // re-arm) and the recipient notifications commit together under the
  // admission's tenant. A failed SLA write rolls both back and the next
  // 5-minute tick retries (the open-clock dedupe only engages once the clock
  // row exists).
  const { slaInstance, notificationRows } = await setTenantTx(
    admission.tenant_id,
    async (tx) => {
      const sla = await startDrugChartSlaInTx(tx, {
        admission,
        recipients,
        now,
        graceMinutes,
      });
      const inserted = await insertDrugChartNotifications({
        admission,
        recipients,
        now,
        graceMinutes,
        db: tx,
      });
      return { slaInstance: sla, notificationRows: inserted };
    },
  );

  // Phase 1.5 — the legacy audit_logs marker stays for metrics continuity
  // (metric_key drug_chart_missing_after_ward_arrival dashboards). Dedupe now
  // lives on the SLA instance; this marker keeps its own one-shot NOT EXISTS,
  // recording only the FIRST alert per admission.
  const audit = await insertMissingDrugChartAudit({
    admission,
    recipients,
    notificationRows,
    now,
    graceMinutes,
  });

  return {
    admission_id: admission.admission_id,
    patient_uid: admission.patient_uid,
    recipient_count: recipients.length,
    notification_count: notificationRows.length,
    audit_id: audit?.id || null,
    sla_instance_id: slaInstance?.id || null,
  };
}

export async function runMissingDrugChartSweep({
  now = new Date(),
  graceMinutes = DEFAULT_GRACE_MINUTES,
  limit = DEFAULT_SWEEP_LIMIT,
  timezone = DEFAULT_TIMEZONE,
} = {}) {
  const candidates = await findAdmissionsMissingDrugChart({
    now,
    graceMinutes,
    limit,
  });
  const alerts = [];

  for (const admission of candidates) {
    try {
      alerts.push(await processMissingDrugChartAdmission({
        admission,
        now,
        graceMinutes,
        timezone,
      }));
    } catch (err) {
      logger.warn('Drug chart SLA alert failed for admission', {
        admissionId: admission.admission_id,
        error: err.message,
      });
    }
  }

  if (candidates.length) {
    logger.info(`Drug chart SLA sweep checked ${candidates.length} delayed admission(s); ${alerts.length} alert(s) processed.`);
  }

  return {
    checked: candidates.length,
    alerts,
  };
}

async function findAdmissionForMedicationOrder(order) {
  if (!order?.patient_uid) return null;
  const createdAt = toIso(order.created_at || new Date());
  const rows = await prisma.$queryRawUnsafe(
    `SELECT a.id AS admission_id,
            a.tenant_id,
            a.patient_uid,
            a.encounter_id,
            a.admitting_doctor,
            a.attending_doctor,
            a.admitted_at,
            COALESCE(b.assigned_at, b.admitted_at, a.admitted_at, a.created_at) AS ward_arrived_at,
            b.id AS bed_id,
            b.bed_number,
            b.ward_id,
            COALESCE(w.name, b.ward_name, a.ward) AS ward_name,
            COALESCE(w.floor::text, b.floor::text) AS floor,
            u.name AS patient_name
       FROM admissions a
  LEFT JOIN beds b ON b.id = a.bed_id
  LEFT JOIN wards w ON w.id = b.ward_id
  LEFT JOIN users u ON u.uid = a.patient_uid
      WHERE a.patient_uid = $1::uuid
        AND a.status = ANY($4::text[])
        AND (
          ($2::uuid IS NOT NULL AND a.encounter_id = $2::uuid)
          OR $3::timestamptz >= COALESCE(a.admitted_at, a.created_at)
        )
      ORDER BY
        CASE WHEN $2::uuid IS NOT NULL AND a.encounter_id = $2::uuid THEN 0 ELSE 1 END,
        a.admitted_at DESC NULLS LAST,
        a.id DESC
      LIMIT 1`,
    order.patient_uid,
    order.encounter_id || null,
    createdAt,
    ACTIVE_ADMISSION_STATUSES,
  );
  return rows[0] || null;
}

async function countMedicationOrdersForAdmission({ admission, order }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS order_count
       FROM clinical_orders co
      WHERE co.tenant_id = $1::uuid
        AND co.patient_uid = $2::uuid
        AND co.order_type = 'medication'
        AND COALESCE(co.status, 'ordered') !~* $6
        AND co.created_at <= $3::timestamptz
        AND (
          ($4::uuid IS NOT NULL AND co.encounter_id = $4::uuid)
          OR co.created_at >= COALESCE($5::timestamptz, co.created_at)
        )`,
    admission.tenant_id,
    admission.patient_uid,
    toIso(order.created_at || new Date()),
    admission.encounter_id || null,
    admission.admitted_at || admission.ward_arrived_at || null,
    ACTIVE_MEDICATION_STATUS_RE,
  );
  return Number(rows[0]?.order_count || 0);
}

// Any canonical SLA instance for the admission (open or closed) means the
// missing-chart alert fired at least once — the normalized source for the
// after_missing_alert metric, replacing the legacy audit_logs marker read.
async function missingAlertAlreadyRaised(admission) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id
       FROM workflow_sla_instances
      WHERE tenant_id = $1::uuid
        AND rule_code = $2
        AND source_table = 'admissions'
        AND source_id = $3
      LIMIT 1`,
    admission.tenant_id,
    DRUG_CHART_SLA_RULE_CODE,
    String(admission.admission_id),
  );
  return rows.length > 0;
}

// The sweep's clock for this admission, but only while it is OPEN. Guards the
// completion write so re-entry after a terminal completion never overwrites
// the closed instance (completeWorkflowSla itself carries no status guard —
// known F-L4; re-opening is owned exclusively by the sweep's re-arm).
async function findOpenDrugChartSla(admission) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id
       FROM workflow_sla_instances
      WHERE tenant_id = $1::uuid
        AND rule_code = $2
        AND source_table = 'admissions'
        AND source_id = $3
        AND completed_at IS NULL
      LIMIT 1`,
    admission.tenant_id,
    DRUG_CHART_SLA_RULE_CODE,
    String(admission.admission_id),
  );
  return rows[0] || null;
}

export async function recordFirstDrugChartEntry(order) {
  if (!order || order.order_type !== 'medication') return null;

  try {
    const admission = await findAdmissionForMedicationOrder(order);
    if (!admission) return null;

    // C-M6 resolution side: a medication order entered while the canonical
    // drug-chart-missing clock is OPEN resolves it, whatever the order count —
    // an open clock by definition means the chart was empty at sweep time.
    // completeWorkflowSla computes completed-vs-breached against due_at itself.
    const openSla = await findOpenDrugChartSla(admission);
    if (openSla) {
      await completeWorkflowSla({
        tenantId: admission.tenant_id,
        ruleCode: DRUG_CHART_SLA_RULE_CODE,
        sourceTable: 'admissions',
        sourceId: String(admission.admission_id),
        metadata: {
          order_id: order.id,
          order_number: order.order_number || null,
          entered_at: toIso(order.created_at || new Date()),
        },
      });
    }

    const orderCount = await countMedicationOrdersForAdmission({ admission, order });
    if (orderCount !== 1) return null;

    const enteredAt = order.created_at || new Date();
    const delayMinutes = minutesBetween(admission.ward_arrived_at || admission.admitted_at, enteredAt);
    const afterMissingAlert = await missingAlertAlreadyRaised(admission);
    const metadata = notificationData(admission, {
      order_id: order.id,
      order_number: order.order_number || null,
      ordered_by: order.ordered_by || null,
      entered_at: toIso(enteredAt),
      ward_arrived_at: admission.ward_arrived_at || null,
      delay_minutes: delayMinutes,
      delayed_after_60_min: delayMinutes === null ? null : delayMinutes > DEFAULT_GRACE_MINUTES,
      after_missing_alert: afterMissingAlert,
      metric_key: 'drug_chart_time_to_first_entry',
    });

    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO audit_logs
         (uid, role, action, resource, resource_id, metadata, created_at)
       SELECT $2::uuid,
              'system',
              $3::varchar,
              'admission',
              $1::text,
              $4::jsonb,
              $5::timestamp
        WHERE NOT EXISTS (
          SELECT 1
            FROM audit_logs
           WHERE action = $3::varchar
             AND resource = 'admission'
             AND resource_id = $1::text
        )
       RETURNING id`,
      String(admission.admission_id),
      order.ordered_by || null,
      DRUG_CHART_FIRST_ENTERED_AUDIT_ACTION,
      JSON.stringify(metadata),
      toIso(enteredAt),
    );
    return rows[0] || null;
  } catch (err) {
    logger.warn('Drug chart first-entry audit failed', {
      orderId: order.id,
      error: err.message,
    });
    return null;
  }
}

export default {
  findAdmissionsMissingDrugChart,
  processMissingDrugChartAdmission,
  recordFirstDrugChartEntry,
  resolveDrugChartAlertRecipients,
  runMissingDrugChartSweep,
};
