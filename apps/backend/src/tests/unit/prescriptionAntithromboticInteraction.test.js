// Unit test — antithrombotic (bleeding-risk) interaction screening in
// prescriptionSafetyCheck. Regression guard for finding
// 2026-05-10-emergency-walk-in-doctor-safety-check-misses-dapt-anticoag-bleeding-risk:
// aspirin + clopidogrel + enoxaparin (dual antiplatelet + anticoagulant)
// previously returned { safe:true, warnings:[], blockers:[] }.
//
// Two layers:
//  - checkAntithromboticInteractions is a pure function — tested directly.
//  - validatePrescriptionSafety hits prisma for allergy / duplicate /
//    paediatric lookups, all through prisma.$queryRawUnsafe. The prisma
//    module is mocked (jest.unstable_mockModule — the established pattern
//    for this repo's unit/ project, since the real @prisma/client can't
//    be loaded under Jest's ESM require here). The stub resolves [] for
//    every call, disabling every DB-backed check so only the new pure
//    antithrombotic logic contributes to the result.

import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: queryRawUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

const { validatePrescriptionSafety, checkAntithromboticInteractions } = await import(
  '../../utils/clinical/prescriptionSafetyCheck.js'
);

describe('checkAntithromboticInteractions — pure interaction rules', () => {
  it('flags dual antiplatelet + anticoagulant ("triple therapy") as a HIGH blocker', () => {
    const { warnings, blockers } = checkAntithromboticInteractions([
      { medication_name: 'Aspirin', dosage: '75 mg' },
      { medication_name: 'Clopidogrel', dosage: '75 mg' },
      { medication_name: 'Enoxaparin', dosage: '60 mg subcutaneous' },
    ]);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({
      type: 'ANTITHROMBOTIC_INTERACTION',
      interaction: 'TRIPLE_THERAPY',
      severity: 'HIGH',
    });
    expect(blockers[0].message).toMatch(/triple/i);
    // Triple therapy subsumes the lone DAPT warning — not double-flagged.
    expect(warnings).toHaveLength(0);
  });

  it('flags a single antiplatelet + anticoagulant as a HIGH blocker', () => {
    const { warnings, blockers } = checkAntithromboticInteractions([
      { name: 'Aspirin' },
      { name: 'Warfarin' },
    ]);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].interaction).toBe('ANTIPLATELET_ANTICOAGULANT');
    expect(blockers[0].severity).toBe('HIGH');
    expect(warnings).toHaveLength(0);
  });

  it('flags dual antiplatelet therapy alone as a MODERATE warning (not a blocker)', () => {
    const { warnings, blockers } = checkAntithromboticInteractions([
      { name: 'Aspirin' },
      { name: 'Clopidogrel' },
    ]);
    expect(blockers).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].interaction).toBe('DUAL_ANTIPLATELET');
    expect(warnings[0].severity).toBe('MODERATE');
  });

  it('flags anticoagulant + NSAID as a MODERATE warning', () => {
    const { warnings, blockers } = checkAntithromboticInteractions([
      { name: 'Warfarin' },
      { name: 'Ibuprofen 400mg' },
    ]);
    expect(blockers).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].interaction).toBe('ANTICOAGULANT_NSAID');
    expect(warnings[0].severity).toBe('MODERATE');
  });

  it('fires the NSAID warning independently of the triple-therapy blocker', () => {
    const { warnings, blockers } = checkAntithromboticInteractions([
      { name: 'Aspirin' },
      { name: 'Clopidogrel' },
      { name: 'Enoxaparin' },
      { name: 'Diclofenac' },
    ]);
    expect(blockers.map((b) => b.interaction)).toEqual(['TRIPLE_THERAPY']);
    expect(warnings.map((w) => w.interaction)).toEqual(['ANTICOAGULANT_NSAID']);
  });

  it('recognises common brand names (Ecosprin / Clexane)', () => {
    const { blockers } = checkAntithromboticInteractions([
      { name: 'Tab Ecosprin 75' },
      { name: 'Inj Clexane 60mg' },
    ]);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].interaction).toBe('ANTIPLATELET_ANTICOAGULANT');
  });

  it('does not flag a single antithrombotic or non-antithrombotic combos', () => {
    expect(checkAntithromboticInteractions([{ name: 'Aspirin' }]).blockers).toHaveLength(0);
    expect(checkAntithromboticInteractions([{ name: 'Aspirin' }]).warnings).toHaveLength(0);
    expect(checkAntithromboticInteractions([{ name: 'Warfarin' }]).blockers).toHaveLength(0);
    const benign = checkAntithromboticInteractions([
      { name: 'Atorvastatin 80mg' },
      { name: 'Paracetamol 650mg' },
      { name: 'Metformin 500mg' },
    ]);
    expect(benign.blockers).toHaveLength(0);
    expect(benign.warnings).toHaveLength(0);
  });

  it('returns empty results for bad input', () => {
    expect(checkAntithromboticInteractions(null)).toEqual({ warnings: [], blockers: [] });
    expect(checkAntithromboticInteractions(undefined)).toEqual({ warnings: [], blockers: [] });
    expect(checkAntithromboticInteractions([])).toEqual({ warnings: [], blockers: [] });
  });
});

