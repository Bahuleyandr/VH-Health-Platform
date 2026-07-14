import { createHash, randomUUID } from 'crypto';

import { jest } from '@jest/globals';

import prisma from '../lib/prisma.js';
import { addAddendum, signNote } from '../services/emr/clinicalNotesService.js';
import {
  getImmunisationStatus,
  markScheduleUpToDate,
  recordDose as recordNewbornDose,
  seedScheduleForNewborn
} from '../services/maternity/immunisationService.js';
import {
  listDueForPatient,
  listForPatient,
  recordDose as recordPatientDose,
  seedScheduleForPatient
} from '../services/paediatric/paediatricImmunisationService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const ACTOR_UID = randomUUID();
const SPOOFED_UID = randomUUID();
const createdPatientUids = [];
const installedTriggers = [];
let phoneSequence = 0;
let vaccineId;

function nextPhone() {
  phoneSequence += 1;
  return `+9186${String(Date.now()).slice(-7)}${phoneSequence}`;
}

async function installFailureTrigger({ table, operation = 'INSERT', condition }) {
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `md_atomic_fail_${suffix}`;
  const triggerName = `md_atomic_trigger_${suffix}`;
  const entry = { table, functionName, triggerName };
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION ${functionName}()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $$
       BEGIN
         IF ${condition} THEN
           RAISE EXCEPTION 'M-D injected failure ${suffix}';
         END IF;
         RETURN NEW;
       END;
       $$`
  );
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER ${triggerName}
       AFTER ${operation} ON ${table}
       FOR EACH ROW EXECUTE FUNCTION ${functionName}()`
  );
  installedTriggers.push(entry);
  return async () => {
    await prisma
      .$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON ${table}`)
      .catch(() => {});
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${functionName}()`).catch(() => {});
    const index = installedTriggers.indexOf(entry);
    if (index >= 0) installedTriggers.splice(index, 1);
  };
}

async function seedUser({ tenantId = TENANT_A, role = 'PATIENT', birthday = '2024-01-01' } = {}) {
  const uid = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO users
       (uid, phone, name, role, birthday, is_active, tenant_id, updated_at)
     VALUES ($1::uuid, $2, $3, $4, $5::date, true, $6::uuid, NOW())`,
    uid,
    nextPhone(),
    `M-D ${role} ${uid.slice(0, 8)}`,
    role,
    birthday,
    tenantId
  );
  createdPatientUids.push(uid);
  return uid;
}

async function seedNewborn({ tenantId = TENANT_A, linkedPatientUid = null } = {}) {
  const motherUid = await seedUser({ tenantId });
  const pregnancyRows = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_pregnancies
       (patient_uid, pregnancy_number, lmp_date, edd_date, status, created_by, tenant_id)
     VALUES ($1::uuid, 1, '2025-09-01', '2026-06-08', 'delivered', $2::uuid, $3::uuid)
     RETURNING id`,
    motherUid,
    ACTOR_UID,
    tenantId
  );
  const deliveryRows = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_deliveries
       (pregnancy_id, delivery_datetime, delivery_mode, delivered_by, tenant_id)
     VALUES ($1::int, '2026-06-08T04:00:00Z', 'nvd', $2::uuid, $3::uuid)
     RETURNING id`,
    Number(pregnancyRows[0].id),
    ACTOR_UID,
    tenantId
  );
  const newbornRows = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_newborns
       (delivery_id, birth_datetime, outcome, newborn_patient_uid, recorded_by, tenant_id)
     VALUES ($1::int, '2026-06-08T04:00:00Z', 'live', $2::uuid, $3::uuid, $4::uuid)
     RETURNING id`,
    Number(deliveryRows[0].id),
    linkedPatientUid,
    ACTOR_UID,
    tenantId
  );
  return {
    motherUid,
    patientUid: linkedPatientUid || motherUid,
    pregnancyId: Number(pregnancyRows[0].id),
    deliveryId: Number(deliveryRows[0].id),
    newbornId: Number(newbornRows[0].id)
  };
}

async function canonicalRows(patientUid, eventType, sourceTable = null) {
  const params = [patientUid, eventType, sourceTable];
  const timeline = await prisma.$queryRawUnsafe(
    `SELECT event_type, event_status, source_table, source_id, actor_uid,
            actor_role, visible_to_patient, payload, idempotency_key
       FROM clinical_timeline_events
      WHERE patient_uid = $1::uuid AND event_type = $2
        AND ($3::text IS NULL OR source_table = $3)
      ORDER BY created_at`,
    ...params
  );
  const audit = await prisma.$queryRawUnsafe(
    `SELECT action, resource_table, resource_id, actor_uid, actor_role, after_state,
            idempotency_key
       FROM clinical_audit_events
      WHERE patient_uid = $1::uuid AND action = $2
        AND ($3::text IS NULL OR resource_table = $3)
      ORDER BY created_at`,
    ...params
  );
  return { timeline, audit };
}

// Split `<state-fingerprint-base>:tx:<xid8>` revision keys. Genuine dose
// mutations must carry a transaction-unique xid8 suffix while A->B->A
// revisions 1 and 3 share the persisted-state hash base.
function splitRevisionKey(key) {
  const marker = String(key).lastIndexOf(':tx:');
  if (marker === -1) return { base: String(key), tx: null };
  return { base: String(key).slice(0, marker), tx: String(key).slice(marker + 4) };
}

function expectRevisionKeySequence(timeline, audit) {
  const timelineKeys = timeline.map(({ idempotency_key }) => splitRevisionKey(idempotency_key));
  const auditKeys = audit.map(({ idempotency_key }) => splitRevisionKey(idempotency_key));
  expect(timelineKeys.every(({ tx }) => tx && /^\d+$/.test(tx))).toBe(true);
  expect(auditKeys.every(({ tx }) => tx && /^\d+$/.test(tx))).toBe(true);
  expect(timelineKeys[0].base).toBe(timelineKeys[2].base);
  expect(timelineKeys[1].base).not.toBe(timelineKeys[0].base);
  expect(timelineKeys[0].tx).not.toBe(timelineKeys[2].tx);
  expect(auditKeys[0].base).toBe(auditKeys[2].base);
  expect(auditKeys[0].tx).not.toBe(auditKeys[2].tx);
  expect(auditKeys.map(({ tx }) => tx)).toEqual(timelineKeys.map(({ tx }) => tx));
}

// Replicates the (module-private) canonicalDoseFingerprint the immunisation
// services hash persisted dose state with. Deliberately duplicated rather than
// exported: pre-fix bare idempotency keys already stored in prod derive from
// exactly this shape, so if the service's fingerprint semantics ever drift,
// this must fail (drift would orphan legacy keys and re-open HISTORY_FINAL
// 409s on semantically identical retries).
function persistedDoseFingerprint(dose) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        status: dose.status == null ? null : String(dose.status),
        given_at: dose.given_at ? new Date(dose.given_at).toISOString() : null,
        given_by: dose.given_by == null ? null : String(dose.given_by),
        given_by_name: dose.given_by_name == null ? null : String(dose.given_by_name),
        batch_number: dose.batch_number == null ? null : String(dose.batch_number),
        manufacturer: dose.manufacturer == null ? null : String(dose.manufacturer),
        site_of_injection: dose.site_of_injection == null ? null : String(dose.site_of_injection),
        adverse_event: dose.adverse_event == null ? null : String(dose.adverse_event),
        notes: dose.notes == null ? null : String(dose.notes)
      })
    )
    .digest('hex');
}

