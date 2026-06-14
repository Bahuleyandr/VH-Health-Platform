// Unit coverage for src/services/emr/cdsEngine.js (roadmap B3.2).
//
// cdsEngine is the Clinical Decision Support rule engine: drug-interaction,
// allergy, duplicate-order, recent-result, critical-lab, and protocol-reminder
// evaluators, plus the alert persistence helper and the acknowledge/list
// surfaces. It was ~33% statements — the rule evaluators that query patient
// clinical data (lines ~555-902, 1003-1099) were entirely uncovered. The
// integration path goes through the EMR controllers + a live DB; this file is a
// *self-contained* unit suite with a fully-mocked Prisma so a SCOPED coverage
// run (which executes only this file) drives the whole service to >=80%
// statements without needing the QA DB.
//
// Prisma-mock convention matches the sibling unit tests
// (adminOtpServiceCoverage.test.js / accessDecisionService.test.js):
//   jest.unstable_mockModule('../../lib/prisma.js', () => ({ default, setTenantTx, ... }))
// cdsEngine reads via prisma.<model>.findMany/findUnique and writes the
// acknowledge path through setTenantTx (delegated to the same mock client), so
// every typed-ORM call flows through the mocked models below.

import { jest } from '@jest/globals';

// ── Prisma mock ─────────────────────────────────────────────────────────────
// One mock client object, re-used for the setTenantTx delegate so the
// acknowledge transaction reads/writes the same canned rows.
const mockPrisma = {
  users: { findUnique: jest.fn() },
  admissions: { findMany: jest.fn() },
  allergies: { findMany: jest.fn() },
  patient_allergies: { findMany: jest.fn() },
  medication_administrations: { findMany: jest.fn() },
  prescriptions: { findMany: jest.fn() },
  drug_interactions: { findMany: jest.fn() },
  investigations: { findMany: jest.fn() },
  diagnoses: { findMany: jest.fn() },
  clinical_protocols: { findMany: jest.fn(), create: jest.fn() },
  cds_alerts: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn() },
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: mockPrisma,
  setTenant: async (_tenantId, fn) => fn(mockPrisma),
  setTenantTx: async (_tenantId, fn) => fn(mockPrisma),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(mockPrisma),
  pickTenantClient: () => mockPrisma,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// canonicalOperationalBridgeService.emitCdsAlertAcknowledged is a fire-and-forget
// downstream bridge — stub so acknowledgeAlert doesn't reach the prisma-backed
// implementation.
const emitCdsAlertAcknowledged = jest.fn(async () => {});
jest.unstable_mockModule('../../services/clinical/canonicalOperationalBridgeService.js', () => ({
  emitCdsAlertAcknowledged,
}));

// tenantService only exports a constant used as the fallback tenant for the
// acknowledge tx — keep the real value shape.
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID: '00000000-0000-4000-8000-000000000001',
}));

const cds = await import('../../services/emr/cdsEngine.js');

const PATIENT_UID = 'patient-uid-1';

// Default: every model returns []. Individual tests override the specific calls
// they exercise. resolveUserIdFromUid / persistCdsAlert both call
// users.findUnique — default it to a resolvable owner so persist paths run.
function resetMocks() {
  for (const model of Object.values(mockPrisma)) {
    for (const fn of Object.values(model)) {
      fn.mockReset();
      fn.mockResolvedValue([]);
    }
  }
  emitCdsAlertAcknowledged.mockClear();
  // users.findUnique is used both for tenant resolution (returns {tenant_id})
  // and uid→id resolution (returns {id}). A single object satisfying both is
  // fine for the default case.
  mockPrisma.users.findUnique.mockResolvedValue({ id: 7, tenant_id: 'tenant-7' });
  mockPrisma.cds_alerts.create.mockResolvedValue({ id: 1 });
}

beforeEach(() => {
  resetMocks();
});

