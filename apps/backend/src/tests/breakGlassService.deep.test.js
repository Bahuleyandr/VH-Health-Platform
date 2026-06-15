// PHI-access break-glass lifecycle — deep integration against the REAL engine + DB.
//
// CareTeam ABAC design §5. Proves, end to end (real breakGlassService, real
// accessDecisionService, real patient_access_break_glass +
// patient_access_break_glass_status_history tables under the default tenant):
//
//   1. ACTIVATE writes an 'active' row + a matching status-history row in one
//      transaction, AND emits the loud security signal (webhook + audit log).
//   2. reason < 8 chars is rejected (400 / AppError) before any row is written.
//   3. An ineligible role cannot activate (defense-in-depth behind route RBAC).
//   4. The ENGINE then GRANTS access for that patient while the override is
//      active (accessSource='break_glass'), where it denied before.
//   5. REVOKE flips the row to 'revoked' (terminal) + history; re-revoke 404s.
//   6. sweepExpiredBreakGlass flips a time-expired 'active' row to 'expired'.

import { jest } from '@jest/globals';

// The loud-alert utils are fire-and-forget and no-op when the env webhook is
// disabled, so module-mock them (ESM unstable_mockModule) to assert the
// break-glass signal fires. Modules under test are dynamically imported AFTER
// the mocks are registered.
const sendSecurityWebhook = jest.fn();
const logSecurityEvent = jest.fn();
jest.unstable_mockModule('../utils/securityWebhook.js', () => ({
  sendSecurityWebhook,
}));
jest.unstable_mockModule('../utils/securityAuditLogger.js', () => ({
  logSecurityEvent,
  SecurityEvents: {},
}));

const prisma = (await import('../lib/prisma.js')).default;
const { DEFAULT_TENANT_ID } = await import('../services/tenant/tenantService.js');
const {
  activateBreakGlass,
  revokeBreakGlass,
  listActiveBreakGlass,
  sweepExpiredBreakGlass,
} = await import('../services/security/breakGlassService.js');
const { authorizePatientAccessRequest } = await import('../services/security/accessDecisionService.js');

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const SUFFIX = String(Date.now() % 100000).padStart(5, '0');
const PATIENT_UID = `be100000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
// CMO is break-glass-eligible (phi.can_break_glass) AND requires a patient
// relationship (CLINICAL_LEADERSHIP), so without a break-glass row the engine
// denies — the clean control for "grants while active".
const ACTOR_UID = `be200000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const PATIENT_PHONE = `+9197001${SUFFIX}`;
const ACTOR_PHONE = `+9197002${SUFFIX}`;

// DIALYSIS → PATIENT_CRITICAL_CARE_VIEW policy: patient_relationship_required,
// break_glass_allowed=true, full relationship chain incl. break_glass.
function engineReq() {
  return {
    id: `bg-${SUFFIX}`,
    method: 'GET',
    originalUrl: `/api/v1/dialysis?patient_uid=${PATIENT_UID}`,
    params: {},
    query: { patient_uid: PATIENT_UID },
    body: {},
    tenantId: DEFAULT_TENANT_ID,
    user: { id: 0, uid: ACTOR_UID, role: 'CMO', tenant_id: DEFAULT_TENANT_ID },
  };
}

async function historyRows(breakGlassId) {
  return prisma.$queryRawUnsafe(
    `SELECT from_status, to_status
       FROM patient_access_break_glass_status_history
      WHERE tenant_id = $1::uuid AND break_glass_id = $2::int
      ORDER BY id ASC`,
    DEFAULT_TENANT_ID,
    breakGlassId,
  );
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_access_break_glass_status_history WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_access_break_glass WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_access_audit_log WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, ACTOR_UID,
  ).catch(() => {});
}

