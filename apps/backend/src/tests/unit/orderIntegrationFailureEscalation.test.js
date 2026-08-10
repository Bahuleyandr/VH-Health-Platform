// BE-H1 (review 2026-08-09) — unit regression for the durable escalation of
// post-commit order-integration failures in orderEntryService.
//
// The post-create hooks (MAR scheduling, ward indent, downstream dispatch)
// run after the order transaction committed, so their failures used to leave
// only a log line — a medication order could commit with ZERO scheduled MAR
// doses and no detector. escalateOrderIntegrationFailure must:
//   * queue durable notification_outbox alerts fanned out to CONCRETE
//     duty-doctor recipients (fix R2 2026-08-10 — the outbox has no topic
//     delivery, so the old recipientId:null broadcast reached nobody;
//     deterministic shared source_event_key, per-recipient dedupe) AND
//   * write a clinical_audit_events 'failed' row with the deterministic
//     idempotency key clinical_orders:<id>:<stage>_failed,
//   * attempt the two INDEPENDENTLY (one failing never skips the other),
//   * never throw (the committed order must stand).
//
// Pure unit — all side-effect channels are injected via the `deps` seam
// (precedent: buildMarEntryFromOrderDetails is exported for the same reason).

import { jest } from '@jest/globals';

import { escalateOrderIntegrationFailure } from '../../services/emr/orderEntryService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';

function makeOrder(overrides = {}) {
  return {
    id: 4711,
    order_number: 'ORD-20260809-0001',
    order_type: 'medication',
    priority: 'routine',
    patient_uid: '11111111-1111-4111-8111-111111111111',
    encounter_id: null,
    ordered_by: '22222222-2222-4222-8222-222222222222',
    tenant_id: TENANT,
    ...overrides,
  };
}

// Post-commit-policy stand-in: run the task, swallow failures (the real
// safeCanonical logs 42P01 at warn / other faults at error and returns null).
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

function makeDeps({ queueImpl, auditImpl, resolveImpl } = {}) {
  return {
    notificationOutbox: { queue: jest.fn(queueImpl || (async () => ({ id: 1, status: 'PENDING' }))) },
    resolveClinicalAlertRecipients: jest.fn(resolveImpl || (async () => RECIPIENTS)),
    recordClinicalAuditEvent: jest.fn(auditImpl || (async (input) => ({ id: 99, ...input }))),
    safeCanonical: swallowingSafeCanonical,
  };
}

