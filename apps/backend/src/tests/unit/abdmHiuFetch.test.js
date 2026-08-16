/**
 * Thin HIU fetch (migration 703) — unit suite, gateway/DB/R2 mocked, crypto REAL.
 *
 * Pins the receive-key lifecycle and the decrypt mirror:
 *   1. startHiuFetch persists the X25519 private key ONLY as encryptField()
 *      ciphertext, hands the CM the PUBLIC envelope, and creates the
 *      direction='in' transfer row on the 124 layer.
 *   2. The data-push handler decrypts a REAL fixture produced by abdmCrypto's
 *      HIP-side encryptFhirBundle against the session's stored key material
 *      (round-trip through the actual FIDELIUS-equivalent), uploads the
 *      DECRYPTED bundle to R2 (PHI bytes never to Postgres), records the
 *      reference row with the decrypted-bytes sha256, completes the session,
 *      and NULLs the private key.
 *   3. A checksum-failed part is rejected (no upload, no row) and the session
 *      finishes 'partial'.
 *   4. The sweep expires aged live sessions and scrubs any key a terminal
 *      session still holds.
 *   5. Config gate: 403 ABDM_HIU_DISABLED; consent-request creation persists
 *      evidence BEFORE the gateway call and fails the row on refusal.
 */
import { jest } from '@jest/globals';
import crypto from 'crypto';

const prismaQuery = jest.fn();
const prismaExecute = jest.fn();
const gatewayMock = {
  initHiuConsentRequest: jest.fn(),
  requestHealthInformation: jest.fn(),
  notifyHiuHealthInfoStatus: jest.fn(),
};
const hipHiuMock = {
  createConsentRequest: jest.fn(),
  transitionConsentRequest: jest.fn(),
  recordConsentArtifact: jest.fn(),
  createDataTransfer: jest.fn(),
  transitionDataTransfer: jest.fn(),
  recordWebhookEvent: jest.fn(),
  markWebhookProcessed: jest.fn(),
};
const uploadFileToR2 = jest.fn();
const getFileFromR2 = jest.fn();
const getAbdmHiuSettings = jest.fn();
const verifyConsentArtefactMock = jest.fn();
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.unstable_mockModule('../../config/abdmConfig.js', () => ({
  ABDM_CONFIG: {
    enabled: true,
    environment: 'sandbox',
    cmId: 'sbx',
    hipId: 'TEST_HIP',
    hiuId: 'TEST_HIU',
    callbackUrl: 'https://api.example.test',
    PURPOSES: ['CAREMGT'],
  },
}));
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: prismaQuery, $executeRawUnsafe: prismaExecute },
  setTenant: jest.fn(),
  setTenantTx: jest.fn(),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../../services/abdm/abdmGateway.js', () => ({ default: gatewayMock }));
jest.unstable_mockModule('../../services/abdmFull/abdmHipHiuService.js', () => hipHiuMock);
jest.unstable_mockModule('../../utils/r2Storage.js', () => ({ uploadFileToR2, getFileFromR2 }));
jest.unstable_mockModule('../../utils/fieldEncryption.js', () => ({
  encryptField: (plaintext) => `enc:${plaintext}`,
  decryptField: (ciphertext) => {
    if (!String(ciphertext).startsWith('enc:')) throw new Error('not an encrypted field');
    return String(ciphertext).slice(4);
  },
}));
jest.unstable_mockModule('../../services/tenant/tenantSettingsService.js', () => ({
  getAbdmEnrolmentSettings: jest.fn(),
  getAbdmHiuSettings,
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (tenantId) => {
    if (!tenantId) {
      const err = new Error('Tenant context is required');
      err.isOperational = true;
      err.statusCode = 403;
      err.code = 'TENANT_REQUIRED';
      throw err;
    }
    return tenantId;
  },
}));
jest.unstable_mockModule('../../services/abdm/abdmService.js', () => ({
  default: { _verifyConsentArtefact: verifyConsentArtefactMock },
}));

// REAL crypto module — the round-trip is the point of this suite.
const abdmCrypto = await import('../../services/abdm/abdmCrypto.js');
const hiuService = (await import('../../services/abdm/abdmHiuService.js')).default;

const TENANT_ID = '70300000-0000-4000-8000-00000000b003';
const PATIENT_UID = '70300000-0000-4000-8000-0000000007b3';

