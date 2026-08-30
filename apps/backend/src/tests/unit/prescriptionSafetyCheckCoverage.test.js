// Unit test — branch-coverage sweep for validatePrescriptionSafety in
// src/utils/clinical/prescriptionSafetyCheck.js (roadmap B3.2).
//
// The sibling prescriptionAntithromboticInteraction.test.js already pins the
// pure antithrombotic rules and a few happy-path wirings. This file targets
// the BRANCH gap (~67%): the allergy severity tiers, the unstructured-note
// allergen scan + beta-lactam cross-reactivity, duplicate active-medication
// detection, the paediatric weight-based dose blockers (flat + liquid-volume
// mismatch), the renal / pregnancy / antibiotic-stewardship classifiers, the
// drug-KB findings → blocker-vs-warning mapping (check 8), and the
// fail-closed outer catch.
//
// Runtime dependencies are mocked with jest.unstable_mockModule (the
// established pattern for this repo's unit/ project — the real @prisma/client
// can't be loaded under Jest's ESM here). The primary safety seams are:
//   * ../../lib/prisma.js            — drives every $queryRawUnsafe call.
//   * ../../services/clinical/allergySourceService.js — getUnifiedActiveAllergies,
//     so allergy severity tiers are deterministic (the real service also
//     reads prisma, which would otherwise need seeded rows).
//   * ../../services/clinical/drugKnowledgeBaseService.js — evaluateDrugKb +
//     classifyAntithromboticDrug-adjacent helpers, so the KB findings → issue
//     classification in check 8 is exercised without migration 277 data.
//
// No source is modified; assertions describe the code AS WRITTEN.

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
const enrichMedicationsWithCompositionMock = jest.fn();
const resolveCompositionIdentitiesByCatalogIdsMock = jest.fn();
const resolveDrugKeysMock = jest.fn();

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
  // Mirror the real fail-safe ranking the consumer now uses to decide
  // blocker-vs-warning: canonical-severe and present-but-unparseable rank >= 4
  // (block); explicit no-claim sentinels (UNKNOWN/null) rank 0 (warn).
  SEVERE_BLOCK_RANK: 4,
  rankSeverity: (v) => {
    if (v == null) return 0;
    const k = String(v).trim().toUpperCase();
    if (!k || ['UNKNOWN', 'UNSPECIFIED', 'NONE', 'N/A', 'NA', 'NULL', 'NIL'].includes(k)) return 0;
    return ({ LIFE_THREATENING: 5, ANAPHYLAXIS: 5, CONTRAINDICATED: 4, SEVERE: 4, HIGH: 3, MODERATE: 2, MILD: 1 })[k] ?? 4;
  },
}));

jest.unstable_mockModule('../../services/clinical/drugKnowledgeBaseService.js', () => ({
  evaluateDrugKb: evaluateDrugKbMock,
}));
jest.unstable_mockModule('../../services/clinical/drugKbLinkService.js', () => ({
  resolveDrugKeys: resolveDrugKeysMock,
}));
jest.unstable_mockModule('../../services/pharmacy/compositionFeatureService.js', () => ({
  isCompositionSearchEnabled: isCompositionSearchEnabledMock,
}));
jest.unstable_mockModule('../../services/pharmacy/compositionIdentityService.js', () => ({
  enrichMedicationsWithComposition: enrichMedicationsWithCompositionMock,
  resolveCompositionIdentitiesByCatalogIds: resolveCompositionIdentitiesByCatalogIdsMock,
}));

const { validatePrescriptionSafety: validatePrescriptionSafetyImpl } = await import(
  '../../utils/clinical/prescriptionSafetyCheck.js'
);

// ---- shared helpers -------------------------------------------------------

// Default: the authoritative KB is available and contributes no findings.
// Tests that exercise unavailable/error behavior override this explicitly.
function defaultKb() {
  evaluateDrugKbMock.mockReset().mockResolvedValue({ kbAvailable: true, findings: [] });
}

// Default: no structured allergies. Most tests override.
function noAllergies() {
  getUnifiedActiveAllergiesMock.mockReset().mockResolvedValue([]);
}

