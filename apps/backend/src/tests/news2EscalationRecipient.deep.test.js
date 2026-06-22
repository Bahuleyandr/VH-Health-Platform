// WS-A / audit W1-H4 regression.
//
// A high NEWS2 (>= 5; critical >= 7) deterioration alert MUST reach a real,
// assigned, acknowledgement-tracked recipient. Before the fix, escalateNews2()
// queued a NEWS2_ALERT into notification_outbox with NO recipient_id and NO
// recipient_phone, so the drain dead-lettered it after 3 retries — the
// deteriorating-patient page reached nobody. The fix routes it through the
// results-inbox producer (enqueueCriticalResultTask), which creates an assigned
// (DUTY-role fallback), SLA-clocked, escalation-swept task.
//
// This pins: a NEWS2 >= threshold produces at least one tasks row for the
// news2_score with a non-null assignee (uid OR role).

import prisma from '../lib/prisma.js';
import { escalateNews2 } from '../services/clinical/news2Service.js';

const hasDb = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001'; // literal default tenant
const PATIENT = '00000000-0000-4000-8000-0000000a7e51';

async function exec(sql, ...p) {
  return prisma.$executeRawUnsafe(sql, ...p);
}
async function query(sql, ...p) {
  const r = await prisma.$queryRawUnsafe(sql, ...p);
  return Array.isArray(r) ? r : [];
}

d('NEWS2 escalation reaches an assigned recipient (audit W1-H4)', () => {
  beforeAll(async () => {
    // Clear any task left by a prior/aborted run for this patient — an open task
    // for this score would make the producer idempotently skip (created:false,
    // no error), which is a safe no-op for the service but defeats this test's
    // "a fresh task is created" intent. Self-isolating, not stale-state-dependent.
    await exec(`DELETE FROM tasks WHERE patient_uid = $1::uuid`, PATIENT).catch(() => {});
    await exec(
      `INSERT INTO users (uid, phone, name, role, is_active, status, tenant_id, updated_at)
       VALUES ($1::uuid, '8990111222', 'NEWS2 Test Patient', 'PATIENT', true, 'active', $2::uuid, NOW())
       ON CONFLICT (uid) DO NOTHING`,
      PATIENT,
      TENANT,
    );
  });

  afterAll(async () => {
    await exec(`DELETE FROM tasks WHERE patient_uid = $1::uuid`, PATIENT).catch(() => {});
    await exec(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('a NEWS2 >= 7 produces an assigned, ack-tracked task (assignee or role)', async () => {
    await escalateNews2(
      PATIENT,
      { id: 987654 },
      { totalScore: 8, clinicalRisk: 'high', escalationAction: 'Urgent clinical review', scores: {}, anyParamThree: true },
      { tenantId: TENANT },
    );

    const rows = await query(
      `SELECT id, assigned_to_uid, assigned_to_role
         FROM tasks
        WHERE patient_uid = $1::uuid AND related_resource_type = 'news2_score'`,
      PATIENT,
    );

    expect(rows.length).toBeGreaterThanOrEqual(1);
    // The deteriorating-patient alert must have a deliverable recipient — either
    // an explicit assignee or (the DUTY-role fallback) a role to escalate to.
    expect(rows.some((r) => r.assigned_to_uid != null || r.assigned_to_role != null)).toBe(true);
  });
});