describe('validatePrescriptionSafety — antithrombotic wiring (prisma stubbed)', () => {
  beforeEach(() => {
    // Structured allergies, the note-allergen scan, duplicate actives,
    // and the paediatric age/weight lookup all read through
    // $queryRawUnsafe — resolving [] disables them all so only the pure
    // antithrombotic check contributes to the result.
    queryRawUnsafeMock.mockReset().mockResolvedValue([]);
  });

  it('blocks the finding scenario: aspirin + clopidogrel + enoxaparin is no longer safe:true', async () => {
    const result = await validatePrescriptionSafety(106, [
      { medication_name: 'Aspirin', dosage: '75 mg', frequency: 'OD' },
      { medication_name: 'Clopidogrel', dosage: '300 mg stat then 75 mg', frequency: 'stat then OD' },
      { medication_name: 'Atorvastatin', dosage: '80 mg', frequency: 'HS' },
      { medication_name: 'Enoxaparin', dosage: '60 mg subcutaneous', frequency: 'BD' },
    ]);
    expect(result.safe).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'ANTITHROMBOTIC_INTERACTION',
          interaction: 'TRIPLE_THERAPY',
        }),
      ]),
    );
  });

  it('keeps a benign single-drug prescription safe:true', async () => {
    const result = await validatePrescriptionSafety(106, [
      { medication_name: 'Amoxicillin', dosage: '500 mg', frequency: 'TDS', days: 5 },
    ]);
    expect(result.safe).toBe(true);
    expect(result.blockers).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('produces an override-consumable blocker contract', async () => {
    // createPrescription gates on `!safety.safe` and persists
    // JSON.stringify(safety.blockers) to prescription_safety_overrides —
    // so the blocker must be a plain, JSON-serialisable object carrying a
    // human-readable .message (the field the CDS-modal renderer keys on).
    const result = await validatePrescriptionSafety(106, [
      { name: 'Aspirin' },
      { name: 'Warfarin' },
    ]);
    expect(result.safe).toBe(false);
    expect(result.blockers.length).toBeGreaterThan(0);
    for (const blocker of result.blockers) {
      expect(typeof blocker.message).toBe('string');
      expect(blocker.message.length).toBeGreaterThan(0);
    }
    // Round-trips through JSON exactly as the override audit path serialises it.
    expect(JSON.parse(JSON.stringify(result.blockers))).toEqual(result.blockers);
  });

  it('blocks high-risk pregnancy medication when active pregnancy is recorded', async () => {
    queryRawUnsafeMock.mockReset()
      .mockResolvedValueOnce([]) // structured allergies
      .mockResolvedValueOnce([]) // unstructured note scan
      .mockResolvedValueOnce([]) // duplicate active prescriptions
      .mockResolvedValueOnce([{ age_years: 30 }]) // paediatric context
      .mockResolvedValueOnce([{
        gender: 'female',
        is_pregnant: true,
        pregnancy_lmp_date: '2026-02-01',
        age_years: 30,
        has_ongoing_pregnancy: true,
      }])
      .mockResolvedValueOnce([{ labs: [] }]); // renal context

    const result = await validatePrescriptionSafety(106, [
      { medication_name: 'Warfarin 5mg', frequency: 'OD', days: 7 },
    ]);

    expect(result.safe).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'PREGNANCY_MEDICATION_RISK',
          medication: 'Warfarin 5mg',
        }),
      ]),
    );
  });

  it('blocks high-risk renal drugs when severe renal impairment evidence exists', async () => {
    queryRawUnsafeMock.mockReset()
      .mockResolvedValueOnce([]) // structured allergies
      .mockResolvedValueOnce([]) // unstructured note scan
      .mockResolvedValueOnce([]) // duplicate active prescriptions
      .mockResolvedValueOnce([{ age_years: 70 }]) // paediatric context
      .mockResolvedValueOnce([{ gender: 'male', is_pregnant: false, age_years: 70, has_ongoing_pregnancy: false }])
      .mockResolvedValueOnce([{
        labs: [
          { test_name: 'eGFR', test_code: 'EGFR', value_numeric: '22', unit: 'mL/min' },
        ],
      }]);

    const result = await validatePrescriptionSafety(106, [
      { medication_name: 'Gentamicin injection', frequency: 'OD', days: 3 },
    ]);

    expect(result.safe).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'RENAL_MEDICATION_REVIEW',
          medication: 'Gentamicin injection',
          latest_egfr: 22,
        }),
      ]),
    );
  });

  it('warns on reserve antibiotic stewardship and missing duration without hard-blocking', async () => {
    queryRawUnsafeMock.mockReset().mockResolvedValue([]);

    const result = await validatePrescriptionSafety(106, [
      { medication_name: 'Meropenem injection', frequency: 'TDS' },
    ]);

    expect(result.safe).toBe(true);
    expect(result.blockers).toHaveLength(0);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'ANTIBIOTIC_DURATION_MISSING' }),
        expect.objectContaining({ type: 'ANTIBIOTIC_STEWARDSHIP_RESERVE' }),
      ]),
    );
  });
});
