// Regression test for finding 2026-05-23-emergency-walk-in-nurse-d94bba9f.
//
// `POST /api/v1/emr/io` (write) accepted the admission encounter UUID and
// stored it on `intake_output.encounter_uid` (the column migration 208/223
// added for exactly this case). `GET /api/v1/emr/io/:uid/balance` (read)
// hard-rejected the same UUID with "encounterId must be an integer". An
// ICU nurse who charted hourly I/O against the admission encounter UUID at
// the bedside therefore could not retrieve a balance for the same encounter
// — the API contract was inconsistent (writes accepted, reads rejected).
//
// Fix: read side (`getIOBalance` + `getIOChart`) now uses the same
// `normalizeEncounter` helper as the write side, routing UUID to
// `encounter_uid` and integer to `encounter_id`. So a write+read on the
// same encounter handle round-trips cleanly.

import prisma from '../lib/prisma.js';
import { recordIntakeOutput, getIOBalance, getIOChart } from '../services/emr/vitalsChartService.js';

const PATIENT_UID = 'c9999999-9999-4999-8999-bbbbbbbb5d90';
const RECORDER_UID = 'c9999999-9999-4999-8999-bbbbbbbb5d91';
const ENCOUNTER_UUID_A = 'c9999999-9999-4999-8999-cccccccc5e91';
const ENCOUNTER_UUID_B = 'c9999999-9999-4999-8999-cccccccc5e92';
const ENCOUNTER_INT = 999999;
const TODAY = new Date().toISOString().slice(0, 10);

async function seedIntakeOutput({ encounterArg, io_type, amount_ml, category }) {
  return recordIntakeOutput({
    patient_uid: PATIENT_UID,
    encounter_id: encounterArg,   // routes to encounter_id (int) OR encounter_uid (uuid) inside the service
    io_type,
    category,
    amount_ml,
    description: `Test ${io_type}`,
    recorded_by: RECORDER_UID,
  });
}

describe('I/O balance + chart — encounter UUID round-trips (d94bba9f)', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM intake_output WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, RECORDER_UID).catch(() => {});

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000330090', 'I/O Test Patient', 'PATIENT', true, NOW())`,
      PATIENT_UID);
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000330091', 'I/O Test Nurse', 'NURSING_STAFF', true, NOW())`,
      RECORDER_UID);

    // Encounter A (UUID): 200ml intake + 50ml output.
    await seedIntakeOutput({ encounterArg: ENCOUNTER_UUID_A, io_type: 'intake', category: 'iv',    amount_ml: 200 });
    await seedIntakeOutput({ encounterArg: ENCOUNTER_UUID_A, io_type: 'output', category: 'urine', amount_ml: 50 });

    // Encounter B (different UUID): 300ml intake (must not bleed into A's balance).
    await seedIntakeOutput({ encounterArg: ENCOUNTER_UUID_B, io_type: 'intake', category: 'oral', amount_ml: 300 });

    // Legacy int encounter: 80ml intake (separate column).
    await seedIntakeOutput({ encounterArg: ENCOUNTER_INT, io_type: 'intake', category: 'iv', amount_ml: 80 });
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM intake_output WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, RECORDER_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('getIOBalance accepts the admission encounter UUID written at bedside (the repro)', async () => {
    const bal = await getIOBalance(PATIENT_UID, ENCOUNTER_UUID_A, TODAY);
    expect(bal.total_intake).toBe(200);
    expect(bal.total_output).toBe(50);
    expect(bal.balance).toBe(150);
    expect(bal.entries.length).toBe(2);
  });

  it('getIOBalance does NOT bleed in rows from a different encounter UUID', async () => {
    const bal = await getIOBalance(PATIENT_UID, ENCOUNTER_UUID_B, TODAY);
    expect(bal.total_intake).toBe(300);
    expect(bal.total_output).toBe(0);
    expect(bal.balance).toBe(300);
    expect(bal.entries.length).toBe(1);
  });

  it('getIOBalance still accepts a legacy integer encounter_id (backward compat)', async () => {
    const bal = await getIOBalance(PATIENT_UID, String(ENCOUNTER_INT), TODAY);
    expect(bal.total_intake).toBe(80);
    expect(bal.balance).toBe(80);
    expect(bal.entries.length).toBe(1);
  });

  it('getIOBalance returns the union across encounters when no encounter filter is supplied', async () => {
    const bal = await getIOBalance(PATIENT_UID, null, TODAY);
    expect(bal.total_intake).toBe(200 + 300 + 80);
    expect(bal.total_output).toBe(50);
    expect(bal.balance).toBe(530);
    expect(bal.entries.length).toBe(4);
  });

  it('getIOBalance still rejects garbage encounter input (regression boundary)', async () => {
    await expect(
      getIOBalance(PATIENT_UID, 'not-an-id', TODAY),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('getIOChart mirrors the same uuid-vs-int routing as the balance endpoint', async () => {
    const chartA = await getIOChart(PATIENT_UID, ENCOUNTER_UUID_A, null, null);
    expect(chartA.length).toBe(2);
    const chartB = await getIOChart(PATIENT_UID, ENCOUNTER_UUID_B, null, null);
    expect(chartB.length).toBe(1);
    const chartInt = await getIOChart(PATIENT_UID, String(ENCOUNTER_INT), null, null);
    expect(chartInt.length).toBe(1);
  });
});
