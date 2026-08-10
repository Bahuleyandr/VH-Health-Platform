/**
 * ABHA linkage contract (audit follow-up P13).
 *
 * `registerABHA` links an ABHA the patient ALREADY HOLDS — it is not an ABDM
 * enrolment. These pin the three things a caller can get wrong (number format,
 * address format, a number already held by someone else), plus the shape the
 * endpoint returns, which the patient app renders directly.
 */
import { jest } from '@jest/globals';

const prismaQuery = jest.fn();
const setTenantMock = jest.fn();
const verifyABHA = jest.fn();
const recordClinicalAuditEventMock = jest.fn();

jest.unstable_mockModule('../../config/abdmConfig.js', () => ({
  ABDM_CONFIG: {
    enabled: false,
    hipId: 'HIP-1',
    hipName: 'VH Health',
    PURPOSES: ['CAREMGT'],
  },
}));
const __prismaMock = { $queryRawUnsafe: prismaQuery };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaMock,
  setTenant: setTenantMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaMock),
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordClinicalAuditEvent: recordClinicalAuditEventMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('../../services/abdm/abdmCrypto.js', () => ({
  encryptFhirBundle: jest.fn(),
}));
jest.unstable_mockModule('../../services/abdm/abdmGateway.js', () => ({
  default: { verifyABHA },
}));
jest.unstable_mockModule('../../utils/ssrfGuard.js', () => ({
  assertSafeOutboundUrl: jest.fn(),
}));

const TENANT_ID = 'ab100000-0000-4000-8000-00000000b001';
const PATIENT_UID = 'ab100000-0000-4000-8000-0000000007b1';

const { default: abdmService } = await import('../../services/abdm/abdmService.js');

/**
 * registerABHA issues three queries in order: patient lookup, duplicate-ABHA
 * probe, then the UPDATE. Queue the rows each should return.
 */
