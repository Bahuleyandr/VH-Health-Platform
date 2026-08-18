// Deep test for the drug-returns disposal witness hardening (quick win A6):
// Schedule H1 / X / narcotic return lines can no longer be recorded with a
// free-text witness name — the witness must be a REAL, distinct, active staff
// member of the tenant with an eligible pharmacy/medical/nursing role,
// validated through the same assertControlledDispenseWitness roster check the
// controlled-dispense path uses. The stored witness_name is the canonical
// roster name, never the caller's string. Non-controlled lines keep the
// legacy optional free-text witness (backward compatible), but a supplied
// witness_uid is always validated.
//
// Tests seed/connect as the postgres superuser (jest.setup default
// DATABASE_URL), which bypasses RLS; the service's explicit tenant filters
// still apply.
import prisma from '../lib/prisma.js';
import { createBatch, addLine } from '../services/compliance/drugReturnsService.js';

const TENANT = '00000000-0000-4000-8000-0000d8e70001';
const RECORDER = 'b1111111-1111-4111-8111-111111111d87';
const WITNESS = 'b2222222-2222-4222-8222-222222222d87';
const CLERK = 'b3333333-3333-4333-8333-333333333d87';
const INACTIVE = 'b4444444-4444-4444-8444-444444444d87';
const GHOST = 'b9999999-9999-4999-8999-999999999d87';

