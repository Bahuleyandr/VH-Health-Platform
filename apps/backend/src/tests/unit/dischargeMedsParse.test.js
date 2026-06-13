// Unit regression for finding H' D71 — discharge meds materialised as a
// generic sentence on the patient app Rx tab.
//
// `materialiseDischargeMedsAsPrescription` used to stamp every
// extracted medication line with `instructions: 'See discharge summary
// for full schedule'`. The patient's Rx card therefore rendered:
//
//     Metformin 500mg BD (continue)
//     See discharge summary for full schedule
//
// for every takeaway — a useless boilerplate sentence with no actual
// dose/frequency/duration. The patient (and especially elderly /
// low-literacy patients on a feature-phone WhatsApp render) could not
// see what to actually take.
//
// The fix splits each line at the first digit-led tail into:
//   * name         — everything before the first digit (e.g. "Metformin")
//   * instructions — the dose/frequency/route tail (e.g. "500mg BD (continue)")
// so the Rx card shows a real prescription, not boilerplate. Lines with
// no digits (e.g. "Continue current home meds") fall back to the whole
// line as `name` and `instructions: null` rather than the old boilerplate.
//
// Findings 2026-05-22-discharge-..._a175476a and ..._c221cd96.

import { jest } from '@jest/globals';

const queryRawMock = jest.fn();
const executeRawMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawMock,
  $executeRawUnsafe: executeRawMock,
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { materialiseDischargeMedsAsPrescription } = await import(
  '../../services/discharge/dischargeService.js'
);

const PATIENT_UID = 'cccccccc-1111-4222-8333-444444444444';
const DOCTOR_UID = 'cccccccc-1111-4222-8333-555555555555';

describe('materialiseDischargeMedsAsPrescription — line parsing (H D71)', () => {
  beforeEach(() => {
    queryRawMock.mockReset();
    executeRawMock.mockReset();
    executeRawMock.mockResolvedValue(1);
  });

  async function callWithBody(body) {
    // Mock queue for: sections lookup → idempotency probe → patient
    // lookup → doctor lookup.
    queryRawMock
      .mockResolvedValueOnce([{
        section_key: 'discharge_medications',
        section_title: 'Discharge medications',
        body,
      }])
      .mockResolvedValueOnce([]) // idempotency probe (no prior row)
      .mockResolvedValueOnce([{ id: 71 }]) // patient
      .mockResolvedValueOnce([{ id: 17 }]); // doctor

    await materialiseDischargeMedsAsPrescription({
      discharge_summary_id: 4242,
      patient_uid: PATIENT_UID,
      doctor_uid: DOCTOR_UID,
    });
    // The INSERT is the last $executeRawUnsafe call — return its
    // medications JSON for assertion.
    const insertCall = executeRawMock.mock.calls.find((args) =>
      /INSERT INTO e_prescriptions/.test(args[0]),
    );
    if (!insertCall) throw new Error('e_prescriptions INSERT not called');
    return JSON.parse(insertCall[6]); // medications jsonb at $6
  }

  it('parses dose/frequency tail into instructions for a typical chronic-med list', async () => {
    const body = [
      '[AUTO-DRAFT — review and edit before sign-off]',
      '',
      'Chronic medications to continue (reconcile against takeaway script):',
      '- Metformin 500mg BD (continue)',
      '- Aspirin 75mg OD',
      '- Vitamin D3 60000 IU weekly x 8 weeks',
    ].join('\n');

    const meds = await callWithBody(body);

    // Every parsed entry must carry real instructions — no generic
    // "See discharge summary" boilerplate anywhere.
    for (const m of meds) {
      expect(String(m.instructions || '')).not.toMatch(/See discharge summary/i);
    }

    // The three pharmacy lines should land with name + instructions split.
    const byName = Object.fromEntries(meds.map((m) => [m.name, m.instructions]));
    expect(byName.Metformin).toBe('500mg BD (continue)');
    expect(byName.Aspirin).toBe('75mg OD');
    expect(byName['Vitamin D3']).toBe('60000 IU weekly x 8 weeks');
  });

  it('falls back to whole-line name (no boilerplate) when a line has no dose', async () => {
    const body = [
      '- Continue current home meds',
      '- Metoprolol 25mg OD',
    ].join('\n');

    const meds = await callWithBody(body);

    const continueLine = meds.find((m) => /Continue current home meds/.test(m.name));
    expect(continueLine).toBeTruthy();
    // No dose → no instructions string, NOT the old boilerplate.
    expect(continueLine.instructions).toBeNull();

    const metop = meds.find((m) => m.name === 'Metoprolol');
    expect(metop?.instructions).toBe('25mg OD');
  });

  it('strips trailing punctuation off the parsed name', async () => {
    const body = '- Atorvastatin: 20mg OD HS';
    const meds = await callWithBody(body);
    expect(meds[0].name).toBe('Atorvastatin');
    expect(meds[0].instructions).toBe('20mg OD HS');
  });

  it('stamps source: discharge_summary on every entry', async () => {
    const body = '- Pantoprazole 40mg OD before breakfast';
    const meds = await callWithBody(body);
    expect(meds[0].source).toBe('discharge_summary');
  });
});
