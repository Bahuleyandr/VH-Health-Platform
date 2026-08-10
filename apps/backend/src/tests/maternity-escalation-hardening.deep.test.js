// BE-H2 + BE-M2 (review 2026-08-09) — deep regressions for the maternity
// swallowed-failure hardening.
//
// BE-H2: recordAncVisit's post-commit pre-eclampsia check used to swallow
// every failure into `alerts: []`. Now, when the alert engine DETECTS an
// anomaly but cannot persist the clinical_alerts fan-out, the API must NOT
// report success: the committed visit stands, the caller gets
// CLINICAL_ALERT_PERSIST_FAILED, and a clinical_audit_events 'failed' row
// records the drop (mirrors vitalsChartService.recordVitals).
//
// BE-M2: a partograph entry that crosses the WHO ACTION line (or records a
// fetal deceleration) used to store the flag and notify NOBODY. Now it
// raises: a canonical escalation pair atomic with the entry, a CRITICAL
// clinical_alerts row, and a durable notification_outbox care-team alert —
// and a normal entry raises nothing.
//
// Template: maternity-anc-atomicity.deep.test.js (self-skips without a DB,
// injected failure triggers, superuser fixture cleanup).

import { randomUUID } from 'crypto';

import prisma from '../lib/prisma.js';
import {
  admitToLabor,
  recordAncVisit,
  recordPartographEntry,
} from '../services/maternity/maternityService.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = DEFAULT_TENANT_ID;
const ACTOR_UID = randomUUID();
const DUTY_DOCTOR_UID = randomUUID();
const createdUserUids = [ACTOR_UID];
const installedTriggers = [];
let phoneSequence = 0;

function nextPhone() {
  phoneSequence += 1;
  return `+9188${String(Date.now()).slice(-7)}${phoneSequence}`;
}

async function dropFailureTrigger(entry) {
  await prisma.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS ${entry.triggerName} ON ${entry.table}`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DROP FUNCTION IF EXISTS ${entry.functionName}()`,
  ).catch(() => {});
  const index = installedTriggers.indexOf(entry);
  if (index >= 0) installedTriggers.splice(index, 1);
}

async function installFailureTrigger({ table, operation, condition }) {
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `mesc_fail_${suffix}`;
  const triggerName = `mesc_trigger_${suffix}`;
  const entry = { table, functionName, triggerName };

  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION ${functionName}()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $$
       BEGIN
         IF ${condition} THEN
           RAISE EXCEPTION 'M-ESC injected failure ${suffix}';
         END IF;
         RETURN NEW;
       END;
       $$`,
  );
  try {
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${triggerName}
         AFTER ${operation} ON ${table}
         FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    );
  } catch (error) {
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${functionName}()`).catch(() => {});
    throw error;
  }

  installedTriggers.push(entry);
  return () => dropFailureTrigger(entry);
}

async function seedPatient() {
  const uid = randomUUID();
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
     VALUES ($1::uuid, $2, $3, 'PATIENT', true, $4::uuid, NOW()) RETURNING id`,
    uid, nextPhone(), `M-ESC Patient ${randomUUID().slice(0, 8)}`, TENANT,
  );
  createdUserUids.push(uid);
  return { uid, id: rows[0].id };
}

async function seedPregnancy(patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_pregnancies
       (patient_uid, pregnancy_number, lmp_date, edd_date, status, created_by, tenant_id)
     VALUES ($1::uuid, 1, '2025-11-01'::date, '2025-11-01'::date + 280,
             'ongoing', $2::uuid, $3::uuid)
     RETURNING *`,
    patientUid, ACTOR_UID, TENANT,
  );
  return rows[0];
}

