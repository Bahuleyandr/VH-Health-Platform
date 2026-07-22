import { jest } from '@jest/globals';

const queryRawMock = jest.fn();
const executeRawMock = jest.fn();
const recordCanonicalClinicalEventMock = jest.fn();
const createGenerationMock = jest.fn();
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

const db = {
  $queryRawUnsafe: queryRawMock,
  $executeRawUnsafe: executeRawMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: db,
  setTenantTx: async (_tenantId, fn) => fn(db),
  setTenant: async (_tenantId, fn) => fn(db),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(db),
  pickTenantClient: () => db,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (tenantId) => tenantId || DEFAULT_TENANT_ID,
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
}));
jest.unstable_mockModule('../../services/diagnostics/structuredReportDiagnosticGenerationService.js', () => ({
  createRadiologyDiagnosticGenerationTx: createGenerationMock,
  normalizeDiagnosticIdempotencyKey: (value) => {
    const key = String(value || '').trim();
    if (!key) throw new Error('Idempotency-Key is required');
    return key;
  },
  normalizeStructuredResultClassification: (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    if (!['critical', 'abnormal', 'normal', 'indeterminate'].includes(normalized)) {
      const error = new Error('result_classification is required');
      error.statusCode = 400;
      throw error;
    }
    return normalized;
  },
  normalizeStructuredClassificationBasis: (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) {
      const error = new Error('classification_basis is required');
      error.statusCode = 400;
      throw error;
    }
    return value;
  },
  normalizeStructuredAddendumSignificance: (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    if (!['unchanged', 'new_finding', 'worsened', 'improved', 'corrected'].includes(normalized)) {
      const error = new Error('clinical_significance is required');
      error.statusCode = 400;
      throw error;
    }
    return normalized;
  },
}));

const { default: radiologyService } = await import('../../services/radiology/radiologyService.js');

const SIGNED_AT = new Date('2026-05-22T10:00:00Z');
const SIGNED_BY = 'aaaa1111-2222-4333-8444-555555555555';
const RADIOLOGIST_UID = 'bbbb1111-2222-4333-8444-666666666666';
const PATIENT_UID = 'cccc1111-2222-4333-8444-777777777777';

function input(overrides = {}) {
  return {
    addendum: 'On second review, a small subpleural nodule is seen.',
    addendum_by: RADIOLOGIST_UID,
    result_classification: 'abnormal',
    classification_basis: { source: 'radiologist_attestation' },
    clinical_significance: 'new_finding',
    idempotencyKey: 'radiology-addendum-unit-1',
    actorRole: 'RADIOLOGIST',
    ...overrides,
  };
}

function signedOrder(overrides = {}) {
  return {
    id: 20,
    tenant_id: DEFAULT_TENANT_ID,
    patient_uid: PATIENT_UID,
    encounter_id: null,
    status: 'completed',
    report: 'Original findings.\nImpression: normal.',
    structured_report: {},
    modality: 'ct',
    body_part: 'chest',
    priority: 'routine',
    ordered_by: SIGNED_BY,
    report_signed_off_at: SIGNED_AT,
    report_signed_off_by: SIGNED_BY,
    result_classification: 'normal',
    report_generation_version: 1,
    updated_at: SIGNED_AT,
    created_at: SIGNED_AT,
    ...overrides,
  };
}

describe('radiologyService.appendReportAddendum', () => {
  beforeEach(() => {
    queryRawMock.mockReset();
    executeRawMock.mockReset();
    recordCanonicalClinicalEventMock.mockReset();
    createGenerationMock.mockReset();
    recordCanonicalClinicalEventMock.mockResolvedValue({
      timeline: { id: '11111111-2222-4333-8444-555555555555' },
      audit: { id: '66666666-7777-4888-8999-aaaaaaaaaaaa' },
    });
    createGenerationMock.mockResolvedValue({
      id: 'dddd1111-2222-4333-8444-888888888888',
      source_version: 2,
    });
    executeRawMock.mockResolvedValue(1);
  });

  it('rejects when the report is not yet signed off', async () => {
    queryRawMock.mockResolvedValueOnce([signedOrder({ report_signed_off_at: null })]);
    await expect(radiologyService.appendReportAddendum(20, input()))
      .rejects.toMatchObject({ statusCode: 400, code: 'REPORT_NOT_SIGNED_OFF' });
  });

  it('rejects a cancelled order', async () => {
    queryRawMock.mockResolvedValueOnce([signedOrder({ status: 'cancelled' })]);
    await expect(radiologyService.appendReportAddendum(20, input()))
      .rejects.toThrow(/cancelled/i);
  });

  it('requires explicit structured classification and significance', async () => {
    await expect(radiologyService.appendReportAddendum(20, input({ addendum: ' ' })))
      .rejects.toThrow(/addendum text is required/i);
    await expect(radiologyService.appendReportAddendum(20, input({ result_classification: null })))
      .rejects.toThrow(/result_classification/i);
    await expect(radiologyService.appendReportAddendum(20, input({ classification_basis: null })))
      .rejects.toThrow(/classification_basis/i);
    await expect(radiologyService.appendReportAddendum(20, input({ clinical_significance: null })))
      .rejects.toThrow(/clinical_significance/i);
  });

  it('creates an immutable addendum generation without rewriting the signed report', async () => {
    const order = signedOrder();
    const addendum = {
      id: 91n,
      generation_version: 2n,
      addendum_text: input().addendum,
      previous_classification: 'normal',
      result_classification: 'abnormal',
      classification_basis: input().classification_basis,
      clinical_significance: 'new_finding',
      signed_by: RADIOLOGIST_UID,
      signed_at: new Date('2026-07-22T12:00:00Z'),
    };
    queryRawMock
      .mockResolvedValueOnce([order])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([addendum]);

    const result = await radiologyService.appendReportAddendum(20, input());

    expect(queryRawMock.mock.calls.some(([sql]) => /UPDATE radiology_orders/i.test(sql))).toBe(false);
    expect(queryRawMock.mock.calls[2][0]).toMatch(/INSERT INTO radiology_report_addenda/i);
    expect(createGenerationMock).toHaveBeenCalledWith(expect.objectContaining({
      radiologyOrderId: 20,
      radiologyAddendumId: 91n,
      sourceVersion: 2,
      resultClassification: 'abnormal',
      clinicalSignificance: 'new_finding',
      orderingOwnerUid: SIGNED_BY,
    }));
    expect(executeRawMock).toHaveBeenCalledWith(
      expect.stringContaining('RADIOLOGY_REPORT_ADDENDUM'),
      RADIOLOGIST_UID,
      '20',
      expect.stringContaining('"generation_version":2'),
    );
    expect(result.report).toBe(order.report);
    expect(result.report_signed_off_at).toBe(SIGNED_AT);
    expect(result.addendum).toMatchObject({
      id: 91,
      generation_version: 2,
      result_classification: 'abnormal',
    });
    expect(result.diagnostic_generation.source_version).toBe(2);
  });

  it('rejects legacy signed reports that lack structured generation one', async () => {
    queryRawMock.mockResolvedValueOnce([signedOrder({
      result_classification: null,
      report_generation_version: null,
    })]);
    await expect(radiologyService.appendReportAddendum(20, input()))
      .rejects.toMatchObject({ code: 'DIAGNOSTIC_SOURCE_RECONCILIATION_REQUIRED' });
  });
});