// validatePrescriptionSafety issues, in order. The active-therapy loader now
// adds authority/lock/source queries between the note scan and the legacy
// clinical-context queries. queueRaw routes those by SQL so the historical
// sequence slots below stay stable:
//   1. note scan (appointments + clinical_notes)  -> queued value #1
//   2. active-therapy source rows                  -> queued value #2
//   3. loadPaediatricContext: age query            -> $queryRawUnsafe #3
//      (and, if age < 12, a second weight query)   -> $queryRawUnsafe #3b
//   4. loadPregnancyContext                        -> next
//   5. loadRenalContext                            -> next
//   6. check 8: patient uid/age query              -> next
//      (and, if uid present, patient_problems)     -> next
// Tests that need precise control pass a sequence; anything past it is [].
// Legacy duplicate rows are upgraded to complete governed snapshot rows so
// they remain warning-only instead of introducing identity blockers.
function queueRaw(...sequence) {
  const queued = [...sequence];
  let catalogRows = [];
  let compositionRows = [];

  const nextQueued = () => {
    const value = queued.length > 0 ? queued.shift() : [];
    if (value instanceof Error) throw value;
    return value;
  };

  queryRawUnsafeMock.mockReset().mockImplementation(async (statement) => {
    if (/SELECT id, uid, NOW\(\) AS snapshot_at/.test(statement)) {
      return [{ id: 106, uid: PATIENT_UID, snapshot_at: SNAPSHOT_AT }];
    }
    if (/SELECT inventory\.id/.test(statement) && /FOR KEY SHARE OF inventory/.test(statement)) {
      return [];
    }
    if (/WITH latest_reconciliation/.test(statement)) {
      const rows = nextQueued();
      catalogRows = [];
      compositionRows = [];
      return rows
        .filter((row) => String(row?.medication_name || '').trim())
        .map((row, index) => {
          const catalogId = 1000 + index;
          const compositionId = 2000 + index;
          catalogRows.push({
            id: catalogId,
            name: row.medication_name,
            generic_name: row.medication_name,
            composition_id: compositionId,
            strength: null,
            strength_key: null,
            form: null,
            form_key: null,
            release_key: null,
            route: null,
            updated_at: SNAPSHOT_AT,
          });
          compositionRows.push({
            id: compositionId,
            composition_key: `fixture-${compositionId}`,
            active_ingredients: [String(row.medication_name).toLowerCase()],
            updated_at: SNAPSHOT_AT,
          });
          return {
            source: 'e_prescription',
            source_id: String(40 + index),
            source_revision: '1',
            lineage_id: `e_prescription:${40 + index}`,
            line_index: String(index),
            medication_name: row.medication_name,
            catalog_id: String(catalogId),
            source_status: 'active',
            lifecycle_status: 'signed',
            effective_start: '2026-08-29T08:00:00.000Z',
            effective_end: null,
            line_payload: {
              _patient_uid_resolved: true,
              _source_start_authoritative: true,
            },
          };
        });
    }
    if (/FROM chemo_administrations/.test(statement)) return [];
    if (/FROM pharmacy_catalog/.test(statement) && /FOR KEY SHARE/.test(statement)) {
      return catalogRows;
    }
    if (/FROM drug_compositions/.test(statement) && /FOR KEY SHARE/.test(statement)) {
      return compositionRows;
    }
    return nextQueued();
  });
}

function validatePrescriptionSafety(patientId, medications, options = {}) {
  return validatePrescriptionSafetyImpl(patientId, medications, {
    tenantId: TENANT_ID,
    ...options,
  });
}

beforeEach(() => {
  getUnifiedActiveAllergiesDetailedMock.mockClear();
  noAllergies();
  defaultKb();
  resolveDrugKeysMock.mockReset().mockImplementation(async ({ medications }) => ({
    enabled: true,
    resolutions: medications.map((medication) => ({
      catalog_id: medication.catalog_id,
      drug_keys: [String(medication.medication_name || medication.name).toLowerCase()],
      tier: 'explicit_link',
    })),
  }));
  isCompositionSearchEnabledMock.mockReset().mockResolvedValue(false);
  enrichMedicationsWithCompositionMock.mockReset().mockImplementation(async (_tenantId, medications) => medications);
  resolveCompositionIdentitiesByCatalogIdsMock.mockReset().mockResolvedValue(new Map());
  queueRaw();
});

// ---- 1. Structured allergy severity tiers --------------------------------

describe('structured allergy conflict — severity classification', () => {
  it.each([
    ['SEVERE', 'blocker'],
    ['LIFE_THREATENING', 'blocker'],
    ['ANAPHYLAXIS', 'blocker'],
    ['CONTRAINDICATED', 'blocker'],
  ])('classifies %s allergy match as a %s', async (severity, kind) => {
    getUnifiedActiveAllergiesMock.mockResolvedValue([
      { allergen: 'Penicillin', severity, sources: ['patient_allergies'] },
    ]);
    const result = await validatePrescriptionSafety(106, [
      { name: 'Penicillin V 500mg' },
    ]);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'ALLERGY_CONFLICT', allergy: 'Penicillin', severity }),
      ]),
    );
    expect(result.warnings.filter((w) => w.type === 'ALLERGY_CONFLICT')).toHaveLength(0);
    expect(kind).toBe('blocker'); // documents intent
    expect(result.safe).toBe(false);
  });

  it.each([
    ['MILD'],
    ['MODERATE'],
    ['UNKNOWN'],
    [null],
  ])('classifies %s allergy match as a warning (not a blocker)', async (severity) => {
    getUnifiedActiveAllergiesMock.mockResolvedValue([
      { allergen: 'Penicillin', severity, sources: ['users.allergies'] },
    ]);
    const result = await validatePrescriptionSafety(106, [
      { medication_name: 'Penicillin G' },
    ]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'ALLERGY_CONFLICT',
          allergy: 'Penicillin',
          severity: severity || 'UNKNOWN',
        }),
      ]),
    );
    expect(result.blockers.filter((b) => b.type === 'ALLERGY_CONFLICT')).toHaveLength(0);
  });

  it('matches when allergen contains the medication name (reverse substring)', async () => {
    getUnifiedActiveAllergiesMock.mockResolvedValue([
      { allergen: 'amoxicillin trihydrate', severity: 'SEVERE', sources: ['allergies'] },
    ]);
    const result = await validatePrescriptionSafety(106, [{ name: 'amoxicillin' }]);
    expect(result.blockers.some((b) => b.type === 'ALLERGY_CONFLICT')).toBe(true);
  });

  it('does not flag when allergen and medication do not overlap', async () => {
    getUnifiedActiveAllergiesMock.mockResolvedValue([
      { allergen: 'sulfa', severity: 'SEVERE', sources: ['patient_allergies'] },
    ]);
    const result = await validatePrescriptionSafety(106, [{ name: 'Paracetamol 650' }]);
    expect(result.blockers).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.safe).toBe(true);
  });

  it('does not spuriously match every allergy for a medication line with no name', async () => {
    // Regression: an empty medName made `allergyName.includes("")` always true,
    // flagging a nameless med against EVERY allergy (a false HARD BLOCKER when an
    // allergy is severe). The nameless line must now be skipped.
    getUnifiedActiveAllergiesMock.mockResolvedValue([
      { allergen: 'Penicillin', severity: 'ANAPHYLAXIS', sources: ['patient_allergies'] },
    ]);
    const result = await validatePrescriptionSafety(106, [{ dosage: '1 tab', medication_name: '' }]);
    expect(result.blockers.filter((b) => b.type === 'ALLERGY_CONFLICT')).toHaveLength(0);
    expect(result.warnings.filter((w) => w.type === 'ALLERGY_CONFLICT')).toHaveLength(0);
  });

  it('does not match a real medication against an empty-string allergen', async () => {
    // Symmetric guard: an empty allergen made `medName.includes("")` always true.
    getUnifiedActiveAllergiesMock.mockResolvedValue([
      { allergen: '', severity: 'SEVERE', sources: ['patient_allergies'] },
    ]);
    const result = await validatePrescriptionSafety(106, [{ name: 'Amoxicillin' }]);
    expect(result.blockers.filter((b) => b.type === 'ALLERGY_CONFLICT')).toHaveLength(0);
    expect(result.warnings.filter((w) => w.type === 'ALLERGY_CONFLICT')).toHaveLength(0);
  });
});