async function cleanup() {
  for (const entry of [...installedTriggers]) await dropFailureTrigger(entry);
  if (createdUserUids.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM notification_outbox WHERE payload->>'patient_uid' = ANY($1::text[])`,
      createdUserUids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events WHERE patient_uid = ANY($1::uuid[])`,
      createdUserUids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events WHERE patient_uid = ANY($1::uuid[])`,
      createdUserUids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_alerts WHERE patient_id IN (
         SELECT id FROM users WHERE uid = ANY($1::uuid[]))`,
      createdUserUids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM cds_alerts WHERE patient_uid = ANY($1::uuid[])`,
      createdUserUids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM maternity_partograph_entries WHERE labor_admission_id IN (
         SELECT la.id FROM maternity_labor_admissions la
         JOIN maternity_pregnancies p ON p.id = la.pregnancy_id
        WHERE p.patient_uid = ANY($1::uuid[]))`,
      createdUserUids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM maternity_labor_admissions WHERE pregnancy_id IN (
         SELECT id FROM maternity_pregnancies WHERE patient_uid = ANY($1::uuid[]))`,
      createdUserUids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM maternity_anc_visits WHERE pregnancy_id IN (
         SELECT id FROM maternity_pregnancies WHERE patient_uid = ANY($1::uuid[]))`,
      createdUserUids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM maternity_pregnancies WHERE patient_uid = ANY($1::uuid[])`,
      createdUserUids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = ANY($1::uuid[])`,
      createdUserUids,
    ).catch(() => {});
  }
}

