// Dialysis machine-data ingestion tenant scope (D7).
//
// Three tenant defects on one code path, all proven against the real schema.
//
// 1. THE MATCH. ingestMachineObservations found the in-progress session by
//    machine_no ALONE:
//
//      SELECT id, dialysis_patient_id FROM dialysis_sessions
//       WHERE machine_no = $1 AND status = 'in_progress'
//
//    machine_no is a device label ("FRES-4008-07"), not a globally unique key,
//    so two tenants running the same model collide. Nothing else scoped the
//    read: the service uses a plain `prisma` client with no transaction-local
//    app.current_tenant_id, and dialysis_sessions carries only the PERMISSIVE
//    tenant_isolation policy, which explicitly permits every row when that GUC
//    is unset. RLS does not backstop this.
//
// 2. THE RE-CHECK. The service then called logObservation with no tenantId, so
//    the in-tenant re-check inside logObservation resolved `undefined` through
//    requireTenantId — DEFAULT_TENANT_ID while ALLOW_DEFAULT_TENANT=true
//    (today's single-hospital posture, and the jest default), a 403 once that
//    flips false at the multi-tenant cutover. So the re-check AGREED with the
//    unscoped match whenever the matched session belonged to the default
//    tenant, and would have failed every ingestion after the cutover.
//
// 3. THE STAMP. logObservation's INSERT omitted tenant_id and let the column
//    default supply it — COALESCE(the same unset GUC, DEFAULT_TENANT_ID) — so
//    an observation on a non-default tenant's session was stamped with the
//    default tenant's id. Reads filter by session_id behind an in-tenant
//    session lookup, so nothing became invisible; the row's own attribution was
//    just wrong.
//
// Defects 1 and 2 compose into a completed cross-tenant WRITE, which is why the
// fixture below gives each tenant a machine the OTHER has no session on: that
// is the shape where the unscoped match has only the wrong tenant's row to
// return. Asserting on the thrown code alone would not be enough — pre-fix the
// leak direction returned 201 — so each isolation test also asserts the victim
// session's observation count did not move.
import { ingestMachineObservations } from '../services/clinical/dialysisMachineService.js';
import prisma from '../lib/prisma.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

// TENANT_A is deliberately the DEFAULT tenant: that is what requireTenantId
// falls back to under ALLOW_DEFAULT_TENANT=true, and it is what turns the
// B-caller/A-session direction into a completed write rather than a 404.
const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '7d1a1000-0000-4000-8000-0000000000b7';

// One machine per tenant. Neither tenant has a session on the other's machine,
// so an unscoped match has nothing of its own to find.
const MACHINE_A = 'FRES-4008-D7TENANT-A';
const MACHINE_B = 'FRES-4008-D7TENANT-B';

const PATIENT_A_UID = '7d1a1000-0000-4000-8000-0000000000a1';
const PATIENT_B_UID = '7d1a1000-0000-4000-8000-0000000000b1';

let sessionA;
let sessionB;

const payload = (machineNo, systolic) => ({
  machine_no: machineNo,
  observations: [{ bp_systolic: systolic, bp_diastolic: 70, pulse: 78, blood_flow_ml_min: 300 }],
});

async function obsRowsFor(sessionId) {
  return prisma.$queryRawUnsafe(
    `SELECT bp_systolic, tenant_id FROM dialysis_intra_obs
      WHERE session_id = $1 ORDER BY id`,
    sessionId,
  );
}

async function seedSession(tenantId, patientUid, machineNo) {
  const pat = await prisma.$queryRawUnsafe(
    `INSERT INTO dialysis_patients (tenant_id, patient_uid, modality, status)
     VALUES ($1::uuid, $2::uuid, 'hd', 'active') RETURNING id`,
    tenantId, patientUid,
  );
  const sess = await prisma.$queryRawUnsafe(
    `INSERT INTO dialysis_sessions
       (tenant_id, dialysis_patient_id, modality, status, machine_no, actual_start_at)
     VALUES ($1::uuid, $2, 'hd', 'in_progress', $3, NOW()) RETURNING id`,
    tenantId, Number(pat[0].id), machineNo,
  );
  return Number(sess[0].id);
}