// ── checkDrugInteractions ────────────────────────────────────────────────────
describe('checkDrugInteractions', () => {
  it('returns [] when medicationName or patientUid is missing', async () => {
    expect(await cds.checkDrugInteractions('', PATIENT_UID)).toEqual([]);
    expect(await cds.checkDrugInteractions('warfarin', '')).toEqual([]);
  });

  it('returns [] when the patient has no active medications', async () => {
    mockPrisma.medication_administrations.findMany.mockResolvedValue([]);
    mockPrisma.prescriptions.findMany.mockResolvedValue([]);
    expect(await cds.checkDrugInteractions('warfarin', PATIENT_UID)).toEqual([]);
  });

  it('skips the self-pair and maps each interaction severity tier', async () => {
    // Active meds come from MAR + prescriptions; one duplicates the ordered drug
    // (warfarin) to exercise the self-skip `continue`.
    mockPrisma.medication_administrations.findMany.mockResolvedValue([
      { medication_name: 'Warfarin' },
      { medication_name: 'Ibuprofen' },
    ]);
    mockPrisma.prescriptions.findMany.mockResolvedValue([
      { medication_name: 'Aspirin' },
      { medication_name: null }, // exercises the `if (row.medication_name)` falsy branch
    ]);

    // drug_interactions.findMany is called once per non-self active med. Return a
    // different severity tier per call so all four severity branches execute.
    mockPrisma.drug_interactions.findMany
      .mockResolvedValueOnce([
        // ibuprofen pair — drug_a matches the ordered drug → otherDrug = drug_b
        {
          id: 1, drug_a: 'warfarin', drug_b: 'ibuprofen', severity: 'contraindicated',
          description: 'avoid', clinical_effect: 'bleed', management: 'stop',
        },
      ])
      .mockResolvedValueOnce([
        // aspirin pair — drug_a is the OTHER drug → otherDrug = drug_a branch
        {
          id: 2, drug_a: 'aspirin', drug_b: 'warfarin', severity: 'moderate',
          description: 'monitor', clinical_effect: 'bleed', management: 'watch',
        },
      ]);

    const alerts = await cds.checkDrugInteractions('warfarin', PATIENT_UID);

    expect(alerts).toHaveLength(2);
    const contra = alerts.find((a) => a.sourceData.interaction_id === 1);
    expect(contra.severity).toBe('critical');
    expect(contra.canOverride).toBe(false); // contraindicated → cannot override
    expect(contra.title).toContain('ibuprofen');

    const moderate = alerts.find((a) => a.sourceData.interaction_id === 2);
    expect(moderate.severity).toBe('warning');
    expect(moderate.canOverride).toBe(true);
    expect(moderate.title).toContain('aspirin'); // otherDrug = drug_a branch
  });

  it('maps severe → critical and an unknown severity → info', async () => {
    mockPrisma.medication_administrations.findMany.mockResolvedValue([
      { medication_name: 'Heparin' },
      { medication_name: 'Digoxin' },
    ]);
    mockPrisma.prescriptions.findMany.mockResolvedValue([]);
    mockPrisma.drug_interactions.findMany
      .mockResolvedValueOnce([
        { id: 3, drug_a: 'warfarin', drug_b: 'heparin', severity: 'severe', description: 'd' },
      ])
      .mockResolvedValueOnce([
        { id: 4, drug_a: 'warfarin', drug_b: 'digoxin', severity: 'minor', description: 'd' },
      ]);

    const alerts = await cds.checkDrugInteractions('warfarin', PATIENT_UID);
    expect(alerts.find((a) => a.sourceData.interaction_id === 3).severity).toBe('critical');
    expect(alerts.find((a) => a.sourceData.interaction_id === 4).severity).toBe('info');
  });
});