let routes;
function route(needle, impl) {
  routes.unshift([needle, impl]);
}
function dispatch(sql, args) {
  for (const [needle, impl] of routes) {
    if (sql.includes(needle)) return impl(sql, args);
  }
  return [];
}

beforeEach(() => {
  jest.clearAllMocks();
  routes = [];
  prismaQuery.mockImplementation(async (sql, ...args) => dispatch(sql, args));
  prismaExecute.mockImplementation(async (sql, ...args) => dispatch(sql, args));
  getAbdmHiuSettings.mockResolvedValue({ enabled: true });
  hipHiuMock.createDataTransfer.mockResolvedValue({ id: 51 });
  hipHiuMock.transitionDataTransfer.mockResolvedValue({ id: 51 });
  hipHiuMock.recordWebhookEvent.mockResolvedValue({
    event: { id: '61', status: 'pending' }, duplicate: false,
  });
  hipHiuMock.markWebhookProcessed.mockResolvedValue({ id: '61' });
  uploadFileToR2.mockResolvedValue('https://r2/ok');
});

describe('startHiuFetch — key persistence', () => {
  const ARTIFACT = {
    id: 41, artifact_id: 'cm-artifact-1', patient_uid: PATIENT_UID,
    hi_types: ['Prescription'], data_from: new Date('2026-01-01'),
    data_to: new Date('2026-06-01'), status: 'active',
  };

  it('persists the private key encryptField-encrypted, sends the PUBLIC envelope', async () => {
    let insertArgs;
    route('FROM abdm_consent_artifacts', () => [ARTIFACT]);
    route('INSERT INTO abdm_hiu_fetch_sessions', (sql, args) => {
      insertArgs = args;
      return [{
        id: 71, tenant_id: TENANT_ID, transaction_id: args[4], request_id: args[4],
        status: 'requested', parts_received: 0,
      }];
    });

    const session = await hiuService.startHiuFetch({
      tenantId: TENANT_ID, artifactId: 41, initiatedBy: PATIENT_UID,
    });

    // Explicit tenant, encrypted private key, our nonce.
    expect(insertArgs[0]).toBe(TENANT_ID);
    const storedCiphertext = insertArgs[9];
    expect(storedCiphertext).toMatch(/^enc:/);
    // The ciphertext payload is a valid PKCS#8 X25519 private key…
    const priv = crypto.createPrivateKey({
      key: Buffer.from(storedCiphertext.slice(4), 'base64'), format: 'der', type: 'pkcs8',
    });
    expect(priv.asymmetricKeyType).toBe('x25519');

    // …and the gateway saw ONLY the public envelope (never the private key).
    const gwArg = gatewayMock.requestHealthInformation.mock.calls[0][0];
    expect(gwArg.consentId).toBe('cm-artifact-1');
    expect(gwArg.dataPushUrl).toBe('https://api.example.test/api/v1/abdm/hiu/health-info/push');
    expect(gwArg.keyMaterial.dhPublicKey.keyValue).toBeDefined();
    expect(JSON.stringify(gwArg)).not.toContain(storedCiphertext.slice(4));

    // 124 layer: direction='in' transfer row.
    expect(hipHiuMock.createDataTransfer).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID, direction: 'in', consentArtifactId: 41,
      encryptionKind: 'ecdh_aes_256_gcm',
    }));
    expect(session.status).toBe('requested');
    expect(session).not.toHaveProperty('key_material_private_ciphertext');
  });

  it('fails the session AND destroys the key when the gateway refuses', async () => {
    route('FROM abdm_consent_artifacts', () => [ARTIFACT]);
    route('INSERT INTO abdm_hiu_fetch_sessions', (sql, args) => [{
      id: 71, transaction_id: args[4], status: 'requested',
    }]);
    gatewayMock.requestHealthInformation.mockRejectedValue(Object.assign(
      new Error('cm refused'), { isOperational: true, statusCode: 500 },
    ));

    await expect(hiuService.startHiuFetch({ tenantId: TENANT_ID, artifactId: 41 }))
      .rejects.toMatchObject({ message: 'cm refused' });
    const failCall = prismaExecute.mock.calls.find((c) => c[0].includes("status = 'failed'"));
    expect(failCall[0]).toContain('key_material_private_ciphertext = NULL');
    expect(hipHiuMock.transitionDataTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ nextStatus: 'failed' }),
    );
  });

  it('403 ABDM_HIU_DISABLED while the tenant setting is off', async () => {
    getAbdmHiuSettings.mockResolvedValue({ enabled: false });
    await expect(hiuService.startHiuFetch({ tenantId: TENANT_ID, artifactId: 41 }))
      .rejects.toMatchObject({ code: 'ABDM_HIU_DISABLED', statusCode: 403 });
    expect(prismaQuery).not.toHaveBeenCalled();
  });

  it('refuses inactive artifacts', async () => {
    route('FROM abdm_consent_artifacts', () => [{ ...ARTIFACT, status: 'revoked' }]);
    await expect(hiuService.startHiuFetch({ tenantId: TENANT_ID, artifactId: 41 }))
      .rejects.toMatchObject({ code: 'ABDM_ARTIFACT_INACTIVE', statusCode: 409 });
  });
});

