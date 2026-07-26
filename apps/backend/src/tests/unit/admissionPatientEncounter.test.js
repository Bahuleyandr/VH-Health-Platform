import { jest } from '@jest/globals';

import {
  ensureAdmissionPatientEncounterTx,
} from '../../services/emr/admissionService.js';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PATIENT_UID = '20000000-0000-4000-8000-000000000001';
const ACTOR_UID = '30000000-0000-4000-8000-000000000001';
const DOCTOR_UID = '40000000-0000-4000-8000-000000000001';
const REQUESTED_ENCOUNTER_ID = '50000000-0000-4000-8000-000000000001';
const EXISTING_ENCOUNTER_ID = '50000000-0000-4000-8000-000000000002';

function admission(overrides = {}) {
  return {
    id: 17,
    tenant_id: TENANT_ID,
    patient_uid: PATIENT_UID,
    encounter_id: REQUESTED_ENCOUNTER_ID,
    admission_type: 'elective',
    status: 'admitted',
    admitted_at: new Date('2026-07-24T01:00:00.000Z'),
    admitting_doctor: DOCTOR_UID,
    attending_doctor: null,
    ...overrides,
  };
}

function encounter(overrides = {}) {
  return {
    id: REQUESTED_ENCOUNTER_ID,
    tenant_id: TENANT_ID,
    patient_uid: PATIENT_UID,
    encounter_type: 'ip',
    status: 'active',
    admission_id: 17,
    admission_encounter_id: REQUESTED_ENCOUNTER_ID,
    primary_doctor_uid: DOCTOR_UID,
    care_team_uids: [DOCTOR_UID, ACTOR_UID],
    created_by: ACTOR_UID,
    updated_by: ACTOR_UID,
    metadata: { source: 'admission_service', admission_id: 17 },
    ...overrides,
  };
}

describe('canonical inpatient encounter materialization', () => {
  it('locks the exact admission and creates one canonical IP encounter', async () => {
    const lockedAdmission = admission();
    const inserted = encounter();
    const query = jest.fn(async (sql, ...params) => {
      if (sql.includes('FROM admissions')) return [lockedAdmission];
      if (sql.includes('FROM patient_encounters')) return [];
      if (sql.includes('INSERT INTO patient_encounters')) {
        expect(params).toEqual([
          REQUESTED_ENCOUNTER_ID,
          TENANT_ID,
          PATIENT_UID,
          'ip',
          17,
          DOCTOR_UID,
          DOCTOR_UID,
          null,
          ACTOR_UID,
          lockedAdmission.admitted_at,
          JSON.stringify({
            source: 'admission_service',
            admission_id: 17,
            admission_type: 'elective',
          }),
        ]);
        return [inserted];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const result = await ensureAdmissionPatientEncounterTx({
      tx: { $queryRawUnsafe: query },
      tenantId: TENANT_ID,
      admission: admission(),
      actorUid: ACTOR_UID,
    });

    expect(result).toEqual({ encounter: inserted, replayed: false });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(query.mock.calls[1][0]).toContain('FOR UPDATE');
    expect(query.mock.calls[2][0]).toContain(`'inpatient admission created'`);
  });

  it('replays an exact existing encounter without mutating it', async () => {
    const existing = encounter();
    const query = jest.fn(async (sql) => {
      if (sql.includes('FROM admissions')) return [admission()];
      if (sql.includes('FROM patient_encounters')) return [existing];
      throw new Error(`Existing encounter replay attempted a mutation: ${sql}`);
    });

    const inputAdmission = admission();
    const result = await ensureAdmissionPatientEncounterTx({
      tx: { $queryRawUnsafe: query },
      tenantId: TENANT_ID,
      admission: inputAdmission,
      actorUid: ACTOR_UID,
    });

    expect(result).toEqual({ encounter: existing, replayed: true });
    expect(inputAdmission.encounter_id).toBe(REQUESTED_ENCOUNTER_ID);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('preserves a valid pre-existing canonical row and rebinds the admission before downstream work', async () => {
    const existing = encounter({
      id: EXISTING_ENCOUNTER_ID,
      admission_encounter_id: REQUESTED_ENCOUNTER_ID,
      metadata: { source: 'preexisting-canonical-encounter' },
    });
    const query = jest.fn(async (sql, ...params) => {
      if (sql.includes('FROM admissions')) return [admission()];
      if (sql.includes('FROM patient_encounters')) return [existing];
      if (sql.includes('UPDATE admissions')) {
        expect(params).toEqual([
          TENANT_ID,
          17,
          PATIENT_UID,
          EXISTING_ENCOUNTER_ID,
          REQUESTED_ENCOUNTER_ID,
        ]);
        return [{ encounter_id: EXISTING_ENCOUNTER_ID }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const inputAdmission = admission();
    const result = await ensureAdmissionPatientEncounterTx({
      tx: { $queryRawUnsafe: query },
      tenantId: TENANT_ID,
      admission: inputAdmission,
      actorUid: ACTOR_UID,
    });

    expect(result).toEqual({ encounter: existing, replayed: true });
    expect(inputAdmission.encounter_id).toBe(EXISTING_ENCOUNTER_ID);
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO'))).toBe(false);
  });

  it.each([
    ['another patient', { patient_uid: ACTOR_UID }],
    ['another encounter type', { encounter_type: 'op' }],
    ['a terminal status', { status: 'locked' }],
    ['another detail encounter', {
      admission_encounter_id: '50000000-0000-4000-8000-000000000099',
    }],
  ])('rejects an existing binding for %s without mutating either row', async (
    _label,
    overrides,
  ) => {
    const query = jest.fn(async (sql) => {
      if (sql.includes('FROM admissions')) return [admission()];
      if (sql.includes('FROM patient_encounters')) return [encounter(overrides)];
      throw new Error(`Invalid binding attempted a mutation: ${sql}`);
    });

    await expect(ensureAdmissionPatientEncounterTx({
      tx: { $queryRawUnsafe: query },
      tenantId: TENANT_ID,
      admission: admission(),
      actorUid: ACTOR_UID,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'INPATIENT_ENCOUNTER_BINDING_INVALID',
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('does not swallow a canonical encounter insert failure', async () => {
    const insertError = Object.assign(new Error('forced encounter insert failure'), {
      code: '23514',
    });
    const query = jest.fn(async (sql) => {
      if (sql.includes('FROM admissions')) return [admission()];
      if (sql.includes('FROM patient_encounters')) return [];
      if (sql.includes('INSERT INTO patient_encounters')) throw insertError;
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(ensureAdmissionPatientEncounterTx({
      tx: { $queryRawUnsafe: query },
      tenantId: TENANT_ID,
      admission: admission(),
      actorUid: ACTOR_UID,
    })).rejects.toBe(insertError);
  });
});
