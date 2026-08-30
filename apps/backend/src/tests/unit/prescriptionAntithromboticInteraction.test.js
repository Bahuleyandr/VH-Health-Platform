// Unit test — antithrombotic (bleeding-risk) interaction screening in
// prescriptionSafetyCheck. Regression guard for finding
// 2026-05-10-emergency-walk-in-doctor-safety-check-misses-dapt-anticoag-bleeding-risk:
// aspirin + clopidogrel + enoxaparin (dual antiplatelet + anticoagulant)
// previously returned { safe:true, warnings:[], blockers:[] }.
//
// Two layers:
//  - checkAntithromboticInteractions is a pure function — tested directly.
//  - validatePrescriptionSafety hits prisma for active-therapy and clinical
//    context lookups. The prisma module is mocked (jest.unstable_mockModule —
//    the established pattern for this repo's unit/ project, since the real
//    @prisma/client can't be loaded under Jest's ESM require here). The stub
//    resolves a governed empty active-therapy snapshot and routes the remaining
//    lookups so only each test's intended safety rule contributes.

import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const getUnifiedActiveAllergiesMock = jest.fn();
const getUnifiedActiveAllergiesDetailedMock = jest.fn(async (...args) => ({
  allergies: await getUnifiedActiveAllergiesMock(...args),
  sourcesFailed: [],
  patientResolved: true,
}));
const evaluateDrugKbMock = jest.fn();
const isCompositionSearchEnabledMock = jest.fn();

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const SNAPSHOT_AT = '2026-08-30T08:00:00.000Z';

const __prismaDefaultMock = { $queryRawUnsafe: queryRawUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../services/clinical/allergySourceService.js', () => ({
  getUnifiedActiveAllergies: getUnifiedActiveAllergiesMock,
  getUnifiedActiveAllergiesDetailed: getUnifiedActiveAllergiesDetailedMock,
  SEVERE_BLOCK_RANK: 4,
  rankSeverity: (value) => {
    if (value == null) return 0;
    const key = String(value).trim().toUpperCase();
    if (!key || ['UNKNOWN', 'UNSPECIFIED', 'NONE', 'N/A', 'NA', 'NULL', 'NIL'].includes(key)) return 0;
    return ({
      LIFE_THREATENING: 5,
      ANAPHYLAXIS: 5,
      CONTRAINDICATED: 4,
      SEVERE: 4,
      HIGH: 3,
      MODERATE: 2,
      MILD: 1,
    })[key] ?? 4;
  },
}));

jest.unstable_mockModule('../../services/clinical/drugKnowledgeBaseService.js', () => ({
  evaluateDrugKb: evaluateDrugKbMock,
}));

jest.unstable_mockModule('../../services/pharmacy/compositionFeatureService.js', () => ({
  isCompositionSearchEnabled: isCompositionSearchEnabledMock,
}));

const { validatePrescriptionSafety: validatePrescriptionSafetyImpl, checkAntithromboticInteractions } = await import(
  '../../utils/clinical/prescriptionSafetyCheck.js'
);

function queueRaw(...sequence) {
  const queued = [...sequence];
  const nextQueued = () => (queued.length > 0 ? queued.shift() : []);

  queryRawUnsafeMock.mockReset().mockImplementation(async (statement) => {
    if (/SELECT id, uid, NOW\(\) AS snapshot_at/.test(statement)) {
      return [{ id: 106, uid: PATIENT_UID, snapshot_at: SNAPSHOT_AT }];
    }
    if (/SELECT inventory\.id/.test(statement) && /FOR KEY SHARE OF inventory/.test(statement)) {
      return [];
    }
    if (/WITH latest_reconciliation/.test(statement)) return nextQueued();
    if (/FROM chemo_administrations/.test(statement)) return [];
    return nextQueued();
  });
}

function validatePrescriptionSafety(patientId, medications, options = {}) {
  return validatePrescriptionSafetyImpl(patientId, medications, {
    tenantId: TENANT_ID,
    ...options,
  });
}

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
    getUnifiedActiveAllergiesMock.mockReset().mockResolvedValue([]);
    getUnifiedActiveAllergiesDetailedMock.mockClear();
    evaluateDrugKbMock.mockReset().mockResolvedValue({ kbAvailable: true, findings: [] });
    isCompositionSearchEnabledMock.mockReset().mockResolvedValue(false);
    queueRaw();
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
    queueRaw(
      [], // unstructured note scan
      [], // governed active-therapy source rows
      [{ age_years: 30 }], // paediatric context
      [{
        gender: 'female',
        is_pregnant: true,
        pregnancy_lmp_date: '2026-02-01',
        age_years: 30,
        has_ongoing_pregnancy: true,
      }],
      [{ labs: [] }], // renal context
    );

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
    queueRaw(
      [], // unstructured note scan
      [], // governed active-therapy source rows
      [{ age_years: 70 }], // paediatric context
      [{ gender: 'male', is_pregnant: false, age_years: 70, has_ongoing_pregnancy: false }],
      [{
        labs: [
          { test_name: 'eGFR', test_code: 'EGFR', value_numeric: '22', unit: 'mL/min' },
        ],
      }],
    );

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
    queueRaw();

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