describe('escalateOrderIntegrationFailure (BE-H1)', () => {
  test('MAR failure queues the outbox alert AND writes the failed audit row', async () => {
    const order = makeOrder();
    const err = Object.assign(new Error('duration_days 400 exceeds the window'), {
      code: 'MAR_DURATION_EXCEEDS_WINDOW',
    });
    const deps = makeDeps();

    const result = await escalateOrderIntegrationFailure({ order, stage: 'mar_schedule', err, deps });

    expect(result).toEqual({ alertQueued: true, auditRecorded: true });

    // R2 fan-out: one CONCRETE-recipient outbox row per resolved clinician —
    // never a recipientId:null broadcast row (the outbox has no topic delivery).
    expect(deps.resolveClinicalAlertRecipients).toHaveBeenCalledWith(TENANT);
    expect(deps.notificationOutbox.queue).toHaveBeenCalledTimes(RECIPIENTS.length);
    const [notification, queueOptions] = deps.notificationOutbox.queue.mock.calls[0];
    expect(queueOptions).toEqual({ strict: true });
    expect(notification).toMatchObject({
      type: 'push',
      recipientId: RECIPIENTS[0].id,
      recipientPhone: RECIPIENTS[0].phone,
      tenantId: TENANT,
      channel: 'clinical_alert',
    });
    expect(deps.notificationOutbox.queue.mock.calls[1][0]).toMatchObject({
      recipientId: RECIPIENTS[1].id,
    });
    for (const [queued] of deps.notificationOutbox.queue.mock.calls) {
      expect(queued.recipientId).not.toBeNull();
    }
    expect(notification.data).toMatchObject({
      source_event_key: 'clinical_orders:4711:mar_schedule_failed:alert',
      order_id: 4711,
      order_number: 'ORD-20260809-0001',
      failure_stage: 'mar_schedule',
      error_code: 'MAR_DURATION_EXCEEDS_WINDOW',
      recipient_role: 'DUTY_DOCTOR',
    });
    expect(notification.title).toMatch(/no scheduled mar doses/i);

    expect(deps.recordClinicalAuditEvent).toHaveBeenCalledTimes(1);
    const [auditInput] = deps.recordClinicalAuditEvent.mock.calls[0];
    expect(auditInput).toMatchObject({
      tenantId: TENANT,
      patientUid: order.patient_uid,
      action: 'mar_scheduling_failed',
      actionStatus: 'failed',
      resourceTable: 'clinical_orders',
      resourceId: '4711',
      idempotencyKey: 'clinical_orders:4711:mar_schedule_failed',
    });
    expect(auditInput.metadata).toMatchObject({
      failure_stage: 'mar_schedule',
      error_code: 'MAR_DURATION_EXCEEDS_WINDOW',
    });
  });

  test.each([
    ['ward_indent', 'ward_indent_creation_failed', 'clinical_orders:4711:ward_indent_failed'],
    ['integration_dispatch', 'order_integration_dispatch_failed', 'clinical_orders:4711:integration_dispatch_failed'],
  ])('%s failure escalates with its own action + deterministic key', async (stage, action, auditKey) => {
    const deps = makeDeps();
    const result = await escalateOrderIntegrationFailure({
      order: makeOrder(),
      stage,
      err: new Error('boom'),
      deps,
    });

    expect(result).toEqual({ alertQueued: true, auditRecorded: true });
    expect(deps.notificationOutbox.queue.mock.calls[0][0].data.source_event_key)
      .toBe(`${auditKey}:alert`);
    expect(deps.recordClinicalAuditEvent.mock.calls[0][0]).toMatchObject({
      action,
      idempotencyKey: auditKey,
    });
  });

  test('zero resolvable recipients is a queue failure (alertQueued false), audit still records', async () => {
    const deps = makeDeps({ resolveImpl: async () => [] });

    const result = await escalateOrderIntegrationFailure({
      order: makeOrder(),
      stage: 'mar_schedule',
      err: new Error('boom'),
      deps,
    });

    expect(result).toEqual({ alertQueued: false, auditRecorded: true });
    expect(deps.notificationOutbox.queue).not.toHaveBeenCalled();
    expect(deps.recordClinicalAuditEvent.mock.calls[0][0].metadata.alert_queued).toBe(false);
  });

  test('an outbox failure does NOT skip the audit row (independent attempts, no throw)', async () => {
    const deps = makeDeps({
      queueImpl: async () => { throw new Error('outbox down'); },
    });

    const result = await escalateOrderIntegrationFailure({
      order: makeOrder(),
      stage: 'mar_schedule',
      err: new Error('boom'),
      deps,
    });

    expect(result).toEqual({ alertQueued: false, auditRecorded: true });
    expect(deps.recordClinicalAuditEvent).toHaveBeenCalledTimes(1);
    // alert_queued: false is carried into the audit metadata for triage.
    expect(deps.recordClinicalAuditEvent.mock.calls[0][0].metadata.alert_queued).toBe(false);
  });

  test('an audit failure does NOT undo the queued alert, and the helper never throws', async () => {
    const deps = makeDeps({
      auditImpl: async () => { throw new Error('audit table fault'); },
    });

    const result = await escalateOrderIntegrationFailure({
      order: makeOrder(),
      stage: 'mar_schedule',
      err: new Error('boom'),
      deps,
    });

    expect(result).toEqual({ alertQueued: true, auditRecorded: false });
    expect(deps.notificationOutbox.queue).toHaveBeenCalledTimes(1);
  });

  test('both channels failing still resolves (logger.error last resort), never throws', async () => {
    const deps = makeDeps({
      queueImpl: async () => { throw new Error('outbox down'); },
      auditImpl: async () => { throw new Error('audit down'); },
    });

    await expect(escalateOrderIntegrationFailure({
      order: makeOrder(),
      stage: 'mar_schedule',
      err: new Error('boom'),
      deps,
    })).resolves.toEqual({ alertQueued: false, auditRecorded: false });
  });

  test('missing order or unknown stage is a safe no-op', async () => {
    const deps = makeDeps();
    await expect(escalateOrderIntegrationFailure({ order: null, stage: 'mar_schedule', err: new Error('x'), deps }))
      .resolves.toEqual({ alertQueued: false, auditRecorded: false });
    await expect(escalateOrderIntegrationFailure({ order: makeOrder(), stage: 'nope', err: new Error('x'), deps }))
      .resolves.toEqual({ alertQueued: false, auditRecorded: false });
    expect(deps.notificationOutbox.queue).not.toHaveBeenCalled();
    expect(deps.recordClinicalAuditEvent).not.toHaveBeenCalled();
  });
});
