// Audit §3 (Clinical core & safety) — referral creation must persist its
// canonical clinical_timeline_events + clinical_audit_events row AND start the
// referral_response workflow SLA INSIDE the same transaction as the referral
// detail row (was: post-commit best-effort + swallowed, so an SLA-start failure
// silently vanished and a referral could exist with no response-time clock).
//
// Proven here against the real referralService + real QA DB:
//   1. createReferral persists referrals + clinical_timeline_events(referral.requested)
//      + clinical_audit_events + workflow_sla_instances(referral_response, active)
//      in one shot.
//   2. A forced canonical-write failure ROLLS BACK the referral — no orphan
//      referrals row, no orphan SLA row (atomicity).
//
// The canonical platform module is mocked with a TOGGLE: by default it delegates
// to the real implementation (so happy-path writes real rows); when
// `__forceCanonicalFailure` is set it throws a non-42P01 error, exercising the
// in-tx propagate→rollback path.

import { jest } from '@jest/globals';
import { randomUUID } from 'crypto';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

// Toggle + real-delegating mock of the canonical platform service.
const ctl = { forceFailEvent: false, forceFailSla: false };
const actualCanonical = await import('../services/clinical/canonicalClinicalPlatformService.js');
jest.unstable_mockModule('../services/clinical/canonicalClinicalPlatformService.js', () => ({
  ...actualCanonical,
  recordCanonicalClinicalEvent: async (...args) => {
    if (ctl.forceFailEvent) throw new Error('forced canonical event failure (test)');
    return actualCanonical.recordCanonicalClinicalEvent(...args);
  },
  startWorkflowSla: async (...args) => {
    if (ctl.forceFailSla) throw new Error('forced SLA start failure (test)');
    return actualCanonical.startWorkflowSla(...args);
  },
}));

const prisma = (await import('../lib/prisma.js')).default;
const referralService = (await import('../services/referral/referralService.js')).default;

const TENANT_ID = randomUUID();
const PATIENT_UID = randomUUID();
const DOCTOR_UID = randomUUID();
const PATIENT_PHONE = `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const DOCTOR_PHONE = `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

async function referralRows() {
  return prisma.$queryRawUnsafe(
    `SELECT id, status, referral_number FROM referrals
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
    TENANT_ID, PATIENT_UID,
  );
}
async function timelineRows() {
  return prisma.$queryRawUnsafe(
    `SELECT id, event_type, source_table, source_id FROM clinical_timeline_events
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND event_type = 'referral.requested'`,
    TENANT_ID, PATIENT_UID,
  );
}
async function auditRows() {
  return prisma.$queryRawUnsafe(
    `SELECT id, action FROM clinical_audit_events
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND action = 'referral.requested'`,
    TENANT_ID, PATIENT_UID,
  );
}
async function slaRows() {
  return prisma.$queryRawUnsafe(
    `SELECT id, status, source_table, source_id FROM workflow_sla_instances
      WHERE tenant_id = $1::uuid AND rule_code = 'referral_response' AND source_table = 'referrals'`,
    TENANT_ID,
  );
}

// Output-only cleanup (between tests): wipe the rows createReferral writes, but
// KEEP the tenant + patient + doctor fixtures so each test starts from a clean
// slate without re-seeding users (whose FKs the referral depends on).
async function cleanupOutputs() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM workflow_sla_instances WHERE tenant_id = $1::uuid AND source_table = 'referrals'`,
    TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM clinical_timeline_events WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM referrals WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
}

async function cleanup() {
  await cleanupOutputs();
  await prisma.$executeRawUnsafe(`DELETE FROM care_team_members WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM care_teams WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DOCTOR_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT_ID).catch(() => {});
}

const baseReferral = () => ({
  patient_uid: PATIENT_UID,
  referred_to_doctor: DOCTOR_UID,
  referred_to_department: 'Cardiology',
  reason: 'Chest pain, r/o ACS',
  urgency: 'urgent',
  requester_id: DOCTOR_UID,
  referring_doctor: DOCTOR_UID,
  actor_role: 'ADMIN', // admin bypasses the relationship gate (Phase-0 pre-flight)
  tenant_id: TENANT_ID,
  source: 'ward',
});

d('Referral creation canonical atomicity (audit §3)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, 'Referral Atomicity Tenant')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_ID, `ref-atom-${TENANT_ID.slice(0, 8)}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Referral Atomicity Patient', 'PATIENT', true, $3::uuid, NOW())`,
      PATIENT_UID, PATIENT_PHONE, TENANT_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Referral Atomicity Doctor', 'DOCTOR', true, $3::uuid, NOW())`,
      DOCTOR_UID, DOCTOR_PHONE, TENANT_ID,
    );
  }, 60_000);

  afterEach(async () => {
    ctl.forceFailEvent = false;
    ctl.forceFailSla = false;
    await cleanupOutputs();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('persists referral + canonical timeline + audit + active referral_response SLA in one tx', async () => {
    const created = await referralService.createReferral(baseReferral());
    expect(created.id).toBeTruthy();

    const refs = await referralRows();
    expect(refs).toHaveLength(1);

    const tl = await timelineRows();
    expect(tl.length).toBeGreaterThanOrEqual(1);
    expect(tl[0].source_table).toBe('referrals');
    expect(String(tl[0].source_id)).toBe(String(created.id));

    const au = await auditRows();
    expect(au.length).toBeGreaterThanOrEqual(1);

    const sla = await slaRows();
    expect(sla.length).toBeGreaterThanOrEqual(1);
    const ourSla = sla.find((s) => String(s.source_id) === String(created.id));
    expect(ourSla).toBeDefined();
    expect(ourSla.status).toBe('active');
  }, 30_000);

  it('rolls back the referral when the canonical timeline write fails (no orphan referral, no orphan SLA)', async () => {
    ctl.forceFailEvent = true;
    await expect(referralService.createReferral(baseReferral())).rejects.toThrow(/forced canonical event failure/);

    // The referral detail row must NOT have committed.
    expect(await referralRows()).toHaveLength(0);
    // No SLA orphaned either.
    expect(await slaRows()).toHaveLength(0);
  }, 30_000);

  it('rolls back the referral when the SLA start fails (canonical event must not survive alone)', async () => {
    ctl.forceFailSla = true;
    await expect(referralService.createReferral(baseReferral())).rejects.toThrow(/forced SLA start failure/);

    expect(await referralRows()).toHaveLength(0);
    expect(await timelineRows()).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  }, 30_000);
});
