import {
  buildPriorAuthPayerPayload,
  resolvePriorAuthPayerConfig,
  submitPriorAuthToPayer,
} from '../../services/ai/priorAuthorizationPayerAdapterService.js';

const priorAuth = {
  id: 42,
  tenant_id: '00000000-0000-4000-8000-000000000001',
  admission_id: 1001,
  patient_uid: '11111111-1111-4111-8111-111111111111',
  payer_name: 'Test Payer',
  policy_number: 'POL-123',
  procedure_code: 'PROC-9',
  procedure_description: 'Monitored inpatient procedure',
  requested_service_type: 'inpatient_procedure',
  medical_necessity: 'Procedure is supported by signed clinical documentation.',
  clinical_evidence: { diagnoses: [{ icd10: 'J18.9', description: 'Pneumonia' }] },
  packet_draft: { patient_summary: 'Admitted for pneumonia management.' },
  citations: [{ source_type: 'clinical_note', source_id: '7', label: 'Signed progress note' }],
};

describe('prior authorization payer adapter', () => {
  it('defaults to manual submission without blocking local workflow', async () => {
    const result = await submitPriorAuthToPayer({
      priorAuth,
      payerReferenceId: 'MANUAL-REF-1',
      env: {},
    });

    expect(result.status).toBe('manual_submission_required');
    expect(result.reason).toBe('manual_payer_submission');
    expect(result.reference_id).toBe('MANUAL-REF-1');
    expect(result.submitted).toBe(false);
    expect(result.blocking).toBe(false);
  });

  it('builds a bounded payer payload from the saved packet', () => {
    const payload = buildPriorAuthPayerPayload(priorAuth, { payerReferenceId: 'REQ-9' });

    expect(payload).toMatchObject({
      prior_auth_id: 42,
      patient_uid: priorAuth.patient_uid,
      payer_name: 'Test Payer',
      policy_number: 'POL-123',
      procedure_code: 'PROC-9',
      requested_reference_id: 'REQ-9',
      clinical_evidence: priorAuth.clinical_evidence,
      packet_draft: priorAuth.packet_draft,
    });
    expect(payload.citations).toHaveLength(1);
  });

  it('posts HTTP submissions with auth and normalizes payer references', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 202,
        json: async () => ({ request_id: 'PAYER-777', status: 'accepted' }),
      };
    };

    const result = await submitPriorAuthToPayer({
      priorAuth,
      tenantRegion: 'IN',
      env: {
        PRIOR_AUTH_PAYER_MODE: 'http',
        PRIOR_AUTH_PAYER_ENDPOINT: 'https://payer.example.test/prior-auth',
        PRIOR_AUTH_PAYER_API_KEY: 'secret-value',
        PRIOR_AUTH_PAYER_ALLOWED_REGIONS: 'IN,US',
      },
      fetchImpl,
    });

    expect(result.status).toBe('submitted');
    expect(result.submitted).toBe(true);
    expect(result.reference_id).toBe('PAYER-777');
    expect(result.payer_status).toBe('accepted');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://payer.example.test/prior-auth');
    expect(calls[0].options.method).toBe('POST');
    expect(calls[0].options.headers.Authorization).toBe('Bearer secret-value');
    expect(calls[0].options.headers['Idempotency-Key']).toBe('vh-prior-auth-42');
    expect(JSON.parse(calls[0].options.body).procedure_code).toBe('PROC-9');
  });

  it('blocks explicit HTTP mode when no endpoint is configured', async () => {
    const result = await submitPriorAuthToPayer({
      priorAuth,
      env: { PRIOR_AUTH_PAYER_MODE: 'http' },
    });

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('payer_endpoint_not_configured');
    expect(result.blocking).toBe(true);
  });

  it('blocks external payer submission outside the allowed tenant regions', () => {
    const config = resolvePriorAuthPayerConfig({
      tenantRegion: 'EU',
      env: {
        PRIOR_AUTH_PAYER_MODE: 'webhook',
        PRIOR_AUTH_PAYER_ENDPOINT: 'https://payer.example.test/prior-auth',
        PRIOR_AUTH_PAYER_ALLOWED_REGIONS: 'IN,US',
      },
    });

    expect(config.configured).toBe(false);
    expect(config.reason).toBe('tenant_region_not_allowed_for_payer');
  });
});
