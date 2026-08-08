import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import {
  ensureAdmissionPatientEncounterTx,
} from '../services/emr/admissionService.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

function txClient(client) {
  return {
    async $queryRawUnsafe(statement, ...params) {
      return (await client.query(statement, params)).rows;
    },
  };
}

async function setTenant(client) {
  await client.query(
    `SELECT set_config('app.current_tenant_id', $1::text, false)`,
    [TENANT_ID],
  );
}

async function insertUser(client, role) {
  const uid = randomUUID();
  await client.query(
    `INSERT INTO users
       (uid, tenant_id, name, role, is_active, status, is_deleted, updated_at)
     VALUES
       ($1::uuid, $2::uuid, $3::text, $4::text,
        TRUE, 'active', FALSE, NOW())`,
    [uid, TENANT_ID, `Admission encounter ${role} ${uid}`, role],
  );
  return uid;
}

async function insertAdmission(client, {
  patientUid,
  actorUid,
  migrationSourceKey,
}) {
  // Migration 640 allows only one active admission per patient — close any
  // prior fixture admission before seeding the next one.
  await client.query(
    `UPDATE admissions
        SET status = 'discharged', discharged_at = NOW()
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND status IN ('admitted', 'transferred')`,
    [TENANT_ID, patientUid],
  );
  const rows = await client.query(
    `INSERT INTO admissions
       (tenant_id, patient_uid, status, allergies, admission_type,
        admitting_doctor, created_by, admitted_at, migration_source_key)
     VALUES
       ($1::uuid, $2::uuid, 'admitted', ARRAY[]::text[], 'elective',
        $3::uuid, $3::uuid, NOW(), $4::text)
     RETURNING id, tenant_id, patient_uid, encounter_id, admission_type,
               status, admitted_at, admitting_doctor, attending_doctor`,
    [TENANT_ID, patientUid, actorUid, migrationSourceKey],
  );
  return rows.rows[0];
}

async function inTransaction(work) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await setTenant(client);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

describeIfDb('canonical inpatient patient_encounter transaction contract', () => {
  let control;
  let patientUid;
  let actorUid;

  beforeAll(async () => {
    control = new Client({ connectionString: databaseUrl });
    await control.connect();
    await setTenant(control);
    patientUid = await insertUser(control, 'PATIENT');
    actorUid = await insertUser(control, 'DOCTOR');
  });

  afterAll(async () => {
    if (!control) return;
    await setTenant(control).catch(() => {});
    await control.query(
      `DELETE FROM patient_encounters
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid`,
      [TENANT_ID, patientUid],
    ).catch(() => {});
    await control.query(
      `DELETE FROM admissions
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid`,
      [TENANT_ID, patientUid],
    ).catch(() => {});
    await control.query(
      `DELETE FROM users
        WHERE tenant_id = $1::uuid
          AND uid = ANY($2::uuid[])`,
      [TENANT_ID, [patientUid, actorUid]],
    ).catch(() => {});
    await control.end();
  });

  it('serializes concurrent materialization into one exact encounter and one replay', async () => {
    const admission = await insertAdmission(control, {
      patientUid,
      actorUid,
      migrationSourceKey: `encounter-concurrency-${randomUUID()}`,
    });

    const run = () => inTransaction((client) => ensureAdmissionPatientEncounterTx({
      tx: txClient(client),
      tenantId: TENANT_ID,
      admission: { ...admission },
      actorUid,
    }));
    const results = await Promise.all([run(), run()]);

    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    const rows = await control.query(
      `SELECT *
         FROM patient_encounters
        WHERE tenant_id = $1::uuid
          AND admission_id = $2::integer`,
      [TENANT_ID, Number(admission.id)],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      id: admission.encounter_id,
      patient_uid: patientUid,
      encounter_type: 'ip',
      status: 'active',
      admission_id: Number(admission.id),
      admission_encounter_id: admission.encounter_id,
      primary_doctor_uid: actorUid,
      created_by: actorUid,
      updated_by: actorUid,
    });
    expect(rows.rows[0].care_team_uids).toEqual(expect.arrayContaining([actorUid]));
  });

  it('rolls the admission and encounter back together when later transaction work fails', async () => {
    const migrationSourceKey = `encounter-rollback-${randomUUID()}`;
    await expect(inTransaction(async (client) => {
      const admission = await insertAdmission(client, {
        patientUid,
        actorUid,
        migrationSourceKey,
      });
      await ensureAdmissionPatientEncounterTx({
        tx: txClient(client),
        tenantId: TENANT_ID,
        admission,
        actorUid,
      });
      throw new Error('forced downstream canonical failure');
    })).rejects.toThrow('forced downstream canonical failure');

    const admissionRows = await control.query(
      `SELECT id
         FROM admissions
        WHERE tenant_id = $1::uuid
          AND migration_source_key = $2::text`,
      [TENANT_ID, migrationSourceKey],
    );
    const encounterRows = await control.query(
      `SELECT id
         FROM patient_encounters
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND metadata->>'admission_type' = 'elective'
          AND admission_id NOT IN (
            SELECT id
              FROM admissions
             WHERE tenant_id = $1::uuid
          )`,
      [TENANT_ID, patientUid],
    );
    expect(admissionRows.rows).toHaveLength(0);
    expect(encounterRows.rows).toHaveLength(0);
  });

  it('preserves an exact existing encounter and atomically rebinds the admission', async () => {
    const admission = await insertAdmission(control, {
      patientUid,
      actorUid,
      migrationSourceKey: `encounter-rebind-${randomUUID()}`,
    });
    const existingId = randomUUID();
    const marker = `existing-${randomUUID()}`;
    await control.query(
      `INSERT INTO patient_encounters
         (id, tenant_id, patient_uid, encounter_type, status, admission_id,
          admission_encounter_id, primary_doctor_uid, created_by, updated_by,
          metadata)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, 'ip', 'active', $4::integer,
          $5::uuid, $6::uuid, $6::uuid, $6::uuid,
          jsonb_build_object('marker', $7::text))`,
      [
        existingId,
        TENANT_ID,
        patientUid,
        Number(admission.id),
        admission.encounter_id,
        actorUid,
        marker,
      ],
    );

    const result = await inTransaction((client) => ensureAdmissionPatientEncounterTx({
      tx: txClient(client),
      tenantId: TENANT_ID,
      admission,
      actorUid,
    }));

    expect(result).toMatchObject({
      replayed: true,
      encounter: {
        id: existingId,
        metadata: { marker },
      },
    });
    const admissionRows = await control.query(
      `SELECT encounter_id
         FROM admissions
        WHERE tenant_id = $1::uuid
          AND id = $2::integer`,
      [TENANT_ID, Number(admission.id)],
    );
    const encounterRows = await control.query(
      `SELECT id, metadata
         FROM patient_encounters
        WHERE tenant_id = $1::uuid
          AND admission_id = $2::integer`,
      [TENANT_ID, Number(admission.id)],
    );
    expect(admissionRows.rows[0].encounter_id).toBe(existingId);
    expect(encounterRows.rows).toEqual([{
      id: existingId,
      metadata: { marker },
    }]);
  });
});