describe('handleHiuDataPush — decrypt round-trip against the REAL crypto', () => {
  const FHIR_BUNDLE = {
    resourceType: 'Bundle', type: 'document',
    entry: [{ resource: { resourceType: 'Composition', title: 'OP Consultation' } }],
  };

  function buildSessionAndEntry() {
    // HIU side: generate the receive keypair exactly as startHiuFetch does.
    const receiver = abdmCrypto.generateKeyMaterial();
    const privB64 = receiver.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    // HIP side: encrypt a real bundle against our public envelope.
    const encrypted = abdmCrypto.encryptFhirBundle(FHIR_BUNDLE, receiver.keyMaterial);
    const session = {
      id: 71, tenant_id: TENANT_ID, environment: 'sandbox',
      consent_artifact_id: 41, data_transfer_id: 51, patient_uid: PATIENT_UID,
      transaction_id: 'txn-71', request_id: 'req-71', status: 'acknowledged',
      parts_expected: null, parts_received: 0,
      key_material_private_ciphertext: `enc:${privB64}`,
      key_material_nonce: receiver.nonce,
      key_material_expires_at: new Date(Date.now() + 10 * 60 * 1000),
    };
    return { session, encrypted };
  }

  it('decrypts, uploads to R2, records the reference row, completes, NULLs the key', async () => {
    const { session, encrypted } = buildSessionAndEntry();
    route('FROM abdm_hiu_fetch_sessions', () => [session]);
    let bundleInsertArgs;
    route('INSERT INTO abdm_hiu_received_bundles', (sql, args) => {
      bundleInsertArgs = args;
      expect(sql).toContain('ON CONFLICT (tenant_id, fetch_session_id, bundle_sha256) DO NOTHING');
      return [{ id: 81 }];
    });
    let completeSql;
    route('completed_at = NOW()', (sql, args) => {
      completeSql = sql;
      expect(args[2]).toBe('completed');
      return [{ ...session, status: 'completed', key_material_private_ciphertext: undefined }];
    });

    const result = await hiuService.handleHiuDataPush({
      tenantId: TENANT_ID,
      environment: 'sandbox',
      body: {
        transactionId: 'txn-71',
        pageNumber: 1,
        pageCount: 1,
        keyMaterial: encrypted.senderKeyMaterial,
        entries: [{
          content: encrypted.content,
          checksum: encrypted.checksum,
          media: 'application/fhir+json',
          careContextReference: 'cc-1',
          hiType: 'OPConsultation',
        }],
      },
    });

    expect(result.stored).toBe(1);
    expect(result.failed).toBe(0);
    // The DECRYPTED bundle (and only the decrypted bundle) went to R2.
    expect(uploadFileToR2).toHaveBeenCalledTimes(1);
    const [bytes, storageKey, mime] = uploadFileToR2.mock.calls[0];
    expect(JSON.parse(bytes.toString('utf8'))).toEqual(FHIR_BUNDLE);
    expect(storageKey).toBe(`abdm-hiu/${TENANT_ID}/71/0.json`);
    expect(mime).toBe('application/fhir+json');
    // Reference row: explicit tenant + sha256 of the decrypted bytes.
    expect(bundleInsertArgs[0]).toBe(TENANT_ID);
    expect(bundleInsertArgs[6]).toBe(
      crypto.createHash('sha256').update(bytes).digest('hex'),
    );
    // PHI bytes never went into the row.
    expect(JSON.stringify(bundleInsertArgs)).not.toContain('OP Consultation');
    // Final page: key destroyed, transfer succeeded, HIU notify sent.
    expect(completeSql).toContain('key_material_private_ciphertext = NULL');
    expect(hipHiuMock.transitionDataTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 51, nextStatus: 'succeeded' }),
    );
    expect(gatewayMock.notifyHiuHealthInfoStatus).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'txn-71', sessionStatus: 'TRANSFERRED' }),
    );
  });

  it('rejects a checksum-failed part (no upload, no row) and finishes partial', async () => {
    const { session, encrypted } = buildSessionAndEntry();
    route('FROM abdm_hiu_fetch_sessions', () => [session]);
    route('completed_at = NOW()', (sql, args) => {
      expect(args[2]).toBe('partial');
      return [{ ...session, status: 'partial' }];
    });

    const result = await hiuService.handleHiuDataPush({
      tenantId: TENANT_ID,
      environment: 'sandbox',
      body: {
        transactionId: 'txn-71',
        pageNumber: 1,
        pageCount: 1,
        keyMaterial: encrypted.senderKeyMaterial,
        entries: [{ content: encrypted.content, checksum: 'f'.repeat(32) }],
      },
    });

    expect(result.stored).toBe(0);
    expect(result.failed).toBe(1);
    expect(uploadFileToR2).not.toHaveBeenCalled();
    const bundleInsert = prismaQuery.mock.calls.find((c) => c[0].includes('INSERT INTO abdm_hiu_received_bundles'));
    expect(bundleInsert).toBeUndefined();
    expect(hipHiuMock.transitionDataTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ nextStatus: 'partial' }),
    );
  });

  it('a tampered ciphertext fails authentication and the part is rejected', async () => {
    const { session, encrypted } = buildSessionAndEntry();
    const tampered = Buffer.from(encrypted.content, 'base64');
    tampered[tampered.length - 1] ^= 0xff;
    const tamperedB64 = tampered.toString('base64');
    route('FROM abdm_hiu_fetch_sessions', () => [session]);
    route('completed_at = NOW()', () => [{ ...session, status: 'partial' }]);

    const result = await hiuService.handleHiuDataPush({
      tenantId: TENANT_ID,
      environment: 'sandbox',
      body: {
        transactionId: 'txn-71',
        pageNumber: 1,
        pageCount: 1,
        keyMaterial: encrypted.senderKeyMaterial,
        entries: [{
          content: tamperedB64,
          checksum: crypto.createHash('md5').update(tamperedB64).digest('hex'),
        }],
      },
    });

    expect(result.stored).toBe(0);
    expect(result.failed).toBe(1);
    expect(uploadFileToR2).not.toHaveBeenCalled();
  });

  it('replays of a page collapse on the webhook event dedupe', async () => {
    hipHiuMock.recordWebhookEvent.mockResolvedValue({
      event: { id: '61' }, duplicate: true,
    });
    const result = await hiuService.handleHiuDataPush({
      tenantId: TENANT_ID, environment: 'sandbox',
      body: { transactionId: 'txn-71', pageNumber: 1, pageCount: 1, entries: [] },
    });
    expect(result.duplicate).toBe(true);
    expect(prismaQuery).not.toHaveBeenCalled();
  });

  it('refuses a session whose key material is gone or expired', async () => {
    const { session } = buildSessionAndEntry();
    route('FROM abdm_hiu_fetch_sessions', () => [{ ...session, key_material_private_ciphertext: null }]);
    await expect(hiuService.handleHiuDataPush({
      tenantId: TENANT_ID, environment: 'sandbox',
      body: { transactionId: 'txn-71', pageNumber: 1, pageCount: 1, entries: [] },
    })).rejects.toMatchObject({ code: 'ABDM_HIU_KEY_UNAVAILABLE' });

    hipHiuMock.recordWebhookEvent.mockResolvedValue({
      event: { id: '62' }, duplicate: false,
    });
    route('FROM abdm_hiu_fetch_sessions', () => [{
      ...session, key_material_expires_at: new Date(Date.now() - 1000),
    }]);
    await expect(hiuService.handleHiuDataPush({
      tenantId: TENANT_ID, environment: 'sandbox',
      body: { transactionId: 'txn-71', pageNumber: 1, pageCount: 1, entries: [] },
    })).rejects.toMatchObject({ code: 'ABDM_HIU_KEY_EXPIRED' });
  });
});

