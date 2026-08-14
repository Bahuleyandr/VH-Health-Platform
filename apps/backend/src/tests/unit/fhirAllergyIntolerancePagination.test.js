import { jest } from '@jest/globals';

// listFhirAllergyIntolerances used to read every active row from both allergy
// stores and slice the merged array in Node. These tests pin the replacement
// contract: the union, the duplicate collapse, the page window AND the
// whole-set integrity verdict are one statement over one evaluation of the
// union, and a MIS-ATTRIBUTED row anywhere still refuses the read before any
// page is built.
//
// The two row classes that do NOT refuse are the ones that carry nothing a
// reader could be missing: a source row stating no patient key at all (belongs
// to nobody) and one naming no substance (no clinical content — the
// prescription-safety gate already drops those, see
// allergySourceService.mergeAllergyRows). Refusing on either hid every
// patient's allergy list behind a 500 (`fhir-server.deep.test.js` — tenant-wide
// read). They are excluded from the page and reported instead; the
// `quarantines …` tests below are the pins for that.
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
const warn = jest.fn();
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { warn, info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { listFhirAllergyIntolerances, __testing__ } = await import(
  '../../services/fhir/fhirAllergyIntoleranceService.js'
);

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const PATIENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';

function sourceRow(overrides = {}) {
  return {
    integrity_defect: null,
    quarantined_rows: null,
    quarantined_sample: null,
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

// The verdict row the statement appends: every source column is NULL on it.
const verdictRow = ({ defect = null, quarantined = 0, sample = null } = {}) => ({
  ...sourceRow(),
  integrity_defect: defect,
  quarantined_rows: quarantined,
  quarantined_sample: sample,
  source: null,
  id: null,
});
const defectRow = defect => verdictRow({ defect });

describe('FHIR AllergyIntolerance pagination', () => {
  beforeEach(() => {
    calls.length = 0;
    nextRows = [];
    warn.mockClear();
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

  test('never leaks a verdict column into a served row', async () => {
    nextRows = [sourceRow()];
    const [row] = await listFhirAllergyIntolerances({ tenantId: TENANT });
    expect(row).not.toHaveProperty('integrity_defect');
    expect(row).not.toHaveProperty('quarantined_rows');
    expect(row).not.toHaveProperty('quarantined_sample');
  });

  test.each([
    ['identity_unresolved', 'FHIR_ALLERGY_PATIENT_UNRESOLVED'],
    ['identity_invalid', 'FHIR_ALLERGY_PATIENT_INVALID'],
    ['identity_conflict', 'FHIR_ALLERGY_PATIENT_IDENTITY_CONFLICT'],
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

  test('quarantines unrenderable source rows instead of refusing', async () => {
    // `patient_unresolved` — a `patient_allergies` row with neither patient_uid
    // nor patient_id belongs to nobody: it can never appear on any patient's
    // list, and every patient-scoped read already filters it out.
    // `allergen_missing` — a row naming no substance carries no clinical
    // content; the prescription-safety gate drops the same shape.
    // Refusing on either took the tenant-wide read — every patient's allergy
    // list — down with a 500.
    const sample = 'allergen_missing:allergies:44,patient_unresolved:patient_allergies:31';
    nextRows = [sourceRow({ id: 7 }), verdictRow({ quarantined: 2, sample })];

    const rows = await listFhirAllergyIntolerances({ tenantId: TENANT });

    expect(rows.map(row => row.id)).toEqual(['pa-7']);
    // Excluding them silently would be its own failure: the read reports them.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      code: 'FHIR_ALLERGY_SOURCE_QUARANTINED',
      tenantId: TENANT,
      excludedRows: 2,
      sample,
    }));
  });

  test('a mis-attributed row still refuses even when quarantined rows are also present', async () => {
    nextRows = [sourceRow(), verdictRow({ defect: 'identity_conflict', quarantined: 5 })];
    await expect(listFhirAllergyIntolerances({ tenantId: TENANT }))
      .rejects.toMatchObject({ code: 'FHIR_ALLERGY_PATIENT_IDENTITY_CONFLICT' });
    expect(warn).not.toHaveBeenCalled();
  });

  test('a clean read reports nothing', async () => {
    nextRows = [sourceRow()];
    await listFhirAllergyIntolerances({ tenantId: TENANT });
    expect(warn).not.toHaveBeenCalled();
  });

  test('the merge drops the same two classes the page query does', () => {
    const unattributable = { ...sourceRow({ id: 3 }), patient_uid_raw: null, patient_uid_match: null };
    const nameless = { ...sourceRow({ id: 4, allergy_name: '   ' }) };
    expect(__testing__.mergeReadableAllergyRows([unattributable, nameless, sourceRow({ id: 5 })]))
      .toHaveLength(1);
  });

  test('the quarantine classes are excluded from the refusal verdict in SQL', () => {
    const sql = __testing__.ALLERGY_PAGE_SQL;
    const refusal = sql.slice(sql.indexOf('integrity_defect AS ('), sql.indexOf('quarantined_rows AS ('));
    expect(refusal).toContain("defect NOT IN ('patient_unresolved', 'allergen_missing')");
    // ...and they are counted rather than dropped on the floor.
    expect(sql).toContain("WHERE defect IN ('patient_unresolved', 'allergen_missing')");
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
