// Sign-off moves the linked investigation to COMPLETED once no result is still
// pending. Two defects made that unreachable for whole classes of order:
//
//  1. THE PENDING PREDICATE omitted 'amended'. Sign-off writes three statuses —
//     verified -> 'final', corrected -> 'corrected', amended -> 'amended' — but
//     the probe accepted only 'final' and 'corrected', so an amended analyte
//     read as still pending forever and any panel containing one could never
//     complete.
//
//  2. THE BLOCK ONLY RAN FOR A 'verified' DECISION, so an order whose last
//     outstanding analyte was resolved correctively never reconciled at all —
//     including the orders defect 1 had already stranded.
//
// These are deliberately exercised through the real sign-off service rather
// than by asserting on the SQL, because the coupling that produced the bug is
// between what sign-off WRITES and what the probe ACCEPTS, and only the round
// trip tests that.
import prisma from '../lib/prisma.js';
import { signOffResults } from '../services/lab/labResultsService.js';
import { ensureTestIdentity } from './testClient.js';
import { purgeDiagnosticEvidence } from './helpers/diagnosticEvidenceCleanup.js';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'a2c00000-0000-4000-8000-000000000001';
const PATHOLOGIST_UID = 'a2c00000-0000-4000-8000-000000000002';

const investigationIds = [];
const resultIds = [];

async function seedEpisode(analytes) {
  const investigation = await prisma.$queryRawUnsafe(
    `INSERT INTO investigations
       (tenant_id, patient_uid, phone, test_name, test_type, status, priority,
        requested_at, updated_at)
     VALUES ($1::uuid, $2::uuid, '9822000101', 'Completion panel', 'LAB',
             'IN_PROGRESS', 'NORMAL', NOW(), NOW())
     RETURNING id`,
    TENANT, PATIENT_UID,
  );
  const investigationId = Number(investigation[0].id);
  investigationIds.push(investigationId);

  const created = [];
  for (const [index, analyte] of analytes.entries()) {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO lab_results
         (tenant_id, patient_uid, investigation_id, test_code, test_name,
          value_text, value_numeric, unit, abnormal_flag, is_critical, status)
       VALUES ($1::uuid, $2::uuid, $3::int, $4, $5, $6, $7, 'mmol/L', 'N', false, 'preliminary')
       RETURNING id`,
      TENANT, PATIENT_UID, investigationId,
      analyte.testCode || `CMP-${index + 1}`,
      analyte.testName || `Completion analyte ${index + 1}`,
      analyte.valueText || '4.2',
      analyte.valueNumeric ?? 4.2,
    );
    const id = Number(rows[0].id);
    resultIds.push(id);
    created.push(id);
  }
  return { investigationId, resultIds: created };
}

function signOff(ids, decision) {
  return signOffResults({
    tenantId: TENANT,
    signed_off_by: PATHOLOGIST_UID,
    signed_off_by_role: 'PATHOLOGIST',
    actorRoles: ['PATHOLOGIST'],
    actorRawRole: 'PATHOLOGIST',
    result_ids: ids,
    decision,
  });
}

async function investigationStatus(id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT status FROM investigations WHERE id = $1::int AND tenant_id = $2::uuid`,
    id, TENANT,
  );
  return rows[0]?.status ?? null;
}

async function cleanup() {
  await purgeDiagnosticEvidence(prisma, TENANT, [PATIENT_UID, PATHOLOGIST_UID]);
  if (resultIds.length > 0) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM lab_pathologist_signoffs
        WHERE tenant_id = $1::uuid AND result_ids && $2::int[]`,
      TENANT, resultIds,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM lab_results WHERE tenant_id = $1::uuid AND id = ANY($2::int[])`,
      TENANT, resultIds,
    ).catch(() => {});
    resultIds.length = 0;
  }
  if (investigationIds.length > 0) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM investigations WHERE tenant_id = $1::uuid AND id = ANY($2::int[])`,
      TENANT, investigationIds,
    ).catch(() => {});
    investigationIds.length = 0;
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM staff_credentials
      WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid
        AND name = 'Completion test registration'`,
    TENANT, PATHOLOGIST_UID,
  ).catch(() => {});
}