// ---- 1b. Unstructured note allergen scan + dedup -------------------------

describe('unstructured note allergen scan', () => {
  it('blocks a beta-lactam when a note records a penicillin allergy (cross-reactivity)', async () => {
    // Note scan returns one appointment row containing "Allergy: Penicillin".
    queueRaw([{ source: 'appointment', body: 'Pt c/o fever. Allergy: Penicillin. Reviewed.' }]);
    const result = await validatePrescriptionSafety(106, [
      { name: 'Amoxicillin 500mg' }, // beta-lactam — cross-reacts with penicillin
    ]);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'ALLERGY_CONFLICT_UNSTRUCTURED',
          allergy: 'penicillin',
          severity: 'UNSTRUCTURED',
        }),
      ]),
    );
    expect(result.safe).toBe(false);
  });

  it('skips the unstructured blocker when the structured check already flagged the same pair', async () => {
    // Structured allergy already produces an ALLERGY_CONFLICT for amoxicillin.
    getUnifiedActiveAllergiesMock.mockResolvedValue([
      { allergen: 'amoxicillin', severity: 'SEVERE', sources: ['patient_allergies'] },
    ]);
    // Note also mentions the same allergen — the alreadyFlagged guard must skip it.
    queueRaw([{ source: 'clinical_note', body: 'Allergic to amoxicillin' }]);
    const result = await validatePrescriptionSafety(106, [{ name: 'amoxicillin' }]);
    const unstructured = result.blockers.filter((b) => b.type === 'ALLERGY_CONFLICT_UNSTRUCTURED');
    expect(unstructured).toHaveLength(0);
    // The structured blocker is still present.
    expect(result.blockers.some((b) => b.type === 'ALLERGY_CONFLICT')).toBe(true);
  });

  it('does not flag a note allergen that does not conflict with the prescription', async () => {
    queueRaw([{ source: 'appointment', body: 'Allergy: peanuts' }]);
    const result = await validatePrescriptionSafety(106, [{ name: 'Paracetamol' }]);
    expect(result.blockers).toHaveLength(0);
    expect(result.safe).toBe(true);
  });

  it('ignores note bodies with no extractable allergen (empty noteAllergens set)', async () => {
    queueRaw([{ source: 'appointment', body: 'Routine review, no complaints.' }]);
    const result = await validatePrescriptionSafety(106, [{ name: 'Amoxicillin' }]);
    expect(result.blockers).toHaveLength(0);
  });
});

describe('active-therapy authority', () => {
  it('fails closed when explicit tenant authority is missing', async () => {
    const result = await validatePrescriptionSafetyImpl(106, [{ name: 'Cetirizine' }]);
    expect(result.safe).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'ACTIVE_THERAPY_CONTEXT_UNAVAILABLE', severity: 'HIGH' }),
    ]));
  });
});

// ---- 2. Duplicate active-medication detection ----------------------------

describe('duplicate active-medication detection', () => {
  it('warns when the medication is already actively prescribed (case-insensitive)', async () => {
    // #1 note scan = [], #2 active-therapy snapshot = one matching row.
    queueRaw([], [{ medication_name: 'Amoxicillin 500mg' }]);
    const result = await validatePrescriptionSafety(106, [
      { name: 'amoxicillin 500mg' }, // different case — still a duplicate
    ]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'DUPLICATE_MEDICATION',
          medication: 'amoxicillin 500mg',
        }),
      ]),
    );
    // Duplicate alone is a warning, not a blocker.
    expect(result.blockers).toHaveLength(0);
    expect(result.safe).toBe(true);
  });

  it('does not warn when the active list has a different medication', async () => {
    queueRaw([], [{ medication_name: 'Pantoprazole 40mg' }]);
    const result = await validatePrescriptionSafety(106, [{ name: 'Amoxicillin 500mg' }]);
    expect(result.warnings.filter((w) => w.type === 'DUPLICATE_MEDICATION')).toHaveLength(0);
  });

  it('tolerates a null medication_name in the active-prescription row', async () => {
    queueRaw([], [{ medication_name: null }]);
    const result = await validatePrescriptionSafety(106, [{ name: 'Amoxicillin' }]);
    expect(result.warnings.filter((w) => w.type === 'DUPLICATE_MEDICATION')).toHaveLength(0);
  });
});

