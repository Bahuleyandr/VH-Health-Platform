import { jest } from '@jest/globals';

// listFhirAllergyIntolerances used to read every active row from both allergy
// stores and slice the merged array in Node. These tests pin the replacement
// contract: the union, the duplicate collapse, and the page window are the
// database's job, and the whole-set integrity probe still refuses the read
// before any page is built.

const queries = [];
const responses = { probe: [], page: [] };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: async (_tenantId, fn) => fn({
    $queryRawUnsafe: async (sql, ...params) => {
      const text = String(sql);
      const kind = text.includes('classified') ? 'probe' : 'page';
      queries.push({ kind, text, params });
      return responses[kind];
    },
  }),
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: jest.fn(),
}));

const { listFhirAllergyIntolerances } = await import(
  '../../services/fhir/fhirAllergyIntoleranceService.js'
);

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const PATIENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';

function sourceRow(overrides = {}) {
  return {
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

describe('FHIR AllergyIntolerance pagination', () => {
  beforeEach(() => {
    queries.length = 0;
    responses.probe = [];
    responses.page = [];
  });

  test('pushes the page window into the query instead of slicing in memory', async () => {
    responses.page = [
      sourceRow({ id: 1, allergy_name: 'Penicillin' }),
      sourceRow({ id: 2, allergy_name: 'Latex', created_at: '2026-07-01T00:00:00.000Z' }),
      sourceRow({ id: 3, allergy_name: 'Sulfa', created_at: '2026-06-01T00:00:00.000Z' }),
    ];

    const rows = await listFhirAllergyIntolerances({
      tenantId: TENANT, patientUid: PATIENT, limit: 1, offset: 0,
    });

    const page = queries.find(query => query.kind === 'page');
    expect(page.text).toContain('UNION ALL');
    expect(page.text).toContain('DISTINCT ON (group_patient_uid, group_allergen)');
    expect(page.text).toContain('LIMIT $3::integer OFFSET $4::integer');
    expect(page.params).toEqual([TENANT, PATIENT, 1, 0]);
    // Everything the database returned is served. A surviving in-memory
    // .slice() would have cut this back to one row.
    expect(rows.map(row => row.allergen)).toEqual(['Penicillin', 'Latex', 'Sulfa']);
  });

  test('clamps the requested window before it reaches the database', async () => {
    await listFhirAllergyIntolerances({ tenantId: TENANT, limit: 5000, offset: -7 });
    expect(queries.find(query => query.kind === 'page').params)
      .toEqual([TENANT, null, 1000, 0]);

    queries.length = 0;
    await listFhirAllergyIntolerances({ tenantId: TENANT });
    expect(queries.find(query => query.kind === 'page').params)
      .toEqual([TENANT, null, 200, 0]);
  });

  test('still merges duplicate allergens across both stores on the page', async () => {
    responses.page = [
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

  test.each([
    ['identity_unresolved', 'FHIR_ALLERGY_PATIENT_UNRESOLVED'],
    ['identity_invalid', 'FHIR_ALLERGY_PATIENT_INVALID'],
    ['identity_conflict', 'FHIR_ALLERGY_PATIENT_IDENTITY_CONFLICT'],
    ['patient_unresolved', 'FHIR_ALLERGY_PATIENT_UNRESOLVED'],
    ['allergen_missing', 'FHIR_ALLERGY_CONTENT_UNRESOLVED'],
  ])('refuses the whole read when a source row is %s', async (defect, code) => {
    responses.probe = [{ defect }];

    await expect(listFhirAllergyIntolerances({ tenantId: TENANT, limit: 5, offset: 100 }))
      .rejects.toMatchObject({ code });

    // The defect may sit outside the requested page; the probe runs over the
    // whole filtered set and no page is built once it fires.
    const probe = queries.find(query => query.kind === 'probe');
    expect(probe.params).toEqual([TENANT, null]);
    expect(queries.some(query => query.kind === 'page')).toBe(false);
  });
});