async function persistedNewbornDose(newbornImmunisationId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, status, given_at, given_by, given_by_name, batch_number,
            manufacturer, site_of_injection, adverse_event, notes
       FROM newborn_immunisations
      WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(newbornImmunisationId),
    TENANT_A
  );
  return rows[0];
}

async function tupleVersion(table, id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT xmin::text AS xmin, updated_at, to_jsonb(t) AS row_state
       FROM ${table} t
      WHERE id = $1::int`,
    Number(id)
  );
  return {
    xmin: rows[0].xmin,
    updated_at: new Date(rows[0].updated_at).toISOString(),
    row_state: JSON.stringify(rows[0].row_state)
  };
}

async function patientDose(patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, status, newborn_immunisation_id
       FROM patient_immunisations
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
      ORDER BY id
      LIMIT 1`,
    TENANT_A,
    patientUid
  );
  return rows[0] || null;
}

async function cleanup() {
  for (const entry of [...installedTriggers]) {
    await prisma
      .$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${entry.triggerName} ON ${entry.table}`)
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${entry.functionName}()`)
      .catch(() => {});
  }
  installedTriggers.length = 0;

  if (createdPatientUids.length) {
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM clinical_audit_events WHERE patient_uid = ANY($1::uuid[])`,
        createdPatientUids
      )
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM clinical_timeline_events WHERE patient_uid = ANY($1::uuid[])`,
        createdPatientUids
      )
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM clinical_notes WHERE patient_uid = ANY($1::uuid[])`,
        createdPatientUids
      )
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM patient_immunisations WHERE patient_uid = ANY($1::uuid[])`,
        createdPatientUids
      )
      .catch(() => {});
  }
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM newborn_immunisations WHERE tenant_id IN ($1::uuid, $2::uuid)`,
      TENANT_A,
      TENANT_B
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM vaccine_catalogue WHERE tenant_id IN ($1::uuid, $2::uuid)`,
      TENANT_A,
      TENANT_B
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM maternity_newborns WHERE tenant_id IN ($1::uuid, $2::uuid)`,
      TENANT_A,
      TENANT_B
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM maternity_deliveries WHERE tenant_id IN ($1::uuid, $2::uuid)`,
      TENANT_A,
      TENANT_B
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM maternity_pregnancies WHERE tenant_id IN ($1::uuid, $2::uuid)`,
      TENANT_A,
      TENANT_B
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM users WHERE tenant_id IN ($1::uuid, $2::uuid) OR uid = $3::uuid`,
      TENANT_A,
      TENANT_B,
      ACTOR_UID
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(`DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`, TENANT_A, TENANT_B)
    .catch(() => {});
}