async function clean() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM dialysis_patients WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    PATIENT_A_UID, PATIENT_B_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM lab_interface_messages WHERE analyzer_code IN ($1, $2)`,
    MACHINE_A, MACHINE_B,
  ).catch(() => {});
}

d('Dialysis machine ingestion is tenant-scoped (D7)', () => {
  beforeAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, 'd7-machine-tenant-b', 'D7 Machine Tenant B')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_B,
    );
    sessionA = await seedSession(TENANT_A, PATIENT_A_UID, MACHINE_A);
    sessionB = await seedSession(TENANT_B, PATIENT_B_UID, MACHINE_B);
  }, 30000);

  afterAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT_B).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }, 30000);

  it('the fixture really does straddle a tenant boundary', async () => {
    // Without this the isolation assertions could pass vacuously — there would
    // be nothing on the other side of the boundary to leak.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT machine_no, tenant_id::text AS tenant_id FROM dialysis_sessions
        WHERE machine_no IN ($1, $2) AND status = 'in_progress'
        ORDER BY machine_no`,
      MACHINE_A, MACHINE_B,
    );
    expect(rows.map((r) => [r.machine_no, r.tenant_id]))
      .toEqual([[MACHINE_A, TENANT_A], [MACHINE_B, TENANT_B]]);
  });

  it('a tenant-B caller cannot WRITE onto the default tenant\'s session', async () => {
    // THE LEAK DIRECTION. Pre-fix the unscoped match returned tenant A's
    // session, the re-check fell back to the default tenant and agreed, and
    // this call resolved 201 with the observation landed on tenant A's patient
    // — so assert tenant A's rows did not move, not merely that we threw.
    const before = await obsRowsFor(sessionA);
    await expect(
      ingestMachineObservations({ payload: payload(MACHINE_A, 222), machineCode: MACHINE_A, tenantId: TENANT_B }),
    ).rejects.toMatchObject({ code: 'DIALYSIS_MACHINE_SESSION_NOT_FOUND' });
    expect(await obsRowsFor(sessionA)).toEqual(before);
  });

  it('a tenant-A caller cannot reach tenant B\'s session either', async () => {
    const before = await obsRowsFor(sessionB);
    await expect(
      ingestMachineObservations({ payload: payload(MACHINE_B, 111), machineCode: MACHINE_B, tenantId: TENANT_A }),
    ).rejects.toMatchObject({ code: 'DIALYSIS_MACHINE_SESSION_NOT_FOUND' });
    expect(await obsRowsFor(sessionB)).toEqual(before);
  });

  it('each tenant still ingests onto its OWN session (the predicate is not a blanket deny)', async () => {
    const a = await ingestMachineObservations(
      { payload: payload(MACHINE_A, 133), machineCode: MACHINE_A, tenantId: TENANT_A },
    );
    expect(a.session_id).toBe(sessionA);
    expect(a.ingested).toBe(1);

    const b = await ingestMachineObservations(
      { payload: payload(MACHINE_B, 144), machineCode: MACHINE_B, tenantId: TENANT_B },
    );
    expect(b.session_id).toBe(sessionB);
    expect(b.ingested).toBe(1);
  });

  it('the observation row is stamped with its OWN session\'s tenant', async () => {
    // Defect 3. Before the explicit bind, tenant B's observation carried
    // TENANT_A's id because the column default read an unset GUC.
    expect((await obsRowsFor(sessionA)).map((r) => [Number(r.bp_systolic), r.tenant_id]))
      .toEqual([[133, TENANT_A]]);
    expect((await obsRowsFor(sessionB)).map((r) => [Number(r.bp_systolic), r.tenant_id]))
      .toEqual([[144, TENANT_B]]);
  });

  it('the inbox row is written under the CALLER\'s tenant, not the matched session\'s', async () => {
    // The raw payload persists before the match, so a rejected cross-tenant
    // attempt must still be attributable to the tenant that sent it.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT status FROM lab_interface_messages
        WHERE analyzer_code IN ($1, $2) AND tenant_id = $3::uuid`,
      MACHINE_A, MACHINE_B, TENANT_B,
    );
    // Two tenant-B attempts above: the rejected cross-tenant one, and its own.
    expect(rows.map((r) => r.status).sort()).toEqual(['failed', 'ingested']);
  });
});
