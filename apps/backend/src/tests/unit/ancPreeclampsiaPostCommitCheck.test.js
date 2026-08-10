// BE-H2 (review 2026-08-09) — unit regression for the hardened post-commit
// ANC pre-eclampsia check in maternityService.
//
// The old block swallowed EVERY failure to a logger.warn and returned
// alerts: [] — a 142/92 ANC visit whose screen never ran read exactly like a
// clean no-alert visit. runAncPreeclampsiaPostCommitCheck must now:
//   * Phase A (id resolution) failure -> the check COULD NOT RUN: durable
//     notification_outbox broadcast alert + clinical_audit_events 'failed'
//     row (action anc_preeclampsia_check_failed), return checkFailed: true
//     so the caller surfaces alerts_check_failed instead of a fake clean
//     result — the committed visit and the 200 stand;
//   * Phase B (checkVitalAnomalies throw) -> a detected anomaly's alert
//     could not be PERSISTED: audit-trail row (action
//     anc_preeclampsia_alert_persist_failed) then THROW
//     CLINICAL_ALERT_PERSIST_FAILED, mirroring the hardened main vitals path
//     (vitalsChartService.recordVitals);
//   * escalation attempts stay independent — outbox failing never skips the
//     audit row.
//
// Pure unit — DB / alert engine / outbox / audit are injected via `deps`.

import { jest } from '@jest/globals';

import { AppError } from '../../utils/AppError.js';
import { runAncPreeclampsiaPostCommitCheck } from '../../services/maternity/maternityService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const RECORDER_UID = '22222222-2222-4222-8222-222222222222';

// Post-commit-policy stand-in (the real safeCanonical swallows + logs).
const swallowingSafeCanonical = async (label, task) => {
  try {
    return await task();
  } catch {
    return null;
  }
};

const RECIPIENTS = [
  { id: 71, uid: '33333333-3333-4333-8333-333333333333', phone: '+911234567890', role: 'DUTY_DOCTOR' },
  { id: 72, uid: '44444444-4444-4444-8444-444444444444', phone: null, role: 'SENIOR_DOCTOR' },
];

function makeDeps({ dbImpl, checkImpl, queueImpl, auditImpl, resolveImpl } = {}) {
  return {
    db: {
      $queryRawUnsafe: jest.fn(dbImpl || (async (sql) => {
        if (/JOIN users/i.test(sql)) return [{ id: 77 }];
        return [{ id: 88 }];
      })),
    },
    checkVitalAnomalies: jest.fn(checkImpl || (async () => [{ severity: 'CRITICAL', vital_name: 'systolic_bp' }])),
    notificationOutbox: { queue: jest.fn(queueImpl || (async () => ({ id: 5, status: 'PENDING' }))) },
    resolveClinicalAlertRecipients: jest.fn(resolveImpl || (async () => RECIPIENTS)),
    recordClinicalAuditEvent: jest.fn(auditImpl || (async (input) => ({ id: 42, ...input }))),
    safeCanonical: swallowingSafeCanonical,
  };
}

const baseInput = {
  tenantId: TENANT,
  pregnancyId: 12,
  patientUid: PATIENT_UID,
  visitId: 345,
  vitalsForCheck: { systolic_bp: 142, diastolic_bp: 92 },
  recordedBy: RECORDER_UID,
};