d('investigation completion after sign-off', () => {
  beforeAll(async () => {
    await ensureTestIdentity(PATHOLOGIST_UID);
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, name, role, status, is_active, is_deleted, updated_at)
       VALUES
         ($1::uuid, $3::uuid, '9822000101', 'Completion Patient', 'PATIENT', 'active', true, false, NOW()),
         ($2::uuid, $3::uuid, '9822000102', 'Completion Pathologist', 'PATHOLOGIST', 'active', true, false, NOW())
       ON CONFLICT (uid) DO UPDATE
         SET tenant_id = EXCLUDED.tenant_id, name = EXCLUDED.name, role = EXCLUDED.role,
             status = EXCLUDED.status, is_active = EXCLUDED.is_active,
             is_deleted = false, deleted_at = NULL`,
      PATIENT_UID, PATHOLOGIST_UID, TENANT,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff_credentials
         (tenant_id, staff_uid, credential_type, name, registration_number,
          status, verified_by, verified_at, created_by)
       VALUES ($1::uuid, $2::uuid, 'registration', 'Completion test registration',
               'CMP-REG-2042', 'active', $2::uuid, NOW(), $2::uuid)`,
      TENANT, PATHOLOGIST_UID,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
      PATIENT_UID, PATHOLOGIST_UID,
    ).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('completes a panel whose earlier analyte was amended before the last one was verified', async () => {
    const episode = await seedEpisode([{ testCode: 'CMP-A' }, { testCode: 'CMP-B' }]);
    const [a, b] = episode.resultIds;

    await signOff([a], 'verified');
    expect(await investigationStatus(episode.investigationId)).toBe('IN_PROGRESS');

    // A is amended before B is ever verified — the ordinary "the first result
    // was wrong and got fixed while the rest of the panel was still running"
    // sequence. A's status becomes 'amended'.
    await prisma.$executeRawUnsafe(
      `UPDATE lab_results SET value_text = '5.1', value_numeric = 5.1, updated_at = NOW() + interval '1 second'
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      a, TENANT,
    );
    await signOff([a], 'amended');
    const amended = await prisma.$queryRawUnsafe(
      `SELECT status FROM lab_results WHERE id = $1::int`, a,
    );
    expect(String(amended[0].status).toLowerCase()).toBe('amended');
    expect(await investigationStatus(episode.investigationId)).toBe('IN_PROGRESS');

    // Signing the last outstanding analyte must now complete the order. Before
    // the fix the probe read A's 'amended' as still pending and it never did.
    await signOff([b], 'verified');
    expect(await investigationStatus(episode.investigationId)).toBe('COMPLETED');
  });

  it('completes an order stranded by the old predicate when the last gap is closed correctively', async () => {
    const episode = await seedEpisode([{ testCode: 'CMP-C' }, { testCode: 'CMP-D' }]);
    const [c, e] = episode.resultIds;

    // Signed separately, not as one batch: the corrective predecessor lookup
    // matches on `result_ids = $2::int[]` — EXACT array equality — so a later
    // correction of one analyte only finds a predecessor if that analyte was
    // signed under its own id set.
    await signOff([c], 'verified');
    await signOff([e], 'verified');
    expect(await investigationStatus(episode.investigationId)).toBe('COMPLETED');

    // Reproduce the state the old predicate left behind: every result signed,
    // but the order still IN_PROGRESS because a past reconciliation read an
    // amended row as pending. This is the shape a stranded order has today.
    await prisma.$executeRawUnsafe(
      `UPDATE investigations SET status = 'IN_PROGRESS', completed_at = NULL
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      episode.investigationId, TENANT,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE lab_results SET value_text = '6.4', value_numeric = 6.4, updated_at = NOW() + interval '1 second'
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      c, TENANT,
    );

    // A CORRECTIVE decision must reconcile too. While the block ran only for
    // 'verified', a stranded order could sit IN_PROGRESS indefinitely because
    // nothing else was ever going to be verified on it.
    await signOff([c], 'corrected');
    expect(await investigationStatus(episode.investigationId)).toBe('COMPLETED');
  });

  it('does not complete a panel while a genuinely unsigned analyte remains', async () => {
    const episode = await seedEpisode([{ testCode: 'CMP-E' }, { testCode: 'CMP-F' }]);
    await signOff([episode.resultIds[0]], 'verified');
    expect(await investigationStatus(episode.investigationId)).toBe('IN_PROGRESS');
  });
});
