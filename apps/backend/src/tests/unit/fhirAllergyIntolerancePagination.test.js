import { jest } from '@jest/globals';

// listFhirAllergyIntolerances used to read every active row from both allergy
// stores and slice the merged array in Node. These tests pin the replacement
// contract: the union, the duplicate collapse, the page window AND the
// whole-set integrity verdict are one statement over one evaluation of the
// union, and an unreadable row anywhere still refuses the read before any page
// is built.
//
// The single-statement property is load-bearing, not cosmetic. The first cut of
// this change ran a separate probe query ahead of the page query; both rebuilt
// the same union, so the unfiltered tenant read did roughly DOUBLE the database
// work of the unpaginated original it replaced. `issues exactly one statement`
// below is the regression pin for that.

const calls = [];
let nextRows = [];

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: async (_tenantId, fn) => fn({
    $queryRawUnsafe: async (sql, ...params) => {
      calls.push({ text: String(sql), params });
      return nextRows;
    },
  }),
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: jest.fn(),
}));

const { listFhirAllergyIntolerances, __testing__ } = await import(
  '../../services/fhir/fhirAllergyIntoleranceService.js'
);

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const PATIENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';

function sourceRow(overrides = {}) {
  return {
    integrity_defect: null,
    source: 'patient_allergies',
    id: 1,
    allergy_name: 'Penicillin',
    severity: 'MILD',
    reaction: null,
    created_at: '2026-08-01T00:00:00.000Z',
    recorded_at: null,
    has_fhir_receipt: false,
    patient_uid_raw: PATIENT,
    patient_id_raw: null,
    patient_uid_match: PATIENT,
    patient_uid_role: 'PATIENT',
    patient_uid_active: true,
    patient_id_match: null,
    patient_id_role: null,
    patient_id_active: null,
    ...overrides,
  };
}

const defectRow = defect => ({ ...sourceRow(), integrity_defect: defect, source: null, id: null });

describe('FHIR AllergyIntolerance pagination', () => {
  beforeEach(() => {
    calls.length = 0;
    nextRows = [];
  });

  test('issues exactly one statement, which carries both the page and the verdict', async () => {
    nextRows = [sourceRow()];

    await listFhirAllergyIntolerances({ tenantId: TENANT, limit: 10, offset: 0 });

    // One statement per read. Two would mean the union is rebuilt per concern.
    expect(calls).toHaveLength(1);
    const [{ text }] = calls;
    expect(text).toContain('classified_rows AS (');
    expect(text).toContain('integrity_defect AS (');
    expect(text).toContain('LIMIT $3::integer OFFSET $4::integer');
    // The union appears once in the statement, not once per concern.
    expect(text.match(/FROM patient_allergies allergy/g)).toHaveLength(1);
    expect(text.match(/FROM allergies allergy/g)).toHaveLength(1);
    // ...and every consumer reads that one materialization back.
    expect(text.match(/FROM classified_rows/g).length).toBeGreaterThanOrEqual(3);
  });

  test('pushes the page window into the query instead of slicing in memory', async () => {
    nextRows = [
      sourceRow({ id: 1, allergy_name: 'Penicillin' }),
      sourceRow({ id: 2, allergy_name: 'Latex', created_at: '2026-07-01T00:00:00.000Z' }),
      sourceRow({ id: 3, allergy_name: 'Sulfa', created_at: '2026-06-01T00:00:00.000Z' }),
    ];

    const rows = await listFhirAllergyIntolerances({
      tenantId: TENANT, patientUid: PATIENT, limit: 1, offset: 0,
    });

    const [{ text, params }] = calls;
    expect(text).toContain('DISTINCT ON (group_patient_uid, group_allergen)');
    expect(params).toEqual([TENANT, PATIENT, 1, 0]);
    // Everything the database returned is served. A surviving in-memory
    // .slice() would have cut this back to one row.
    expect(rows.map(row => row.allergen)).toEqual(['Penicillin', 'Latex', 'Sulfa']);
  });

  test('clamps the requested window before it reaches the database', async () => {
    await listFhirAllergyIntolerances({ tenantId: TENANT, limit: 5000, offset: -7 });
    expect(calls[0].params).toEqual([TENANT, null, 1000, 0]);

    calls.length = 0;
    await listFhirAllergyIntolerances({ tenantId: TENANT });
    expect(calls[0].params).toEqual([TENANT, null, 200, 0]);
  });

  test('still merges duplicate allergens across both stores on the page', async () => {
    nextRows = [
      sourceRow({ id: 4, allergy_name: '  Penicillin  ', severity: 'MILD', has_fhir_receipt: true }),
      sourceRow({
        source: 'allergies',
        id: 9,
        allergy_name: 'PENICILLIN',
        severity: 'SEVERE',
        reaction: '  anaphylaxis  ',
        recorded_at: '2026-08-02T00:00:00.000Z',
      }),
    ];

    const [row] = await listFhirAllergyIntolerances({ tenantId: TENANT, patientUid: PATIENT });

    expect(row).toMatchObject({
      id: 'pa-4',
      allergen: 'Penicillin',
      severity: 'SEVERE',
      reaction: 'anaphylaxis',
      sources: ['patient_allergies', 'allergies'],
    });
    expect(row.identifiers).toEqual([
      { system: 'urn:vhhealth:patient-allergy', value: '4' },
      { system: 'urn:vhhealth:allergy', value: '9' },
    ]);
  });

  test('never leaks the verdict column into a served row', async () => {
    nextRows = [sourceRow()];
    const [row] = await listFhirAllergyIntolerances({ tenantId: TENANT });
    expect(row).not.toHaveProperty('integrity_defect');
  });

  test.each([
    ['identity_unresolved', 'FHIR_ALLERGY_PATIENT_UNRESOLVED'],
    ['identity_invalid', 'FHIR_ALLERGY_PATIENT_INVALID'],
    ['identity_conflict', 'FHIR_ALLERGY_PATIENT_IDENTITY_CONFLICT'],
    ['patient_unresolved', 'FHIR_ALLERGY_PATIENT_UNRESOLVED'],
    ['allergen_missing', 'FHIR_ALLERGY_CONTENT_UNRESOLVED'],
  ])('refuses the whole read when a source row is %s', async (defect, code) => {
    // The verdict row rides alongside a perfectly servable page: the defect sits
    // outside the requested window, and the read must still fail closed.
    nextRows = [sourceRow({ id: 11 }), defectRow(defect)];

    await expect(listFhirAllergyIntolerances({ tenantId: TENANT, limit: 5, offset: 100 }))
      .rejects.toMatchObject({ code });

    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual([TENANT, null, 5, 100]);
  });

  test('an unrecognised verdict still refuses rather than serving the page', async () => {
    nextRows = [sourceRow(), defectRow('something_new')];
    await expect(listFhirAllergyIntolerances({ tenantId: TENANT }))
      .rejects.toMatchObject({ code: 'FHIR_ALLERGY_PATIENT_UNRESOLVED' });
  });

  test('the verdict is computed over the whole set, not the page', () => {
    const sql = __testing__.ALLERGY_PAGE_SQL;
    // The probe reads the full classified set; only `page` carries LIMIT/OFFSET.
    const probe = sql.slice(sql.indexOf('integrity_defect AS ('), sql.indexOf('primaries AS ('));
    expect(probe).toContain('FROM classified_rows');
    expect(probe).not.toContain('$3');
    expect(probe).not.toContain('OFFSET');
  });
});
