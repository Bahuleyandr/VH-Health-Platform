import { jest } from '@jest/globals';

const canonical = jest.fn();
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: canonical,
  startWorkflowSla: jest.fn(),
  completeWorkflowSla: jest.fn(),
  cancelWorkflowSla: jest.fn(),
  isSchemaMissing: () => false,
}));
const { emitPharmacyOrderEvent, emitDischargeWorkflowOpened, emitDischargeDrugsDispensed } =
  await import('../../services/clinical/canonicalOperationalBridgeService.js');

const instant = new Date('2026-09-16T12:00:00.123Z');
const patient = '00000000-0000-4000-8000-00000000c20d';
const tenant = '00000000-0000-4000-8000-00000000c20c';
const tx = { $queryRawUnsafe: jest.fn(async () => [{ uid: patient }]) };

beforeEach(() => canonical.mockReset().mockResolvedValue({ timeline: {}, audit: {} }));

it('uses the supplied dispensing instant for occurrence and identity, not a naive returned timestamp', async () => {
  await emitPharmacyOrderEvent({
    db: tx,
    order: { id: 42, tenant_id: tenant, patient_uid: patient, status: 'DISPENSED', updated_at: '2026-09-16T17:30:00.123Z' },
    eventType: 'pharmacy.order_dispensed', occurredAt: instant,
  });
  expect(canonical).toHaveBeenCalledWith(expect.objectContaining({
    occurredAt: instant.toISOString(),
    timelineIdempotencyKey: `pharmacy_orders:42:pharmacy.order_dispensed:DISPENSED:${instant.toISOString()}`,
    auditIdempotencyKey: `pharmacy_orders:42:audit:pharmacy.order_dispensed:DISPENSED:${instant.toISOString()}`,
  }), { db: tx, strict: true });
});

it('preserves occurrence defaults and identity for unrelated pharmacy callers', async () => {
  await emitPharmacyOrderEvent({
    db: tx, order: { id: 42, tenant_id: tenant, patient_uid: patient, status: 'READY', updated_at: instant },
  });
  expect(canonical).toHaveBeenCalledWith(expect.objectContaining({
    occurredAt: null,
    timelineIdempotencyKey: `pharmacy_orders:42:pharmacy.order_updated:READY:${instant.toISOString()}`,
  }), { db: tx, strict: true });
});

it.each([
  { emit: emitDischargeWorkflowOpened, field: 'discharge_initiated_at', eventType: 'discharge.workflow_opened' },
  { emit: emitDischargeDrugsDispensed, field: 'discharge_drugs_dispensed_at', eventType: 'discharge.drugs_dispensed' },
])('uses the authoritative admission instant for $eventType', async ({ emit, field, eventType }) => {
  await emit({ db: tx, admission: { id: 42, tenant_id: tenant, patient_uid: patient, [field]: instant } });
  expect(canonical).toHaveBeenCalledWith(expect.objectContaining({ occurredAt: instant.toISOString(), eventType }), expect.objectContaining({ db: tx }));
});

it('prefers the captured discharge occurrence over an adapter-shifted returned field', async () => {
  await emitDischargeDrugsDispensed({
    db: tx, occurredAt: instant,
    admission: { id: 42, tenant_id: tenant, patient_uid: patient, discharge_drugs_dispensed_at: '2026-09-16T17:30:00.123Z' },
  });
  expect(canonical).toHaveBeenCalledWith(expect.objectContaining({
    occurredAt: instant.toISOString(), payload: expect.objectContaining({ discharge_drugs_dispensed_at: instant }),
  }), { db: tx, strict: true });
});

it('propagates canonical failure instead of accepting an unrecorded dispense', async () => {
  canonical.mockRejectedValueOnce(new Error('synthetic canonical failure'));
  await expect(emitPharmacyOrderEvent({
    db: tx, order: { id: 42, tenant_id: tenant, patient_uid: patient }, occurredAt: instant,
  })).rejects.toThrow('synthetic canonical failure');
});