describe('runAncPreeclampsiaPostCommitCheck (BE-H2)', () => {
  test('clean run returns the engine alerts and checkFailed: false, no escalation', async () => {
    const deps = makeDeps();
    const outcome = await runAncPreeclampsiaPostCommitCheck({ ...baseInput, deps });

    expect(outcome.checkFailed).toBe(false);
    expect(outcome.alerts).toHaveLength(1);
    expect(deps.checkVitalAnomalies).toHaveBeenCalledWith(
      77,
      { systolic_bp: 142, diastolic_bp: 92 },
      { recordedBy: 88, tenantId: TENANT },
    );
    expect(deps.notificationOutbox.queue).not.toHaveBeenCalled();
    expect(deps.recordClinicalAuditEvent).not.toHaveBeenCalled();
  });

  test('Phase A lookup failure -> durable alert + failed audit row + checkFailed: true (no throw)', async () => {
    const deps = makeDeps({
      dbImpl: async () => { throw new Error('connection reset'); },
    });

    const outcome = await runAncPreeclampsiaPostCommitCheck({ ...baseInput, deps });

    expect(outcome).toEqual({ alerts: [], checkFailed: true });
    expect(deps.checkVitalAnomalies).not.toHaveBeenCalled();

    // R2 fan-out: one CONCRETE-recipient outbox row per resolved clinician —
    // never a recipientId:null broadcast row (the outbox has no topic delivery).
    expect(deps.resolveClinicalAlertRecipients).toHaveBeenCalledWith(TENANT);
    expect(deps.notificationOutbox.queue).toHaveBeenCalledTimes(RECIPIENTS.length);
    const [notification, options] = deps.notificationOutbox.queue.mock.calls[0];
    expect(options).toEqual({ strict: true });
    expect(notification).toMatchObject({
      recipientId: RECIPIENTS[0].uid,
      recipientPhone: RECIPIENTS[0].phone,
      tenantId: TENANT,
      channel: 'clinical_alert',
    });
    for (const [queued] of deps.notificationOutbox.queue.mock.calls) {
      expect(queued.recipientId).not.toBeNull();
    }
    expect(notification.data).toMatchObject({
      source_event_key: 'maternity_anc_visits:345:preeclampsia_check_failed:alert',
      anc_visit_id: 345,
      pregnancy_id: 12,
      bp: '142/92',
      recipient_role: 'DUTY_DOCTOR',
    });

    expect(deps.recordClinicalAuditEvent).toHaveBeenCalledTimes(1);
    expect(deps.recordClinicalAuditEvent.mock.calls[0][0]).toMatchObject({
      tenantId: TENANT,
      patientUid: PATIENT_UID,
      action: 'anc_preeclampsia_check_failed',
      actionStatus: 'failed',
      resourceTable: 'maternity_anc_visits',
      resourceId: '345',
      idempotencyKey: 'maternity_anc_visits:345:anc_preeclampsia_check_failed',
    });
  });

  test('an unresolvable patient row is a couldn\'t-run failure, not a silent skip', async () => {
    const deps = makeDeps({
      dbImpl: async () => [], // no patient row
    });

    const outcome = await runAncPreeclampsiaPostCommitCheck({ ...baseInput, deps });

    expect(outcome).toEqual({ alerts: [], checkFailed: true });
    expect(deps.notificationOutbox.queue).toHaveBeenCalledTimes(RECIPIENTS.length);
    expect(deps.recordClinicalAuditEvent).toHaveBeenCalledTimes(1);
  });

  test('Phase A escalation attempts are independent — outbox failure never skips the audit row', async () => {
    const deps = makeDeps({
      dbImpl: async () => { throw new Error('connection reset'); },
      queueImpl: async () => { throw new Error('outbox down'); },
    });

    const outcome = await runAncPreeclampsiaPostCommitCheck({ ...baseInput, deps });

    expect(outcome).toEqual({ alerts: [], checkFailed: true });
    expect(deps.recordClinicalAuditEvent).toHaveBeenCalledTimes(1);
  });

  test('Phase B throw (alert persistence) -> audit row + CLINICAL_ALERT_PERSIST_FAILED (visit stands, response must not claim success)', async () => {
    const deps = makeDeps({
      checkImpl: async () => { throw new Error('insert into clinical_alerts failed'); },
    });

    await expect(runAncPreeclampsiaPostCommitCheck({ ...baseInput, deps }))
      .rejects.toMatchObject({ code: 'CLINICAL_ALERT_PERSIST_FAILED', statusCode: 500 });

    expect(deps.recordClinicalAuditEvent).toHaveBeenCalledTimes(1);
    expect(deps.recordClinicalAuditEvent.mock.calls[0][0]).toMatchObject({
      action: 'anc_preeclampsia_alert_persist_failed',
      actionStatus: 'failed',
      idempotencyKey: 'maternity_anc_visits:345:anc_preeclampsia_alert_persist_failed',
    });
    // No couldn't-run broadcast on this branch — the surfaced error is the signal.
    expect(deps.notificationOutbox.queue).not.toHaveBeenCalled();
  });

  test('Phase B AppError passthrough STILL writes the audit row before rethrowing (SF-4)', async () => {
    // e.g. a fail-closed TENANT_CONTEXT_REQUIRED thrown inside the anomaly
    // path: the original error must surface unchanged, but the durable audit
    // trail must not be skippable.
    const tenantErr = AppError.forbidden('Tenant context required', 'TENANT_CONTEXT_REQUIRED');
    const deps = makeDeps({
      checkImpl: async () => { throw tenantErr; },
    });

    await expect(runAncPreeclampsiaPostCommitCheck({ ...baseInput, deps }))
      .rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED', statusCode: 403 });

    expect(deps.recordClinicalAuditEvent).toHaveBeenCalledTimes(1);
    expect(deps.recordClinicalAuditEvent.mock.calls[0][0]).toMatchObject({
      action: 'anc_preeclampsia_alert_persist_failed',
      actionStatus: 'failed',
      idempotencyKey: 'maternity_anc_visits:345:anc_preeclampsia_alert_persist_failed',
    });
  });
});
