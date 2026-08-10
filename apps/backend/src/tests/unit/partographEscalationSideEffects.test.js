// BE-M2 (review 2026-08-09) — unit regression for the partograph escalation
// fan-out in maternityService.
//
// on_action_line is the WHO trigger for emergency intervention in obstructed
// labour and fetal decelerations are a fetal-distress signal — previously
// both were stored on the partograph row and consumed by NOTHING. The
// post-commit fan-out must write a CRITICAL clinical_alerts row (the same
// staff review queue the vitals anomaly engine feeds) and queue a durable
// notification_outbox care-team alert, independently guarded and never
// throwing (the committed partograph entry is the clinical evidence and must
// stand; the canonical escalation pair is already atomic with the entry).
//
// Pure unit — tenant tx / outbox are injected via `deps`.

import { jest } from '@jest/globals';

import { raisePartographEscalationSideEffects } from '../../services/maternity/maternityService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const OBSTETRICIAN_UID = '33333333-3333-4333-8333-333333333333';

const DUTY_RECIPIENTS = [
  { id: 71, uid: '55555555-5555-4555-8555-555555555555', phone: '+911234567890', role: 'DUTY_DOCTOR' },
  { id: 72, uid: '66666666-6666-4666-8666-666666666666', phone: null, role: 'SENIOR_DOCTOR' },
];

function makeDeps({ txImpl, queueImpl, resolveImpl } = {}) {
  const tx = {
    $queryRawUnsafe: jest.fn(async () => [{ id: 77 }]),
    $executeRawUnsafe: jest.fn(async () => 1),
  };
  return {
    tx,
    deps: {
      setTenantTx: jest.fn(txImpl || (async (tenantId, fn) => fn(tx))),
      notificationOutbox: { queue: jest.fn(queueImpl || (async () => ({ id: 9, status: 'PENDING' }))) },
      resolveClinicalAlertRecipients: jest.fn(resolveImpl || (async () => DUTY_RECIPIENTS)),
    },
  };
}

const pregnancy = { id: 12, patient_uid: PATIENT_UID };
const labor = { id: 34, attending_obstetrician: OBSTETRICIAN_UID };
const entry = {
  id: 56,
  on_alert_line: true,
  on_action_line: true,
  fetal_decel: null,
  fetal_heart_rate_bpm: 96,
  cervix_dilation_cm: 5,
};

describe('raisePartographEscalationSideEffects (BE-M2)', () => {
  test('action-line escalation writes a CRITICAL clinical_alerts row and queues the care-team alert', async () => {
    const { tx, deps } = makeDeps();

    await raisePartographEscalationSideEffects({
      tenantId: TENANT,
      pregnancy,
      labor,
      entry,
      escalationReason: 'action_line_crossed',
      recordedBy: OBSTETRICIAN_UID,
      deps,
    });

    // clinical_alerts insert ran under the tenant tx with CRITICAL severity.
    expect(deps.setTenantTx).toHaveBeenCalledWith(TENANT, expect.any(Function));
    const insertCall = tx.$executeRawUnsafe.mock.calls[0];
    expect(insertCall[0]).toMatch(/INSERT INTO clinical_alerts/);
    expect(insertCall[0]).toMatch(/PARTOGRAPH_ESCALATION/);
    expect(insertCall[0]).toMatch(/'CRITICAL'/);
    expect(insertCall[1]).toBe(77); // resolved int patient id
    expect(insertCall[2]).toBe('partograph_action_line');
    expect(insertCall[4]).toMatch(/ACTION line crossed/i);

    // Durable, deduplicated care-team notification.
    expect(deps.notificationOutbox.queue).toHaveBeenCalledTimes(1);
    const [notification, options] = deps.notificationOutbox.queue.mock.calls[0];
    expect(options).toEqual({ strict: true });
    expect(notification).toMatchObject({
      recipientId: OBSTETRICIAN_UID,
      tenantId: TENANT,
      channel: 'clinical_alert',
    });
    expect(notification.data).toMatchObject({
      source_event_key: 'maternity_partograph_entries:56:escalation_alert',
      partograph_entry_id: 56,
      labor_admission_id: 34,
      escalation_reason: 'action_line_crossed',
    });
  });

  test('fetal-decel escalation uses the decel vital name and copy', async () => {
    const { tx, deps } = makeDeps();

    await raisePartographEscalationSideEffects({
      tenantId: TENANT,
      pregnancy,
      labor: { id: 34, attending_obstetrician: null },
      entry: { ...entry, on_action_line: false, fetal_decel: 'late' },
      escalationReason: 'fetal_decel',
      recordedBy: null,
      deps,
    });

    const insertCall = tx.$executeRawUnsafe.mock.calls[0];
    expect(insertCall[2]).toBe('fetal_decel');
    expect(insertCall[4]).toMatch(/deceleration/i);
    // No obstetrician on file -> duty-doctor fan-out to CONCRETE recipients
    // (fix R2 — the old recipientId:null broadcast row reached nobody).
    expect(deps.resolveClinicalAlertRecipients).toHaveBeenCalledWith(TENANT);
    expect(deps.notificationOutbox.queue).toHaveBeenCalledTimes(DUTY_RECIPIENTS.length);
    const [notification] = deps.notificationOutbox.queue.mock.calls[0];
    expect(notification.recipientId).toBe(DUTY_RECIPIENTS[0].uid);
    expect(notification.data.recipient_role).toBe('DUTY_DOCTOR');
    expect(notification.title).toMatch(/deceleration/i);
  });

  test('a clinical_alerts failure does NOT skip the outbox alert, and nothing throws', async () => {
    const { deps } = makeDeps({
      txImpl: async () => { throw new Error('alerts table fault'); },
    });

    await expect(raisePartographEscalationSideEffects({
      tenantId: TENANT,
      pregnancy,
      labor,
      entry,
      escalationReason: 'action_line_crossed',
      deps,
    })).resolves.toBeUndefined();

    expect(deps.notificationOutbox.queue).toHaveBeenCalledTimes(1);
  });

  test('an outbox failure after the alert row still resolves (never throws)', async () => {
    const { tx, deps } = makeDeps({
      queueImpl: async () => { throw new Error('outbox down'); },
    });

    await expect(raisePartographEscalationSideEffects({
      tenantId: TENANT,
      pregnancy,
      labor,
      entry,
      escalationReason: 'action_line_crossed',
      deps,
    })).resolves.toBeUndefined();

    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
  });
});
