import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';

const resolveDrugKeys = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn() },
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('../../services/clinical/allergySourceService.js', () => ({
  getUnifiedActiveAllergiesDetailed: jest.fn(),
  rankSeverity: jest.fn(),
  SEVERE_BLOCK_RANK: 4,
}));
jest.unstable_mockModule('../../services/clinical/drugKnowledgeBaseService.js', () => ({
  evaluateDrugKb: jest.fn(),
}));
jest.unstable_mockModule('../../services/clinical/drugKbLinkService.js', () => ({
  resolveDrugKeys,
}));
jest.unstable_mockModule('../../services/pharmacy/compositionFeatureService.js', () => ({
  isCompositionSearchEnabled: jest.fn(),
}));
jest.unstable_mockModule('../../services/pharmacy/compositionIdentityService.js', () => ({
  enrichMedicationsWithComposition: jest.fn(),
  resolveCompositionIdentitiesByCatalogIds: jest.fn(),
}));

const { loadActiveTherapySnapshot, checkAntithromboticInteractions } = await import(
  '../../utils/clinical/prescriptionSafetyCheck.js'
);

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const SNAPSHOT_AT = '2026-08-29T08:00:00.000Z';
const migration753 = readFileSync(
  new URL('../../migrations/753_pharmacy_order_inventory_authority.sql', import.meta.url),
  'utf8',
);

function sourceRow(overrides = {}) {
  return {
    source: 'e_prescription',
    source_id: '41',
    source_revision: '3',
    lineage_id: 'e_prescription:41',
    line_index: '0',
    medication_name: 'Warfarin 5 mg',
    catalog_id: '17',
    source_status: 'active',
    lifecycle_status: 'signed',
    effective_start: '2026-08-20T08:00:00.000Z',
    effective_end: null,
    line_payload: {
      dose: '5 mg', route: 'oral', _patient_uid_resolved: true, _source_start_authoritative: true,
    },
    ...overrides,
  };
}

function authorityDb(coreRows, specialtyRows = []) {
  const sql = [];
  const db = {
    $queryRawUnsafe: jest.fn(async (statement) => {
      sql.push(statement);
      if (/SELECT id, uid, NOW\(\) AS snapshot_at/.test(statement)) {
        return [{ id: 91, uid: PATIENT_UID, snapshot_at: SNAPSHOT_AT }];
      }
      if (/SELECT inventory\.id/.test(statement) && /FOR KEY SHARE OF inventory/.test(statement)) {
        return [];
      }
      if (/WITH latest_reconciliation/.test(statement)) return coreRows;
      if (/FROM chemo_administrations/.test(statement)) return specialtyRows;
      if (/FROM pharmacy_catalog/.test(statement) && /FOR KEY SHARE/.test(statement)) {
        return [{ id: 17, name: 'Warfarin 5 mg', generic_name: 'warfarin', composition_id: 7 }];
      }
      if (/FROM drug_compositions/.test(statement) && /FOR KEY SHARE/.test(statement)) {
        return [{ id: 7, composition_key: 'warfarin', active_ingredients: ['warfarin'] }];
      }
      throw new Error(`Unexpected active-therapy SQL: ${statement.slice(0, 100)}`);
    }),
  };
  return { db, sql };
}

beforeEach(() => {
  jest.clearAllMocks();
  resolveDrugKeys.mockImplementation(async ({ medications, db, strict }) => ({
    enabled: true,
    resolutions: medications.map((medication) => ({
      catalog_id: medication.catalog_id,
      drug_keys: ['warfarin'],
      tier: 'explicit_link',
    })),
    db,
    strict,
  }));
});

