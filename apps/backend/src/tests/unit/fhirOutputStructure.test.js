import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
  prismaReadOnly: { $queryRawUnsafe: queryUnsafeMock },
  setTenant: async (_tenantId, fn) => fn({ $queryRawUnsafe: queryUnsafeMock }),
  setTenantTx: async (_tenantId, fn) => fn({ $queryRawUnsafe: queryUnsafeMock }),
}));

const { toFhirPatient } = await import('../../services/fhir/fhirAdapter.js');
const { validateResource, validateBundle } = await import('../../services/fhir/fhirValidator.js');

const PATIENT = '11111111-1111-4111-8111-111111111111';

describe('Patient optional contact and name structure', () => {
  it.each([undefined, null, ''])('omits absent name and contacts represented by %s', (absent) => {
    const snapshot = Object.freeze({ uid: PATIENT, name: absent, phone: absent, email: absent });
    const before = structuredClone(snapshot);
    const patient = toFhirPatient(snapshot);

    expect(patient).toMatchObject({ resourceType: 'Patient', id: PATIENT });
    expect(patient).not.toHaveProperty('name');
    expect(patient).not.toHaveProperty('telecom');
    expect(validateResource(patient)).toEqual({ valid: true, issues: [] });
    expect(snapshot).toEqual(before);
  });

  it('preserves populated names, contacts and unrelated patient values', () => {
    const snapshot = Object.freeze({
      uid: PATIENT, name: 'Synthetic Patient', phone: '+919999999999',
      email: 'patient@example.test', gender: 'female', birthday: '1990-01-01',
      address: 'Synthetic address', is_active: false,
    });
    const before = structuredClone(snapshot);
    expect(toFhirPatient(snapshot)).toMatchObject({
      resourceType: 'Patient', id: PATIENT, active: false,
      identifier: [{ system: 'urn:vhhealth:uid', value: PATIENT }],
      name: [{ use: 'official', text: 'Synthetic Patient' }],
      telecom: [
        { system: 'phone', value: '+919999999999', use: 'mobile' },
        { system: 'email', value: 'patient@example.test' },
      ],
      gender: 'female', birthDate: '1990-01-01',
      address: [{ use: 'home', text: 'Synthetic address' }],
    });
    expect(snapshot).toEqual(before);
  });

  it.each([
    [{ phone: '+919999999999' }, { system: 'phone', value: '+919999999999', use: 'mobile' }],
    [{ email: 'patient@example.test' }, { system: 'email', value: 'patient@example.test' }],
  ])('retains a single populated contact without manufacturing another', (contact, expected) => {
    const patient = toFhirPatient({ uid: PATIENT, ...contact });
    expect(patient.telecom).toEqual([expected]);
    expect(patient).not.toHaveProperty('name');
  });
});

describe('Targeted lightweight FHIR structural checks', () => {
  it.each(['name', 'telecom'])('rejects literal Patient.%s empty arrays without modifying input', (field) => {
    const patient = { resourceType: 'Patient', id: PATIENT, [field]: [] };
    const before = structuredClone(patient);
    const result = validateResource(patient);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'error', code: 'structure', message: expect.stringContaining(`Patient.${field}`) }),
    ]));
    expect(patient).toEqual(before);
  });

  it('allows absent optional arrays and populated Patient extensions', () => {
    const patient = {
      resourceType: 'Patient', id: PATIENT,
      extension: [{ url: 'https://example.test/fhir/patient-note', valueString: 'synthetic' }],
    };
    const before = structuredClone(patient);
    expect(validateResource(patient)).toEqual({ valid: true, issues: [] });
    expect(patient).toEqual(before);
  });

  it.each([
    { label: 'empty array', extension: [] },
    { label: 'populated array', extension: [{ url: 'https://example.test/fhir/main-resource', valueCode: 'Patient' }] },
  ])(
    'rejects the illegal Bundle.extension $label through both validator entry points', ({ extension }) => {
      const bundle = {
        resourceType: 'Bundle', type: 'collection', extension,
        entry: [{ resource: { resourceType: 'Patient', id: PATIENT } }],
      };
      const before = structuredClone(bundle);
      expect(validateResource(bundle).valid).toBe(false);
      const result = validateBundle(bundle);
      expect(result).toMatchObject({ valid: false, entryCount: 1, invalidCount: 0 });
      expect(result.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ severity: 'error', code: 'structure', message: expect.stringContaining('Bundle.extension') }),
      ]));
      expect(bundle).toEqual(before);
    },
  );

  it('counts invalid Patient entries without silently dropping them', () => {
    const bundle = {
      resourceType: 'Bundle', type: 'searchset',
      entry: [
        { resource: { resourceType: 'Patient', id: PATIENT, telecom: [] } },
        { resource: { resourceType: 'Patient', id: 'other-patient' } },
      ],
    };
    const before = structuredClone(bundle);
    expect(validateBundle(bundle)).toMatchObject({ valid: false, entryCount: 2, invalidCount: 1 });
    expect(bundle).toEqual(before);
  });
});
