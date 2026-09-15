import fs from 'node:fs';
import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
  prismaReadOnly: { $queryRawUnsafe: queryUnsafeMock },
  setTenant: async (_tenantId, fn) => fn({ $queryRawUnsafe: queryUnsafeMock }),
  setTenantTx: async (_tenantId, fn) => fn({ $queryRawUnsafe: queryUnsafeMock }),
}));

const {
  buildCoverageEligibilityRequestBundle, buildPreauthClaimRequestBundle,
  buildClaimRequestBundle, buildClaimStatusTaskBundle, buildCommunicationResponseBundle,
  validateNHCXOutboundBundle, assertNHCXOutboundBundle, validateNHCXInboundBundle,
  payloadHash, NHCX_PROFILE_URLS, NRCES_NHCX_PROFILE_VERSION,
} = await import('../../services/nhcx/nhcxFhirProfileService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const API_CALL = '22222222-2222-4222-8222-222222222222';
const PRIOR_CALL = '33333333-3333-4333-8333-333333333333';
const TIMESTAMP = '2026-07-05T10:30:00.000Z';
const PARTICIPANTS = {
  tenantId: TENANT,
  participantCodeSelf: 'VH-NHCX-PROVIDER',
  participantCodeCounterparty: 'PAYER-NHCX-MOCK',
};

function snapshot(populated) {
  return {
    tenant_id: TENANT, uid: PATIENT, patient_uid: PATIENT, patient_id: 501,
    policy_id: 55, preauth_id: 77, claim_id: 88, admission_id: 7001,
    policy_number: 'POL-123', member_id: 'MEM-123', group_number: 'GRP-1',
    policy_type: 'family_floater', policy_status: 'active',
    valid_from: '2026-01-01', valid_to: '2026-12-31',
    insurer_name: 'Mock Insurer', payer_name: 'Mock Payer', payer_code: 'PAYER-NHCX-MOCK',
    preauth_number: 'PRE-123', request_type: 'preauthorization',
    primary_diagnosis: 'Synthetic diagnosis', proposed_procedure: 'Synthetic procedure',
    icd10_codes: ['Z00.0'], procedure_codes: ['SYNTHETIC-PROCEDURE'], expected_cost: 42000,
    claim_number: 'CL-2627-00088', claim_type: 'cashless', claim_status: 'prepared',
    stage: 'final', claimed_amount: 76000,
    policy_updated_at: TIMESTAMP, preauth_updated_at: TIMESTAMP, claim_updated_at: TIMESTAMP,
    admission_status: 'admitted', admitted_at: '2026-07-01T08:00:00.000Z', room_category: 'private',
    name: populated ? 'Synthetic Patient' : null,
    phone: populated ? '+919999999999' : null,
    email: populated ? 'patient@example.test' : null,
    gender: 'female', birthday: '1990-01-01', address: 'Synthetic address',
  };
}

function correspondence() {
  return {
    id: 91, tenant_id: TENANT, claim_id: 88, preauth_id: null,
    subject: 'Synthetic query response', body: 'Synthetic response retained verbatim.',
    recorded_at: TIMESTAMP,
    attachments: [{ document_ids: [], nhcx: {
      api_call_id: API_CALL, in_response_to_api_call_id: PRIOR_CALL, workflow_id: '7001',
    } }],
  };
}

function resource(bundle, type) {
  const matches = bundle.entry.map((item) => item.resource).filter((item) => item.resourceType === type);
  expect(matches).toHaveLength(1);
  return matches[0];
}

const BUILDERS = [
  { name: 'eligibility', build: buildCoverageEligibilityRequestBundle, args: { policyId: 55, admissionId: 7001 },
    type: 'CoverageEligibilityRequest', profile: 'coverageEligibilityRequestBundle', entries: 6, queries: 1 },
  { name: 'preauthorization', build: buildPreauthClaimRequestBundle, args: { preauthId: 77 },
    type: 'Claim', profile: 'preauthClaimRequestBundle', entries: 6, queries: 1, claimUse: 'preauthorization', amount: 42000 },
  { name: 'final Claim', build: buildClaimRequestBundle, args: { claimId: 88 },
    type: 'Claim', profile: 'claimRequestBundle', entries: 6, queries: 2, claimUse: 'claim', amount: 76000 },
  { name: 'claim status Task', build: buildClaimStatusTaskBundle, args: { claimId: 88 },
    type: 'Task', profile: 'taskBundle', entries: 7, queries: 1, claimUse: 'claim', amount: 76000 },
  { name: 'Communication response', build: buildCommunicationResponseBundle, args: { hcxApiCallId: API_CALL },
    type: 'Communication', profile: 'communicationBundle', entries: 6, queries: 2 },
];

beforeEach(() => queryUnsafeMock.mockReset());

describe('Actual NHCX bundle producers', () => {
  it('covers all five shared bundle-helper consumers', () => {
    expect(BUILDERS.map((builder) => builder.build)).toEqual([
      buildCoverageEligibilityRequestBundle, buildPreauthClaimRequestBundle,
      buildClaimRequestBundle, buildClaimStatusTaskBundle, buildCommunicationResponseBundle,
    ]);
    expect(new Set(BUILDERS.map((builder) => builder.build)).size).toBe(5);
  });

  describe.each(BUILDERS)('$name', (builder) => {
    it.each([false, true])('preserves the snapshot and emits valid optional fields (populated=%s)', async (populated) => {
      const row = snapshot(populated);
      const message = correspondence();
      const before = structuredClone({ row, message });
      queryUnsafeMock.mockImplementation(async (sql) => {
        if (sql.includes('FROM tpa_claim_correspondence')) return [message];
        if (sql.includes('FROM tpa_claim_documents')) return [];
        if (/FROM (insurance_policies p|insurance_preauth pre|tpa_claims c)\b/.test(sql)) return [row];
        throw new Error(`Unexpected snapshot query: ${sql}`);
      });

      const built = await builder.build({ ...PARTICIPANTS, ...builder.args });
      expect(queryUnsafeMock).toHaveBeenCalledTimes(builder.queries);
      expect(built.bundle.entry).toHaveLength(builder.entries);
      expect(built.bundle).not.toHaveProperty('extension');
      expect(built.bundle.meta).toEqual({
        profile: [NHCX_PROFILE_URLS[builder.profile]], versionId: NRCES_NHCX_PROFILE_VERSION,
      });
      expect(built).toMatchObject({
        domainResourceType: builder.type, profileUrl: NHCX_PROFILE_URLS[builder.profile],
        profileVersion: NRCES_NHCX_PROFILE_VERSION, patientUid: PATIENT, admissionId: 7001, policyId: 55,
      });
      expect(built.bundle.timestamp).toBe(TIMESTAMP);
      const patient = resource(built.bundle, 'Patient');
      expect(patient.id).toBe(PATIENT);
      expect(patient.identifier).toEqual([{ system: 'urn:vhhealth:uid', value: PATIENT }]);
      if (populated) {
        expect(patient.name).toEqual([{ use: 'official', text: 'Synthetic Patient' }]);
        expect(patient.telecom).toEqual([
          { system: 'phone', value: '+919999999999', use: 'mobile' },
          { system: 'email', value: 'patient@example.test' },
        ]);
      } else {
        expect(patient).not.toHaveProperty('name');
        expect(patient).not.toHaveProperty('telecom');
      }
      const main = resource(built.bundle, builder.type);
      if (builder.claimUse) {
        const claim = resource(built.bundle, 'Claim');
        expect(claim.use).toBe(builder.claimUse);
        expect(claim.total).toEqual({ value: builder.amount, currency: 'INR' });
        expect(claim.item[0].unitPrice).toEqual({ value: builder.amount, currency: 'INR' });
        expect(claim.item[0].net).toEqual({ value: builder.amount, currency: 'INR' });
        expect(built.workflowId).toBe('7001');
      }
      if (builder.type === 'Task') {
        expect(main).toMatchObject({ status: 'requested', intent: 'order', focus: { reference: 'Claim/claim-88' } });
      }
      if (builder.type === 'Communication') {
        expect(main.identifier).toEqual([{ system: 'urn:vhhealth:nhcx-communication-api-call-id', value: API_CALL }]);
        expect(main.inResponseTo).toEqual([{ identifier: {
          system: 'urn:vhhealth:nhcx-communication-request-api-call-id', value: PRIOR_CALL,
        } }]);
        expect(main.payload).toEqual([{ contentString: message.body }]);
        expect(built.workflowId).toBe('7001');
      }
      expect(validateNHCXOutboundBundle(built.bundle, {
        expectedMainResourceType: builder.type, expectedClaimUse: builder.claimUse,
      })).toEqual({ valid: true, issues: [], entryCount: builder.entries });
      expect(built.payloadHash).toBe(payloadHash(built.bundle));
      const repeated = await builder.build({ ...PARTICIPANTS, ...builder.args });
      expect(repeated).toEqual(built);
      expect(queryUnsafeMock).toHaveBeenCalledTimes(builder.queries * 2);
      expect({ row, message }).toEqual(before);
    });
  });
});

function literalBundle() {
  return {
    resourceType: 'Bundle', id: 'literal-task-bundle', type: 'collection',
    meta: { profile: [NHCX_PROFILE_URLS.taskBundle], versionId: NRCES_NHCX_PROFILE_VERSION },
    entry: [
      { resource: { resourceType: 'Patient', id: PATIENT } },
      { resource: {
        resourceType: 'Task', id: 'literal-status-task', status: 'requested', intent: 'order',
        code: { text: 'Synthetic status request' }, for: { reference: `Patient/${PATIENT}` }, authoredOn: TIMESTAMP,
      } },
    ],
  };
}

describe('NHCX validation preserves inbound evidence', () => {
  it.each(['Bundle.extension', 'Patient.name', 'Patient.telecom'])('%s is an outbound error but an unchanged inbound warning', (field) => {
    const bundle = literalBundle();
    expect(validateNHCXOutboundBundle(bundle, { expectedMainResourceType: 'Task' }).valid).toBe(true);
    const validHash = payloadHash(bundle);
    if (field === 'Bundle.extension') {
      bundle.extension = [{ url: 'https://vhhealth.app/fhir/StructureDefinition/nhcx-main-resource', valueCode: 'Task' }];
    } else {
      bundle.entry[0].resource[field.split('.')[1]] = [];
    }
    const before = structuredClone(bundle);
    const evidenceHash = payloadHash(bundle);
    expect(evidenceHash).not.toBe(validHash);
    const outbound = validateNHCXOutboundBundle(bundle, { expectedMainResourceType: 'Task' });
    expect(outbound.valid).toBe(false);
    expect(outbound.issues).toEqual([expect.objectContaining({
      severity: 'error', code: 'structure', message: expect.stringContaining(field),
    })]);
    expect(() => assertNHCXOutboundBundle(bundle, { expectedMainResourceType: 'Task' })).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'NHCX_FHIR_PROFILE_INVALID' }),
    );
    const inbound = validateNHCXInboundBundle(bundle, { expectedMainResourceType: 'Task' });
    expect(inbound).toEqual({
      valid: true, entryCount: 2,
      issues: outbound.issues.map((issue) => ({ ...issue, severity: 'warning' })),
    });
    expect(bundle).toEqual(before);
    expect(payloadHash(bundle)).toBe(evidenceHash);
  });
});

describe('Informational NHCX sample structural parity', () => {
  it.each([
    'nhcx_coverageeligibility_request_bundle.json', 'nhcx_preauth_claim_request_bundle.json',
  ])('%s contains no illegal Bundle extension or empty Patient contacts', (name) => {
    const sample = JSON.parse(fs.readFileSync(new URL(`../../services/fhir/__samples__/${name}`, import.meta.url), 'utf8'));
    expect(sample.entry).toHaveLength(6);
    expect(sample).not.toHaveProperty('extension');
    const patient = resource(sample, 'Patient');
    expect(patient.name).toEqual([{ use: 'official', text: 'NHCX Sample Patient' }]);
    expect(patient).not.toHaveProperty('telecom');
  });
});