// ── checkAllergies / getPatientAllergyEntries ────────────────────────────────
describe('checkAllergies', () => {
  it('returns [] when medicationName or patientUid is missing', async () => {
    expect(await cds.checkAllergies('', PATIENT_UID)).toEqual([]);
    expect(await cds.checkAllergies('amoxicillin', '')).toEqual([]);
  });

  it('returns [] when the patient has no allergy entries', async () => {
    // all three allergy sources empty
    expect(await cds.checkAllergies('amoxicillin', PATIENT_UID)).toEqual([]);
  });

  it('merges all three allergy sources and flags a direct substring match', async () => {
    mockPrisma.admissions.findMany.mockResolvedValue([
      { allergies: ['Penicillin', '', null] }, // '' / null skipped by normalizeAllergy guard
    ]);
    mockPrisma.allergies.findMany.mockResolvedValue([
      { allergen: 'Sulfa', name: 'ignored', severity: 'severe', reaction: 'rash' },
      { allergen: '   ', name: 'Latex', severity: null, reaction: null }, // blank allergen → falls back to name
    ]);
    mockPrisma.patient_allergies.findMany.mockResolvedValue([
      { allergy_name: 'Codeine', severity: 'moderate', reaction: 'nausea' },
    ]);

    // Order penicillin → direct match (drug contains allergen).
    const alerts = await cds.checkAllergies('penicillin', PATIENT_UID);
    const direct = alerts.find((a) => a.sourceData.match_type === 'direct');
    expect(direct).toBeDefined();
    expect(direct.severity).toBe('critical');
    expect(direct.sourceData.source).toBe('admissions');
  });

  it('raises a drug-class cross-sensitivity warning without duplicating a direct match', async () => {
    // Patient allergic to amoxicillin (a penicillin-class member). Order a
    // DIFFERENT penicillin (ampicillin) → class match, no direct match.
    mockPrisma.patient_allergies.findMany.mockResolvedValue([
      { allergy_name: 'amoxicillin', severity: 'severe', reaction: 'anaphylaxis' },
    ]);

    const alerts = await cds.checkAllergies('ampicillin', PATIENT_UID);
    const classAlert = alerts.find((a) => a.sourceData.match_type === 'class');
    expect(classAlert).toBeDefined();
    expect(classAlert.severity).toBe('warning');
    expect(classAlert.sourceData.drug_class).toBe('penicillin');
  });

  it('matches a class by the class-name allergy and dedups a direct hit', async () => {
    // Allergy recorded as the class name itself ("nsaid"); order ibuprofen
    // (nsaid member). Also a second allergy that direct-matches ibuprofen so the
    // alreadyCaught dedup branch runs.
    mockPrisma.patient_allergies.findMany.mockResolvedValue([
      { allergy_name: 'nsaid', severity: null, reaction: null },
      { allergy_name: 'ibuprofen', severity: 'mild', reaction: 'hives' },
    ]);

    const alerts = await cds.checkAllergies('ibuprofen', PATIENT_UID);
    // ibuprofen allergy → direct critical; nsaid allergy → class warning.
    expect(alerts.some((a) => a.sourceData.match_type === 'direct')).toBe(true);
    expect(alerts.some((a) => a.sourceData.match_type === 'class' && a.sourceData.allergy === 'nsaid')).toBe(true);
    // ibuprofen was already caught directly → no class alert for the 'ibuprofen' allergy entry.
    const dupClass = alerts.filter((a) => a.sourceData.match_type === 'class' && a.sourceData.allergy === 'ibuprofen');
    expect(dupClass).toHaveLength(0);
  });
});

// ── checkDuplicateOrders ─────────────────────────────────────────────────────
describe('checkDuplicateOrders', () => {
  it('returns [] when orderType or patientUid is missing', async () => {
    expect(await cds.checkDuplicateOrders('', {}, PATIENT_UID)).toEqual([]);
    expect(await cds.checkDuplicateOrders('medication', {}, '')).toEqual([]);
  });

  it('returns [] for a medication order with no medication_name', async () => {
    expect(await cds.checkDuplicateOrders('medication', {}, PATIENT_UID)).toEqual([]);
  });

  it('flags active prescriptions (warning) and scheduled MAR doses (info)', async () => {
    mockPrisma.prescriptions.findMany.mockResolvedValue([
      { id: 11, medication_name: 'aspirin', dosage: '75mg', frequency: 'OD', status: 'active', created_at: new Date() },
    ]);
    mockPrisma.medication_administrations.findMany.mockResolvedValue([
      { id: 22, medication_name: 'aspirin', dose: '75mg', status: 'scheduled', created_at: new Date() },
    ]);

    const alerts = await cds.checkDuplicateOrders('medication', { medication_name: 'Aspirin' }, PATIENT_UID);
    expect(alerts.find((a) => a.severity === 'warning').sourceData.existing_prescriptions).toHaveLength(1);
    expect(alerts.find((a) => a.severity === 'info').sourceData.scheduled_count).toBe(1);
  });

  it('flags pending investigations when patient int id resolves', async () => {
    mockPrisma.users.findUnique.mockResolvedValue({ id: 99, tenant_id: 'tenant-99' });
    mockPrisma.investigations.findMany.mockResolvedValue([
      { id: 5, test_name: 'cbc', status: 'ordered', requested_at: new Date(), updated_at: null, completed_at: null },
    ]);

    const alerts = await cds.checkDuplicateOrders('investigation', { test_name: 'CBC' }, PATIENT_UID);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('warning');
    expect(alerts[0].sourceData.pending_tests[0].id).toBe(5);
  });

  it('handles an investigation order when patient int id is null (uid-only WHERE)', async () => {
    mockPrisma.users.findUnique.mockResolvedValue(null); // resolveUserIdFromUid → null
    mockPrisma.investigations.findMany.mockResolvedValue([]); // no pending
    const alerts = await cds.checkDuplicateOrders('investigation', { test_name: 'CBC' }, PATIENT_UID);
    expect(alerts).toEqual([]);
  });
});

