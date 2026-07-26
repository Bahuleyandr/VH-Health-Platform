import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { jest } from '@jest/globals';

const linkPendingResultOwnerActionsForGenerationTxMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  isTenantTransactionClient: () => true,
}));
jest.unstable_mockModule(
  '../../services/clinical/canonicalClinicalPlatformService.js',
  () => ({ recordCanonicalClinicalEvent: jest.fn() }),
);
jest.unstable_mockModule(
  '../../services/emr/inpatientPathwayDomainService.js',
  () => ({
    linkPendingResultOwnerActionsForGenerationTx:
      linkPendingResultOwnerActionsForGenerationTxMock,
    publishInpatientDiagnosticResourceLinkedTx: jest.fn(),
  }),
);
jest.unstable_mockModule('../../services/events/eventOutboxService.js', () => ({
  publishEvent: jest.fn(),
}));

const {
  createLabDiagnosticGenerationTx,
  createSharedInvestigationGenerationTx,
} = await import('../../services/diagnostics/diagnosticResultGenerationService.js');

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PATIENT_UID = '20000000-0000-4000-8000-000000000001';
const OTHER_PATIENT_UID = '30000000-0000-4000-8000-000000000001';
const SIGNER_UID = '40000000-0000-4000-8000-000000000001';

describe('diagnostic generation exact inpatient lineage', () => {
  it('rejects a caller-supplied investigation whose DB source belongs to another patient', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('FROM investigations')) {
          return [{
            id: 73,
            tenant_id: TENANT_ID,
            patient_uid: OTHER_PATIENT_UID,
            admission_id: 17,
            result_version: 1,
            test_type: 'LAB',
            test_name: 'Shared test',
            results: { value: 'normal', abnormal_flag: 'N' },
            verified_by: SIGNER_UID,
            verified_at: new Date(),
          }];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };

    await expect(createSharedInvestigationGenerationTx({
      tx,
      tenantId: TENANT_ID,
      investigation: { id: 73, patient_uid: PATIENT_UID },
      signerRole: 'DOCTOR',
    })).rejects.toMatchObject({ code: 'DIAGNOSTIC_SOURCE_IDENTITY_MISMATCH' });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('rejects a signed lab panel when the exact sign-off result set is incomplete', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('FROM lab_pathologist_signoffs')) {
          return [{
            id: 9,
            patient_uid: PATIENT_UID,
            result_ids: [73, 74],
            signed_off_by: SIGNER_UID,
            signed_at: new Date(),
          }];
        }
        if (sql.includes('FROM lab_results')) {
          return [{
            id: 73,
            patient_uid: PATIENT_UID,
            admission_id: 17,
            investigation_id: 81,
            test_code: 'CBC',
            test_name: 'CBC',
            status: 'final',
            signed_off_at: new Date(),
            signed_off_by: SIGNER_UID,
          }];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };

    await expect(createLabDiagnosticGenerationTx({
      tx,
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      episode: { type: 'investigation', id: 81, key: 'investigation:81' },
      signoff: { id: 9 },
      signerRole: 'DOCTOR',
      panelRows: [{ id: 73 }, { id: 74 }],
    })).rejects.toMatchObject({ code: 'DIAGNOSTIC_SOURCE_IDENTITY_MISMATCH' });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('keeps generation replay correlation wired for both lab and shared sources', () => {
    const servicePath = fileURLToPath(new URL(
      '../../services/diagnostics/diagnosticResultGenerationService.js',
      import.meta.url,
    ));
    const source = readFileSync(servicePath, 'utf8');
    const replayCorrelations = source.match(
      /if \(admissionId != null\) \{\s+await linkPendingResultOwnerActionsForGenerationTx\(\{\s+tx: db,\s+tenantId: tid,\s+generationId: existing\.id,/g,
    ) || [];
    expect(replayCorrelations).toHaveLength(2);
  });
});
