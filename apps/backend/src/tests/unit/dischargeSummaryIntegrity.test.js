import { jest } from '@jest/globals';

// Pure-function unit tests for the take-home medication reconciliation
// in the clinical-AI discharge path. The whole module pulls in the LLM
// client + event outbox at import time, so stub those out; we only call
// the pure buildDischargeMedications helper exposed via __testing__.
jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../services/ai/localLlmClient.js', () => ({
  generateClinicalText: jest.fn(),
  getClinicalAiConfig: jest.fn(() => ({})),
}));
jest.unstable_mockModule('../../services/events/eventOutboxService.js', () => ({
  publishEvent: jest.fn(),
}));
jest.unstable_mockModule('../../utils/hipaaAudit.js', () => ({
  logPhiAccess: jest.fn(),
}));
jest.unstable_mockModule('../../services/emr/clinicalTimelineService.js', () => ({
  collectAdmissionClinicalContext: jest.fn(),
}));

const { __testing__ } = await import('../../services/emr/dischargeSummaryGenerator.js');
const { buildDischargeMedications } = __testing__;

// Build a clinical_orders timeline event of order_type=medication the way
// clinicalTimelineService.getTimelineOrders shapes it.
function medOrder({ id, name, route = '', dose = '', status = 'in_progress', frequency = '' }) {
  return {
    event_type: 'clinical_order',
    sub_type: 'medication',
    id,
    payload: {
      id,
      order_type: 'medication',
      status,
      details: { medication_name: name, route, dose, frequency },
    },
  };
}

// Finding 2026-05-22-inpatient-admission-discharge-edb7c8ff:
//   Discharge summary draft carried discontinued / stopped IV inpatient
//   drugs into discharge medications as `continue`, and duplicated an
//   ORS order from two source order ids. The take-home reconciliation
//   must distinguish inpatient/stopped meds from genuine take-home meds.
describe('buildDischargeMedications — take-home reconciliation', () => {
  it('excludes a discontinued medication order from the take-home list', () => {
    const ctx = {
      orders: [
        medOrder({ id: 1, name: 'Pantoprazole', route: 'oral', dose: '40mg', status: 'discontinued' }),
        medOrder({ id: 2, name: 'Ondansetron', route: 'oral', dose: '4mg', status: 'in_progress' }),
      ],
      chronic_medications: [],
    };
    const meds = buildDischargeMedications(ctx);
    const names = meds.map((m) => m.name);
    expect(names).toContain('Ondansetron');
    expect(names).not.toContain('Pantoprazole');
  });

  it('excludes a STOPPED medication (free-text status the old regex missed)', () => {
    const ctx = {
      orders: [
        medOrder({ id: 1, name: 'Normal Saline', route: 'IV', status: 'stopped' }),
        medOrder({ id: 2, name: 'ORS', route: 'oral', status: 'in_progress' }),
      ],
      chronic_medications: [],
    };
    const meds = buildDischargeMedications(ctx);
    expect(meds.map((m) => m.name)).toEqual(['ORS']);
  });

  it('does NOT auto-mark an active IV inpatient drug as continue', () => {
    // Active (in_progress) Normal Saline IV + Pantoprazole IV — the exact
    // finding scenario. They may still be surfaced for reconciliation, but
    // never as `continue` (which the patient/relative reads as take-home).
    const ctx = {
      orders: [
        medOrder({ id: 56, name: 'Normal Saline', route: 'IV', status: 'in_progress' }),
        medOrder({ id: 57, name: 'Pantoprazole', route: 'IV', status: 'in_progress' }),
        medOrder({ id: 58, name: 'Pantoprazole', route: 'oral', dose: '40mg', status: 'in_progress' }),
      ],
      chronic_medications: [],
    };
    const meds = buildDischargeMedications(ctx);
    const saline = meds.find((m) => m.name === 'Normal Saline');
    const ivPanto = meds.find((m) => m.name === 'Pantoprazole' && m.route === 'IV');
    const oralPanto = meds.find((m) => m.name === 'Pantoprazole' && m.route === 'oral');

    expect(saline.reconciliation_status).toBe('pending_review');
    expect(saline.requires_review_reason).toBe('parenteral_inpatient_route_not_take_home');
    expect(ivPanto.reconciliation_status).toBe('pending_review');
    // The oral form is a legitimate take-home med and stays `continue`.
    expect(oralPanto.reconciliation_status).toBe('continue');
  });

  it('detects parenteral route from the drug name when the route column is blank', () => {
    const ctx = {
      orders: [medOrder({ id: 1, name: 'Normal Saline IV', route: '', status: 'in_progress' })],
      chronic_medications: [],
    };
    const [med] = buildDischargeMedications(ctx);
    expect(med.reconciliation_status).toBe('pending_review');
  });

  it('de-duplicates the same drug ordered twice during the stay', () => {
    // Duplicate ORS from source_order_id 59 and 60 (finding evidence).
    const ctx = {
      orders: [
        medOrder({ id: 59, name: 'ORS', route: 'oral', dose: '1 sachet', status: 'in_progress' }),
        medOrder({ id: 60, name: 'ORS', route: 'oral', dose: '1 sachet', status: 'in_progress' }),
      ],
      chronic_medications: [],
    };
    const meds = buildDischargeMedications(ctx);
    expect(meds.filter((m) => m.name === 'ORS')).toHaveLength(1);
    // First-seen order id is retained.
    expect(meds[0].source_order_id).toBe(59);
  });

  it('keeps an active oral medication as a continue take-home med', () => {
    const ctx = {
      orders: [medOrder({ id: 1, name: 'Metformin', route: 'oral', dose: '500mg', frequency: 'BD', status: 'in_progress' })],
      chronic_medications: [],
    };
    const [med] = buildDischargeMedications(ctx);
    expect(med).toMatchObject({
      name: 'Metformin',
      route: 'oral',
      reconciliation_status: 'continue',
      source: 'inpatient',
    });
  });

  it('end-to-end finding scenario: only oral takeaway meds are continue', () => {
    // Day-2 oral step-down: Normal Saline stopped, oral Pantoprazole/ORS/
    // Ondansetron ordered, plus a still-running IV support drug.
    const ctx = {
      orders: [
        medOrder({ id: 56, name: 'Normal Saline', route: 'IV', status: 'stopped' }),
        medOrder({ id: 57, name: 'Pantoprazole', route: 'IV', status: 'in_progress' }),
        medOrder({ id: 58, name: 'Pantoprazole', route: 'oral', dose: '40mg', status: 'in_progress' }),
        medOrder({ id: 59, name: 'ORS', route: 'oral', status: 'in_progress' }),
        medOrder({ id: 60, name: 'ORS', route: 'oral', status: 'in_progress' }),
        medOrder({ id: 61, name: 'Ondansetron', route: 'oral', dose: '4mg', status: 'in_progress' }),
      ],
      chronic_medications: [],
    };
    const meds = buildDischargeMedications(ctx);
    const continueMeds = meds.filter((m) => m.reconciliation_status === 'continue').map((m) => m.name).sort();
    // Stopped saline is gone entirely; IV pantoprazole is pending_review;
    // ORS de-duplicated to one. The take-home `continue` set is the three
    // distinct oral drugs.
    expect(continueMeds).toEqual(['ORS', 'Ondansetron', 'Pantoprazole']);
    expect(meds.find((m) => m.name === 'Normal Saline')).toBeUndefined();
  });
});