// ── checkRecentResults ───────────────────────────────────────────────────────
describe('checkRecentResults', () => {
  it('returns [] when testName or patientUid is missing', async () => {
    expect(await cds.checkRecentResults('', PATIENT_UID)).toEqual([]);
    expect(await cds.checkRecentResults('cbc', '')).toEqual([]);
  });

  it('filters by the coalesced timestamp, sorts desc, and surfaces only the recent results', async () => {
    const newest = new Date(Date.now() - 1 * 60 * 60 * 1000); // 1h ago → within 48h
    const older = new Date(Date.now() - 5 * 60 * 60 * 1000); // 5h ago → within 48h, but older
    const stale = new Date(Date.now() - 72 * 60 * 60 * 1000); // 72h ago → filtered out
    mockPrisma.investigations.findMany.mockResolvedValue([
      // intentionally out of order so the .sort comparator (line 590) runs and re-orders
      { id: 1, test_name: 'cbc', status: 'completed', result_file: 'a.pdf', completed_at: older, updated_at: null, requested_at: null },
      { id: 2, test_name: 'cbc', status: 'completed', result_file: 'b.pdf', completed_at: newest, updated_at: null, requested_at: null },
      { id: 3, test_name: 'cbc', status: 'completed', result_file: null, completed_at: null, updated_at: null, requested_at: stale }, // stale via requested_at → filtered
      { id: 4, test_name: 'cbc', status: 'completed', result_file: null, completed_at: null, updated_at: null, requested_at: null }, // no timestamp → filtered
    ]);

    const alerts = await cds.checkRecentResults('CBC', PATIENT_UID);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('info');
    expect(alerts[0].sourceData.recent_results).toHaveLength(2);
    // newest first (descending sort by created_at)
    expect(alerts[0].sourceData.recent_results.map((r) => r.id)).toEqual([2, 1]);
  });

  it('returns [] when no completed results fall inside the window', async () => {
    mockPrisma.investigations.findMany.mockResolvedValue([]);
    expect(await cds.checkRecentResults('CBC', PATIENT_UID)).toEqual([]);
  });
});

// ── checkCriticalLabValues ───────────────────────────────────────────────────
describe('checkCriticalLabValues', () => {
  it('returns [] for missing/invalid input', async () => {
    expect(await cds.checkCriticalLabValues(null, PATIENT_UID)).toEqual([]);
    expect(await cds.checkCriticalLabValues({ test_name: 'potassium' }, PATIENT_UID)).toEqual([]); // value undefined
    expect(await cds.checkCriticalLabValues({ test_name: 'potassium', value: null }, PATIENT_UID)).toEqual([]);
  });

  it('returns [] for a non-numeric value', async () => {
    expect(await cds.checkCriticalLabValues({ test_name: 'potassium', value: 'abc' }, PATIENT_UID)).toEqual([]);
  });

  it('returns [] for an unknown test (no range)', async () => {
    expect(await cds.checkCriticalLabValues({ test_name: 'unobtanium', value: 5 }, PATIENT_UID)).toEqual([]);
  });

  it('flags CRITICAL LOW and persists the alert', async () => {
    const alerts = await cds.checkCriticalLabValues(
      { test_name: 'Potassium', value: 2.0, encounter_id: 12 }, PATIENT_UID,
    );
    expect(alerts[0].severity).toBe('critical');
    expect(alerts[0].title).toContain('CRITICAL LOW');
    expect(alerts[0].canOverride).toBe(false);
    expect(mockPrisma.cds_alerts.create).toHaveBeenCalledTimes(1);
  });

  it('flags CRITICAL HIGH', async () => {
    const alerts = await cds.checkCriticalLabValues({ test_name: 'Potassium', value: 7.0 }, PATIENT_UID);
    expect(alerts[0].title).toContain('CRITICAL HIGH');
    expect(alerts[0].severity).toBe('critical');
  });

  it('flags LOW (warning) when between criticalLow and low', async () => {
    const alerts = await cds.checkCriticalLabValues({ test_name: 'Potassium', value: 3.0 }, PATIENT_UID);
    expect(alerts[0].severity).toBe('warning');
    expect(alerts[0].title).toContain('LOW');
  });

  it('flags HIGH (warning) when between high and criticalHigh', async () => {
    const alerts = await cds.checkCriticalLabValues({ test_name: 'Potassium', value: 5.5 }, PATIENT_UID);
    expect(alerts[0].severity).toBe('warning');
    expect(alerts[0].title).toContain('HIGH');
  });

  it('returns [] (no alert) for a normal value', async () => {
    // potassium 4.0 is within low(3.5)-high(5.0)
    expect(await cds.checkCriticalLabValues({ test_name: 'Potassium', value: 4.0 }, PATIENT_UID)).toEqual([]);
    expect(mockPrisma.cds_alerts.create).not.toHaveBeenCalled();
  });

  it('uses criticalHigh branch when criticalLow is null (creatinine high)', async () => {
    const alerts = await cds.checkCriticalLabValues({ test_name: 'Creatinine', value: 12 }, PATIENT_UID);
    expect(alerts[0].severity).toBe('critical');
    expect(alerts[0].title).toContain('CRITICAL HIGH');
  });
});