// ---- 3. Paediatric weight-based dose checks ------------------------------

describe('paediatric weight-based dose blockers', () => {
  // loadPaediatricContext order: age query (#3), then weight query (#3b).
  // Sequence: [noteScan], [activeTherapies], [ageRow], [weightRow], ...
  function paedSequence(ageYears, weightKg, extraTail = []) {
    return [
      [], // note scan
      [], // active therapies
      [{ age_years: ageYears }], // paediatric age
      [{ weight_kg: weightKg }], // paediatric weight
      ...extraTail,
    ];
  }

  it('blocks a flat mg dose that exceeds 1.2x the mg/kg ceiling', async () => {
    // Paracetamol ceiling 15 mg/kg; 10 kg child → max 150 mg/dose, 1.2x = 180.
    // 500 mg flat tablet dose → blocker.
    queueRaw(...paedSequence(3, 10));
    const result = await validatePrescriptionSafety(106, [
      { name: 'Paracetamol', dose: '500 mg' },
    ]);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'PAEDIATRIC_DOSE_HIGH',
          medication: 'Paracetamol',
          patient_weight_kg: 10,
          patient_age_years: 3,
          entered_dose_mg: 500,
        }),
      ]),
    );
    expect(result.safe).toBe(false);
  });

  it('does not block a flat mg dose within the ceiling', async () => {
    queueRaw(...paedSequence(3, 10));
    const result = await validatePrescriptionSafety(106, [
      { name: 'Paracetamol', dose: '120 mg' }, // < 150 mg ceiling
    ]);
    expect(result.blockers.filter((b) => b.type === 'PAEDIATRIC_DOSE_HIGH')).toHaveLength(0);
  });

  it('converts an ml dose via the name-embedded strength and blocks an overdose', async () => {
    // "125mg/5ml" → 25 mg/ml. 15 ml → 375 mg in a 10 kg child (ceiling 150,
    // 1.2x=180) → blocker. Also exercises parseStrengthMgPerMl(name).
    queueRaw(...paedSequence(2, 10));
    const result = await validatePrescriptionSafety(106, [
      { name: 'Paracetamol syrup 125mg/5ml', dose: '15 ml' },
    ]);
    expect(result.blockers.some((b) => b.type === 'PAEDIATRIC_DOSE_HIGH')).toBe(true);
  });

  it('flags a liquid mg/ml mismatch (entered mg and ml disagree with strength)', async () => {
    // strength 25 mg/ml; doctor wrote "250 mg" AND "2 ml". 250 mg should be
    // 10 ml, not 2 ml → PAEDIATRIC_LIQUID_DOSE_MISMATCH blocker.
    queueRaw(...paedSequence(4, 14));
    const result = await validatePrescriptionSafety(106, [
      {
        name: 'Paracetamol',
        strength_mg_per_ml: 25,
        dose: '250 mg 2 ml',
      },
    ]);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'PAEDIATRIC_LIQUID_DOSE_MISMATCH',
          medication: 'Paracetamol',
          entered_mg: 250,
          entered_ml: 2,
        }),
      ]),
    );
  });

  it('skips dose checks for a drug not in the paediatric seed table', async () => {
    queueRaw(...paedSequence(3, 10));
    const result = await validatePrescriptionSafety(106, [
      { name: 'Pantoprazole', dose: '500 mg' }, // not in PAEDIATRIC_MG_PER_KG
    ]);
    expect(result.blockers.filter((b) => b.type?.startsWith('PAEDIATRIC'))).toHaveLength(0);
  });

  it('skips the whole paediatric block when no recorded weight exists', async () => {
    // age query returns a child, but the weight query returns no usable weight
    // → loadPaediatricContext returns null → paedCtx falsy → block skipped.
    queueRaw([], [], [{ age_years: 3 }], [{ weight_kg: null }]);
    const result = await validatePrescriptionSafety(106, [
      { name: 'Paracetamol', dose: '500 mg' },
    ]);
    expect(result.blockers.filter((b) => b.type?.startsWith('PAEDIATRIC'))).toHaveLength(0);
  });

  it('skips the paediatric block for a patient aged 12 or older', async () => {
    // age >= 12 → loadPaediatricContext returns null before the weight query.
    queueRaw([], [], [{ age_years: 14 }]);
    const result = await validatePrescriptionSafety(106, [
      { name: 'Paracetamol', dose: '500 mg' },
    ]);
    expect(result.blockers.filter((b) => b.type?.startsWith('PAEDIATRIC'))).toHaveLength(0);
  });

  it('uses an mg/kg dose string against the weight (parseDoseToMg mg/kg path)', async () => {
    // "20 mg/kg" * 10 kg = 200 mg; ceiling 15*10*1.2 = 180 → blocker.
    queueRaw(...paedSequence(3, 10));
    const result = await validatePrescriptionSafety(106, [
      { name: 'Paracetamol', dose: '20 mg/kg' },
    ]);
    expect(result.blockers.some((b) => b.type === 'PAEDIATRIC_DOSE_HIGH')).toBe(true);
  });

  it('skips a med whose dose text has no parseable value', async () => {
    queueRaw(...paedSequence(3, 10));
    const result = await validatePrescriptionSafety(106, [
      { name: 'Paracetamol', dose: 'as directed' },
    ]);
    expect(result.blockers.filter((b) => b.type?.startsWith('PAEDIATRIC'))).toHaveLength(0);
  });

  it('skips an ml-only dose when no strength can be resolved (parseDoseToMg ml→null)', async () => {
    // ml dose with no strength_mg_per_ml field and no mg/ml token in the name
    // → parseDoseToMg returns null (line 85) → dose check silently skips.
    queueRaw(...paedSequence(3, 10));
    const result = await validatePrescriptionSafety(106, [
      { name: 'Paracetamol', dose: '5 ml' }, // no strength anywhere
    ]);
    expect(result.blockers.filter((b) => b.type?.startsWith('PAEDIATRIC'))).toHaveLength(0);
  });

  it('fails closed when the paediatric weight query rejects', async () => {
    queueRaw([], [], [{ age_years: 3 }], new Error('weight query exploded'));
    const result = await validatePrescriptionSafety(106, [
      { name: 'Paracetamol', dose: '500 mg' },
    ]);
    expect(result.safe).toBe(false);
    expect(result.blockers.some((b) => b.type === 'SAFETY_CHECK_ERROR')).toBe(true);
  });
});