d('M-D immunisation canonical atomicity', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2, 'M-D Atomic Tenant A'),
              ($3::uuid, $4, 'M-D Atomic Tenant B')`,
      TENANT_A,
      `md-a-${TENANT_A.slice(0, 8)}`,
      TENANT_B,
      `md-b-${TENANT_B.slice(0, 8)}`
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'M-D Atomic Nurse', 'NURSING_STAFF', true, $3::uuid, NOW())`,
      ACTOR_UID,
      nextPhone(),
      TENANT_A
    );
    const catalogueRows = await prisma.$queryRawUnsafe(
      `INSERT INTO vaccine_catalogue
         (code, display_name, dose_number, recommended_age_days, window_days, active, tenant_id)
       VALUES ('MD-TEST', 'M-D atomic test vaccine', 1, 42, 28, true, $1::uuid)
       RETURNING id`,
      TENANT_A
    );
    vaccineId = Number(catalogueRows[0].id);
  }, 30_000);

  afterEach(async () => {
    for (const entry of [...installedTriggers]) {
      await prisma
        .$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${entry.triggerName} ON ${entry.table}`)
        .catch(() => {});
      await prisma
        .$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${entry.functionName}()`)
        .catch(() => {});
      installedTriggers.splice(installedTriggers.indexOf(entry), 1);
    }
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  }, 30_000);

  test('newborn seeding commits staff-only canonical/audit rows and retries idempotently', async () => {
    const childUid = await seedUser();
    const newborn = await seedNewborn({ linkedPatientUid: childUid });

    const first = await seedScheduleForNewborn({
      tenantId: TENANT_A,
      newborn_id: newborn.newbornId,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF'
    });
    const retry = await seedScheduleForNewborn({
      tenantId: TENANT_A,
      newborn_id: newborn.newbornId,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF'
    });

    expect(first.scheduled).toBe(1);
    expect(retry.scheduled).toBe(0);
    const { timeline, audit } = await canonicalRows(
      childUid,
      'immunisation.schedule_seeded',
      'newborn_immunisations'
    );
    expect(timeline).toHaveLength(1);
    expect(audit).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      event_status: 'scheduled',
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
      visible_to_patient: false,
      payload: expect.objectContaining({
        newborn_id: newborn.newbornId,
        vaccine_catalogue_id: vaccineId,
        status: 'scheduled'
      })
    });
  });

  test('newborn seeding rolls every detail row back when canonical recording fails', async () => {
    const childUid = await seedUser();
    const newborn = await seedNewborn({ linkedPatientUid: childUid });
    const removeTrigger = await installFailureTrigger({
      table: 'clinical_timeline_events',
      condition: `NEW.patient_uid = '${childUid}'::uuid AND NEW.event_type = 'immunisation.schedule_seeded'`
    });
    try {
      await expect(
        seedScheduleForNewborn({
          tenantId: TENANT_A,
          newborn_id: newborn.newbornId,
          actor_uid: ACTOR_UID,
          actor_role: 'NURSING_STAFF'
        })
      ).rejects.toThrow();
    } finally {
      await removeTrigger();
    }
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id FROM newborn_immunisations WHERE newborn_id = $1::int`,
      newborn.newbornId
    );
    expect(rows).toHaveLength(0);
  });

  test('newborn dose retries dedupe exact state and cover changed cold-chain facts', async () => {
    const childUid = await seedUser();
    const newborn = await seedNewborn({ linkedPatientUid: childUid });
    await seedScheduleForNewborn({ tenantId: TENANT_A, newborn_id: newborn.newbornId });
    const doses = await prisma.$queryRawUnsafe(
      `SELECT id FROM newborn_immunisations WHERE newborn_id = $1::int`,
      newborn.newbornId
    );
    const input = {
      tenantId: TENANT_A,
      immunisation_id: doses[0].id,
      status: 'given',
      given_by: ACTOR_UID,
      given_by_name: 'M-D Atomic Nurse',
      batch_number: 'NB-BATCH-1',
      manufacturer: 'NB Manufacturer',
      site_of_injection: 'left_thigh',
      notes: 'staff-only detail',
      actor_role: 'NURSING_STAFF'
    };
    await recordNewbornDose(input);
    const tupleBefore = await tupleVersion('newborn_immunisations', doses[0].id);
    await recordNewbornDose(input);
    const tupleAfterRetry = await tupleVersion('newborn_immunisations', doses[0].id);
    expect(tupleAfterRetry.xmin).toBe(tupleBefore.xmin);
    expect(tupleAfterRetry.updated_at).toBe(tupleBefore.updated_at);
    expect(tupleAfterRetry.row_state).toBe(tupleBefore.row_state);
    const exactRetryRows = await canonicalRows(
      childUid,
      'immunisation.dose_recorded',
      'newborn_immunisations'
    );
    expect(exactRetryRows.timeline).toHaveLength(1);
    expect(exactRetryRows.audit).toHaveLength(1);

    const revised = {
      ...input,
      batch_number: 'NB-BATCH-2',
      manufacturer: 'NB Manufacturer Revised',
      site_of_injection: 'right_thigh'
    };
    await recordNewbornDose(revised);
    await recordNewbornDose(revised);
    await recordNewbornDose(input);
    await recordNewbornDose(input);
    const { timeline, audit } = await canonicalRows(
      childUid,
      'immunisation.dose_recorded',
      'newborn_immunisations'
    );
    expect(timeline).toHaveLength(3);
    expect(audit).toHaveLength(3);
    expect(timeline.map((row) => row.payload.batch_number)).toEqual([
      'NB-BATCH-1',
      'NB-BATCH-2',
      'NB-BATCH-1'
    ]);
    expect(new Set(timeline.map(({ idempotency_key }) => idempotency_key))).toHaveProperty(
      'size',
      3
    );
    expect(new Set(audit.map(({ idempotency_key }) => idempotency_key))).toHaveProperty('size', 3);
    expectRevisionKeySequence(timeline, audit);
    const storedDose = await prisma.$queryRawUnsafe(
      `SELECT status, batch_number, manufacturer, site_of_injection
         FROM newborn_immunisations
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(doses[0].id),
      TENANT_A
    );
    expect(storedDose[0]).toMatchObject({
      status: 'given',
      batch_number: 'NB-BATCH-1',
      manufacturer: 'NB Manufacturer',
      site_of_injection: 'left_thigh'
    });
    expect(timeline[1]).toMatchObject({
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
      visible_to_patient: false,
      payload: expect.objectContaining({
        batch_number: 'NB-BATCH-2',
        manufacturer: 'NB Manufacturer Revised',
        site_of_injection: 'right_thigh'
      })
    });
    expect(audit.every((row) => row.actor_uid === ACTOR_UID)).toBe(true);
    expect(JSON.stringify([
      ...timeline.map((row) => row.payload),
      ...audit.map((row) => row.after_state)
    ])).not.toContain(
      'staff-only detail'
    );
  });

  test('newborn dose update rolls back when its canonical timeline insert fails', async () => {
    const childUid = await seedUser();
    const newborn = await seedNewborn({ linkedPatientUid: childUid });
    await seedScheduleForNewborn({ tenantId: TENANT_A, newborn_id: newborn.newbornId });
    const doses = await prisma.$queryRawUnsafe(
      `SELECT id FROM newborn_immunisations WHERE newborn_id = $1::int`,
      newborn.newbornId
    );
    const removeTrigger = await installFailureTrigger({
      table: 'clinical_timeline_events',
      condition: `NEW.patient_uid = '${childUid}'::uuid AND NEW.event_type = 'immunisation.dose_recorded'`
    });
    try {
      await expect(
        recordNewbornDose({
          tenantId: TENANT_A,
          immunisation_id: doses[0].id,
          status: 'given',
          given_by: ACTOR_UID,
          given_by_name: 'M-D Atomic Nurse',
          actor_role: 'NURSING_STAFF'
        })
      ).rejects.toThrow();
    } finally {
      await removeTrigger();
    }
    const current = await prisma.$queryRawUnsafe(
      `SELECT status, given_at FROM newborn_immunisations WHERE id = $1::int`,
      Number(doses[0].id)
    );
    expect(current[0]).toMatchObject({ status: 'scheduled', given_at: null });
  });

  test('up-to-date review commits with signed_by audit attribution and no narrative payload', async () => {
    const patientUid = await seedUser();
    await markScheduleUpToDate({
      tenantId: TENANT_A,
      patient_uid: patientUid,
      as_of: '2026-07-14',
      age_group: 'current',
      signed_by: ACTOR_UID,
      signed_by_name: 'M-D Atomic Nurse',
      notes: 'private review narrative',
      actor_role: 'NURSING_STAFF'
    });
    const { timeline, audit } = await canonicalRows(
      patientUid,
      'immunisation.schedule_marked_up_to_date',
      'clinical_notes'
    );
    expect(timeline).toHaveLength(1);
    expect(audit).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
      visible_to_patient: false,
      payload: {
        note_id: expect.any(Number),
        status: 'up_to_date',
        as_of: '2026-07-14',
        age_group: 'current'
      }
    });
    expect(audit[0].actor_uid).toBe(ACTOR_UID);
    expect(JSON.stringify([timeline[0].payload, audit[0].after_state])).not.toContain(
      'private review'
    );
  });

  test('up-to-date note and timeline roll back when the strict audit insert fails', async () => {
    const patientUid = await seedUser();
    const removeTrigger = await installFailureTrigger({
      table: 'clinical_audit_events',
      condition: `NEW.patient_uid = '${patientUid}'::uuid AND NEW.action = 'immunisation.schedule_marked_up_to_date'`
    });
    try {
      await expect(
        markScheduleUpToDate({
          tenantId: TENANT_A,
          patient_uid: patientUid,
          signed_by: ACTOR_UID,
          actor_role: 'NURSING_STAFF'
        })
      ).rejects.toThrow();
    } finally {
      await removeTrigger();
    }
    const notes = await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_notes
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
          AND note_type = 'immunisation_review'`,
      TENANT_A,
      patientUid
    );
    const events = await canonicalRows(patientUid, 'immunisation.schedule_marked_up_to_date');
    expect(notes).toHaveLength(0);
    expect(events.timeline).toHaveLength(0);
    expect(events.audit).toHaveLength(0);
  });

  test('getImmunisationStatus ignores addendum rows attached to a review note', async () => {
    // addAddendum copies note_type from the parent and validates neither
    // note_type nor content shape, so a free-form addendum CAN attach to an
    // immunisation_review note. The status projection must keep reading the
    // review itself (is_addendum = false), not the newest chain row.
    const patientUid = await seedUser();
    const review = await markScheduleUpToDate({
      tenantId: TENANT_A,
      patient_uid: patientUid,
      as_of: '2026-07-01',
      age_group: 'current',
      signed_by: ACTOR_UID,
      signed_by_name: 'M-D Atomic Nurse',
      actor_role: 'NURSING_STAFF'
    });

    const addendum = await addAddendum(
      review.id,
      { text: 'Parent supplied the physical immunisation card; copy filed.' },
      ACTOR_UID,
      'DOCTOR',
      TENANT_A
    );
    expect(addendum).toMatchObject({
      is_addendum: true,
      note_type: 'immunisation_review'
    });

    const status = await getImmunisationStatus({ tenantId: TENANT_A, patient_uid: patientUid });
    expect(status).toMatchObject({
      status: 'up_to_date',
      as_of: '2026-07-01',
      age_group: 'current',
      note_id: review.id,
      reviewed: true
    });
  });

  test('signed up_to_date addendum content cannot move the paediatric due-list review cutoff', async () => {
    const patientUid = await seedUser({ birthday: '2024-04-01' });
    await seedScheduleForPatient({
      patientUid,
      dob: '2024-04-01',
      tenantId: TENANT_A,
      actorUid: ACTOR_UID,
      actorRole: 'NURSING_STAFF'
    });
    const doseRows = await prisma.$queryRawUnsafe(
      `SELECT id, due_date::text AS due_date
         FROM patient_immunisations
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
        ORDER BY due_date ASC
        LIMIT 1`,
      TENANT_A,
      patientUid
    );
    expect(doseRows).toHaveLength(1);
    const dueIso = doseRows[0].due_date;
    const dayMs = 24 * 60 * 60 * 1000;
    const shiftDay = (iso, days) =>
      new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * dayMs).toISOString().slice(0, 10);
    const reviewAsOf = shiftDay(dueIso, -1); // before the dose is due: hides nothing
    const addendumAsOf = shiftDay(dueIso, 1); // would swallow the dose if it counted
    const checkpoint = shiftDay(dueIso, 30);

    const review = await markScheduleUpToDate({
      tenantId: TENANT_A,
      patient_uid: patientUid,
      as_of: reviewAsOf,
      signed_by: ACTOR_UID,
      actor_role: 'NURSING_STAFF'
    });
    const baseline = await listDueForPatient(patientUid, { tenantId: TENANT_A, asOf: checkpoint });
    expect(baseline.map((row) => row.id)).toContain(doseRows[0].id);

    // A later SIGNED addendum whose free-form content mimics a review must
    // not become the effective review cutoff and hide genuinely due doses.
    const addendum = await addAddendum(
      review.id,
      { status: 'up_to_date', as_of: addendumAsOf, text: 'narrative only' },
      ACTOR_UID,
      'DOCTOR',
      TENANT_A
    );
    await signNote(addendum.id, ACTOR_UID, { uid: ACTOR_UID, role: 'DOCTOR' }, TENANT_A);

    const after = await listDueForPatient(patientUid, { tenantId: TENANT_A, asOf: checkpoint });
    expect(after.map((row) => row.id)).toContain(doseRows[0].id);
  });

  test('patient schedule seed preserves the exact O1 link and is canonical plus retry-safe', async () => {
    const childUid = await seedUser({ birthday: '2026-06-08' });
    const newborn = await seedNewborn({ linkedPatientUid: childUid });
    await seedScheduleForNewborn({ tenantId: TENANT_A, newborn_id: newborn.newbornId });

    const first = await seedScheduleForPatient({
      patientUid: childUid,
      dob: '2026-06-08',
      tenantId: TENANT_A,
      actorUid: ACTOR_UID,
      actorRole: 'NURSING_STAFF'
    });
    const retry = await seedScheduleForPatient({
      patientUid: childUid,
      dob: '2026-06-08',
      tenantId: TENANT_A,
      actorUid: ACTOR_UID,
      actorRole: 'NURSING_STAFF'
    });
    const dose = await patientDose(childUid);
    expect(first).toMatchObject({ inserted: 1, linked: 1, total: 1 });
    expect(retry).toMatchObject({ inserted: 0, updated: 1, linked: 0, total: 1 });
    expect(dose.newborn_immunisation_id).not.toBeNull();
    const { timeline, audit } = await canonicalRows(
      childUid,
      'immunisation.schedule_seeded',
      'patient_immunisations'
    );
    expect(timeline).toHaveLength(1);
    expect(audit).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
      visible_to_patient: false,
      payload: expect.objectContaining({ linked_to_newborn: true })
    });
  });

  test('patient schedule insert rolls back when canonical recording fails', async () => {
    const patientUid = await seedUser({ birthday: '2024-02-01' });
    const removeTrigger = await installFailureTrigger({
      table: 'clinical_timeline_events',
      condition: `NEW.patient_uid = '${patientUid}'::uuid AND NEW.event_type = 'immunisation.schedule_seeded'`
    });
    try {
      await expect(
        seedScheduleForPatient({
          patientUid,
          dob: '2024-02-01',
          tenantId: TENANT_A,
          actorUid: ACTOR_UID,
          actorRole: 'NURSING_STAFF'
        })
      ).rejects.toThrow();
    } finally {
      await removeTrigger();
    }
    expect(await patientDose(patientUid)).toBeNull();
  });

  test('patient schedule GET functions never seed missing rows', async () => {
    const patientUid = await seedUser({ birthday: '2023-01-01' });
    expect(await listForPatient(patientUid, { tenantId: TENANT_A })).toEqual([]);
    expect(await listDueForPatient(patientUid, { tenantId: TENANT_A, asOf: '2026-07-14' })).toEqual(
      []
    );
    expect(await patientDose(patientUid)).toBeNull();
    const events = await canonicalRows(patientUid, 'immunisation.schedule_seeded');
    expect(events.timeline).toHaveLength(0);
    expect(events.audit).toHaveLength(0);
  });

  test('patient dose recording commits canonical cold-chain facts with the authenticated actor', async () => {
    const patientUid = await seedUser({ birthday: '2024-03-01' });
    await seedScheduleForPatient({ patientUid, dob: '2024-03-01', tenantId: TENANT_A });
    const dose = await patientDose(patientUid);
    const beforeGivenAt = Date.now();
    const recordedDose = await recordPatientDose({
      tenantId: TENANT_A,
      immunisationId: dose.id,
      status: 'given',
      givenBy: ACTOR_UID,
      givenByName: 'M-D Atomic Nurse',
      batchNumber: 'PT-BATCH-1',
      manufacturer: 'Patient Manufacturer',
      siteOfInjection: 'right_thigh',
      notes: 'patient dose private narrative',
      actorRole: 'NURSING_STAFF'
    });
    const afterGivenAt = Date.now();
    expect(recordedDose.given_at.getTime()).toBeGreaterThanOrEqual(beforeGivenAt);
    expect(recordedDose.given_at.getTime()).toBeLessThanOrEqual(afterGivenAt);
    const { timeline, audit } = await canonicalRows(
      patientUid,
      'immunisation.dose_recorded',
      'patient_immunisations'
    );
    expect(timeline).toHaveLength(1);
    expect(audit).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
      visible_to_patient: false,
      payload: expect.objectContaining({
        batch_number: 'PT-BATCH-1',
        manufacturer: 'Patient Manufacturer',
        site_of_injection: 'right_thigh'
      })
    });
    expect(audit[0].actor_uid).toBe(ACTOR_UID);
    expect(JSON.stringify([timeline[0].payload, audit[0].after_state])).not.toContain(
      'private narrative'
    );
  });

  test('unlinked patient dose retries dedupe exact state and cover changed cold-chain facts', async () => {
    const patientUid = await seedUser({ birthday: '2024-03-15' });
    await seedScheduleForPatient({ patientUid, dob: '2024-03-15', tenantId: TENANT_A });
    const dose = await patientDose(patientUid);
    // Pass a Date, not an ISO string: Prisma's raw-param inference re-serializes
    // datetime-shaped strings through the engine host timezone (double-shifts on
    // non-UTC Windows hosts); Date params bind exactly.
    const firstGivenAt = new Date('2026-07-14T04:30:00Z');

    await recordPatientDose({
      tenantId: TENANT_A,
      immunisationId: dose.id,
      status: 'given',
      givenAt: firstGivenAt,
      givenBy: ACTOR_UID,
      givenByName: 'M-D Atomic Nurse',
      batchNumber: 'PT-RETRY-1',
      actorRole: 'NURSING_STAFF'
    });
    // A different request-side givenAt is still an effective-state retry for a
    // 'given' dose: the persisted given_at is COALESCE-retained, so nothing in
    // the tuple would change. The write must be a pure no-op.
    const tupleBefore = await tupleVersion('patient_immunisations', dose.id);
    await recordPatientDose({
      tenantId: TENANT_A,
      immunisationId: dose.id,
      status: 'given',
      givenAt: new Date('2026-07-14T05:30:00Z'),
      givenBy: ACTOR_UID,
      givenByName: 'M-D Atomic Nurse',
      batchNumber: 'PT-RETRY-1',
      actorRole: 'NURSING_STAFF'
    });
    const tupleAfterRetry = await tupleVersion('patient_immunisations', dose.id);
    expect(tupleAfterRetry.xmin).toBe(tupleBefore.xmin);
    expect(tupleAfterRetry.updated_at).toBe(tupleBefore.updated_at);
    expect(tupleAfterRetry.row_state).toBe(tupleBefore.row_state);

    let canonical = await canonicalRows(
      patientUid,
      'immunisation.dose_recorded',
      'patient_immunisations'
    );
    expect(canonical.timeline).toHaveLength(1);
    expect(canonical.audit).toHaveLength(1);

    await recordPatientDose({
      tenantId: TENANT_A,
      immunisationId: dose.id,
      status: 'given',
      givenAt: new Date('2026-07-14T08:30:00Z'),
      givenBy: ACTOR_UID,
      givenByName: 'M-D Atomic Nurse',
      batchNumber: 'PT-RETRY-2',
      actorRole: 'NURSING_STAFF'
    });
    await recordPatientDose({
      tenantId: TENANT_A,
      immunisationId: dose.id,
      status: 'given',
      givenBy: ACTOR_UID,
      givenByName: 'M-D Atomic Nurse',
      batchNumber: 'PT-RETRY-2',
      actorRole: 'NURSING_STAFF'
    });
    await recordPatientDose({
      tenantId: TENANT_A,
      immunisationId: dose.id,
      status: 'given',
      givenBy: ACTOR_UID,
      givenByName: 'M-D Atomic Nurse',
      batchNumber: 'PT-RETRY-1',
      actorRole: 'NURSING_STAFF'
    });
    await recordPatientDose({
      tenantId: TENANT_A,
      immunisationId: dose.id,
      status: 'given',
      givenBy: ACTOR_UID,
      givenByName: 'M-D Atomic Nurse',
      batchNumber: 'PT-RETRY-1',
      actorRole: 'NURSING_STAFF'
    });

    const stored = await prisma.$queryRawUnsafe(
      `SELECT given_at, batch_number
         FROM patient_immunisations
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      dose.id,
      TENANT_A
    );
    expect(stored[0]).toMatchObject({
      batch_number: 'PT-RETRY-1'
    });
    expect(stored[0].given_at.toISOString()).toBe('2026-07-14T04:30:00.000Z');
    canonical = await canonicalRows(
      patientUid,
      'immunisation.dose_recorded',
      'patient_immunisations'
    );
    expect(canonical.timeline).toHaveLength(3);
    expect(canonical.audit).toHaveLength(3);
    expect(canonical.timeline.map((row) => row.payload.batch_number)).toEqual([
      'PT-RETRY-1',
      'PT-RETRY-2',
      'PT-RETRY-1'
    ]);
    expect(
      new Set(canonical.timeline.map(({ idempotency_key }) => idempotency_key))
    ).toHaveProperty('size', 3);
    expect(
      new Set(canonical.audit.map(({ idempotency_key }) => idempotency_key))
    ).toHaveProperty('size', 3);
    expectRevisionKeySequence(canonical.timeline, canonical.audit);
  });

  test('concurrent newborn dose mutations collapse identical writes and keep distinct writes unique', async () => {
    const childUid = await seedUser();
    const newborn = await seedNewborn({ linkedPatientUid: childUid });
    await seedScheduleForNewborn({ tenantId: TENANT_A, newborn_id: newborn.newbornId });
    const doses = await prisma.$queryRawUnsafe(
      `SELECT id FROM newborn_immunisations WHERE newborn_id = $1::int`,
      newborn.newbornId
    );
    const input = {
      tenantId: TENANT_A,
      immunisation_id: doses[0].id,
      status: 'given',
      given_by: ACTOR_UID,
      given_by_name: 'M-D Atomic Nurse',
      batch_number: 'NB-CONC-BASE',
      actor_role: 'NURSING_STAFF'
    };
    await recordNewbornDose(input);

    await Promise.all([
      recordNewbornDose({ ...input, batch_number: 'NB-CONC-SAME' }),
      recordNewbornDose({ ...input, batch_number: 'NB-CONC-SAME' })
    ]);
    let { timeline, audit } = await canonicalRows(
      childUid,
      'immunisation.dose_recorded',
      'newborn_immunisations'
    );
    expect(timeline).toHaveLength(2);
    expect(audit).toHaveLength(2);

    await Promise.all([
      recordNewbornDose({ ...input, batch_number: 'NB-CONC-X' }),
      recordNewbornDose({ ...input, batch_number: 'NB-CONC-Y' })
    ]);
    ({ timeline, audit } = await canonicalRows(
      childUid,
      'immunisation.dose_recorded',
      'newborn_immunisations'
    ));
    expect(timeline).toHaveLength(4);
    expect(audit).toHaveLength(4);
    expect(new Set(timeline.map(({ idempotency_key }) => idempotency_key))).toHaveProperty(
      'size',
      4
    );
    expect(new Set(audit.map(({ idempotency_key }) => idempotency_key))).toHaveProperty('size', 4);
    const stored = await prisma.$queryRawUnsafe(
      `SELECT batch_number FROM newborn_immunisations WHERE id = $1::int`,
      Number(doses[0].id)
    );
    expect(['NB-CONC-X', 'NB-CONC-Y']).toContain(stored[0].batch_number);
  });

  test('concurrent unlinked patient dose mutations collapse identical writes and keep distinct writes unique', async () => {
    const patientUid = await seedUser({ birthday: '2024-03-20' });
    await seedScheduleForPatient({ patientUid, dob: '2024-03-20', tenantId: TENANT_A });
    const dose = await patientDose(patientUid);
    const input = {
      tenantId: TENANT_A,
      immunisationId: dose.id,
      status: 'given',
      givenAt: new Date('2026-07-14T03:15:00Z'),
      givenBy: ACTOR_UID,
      givenByName: 'M-D Atomic Nurse',
      batchNumber: 'PT-CONC-BASE',
      actorRole: 'NURSING_STAFF'
    };
    await recordPatientDose(input);

    await Promise.all([
      recordPatientDose({ ...input, batchNumber: 'PT-CONC-SAME' }),
      recordPatientDose({ ...input, batchNumber: 'PT-CONC-SAME' })
    ]);
    let canonical = await canonicalRows(
      patientUid,
      'immunisation.dose_recorded',
      'patient_immunisations'
    );
    expect(canonical.timeline).toHaveLength(2);
    expect(canonical.audit).toHaveLength(2);

    await Promise.all([
      recordPatientDose({ ...input, batchNumber: 'PT-CONC-X' }),
      recordPatientDose({ ...input, batchNumber: 'PT-CONC-Y' })
    ]);
    canonical = await canonicalRows(
      patientUid,
      'immunisation.dose_recorded',
      'patient_immunisations'
    );
    expect(canonical.timeline).toHaveLength(4);
    expect(canonical.audit).toHaveLength(4);
    expect(
      new Set(canonical.timeline.map(({ idempotency_key }) => idempotency_key))
    ).toHaveProperty('size', 4);
    expect(
      new Set(canonical.audit.map(({ idempotency_key }) => idempotency_key))
    ).toHaveProperty('size', 4);
    const stored = await prisma.$queryRawUnsafe(
      `SELECT batch_number FROM patient_immunisations WHERE id = $1::int`,
      Number(dose.id)
    );
    expect(['PT-CONC-X', 'PT-CONC-Y']).toContain(stored[0].batch_number);
  });

  test('a frozen JS clock still yields distinct genuine dose revisions', async () => {
    const childUid = await seedUser();
    const newborn = await seedNewborn({ linkedPatientUid: childUid });
    await seedScheduleForNewborn({ tenantId: TENANT_A, newborn_id: newborn.newbornId });
    const newbornDoses = await prisma.$queryRawUnsafe(
      `SELECT id FROM newborn_immunisations WHERE newborn_id = $1::int`,
      newborn.newbornId
    );
    const patientUid = await seedUser({ birthday: '2024-04-15' });
    await seedScheduleForPatient({ patientUid, dob: '2024-04-15', tenantId: TENANT_A });
    const unlinkedDose = await patientDose(patientUid);

    jest.useFakeTimers({
      now: new Date('2026-07-14T10:00:00.000Z'),
      doNotFake: [
        'hrtime', 'nextTick', 'performance', 'queueMicrotask',
        'requestAnimationFrame', 'cancelAnimationFrame',
        'requestIdleCallback', 'cancelIdleCallback',
        'setImmediate', 'clearImmediate',
        'setInterval', 'clearInterval',
        'setTimeout', 'clearTimeout'
      ]
    });
    try {
      expect(Date.now()).toBe(new Date('2026-07-14T10:00:00.000Z').getTime());

      const newbornInput = {
        tenantId: TENANT_A,
        immunisation_id: newbornDoses[0].id,
        status: 'given',
        given_by: ACTOR_UID,
        given_by_name: 'M-D Atomic Nurse',
        batch_number: 'NB-FROZEN-1',
        actor_role: 'NURSING_STAFF'
      };
      await recordNewbornDose(newbornInput);
      await recordNewbornDose({ ...newbornInput, batch_number: 'NB-FROZEN-2' });
      await recordNewbornDose(newbornInput);

      const patientInput = {
        tenantId: TENANT_A,
        immunisationId: unlinkedDose.id,
        status: 'given',
        givenBy: ACTOR_UID,
        givenByName: 'M-D Atomic Nurse',
        batchNumber: 'PT-FROZEN-1',
        actorRole: 'NURSING_STAFF'
      };
      await recordPatientDose(patientInput);
      await recordPatientDose({ ...patientInput, batchNumber: 'PT-FROZEN-2' });
      await recordPatientDose(patientInput);
    } finally {
      jest.useRealTimers();
    }

    const newbornCanonical = await canonicalRows(
      childUid,
      'immunisation.dose_recorded',
      'newborn_immunisations'
    );
    expect(newbornCanonical.timeline).toHaveLength(3);
    expect(newbornCanonical.audit).toHaveLength(3);
    expect(
      new Set(newbornCanonical.timeline.map(({ idempotency_key }) => idempotency_key))
    ).toHaveProperty('size', 3);
    expect(
      new Set(newbornCanonical.audit.map(({ idempotency_key }) => idempotency_key))
    ).toHaveProperty('size', 3);

    const patientCanonical = await canonicalRows(
      patientUid,
      'immunisation.dose_recorded',
      'patient_immunisations'
    );
    expect(patientCanonical.timeline).toHaveLength(3);
    expect(patientCanonical.audit).toHaveLength(3);
    expect(
      new Set(patientCanonical.timeline.map(({ idempotency_key }) => idempotency_key))
    ).toHaveProperty('size', 3);
    expect(
      new Set(patientCanonical.audit.map(({ idempotency_key }) => idempotency_key))
    ).toHaveProperty('size', 3);
  });

  test('patient dose update rolls back after a canonical failure', async () => {
    const patientUid = await seedUser({ birthday: '2024-04-01' });
    await seedScheduleForPatient({ patientUid, dob: '2024-04-01', tenantId: TENANT_A });
    const dose = await patientDose(patientUid);
    const removeTrigger = await installFailureTrigger({
      table: 'clinical_timeline_events',
      condition: `NEW.patient_uid = '${patientUid}'::uuid AND NEW.event_type = 'immunisation.dose_recorded'`
    });
    try {
      await expect(
        recordPatientDose({
          tenantId: TENANT_A,
          immunisationId: dose.id,
          status: 'given',
          givenBy: ACTOR_UID,
          actorRole: 'NURSING_STAFF'
        })
      ).rejects.toThrow();
    } finally {
      await removeTrigger();
    }
    expect(await patientDose(patientUid)).toMatchObject({ status: 'scheduled' });
  });

  test('exact-linked patient dose retries preserve authoritative facts and one canonical pair', async () => {
    const childUid = await seedUser({ birthday: '2026-06-08' });
    const newborn = await seedNewborn({ linkedPatientUid: childUid });
    await seedScheduleForNewborn({ tenantId: TENANT_A, newborn_id: newborn.newbornId });
    await seedScheduleForPatient({
      patientUid: childUid,
      dob: '2026-06-08',
      tenantId: TENANT_A
    });
    const dose = await patientDose(childUid);
    expect(dose.newborn_immunisation_id).not.toBeNull();

    const input = {
      tenantId: TENANT_A,
      immunisationId: dose.id,
      status: 'given',
      givenAt: new Date('2026-07-14T06:30:00Z'),
      givenBy: ACTOR_UID,
      givenByName: 'M-D Atomic Nurse',
      batchNumber: 'LINKED-RETRY-1',
      manufacturer: 'Linked Manufacturer',
      siteOfInjection: 'left_thigh',
      actorRole: 'NURSING_STAFF'
    };
    await recordPatientDose(input);
    const retry = await recordPatientDose(input);

    expect(retry).toMatchObject({
      id: dose.id,
      patient_uid: childUid,
      status: 'given',
      given_by: ACTOR_UID
    });
    expect(retry.given_at.toISOString()).toBe('2026-07-14T06:30:00.000Z');
    await expect(
      recordPatientDose({ ...input, batchNumber: 'must-not-rewrite' })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PAEDIATRIC_IMMUNISATION_HISTORY_FINAL'
    });
    const newbornDose = await prisma.$queryRawUnsafe(
      `SELECT status, given_at, batch_number
         FROM newborn_immunisations
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(dose.newborn_immunisation_id),
      TENANT_A
    );
    expect(newbornDose[0]).toMatchObject({ status: 'given', batch_number: 'LINKED-RETRY-1' });
    expect(newbornDose[0].given_at.toISOString()).toBe('2026-07-14T06:30:00.000Z');
    const { timeline, audit } = await canonicalRows(
      childUid,
      'immunisation.dose_recorded',
      'newborn_immunisations'
    );
    expect(timeline).toHaveLength(1);
    expect(audit).toHaveLength(1);
  });

  test('legacy bare-key linked history tolerates exact retries and still appends :tx: revisions', async () => {
    const childUid = await seedUser({ birthday: '2026-06-08' });
    const newborn = await seedNewborn({ linkedPatientUid: childUid });
    await seedScheduleForNewborn({ tenantId: TENANT_A, newborn_id: newborn.newbornId });
    await seedScheduleForPatient({
      patientUid: childUid,
      dob: '2026-06-08',
      tenantId: TENANT_A
    });
    const dose = await patientDose(childUid);
    expect(dose.newborn_immunisation_id).not.toBeNull();
    const newbornImmunisationId = Number(dose.newborn_immunisation_id);

    // Simulate history recorded BEFORE the canonical revision-sequence fix:
    // finalize the newborn dose and seed its canonical pair manually via SQL,
    // with PRE-FIX BARE idempotency keys (state-fingerprint base, no `:tx:`
    // suffix). The current write path must not participate in constructing
    // this history. Date param (not ISO string) — raw datetime strings
    // re-serialize through the engine host timezone on non-UTC hosts.
    const legacyGivenAt = new Date('2026-07-14T06:30:00Z');
    await prisma.$executeRawUnsafe(
      `UPDATE newborn_immunisations
          SET status = 'given',
              given_at = $2::timestamptz,
              given_by = $3::uuid,
              given_by_name = $4,
              batch_number = $5,
              manufacturer = $6,
              site_of_injection = $7,
              updated_at = NOW()
        WHERE id = $1::int AND tenant_id = $8::uuid`,
      newbornImmunisationId,
      legacyGivenAt,
      ACTOR_UID,
      'M-D Atomic Nurse',
      'LEGACY-BATCH-1',
      'Legacy Manufacturer',
      'left_thigh',
      TENANT_A
    );
    const legacyPersisted = await persistedNewbornDose(newbornImmunisationId);
    const legacyBase = persistedDoseFingerprint(legacyPersisted);
    const legacyTimelineKey = `newborn_immunisations:${newbornImmunisationId}:recorded:${legacyBase}`;
    const legacyAuditKey = `newborn_immunisations:${newbornImmunisationId}:audit:recorded:${legacyBase}`;
    const legacyFacts = {
      status: 'given',
      given_at: legacyGivenAt.toISOString(),
      batch_number: 'LEGACY-BATCH-1',
      manufacturer: 'Legacy Manufacturer',
      site_of_injection: 'left_thigh'
    };
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_timeline_events
         (tenant_id, patient_uid, event_type, event_status, source_table,
          source_id, resource_type, resource_id, actor_uid, actor_role,
          occurred_at, visible_to_patient, clinical_summary, payload,
          idempotency_key)
       VALUES ($1::uuid, $2::uuid, 'immunisation.dose_recorded', 'given',
               'newborn_immunisations', $3, 'immunisation_dose', $3,
               $4::uuid, 'NURSING_STAFF', $5::timestamptz, false,
               'Immunisation dose recorded', $6::jsonb, $7)`,
      TENANT_A,
      childUid,
      String(newbornImmunisationId),
      ACTOR_UID,
      legacyGivenAt,
      JSON.stringify({
        immunisation_id: newbornImmunisationId,
        newborn_id: newborn.newbornId,
        vaccine_catalogue_id: vaccineId,
        vaccine_code: 'MD-TEST',
        dose_number: 1,
        status: 'given',
        batch_number: 'LEGACY-BATCH-1',
        manufacturer: 'Legacy Manufacturer',
        site_of_injection: 'left_thigh'
      }),
      legacyTimelineKey
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_audit_events
         (tenant_id, patient_uid, action, action_status, actor_uid, actor_role,
          resource_type, resource_table, resource_id, after_state,
          idempotency_key, occurred_at)
       VALUES ($1::uuid, $2::uuid, 'immunisation.dose_recorded', 'success',
               $3::uuid, 'NURSING_STAFF', 'immunisation_dose',
               'newborn_immunisations', $4, $5::jsonb, $6, $7::timestamptz)`,
      TENANT_A,
      childUid,
      ACTOR_UID,
      String(newbornImmunisationId),
      JSON.stringify(legacyFacts),
      legacyAuditKey,
      legacyGivenAt
    );

    // A semantically identical patient-side retry must be tolerated by the
    // exact-legacy-key arm of the retry detection: success, no duplicate
    // canonical emission, detail tuple untouched.
    const retryInput = {
      tenantId: TENANT_A,
      immunisationId: dose.id,
      status: 'given',
      givenAt: legacyGivenAt,
      givenBy: ACTOR_UID,
      givenByName: 'M-D Atomic Nurse',
      batchNumber: 'LEGACY-BATCH-1',
      manufacturer: 'Legacy Manufacturer',
      siteOfInjection: 'left_thigh',
      actorRole: 'NURSING_STAFF'
    };
    const tupleBefore = await tupleVersion('newborn_immunisations', newbornImmunisationId);
    const retry = await recordPatientDose(retryInput);
    expect(retry).toMatchObject({
      id: dose.id,
      patient_uid: childUid,
      status: 'given',
      given_by: ACTOR_UID
    });
    expect(retry.given_at.toISOString()).toBe('2026-07-14T06:30:00.000Z');
    expect(await tupleVersion('newborn_immunisations', newbornImmunisationId)).toEqual(tupleBefore);
    let canonical = await canonicalRows(
      childUid,
      'immunisation.dose_recorded',
      'newborn_immunisations'
    );
    expect(canonical.timeline).toHaveLength(1);
    expect(canonical.audit).toHaveLength(1);
    expect(canonical.timeline[0].idempotency_key).toBe(legacyTimelineKey);
    expect(canonical.audit[0].idempotency_key).toBe(legacyAuditKey);

    // Legacy tolerance must not weaken the rewrite guard: a genuinely
    // different patient-side request still fails closed against final
    // linked history, changing nothing.
    await expect(
      recordPatientDose({ ...retryInput, batchNumber: 'LEGACY-MUST-NOT-REWRITE' })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PAEDIATRIC_IMMUNISATION_HISTORY_FINAL'
    });
    expect(await tupleVersion('newborn_immunisations', newbornImmunisationId)).toEqual(tupleBefore);
    canonical = await canonicalRows(
      childUid,
      'immunisation.dose_recorded',
      'newborn_immunisations'
    );
    expect(canonical.timeline).toHaveLength(1);
    expect(canonical.audit).toHaveLength(1);

    // A genuinely different newborn-side mutation appends a NEW
    // `:tx:`-suffixed revision pair on top of the untouched legacy pair —
    // chronology is preserved across the key-format boundary.
    await recordNewbornDose({
      tenantId: TENANT_A,
      immunisation_id: newbornImmunisationId,
      status: 'given',
      given_by: ACTOR_UID,
      given_by_name: 'M-D Atomic Nurse',
      adverse_event: 'Mild fever, resolved',
      actor_role: 'NURSING_STAFF'
    });
    const mutatedPersisted = await persistedNewbornDose(newbornImmunisationId);
    const mutatedBase = persistedDoseFingerprint(mutatedPersisted);
    expect(mutatedBase).not.toBe(legacyBase);
    canonical = await canonicalRows(
      childUid,
      'immunisation.dose_recorded',
      'newborn_immunisations'
    );
    expect(canonical.timeline).toHaveLength(2);
    expect(canonical.audit).toHaveLength(2);
    expect(canonical.timeline[0].idempotency_key).toBe(legacyTimelineKey);
    expect(canonical.audit[0].idempotency_key).toBe(legacyAuditKey);
    const revisedTimeline = splitRevisionKey(canonical.timeline[1].idempotency_key);
    const revisedAudit = splitRevisionKey(canonical.audit[1].idempotency_key);
    expect(revisedTimeline.base).toBe(
      `newborn_immunisations:${newbornImmunisationId}:recorded:${mutatedBase}`
    );
    expect(revisedAudit.base).toBe(
      `newborn_immunisations:${newbornImmunisationId}:audit:recorded:${mutatedBase}`
    );
    expect(revisedTimeline.tx).toMatch(/^\d+$/);
    expect(revisedAudit.tx).toBe(revisedTimeline.tx);

    // Retrying the now-current facts is matched by the `:tx:`-prefix arm on
    // top of the legacy row: both key formats coexist without re-emission.
    const mutatedTuple = await tupleVersion('newborn_immunisations', newbornImmunisationId);
    const retryAfterRevision = await recordPatientDose(retryInput);
    expect(retryAfterRevision).toMatchObject({
      id: dose.id,
      patient_uid: childUid,
      status: 'given'
    });
    expect(await tupleVersion('newborn_immunisations', newbornImmunisationId)).toEqual(mutatedTuple);
    canonical = await canonicalRows(
      childUid,
      'immunisation.dose_recorded',
      'newborn_immunisations'
    );
    expect(canonical.timeline).toHaveLength(2);
    expect(canonical.audit).toHaveLength(2);
  });

  test('exact-linked patient dose leaves newborn history untouched after a canonical failure', async () => {
    const childUid = await seedUser({ birthday: '2026-06-08' });
    const newborn = await seedNewborn({ linkedPatientUid: childUid });
    await seedScheduleForNewborn({ tenantId: TENANT_A, newborn_id: newborn.newbornId });
    await seedScheduleForPatient({
      patientUid: childUid,
      dob: '2026-06-08',
      tenantId: TENANT_A
    });
    const dose = await patientDose(childUid);
    expect(dose.newborn_immunisation_id).not.toBeNull();

    const removeTrigger = await installFailureTrigger({
      table: 'clinical_timeline_events',
      condition: `NEW.patient_uid = '${childUid}'::uuid AND NEW.event_type = 'immunisation.dose_recorded'`
    });
    try {
      await expect(
        recordPatientDose({
          tenantId: TENANT_A,
          immunisationId: dose.id,
          status: 'given',
          givenBy: ACTOR_UID,
          actorRole: 'NURSING_STAFF'
        })
      ).rejects.toThrow();
    } finally {
      await removeTrigger();
    }

    const newbornDose = await prisma.$queryRawUnsafe(
      `SELECT status, given_at
         FROM newborn_immunisations
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(dose.newborn_immunisation_id),
      TENANT_A
    );
    expect(newbornDose[0]).toMatchObject({ status: 'scheduled', given_at: null });
    expect(await patientDose(childUid)).toMatchObject({ status: 'scheduled' });
  });

  test('tenant conflicts fail closed across newborn, review and patient schedule mutations', async () => {
    const patientUid = await seedUser({ birthday: '2024-05-01' });
    const newborn = await seedNewborn({ linkedPatientUid: patientUid });
    await seedScheduleForNewborn({ tenantId: TENANT_A, newborn_id: newborn.newbornId });
    await seedScheduleForPatient({ patientUid, dob: '2024-05-01', tenantId: TENANT_A });
    const dose = await patientDose(patientUid);

    await expect(
      seedScheduleForNewborn({
        tenantId: TENANT_B,
        newborn_id: newborn.newbornId
      })
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      recordNewbornDose({
        tenantId: TENANT_B,
        immunisation_id: dose.newborn_immunisation_id,
        status: 'given',
        given_by: ACTOR_UID,
        given_by_name: 'M-D Atomic Nurse'
      })
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      markScheduleUpToDate({
        tenantId: TENANT_B,
        patient_uid: patientUid,
        signed_by: ACTOR_UID
      })
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      seedScheduleForPatient({
        tenantId: TENANT_B,
        patientUid,
        dob: '2024-05-01'
      })
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      recordPatientDose({
        tenantId: TENANT_B,
        immunisationId: dose.id,
        status: 'given',
        givenBy: ACTOR_UID
      })
    ).rejects.toMatchObject({ statusCode: 404 });

    const tenantBEvents = await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT_B,
      patientUid
    );
    expect(tenantBEvents).toHaveLength(0);
  });
});