describe('consent request leg + acks', () => {
  it('persists the consent request BEFORE the gateway call; refusal fails the row', async () => {
    hipHiuMock.createConsentRequest.mockResolvedValue({ id: 91, request_id: 'r-91' });
    gatewayMock.initHiuConsentRequest.mockRejectedValue(Object.assign(
      new Error('gateway down'), { isOperational: true, statusCode: 500 },
    ));

    await expect(hiuService.createHiuConsentRequest({
      tenantId: TENANT_ID,
      abhaAddress: 'asha@sbx',
      hiTypes: ['Prescription'],
      dataFrom: '2026-01-01T00:00:00Z',
      dataTo: '2026-06-01T00:00:00Z',
    })).rejects.toMatchObject({ message: 'gateway down' });

    expect(hipHiuMock.createConsentRequest.mock.invocationCallOrder[0])
      .toBeLessThan(gatewayMock.initHiuConsentRequest.mock.invocationCallOrder[0]);
    expect(hipHiuMock.transitionConsentRequest).toHaveBeenCalledWith(expect.objectContaining({
      id: 91, nextStatus: 'failed',
    }));
  });

  it('on-request ack stamps the CM transactionId and acknowledges the session', async () => {
    let ackSql;
    route("status = 'acknowledged'", (sql, args) => {
      ackSql = sql;
      expect(args).toEqual([TENANT_ID, 'req-71', 'cm-txn-9']);
      return [];
    });

    await hiuService.handleHiuHealthInfoOnRequest({
      tenantId: TENANT_ID,
      environment: 'sandbox',
      body: {
        requestId: 'ack-1',
        resp: { requestId: 'req-71' },
        hiRequest: { transactionId: 'cm-txn-9', sessionStatus: 'ACKNOWLEDGED' },
      },
    });
    expect(ackSql).toContain('transaction_id = $3::text');
  });

  it('consent notify GRANTED verifies + records artefacts through the existing machinery', async () => {
    route('FROM abdm_consent_requests', () => [{
      id: 91, status: 'requested', hi_types: ['Prescription'],
      patient_uid: PATIENT_UID, data_from: null, data_to: null, expiry_at: null,
    }]);
    hipHiuMock.recordConsentArtifact.mockResolvedValue({ id: 41 });
    hipHiuMock.transitionConsentRequest.mockResolvedValue({ id: 91, status: 'granted' });

    const result = await hiuService.handleHiuConsentNotify({
      tenantId: TENANT_ID,
      environment: 'sandbox',
      body: {
        requestId: 'notify-1',
        notification: {
          consentRequestId: 'cm-cr-1',
          status: 'GRANTED',
          consentArtefacts: [{
            id: 'cm-artifact-1',
            consentDetail: { consentId: 'cm-artifact-1' },
            signature: 'sig-b64',
          }],
        },
      },
    });

    expect(result.artifacts).toBe(1);
    expect(verifyConsentArtefactMock).toHaveBeenCalledWith(expect.objectContaining({
      consentRequestId: 'cm-cr-1',
      signature: 'sig-b64',
    }));
    expect(hipHiuMock.transitionConsentRequest).toHaveBeenCalledWith(expect.objectContaining({
      id: 91, nextStatus: 'granted',
    }));
    expect(hipHiuMock.recordConsentArtifact).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID, artifactId: 'cm-artifact-1', consentRequestId: 91,
    }));
  });
});

describe('sweep — key material is a liability', () => {
  it('expires aged live sessions (key NULLed) and scrubs terminal stragglers', async () => {
    route("SET status = 'expired'", (sql) => {
      expect(sql).toContain('key_material_private_ciphertext = NULL');
      return [{ id: 1 }];
    });
    route('key_material_private_ciphertext IS NOT NULL', (sql) => {
      expect(sql).toContain("status IN ('completed', 'partial', 'failed', 'expired')");
      return [{ id: 2 }, { id: 3 }];
    });

    const result = await hiuService.sweepExpiredHiuFetchSessions();
    expect(result).toEqual({ expired: 1, keysScrubbed: 2 });
  });
});