describe('required clinical context loaders fail closed', () => {
  it('does not treat a pregnancy-context query failure as no pregnancy', async () => {
    // #1 note, #2 active therapies, #3 age(>=12), #4 pregnancy REJECTS, #5 renal.
    queueRaw([], [], [{ age_years: 40 }], new Error('pregnancy query exploded'), [{ labs: [] }]);
    const result = await validatePrescriptionSafety(106, [{ name: 'Warfarin 5mg' }]);
    expect(result.safe).toBe(false);
    expect(result.blockers.some((b) => b.type === 'SAFETY_CHECK_ERROR')).toBe(true);
  });

  it('does not treat a renal-context query failure as no evidence', async () => {
    // #1 note, #2 active therapies, #3 age(>=12), #4 pregnancy, #5 renal REJECTS.
    queueRaw(
      [], [], [{ age_years: 60 }],
      [{ gender: 'male', is_pregnant: false, age_years: 60, has_ongoing_pregnancy: false }],
      new Error('renal query exploded'),
    );
    const result = await validatePrescriptionSafety(106, [{ name: 'Ibuprofen 400mg' }]);
    expect(result.safe).toBe(false);
    expect(result.blockers.some((b) => b.type === 'SAFETY_CHECK_ERROR')).toBe(true);
  });
});

// ---- 4 + 5 + 6. Pregnancy / renal / antibiotic classifiers ---------------

describe('pregnancy medication safety classification', () => {
  // Sequence to reach pregnancy context with the right shape:
  //   [noteScan], [dupActives], [age], [pregnancyRow], [renalRow], ...
  // age query >= 12 so paediatric is skipped (single age query).
  it('blocks a HIGH-risk drug when active pregnancy is recorded', async () => {
    queueRaw(
      [], [], [{ age_years: 28 }],
      [{ gender: 'female', is_pregnant: true, age_years: 28, has_ongoing_pregnancy: false }],
      [{ labs: [] }],
    );
    const result = await validatePrescriptionSafety(106, [
      { name: 'Isotretinoin 20mg' },
    ]);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'PREGNANCY_MEDICATION_RISK', severity: 'HIGH' }),
      ]),
    );
  });

  it('warns (not blocks) on a MODERATE drug under active pregnancy', async () => {
    queueRaw(
      [], [], [{ age_years: 30 }],
      [{ gender: 'female', is_pregnant: true, age_years: 30, has_ongoing_pregnancy: false }],
      [{ labs: [] }],
    );
    const result = await validatePrescriptionSafety(106, [
      { name: 'Atorvastatin 10mg' }, // MODERATE
    ]);
    expect(result.warnings.some((w) => w.type === 'PREGNANCY_MEDICATION_RISK' && w.severity === 'MODERATE')).toBe(true);
    expect(result.blockers.filter((b) => b.type === 'PREGNANCY_MEDICATION_RISK')).toHaveLength(0);
  });

  it('warns with PREGNANCY_STATUS_REVIEW for a reproductive-age woman of unknown status', async () => {
    queueRaw(
      [], [], [{ age_years: 25 }],
      [{ gender: 'female', is_pregnant: false, age_years: 25, has_ongoing_pregnancy: false }],
      [{ labs: [] }],
    );
    const result = await validatePrescriptionSafety(106, [
      { name: 'Warfarin 5mg' }, // HIGH drug, but no active pregnancy → status review warning
    ]);
    expect(result.warnings.some((w) => w.type === 'PREGNANCY_STATUS_REVIEW')).toBe(true);
    expect(result.blockers.filter((b) => b.type === 'PREGNANCY_MEDICATION_RISK')).toHaveLength(0);
  });

  it('does not flag pregnancy risk for a male patient', async () => {
    queueRaw(
      [], [], [{ age_years: 40 }],
      [{ gender: 'male', is_pregnant: false, age_years: 40, has_ongoing_pregnancy: false }],
      [{ labs: [] }],
    );
    const result = await validatePrescriptionSafety(106, [{ name: 'Warfarin 5mg' }]);
    expect(result.warnings.filter((w) => String(w.type).startsWith('PREGNANCY'))).toHaveLength(0);
  });
});