describe('drug-return disposal witness validation', () => {
  let batchId;

  async function cleanup() {
    await prisma.$executeRawUnsafe(
      `DELETE FROM drug_return_lines WHERE batch_id IN
         (SELECT id FROM drug_return_batches WHERE tenant_id=$1::uuid)`,
      TENANT,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM drug_return_batches WHERE tenant_id=$1::uuid`, TENANT,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM drug_return_serial_counter WHERE tenant_id=$1::uuid`, TENANT,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM staff WHERE user_id = ANY($1::uuid[])`,
      [RECORDER, WITNESS, CLERK, INACTIVE],
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = ANY($1::uuid[])`,
      [RECORDER, WITNESS, CLERK, INACTIVE],
    ).catch(() => {});
  }

  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
       VALUES ($1::uuid,'drt-wit-test','DRT Witness','IN','active',NOW(),NOW())
       ON CONFLICT (id) DO NOTHING`,
      TENANT,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, name, role, tenant_id, updated_at)
       VALUES
         ($1::uuid, 'Returns Recorder', 'PHARMACY_INCHARGE', $4::uuid, NOW()),
         ($2::uuid, 'Returns Witness', 'PHARMACY_STAFF', $4::uuid, NOW()),
         ($3::uuid, 'Returns Clerk', 'RECEPTIONIST', $4::uuid, NOW())
       ON CONFLICT (uid) DO NOTHING`,
      RECORDER, WITNESS, CLERK, TENANT,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, name, role, tenant_id, is_active, updated_at)
       VALUES ($1::uuid, 'Departed Returns Witness', 'PHARMACY_STAFF', $2::uuid, false, NOW())
       ON CONFLICT (uid) DO NOTHING`,
      INACTIVE, TENANT,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff (user_id, employee_id, name, is_active, archived, tenant_id, updated_at)
       VALUES
         ($1::uuid, 'DRT-RECORDER', 'Roster Returns Recorder', true, false, $5::uuid, NOW()),
         ($2::uuid, 'DRT-WITNESS', 'Roster Returns Witness', true, false, $5::uuid, NOW()),
         ($3::uuid, 'DRT-CLERK', 'Roster Returns Clerk', true, false, $5::uuid, NOW()),
         ($4::uuid, 'DRT-INACTIVE', 'Roster Departed Witness', false, false, $5::uuid, NOW())`,
      RECORDER, WITNESS, CLERK, INACTIVE, TENANT,
    );
    const batch = await createBatch({
      tenantId: TENANT,
      reason: 'expired',
      counterparty_kind: 'manufacturer',
      counterparty_name: 'Acme Pharma',
      initiated_by: RECORDER,
    });
    batchId = batch.id;
  });

  afterAll(async () => {
    await cleanup();
    if (typeof prisma.$disconnect === 'function') await prisma.$disconnect();
  });

  const controlledLine = (overrides = {}) => ({
    tenantId: TENANT,
    batch_id: batchId,
    recorded_by: RECORDER,
    drug_name: 'Alprazolam 0.5mg',
    mfr_batch_no: 'ALP-001',
    qty_units: 10,
    schedule: 'X',
    ...overrides,
  });

  test('controlled line without witness_uid fails closed (free text is not evidence)', async () => {
    await expect(addLine(controlledLine({ witness_name: 'Somebody Typed' })))
      .rejects.toMatchObject({ code: 'DRUG_RETURN_WITNESS_REQUIRED', statusCode: 400 });
  });

  test('H1 and narcotic lines are equally gated', async () => {
    await expect(addLine(controlledLine({ schedule: 'H1' })))
      .rejects.toMatchObject({ code: 'DRUG_RETURN_WITNESS_REQUIRED' });
    await expect(addLine(controlledLine({ schedule: null, is_narcotic: true })))
      .rejects.toMatchObject({ code: 'DRUG_RETURN_WITNESS_REQUIRED' });
  });

  test('ghost, ineligible-role, inactive, self, and non-uuid witnesses are rejected', async () => {
    await expect(addLine(controlledLine({ witness_uid: GHOST })))
      .rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_NOT_FOUND' });
    await expect(addLine(controlledLine({ witness_uid: CLERK })))
      .rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_ROLE_INELIGIBLE' });
    await expect(addLine(controlledLine({ witness_uid: INACTIVE })))
      .rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_NOT_FOUND' });
    await expect(addLine(controlledLine({ witness_uid: RECORDER })))
      .rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_SELF' });
    await expect(addLine(controlledLine({ witness_uid: 'not-a-uuid' })))
      .rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_INVALID' });
  });

  test('missing authenticated recorder fails closed for a witnessed line', async () => {
    await expect(addLine(controlledLine({ recorded_by: null, witness_uid: WITNESS })))
      .rejects.toMatchObject({ code: 'DRUG_RETURN_RECORDER_REQUIRED' });
  });

  test('valid witness: line stores the witness uid + CANONICAL roster name (caller text ignored)', async () => {
    const line = await addLine(controlledLine({
      witness_uid: WITNESS,
      witness_name: 'Caller Typed Someone Else',
    }));
    expect(String(line.witness_uid)).toBe(WITNESS);
    expect(line.witness_name).toBe('Roster Returns Witness');
    expect(line.schedule).toBe('X');
  });

  test('non-controlled line keeps the legacy optional free-text witness (backward compatible)', async () => {
    const line = await addLine(controlledLine({
      schedule: 'NONE',
      is_narcotic: false,
      drug_name: 'Paracetamol 500mg',
      mfr_batch_no: 'PCM-1',
      witness_name: 'Free Text Witness',
      witness_uid: undefined,
    }));
    expect(line.witness_uid).toBeNull();
    expect(line.witness_name).toBe('Free Text Witness');

    const bare = await addLine(controlledLine({
      schedule: 'NONE',
      is_narcotic: false,
      drug_name: 'Cetirizine 10mg',
      mfr_batch_no: 'CET-1',
      witness_uid: undefined,
      witness_name: undefined,
    }));
    expect(bare.witness_name).toBeNull();
  });

  test('a witness_uid supplied on a non-controlled line is still validated', async () => {
    await expect(addLine(controlledLine({
      schedule: 'NONE',
      is_narcotic: false,
      witness_uid: CLERK,
    }))).rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_ROLE_INELIGIBLE' });

    const line = await addLine(controlledLine({
      schedule: 'NONE',
      is_narcotic: false,
      drug_name: 'Ibuprofen 400mg',
      mfr_batch_no: 'IBU-1',
      witness_uid: WITNESS,
    }));
    expect(line.witness_name).toBe('Roster Returns Witness');
  });
});
