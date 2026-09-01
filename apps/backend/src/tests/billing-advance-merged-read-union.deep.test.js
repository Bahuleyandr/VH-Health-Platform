// Advances survive a patient merge on the READ side.
//
// The pharmacy advance lane protects billing_advances with financial-lineage
// immutability triggers, so the merge sweep cannot re-point patient_uid: a
// merged patient's advances legitimately stay on the pre-merge uid. That is
// only safe while every patient-scoped read of the table unions the merged
// family — otherwise the survivor's own advance list silently loses money that
// is still theirs, with no error anywhere.
//
// This is the deep coverage that certifies billing_advances for
// MERGE_READ_UNION_COVERED_TABLES. It asserts the union works AND that it does
// not over-reach: an unrelated patient's advance must never appear.
import { randomUUID } from 'node:crypto';
import prisma from '../lib/prisma.js';
import { listAdvances } from '../services/billing/billingV2Service.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const TAG = `MRU-${String(Date.now() % 100000).padStart(5, '0')}`;
const TENANT = '00000000-0000-4000-8000-000000000001';

const survivor = randomUUID();
const merged = randomUUID();
const stranger = randomUUID();

async function makePatient(uid, name) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, tenant_id, name, role, phone, is_active, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, 'PATIENT', $4, TRUE, NOW())`,
    uid, TENANT, `${TAG} ${name}`, `9${String(BigInt(`0x${uid.replace(/-/g, '').slice(0, 12)}`) % 1000000000n).padStart(9, '0')}`,
  );
}

async function makeAdvance(patientUid, amount, reference) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO billing_advances
       (patient_uid, tenant_id, amount, balance, mode, reference, status, collected_at)
     VALUES ($1::uuid, $2::uuid, $3::numeric, $3::numeric, 'CASH', $4, 'ACTIVE', NOW())
     RETURNING id`,
    patientUid, TENANT, amount, `${TAG}-${reference}`,
  );
  return Number(rows[0].id);
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM billing_advances WHERE reference LIKE $1`, `${TAG}-%`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `UPDATE users SET merged_into_uid = NULL WHERE name LIKE $1`, `${TAG} %`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE name LIKE $1`, `${TAG} %`,
  ).catch(() => {});
}

describeIfDb('advances survive a patient merge on the read side', () => {
  let mergedAdvanceId;
  let survivorAdvanceId;

  beforeAll(async () => {
    await cleanup();
    await makePatient(survivor, 'survivor');
    await makePatient(merged, 'merged');
    await makePatient(stranger, 'stranger');

    survivorAdvanceId = await makeAdvance(survivor, 100, 'survivor');
    mergedAdvanceId = await makeAdvance(merged, 250, 'merged');
    await makeAdvance(stranger, 999, 'stranger');

    // The merge outcome, without running the whole sweep: the secondary points
    // at the survivor, and its advance deliberately stays on the pre-merge uid
    // because the lineage triggers forbid re-pointing it.
    await prisma.$executeRawUnsafe(
      `UPDATE users SET merged_into_uid = $1::uuid, is_active = FALSE
        WHERE uid = $2::uuid AND tenant_id = $3::uuid`,
      survivor, merged, TENANT,
    );
  }, 60000);

  afterAll(async () => {
    await cleanup();
  }, 60000);

  it('the merged patient advance is still on its pre-merge uid', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT patient_uid::text AS patient_uid FROM billing_advances WHERE id = $1::int`,
      mergedAdvanceId,
    );
    // If this ever changes, the sweep started re-pointing these rows and this
    // whole read-union certification needs re-examining rather than patching.
    expect(rows[0].patient_uid).toBe(merged);
  });

  it("listAdvances for the survivor returns the merged patient's advance too", async () => {
    const rows = await listAdvances({ tenantId: TENANT, patient_uid: survivor });
    const ids = rows.map((r) => Number(r.id));
    expect(ids).toContain(survivorAdvanceId);
    expect(ids).toContain(mergedAdvanceId);
  });

  it('does not reach an unrelated patient', async () => {
    const rows = await listAdvances({ tenantId: TENANT, patient_uid: survivor });
    const refs = rows.map((r) => String(r.reference || ''));
    expect(refs).not.toContain(`${TAG}-stranger`);
  });

  it('reading the merged uid directly does not pull in the survivor', async () => {
    // The union is directional: it widens a survivor's read to absorb what was
    // merged INTO them, never the reverse. Without this, the relation would be
    // symmetric and a stale uid would expose the survivor's later activity.
    const rows = await listAdvances({ tenantId: TENANT, patient_uid: merged });
    const ids = rows.map((r) => Number(r.id));
    expect(ids).toContain(mergedAdvanceId);
    expect(ids).not.toContain(survivorAdvanceId);
  });
});