describe('renal medication safety classification', () => {
  it('blocks a HIGH renal drug under severe impairment (eGFR < 30)', async () => {
    queueRaw(
      [], [], [{ age_years: 70 }],
      [{ gender: 'male', is_pregnant: false, age_years: 70, has_ongoing_pregnancy: false }],
      [{ labs: [{ test_name: 'eGFR', test_code: 'EGFR', value_numeric: '20', unit: 'mL/min' }] }],
    );
    const result = await validatePrescriptionSafety(106, [
      { name: 'Ketorolac injection' }, // HIGH renal risk
    ]);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'RENAL_MEDICATION_REVIEW', latest_egfr: 20 }),
      ]),
    );
  });

  it('warns (not blocks) a MODERATE renal drug even under severe impairment', async () => {
    queueRaw(
      [], [], [{ age_years: 65 }],
      [{ gender: 'male', is_pregnant: false, age_years: 65, has_ongoing_pregnancy: false }],
      [{ labs: [{ test_name: 'Creatinine', test_code: 'CREAT', value_numeric: '3.0', unit: 'mg/dL' }] }],
    );
    const result = await validatePrescriptionSafety(106, [
      { name: 'Ibuprofen 400mg' }, // MODERATE renal risk
    ]);
    expect(result.warnings.some((w) => w.type === 'RENAL_MEDICATION_REVIEW')).toBe(true);
    expect(result.blockers.filter((b) => b.type === 'RENAL_MEDICATION_REVIEW')).toHaveLength(0);
  });

  it('warns RENAL_EVIDENCE_MISSING when no recent renal lab exists', async () => {
    queueRaw(
      [], [], [{ age_years: 60 }],
      [{ gender: 'male', is_pregnant: false, age_years: 60, has_ongoing_pregnancy: false }],
      [{ labs: [] }], // no labs → evidenceFound:false
    );
    const result = await validatePrescriptionSafety(106, [
      { name: 'Gentamicin injection' },
    ]);
    expect(result.warnings.some((w) => w.type === 'RENAL_EVIDENCE_MISSING')).toBe(true);
  });
});

describe('antibiotic stewardship classification', () => {
  it('warns on missing duration and on a reserve antibiotic', async () => {
    const result = await validatePrescriptionSafety(106, [
      { name: 'Meropenem injection' }, // reserve, no days
    ]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'ANTIBIOTIC_DURATION_MISSING' }),
        expect.objectContaining({ type: 'ANTIBIOTIC_STEWARDSHIP_RESERVE', severity: 'HIGH' }),
      ]),
    );
    expect(result.safe).toBe(true); // stewardship items never block
  });

  it('warns on a long (>14 day) antibiotic course', async () => {
    const result = await validatePrescriptionSafety(106, [
      { name: 'Doxycycline', days: 30 },
    ]);
    expect(result.warnings.some((w) => w.type === 'ANTIBIOTIC_LONG_DURATION' && w.duration_days === 30)).toBe(true);
  });

  it('warns on duplicate-spectrum antibiotics from the same class', async () => {
    const result = await validatePrescriptionSafety(106, [
      { name: 'Ciprofloxacin', days: 5 },
      { name: 'Levofloxacin', days: 5 }, // both fluoroquinolone
    ]);
    expect(result.warnings.some((w) => w.type === 'ANTIBIOTIC_DUPLICATE_SPECTRUM')).toBe(true);
  });

  it('parses days from a free-text duration string ("5 days")', async () => {
    const result = await validatePrescriptionSafety(106, [
      { name: 'Amoxicillin', duration: '5 days' }, // parseable → no DURATION_MISSING
    ]);
    expect(result.warnings.filter((w) => w.type === 'ANTIBIOTIC_DURATION_MISSING')).toHaveLength(0);
  });
});

// ---- 8. Drug-KB findings → blocker/warning classification ----------------

