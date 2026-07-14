import { randomUUID } from 'crypto';

import prisma from '../lib/prisma.js';
import {
  maybePropagateAncSupplements,
  recordAncVisit,
  recordFetalKick,
  recordSupplement,
  setSupplementReminder,
} from '../services/maternity/maternityService.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_A = DEFAULT_TENANT_ID;
const TENANT_B = randomUUID();
const TENANT_B_SLUG = `ma-atomic-${randomUUID().slice(0, 8)}`;
const ACTOR_UID = randomUUID();
const createdUserUids = [];
const installedTriggers = [];
let phoneSequence = 0;

function nextPhone() {
  phoneSequence += 1;
  return `+9186${String(Date.now()).slice(-7)}${phoneSequence}`;
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
  const functionName = `ma_atomic_fail_${suffix}`;
  const triggerName = `ma_atomic_trigger_${suffix}`;
  const entry = { table, functionName, triggerName };

  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION ${functionName}()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $$
       BEGIN
         IF ${condition} THEN
           RAISE EXCEPTION 'M-A injected failure ${suffix}';
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

async function seedUser({
  tenantId = TENANT_A,
  role = 'PATIENT',
  uid = randomUUID(),
  isPregnant = false,
} = {}) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users
       (uid, phone, name, role, is_active, is_pregnant, tenant_id, updated_at)
     VALUES ($1::uuid, $2, $3, $4, true, $5, $6::uuid, NOW())`,
    uid,
    nextPhone(),
    `M-A Atomic ${randomUUID().slice(0, 8)}`,
    role,
    isPregnant,
    tenantId,
  );
  createdUserUids.push(uid);
  return uid;
}

async function seedPregnancy({ patientUid, tenantId = TENANT_A } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_pregnancies
       (patient_uid, pregnancy_number, lmp_date, edd_date, status, created_by, tenant_id)
     VALUES ($1::uuid, 1, '2025-11-01'::date, '2025-11-01'::date + 280,
             'ongoing', $2::uuid, $3::uuid)
     RETURNING *`,
    patientUid,
    ACTOR_UID,
    tenantId,
  );
  return rows[0];
}

async function seedSupplement({ pregnancyId, tenantId = TENANT_A, reminderEnabled = true } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_supplements
       (pregnancy_id, supplement, dose, frequency, route, start_date,
        reminder_enabled, prescribed_by, tenant_id)
     VALUES ($1::int, 'iron', '60 mg', 'once_daily', 'oral', CURRENT_DATE,
             $2, $3::uuid, $4::uuid)
     RETURNING *`,
    Number(pregnancyId),
    reminderEnabled,
    ACTOR_UID,
    tenantId,
  );
  return rows[0];
}

async function canonicalRows(patientUid, eventType) {
  const timeline = await prisma.$queryRawUnsafe(
    `SELECT tenant_id, event_type, event_subtype, event_status, source_table, source_id,
            resource_type, resource_id, actor_uid, actor_role, occurred_at,
            visible_to_patient, clinical_summary, payload, tags, idempotency_key
       FROM clinical_timeline_events
      WHERE patient_uid = $1::uuid AND event_type = $2
      ORDER BY created_at`,
    patientUid,
    eventType,
  );
  const audit = await prisma.$queryRawUnsafe(
    `SELECT tenant_id, patient_uid, action, action_status, actor_uid, actor_role,
            resource_type, resource_table, resource_id, after_state, metadata,
            idempotency_key
       FROM clinical_audit_events
      WHERE patient_uid = $1::uuid AND action = $2
      ORDER BY created_at`,
    patientUid,
    eventType,
  );
  return { timeline, audit };
}

async function detailCount(table, pregnancyId) {
  const sqlByTable = {
    maternity_anc_visits: `SELECT COUNT(*)::int AS count FROM maternity_anc_visits
      WHERE tenant_id = $1::uuid AND pregnancy_id = $2::int`,
    maternity_supplements: `SELECT COUNT(*)::int AS count FROM maternity_supplements
      WHERE tenant_id = $1::uuid AND pregnancy_id = $2::int`,
    maternity_fetal_kicks: `SELECT COUNT(*)::int AS count FROM maternity_fetal_kicks
      WHERE tenant_id = $1::uuid AND pregnancy_id = $2::int`,
  };
  const sql = sqlByTable[table];
  if (!sql) throw new Error(`Unsupported detail table: ${table}`);
  const rows = await prisma.$queryRawUnsafe(
    sql,
    TENANT_A,
    Number(pregnancyId),
  );
  return Number(rows[0].count);
}

async function cleanup() {
  for (const entry of [...installedTriggers]) await dropFailureTrigger(entry);
  if (createdUserUids.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events WHERE patient_uid = ANY($1::uuid[])`,
      createdUserUids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events WHERE patient_uid = ANY($1::uuid[])`,
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
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id = $1::uuid`,
    TENANT_B,
  ).catch(() => {});
  createdUserUids.length = 0;
}