// ── getProtocolReminders + evaluateProtocolTrigger + evaluateUnmetRecommendations ─
describe('getProtocolReminders', () => {
  it('returns [] when patientUid is missing', async () => {
    expect(await cds.getProtocolReminders('', 'enc-1')).toEqual([]);
  });

  it('returns [] when there are no active protocols', async () => {
    mockPrisma.clinical_protocols.findMany.mockResolvedValue([]);
    expect(await cds.getProtocolReminders(PATIENT_UID, 'enc-1')).toEqual([]);
  });

  it('triggers a high-priority protocol with unmet recommendations and persists', async () => {
    mockPrisma.clinical_protocols.findMany.mockResolvedValue([
      {
        id: 1, name: 'Sepsis Bundle', category: 'sepsis', priority: 'high',
        trigger_conditions: {
          is_admitted: true,
          admission_type: ['emergency'],
          department: ['icu'],
          diagnosis_contains: ['sepsis'],
          days_admitted_gte: 1,
          chief_complaint_contains: ['fever'],
        },
        recommendations: {
          medications: ['vancomycin'],   // not active → unmet
          tests: ['lactate'],            // not recent → unmet
          actions: ['Reassess in 1h'],   // always unmet
        },
      },
      // A low-priority protocol whose trigger fails (not admitted requirement)
      // → exercises the `if (!triggered) continue` skip + unknown-priority sort.
      {
        id: 2, name: 'Skip Me', category: 'x', priority: 'weird',
        trigger_conditions: { is_admitted: true, admission_type: 'elective' },
        recommendations: { medications: ['none'] },
      },
    ]);

    mockPrisma.admissions.findMany.mockResolvedValue([
      {
        id: 50, encounter_id: 'enc-x', status: 'admitted', admission_type: 'emergency',
        department: 'ICU', chief_complaint: 'High fever and chills',
        admitted_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), allergies: [], code_status: 'full',
      },
    ]);
    mockPrisma.diagnoses.findMany.mockResolvedValue([
      { id: 1, icd10_code: 'A41.9', description: 'Severe sepsis', status: 'active', diagnosis_type: 'primary' },
    ]);
    mockPrisma.prescriptions.findMany.mockResolvedValue([
      { medication_name: 'Paracetamol' },
    ]);
    mockPrisma.investigations.findMany.mockResolvedValue([
      { test_name: 'CBC', status: 'completed', requested_at: new Date(), updated_at: null, completed_at: new Date() },
    ]);

    const alerts = await cds.getProtocolReminders(PATIENT_UID, 'enc-1');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('warning'); // high priority → warning
    expect(alerts[0].sourceData.unmet).toEqual(
      expect.arrayContaining(['Order vancomycin', 'Order lactate', 'Reassess in 1h']),
    );
    expect(mockPrisma.cds_alerts.create).toHaveBeenCalledTimes(1);
  });

  it('emits an info alert for a non-high protocol and skips a protocol with all recs met', async () => {
    mockPrisma.clinical_protocols.findMany.mockResolvedValue([
      {
        id: 3, name: 'Glycemic', category: 'endo', priority: 'medium',
        trigger_conditions: { department: 'medicine' },
        recommendations: { tests: ['hba1c'] }, // not recent → unmet → info alert
      },
      {
        id: 4, name: 'AllMet', category: 'cardio', priority: 'low',
        trigger_conditions: {}, // empty object → triggers (truthy guards all skipped)
        recommendations: { medications: ['aspirin'] }, // active → met → no alert
      },
    ]);
    mockPrisma.admissions.findMany.mockResolvedValue([
      { id: 1, status: 'admitted', admission_type: 'routine', department: 'Medicine', chief_complaint: '', admitted_at: new Date(), allergies: [], code_status: null },
    ]);
    mockPrisma.prescriptions.findMany.mockResolvedValue([{ medication_name: 'Aspirin 75' }]);
    mockPrisma.investigations.findMany.mockResolvedValue([]);

    const alerts = await cds.getProtocolReminders(PATIENT_UID, 'enc-1');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('info');
    expect(alerts[0].sourceData.protocol_id).toBe(3);
  });

  it('skips protocols whose department / diagnosis / chief-complaint / days conditions fail', async () => {
    mockPrisma.clinical_protocols.findMany.mockResolvedValue([
      { id: 10, name: 'DeptFail', category: 'c', priority: 'low', trigger_conditions: { department: 'oncology' }, recommendations: { actions: ['x'] } },
      { id: 11, name: 'DxFail', category: 'c', priority: 'low', trigger_conditions: { diagnosis_contains: 'diabetes' }, recommendations: { actions: ['x'] } },
      { id: 12, name: 'CcFail', category: 'c', priority: 'low', trigger_conditions: { chief_complaint_contains: 'headache' }, recommendations: { actions: ['x'] } },
      { id: 13, name: 'DaysFail', category: 'c', priority: 'low', trigger_conditions: { days_admitted_gte: 99 }, recommendations: { actions: ['x'] } },
      { id: 14, name: 'AdmTypeFail', category: 'c', priority: 'low', trigger_conditions: { admission_type: 'daycare' }, recommendations: { actions: ['x'] } },
      { id: 15, name: 'NullConditions', category: 'c', priority: 'low', trigger_conditions: null, recommendations: { actions: ['x'] } }, // typeof guard → false
    ]);
    mockPrisma.admissions.findMany.mockResolvedValue([
      { id: 1, status: 'admitted', admission_type: 'emergency', department: 'Medicine', chief_complaint: 'fever', admitted_at: new Date(), allergies: [], code_status: null },
    ]);
    mockPrisma.diagnoses.findMany.mockResolvedValue([
      { id: 1, icd10_code: 'A41', description: 'sepsis', status: 'active' },
    ]);
    mockPrisma.prescriptions.findMany.mockResolvedValue([]);
    mockPrisma.investigations.findMany.mockResolvedValue([]);

    const alerts = await cds.getProtocolReminders(PATIENT_UID, 'enc-1');
    expect(alerts).toEqual([]); // every protocol's trigger fails
  });

  it('matches diagnosis by ICD-10 code prefix and chief complaint when no admission exists', async () => {
    mockPrisma.clinical_protocols.findMany.mockResolvedValue([
      {
        id: 20, name: 'DxByCode', category: 'c', priority: 'low',
        trigger_conditions: { diagnosis_contains: ['E11'] }, // matches icd10 code prefix
        recommendations: { actions: ['Counsel'] },
      },
    ]);
    mockPrisma.admissions.findMany.mockResolvedValue([]); // no admission → patientCtx fields default
    mockPrisma.diagnoses.findMany.mockResolvedValue([
      { id: 1, icd10_code: 'E11.9', description: null, status: 'chronic' },
    ]);
    mockPrisma.prescriptions.findMany.mockResolvedValue([]);
    mockPrisma.investigations.findMany.mockResolvedValue([]);

    const alerts = await cds.getProtocolReminders(PATIENT_UID, 'enc-1');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].sourceData.unmet).toContain('Counsel');
  });
});