describe('drug knowledge base findings classification (check 8)', () => {
  it('maps a contraindicated interaction finding to a blocker', async () => {
    evaluateDrugKbMock.mockReset().mockResolvedValue({
      kbAvailable: true,
      findings: [{
        check: 'interaction',
        severity: 'contraindicated',
        medications: ['DrugA', 'DrugB'],
        message: 'A + B contraindicated',
      }],
    });
    const result = await validatePrescriptionSafety(106, [
      { name: 'DrugA' }, { name: 'DrugB' },
    ]);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'DRUG_INTERACTION_KB', severity: 'CONTRAINDICATED' }),
      ]),
    );
    expect(result.safe).toBe(false);
  });

  it('maps a moderate interaction finding to a warning', async () => {
    evaluateDrugKbMock.mockReset().mockResolvedValue({
      kbAvailable: true,
      findings: [{
        check: 'interaction',
        severity: 'moderate',
        medications: ['DrugA', 'DrugB'],
        message: 'A + B moderate',
      }],
    });
    const result = await validatePrescriptionSafety(106, [{ name: 'DrugA' }, { name: 'DrugB' }]);
    expect(result.warnings.some((w) => w.type === 'DRUG_INTERACTION_KB')).toBe(true);
    expect(result.blockers.filter((b) => b.type === 'DRUG_INTERACTION_KB')).toHaveLength(0);
  });

  it('skips an interaction finding where every involved drug is antithrombotic', async () => {
    // Both classify antithrombotic → check 4 owns the pair → KB dup skipped.
    evaluateDrugKbMock.mockReset().mockResolvedValue({
      kbAvailable: true,
      findings: [{
        check: 'interaction',
        severity: 'major',
        medications: ['Aspirin', 'Warfarin'],
        message: 'aspirin + warfarin',
      }],
    });
    const result = await validatePrescriptionSafety(106, [
      { name: 'Aspirin' }, { name: 'Warfarin' },
    ]);
    // No DRUG_INTERACTION_KB issue — the antithrombotic check owns this pair.
    expect(result.blockers.filter((b) => b.type === 'DRUG_INTERACTION_KB')).toHaveLength(0);
    expect(result.warnings.filter((w) => w.type === 'DRUG_INTERACTION_KB')).toHaveLength(0);
  });

  it('maps a high allergy_cross_sensitivity finding to a blocker', async () => {
    evaluateDrugKbMock.mockReset().mockResolvedValue({
      kbAvailable: true,
      findings: [{
        check: 'allergy_cross_sensitivity',
        severity: 'high',
        medications: ['Cefixime'],
        allergen: 'penicillin',
        message: 'cefixime cross-reacts with penicillin',
      }],
    });
    const result = await validatePrescriptionSafety(106, [{ name: 'Cefixime' }]);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'ALLERGY_CROSS_SENSITIVITY_KB', severity: 'HIGH' }),
      ]),
    );
  });

  it('skips a cross-sensitivity finding already flagged by the structured allergy check', async () => {
    // Structured allergy produces ALLERGY_CONFLICT for cefixime+penicillin...
    getUnifiedActiveAllergiesMock.mockResolvedValue([
      { allergen: 'cefixime', severity: 'MODERATE', sources: ['patient_allergies'] },
    ]);
    // ...and the KB reports the same medication+allergen pair → dedup skip.
    evaluateDrugKbMock.mockReset().mockResolvedValue({
      kbAvailable: true,
      findings: [{
        check: 'allergy_cross_sensitivity',
        severity: 'high',
        medications: ['cefixime'],
        allergen: 'cefixime',
        message: 'dup',
      }],
    });
    const result = await validatePrescriptionSafety(106, [{ name: 'cefixime' }]);
    expect(result.blockers.filter((b) => b.type === 'ALLERGY_CROSS_SENSITIVITY_KB')).toHaveLength(0);
  });

  it('maps a contraindicated condition_caution finding to a blocker', async () => {
    evaluateDrugKbMock.mockReset().mockResolvedValue({
      kbAvailable: true,
      findings: [{
        check: 'condition_caution',
        severity: 'contraindicated',
        medications: ['Metformin'],
        message: 'metformin contraindicated in CKD',
      }],
    });
    const result = await validatePrescriptionSafety(106, [{ name: 'Metformin' }]);
    expect(result.blockers.some((b) => b.type === 'DRUG_DISEASE_KB')).toBe(true);
  });

  it('maps a major dose_range finding to a blocker and a moderate one to a warning', async () => {
    evaluateDrugKbMock.mockReset().mockResolvedValue({
      kbAvailable: true,
      findings: [
        { check: 'dose_range', severity: 'major', medications: ['DrugX'], message: 'too high' },
        { check: 'dose_range', severity: 'moderate', medications: ['DrugY'], message: 'a bit high' },
      ],
    });
    const result = await validatePrescriptionSafety(106, [{ name: 'DrugX' }, { name: 'DrugY' }]);
    expect(result.blockers.filter((b) => b.type === 'DOSE_RANGE_KB')).toHaveLength(1);
    expect(result.warnings.filter((w) => w.type === 'DOSE_RANGE_KB')).toHaveLength(1);
  });

  it('maps an unrecognised check to the IV-compatibility warning bucket', async () => {
    evaluateDrugKbMock.mockReset().mockResolvedValue({
      kbAvailable: true,
      findings: [{
        check: 'iv_compatibility',
        severity: 'moderate',
        medications: ['DrugP', 'DrugQ'],
        message: 'incompatible at Y-site',
      }],
    });
    const result = await validatePrescriptionSafety(106, [{ name: 'DrugP' }, { name: 'DrugQ' }]);
    expect(result.warnings.some((w) => w.type === 'IV_COMPATIBILITY_KB')).toBe(true);
  });

  it('queries patient_problems when the patient has a uid (check 8 problem path)', async () => {
    // Drive check 8's uid + problem path: patient row carries a uid, the
    // patient_problems query returns an active problem. KB still returns no
    // findings, so we only assert the calls were made without error.
    queueRaw(
      [], // note scan
      [], // active therapies
      [{ age_years: 40 }], // paediatric age (>=12, no weight query)
      [{ gender: 'male', is_pregnant: false, age_years: 40, has_ongoing_pregnancy: false }], // pregnancy
      [{ labs: [] }], // renal
      [{ uid: '11111111-1111-1111-1111-111111111111', age_years: 40 }], // check 8 patient row
      [{ icd10_code: 'N18.5', title: 'CKD stage 5' }], // patient_problems
    );
    evaluateDrugKbMock.mockReset().mockResolvedValue({ kbAvailable: true, findings: [] });
    const result = await validatePrescriptionSafety(106, [{ name: 'Metformin' }]);
    expect(result.safe).toBe(true);
    // evaluateDrugKb received the active problems we returned.
    expect(evaluateDrugKbMock).toHaveBeenCalledWith(
      expect.objectContaining({
        problems: [{ icd10_code: 'N18.5', title: 'CKD stage 5' }],
      }),
    );
  });

  it('fails closed when the patient-problem evidence table is unavailable', async () => {
    const missing = new Error('relation "patient_problems" does not exist');
    queueRaw(
      [], [], [{ age_years: 40 }],
      [{ gender: 'male', is_pregnant: false, age_years: 40, has_ongoing_pregnancy: false }],
      [{ labs: [] }],
      [{ uid: '22222222-2222-2222-2222-222222222222', age_years: 40 }], // patient row
      missing,
    );
    evaluateDrugKbMock.mockReset().mockResolvedValue({ kbAvailable: true, findings: [] });
    const result = await validatePrescriptionSafety(106, [{ name: 'Metformin' }]);
    expect(result.safe).toBe(false);
    expect(result.blockers.some((b) => b.type === 'DRUG_KB_CHECK_ERROR')).toBe(true);
  });

  it('blocks when the authoritative drug knowledge base reports unavailable', async () => {
    evaluateDrugKbMock.mockReset().mockResolvedValue({ kbAvailable: false, findings: [] });
    const result = await validatePrescriptionSafety(106, [{ name: 'Amoxicillin' }]);
    expect(result.safe).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'DRUG_KB_UNAVAILABLE', severity: 'HIGH' }),
    ]));
  });

  it('blocks when the drug knowledge base evaluation throws', async () => {
    evaluateDrugKbMock.mockReset().mockRejectedValue(new Error('kb boom'));
    const result = await validatePrescriptionSafety(106, [{ name: 'Amoxicillin' }]);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'DRUG_KB_CHECK_ERROR', severity: 'HIGH' }),
      ]),
    );
    expect(result.safe).toBe(false);
  });
});