d('M-A ANC, supplement, reminder, and fetal-kick atomic writes', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2, 'M-A Atomic Tenant B')`,
      TENANT_B,
      TENANT_B_SLUG,
    );
    await seedUser({ uid: ACTOR_UID, role: 'NURSING_STAFF' });
  }, 30_000);

  afterEach(async () => {
    for (const entry of [...installedTriggers]) await dropFailureTrigger(entry);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('ANC visit commits detail, pregnancy projection, staff-only canonical event, and audit together', async () => {
    const patientUid = await seedUser();
    const pregnancy = await seedPregnancy({ patientUid });
    const visit = await recordAncVisit({
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      visit_date: '2026-05-14',
      gestational_age_weeks: 27,
      weight_kg: 63.4,
      notes: 'staff-only ANC narrative',
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });

    const users = await prisma.$queryRawUnsafe(
      `SELECT is_pregnant FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      TENANT_A,
      patientUid,
    );
    expect(users[0].is_pregnant).toBe(true);
    const { timeline, audit } = await canonicalRows(patientUid, 'maternity.anc_visit_recorded');
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      tenant_id: TENANT_A,
      event_status: 'recorded',
      source_table: 'maternity_anc_visits',
      source_id: String(visit.id),
      resource_type: 'anc_visit',
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
      visible_to_patient: false,
      payload: {
        anc_visit_id: visit.id,
        pregnancy_id: pregnancy.id,
        visit_number: 1,
      },
    });
    expect(JSON.stringify(timeline[0].payload)).not.toContain('staff-only ANC narrative');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      resource_table: 'maternity_anc_visits',
      resource_id: String(visit.id),
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
      after_state: { anc_visit_recorded: true, user_is_pregnant: true },
    });
  });

  test('ANC visit and pregnancy projection roll back when canonical timeline persistence fails', async () => {
    const patientUid = await seedUser();
    const pregnancy = await seedPregnancy({ patientUid });
    const removeTrigger = await installFailureTrigger({
      table: 'clinical_timeline_events',
      operation: 'INSERT',
      condition: `NEW.patient_uid = '${patientUid}'::uuid AND NEW.event_type = 'maternity.anc_visit_recorded'`,
    });

    await expect(recordAncVisit({
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      visit_date: '2026-05-15',
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toBeTruthy();
    await removeTrigger();

    expect(await detailCount('maternity_anc_visits', pregnancy.id)).toBe(0);
    const users = await prisma.$queryRawUnsafe(
      `SELECT is_pregnant FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      TENANT_A,
      patientUid,
    );
    expect(users[0].is_pregnant).toBe(false);
    const events = await canonicalRows(patientUid, 'maternity.anc_visit_recorded');
    expect(events.timeline).toHaveLength(0);
    expect(events.audit).toHaveLength(0);
  });

  test('ANC mutation rejects a pregnancy from another tenant without writing detail or canonical rows', async () => {
    const patientUid = await seedUser({ tenantId: TENANT_B });
    const pregnancy = await seedPregnancy({ patientUid, tenantId: TENANT_B });

    await expect(recordAncVisit({
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      visit_date: '2026-05-16',
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toMatchObject({ statusCode: 404 });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id FROM maternity_anc_visits WHERE pregnancy_id = $1::int`,
      Number(pregnancy.id),
    );
    expect(rows).toHaveLength(0);
    const events = await canonicalRows(patientUid, 'maternity.anc_visit_recorded');
    expect(events.timeline).toHaveLength(0);
    expect(events.audit).toHaveLength(0);
  });

  test('supplement create and retry use one active detail row with one staff-only canonical pair', async () => {
    const patientUid = await seedUser({ isPregnant: true });
    const pregnancy = await seedPregnancy({ patientUid });
    const input = {
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      supplement: 'iron',
      dose: '60 mg',
      frequency: 'once_daily',
      start_date: '2026-05-17',
      notes: 'staff-only supplement narrative',
      prescribed_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    };
    const first = await recordSupplement(input);
    const second = await recordSupplement(input);

    expect(second.id).toBe(first.id);
    expect(second.continued).toBe(true);
    expect(await detailCount('maternity_supplements', pregnancy.id)).toBe(1);
    const { timeline, audit } = await canonicalRows(patientUid, 'maternity.supplement_recorded');
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      event_status: 'recorded',
      source_id: String(first.id),
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
      visible_to_patient: false,
      payload: {
        supplement_id: first.id,
        pregnancy_id: pregnancy.id,
        supplement: 'iron',
        frequency: 'once_daily',
        continued: false,
      },
    });
    expect(JSON.stringify(timeline[0].payload)).not.toContain('staff-only supplement narrative');
    expect(audit).toHaveLength(1);
  });

  test('supplement detail and timeline roll back when clinical audit persistence fails', async () => {
    const patientUid = await seedUser({ isPregnant: true });
    const pregnancy = await seedPregnancy({ patientUid });
    const removeTrigger = await installFailureTrigger({
      table: 'clinical_audit_events',
      operation: 'INSERT',
      condition: `NEW.patient_uid = '${patientUid}'::uuid AND NEW.action = 'maternity.supplement_recorded'`,
    });

    await expect(recordSupplement({
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      supplement: 'calcium',
      dose: '500 mg',
      prescribed_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toBeTruthy();
    await removeTrigger();

    expect(await detailCount('maternity_supplements', pregnancy.id)).toBe(0);
    const events = await canonicalRows(patientUid, 'maternity.supplement_recorded');
    expect(events.timeline).toHaveLength(0);
    expect(events.audit).toHaveLength(0);
  });

  test('prescription propagation commits each new supplement with canonical coverage and is retry-safe', async () => {
    const patientUid = await seedUser({ isPregnant: true });
    const pregnancy = await seedPregnancy({ patientUid });
    const input = {
      tenantId: TENANT_A,
      patient_uid: patientUid,
      medications: [{ name: 'Iron with Folic Acid', dose: '60 mg', frequency: 'OD' }],
      prescribed_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'DOCTOR',
    };
    const first = await maybePropagateAncSupplements(input);
    const second = await maybePropagateAncSupplements(input);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(await detailCount('maternity_supplements', pregnancy.id)).toBe(1);
    const { timeline, audit } = await canonicalRows(patientUid, 'maternity.supplement_recorded');
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      event_subtype: 'prescription_propagated',
      actor_uid: ACTOR_UID,
      actor_role: 'DOCTOR',
      visible_to_patient: false,
      payload: expect.objectContaining({
        pregnancy_id: pregnancy.id,
        supplement: 'iron',
        source_kind: 'prescription',
      }),
    });
    expect(audit).toHaveLength(1);
  });

  test('prescription propagation rolls back detail when canonical persistence fails', async () => {
    const patientUid = await seedUser({ isPregnant: true });
    const pregnancy = await seedPregnancy({ patientUid });
    const removeTrigger = await installFailureTrigger({
      table: 'clinical_timeline_events',
      operation: 'INSERT',
      condition: `NEW.patient_uid = '${patientUid}'::uuid AND NEW.event_type = 'maternity.supplement_recorded'`,
    });

    await expect(maybePropagateAncSupplements({
      tenantId: TENANT_A,
      patient_uid: patientUid,
      medications: [{ name: 'Calcium 500mg', frequency: 'BD' }],
      prescribed_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'DOCTOR',
    })).rejects.toBeTruthy();
    await removeTrigger();

    expect(await detailCount('maternity_supplements', pregnancy.id)).toBe(0);
    const events = await canonicalRows(patientUid, 'maternity.supplement_recorded');
    expect(events.timeline).toHaveLength(0);
    expect(events.audit).toHaveLength(0);
  });

  test('patient reminder preference writes one staff-only canonical pair and exact actor provenance', async () => {
    const patientUid = await seedUser({ isPregnant: true });
    const pregnancy = await seedPregnancy({ patientUid });
    const supplement = await seedSupplement({ pregnancyId: pregnancy.id });
    const input = {
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      supplement_id: supplement.id,
      reminder_enabled: false,
      actor_uid: patientUid,
      actor_role: 'PATIENT',
    };
    const first = await setSupplementReminder(input);
    const second = await setSupplementReminder(input);

    expect(first.reminder_enabled).toBe(false);
    expect(second.id).toBe(first.id);
    const { timeline, audit } = await canonicalRows(
      patientUid,
      'maternity.supplement_reminder_updated',
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      event_status: 'disabled',
      actor_uid: patientUid,
      actor_role: 'PATIENT',
      visible_to_patient: false,
      payload: {
        supplement_id: supplement.id,
        pregnancy_id: pregnancy.id,
        reminder_enabled: false,
      },
    });
    expect(audit).toHaveLength(1);
  });

  test('reminder preference update rolls back when canonical audit persistence fails', async () => {
    const patientUid = await seedUser({ isPregnant: true });
    const pregnancy = await seedPregnancy({ patientUid });
    const supplement = await seedSupplement({ pregnancyId: pregnancy.id });
    const removeTrigger = await installFailureTrigger({
      table: 'clinical_audit_events',
      operation: 'INSERT',
      condition: `NEW.patient_uid = '${patientUid}'::uuid AND NEW.action = 'maternity.supplement_reminder_updated'`,
    });

    await expect(setSupplementReminder({
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      supplement_id: supplement.id,
      reminder_enabled: false,
      actor_uid: patientUid,
      actor_role: 'PATIENT',
    })).rejects.toBeTruthy();
    await removeTrigger();

    const rows = await prisma.$queryRawUnsafe(
      `SELECT reminder_enabled FROM maternity_supplements WHERE id = $1::int`,
      Number(supplement.id),
    );
    expect(rows[0].reminder_enabled).toBe(true);
    const events = await canonicalRows(patientUid, 'maternity.supplement_reminder_updated');
    expect(events.timeline).toHaveLength(0);
    expect(events.audit).toHaveLength(0);
  });

  test('patient fetal-kick input is unverified, patient-generated, staff-only, and retry-safe', async () => {
    const patientUid = await seedUser({ isPregnant: true });
    const pregnancy = await seedPregnancy({ patientUid });
    const input = {
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      log_date: '2026-05-18',
      kick_count: 8,
      observation_window_minutes: 720,
      notes: 'patient narrative must stay out of canonical payload',
      recorded_by: patientUid,
      actor_uid: patientUid,
      actor_role: 'PATIENT',
    };
    const first = await recordFetalKick(input);
    const second = await recordFetalKick(input);

    expect(second.id).toBe(first.id);
    expect(await detailCount('maternity_fetal_kicks', pregnancy.id)).toBe(1);
    const { timeline, audit } = await canonicalRows(patientUid, 'maternity.fetal_kick_recorded');
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      event_status: 'unverified',
      actor_uid: patientUid,
      actor_role: 'PATIENT',
      visible_to_patient: false,
      clinical_summary: 'Patient-generated fetal kick count recorded — unverified',
      payload: {
        fetal_kick_id: first.id,
        pregnancy_id: pregnancy.id,
        kick_count: 8,
        observation_window_minutes: 720,
        source_kind: 'patient_generated',
        verification_status: 'unverified',
      },
    });
    expect(timeline[0].tags).toEqual(expect.arrayContaining(['patient_generated', 'unverified']));
    expect(JSON.stringify(timeline[0].payload)).not.toContain('patient narrative');
    expect(audit).toHaveLength(1);
    expect(audit[0].after_state).toEqual({
      kick_count: 8,
      low_count_flag: true,
      verification_status: 'unverified',
    });
  });

  test('fetal-kick detail rolls back when canonical timeline persistence fails', async () => {
    const patientUid = await seedUser({ isPregnant: true });
    const pregnancy = await seedPregnancy({ patientUid });
    const removeTrigger = await installFailureTrigger({
      table: 'clinical_timeline_events',
      operation: 'INSERT',
      condition: `NEW.patient_uid = '${patientUid}'::uuid AND NEW.event_type = 'maternity.fetal_kick_recorded'`,
    });

    await expect(recordFetalKick({
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      log_date: '2026-05-19',
      kick_count: 12,
      recorded_by: patientUid,
      actor_uid: patientUid,
      actor_role: 'PATIENT',
    })).rejects.toBeTruthy();
    await removeTrigger();

    expect(await detailCount('maternity_fetal_kicks', pregnancy.id)).toBe(0);
    const events = await canonicalRows(patientUid, 'maternity.fetal_kick_recorded');
    expect(events.timeline).toHaveLength(0);
    expect(events.audit).toHaveLength(0);
  });
});
