import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';

import { listMedicationSafetyReviews } from '../services/clinical/canonicalClinicalPlatformService.js';
import {
  createIsolationEmergencyAuthorization, validateIsolationEmergencyTx,
} from '../services/clinical/dialysisIsolationEmergencyService.js';
import { listSessions, todayBoard } from '../services/clinical/dialysisService.js';
import { placeHoldTx } from '../services/clinical/reprocessableDeviceService.js';
import { createProtocolDeviceScopeTx, createProtocolRevisionTx } from '../services/clinical/reprocessingProtocolService.js';
import { notificationOutbox } from '../utils/notifications/notificationOutbox.js';
import {
  assertMarkerFree, createPlan4DialysisFixture, describeWithDatabase, prisma, setTenantTx,
} from './helpers/plan4DialysisFixtures.js';

const FINGERPRINT_CANARY = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

describeWithDatabase('dialysis emergency isolation authorization', () => {
  let fixture;
  let consultant;
  let admin;
  let machines;
  let scheduledFor;
  let scheduledDay;

  async function query(sql, ...params) {
    return setTenantTx(fixture.tenantId, (tx) => tx.$queryRawUnsafe(sql, fixture.tenantId, ...params));
  }

  async function execute(sql, ...params) {
    return setTenantTx(fixture.tenantId, (tx) => tx.$executeRawUnsafe(sql, fixture.tenantId, ...params));
  }

  async function insertRevision(tx, revision) {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO reprocessing_isolation_setting_revisions
         (tenant_id, revision, approved_isolation_groups, isolation_groups,
          vocabulary_approved_by, vocabulary_approved_role, vocabulary_approved_at,
          mapping_approved_by, mapping_approved_role, mapping_approved_at, created_by)
       VALUES ($1::uuid, $2::int, ARRAY['Bay One'], $3::jsonb,
               $4::uuid, 'INFECTION_CONTROL_OFFICER', clock_timestamp(),
               $4::uuid, 'INFECTION_CONTROL_OFFICER', clock_timestamp(), $4::uuid)
       RETURNING id`, fixture.tenantId, revision,
      JSON.stringify({ hbsag: 'Bay One', hcv: 'Bay One', hiv: 'Bay One', isolation_mixed: 'Bay One' }),
      fixture.infectionControlActor.uid,
    );
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  beforeEach(async () => {
    fixture = await createPlan4DialysisFixture({ clearMarkers: false });
    consultant = { uid: randomUUID(), role: 'CONSULTANT' };
    admin = { uid: randomUUID(), role: 'ADMIN' };
    scheduledFor = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    await setTenantTx(fixture.tenantId, async (tx) => {
      const [calendar] = await tx.$queryRawUnsafe(
        'SELECT $1::timestamptz::date::text AS scheduled_day', scheduledFor,
      );
      scheduledDay = calendar.scheduled_day;
      const users = [consultant, admin];
      expect(users).toHaveLength(2);
      for (const user of users) {
        await tx.$executeRawUnsafe(
          `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
           VALUES ($1::uuid, $2::uuid, $3, 'Emergency authorization fixture', $4, TRUE, 'active', NOW())`,
          user.uid, fixture.tenantId, user.uid.replaceAll('-', '').slice(0, 14), user.role,
        );
      }
      const revision = await insertRevision(tx, 1);
      await tx.$executeRawUnsafe(
        `UPDATE reprocessing_domain_settings
            SET isolation_revision_id = $2::bigint, isolation_enforcement = 'block'
          WHERE tenant_id = $1::uuid AND domain = 'dialysis'`, fixture.tenantId, revision.id,
      );
      machines = await tx.$queryRawUnsafe(
        `INSERT INTO dialysis_machines (tenant_id, machine_no, isolation_group, created_by)
         VALUES ($1::uuid, 'Emergency One', 'Bay One', $2::uuid),
                ($1::uuid, 'Emergency Two', 'Bay One', $2::uuid)
         RETURNING id, machine_no`, fixture.tenantId, fixture.actor.uid,
      );
      expect(machines).toHaveLength(2);
    });
  });

  afterEach(async () => {
    if (!fixture) return;
    await setTenantTx(fixture.tenantId, async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await tx.$executeRawUnsafe(
        'DELETE FROM dialysis_isolation_emergency_authorizations WHERE tenant_id = $1::uuid',
        fixture.tenantId,
      );
    });
    await fixture.cleanup();
  });
  afterAll(() => prisma.$disconnect());

  async function authorize(overrides = {}) {
    return createIsolationEmergencyAuthorization({
      tenantId: fixture.tenantId, patientUid: fixture.patientUid,
      proposedMachineId: machines[0].id, scheduledFor,
      reason: 'Urgent dialysis with consultant-approved isolation precautions',
      purpose: 'Emergency machine allocation',
      consultantApproval: {
        approved_by: consultant.uid, approved_role: consultant.role,
        approved_at: new Date(Date.now() - 1000).toISOString(),
      },
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      actor: consultant, ...overrides,
    });
  }

  async function schedule(authorization, overrides = {}) {
    return fixture.schedule({
      machine_no: machines[0].machine_no, session_date: scheduledDay, scheduled_start_at: scheduledFor,
      isolation_emergency_authorization_id: authorization.authorization_id, ...overrides,
    });
  }

  async function state(id) {
    const rows = await query(
      `SELECT id::text, bound_session_id, consumed_at, consumed_by::text,
              consultant_approved_by::text, consultant_approved_role, applied_by::text, applied_role
         FROM dialysis_isolation_emergency_authorizations
        WHERE tenant_id = $1::uuid AND id = $2::uuid`, id,
    );
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  async function journals() {
    return {
      reviews: await query('SELECT review_type, finding_code, payload FROM medication_safety_reviews WHERE tenant_id = $1::uuid'),
      audits: await query('SELECT action, metadata FROM audit_logs WHERE tenant_id = $1::uuid ORDER BY id'),
      canonicalAudits: await query(
        'SELECT action, metadata, before_state, after_state FROM clinical_audit_events WHERE tenant_id = $1::uuid ORDER BY id',
      ),
      notifications: await query(
        'SELECT type, recipient_id, payload FROM notification_outbox WHERE tenant_id = $1::uuid ORDER BY id',
      ),
    };
  }

  test('unknownPatientOnEmptyDedicatedGroupRequiresBoundEmergencyAndConsumesExactlyOnce', async () => {
    await expect(fixture.schedule({ machine_no: machines[0].machine_no, scheduled_start_at: scheduledFor }))
      .rejects.toMatchObject({ code: 'DIALYSIS_ISOLATION_MACHINE_BLOCKED' });
    const authorization = await authorize();
    expect(Object.keys(authorization).sort()).toEqual([
      'approved_at', 'approved_by', 'approved_role', 'authorization_id', 'expires_at',
    ]);
    expect(authorization).toMatchObject({ approved_by: consultant.uid, approved_role: 'CONSULTANT' });
    expect(await state(authorization.authorization_id)).toMatchObject({ bound_session_id: null, consumed_at: null });
    const session = await schedule(authorization);
    expect(await state(authorization.authorization_id)).toMatchObject({ bound_session_id: session.id, consumed_at: null });
    await fixture.capture(session.id, { exposure_acknowledgement: { reason: 'Independent unknown-evidence acknowledgement' } });
    const started = await fixture.start(session.id);
    expect(started.status).toBe('in_progress');
    const consumed = await state(authorization.authorization_id);
    expect(consumed).toMatchObject({ bound_session_id: session.id, consumed_by: fixture.actor.uid });
    expect(consumed.consumed_at).toBeInstanceOf(Date);
    await expect(schedule(authorization)).rejects.toMatchObject({ code: 'DIALYSIS_ISOLATION_EMERGENCY_INVALID' });
    expect(await state(authorization.authorization_id)).toEqual(consumed);
    expect(await query('SELECT id FROM dialysis_sessions WHERE tenant_id = $1::uuid')).toHaveLength(1);
    assertMarkerFree(authorization);
    assertMarkerFree(started);
  });

  test('administrativeApplicatorRequiresDistinctCurrentlyAssignedConsultant', async () => {
    const authorization = await authorize({ actor: admin });
    expect(await state(authorization.authorization_id)).toMatchObject({
      consultant_approved_by: consultant.uid, consultant_approved_role: 'CONSULTANT',
      applied_by: admin.uid, applied_role: admin.role,
    });
    await expect(authorize({
      actor: admin,
      consultantApproval: { approved_by: admin.uid, approved_role: 'CONSULTANT', approved_at: new Date().toISOString() },
    })).rejects.toMatchObject({ code: 'DIALYSIS_CONSULTANT_APPROVAL_REQUIRED' });
    await execute("UPDATE users SET role = 'DOCTOR' WHERE tenant_id = $1::uuid AND uid = $2::uuid", consultant.uid);
    await expect(authorize({ actor: admin })).rejects.toMatchObject({ code: 'DIALYSIS_CONSULTANT_APPROVAL_REQUIRED' });
    expect(await query('SELECT id FROM dialysis_isolation_emergency_authorizations WHERE tenant_id = $1::uuid')).toHaveLength(1);
  });

  test('overdueExistingBookingCanReceiveFreshBoundAuthorizationWithoutSecondBooking', async () => {
    scheduledFor = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const bookings = await query(
      `INSERT INTO dialysis_sessions
         (tenant_id, dialysis_patient_id, machine_no, session_date, scheduled_start_at, modality)
       VALUES ($1::uuid, $2::int, $3, $4::timestamptz::date, $4::timestamptz, 'hd') RETURNING id`,
      fixture.patientId, machines[0].machine_no, scheduledFor,
    );
    expect(bookings).toHaveLength(1);
    const session = bookings[0];
    const authorization = await authorize({ sessionId: session.id });
    expect(await state(authorization.authorization_id)).toMatchObject({ bound_session_id: session.id, consumed_at: null });
    await fixture.capture(session.id, { exposure_acknowledgement: { reason: 'Unknown evidence acknowledged independently' } });
    expect((await fixture.start(session.id)).status).toBe('in_progress');
    expect(await state(authorization.authorization_id)).toMatchObject({ consumed_by: fixture.actor.uid });
    expect(await query('SELECT id FROM dialysis_sessions WHERE tenant_id = $1::uuid')).toEqual(bookings);
  });

  test('emergencyNeverSubstitutesForCapturedReadyDialyser', async () => {
    const authorization = await authorize();
    const session = await schedule(authorization);
    await expect(fixture.start(session.id)).rejects.toMatchObject({ code: 'RPD_DIALYSIS_USAGE_REQUIRED' });
    expect(await state(authorization.authorization_id)).toMatchObject({ consumed_at: null });
    const unchanged = await fixture.lifecycle(session.id);
    expect(unchanged.session.status).toBe('scheduled');
    expect(unchanged.usages).toEqual([]);
    expect(unchanged.devices).toEqual([]);
  });

  test('forgedActorRoleAndInactiveConsultantCannotAuthorizeEmergency', async () => {
    await expect(authorize({ actor: fixture.actor }))
      .rejects.toMatchObject({ code: 'DIALYSIS_ISOLATION_EMERGENCY_FORBIDDEN' });
    await expect(authorize({
      actor: { ...fixture.actor, role: 'CONSULTANT' },
      consultantApproval: {
        approved_by: fixture.actor.uid, approved_role: 'CONSULTANT', approved_at: new Date(Date.now() - 1000).toISOString(),
      },
    }))
      .rejects.toMatchObject({ code: 'DIALYSIS_ISOLATION_EMERGENCY_FORBIDDEN' });
    await execute('UPDATE users SET is_active = FALSE WHERE tenant_id = $1::uuid AND uid = $2::uuid', consultant.uid);
    await expect(authorize({ actor: admin })).rejects.toMatchObject({ code: 'DIALYSIS_CONSULTANT_APPROVAL_REQUIRED' });
    expect(await query('SELECT id FROM dialysis_isolation_emergency_authorizations WHERE tenant_id = $1::uuid')).toHaveLength(0);
  });

  test('emergencyExpiryCannotBePastOrExceedFourHours', async () => {
    const expiries = [new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString()];
    expect(expiries).toHaveLength(2);
    for (const expiresAt of expiries) {
      await expect(authorize({ expiresAt })).rejects.toMatchObject({ code: 'DIALYSIS_ISOLATION_EMERGENCY_INVALID' });
    }
    expect(await query('SELECT id FROM dialysis_isolation_emergency_authorizations WHERE tenant_id = $1::uuid')).toHaveLength(0);
  });

  test.each(['missing', 'missing_approver', 'wrong_role', 'invalid_date', 'future_date'])(
    '%s consultant approval cannot authorize emergency', async (condition) => {
      const approval = {
        approved_by: consultant.uid, approved_role: 'CONSULTANT',
        approved_at: new Date(Date.now() - 1000).toISOString(),
      };
      if (condition === 'missing_approver') approval.approved_by = null;
      if (condition === 'wrong_role') approval.approved_role = 'ADMIN';
      if (condition === 'invalid_date') approval.approved_at = 'not-a-date';
      if (condition === 'future_date') approval.approved_at = new Date(Date.now() + 60000).toISOString();
      await expect(authorize({ consultantApproval: condition === 'missing' ? null : approval }))
        .rejects.toMatchObject({ code: 'DIALYSIS_CONSULTANT_APPROVAL_REQUIRED' });
      expect(await query('SELECT id FROM dialysis_isolation_emergency_authorizations WHERE tenant_id = $1::uuid')).toHaveLength(0);
    },
  );

  test('activeConsultantInDifferentTenantCannotApproveLocalEmergency', async () => {
    const otherTenantId = randomUUID();
    const otherConsultantUid = randomUUID();
    await setTenantTx(otherTenantId, async (tx) => {
      await tx.$executeRawUnsafe(
        "INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, 'Emergency wrong-tenant control')",
        otherTenantId, `emergency-authority-${otherTenantId}`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'Emergency wrong-tenant consultant', 'CONSULTANT', TRUE, 'active', NOW())`,
        otherConsultantUid, otherTenantId, otherConsultantUid.replaceAll('-', '').slice(0, 14),
      );
    });
    try {
      await expect(authorize({
        actor: admin,
        consultantApproval: {
          approved_by: otherConsultantUid, approved_role: 'CONSULTANT',
          approved_at: new Date(Date.now() - 1000).toISOString(),
        },
      })).rejects.toMatchObject({ code: 'DIALYSIS_CONSULTANT_APPROVAL_REQUIRED' });
      expect(await query('SELECT id FROM dialysis_isolation_emergency_authorizations WHERE tenant_id = $1::uuid')).toHaveLength(0);
    } finally {
      await setTenantTx(otherTenantId, async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
        await tx.$executeRawUnsafe('DELETE FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid', otherTenantId, otherConsultantUid);
        await tx.$executeRawUnsafe('DELETE FROM tenants WHERE id = $1::uuid', otherTenantId);
      });
    }
  });

  test('preSchedulingBindingRejectsDifferentMachineAndTimeWithoutOrphanBooking', async () => {
    const authorization = await authorize();
    await expect(schedule(authorization, { machine_no: machines[1].machine_no }))
      .rejects.toMatchObject({ code: 'DIALYSIS_ISOLATION_EMERGENCY_INVALID' });
    await expect(schedule(authorization, { scheduled_start_at: new Date(Date.parse(scheduledFor) + 60000).toISOString() }))
      .rejects.toMatchObject({ code: 'DIALYSIS_ISOLATION_EMERGENCY_INVALID' });
    expect(await query('SELECT id FROM dialysis_sessions WHERE tenant_id = $1::uuid')).toHaveLength(0);
    expect(await state(authorization.authorization_id)).toMatchObject({ bound_session_id: null, consumed_at: null });
    const session = await schedule(authorization);
    expect(await state(authorization.authorization_id)).toMatchObject({ bound_session_id: session.id, consumed_at: null });
  });

  const changedBindings = ['evidence', 'machine', 'settings', 'policy', 'isolation_revision', 'protocol', 'scheduled_time'];
  test('emergencyChangedBindingMatrixPopulationIsPinned', () => {
    expect(changedBindings).toEqual(['evidence', 'machine', 'settings', 'policy', 'isolation_revision', 'protocol', 'scheduled_time']);
    expect(changedBindings).toHaveLength(7);
  });
  test.each(changedBindings)('changed %s binding refuses start and preserves unconsumed authorization', async (binding) => {
    const authorization = await authorize();
    const session = await schedule(authorization);
    await fixture.capture(session.id, { exposure_acknowledgement: { reason: 'Unknown evidence acknowledged independently' } });
    if (binding === 'evidence') {
      await execute(
        `INSERT INTO patient_bloodborne_markers (tenant_id, patient_uid, marker, result, tested_on, source, recorded_by)
         VALUES ($1::uuid, $2::uuid, 'hbsag', 'non_reactive', $3::date, 'clinical_declaration', $4::uuid)`,
        fixture.patientUid, fixture.today, fixture.infectionControlActor.uid,
      );
    } else if (binding === 'machine') {
      await execute('UPDATE dialysis_machines SET updated_at = clock_timestamp() WHERE tenant_id = $1::uuid AND id = $2::int', machines[0].id);
    } else if (binding === 'settings') {
      await execute("UPDATE reprocessing_domain_settings SET updated_at = clock_timestamp() WHERE tenant_id = $1::uuid AND domain = 'dialysis'");
    } else if (binding === 'policy') {
      await execute("UPDATE reprocessing_domain_policies SET updated_at = clock_timestamp() WHERE tenant_id = $1::uuid AND domain = 'dialysis'");
    } else if (binding === 'isolation_revision') {
      await setTenantTx(fixture.tenantId, async (tx) => {
        const revision = await insertRevision(tx, 2);
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
        await tx.$executeRawUnsafe(
          "UPDATE reprocessing_domain_settings SET isolation_revision_id = $2::bigint WHERE tenant_id = $1::uuid AND domain = 'dialysis'",
          fixture.tenantId, revision.id,
        );
      });
    } else if (binding === 'protocol') {
      await setTenantTx(fixture.tenantId, async (tx) => {
        const protocol = await createProtocolRevisionTx(tx, {
          tenantId: fixture.tenantId,
          input: { ...fixture.protocol, protocol_key: randomUUID(), name: 'Emergency revised protocol' },
        });
        await createProtocolDeviceScopeTx(tx, {
          tenantId: fixture.tenantId, protocolId: protocol.id, input: fixture.scope,
        });
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
        await tx.$executeRawUnsafe(
          "UPDATE reprocessing_domain_policies SET protocol_id = $2::int WHERE tenant_id = $1::uuid AND domain = 'dialysis'",
          fixture.tenantId, protocol.id,
        );
      });
    } else {
      await execute(
        "UPDATE dialysis_sessions SET scheduled_start_at = scheduled_start_at + INTERVAL '1 minute' WHERE tenant_id = $1::uuid AND id = $2::int", session.id,
      );
    }
    const before = await fixture.lifecycle(session.id);
    await expect(setTenantTx(fixture.tenantId, (tx) => validateIsolationEmergencyTx(tx, {
      tenantId: fixture.tenantId, authorizationId: authorization.authorization_id,
      patientUid: fixture.patientUid, machineId: machines[0].id,
      sessionId: session.id, codes: ['DIALYSIS_UNKNOWN_ON_DEDICATED_GROUP'],
    }))).rejects.toMatchObject({ code: 'DIALYSIS_ISOLATION_EMERGENCY_INVALID' });
    await expect(fixture.start(session.id)).rejects.toMatchObject({
      code: binding === 'protocol' ? 'RPD_REUSE_NOT_ELIGIBLE' : 'DIALYSIS_ISOLATION_EMERGENCY_INVALID',
    });
    expect(await state(authorization.authorization_id)).toMatchObject({ bound_session_id: session.id, consumed_at: null });
    expect(await fixture.lifecycle(session.id)).toEqual(before);
  });

  test('expiredAfterSchedulingAuthorizationNeverStartsUse', async () => {
    const authorization = await authorize();
    const session = await schedule(authorization);
    await fixture.capture(session.id, { exposure_acknowledgement: { reason: 'Unknown evidence acknowledged independently' } });
    await setTenantTx(fixture.tenantId, async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await tx.$executeRawUnsafe(
        `UPDATE dialysis_isolation_emergency_authorizations
            SET consultant_approved_at = NOW() - INTERVAL '2 hours',
                created_at = NOW() - INTERVAL '2 hours', expires_at = NOW() - INTERVAL '1 hour'
          WHERE tenant_id = $1::uuid AND id = $2::uuid`, fixture.tenantId, authorization.authorization_id,
      );
    });
    await expect(fixture.start(session.id)).rejects.toMatchObject({ code: 'DIALYSIS_ISOLATION_EMERGENCY_INVALID' });
    expect(await state(authorization.authorization_id)).toMatchObject({ consumed_at: null });
    expect((await fixture.lifecycle(session.id)).session.status).toBe('scheduled');
  });

  test('emergencyCannotBypassDeviceHoldAndFailedAdmissionDoesNotConsumeIt', async () => {
    const authorization = await authorize();
    const session = await schedule(authorization);
    const captured = await fixture.capture(session.id, { exposure_acknowledgement: { reason: 'Unknown evidence acknowledged independently' } });
    await setTenantTx(fixture.tenantId, (tx) => placeHoldTx(tx, {
      tenantId: fixture.tenantId, deviceId: captured.device.id,
      holdType: 'inspection_failed', reasonCode: 'return_condition_damaged', placedVia: 'manual',
      placedBy: fixture.infectionControlActor.uid,
      expectedVersion: captured.device.version,
    }));
    await expect(fixture.start(session.id)).rejects.toMatchObject({ code: 'RPD_HOLD_ACTIVE' });
    expect(await state(authorization.authorization_id)).toMatchObject({ consumed_at: null });
    expect((await fixture.lifecycle(session.id)).session.status).toBe('scheduled');
  });

  test('consultantRoleRevokedAfterAuthorizationPreventsStartWithoutConsumption', async () => {
    const authorization = await authorize();
    const session = await schedule(authorization);
    await fixture.capture(session.id, { exposure_acknowledgement: { reason: 'Unknown evidence acknowledged independently' } });
    const before = await fixture.lifecycle(session.id);
    await execute("UPDATE users SET role = 'DOCTOR' WHERE tenant_id = $1::uuid AND uid = $2::uuid", consultant.uid);
    await expect(fixture.start(session.id)).rejects.toMatchObject({ code: 'DIALYSIS_ISOLATION_EMERGENCY_INVALID' });
    expect(await state(authorization.authorization_id)).toMatchObject({ consumed_at: null });
    expect(await fixture.lifecycle(session.id)).toEqual(before);
  });

  test('selectedRetiredMachineRefusesEmergencyDespiteAnotherActiveMachineInGroup', async () => {
    await execute("UPDATE dialysis_machines SET status = 'retired' WHERE tenant_id = $1::uuid AND id = $2::int", machines[0].id);
    await expect(authorize()).rejects.toMatchObject({ code: 'DIALYSIS_MACHINE_INACTIVE' });
    expect(await query("SELECT id FROM dialysis_machines WHERE tenant_id = $1::uuid AND status = 'active'")).toHaveLength(1);
    expect(await query('SELECT id FROM dialysis_isolation_emergency_authorizations WHERE tenant_id = $1::uuid')).toHaveLength(0);
  });

  test('concurrentStartsConsumeOnlyOnceAndEmitOneConsumptionJournal', async () => {
    const authorization = await authorize();
    const session = await schedule(authorization);
    await fixture.capture(session.id, { exposure_acknowledgement: { reason: 'Unknown evidence acknowledged independently' } });
    const attempts = await Promise.allSettled([fixture.start(session.id), fixture.start(session.id)]);
    expect(attempts).toHaveLength(2);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const failures = attempts.filter((attempt) => attempt.status === 'rejected');
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    expect(await state(authorization.authorization_id)).toMatchObject({ consumed_by: fixture.actor.uid });
    const consumption = await query(
      `SELECT metadata FROM audit_logs WHERE tenant_id = $1::uuid
         AND action = 'dialysis.session.isolation_emergency_override' AND metadata->>'phase' = 'consumed'`,
    );
    expect(consumption).toHaveLength(1);
    expect(consumption[0].metadata.authorization_id).toBe(authorization.authorization_id);
  });

  test('explicitValidatedAuthorizationIsConsumedInsteadOfNewerInvalidBoundAuthorization', async () => {
    const authorization = await authorize();
    const session = await schedule(authorization);
    const secondConsultant = { uid: randomUUID(), role: 'CONSULTANT' };
    await execute(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES ($2::uuid, $1::uuid, $3, 'Second emergency consultant', 'CONSULTANT', TRUE, 'active', NOW())`,
      secondConsultant.uid, secondConsultant.uid.replaceAll('-', '').slice(0, 14),
    );
    const newer = await authorize({
      sessionId: session.id, actor: secondConsultant,
      consultantApproval: {
        approved_by: secondConsultant.uid, approved_role: secondConsultant.role,
        approved_at: new Date(Date.now() - 1000).toISOString(),
      },
    });
    expect(await state(authorization.authorization_id)).toMatchObject({ bound_session_id: session.id, consumed_at: null });
    expect(await state(newer.authorization_id)).toMatchObject({ bound_session_id: session.id, consumed_at: null });
    await execute("UPDATE users SET role = 'DOCTOR' WHERE tenant_id = $1::uuid AND uid = $2::uuid", secondConsultant.uid);
    await fixture.capture(session.id, { exposure_acknowledgement: { reason: 'Unknown evidence acknowledged independently' } });
    expect((await fixture.start(session.id, { isolation_emergency_authorization_id: authorization.authorization_id })).status)
      .toBe('in_progress');
    expect(await state(authorization.authorization_id)).toMatchObject({ consumed_by: fixture.actor.uid });
    expect(await state(newer.authorization_id)).toMatchObject({ consumed_at: null, consumed_by: null });
    const consumption = await query(
      `SELECT metadata FROM audit_logs WHERE tenant_id = $1::uuid
         AND action = 'dialysis.session.isolation_emergency_override' AND metadata->>'phase' = 'consumed'`,
    );
    expect(consumption).toHaveLength(1);
    expect(consumption[0].metadata.authorization_id).toBe(authorization.authorization_id);
  });

  test('noActiveLocalInfectionControlRecipientRefusesWithoutStaleOrForeignFallback', async () => {
    await execute('UPDATE users SET is_active = FALSE WHERE tenant_id = $1::uuid AND uid = $2::uuid', fixture.infectionControlActor.uid);
    const otherTenantId = randomUUID();
    const otherOfficerUid = randomUUID();
    await setTenantTx(otherTenantId, async (tx) => {
      await tx.$executeRawUnsafe(
        "INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, 'Foreign notification control')",
        otherTenantId, `emergency-recipient-${otherTenantId}`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'Foreign infection-control officer', 'INFECTION_CONTROL_OFFICER', TRUE, 'active', NOW())`,
        otherOfficerUid, otherTenantId, otherOfficerUid.replaceAll('-', '').slice(0, 14),
      );
    });
    try {
      await expect(authorize()).rejects.toMatchObject({ code: 'DIALYSIS_INFECTION_CONTROL_RECIPIENT_REQUIRED' });
      expect(await query('SELECT id FROM dialysis_isolation_emergency_authorizations WHERE tenant_id = $1::uuid')).toHaveLength(0);
      expect(await journals()).toEqual({ reviews: [], audits: [], canonicalAudits: [], notifications: [] });
      await execute('UPDATE users SET is_active = TRUE WHERE tenant_id = $1::uuid AND uid = $2::uuid', fixture.infectionControlActor.uid);
      const authorization = await authorize();
      expect(await state(authorization.authorization_id)).toMatchObject({ consumed_at: null });
      const recipient = await query('SELECT id FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid', fixture.infectionControlActor.uid);
      const notifications = (await journals()).notifications;
      expect(recipient).toHaveLength(1);
      expect(notifications).toHaveLength(1);
      expect(String(notifications[0].recipient_id)).toBe(String(recipient[0].id));
    } finally {
      await setTenantTx(otherTenantId, async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
        await tx.$executeRawUnsafe('DELETE FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid', otherTenantId, otherOfficerUid);
        await tx.$executeRawUnsafe('DELETE FROM tenants WHERE id = $1::uuid', otherTenantId);
      });
    }
  });

  test('strictInfectionControlNotificationFailureRollsBackAuthorizationAndAllJournals', async () => {
    const failure = new Error('Emergency notification fixture refusal');
    const queue = jest.spyOn(notificationOutbox, 'queue').mockRejectedValueOnce(failure);
    try {
      await expect(authorize()).rejects.toBe(failure);
      expect(queue).toHaveBeenCalledTimes(1);
      expect(Object.keys(queue.mock.calls[0][1]).sort()).toEqual(['strict', 'tx']);
      expect(queue.mock.calls[0][1].strict).toBe(true);
      expect(queue.mock.calls[0][1].tx.$queryRawUnsafe).toEqual(expect.any(Function));
    } finally {
      queue.mockRestore();
    }
    expect(await query('SELECT id FROM dialysis_isolation_emergency_authorizations WHERE tenant_id = $1::uuid')).toHaveLength(0);
    expect(await journals()).toEqual({ reviews: [], audits: [], canonicalAudits: [], notifications: [] });
    expect(await query('SELECT id FROM clinical_timeline_events WHERE tenant_id = $1::uuid')).toHaveLength(0);
    expect(await query('SELECT id FROM clinical_audit_events WHERE tenant_id = $1::uuid')).toHaveLength(0);
    const authorization = await authorize();
    expect(await state(authorization.authorization_id)).toMatchObject({ bound_session_id: null, consumed_at: null });
    const control = await journals();
    expect(control.reviews).toHaveLength(1);
    expect(control.audits).toHaveLength(1);
    expect(control.canonicalAudits).toHaveLength(1);
    expect(control.notifications).toHaveLength(1);
  });

  test('consumptionNotificationFailureRollsBackActualUseAndPreservesBoundAuthorization', async () => {
    const authorization = await authorize();
    const session = await schedule(authorization);
    await fixture.capture(session.id, { exposure_acknowledgement: { reason: 'Unknown evidence acknowledged independently' } });
    const before = await fixture.lifecycle(session.id);
    const originalJournals = await journals();
    const failure = new Error('Emergency consumption notification fixture refusal');
    const queue = jest.spyOn(notificationOutbox, 'queue').mockRejectedValueOnce(failure);
    try {
      await expect(fixture.start(session.id)).rejects.toBe(failure);
      expect(queue).toHaveBeenCalledTimes(1);
      expect(queue.mock.calls[0][1].strict).toBe(true);
    } finally {
      queue.mockRestore();
    }
    expect(await fixture.lifecycle(session.id)).toEqual(before);
    expect(await state(authorization.authorization_id)).toMatchObject({ bound_session_id: session.id, consumed_at: null });
    expect(await journals()).toEqual(originalJournals);
    expect((await fixture.start(session.id)).status).toBe('in_progress');
    expect(await state(authorization.authorization_id)).toMatchObject({ consumed_by: fixture.actor.uid });
    expect((await journals()).reviews.filter((row) => row.finding_code === 'ISOLATION_EMERGENCY_OVERRIDE')).toHaveLength(2);
  });

  test('missingDurableNotificationReceiptRefusesAndRollsBackAuthorization', async () => {
    const queue = jest.spyOn(notificationOutbox, 'queue').mockResolvedValueOnce(null);
    try {
      await expect(authorize()).rejects.toMatchObject({ code: 'DIALYSIS_INFECTION_CONTROL_NOTIFICATION_REQUIRED' });
      expect(queue).toHaveBeenCalledTimes(1);
      expect(queue.mock.calls[0][1].strict).toBe(true);
    } finally {
      queue.mockRestore();
    }
    expect(await query('SELECT id FROM dialysis_isolation_emergency_authorizations WHERE tenant_id = $1::uuid')).toHaveLength(0);
    expect(await journals()).toEqual({ reviews: [], audits: [], canonicalAudits: [], notifications: [] });
    expect(await query('SELECT id FROM clinical_timeline_events WHERE tenant_id = $1::uuid')).toHaveLength(0);
    const authorization = await authorize();
    expect(await state(authorization.authorization_id)).toMatchObject({ consumed_at: null });
    expect((await journals()).notifications).toHaveLength(1);
  });

  test('emergencyCannotDeclareUnknownPatientCompatibleWithOccupiedDedicatedCohort', async () => {
    const otherUid = randomUUID();
    await setTenantTx(fixture.tenantId, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO users (uid, tenant_id, phone, name, role, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'Emergency cohort positive control', 'PATIENT', NOW())`,
        otherUid, fixture.tenantId, otherUid.replaceAll('-', '').slice(0, 14),
      );
      const [patient] = await tx.$queryRawUnsafe(
        "INSERT INTO dialysis_patients (tenant_id, patient_uid, modality) VALUES ($1::uuid, $2::uuid, 'hd') RETURNING id",
        fixture.tenantId, otherUid,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO patient_bloodborne_markers (tenant_id, patient_uid, marker, result, tested_on, source, recorded_by)
         VALUES ($1::uuid, $2::uuid, 'hbsag', 'reactive', $3::date, 'clinical_declaration', $4::uuid)`,
        fixture.tenantId, otherUid, fixture.today, fixture.infectionControlActor.uid,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO dialysis_sessions (tenant_id, dialysis_patient_id, machine_no, session_date, modality)
         VALUES ($1::uuid, $2::int, $3, $4::date, 'hd')`,
        fixture.tenantId, patient.id, machines[1].machine_no, scheduledDay,
      );
    });
    const authorization = await authorize();
    await expect(schedule(authorization)).rejects.toMatchObject({ code: 'DIALYSIS_COHORT_INCOMPATIBLE' });
    expect(await state(authorization.authorization_id)).toMatchObject({ bound_session_id: null, consumed_at: null });
    expect(await query('SELECT id FROM dialysis_sessions WHERE tenant_id = $1::uuid')).toHaveLength(1);
  });

  test('privateFingerprintByValueCanaryNeverReachesMedicationReaderAuditOrSessionResponses', async () => {
    const authorization = await authorize();
    const originalRows = await query(
      'SELECT decision_fingerprint FROM dialysis_isolation_emergency_authorizations WHERE tenant_id = $1::uuid',
    );
    expect(originalRows).toHaveLength(1);
    const originalFingerprint = originalRows[0].decision_fingerprint;
    expect(originalFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(originalFingerprint).not.toBe(FINGERPRINT_CANARY);
    const session = await schedule(authorization);
    await fixture.capture(session.id, { exposure_acknowledgement: { reason: 'Unknown evidence acknowledged independently' } });
    const started = await fixture.start(session.id);
    await setTenantTx(fixture.tenantId, async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await tx.$executeRawUnsafe(
        `UPDATE dialysis_isolation_emergency_authorizations SET decision_fingerprint = $2
          WHERE tenant_id = $1::uuid AND id = $3::uuid`, fixture.tenantId, FINGERPRINT_CANARY, authorization.authorization_id,
      );
    });
    const privateRows = await query(
      'SELECT decision_fingerprint FROM dialysis_isolation_emergency_authorizations WHERE tenant_id = $1::uuid',
    );
    expect(privateRows).toEqual([{ decision_fingerprint: FINGERPRINT_CANARY }]);
    const medicationReader = await listMedicationSafetyReviews({ tenantId: fixture.tenantId, patientUid: fixture.patientUid });
    const evidence = await journals();
    const responses = [
      authorization, session, started, medicationReader,
      await listSessions({ tenantId: fixture.tenantId }), await todayBoard({ tenantId: fixture.tenantId }),
    ];
    expect(responses).toHaveLength(6);
    expect(medicationReader.reviews.length).toBeGreaterThan(0);
    const emergencyReviews = evidence.reviews.filter((row) => row.finding_code === 'ISOLATION_EMERGENCY_OVERRIDE');
    const emergencyAudits = evidence.audits.filter((row) => row.action === 'dialysis.session.isolation_emergency_override');
    const emergencyCanonicalAudits = evidence.canonicalAudits.filter((row) => row.action === 'dialysis.session.isolation_emergency_override');
    const emergencyNotifications = evidence.notifications.filter((row) => row.type === 'dialysis_isolation_emergency');
    expect(emergencyReviews).toHaveLength(2);
    expect(emergencyReviews.map((row) => row.review_type))
      .toEqual(['reprocessable_device_reuse', 'reprocessable_device_reuse']);
    expect(emergencyReviews.map((row) => row.payload.domain)).toEqual(['dialysis', 'dialysis']);
    expect(emergencyAudits).toHaveLength(2);
    expect(emergencyCanonicalAudits).toHaveLength(2);
    expect(emergencyNotifications).toHaveLength(2);
    expect(emergencyReviews.map((row) => row.payload.phase).sort()).toEqual(['authorized', 'consumed']);
    expect(emergencyAudits.map((row) => row.metadata.phase).sort()).toEqual(['authorized', 'consumed']);
    const officers = await query(
      'SELECT id FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid', fixture.infectionControlActor.uid,
    );
    expect(officers).toHaveLength(1);
    expect(emergencyNotifications.map((row) => String(row.recipient_id)))
      .toEqual([String(officers[0].id), String(officers[0].id)]);
    const timeline = await query(
      `SELECT visible_to_patient FROM clinical_timeline_events WHERE tenant_id = $1::uuid
         AND event_type = 'dialysis.session.isolation_emergency_override'`,
    );
    expect(timeline).toEqual([{ visible_to_patient: false }, { visible_to_patient: false }]);
    const serialize = (value) => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? String(entry) : entry);
    for (const value of [...responses, evidence.audits, evidence.canonicalAudits, evidence.reviews, evidence.notifications]) {
      expect(serialize(value)).not.toContain(FINGERPRINT_CANARY);
      expect(serialize(value)).not.toContain(originalFingerprint);
      expect(serialize(value)).not.toContain('decision_fingerprint');
    }
    assertMarkerFree(evidence.audits);
    assertMarkerFree(evidence.canonicalAudits);
    assertMarkerFree(evidence.notifications);
  });
});