function stubQueries({ patient = [{ uid: PATIENT_UID }], duplicate = [], updated } = {}) {
  prismaQuery.mockReset();
  prismaQuery
    .mockResolvedValueOnce(patient)
    .mockResolvedValueOnce(duplicate)
    .mockResolvedValueOnce(updated ?? [{
      uid: PATIENT_UID,
      tenant_id: TENANT_ID,
      name: 'Test Patient',
      phone: '+919000000001',
      abha_number: '12-3456-7890-1234',
      abha_address: null,
      abha_verification_status: 'pending',
      abha_verified_at: null,
      updated_at: new Date(),
    }]);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('registerABHA — ABHA number', () => {
  it('links a valid hyphenated number and returns the linkage shape', async () => {
    stubQueries();

    const result = await abdmService.registerABHA(
      PATIENT_UID, '12-3456-7890-1234', null, { tenantId: TENANT_ID },
    );

    expect(result).toEqual({
      linked: true,
      abhaNumber: '12-3456-7890-1234',
      abhaAddress: null,
      verification_status: 'pending',
      abha_verified_at: null,
    });
    // Not the raw user row — name/phone/tenant_id must not reach the client.
    expect(result).not.toHaveProperty('phone');
  });

  it('mints a PENDING link while ABDM is disabled and records the audit row in the tx', async () => {
    stubQueries();

    await abdmService.registerABHA(
      PATIENT_UID, '12-3456-7890-1234', null, { tenantId: TENANT_ID },
    );

    // The UPDATE stamps the verification status explicitly (never 'verified'
    // without a gateway check).
    const [updateSql, ...updateArgs] = prismaQuery.mock.calls[2];
    expect(updateSql).toContain('abha_verification_status = $3');
    expect(updateArgs[2]).toBe('pending');
    // Canonical audit row (ABHA_LINKED) written via the same-transaction helper.
    expect(recordClinicalAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ABHA_LINKED',
        patientUid: PATIENT_UID,
        tenantId: TENANT_ID,
        metadata: expect.objectContaining({
          verification_status: 'pending',
          gateway_verification_ran: false,
          actor: 'self',
        }),
      }),
      expect.objectContaining({ db: expect.anything() }),
    );
  });

  it('records the admin actor when an admin links on behalf of a patient', async () => {
    stubQueries();
    const ADMIN_UID = 'ab100000-0000-4000-8000-0000000000ad';

    await abdmService.registerABHA(
      PATIENT_UID, '12-3456-7890-1234', null,
      { tenantId: TENANT_ID, actorUid: ADMIN_UID, actorRole: 'ADMIN' },
    );

    expect(recordClinicalAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUid: ADMIN_UID,
        actorRole: 'ADMIN',
        metadata: expect.objectContaining({ actor: 'admin_patient_uid' }),
      }),
      expect.anything(),
    );
  });

  it('rejects a number that is not 14 digits', async () => {
    stubQueries();

    await expect(
      abdmService.registerABHA(PATIENT_UID, '12-3456', null, { tenantId: TENANT_ID }),
    ).rejects.toMatchObject({ code: 'INVALID_ABHA_FORMAT', statusCode: 400 });
    expect(prismaQuery).not.toHaveBeenCalled();
  });

  it('rejects the demographics the client used to send as a number', async () => {
    stubQueries();

    await expect(
      abdmService.registerABHA(PATIENT_UID, 'Test Patient', null, { tenantId: TENANT_ID }),
    ).rejects.toMatchObject({ code: 'INVALID_ABHA_FORMAT' });
  });

  it('probes BOTH spellings for a duplicate, so hyphens cannot bypass the guard', async () => {
    stubQueries();

    await abdmService.registerABHA(
      PATIENT_UID, '12345678901234', null, { tenantId: TENANT_ID },
    );

    const [, ...duplicateArgs] = prismaQuery.mock.calls[1];
    expect(duplicateArgs).toEqual([
      TENANT_ID,
      '12345678901234',
      '12-3456-7890-1234',
      PATIENT_UID,
    ]);
    const [, storedNumber] = prismaQuery.mock.calls[2];
    expect(storedNumber).toBe('12-3456-7890-1234');
  });

  it('refuses a number already VERIFIED-linked to another patient', async () => {
    stubQueries({ duplicate: [{ uid: 'someone-else' }] });

    await expect(
      abdmService.registerABHA(PATIENT_UID, '12-3456-7890-1234', null, { tenantId: TENANT_ID }),
    ).rejects.toMatchObject({ code: 'ABHA_ALREADY_LINKED', statusCode: 409 });
  });

  it('only a VERIFIED link blocks — the duplicate probe excludes pending claims', async () => {
    stubQueries();

    await abdmService.registerABHA(
      PATIENT_UID, '12-3456-7890-1234', null, { tenantId: TENANT_ID },
    );

    // Migration 653: a pending (unverified) claim by another patient must not
    // consume the number — otherwise a squatter locks out the rightful owner.
    const [duplicateSql] = prismaQuery.mock.calls[1];
    expect(duplicateSql).toContain("abha_verification_status = 'verified'");
  });

  it('maps the database uniqueness backstop race to the same 409 contract', async () => {
    stubQueries();
    prismaQuery.mockReset();
    prismaQuery
      .mockResolvedValueOnce([{ uid: PATIENT_UID }])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce({
        meta: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "uniq_users_tenant_abha_number_canonical"',
        },
      });

    await expect(
      abdmService.registerABHA(PATIENT_UID, '12-3456-7890-1234', null, { tenantId: TENANT_ID }),
    ).rejects.toMatchObject({ code: 'ABHA_ALREADY_LINKED', statusCode: 409 });
  });

  it('refuses when the patient row is absent in this tenant', async () => {
    stubQueries({ patient: [] });

    await expect(
      abdmService.registerABHA(PATIENT_UID, '12-3456-7890-1234', null, { tenantId: TENANT_ID }),
    ).rejects.toMatchObject({ code: 'PATIENT_NOT_FOUND', statusCode: 404 });
  });

  it('requires a tenant context', async () => {
    await expect(
      abdmService.registerABHA(PATIENT_UID, '12-3456-7890-1234', null, {}),
    ).rejects.toMatchObject({ code: 'ABDM_TENANT_REQUIRED' });
  });
});