d('BE-H2 — ANC pre-eclampsia alert-persistence failure is surfaced, never swallowed', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'M-ESC Nurse', 'NURSING_STAFF', true, $3::uuid, NOW())`,
      ACTOR_UID, nextPhone(), TENANT,
    );
    // R2 fan-out audience: partograph escalations with no attending
    // obstetrician now fan out to concrete duty-doctor recipients instead of
    // queueing an undeliverable recipientId:null broadcast row.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'M-ESC Duty Doctor', 'DUTY_DOCTOR', true, $3::uuid, NOW())`,
      DUTY_DOCTOR_UID, nextPhone(), TENANT,
    );
    createdUserUids.push(DUTY_DOCTOR_UID);
  }, 30_000);

  afterEach(async () => {
    for (const entry of [...installedTriggers]) await dropFailureTrigger(entry);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('hypertensive visit with a working alert engine returns alerts and alerts_check_failed: false', async () => {
    const patient = await seedPatient();
    const pregnancy = await seedPregnancy(patient.uid);

    const visit = await recordAncVisit({
      tenantId: TENANT,
      pregnancy_id: pregnancy.id,
      visit_date: '2026-08-01',
      bp_systolic: 150,
      bp_diastolic: 95,
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });

    expect(visit.alerts_check_failed).toBe(false);
    expect(visit.alerts.length).toBeGreaterThan(0);
    const alertRows = await prisma.$queryRawUnsafe(
      `SELECT severity FROM clinical_alerts WHERE patient_id = $1::int`,
      patient.id,
    );
    expect(alertRows.length).toBeGreaterThan(0);
  });

  test('alert persistence failure -> CLINICAL_ALERT_PERSIST_FAILED, visit stands, failed audit row exists', async () => {
    const patient = await seedPatient();
    const pregnancy = await seedPregnancy(patient.uid);
    const removeTrigger = await installFailureTrigger({
      table: 'clinical_alerts',
      operation: 'INSERT',
      condition: `NEW.patient_id = ${Number(patient.id)}`,
    });

    await expect(recordAncVisit({
      tenantId: TENANT,
      pregnancy_id: pregnancy.id,
      visit_date: '2026-08-02',
      bp_systolic: 152,
      bp_diastolic: 96,
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toMatchObject({ code: 'CLINICAL_ALERT_PERSIST_FAILED', statusCode: 500 });
    await removeTrigger();

    // The visit itself committed (alert generation is post-commit) …
    const visits = await prisma.$queryRawUnsafe(
      `SELECT id FROM maternity_anc_visits
        WHERE tenant_id = $1::uuid AND pregnancy_id = $2::int`,
      TENANT, Number(pregnancy.id),
    );
    expect(visits).toHaveLength(1);

    // … no alert row exists (the drop is real) …
    const alertRows = await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_alerts WHERE patient_id = $1::int`,
      patient.id,
    );
    expect(alertRows).toHaveLength(0);

    // … and the failed audit row is the durable trace of the drop.
    const auditRows = await prisma.$queryRawUnsafe(
      `SELECT action, action_status FROM clinical_audit_events
        WHERE idempotency_key = $1`,
      `maternity_anc_visits:${visits[0].id}:anc_preeclampsia_alert_persist_failed`,
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'anc_preeclampsia_alert_persist_failed',
      action_status: 'failed',
    });
  });

  test('labor admission preserves clinically valid zero dilation and effacement', async () => {
    const patient = await seedPatient();
    const pregnancy = await seedPregnancy(patient.uid);

    const labor = await admitToLabor({
      tenantId: TENANT,
      pregnancy_id: pregnancy.id,
      cervix_dilation_cm: 0,
      cervix_effacement_pct: 0,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });

    expect(Number(labor.cervix_dilation_cm)).toBe(0);
    expect(labor.cervix_effacement_pct).toBe(0);
  });

  test('partograph ACTION-line entry escalates: canonical pair + CRITICAL alert + outbox row (and a normal entry does not)', async () => {
    const patient = await seedPatient();
    const pregnancy = await seedPregnancy(patient.uid);
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const labor = await admitToLabor({
      tenantId: TENANT,
      pregnancy_id: pregnancy.id,
      admission_reason: 'labour pains',
      cervix_dilation_cm: 4,
      fetal_heart_rate_bpm: 140,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });
    await prisma.$executeRawUnsafe(
      `UPDATE maternity_labor_admissions SET admitted_at = $1::timestamptz WHERE id = $2::int`,
      twelveHoursAgo,
      Number(labor.id),
    );

    // 12h into active phase at 5cm -> below the action line (WHO trigger).
    const escalated = await recordPartographEntry({
      tenantId: TENANT,
      labor_admission_id: labor.id,
      cervix_dilation_cm: 5,
      fetal_heart_rate_bpm: 96,
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });

    expect(escalated.on_action_line).toBe(true);
    expect(escalated.escalation_raised).toBe(true);

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type, event_subtype, event_status FROM clinical_timeline_events
        WHERE idempotency_key = $1`,
      `maternity_partograph_entries:${escalated.id}:escalation_raised`,
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      event_type: 'maternity.partograph_escalation_raised',
      event_subtype: 'action_line_crossed',
      event_status: 'raised',
    });
    const audit = await prisma.$queryRawUnsafe(
      `SELECT action, action_status FROM clinical_audit_events
        WHERE idempotency_key = $1`,
      `maternity_partograph_entries:${escalated.id}:audit:escalation_raised`,
    );
    expect(audit).toHaveLength(1);

    const alertRows = await prisma.$queryRawUnsafe(
      `SELECT alert_type, vital_name, severity, message FROM clinical_alerts
        WHERE patient_id = $1::int AND alert_type = 'PARTOGRAPH_ESCALATION'`,
      patient.id,
    );
    expect(alertRows).toHaveLength(1);
    expect(alertRows[0]).toMatchObject({
      vital_name: 'partograph_action_line',
      severity: 'CRITICAL',
    });

    // R2 fan-out: no attending obstetrician on this labour, so the escalation
    // fans out to concrete duty-doctor recipients — one PENDING row per
    // recipient, never a recipientId:null broadcast row (>= 1 because other
    // suites may have seeded additional doctor-tier users in this tenant).
    const outboxRows = await prisma.$queryRawUnsafe(
      `SELECT status, title, recipient_id FROM notification_outbox
        WHERE tenant_id = $1::uuid AND source_event_key = $2`,
      TENANT, `maternity_partograph_entries:${escalated.id}:escalation_alert`,
    );
    expect(outboxRows.length).toBeGreaterThanOrEqual(1);
    for (const row of outboxRows) {
      expect(row.status).toBe('PENDING');
      expect(row.title).toMatch(/action line/i);
      expect(row.recipient_id).not.toBeNull();
    }

    // A normal-progress entry on a fresh labour raises NOTHING.
    const patient2 = await seedPatient();
    const pregnancy2 = await seedPregnancy(patient2.uid);
    const labor2 = await admitToLabor({
      tenantId: TENANT,
      pregnancy_id: pregnancy2.id,
      cervix_dilation_cm: 4,
      labor_started_at: new Date().toISOString(),
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });
    const normal = await recordPartographEntry({
      tenantId: TENANT,
      labor_admission_id: labor2.id,
      cervix_dilation_cm: 6,
      fetal_heart_rate_bpm: 138,
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });

    expect(normal.on_action_line).toBe(false);
    expect(normal.escalation_raised).toBe(false);
    const normalTimeline = await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_timeline_events
        WHERE patient_uid = $1::uuid AND event_type = 'maternity.partograph_escalation_raised'`,
      patient2.uid,
    );
    expect(normalTimeline).toHaveLength(0);
    const normalAlerts = await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_alerts WHERE patient_id = $1::int`,
      patient2.id,
    );
    expect(normalAlerts).toHaveLength(0);
  }, 30_000);

  test('a failing in-tx escalation canonical pair rolls the partograph entry back (atomicity)', async () => {
    const patient = await seedPatient();
    const pregnancy = await seedPregnancy(patient.uid);
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const labor = await admitToLabor({
      tenantId: TENANT,
      pregnancy_id: pregnancy.id,
      cervix_dilation_cm: 4,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });
    await prisma.$executeRawUnsafe(
      `UPDATE maternity_labor_admissions SET admitted_at = $1::timestamptz WHERE id = $2::int`,
      twelveHoursAgo,
      Number(labor.id),
    );
    const removeTrigger = await installFailureTrigger({
      table: 'clinical_timeline_events',
      operation: 'INSERT',
      condition: `NEW.patient_uid = '${patient.uid}'::uuid AND NEW.event_type = 'maternity.partograph_escalation_raised'`,
    });

    await expect(recordPartographEntry({
      tenantId: TENANT,
      labor_admission_id: labor.id,
      cervix_dilation_cm: 5, // 12h in at 5cm -> action line -> escalation pair required
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toBeTruthy();
    await removeTrigger();

    const entries = await prisma.$queryRawUnsafe(
      `SELECT id FROM maternity_partograph_entries WHERE labor_admission_id = $1::int`,
      Number(labor.id),
    );
    expect(entries).toHaveLength(0);
    // The labour-admission event above committed separately; the ENTRY's own
    // pair and the escalation pair must both have rolled back with the row.
    const timeline = await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_timeline_events
        WHERE patient_uid = $1::uuid AND event_type LIKE 'maternity.partograph%'`,
      patient.uid,
    );
    expect(timeline).toHaveLength(0);
    const alerts = await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_alerts WHERE patient_id = $1::int`,
      patient.id,
    );
    expect(alerts).toHaveLength(0);
    const outboxRows = await prisma.$queryRawUnsafe(
      `SELECT id FROM notification_outbox WHERE payload->>'patient_uid' = $1`,
      patient.uid,
    );
    expect(outboxRows).toHaveLength(0);
  }, 30_000);

  test('fetal deceleration escalates even when the action line is not crossed', async () => {
    const patient = await seedPatient();
    const pregnancy = await seedPregnancy(patient.uid);
    const labor = await admitToLabor({
      tenantId: TENANT,
      pregnancy_id: pregnancy.id,
      cervix_dilation_cm: 4,
      labor_started_at: new Date().toISOString(),
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });

    const entry = await recordPartographEntry({
      tenantId: TENANT,
      labor_admission_id: labor.id,
      cervix_dilation_cm: 6,
      fetal_heart_rate_bpm: 98,
      fetal_decel: 'late',
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });

    expect(entry.on_action_line).toBe(false);
    expect(entry.escalation_raised).toBe(true);
    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_subtype FROM clinical_timeline_events
        WHERE idempotency_key = $1`,
      `maternity_partograph_entries:${entry.id}:escalation_raised`,
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0].event_subtype).toBe('fetal_decel');
    const alertRows = await prisma.$queryRawUnsafe(
      `SELECT vital_name FROM clinical_alerts
        WHERE patient_id = $1::int AND alert_type = 'PARTOGRAPH_ESCALATION'`,
      patient.id,
    );
    expect(alertRows).toHaveLength(1);
    expect(alertRows[0].vital_name).toBe('fetal_decel');
  }, 30_000);
});
