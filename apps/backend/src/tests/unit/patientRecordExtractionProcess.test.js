import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const authorizePatientAccessRequestMock = jest.fn();
const getFileFromR2Mock = jest.fn();
const getSignedFileUrlMock = jest.fn();
const ingestClinicalDocumentUploadMock = jest.fn();
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: jest.fn(),
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/security/accessDecisionService.js', () => ({
  ACCESS_POLICY_CODES: {
    PATIENT_RECORD_EXTRACTION_VIEW: 'patient.record.extraction.view',
    PATIENT_RECORD_UPLOAD: 'patient.record.upload',
    PATIENT_RECORD_DELETE: 'patient.record.delete',
    PATIENT_RECORD_VIEW: 'patient.record.view',
  },
  SAFE_PATIENT_ACCESS_DENIAL_MESSAGE: 'Access denied',
  authorizePatientAccessRequest: authorizePatientAccessRequestMock,
}));

jest.unstable_mockModule('../../services/ai/documentIntelligenceService.js', () => ({
  decideClinicalDocumentIntake: jest.fn(),
  ingestClinicalDocumentUpload: ingestClinicalDocumentUploadMock,
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID: '00000000-0000-4000-8000-000000000001',
  resolveTenantOrThrow: (req) => req?.tenantId || '00000000-0000-4000-8000-000000000001',
  requireTenantId: (tenantId) => tenantId || '00000000-0000-4000-8000-000000000001',
}));

jest.unstable_mockModule('../../utils/r2Storage.js', () => ({
  uploadFileToR2: jest.fn(),
  getSignedFileUrl: getSignedFileUrlMock,
  getFileFromR2: getFileFromR2Mock,
  deleteObject: jest.fn(),
}));

jest.unstable_mockModule('../../utils/phoneUtils.js', () => ({
  normalizePhone: (value) => value,
}));

jest.unstable_mockModule('../../utils/notifications/sendPushNotification.js', () => ({
  sendPushNotification: jest.fn(),
}));

const { processPatientRecordExtraction } = await import(
  '../../controllers/appointment/appointmentDocumentController.js'
);

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

function baseReq() {
  return {
    params: { id: '12' },
    protocol: 'https',
    get: jest.fn(() => 'dalekdefender.example.test'),
    tenantId: TENANT_ID,
    user: {
      id: 97,
      uid: '4fd0f5a4-42da-4994-a85b-73ce79699147',
      role: 'PATIENT',
      tenant_id: TENANT_ID,
    },
  };
}

function recordRow(overrides = {}) {
  return {
    id: 12,
    patient_id: 97,
    patient_uid: '4fd0f5a4-42da-4994-a85b-73ce79699147',
    document_type: 'other',
    title: null,
    file_key: 'records/patient_uploads/97/scan.jpg',
    file_url: null,
    file_name: 'scan.jpg',
    file_size: 128,
    file_mime: 'image/jpeg',
    source_hospital: null,
    record_date: null,
    notes: null,
    tenant_id: TENANT_ID,
    created_at: new Date('2026-06-07T10:00:00Z'),
    ai_intake_id: null,
    ai_extraction_status: null,
    ai_document_type: null,
    ai_extracted_fields: null,
    ai_normalized_sections: null,
    ai_source_citations: null,
    ai_safety_flags: null,
    ai_metadata: null,
    ai_raw_text: null,
    ...overrides,
  };
}

describe('processPatientRecordExtraction', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    authorizePatientAccessRequestMock.mockReset();
    getFileFromR2Mock.mockReset();
    getSignedFileUrlMock.mockReset();
    ingestClinicalDocumentUploadMock.mockReset();
    authorizePatientAccessRequestMock.mockResolvedValue({ allowed: true });
    getSignedFileUrlMock.mockResolvedValue('https://signed.example.test/scan.jpg');
  });

  it('returns an existing extraction without creating another intake', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([
      recordRow({
        ai_intake_id: 55,
        ai_extraction_status: 'completed',
        ai_document_type: 'prescription',
        ai_extracted_fields: { medications: [{ text: 'Tab Amlodipine 5 mg' }] },
        ai_normalized_sections: { summary: ['Prescription uploaded'] },
        ai_source_citations: [{ label: 'line 1' }],
        ai_safety_flags: [],
        ai_metadata: { ocr_status: 'completed', text_char_count: 80 },
        ai_raw_text: 'Tab Amlodipine 5 mg',
      }),
    ]);

    const res = makeRes();
    await processPatientRecordExtraction(baseReq(), res);

    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('pr.tenant_id = $2::uuid');
    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('pu.tenant_id = $2::uuid');
    expect(queryRawUnsafeMock.mock.calls[0][2]).toBe(TENANT_ID);
    expect(getFileFromR2Mock).not.toHaveBeenCalled();
    expect(ingestClinicalDocumentUploadMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.data.processed).toBe(false);
    expect(body.data.ai_extraction).toEqual(expect.objectContaining({
      intake_id: 55,
      raw_text: 'Tab Amlodipine 5 mg',
    }));
  });

  it('downloads the stored file and processes extraction when no intake exists', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([recordRow()])
      .mockResolvedValueOnce([
        recordRow({
          ai_intake_id: 77,
          ai_extraction_status: 'completed',
          ai_document_type: 'lab_report',
          ai_extracted_fields: { investigations: [{ text: 'Hb 12 g/dL' }] },
          ai_normalized_sections: { summary: ['Lab report uploaded'] },
          ai_source_citations: [{ label: 'line 1' }],
          ai_safety_flags: [],
          ai_metadata: { ocr_status: 'completed', text_char_count: 40 },
          ai_raw_text: 'Hb 12 g/dL',
        }),
      ]);
    getFileFromR2Mock.mockResolvedValue(Buffer.from('fake-image'));
    ingestClinicalDocumentUploadMock.mockResolvedValue({
      intake_id: 77,
      extraction_status: 'completed',
    });

    const res = makeRes();
    await processPatientRecordExtraction(baseReq(), res);

    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('pr.tenant_id = $2::uuid');
    expect(queryRawUnsafeMock.mock.calls[0][2]).toBe(TENANT_ID);
    expect(queryRawUnsafeMock.mock.calls[1][0]).toContain('pr.tenant_id = $2::uuid');
    expect(queryRawUnsafeMock.mock.calls[1][2]).toBe(TENANT_ID);
    expect(getFileFromR2Mock).toHaveBeenCalledWith('records/patient_uploads/97/scan.jpg');
    expect(ingestClinicalDocumentUploadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        patientUid: '4fd0f5a4-42da-4994-a85b-73ce79699147',
        sourceType: 'other',
        title: null,
        storageKey: 'records/patient_uploads/97/scan.jpg',
        file: expect.objectContaining({
          originalname: 'scan.jpg',
          mimetype: 'image/jpeg',
        }),
      }),
    );
    const body = res.json.mock.calls[0][0];
    expect(body.data.processed).toBe(true);
    expect(body.data.ai_extraction.intake_id).toBe(77);
  });
});