describe('registerABHA — ABHA address', () => {
  it('normalizes a valid address to lower case before storing it', async () => {
    stubQueries({
      updated: [{
        uid: PATIENT_UID,
        abha_number: '12-3456-7890-1234',
        abha_address: 'patient@abdm',
      }],
    });

    const result = await abdmService.registerABHA(
      PATIENT_UID, '12-3456-7890-1234', '  Patient@ABDM  ', { tenantId: TENANT_ID },
    );

    const [, ...updateArgs] = prismaQuery.mock.calls[2];
    expect(updateArgs[1]).toBe('patient@abdm');
    expect(result.abhaAddress).toBe('patient@abdm');
  });

  it('treats an empty address as absent rather than storing a blank', async () => {
    stubQueries();

    await abdmService.registerABHA(
      PATIENT_UID, '12-3456-7890-1234', '   ', { tenantId: TENANT_ID },
    );

    const [, ...updateArgs] = prismaQuery.mock.calls[2];
    expect(updateArgs[1]).toBeNull();
  });

  it('rejects an address with no @ instead of storing it', async () => {
    stubQueries();

    await expect(
      abdmService.registerABHA(
        PATIENT_UID, '12-3456-7890-1234', '9000000001', { tenantId: TENANT_ID },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ABHA_ADDRESS', statusCode: 400 });
    expect(prismaQuery).not.toHaveBeenCalled();
  });

  it('rejects an address longer than the VARCHAR(100) column', async () => {
    stubQueries();

    await expect(
      abdmService.registerABHA(
        PATIENT_UID, '12-3456-7890-1234', `${'a'.repeat(120)}@abdm`, { tenantId: TENANT_ID },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ABHA_ADDRESS' });
  });
});

describe('registerABHA — gateway verification', () => {
  it('does not call the gateway while ABDM credentials are unconfigured', async () => {
    stubQueries();

    await abdmService.registerABHA(
      PATIENT_UID, '12-3456-7890-1234', null, { tenantId: TENANT_ID },
    );

    // ABDM_CONFIG.enabled is false in this suite: linkage must still work, which
    // is what makes the patient-facing link flow honest before certification.
    expect(verifyABHA).not.toHaveBeenCalled();
  });
});

describe('verifyLinkedAbha — ABDM disabled', () => {
  it('fails closed with 503 and no gateway bypass while ABDM is disabled', async () => {
    prismaQuery.mockReset();
    prismaQuery.mockResolvedValueOnce([{
      uid: PATIENT_UID,
      abha_number: '12-3456-7890-1234',
      abha_address: null,
      abha_verification_status: 'pending',
      abha_verified_at: null,
    }]);

    await expect(
      abdmService.verifyLinkedAbha(PATIENT_UID, { tenantId: TENANT_ID }),
    ).rejects.toMatchObject({ code: 'ABDM_NOT_ENABLED', statusCode: 503 });
    expect(verifyABHA).not.toHaveBeenCalled();
    // No promotion UPDATE ran.
    expect(prismaQuery).toHaveBeenCalledTimes(1);
  });

  it('still answers the idempotent no-op for an already-verified link while disabled', async () => {
    prismaQuery.mockReset();
    const verifiedAt = new Date('2026-08-01T00:00:00Z');
    prismaQuery.mockResolvedValueOnce([{
      uid: PATIENT_UID,
      abha_number: '12-3456-7890-1234',
      abha_address: null,
      abha_verification_status: 'verified',
      abha_verified_at: verifiedAt,
    }]);

    const result = await abdmService.verifyLinkedAbha(PATIENT_UID, { tenantId: TENANT_ID });

    expect(result.verification_status).toBe('verified');
    expect(verifyABHA).not.toHaveBeenCalled();
  });
});
