// CDS Hooks fail-visible contract (AI/CDS hardening batch).
//
// The order-select / order-sign / medication-prescribe hooks used to swallow
// engine failures into an EMPTY card list (`.catch(() => ({alerts: []}))` /
// `.catch(() => [])`) — a skipped safety check looked exactly like a clean
// pass. This suite pins the replacement behaviour: a visible degraded warning
// card (critical on order-sign, the final signing hook) plus a
// clinical_audit_events row via recordCdsCheckFailureAudit.
//
// cdsEngine + access decision are fully mocked; the route + cdsHooksAdapter
// (pure) run for real under supertest.

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const checkOrder = jest.fn();
const checkDrugInteractions = jest.fn(async () => []);
const checkAllergies = jest.fn(async () => []);
const checkDuplicateOrders = jest.fn(async () => []);
const getActiveAlerts = jest.fn(async () => []);
const getProtocolReminders = jest.fn(async () => []);
const recordCdsCheckFailureAudit = jest.fn(async () => true);
// Sentinel titles so assertions can tell the two severities apart without
// depending on the exact production copy (pinned in cdsEngineCoverage).
const buildCdsUnavailableAlert = jest.fn(({ severity = 'warning' } = {}) => ({
  type: 'system_error',
  severity,
  title: severity === 'critical' ? 'SENTINEL-CDS-UNAVAILABLE-CRITICAL' : 'SENTINEL-CDS-UNAVAILABLE-WARNING',
  description: 'sentinel description',
  canOverride: true,
  degraded: true,
}));

jest.unstable_mockModule('../../services/emr/cdsEngine.js', () => ({
  buildCdsUnavailableAlert,
  checkOrder,
  checkDrugInteractions,
  checkAllergies,
  checkDuplicateOrders,
  getActiveAlerts,
  getProtocolReminders,
  recordCdsCheckFailureAudit,
}));

jest.unstable_mockModule('../../services/cds/encounterCdsHelper.js', () => ({
  buildEncounterStartAlerts: jest.fn(async () => []),
  buildEncounterDischargeAlerts: jest.fn(async () => []),
}));

jest.unstable_mockModule('../../services/security/accessDecisionService.js', () => ({
  authorizePatientAccessRequest: jest.fn(async () => ({ allowed: true })),
  patientAccessErrorPayload: jest.fn(() => ({ success: false })),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: cdsHooksRouter } = await import('../../routes/clinical/cdsHooksRoutes.js');

const app = express();
app.use(express.json());
app.use('/cds-services', cdsHooksRouter);
// Bare error handler so route-level next(err) doesn't crash the test app.
app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));

const PATIENT_UID = 'a2f0c1de-1111-4222-8333-444455556666';

function orderSignBody(hook, resource) {
  return {
    hook,
    context: {
      patientId: `Patient/${PATIENT_UID}`,
      encounterId: 'Encounter/55',
      draftOrders: { entry: [{ resource }] },
    },
  };
}

const MED_REQUEST = {
  resourceType: 'MedicationRequest',
  medicationCodeableConcept: { text: 'Warfarin' },
};

beforeEach(() => {
  jest.clearAllMocks();
  checkDrugInteractions.mockResolvedValue([]);
  checkAllergies.mockResolvedValue([]);
  checkDuplicateOrders.mockResolvedValue([]);
});

describe('order-sign / order-select degraded cards', () => {
  it('order-sign: a checkOrder rejection returns a CRITICAL degraded card + audit row (never empty cards)', async () => {
    checkOrder.mockRejectedValue(new Error('engine exploded'));

    const res = await request(app)
      .post('/cds-services/vh-order-sign')
      .send(orderSignBody('order-sign', MED_REQUEST));

    expect(res.status).toBe(200);
    expect(res.body.cards).toHaveLength(1);
    expect(res.body.cards[0].indicator).toBe('critical');
    expect(res.body.cards[0].summary).toContain('SENTINEL-CDS-UNAVAILABLE-CRITICAL');
    expect(recordCdsCheckFailureAudit).toHaveBeenCalledWith(expect.objectContaining({
      patientUid: PATIENT_UID,
      context: 'cds_hooks:order-sign',
    }));
  });

  it('order-select: same failure degrades to a WARNING card', async () => {
    checkOrder.mockRejectedValue(new Error('engine exploded'));

    const res = await request(app)
      .post('/cds-services/vh-order-select')
      .send(orderSignBody('order-select', MED_REQUEST));

    expect(res.status).toBe(200);
    expect(res.body.cards).toHaveLength(1);
    expect(res.body.cards[0].indicator).toBe('warning');
    expect(recordCdsCheckFailureAudit).toHaveBeenCalledWith(expect.objectContaining({
      context: 'cds_hooks:order-select',
    }));
  });

  it('order-sign: a degraded checkOrder RESULT (internal fail-closed) passes its warning alert through as a card', async () => {
    checkOrder.mockResolvedValue({
      safe: false,
      degraded: true,
      degraded_reason: 'cds_engine_error',
      alerts: [{
        type: 'system_error',
        severity: 'warning',
        title: 'CDS safety checks unavailable — verify interactions/allergies manually',
        description: 'x',
        canOverride: true,
        degraded: true,
      }],
    });

    const res = await request(app)
      .post('/cds-services/vh-order-sign')
      .send(orderSignBody('order-sign', MED_REQUEST));

    expect(res.status).toBe(200);
    expect(res.body.cards).toHaveLength(1);
    expect(res.body.cards[0].summary).toMatch(/CDS safety checks unavailable/);
  });

  it('order-sign: clean checkOrder results still map to normal cards', async () => {
    checkOrder.mockResolvedValue({
      safe: false,
      alerts: [{ type: 'allergy', severity: 'critical', title: 'Allergy conflict', description: 'd', canOverride: true }],
    });

    const res = await request(app)
      .post('/cds-services/vh-order-sign')
      .send(orderSignBody('order-sign', MED_REQUEST));

    expect(res.status).toBe(200);
    expect(res.body.cards).toHaveLength(1);
    expect(res.body.cards[0].summary).toBe('Allergy conflict');
    expect(recordCdsCheckFailureAudit).not.toHaveBeenCalled();
  });
});

describe('medication-prescribe degraded cards', () => {
  const body = {
    hook: 'medication-prescribe',
    context: {
      patientId: `Patient/${PATIENT_UID}`,
      medications: ['Warfarin'],
    },
  };

  it('a failed sub-check surfaces a WARNING degraded card + audit row alongside surviving alerts', async () => {
    checkAllergies.mockRejectedValue(new Error('allergy source down'));
    checkDrugInteractions.mockResolvedValue([
      { type: 'drug_interaction', severity: 'warning', title: 'Interaction found', description: 'd', canOverride: true },
    ]);

    const res = await request(app)
      .post('/cds-services/vh-medication-prescribe')
      .send(body);

    expect(res.status).toBe(200);
    const summaries = res.body.cards.map((c) => c.summary);
    expect(summaries).toContain('Interaction found');
    expect(summaries).toContain('SENTINEL-CDS-UNAVAILABLE-WARNING');
    expect(recordCdsCheckFailureAudit).toHaveBeenCalledWith(expect.objectContaining({
      patientUid: PATIENT_UID,
      context: 'cds_hooks:medication-prescribe',
    }));
  });

  it('no failure → no degraded card, no audit row', async () => {
    const res = await request(app)
      .post('/cds-services/vh-medication-prescribe')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.cards).toEqual([]);
    expect(recordCdsCheckFailureAudit).not.toHaveBeenCalled();
  });
});