// ---- Outer catch: fail-closed --------------------------------------------

describe('outer catch — fail closed on safety-check failure', () => {
  it('fails closed when enabled composition screening is unavailable', async () => {
    isCompositionSearchEnabledMock.mockResolvedValueOnce(true);
    enrichMedicationsWithCompositionMock.mockRejectedValueOnce(new Error('composition lookup exploded'));
    queueRaw([], []);

    const result = await validatePrescriptionSafety(
      106,
      [{ name: 'Amoxicillin', catalog_id: 10 }],
      { tenantId: '00000000-0000-4000-8000-000000000001' },
    );

    expect(result.safe).toBe(false);
    expect(result.blockers.some((b) => b.type === 'SAFETY_CHECK_ERROR')).toBe(true);
  });

  it('returns safe:false with a SAFETY_CHECK_ERROR blocker when allergy fetch throws', async () => {
    // getUnifiedActiveAllergies is documented never to throw, but if it does
    // the outer try/catch must fail closed rather than silently pass.
    getUnifiedActiveAllergiesMock.mockReset().mockRejectedValue(new Error('allergy lookup exploded'));
    const result = await validatePrescriptionSafety(106, [{ name: 'Amoxicillin' }]);
    expect(result.safe).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'SAFETY_CHECK_ERROR' }),
      ]),
    );
  });

  it('fails closed when the active-therapy source query throws', async () => {
    // #1 note scan ok ([]), #2 active-therapy source query rejects → outer catch.
    queueRaw([], new Error('active therapy query exploded'));
    const result = await validatePrescriptionSafety(106, [{ name: 'Amoxicillin' }]);
    expect(result.safe).toBe(false);
    expect(result.blockers.some((b) => b.type === 'SAFETY_CHECK_ERROR')).toBe(true);
  });
});

// ---- Combined / aggregate behaviour --------------------------------------

describe('aggregate behaviour', () => {
  it('aggregates warnings + blockers across multiple checks and reports safe:false', async () => {
    // Structured MILD allergy (warning) + a paediatric overdose (blocker) +
    // a duplicate active (warning) + a long antibiotic course (warning).
    getUnifiedActiveAllergiesMock.mockResolvedValue([
      { allergen: 'paracetamol', severity: 'MILD', sources: ['users.allergies'] },
    ]);
    queueRaw(
      [], // note scan
      [{ medication_name: 'Paracetamol' }], // active therapy (matches)
      [{ age_years: 3 }], // paed age
      [{ weight_kg: 10 }], // paed weight
    );
    const result = await validatePrescriptionSafety(106, [
      { name: 'Paracetamol', dose: '500 mg' }, // overdose for 10kg child + dup + MILD allergy
    ]);
    expect(result.safe).toBe(false);
    expect(result.blockers.some((b) => b.type === 'PAEDIATRIC_DOSE_HIGH')).toBe(true);
    expect(result.warnings.some((w) => w.type === 'DUPLICATE_MEDICATION')).toBe(true);
    expect(result.warnings.some((w) => w.type === 'ALLERGY_CONFLICT' && w.severity === 'MILD')).toBe(true);
  });

  it('returns safe:true with empty arrays for a benign single medication', async () => {
    const result = await validatePrescriptionSafety(106, [
      { name: 'Cetirizine tablet', days: 5 },
    ]);
    expect(result).toMatchObject({ safe: true, warnings: [], blockers: [] });
  });

  it('skips medications with no resolvable display name when there are no allergies', async () => {
    // A nameless med object contributes nothing to the display-name-guarded
    // checks (pregnancy / renal / antibiotic / paediatric). With no recorded
    // allergies the structured-allergy loop (check 1) is bypassed entirely
    // (allergies.length === 0), so a nameless line is a clean no-op here.
    // The structured-allergy loop also skips nameless lines, so this remains a
    // clean no-op if allergy data is added to the fixture later.
    getUnifiedActiveAllergiesMock.mockResolvedValue([]);
    const result = await validatePrescriptionSafety(106, [{ frequency: 'OD' }]);
    expect(result.blockers).toHaveLength(0);
    expect(result.safe).toBe(true);
  });
});