d('PHI break-glass lifecycle (deep, real engine/DB)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'BG Patient [test]', 'PATIENT', true, $3::uuid, NOW()),
              ($4::uuid, $5, 'BG CMO [test]', 'CMO', true, $3::uuid, NOW())`,
      PATIENT_UID, PATIENT_PHONE, DEFAULT_TENANT_ID, ACTOR_UID, ACTOR_PHONE,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  beforeEach(() => {
    sendSecurityWebhook.mockClear();
    logSecurityEvent.mockClear();
  });

  it('rejects a too-short reason before writing any row', async () => {
    await expect(activateBreakGlass({
      tenantId: DEFAULT_TENANT_ID,
      patientUid: PATIENT_UID,
      actorUid: ACTOR_UID,
      actorRole: 'CMO',
      reason: 'short',           // 5 chars < 8
    })).rejects.toMatchObject({ statusCode: 400, code: 'BREAK_GLASS_REASON_TOO_SHORT' });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM patient_access_break_glass WHERE patient_uid = $1::uuid`,
      PATIENT_UID,
    );
    expect(rows[0].n).toBe(0);
    expect(sendSecurityWebhook).not.toHaveBeenCalled();
  });

  it('rejects an ineligible role (defense-in-depth behind route RBAC)', async () => {
    await expect(activateBreakGlass({
      tenantId: DEFAULT_TENANT_ID,
      patientUid: PATIENT_UID,
      actorUid: ACTOR_UID,
      actorRole: 'NURSING_STAFF',  // not in can_break_glass set
      reason: 'Emergency cross-team access needed now',
    })).rejects.toMatchObject({ statusCode: 403, code: 'BREAK_GLASS_ROLE_INELIGIBLE' });
  });

  it('engine DENIES before any break-glass is active (control)', async () => {
    const decision = await authorizePatientAccessRequest(engineReq(), {
      recordType: 'DIALYSIS',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.accessDecision).toBe('deny');
  });

  it('ACTIVATE writes an active row + history row and fires the loud alert', async () => {
    const row = await activateBreakGlass({
      tenantId: DEFAULT_TENANT_ID,
      patientUid: PATIENT_UID,
      actorUid: ACTOR_UID,
      actorRole: 'CMO',
      reason: 'Patient crashing, primary team unreachable',
    });

    expect(row.id).toBeTruthy();
    expect(row.status).toBe('active');
    expect(row.patient_uid).toBe(PATIENT_UID);
    expect(row.actor_uid).toBe(ACTOR_UID);
    // expires_at ~2h from now (default), and in the future.
    expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now());

    // Row persisted as active.
    const persisted = await prisma.$queryRawUnsafe(
      `SELECT status FROM patient_access_break_glass WHERE id = $1::int`, row.id,
    );
    expect(persisted[0].status).toBe('active');

    // Status-history row written in the same tx.
    const hist = await historyRows(row.id);
    expect(hist).toHaveLength(1);
    expect(hist[0].from_status).toBeNull();
    expect(hist[0].to_status).toBe('active');

    // LOUD: both the webhook and the persistent security audit fired.
    expect(sendSecurityWebhook).toHaveBeenCalledTimes(1);
    expect(sendSecurityWebhook.mock.calls[0][0]).toBe('PHI_BREAK_GLASS_ACTIVATED');
    expect(logSecurityEvent).toHaveBeenCalledWith(
      'PHI_BREAK_GLASS_ACTIVATED',
      expect.objectContaining({ userId: ACTOR_UID }),
    );

    // Visible in the active list, scoped by patient.
    const active = await listActiveBreakGlass({ tenantId: DEFAULT_TENANT_ID, patientUid: PATIENT_UID });
    expect(active.map((r) => r.id)).toContain(row.id);
  });

  it('engine GRANTS via break_glass while the override is active', async () => {
    const decision = await authorizePatientAccessRequest(engineReq(), {
      recordType: 'DIALYSIS',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.accessSource).toBe('break_glass');
    expect(decision.accessDecision).toBe('break_glass');
  });

  it('REVOKE flips the row to revoked + writes history; re-revoke 404s', async () => {
    const active = await listActiveBreakGlass({ tenantId: DEFAULT_TENANT_ID, patientUid: PATIENT_UID });
    const target = active[0];
    expect(target).toBeTruthy();

    const revoked = await revokeBreakGlass({
      id: target.id,
      tenantId: DEFAULT_TENANT_ID,
      actorUid: ACTOR_UID,
    });
    expect(revoked.status).toBe('revoked');
    expect(revoked.ended_at).toBeTruthy();

    const persisted = await prisma.$queryRawUnsafe(
      `SELECT status FROM patient_access_break_glass WHERE id = $1::int`, target.id,
    );
    expect(persisted[0].status).toBe('revoked');

    const hist = await historyRows(target.id);
    expect(hist.map((h) => h.to_status)).toEqual(['active', 'revoked']);

    expect(sendSecurityWebhook).toHaveBeenCalledWith('PHI_BREAK_GLASS_REVOKED', expect.any(Object));

    // No longer active → engine denies again.
    const decision = await authorizePatientAccessRequest(engineReq(), { recordType: 'DIALYSIS' });
    expect(decision.allowed).toBe(false);

    // Re-revoking the same (now terminal) row is a clean 404.
    await expect(revokeBreakGlass({
      id: target.id,
      tenantId: DEFAULT_TENANT_ID,
      actorUid: ACTOR_UID,
    })).rejects.toMatchObject({ statusCode: 404, code: 'BREAK_GLASS_NOT_FOUND' });
  });

  it('sweepExpiredBreakGlass flips a time-expired active row to expired', async () => {
    // Insert an already-expired active row directly (expires_at in the past).
    const inserted = await prisma.$queryRawUnsafe(
      `INSERT INTO patient_access_break_glass (
         tenant_id, patient_uid, actor_uid, actor_role, reason, status,
         started_at, expires_at, created_at, updated_at
       )
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'CMO', 'Expired override for sweeper test', 'active',
               NOW() - INTERVAL '3 hours', NOW() - INTERVAL '1 hour', NOW(), NOW())
       RETURNING id`,
      DEFAULT_TENANT_ID, PATIENT_UID, ACTOR_UID,
    );
    const id = inserted[0].id;

    const result = await sweepExpiredBreakGlass();
    expect(result.expired).toBeGreaterThanOrEqual(1);

    const after = await prisma.$queryRawUnsafe(
      `SELECT status FROM patient_access_break_glass WHERE id = $1::int`, id,
    );
    expect(after[0].status).toBe('expired');

    // History records the active→expired transition.
    const hist = await historyRows(id);
    expect(hist.some((h) => h.from_status === 'active' && h.to_status === 'expired')).toBe(true);
  });
});
