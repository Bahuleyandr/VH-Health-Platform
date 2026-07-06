import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
  prismaReadOnly: { $queryRawUnsafe: queryUnsafeMock },
  setTenant: async (_tenantId, fn) => fn({ $queryRawUnsafe: queryUnsafeMock }),
  setTenantTx: async (_tenantId, fn) => fn({ $queryRawUnsafe: queryUnsafeMock }),
}));

const {
  buildClaimRequestBundle,
  buildClaimStatusTaskBundle,
} = await import('../../services/nhcx/nhcxFhirProfileService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';

function claimSnapshot(overrides = {}) {
  return {
    claim_id: 88,
    claim_number: 'CL-2627-00088',
    policy_id: 55,
    preauth_id: 77,
    invoice_id: 99,
    patient_uid: PATIENT,
    admission_id: 7001,
    claim_type: 'cashless',
    claim_status: 'prepared',
    total_billed: 80000,
    patient_copay: 0,
    non_payable_amount: 0,
    claimed_amount: 76000,
    approved_amount: null,
    disallowed_amount: null,
    denial_reason: null,
    submitted_at: null,
    submission_channel: null,
    claim_notes: null,
    tenant_id: TENANT,
    claim_created_at: new Date('2026-07-05T10:00:00Z'),
    claim_updated_at: new Date('2026-07-05T10:30:00Z'),
    stage: 'final',
    parent_claim_id: 44,
    policy_number: 'POL-123',
    member_id: 'MEM-123',
    group_number: 'GRP-1',
    insurer_name: 'Mock Insurer',
    policy_type: 'family_floater',
    policy_status: 'active',
    valid_from: '2026-01-01',
    valid_to: '2026-12-31',
    payer_name: 'Mock Payer',
    payer_code: 'PAYER-NHCX-MOCK',
    tpa_name: 'Mock TPA',
    tpa_code: 'TPA-MOCK',
    uid: PATIENT,
    patient_id: 501,
    name: 'Test Patient',
    phone: '+919999999999',
    email: 'patient@example.test',
    gender: 'female',
    birthday: '1990-01-01',
    address: 'Chennai',
    admission_status: 'admitted',
    admitted_at: new Date('2026-07-01T08:00:00Z'),
    room_category: 'private',
    ...overrides,
  };
}

function claimDocs() {
  return [
    {
      id: 10,
      claim_id: 88,
      doc_type: 'final_bill',
      file_name: 'final-bill-99.pdf',
      file_size_bytes: 1234,
      mime_type: 'application/pdf',
      uploaded_at: new Date('2026-07-05T10:20:00Z'),
      notes: 'selected for NHCX',
    },
    {
      id: 11,
      claim_id: 88,
      doc_type: 'discharge_summary',
      file_name: 'discharge-summary-7001.pdf',
      file_size_bytes: 4321,
      mime_type: 'application/pdf',
      uploaded_at: new Date('2026-07-05T10:21:00Z'),
      notes: 'selected for NHCX',
    },
  ];
}

function resource(bundle, type) {
  return bundle.entry.map((item) => item.resource).filter((item) => item.resourceType === type);
}

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

describe('NHCX P2 claim FHIR profile builders', () => {
  it('builds a valid final cashless Claim bundle with selected DocumentReference stubs', async () => {
    queryUnsafeMock.mockResolvedValueOnce([claimSnapshot()]);
    queryUnsafeMock.mockResolvedValueOnce(claimDocs());

    const built = await buildClaimRequestBundle({
      tenantId: TENANT,
      claimId: 88,
      documentIds: [10, 11],
      participantCodeSelf: 'VH-NHCX-PROVIDER',
      participantCodeCounterparty: 'PAYER-NHCX-MOCK',
    });

    const claim = resource(built.bundle, 'Claim')[0];
    expect(claim).toMatchObject({
      use: 'claim',
      subType: { text: 'final' },
      related: [{ claim: { identifier: { value: '44' } } }],
      total: { value: 76000, currency: 'INR' },
    });
    expect(resource(built.bundle, 'DocumentReference')).toHaveLength(2);
    expect(JSON.stringify(built.bundle)).not.toContain('insurance_claims');
    expect(JSON.stringify(built.bundle)).not.toContain('s3://');
    expect(built).toMatchObject({
      claimId: 88,
      preauthId: 77,
      workflowId: '7001',
      domainResourceType: 'Claim',
    });
  });

  it('uses the same tpa_claims surface for reimbursement claims and never probes legacy claim tables', async () => {
    queryUnsafeMock.mockResolvedValueOnce([claimSnapshot({
      claim_type: 'reimbursement',
      stage: 'reimbursement',
      preauth_id: null,
      admission_id: null,
      parent_claim_id: null,
    })]);
    queryUnsafeMock.mockResolvedValueOnce([]);

    const built = await buildClaimRequestBundle({
      tenantId: TENANT,
      claimId: 88,
      participantCodeSelf: 'VH-NHCX-PROVIDER',
      participantCodeCounterparty: 'PAYER-NHCX-MOCK',
    });

    const claim = resource(built.bundle, 'Claim')[0];
    expect(claim.use).toBe('claim');
    expect(claim.subType.text).toBe('reimbursement');
    expect(built.workflowId).toBe('claim-88');
    const sql = queryUnsafeMock.mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).toContain('FROM tpa_claims c');
    expect(sql).not.toMatch(/insurance_claims|INSURANCE_AR/i);
  });

  it('builds Task-based claim status checks without changing the workflow resource', async () => {
    queryUnsafeMock.mockResolvedValueOnce([claimSnapshot()]);

    const built = await buildClaimStatusTaskBundle({
      tenantId: TENANT,
      claimId: 88,
      participantCodeSelf: 'VH-NHCX-PROVIDER',
      participantCodeCounterparty: 'PAYER-NHCX-MOCK',
    });

    expect(resource(built.bundle, 'Task')[0]).toMatchObject({
      status: 'requested',
      intent: 'order',
      focus: { reference: 'Claim/claim-88' },
    });
    expect(built).toMatchObject({
      claimId: 88,
      domainResourceType: 'Task',
      workflowId: '7001',
    });
  });
});