// ── checkOrder (master) ──────────────────────────────────────────────────────
describe('checkOrder', () => {
  it('throws AppError.badRequest when order is missing required fields', async () => {
    await expect(cds.checkOrder(null)).rejects.toMatchObject({ statusCode: 400 });
    await expect(cds.checkOrder({ type: 'medication' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(cds.checkOrder({ patient_uid: PATIENT_UID })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('runs medication checks, persists critical/warning alerts, and reports unsafe', async () => {
    mockPrisma.medication_administrations.findMany.mockResolvedValue([{ medication_name: 'Ibuprofen' }]);
    mockPrisma.prescriptions.findMany.mockResolvedValue([]);
    mockPrisma.drug_interactions.findMany.mockResolvedValue([
      { id: 1, drug_a: 'warfarin', drug_b: 'ibuprofen', severity: 'severe', description: 'bleed risk' },
    ]);
    // No allergies, no duplicate prescriptions.
    const result = await cds.checkOrder({
      type: 'medication', medication_name: 'Warfarin', patient_uid: PATIENT_UID, encounter_id: 5,
    });
    expect(result.safe).toBe(false); // a critical alert exists
    expect(result.alerts.some((a) => a.type === 'drug_interaction')).toBe(true);
    expect(mockPrisma.cds_alerts.create).toHaveBeenCalled(); // critical persisted
  });

  it('runs investigation checks and returns safe when only info alerts arise', async () => {
    // duplicate investigation returns nothing; recent results returns an info alert
    const recent = new Date(Date.now() - 1 * 60 * 60 * 1000);
    mockPrisma.investigations.findMany
      .mockResolvedValueOnce([]) // checkDuplicateOrders pendingTests
      .mockResolvedValueOnce([
        { id: 1, test_name: 'cbc', status: 'completed', result_file: 'r.pdf', completed_at: recent, updated_at: null, requested_at: null },
      ]); // checkRecentResults candidates

    const result = await cds.checkOrder({ type: 'investigation', test_name: 'CBC', patient_uid: PATIENT_UID });
    expect(result.safe).toBe(true); // only info
    expect(result.alerts.some((a) => a.severity === 'info')).toBe(true);
  });

  it('returns safe=true with an empty alert set when type has no matching branch', async () => {
    const result = await cds.checkOrder({ type: 'medication', patient_uid: PATIENT_UID }); // no medication_name
    expect(result).toEqual({ safe: true, alerts: [] });
  });

  it('fails open with a system_error info alert when a check throws', async () => {
    mockPrisma.medication_administrations.findMany.mockRejectedValue(new Error('db down'));
    const result = await cds.checkOrder({ type: 'medication', medication_name: 'Warfarin', patient_uid: PATIENT_UID });
    expect(result.safe).toBe(true);
    expect(result.alerts[0].type).toBe('system_error');
  });
});

// ── persistCdsAlert fail-safe (exercised via checkCriticalLabValues) ──────────
describe('persistCdsAlert fail-safe', () => {
  it('skips the write when the owning tenant cannot be resolved', async () => {
    mockPrisma.users.findUnique.mockResolvedValue(null); // no owner → null tenant
    const alerts = await cds.checkCriticalLabValues({ test_name: 'Potassium', value: 2.0 }, PATIENT_UID);
    expect(alerts).toHaveLength(1); // alert still returned to caller
    expect(mockPrisma.cds_alerts.create).not.toHaveBeenCalled(); // but not persisted
  });

  it('swallows a create failure (best-effort persist) without throwing', async () => {
    mockPrisma.cds_alerts.create.mockRejectedValue(new Error('insert failed'));
    const alerts = await cds.checkCriticalLabValues({ test_name: 'Potassium', value: 2.0 }, PATIENT_UID);
    expect(alerts).toHaveLength(1); // caller still gets the alert
  });
});

// ── acknowledgeAlert ─────────────────────────────────────────────────────────
describe('acknowledgeAlert', () => {
  it('throws AppError.badRequest when alertId or acknowledgedBy is missing', async () => {
    await expect(cds.acknowledgeAlert(null, 'doc-1')).rejects.toMatchObject({ statusCode: 400 });
    await expect(cds.acknowledgeAlert(1, '')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('throws notFound when the alert does not exist', async () => {
    mockPrisma.cds_alerts.findUnique.mockResolvedValue(null);
    await expect(cds.acknowledgeAlert(1, 'doc-1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('throws conflict when already acknowledged', async () => {
    mockPrisma.cds_alerts.findUnique.mockResolvedValue({ id: 1, acknowledged: true, source_data: {} });
    await expect(cds.acknowledgeAlert(1, 'doc-1')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('acknowledges with an override reason and merges it into source_data', async () => {
    mockPrisma.cds_alerts.findUnique.mockResolvedValue({ id: 1, acknowledged: false, source_data: { foo: 'bar' } });
    mockPrisma.cds_alerts.update.mockResolvedValue({
      id: 1, patient_uid: PATIENT_UID, encounter_id: 3, alert_type: 'allergy',
      severity: 'critical', title: 't', description: 'd',
      source_data: { foo: 'bar', override_reason: 'clinically necessary' },
      acknowledged: true, ack_by: 'doc-1', ack_at: new Date(), created_at: new Date(),
    });

    const result = await cds.acknowledgeAlert(1, 'doc-1', 'clinically necessary', 'tenant-7');
    expect(result.acknowledged).toBe(true);
    expect(result.acknowledged_by).toBe('doc-1');
    expect(result.override_reason).toBe('clinically necessary');
    expect(emitCdsAlertAcknowledged).toHaveBeenCalledTimes(1);
  });

  it('acknowledges without an override reason (null source_data path)', async () => {
    mockPrisma.cds_alerts.findUnique.mockResolvedValue({ id: 2, acknowledged: false, source_data: null });
    mockPrisma.cds_alerts.update.mockResolvedValue({
      id: 2, patient_uid: PATIENT_UID, encounter_id: null, alert_type: 'critical_lab',
      severity: 'critical', title: 't', description: 'd', source_data: null,
      acknowledged: true, ack_by: 'doc-2', ack_at: new Date(), created_at: new Date(),
    });

    const result = await cds.acknowledgeAlert(2, 'doc-2');
    expect(result.override_reason).toBeNull();
    expect(result.acknowledged_by).toBe('doc-2');
  });
});

// ── getActiveAlerts ──────────────────────────────────────────────────────────
describe('getActiveAlerts', () => {
  it('throws AppError.badRequest when patientUid is missing', async () => {
    await expect(cds.getActiveAlerts('')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('sorts by severity rank then created_at desc and maps the response shape', async () => {
    const older = new Date('2026-01-01T00:00:00Z');
    const newer = new Date('2026-02-01T00:00:00Z');
    mockPrisma.cds_alerts.findMany.mockResolvedValue([
      { id: 1, patient_uid: PATIENT_UID, encounter_id: null, alert_type: 'a', severity: 'info', title: 'i', description: 'd', source_data: null, acknowledged: false, ack_by: null, ack_at: null, created_at: older },
      { id: 2, patient_uid: PATIENT_UID, encounter_id: null, alert_type: 'b', severity: 'critical', title: 'c', description: 'd', source_data: { override_reason: 'r' }, acknowledged: false, ack_by: null, ack_at: null, created_at: older },
      { id: 3, patient_uid: PATIENT_UID, encounter_id: null, alert_type: 'c', severity: 'critical', title: 'c2', description: 'd', source_data: null, acknowledged: false, ack_by: null, ack_at: null, created_at: newer },
      { id: 4, patient_uid: PATIENT_UID, encounter_id: null, alert_type: 'd', severity: 'mystery', title: 'm', description: 'd', source_data: null, acknowledged: false, ack_by: null, ack_at: null, created_at: older }, // unknown severity → rank 99
    ]);

    const out = await cds.getActiveAlerts(PATIENT_UID);
    // critical (newer) before critical (older) before info before unknown.
    expect(out.map((r) => r.id)).toEqual([3, 2, 1, 4]);
    expect(out.find((r) => r.id === 2).override_reason).toBe('r');
    expect(out.find((r) => r.id === 1).override_reason).toBeNull();
  });
});

// ── listProtocols / createProtocol ───────────────────────────────────────────
describe('listProtocols', () => {
  it('queries with a category filter and category-only ordering', async () => {
    mockPrisma.clinical_protocols.findMany.mockResolvedValue([{ id: 1 }]);
    const rows = await cds.listProtocols('sepsis');
    expect(rows).toHaveLength(1);
    const arg = mockPrisma.clinical_protocols.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ category: 'sepsis' });
    expect(arg.orderBy).toEqual([{ name: 'asc' }]);
  });

  it('queries without a filter and multi-key ordering when category is null', async () => {
    mockPrisma.clinical_protocols.findMany.mockResolvedValue([]);
    await cds.listProtocols();
    const arg = mockPrisma.clinical_protocols.findMany.mock.calls[0][0];
    expect(arg.where).toBeUndefined();
    expect(arg.orderBy).toEqual([{ category: 'asc' }, { name: 'asc' }]);
  });
});

describe('createProtocol', () => {
  it('throws AppError.badRequest when required fields are missing', async () => {
    await expect(cds.createProtocol({ name: 'x' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('creates a protocol with defaulted priority and is_active', async () => {
    mockPrisma.clinical_protocols.create.mockResolvedValue({ id: 9, name: 'P', category: 'c' });
    const created = await cds.createProtocol({
      name: 'P', category: 'c', trigger_conditions: {}, recommendations: {},
    });
    expect(created.id).toBe(9);
    const data = mockPrisma.clinical_protocols.create.mock.calls[0][0].data;
    expect(data.priority).toBe('medium'); // defaulted
    expect(data.is_active).toBe(true);    // is_active !== false
  });

  it('honors explicit priority and is_active=false', async () => {
    mockPrisma.clinical_protocols.create.mockResolvedValue({ id: 10 });
    await cds.createProtocol({
      name: 'P', category: 'c', trigger_conditions: {}, recommendations: {},
      priority: 'high', is_active: false,
    });
    const data = mockPrisma.clinical_protocols.create.mock.calls[0][0].data;
    expect(data.priority).toBe('high');
    expect(data.is_active).toBe(false);
  });
});

// ── default export ───────────────────────────────────────────────────────────
describe('default export', () => {
  it('exposes every public function', () => {
    expect(typeof cds.default.checkOrder).toBe('function');
    expect(typeof cds.default.checkDrugInteractions).toBe('function');
    expect(typeof cds.default.checkAllergies).toBe('function');
    expect(typeof cds.default.checkDuplicateOrders).toBe('function');
    expect(typeof cds.default.checkRecentResults).toBe('function');
    expect(typeof cds.default.checkCriticalLabValues).toBe('function');
    expect(typeof cds.default.getProtocolReminders).toBe('function');
    expect(typeof cds.default.acknowledgeAlert).toBe('function');
    expect(typeof cds.default.getActiveAlerts).toBe('function');
    expect(typeof cds.default.listProtocols).toBe('function');
    expect(typeof cds.default.createProtocol).toBe('function');
  });
});