describe('canonical active-therapy authority', () => {
  test('hashes every independent lineage while deduplicating only interaction inputs', async () => {
    const rows = [
      sourceRow(),
      sourceRow({
        source: 'clinical_order',
        source_id: '82',
        source_revision: '11',
        lineage_id: 'clinical_order:82',
        line_index: 'warfarin 5 mg',
        lifecycle_status: 'clinical_order',
      }),
    ];
    const { db } = authorityDb(rows);

    const snapshot = await loadActiveTherapySnapshot(91, { tenantId: TENANT, db });

    expect(snapshot.blockers).toEqual([]);
    expect(snapshot.evidence).toHaveLength(2);
    expect(snapshot.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'e_prescription', source_revision: '3' }),
      expect.objectContaining({ source: 'clinical_order', source_revision: '11' }),
    ]));
    expect(snapshot.medications).toHaveLength(1);
    expect(snapshot.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(resolveDrugKeys).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      db,
      strict: true,
    }));
  });

  test('keeps independent legacy eRx line names for interaction evaluation', async () => {
    const { db, sql } = authorityDb([
      sourceRow({
        line_index: '0',
        medication_name: 'Aspirin 75 mg',
        catalog_id: null,
      }),
      sourceRow({
        line_index: '1',
        medication_name: 'Warfarin 5 mg',
        catalog_id: null,
      }),
    ]);

    const snapshot = await loadActiveTherapySnapshot(91, { tenantId: TENANT, db });

    expect(snapshot.evidence.map((row) => [row.line_index, row.medication_name])).toEqual([
      ['0', 'Aspirin 75 mg'],
      ['1', 'Warfarin 5 mg'],
    ]);
    expect(checkAntithromboticInteractions(snapshot.medications).blockers).toEqual([
      expect.objectContaining({
        interaction: 'ANTIPLATELET_ANTICOAGULANT',
        medications: ['Aspirin 75 mg', 'Warfarin 5 mg'],
      }),
    ]);

    const sourceSql = sql.find((statement) => /WITH latest_reconciliation/.test(statement));
    const eRxProjection = sourceSql.slice(
      sourceSql.indexOf("SELECT 'e_prescription'"),
      sourceSql.indexOf('UNION ALL'),
    );
    expect(eRxProjection).toMatch(
      /COALESCE\(NULLIF\(TRIM\(med\.value->>'name'\), ''\)[\s\S]*CASE WHEN med\.ordinality IS NULL[\s\S]*THEN NULLIF\(TRIM\(ep\.medication_name\), ''\)/,
    );
  });

  test('collapses only an eRx line durably linked to the same pharmacy-order line', async () => {
    const { db } = authorityDb([
      sourceRow({ lineage_id: 'pharmacy_order:71' }),
      sourceRow({
        source: 'pharmacy_order',
        source_id: '71',
        source_revision: '6',
        lineage_id: 'pharmacy_order:71',
        line_index: '0',
        source_status: 'active',
        lifecycle_status: 'governed_order',
        line_payload: { dose: '5 mg', route: 'oral' },
      }),
    ]);

    const snapshot = await loadActiveTherapySnapshot(91, { tenantId: TENANT, db });

    expect(snapshot.evidence).toEqual([
      expect.objectContaining({
        source: 'pharmacy_order',
        source_id: '71',
        source_revision: '6',
        lineage_id: 'pharmacy_order:71',
        lineage_sources: ['e_prescription', 'pharmacy_order'],
      }),
    ]);
  });

  test('expires a finite fulfilled course against the database snapshot time', async () => {
    const { db } = authorityDb([sourceRow({
      source_status: 'fulfilled',
      effective_start: '2026-08-01T08:00:00.000Z',
      line_payload: {
        days: 5, _patient_uid_resolved: true, _source_start_authoritative: true,
      },
    })]);

    const snapshot = await loadActiveTherapySnapshot(91, { tenantId: TENANT, db });

    expect(snapshot.blockers).toEqual([]);
    expect(snapshot.evidence).toEqual([]);
    expect(snapshot.medications).toEqual([]);
  });

  test('blocks a historical patient-linked counter sale with unresolved course timing', async () => {
    const { db } = authorityDb([sourceRow({
      source: 'counter_sale',
      source_id: '63',
      source_revision: '4',
      lineage_id: 'counter_sale:9:63',
      source_status: 'COMPLETED',
      lifecycle_status: 'registered_counter_sale',
      line_payload: { quantity: 20 },
    })]);

    const snapshot = await loadActiveTherapySnapshot(91, { tenantId: TENANT, db });

    expect(snapshot.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'ACTIVE_THERAPY_TIMING_UNRESOLVED',
        source: 'counter_sale',
        source_id: '63',
      }),
    ]));
    expect(snapshot.evidence).toHaveLength(1);
  });

  test('blocks imported medication history without authoritative source timing', async () => {
    const { db } = authorityDb([sourceRow({
      lifecycle_status: 'imported_history',
      line_payload: {
        source: 'FHIR_MedicationRequest',
        _patient_uid_resolved: true,
        _source_start_authoritative: false,
      },
    })]);

    const snapshot = await loadActiveTherapySnapshot(91, { tenantId: TENANT, db });

    expect(snapshot.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'ACTIVE_THERAPY_TIMING_UNRESOLVED',
        source: 'e_prescription',
      }),
    ]));
  });

  test('blocks a catalogless specialty therapy instead of using free text', async () => {
    const { db } = authorityDb([], [sourceRow({
      source: 'specialty_therapy',
      source_id: 'dialysis:4',
      source_revision: '2',
      lineage_id: 'dialysis:4',
      line_index: 'anticoagulant',
      medication_name: 'heparin',
      catalog_id: null,
      source_status: 'active',
      lifecycle_status: 'dialysis',
    })]);

    const snapshot = await loadActiveTherapySnapshot(91, { tenantId: TENANT, db });

    expect(snapshot.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'ACTIVE_THERAPY_IDENTITY_UNRESOLVED' }),
    ]));
    expect(resolveDrugKeys).not.toHaveBeenCalled();
  });

  test.each([null, false])('quarantines an eRx with unresolved patient UID authority (%s)', async (resolved) => {
    const { db } = authorityDb([sourceRow({
      line_payload: { dose: '5 mg', _patient_uid_resolved: resolved },
    })]);

    const snapshot = await loadActiveTherapySnapshot(91, { tenantId: TENANT, db });

    expect(snapshot.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'ACTIVE_THERAPY_PATIENT_AUTHORITY_UNRESOLVED',
        source_id: '41',
      }),
    ]));
    expect(snapshot.evidence).toEqual([
      expect.objectContaining({
        source: 'e_prescription',
        source_id: '41',
        patient_authority_resolved: false,
      }),
    ]);
    expect(snapshot.evidence[0]).not.toHaveProperty('medication_name');
    expect(snapshot.evidence[0]).not.toHaveProperty('catalog_id');
    expect(resolveDrugKeys).not.toHaveBeenCalled();
  });

  test('source matrix and MAR timing are present in the transaction query', async () => {
    const { db, sql } = authorityDb([sourceRow()]);

    await loadActiveTherapySnapshot(91, { tenantId: TENANT, db });

    const sourceSql = sql.join('\n');
    for (const source of [
      'e_prescriptions', 'pharmacy_orders', 'clinical_orders',
      'medication_administrations', 'chronic_medications',
      'medication_reconciliations', 'prescriptions', 'pharmacy_counter_sales',
      'chemo_administrations', 'dialysis_prescriptions',
      'maternity_supplements', 'resuscitation_medication_links',
      'medication_reminders',
    ]) {
      expect(sourceSql).toContain(source);
    }
    expect(sourceSql).toMatch(/scheduled_time BETWEEN NOW\(\) - INTERVAL '24 hours'[\s\S]*NOW\(\) \+ INTERVAL '7 days'/);
    expect(sourceSql).toMatch(/pharmacy_catalog[\s\S]*tenant_id=\$1::uuid[\s\S]*FOR KEY SHARE/);
    expect(sourceSql).toMatch(/drug_compositions[\s\S]*FOR KEY SHARE/);
  });

  test('migration 753 invalidates the full active-therapy source matrix', () => {
    for (const source of [
      'e_prescriptions', 'pharmacy_orders', 'clinical_orders',
      'medication_administrations', 'medication_reconciliations',
      'medication_reconciliation_items', 'medication_reminders',
      'prescriptions',
      'pharmacy_counter_sales', 'pharmacy_counter_sale_lines',
      'chemo_treatment_plans', 'chemo_cycles', 'chemo_administrations',
      'dialysis_patients', 'dialysis_prescriptions',
      'maternity_pregnancies', 'maternity_supplements',
      'resuscitation_medication_links',
    ]) {
      expect(migration753).toContain(`'${source}'`);
    }
    expect(migration753).toContain('clinical_verification_active_therapy_sha256');
    expect(migration753).not.toMatch(/pharmacy_linked'[\s\S]{0,180}'fulfilled'[\s\S]{0,180}RETURN NEW/);
    expect(migration753).toMatch(/WHEN 'medication_reconciliation_items'[\s\S]*FROM medication_reconciliations/);
    expect(migration753).toMatch(/WHEN 'chemo_administrations'[\s\S]*JOIN chemo_treatment_plans/);
    expect(migration753).toMatch(/WHEN 'dialysis_prescriptions'[\s\S]*FROM dialysis_patients/);
    expect(migration753).toMatch(/WHEN 'maternity_supplements'[\s\S]*FROM maternity_pregnancies/);
  });
});
