// DB-backed HIU consent revocation and dataEraseAt contract.
//
// Uses real Postgres rows/locks with an in-memory R2 double. The object-store
// double is intentional: these tests prove that database authorization and
// retention state control whether decrypted bytes can be read or deleted,
// without placing PHI-like fixtures in a developer's real/local R2 directory.

import { jest } from '@jest/globals';
import crypto from 'crypto';

const r2Objects = new Map();
let failDelete = false;
let readGate = null;

const getFileFromR2 = jest.fn(async (key) => {
  if (readGate) await readGate();
  if (!r2Objects.has(key)) {
    const err = new Error(`No such key: ${key}`);
    err.code = 'NoSuchKey';
    throw err;
  }
  return r2Objects.get(key);
});
const deleteObject = jest.fn(async (key) => {
  if (failDelete) throw new Error('R2 unavailable');
  r2Objects.delete(key);
});

jest.unstable_mockModule('../utils/r2Storage.js', () => ({
  uploadFileToR2: jest.fn(),
  getFileFromR2,
  deleteObject,
}));

const { default: prisma, setTenantTx } = await import('../lib/prisma.js');
const hiuService = (await import('../services/abdm/abdmHiuService.js')).default;

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = '87810000-0000-4000-8000-000000000001';
const OTHER_TENANT_ID = '87810000-0000-4000-8000-000000000002';
const PATIENT_UID = '87810000-0000-4000-8000-000000000101';
const OTHER_PATIENT_UID = '87810000-0000-4000-8000-000000000102';
const PHONE = '+918781000001';
const OTHER_PHONE = '+918781000002';
const ABHA_ADDRESS = 'pr878-hiu@sbx';
const BUNDLE_KEY = `abdm-hiu/${TENANT_ID}/revocation/decrypted.json`;
const REQUEST_ID = 'pr878-hiu-request';
const CM_REQUEST_ID = 'pr878-hiu-cm-request';
const BUNDLE_BYTES = Buffer.from('{"resourceType":"Bundle","type":"document"}');
const BUNDLE_SHA256 = crypto.createHash('sha256').update(BUNDLE_BYTES).digest('hex');

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM abdm_webhook_events WHERE tenant_id = $1::uuid`,
    TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM abdm_hiu_fetch_sessions WHERE tenant_id = $1::uuid`,
    TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM abdm_consent_artifacts WHERE tenant_id = $1::uuid`,
    TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM abdm_consent_requests WHERE tenant_id = $1::uuid`,
    TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE tenant_id = $1::uuid`,
    TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id = $1::uuid`,
    TENANT_ID,
  ).catch(() => {});
}

async function seedBundle({ expiryAt = new Date(Date.now() + 60_000) } = {}) {
  // Bind an explicit-UTC instant, never a JS Date. The pg driver serialises a
  // Date as a zoneless wall clock, so `::timestamptz` re-reads those digits in
  // the session timezone: on the Asia/Calcutta QA session the value lands 5h30m
  // early and expires the consent before the test can exercise it. This mirrors
  // normalizeTimestamp() in the production consent writer (abdmHipHiuService).
  const expiryAtIso = new Date(expiryAt).toISOString();
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, 'pr878-hiu-retention', 'PR878 HIU Retention')`,
    TENANT_ID,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO users
       (uid, tenant_id, phone, name, role, is_active, is_deleted,
        abha_address, abha_verification_status, abha_verified_at, updated_at)
     VALUES
       ($1::uuid, $3::uuid, $4::text, 'PR878 HIU Patient', 'PATIENT', TRUE, FALSE,
        $6::text, 'verified', NOW(), NOW()),
       ($2::uuid, $3::uuid, $5::text, 'PR878 Other Patient', 'PATIENT', TRUE, FALSE,
        'pr878-other@sbx', 'verified', NOW(), NOW())`,
    PATIENT_UID, OTHER_PATIENT_UID, TENANT_ID, PHONE, OTHER_PHONE, ABHA_ADDRESS,
  );
  const requests = await prisma.$queryRawUnsafe(
    `INSERT INTO abdm_consent_requests
       (tenant_id, request_id, flow_kind, patient_uid, hi_types,
        permission_kind, data_from, data_to, expiry_at, purpose_code,
        status, environment, metadata)
     VALUES
       ($1::uuid, $2::text, 'hiu', $3::uuid, ARRAY['Prescription']::text[],
        'view', NOW() - INTERVAL '1 day', NOW(), $4::timestamptz, 'CAREMGT',
        'granted', 'sandbox', jsonb_build_object(
          'abha_address', $5::text,
          'cm_consent_request_id', $6::text
        ))
     RETURNING id`,
    TENANT_ID, REQUEST_ID, PATIENT_UID, expiryAtIso, ABHA_ADDRESS, CM_REQUEST_ID,
  );
  const artifacts = await prisma.$queryRawUnsafe(
    `INSERT INTO abdm_consent_artifacts
       (tenant_id, consent_request_id, artifact_id, patient_uid, hi_types,
        permission_kind, data_from, data_to, expiry_at, status,
        signed_payload, environment, metadata)
     VALUES
       ($1::uuid, $2::integer, 'pr878-hiu-artifact', $3::uuid,
        ARRAY['Prescription']::text[], 'view', NOW() - INTERVAL '1 day', NOW(),
        $4::timestamptz, 'active',
        jsonb_build_object('patient', jsonb_build_object('id', $5::text)),
        'sandbox', jsonb_build_object('hip_id', 'PR878-HIP'))
     RETURNING id`,
    TENANT_ID, requests[0].id, PATIENT_UID, expiryAtIso, ABHA_ADDRESS,
  );
  const sessions = await prisma.$queryRawUnsafe(
    `INSERT INTO abdm_hiu_fetch_sessions
       (tenant_id, environment, consent_artifact_id, patient_uid,
        transaction_id, request_id, hi_types, status, parts_received,
        pages_expected, next_page_number, completed_at, metadata)
     VALUES
       ($1::uuid, 'sandbox', $2::integer, $3::uuid,
        'pr878-hiu-transaction', 'pr878-hiu-fetch', ARRAY['Prescription']::text[],
        'completed', 1, 1, 2, NOW(),
        jsonb_build_object('hiu_bundle_bytes_received', $4::integer))
     RETURNING id`,
    TENANT_ID, artifacts[0].id, PATIENT_UID, BUNDLE_BYTES.length,
  );
  const pages = await prisma.$queryRawUnsafe(
    `INSERT INTO abdm_hiu_fetch_pages
       (tenant_id, fetch_session_id, page_number, page_count, payload_sha256,
        status, claim_id, parts_count, completed_at)
     VALUES
       ($1::uuid, $2::integer, 1, 1, $3::char(64),
        'completed', $4::uuid, 1, NOW())
     RETURNING id`,
    TENANT_ID, sessions[0].id, 'a'.repeat(64),
    '87810000-0000-4000-8000-00000000c101',
  );
  const bundles = await prisma.$queryRawUnsafe(
    `INSERT INTO abdm_hiu_received_bundles
       (tenant_id, fetch_session_id, fetch_page_id, page_number,
        care_context_reference, hi_type, part_number, bundle_storage_key,
        bundle_sha256, checksum_verified, media_type, metadata)
     VALUES
       ($1::uuid, $2::integer, $3::integer, 1,
        'pr878-care-context', 'Prescription', 0, $4::text,
        $5::char(64), TRUE, 'application/fhir+json',
        jsonb_build_object('byte_length', $6::integer))
     RETURNING id`,
    TENANT_ID, sessions[0].id, pages[0].id, BUNDLE_KEY, BUNDLE_SHA256,
    BUNDLE_BYTES.length,
  );
  r2Objects.set(BUNDLE_KEY, BUNDLE_BYTES);
  return {
    requestId: requests[0].id,
    artifactId: artifacts[0].id,
    sessionId: sessions[0].id,
    bundleId: bundles[0].id,
  };
}

async function readBundle(fixture, tenantId = TENANT_ID) {
  return hiuService.getReceivedBundleContent({
    tenantId,
    sessionId: fixture.sessionId,
    bundleId: fixture.bundleId,
  });
}

async function commitSignedRevocation(fixture, externalEventId) {
  const uniqueEventId = `${externalEventId}-${crypto.randomUUID()}`;
  return setTenantTx(TENANT_ID, async (tx) => {
    await tx.$queryRawUnsafe(
      `INSERT INTO abdm_webhook_events
         (tenant_id, external_event_id, event_type, source,
          signature_verified, payload, environment, status)
       VALUES
         ($1::uuid, $2::text, 'hiu_consent_notify', 'abdm_public_callback',
          TRUE, jsonb_build_object(
            'notification', jsonb_build_object(
              'consentRequestId', $3::text,
              'status', 'REVOKED'
            )
          ), 'sandbox', 'pending')`,
      TENANT_ID, uniqueEventId, CM_REQUEST_ID,
    );
    await tx.$queryRawUnsafe(
      `UPDATE abdm_consent_requests
          SET status = 'revoked', decided_at = NOW(), updated_at = NOW()
        WHERE id = $1::integer AND tenant_id = $2::uuid AND status = 'granted'`,
      fixture.requestId, TENANT_ID,
    );
    await tx.$queryRawUnsafe(
      `UPDATE abdm_consent_artifacts
          SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
        WHERE consent_request_id = $1::integer AND tenant_id = $2::uuid
          AND status = 'active'`,
      fixture.requestId, TENANT_ID,
    );
    await tx.$queryRawUnsafe(
      `UPDATE abdm_hiu_fetch_sessions
          SET status = 'expired', key_material_private_ciphertext = NULL,
              failure_reason = 'consent revoked', updated_at = NOW()
        WHERE consent_artifact_id = $1::integer AND tenant_id = $2::uuid
          AND status IN ('requested', 'acknowledged', 'receiving')`,
      fixture.artifactId, TENANT_ID,
    );
    await tx.$queryRawUnsafe(
      `UPDATE abdm_webhook_events
          SET status = 'processed', processed_at = NOW()
        WHERE tenant_id = $1::uuid AND external_event_id = $2::text`,
      TENANT_ID, uniqueEventId,
    );
    return { status: 'REVOKED' };
  });
}

d('ABDM HIU revoked/expired bundle retention', () => {
  beforeEach(async () => {
    failDelete = false;
    readGate = null;
    r2Objects.clear();
    jest.clearAllMocks();
    await cleanup();
  }, 30_000);

  afterEach(cleanup, 30_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 30_000);

  test('a signed revocation blocks a completed bundle immediately and R2 cleanup retries durably', async () => {
    const fixture = await seedBundle();
    await expect(readBundle(fixture)).resolves.toMatchObject({
      content: { resourceType: 'Bundle', type: 'document' },
    });

    await commitSignedRevocation(fixture, 'pr878-hiu-signed-revoke');
    const state = await prisma.$queryRawUnsafe(
      `SELECT r.status AS request_status, a.status AS artifact_status,
              s.status AS session_status
         FROM abdm_consent_requests r
         JOIN abdm_consent_artifacts a
           ON a.consent_request_id = r.id AND a.tenant_id = r.tenant_id
         JOIN abdm_hiu_fetch_sessions s
           ON s.consent_artifact_id = a.id AND s.tenant_id = r.tenant_id
        WHERE r.id = $1::integer AND r.tenant_id = $2::uuid`,
      fixture.requestId, TENANT_ID,
    );
    expect(state[0]).toEqual({
      request_status: 'revoked',
      artifact_status: 'revoked',
      // This was the vulnerable survivor: only live sessions were expired.
      session_status: 'completed',
    });
    getFileFromR2.mockClear();
    await expect(readBundle(fixture))
      .rejects.toMatchObject({ code: 'ABDM_HIU_CONSENT_INACTIVE', statusCode: 403 });
    expect(getFileFromR2).not.toHaveBeenCalled();

    failDelete = true;
    await expect(hiuService.sweepExpiredHiuFetchSessions({ tenantId: TENANT_ID }))
      .resolves.toMatchObject({ bundlesPurged: 0, cleanupErrors: 1 });
    expect(r2Objects.has(BUNDLE_KEY)).toBe(true);
    const retained = await prisma.$queryRawUnsafe(
      `SELECT id FROM abdm_hiu_received_bundles
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT_ID, fixture.bundleId,
    );
    expect(retained).toHaveLength(1);

    failDelete = false;
    await expect(hiuService.sweepExpiredHiuFetchSessions({ tenantId: TENANT_ID }))
      .resolves.toMatchObject({ bundlesPurged: 1, cleanupErrors: 0 });
    expect(r2Objects.has(BUNDLE_KEY)).toBe(false);
    const erased = await prisma.$queryRawUnsafe(
      `SELECT id FROM abdm_hiu_received_bundles
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      TENANT_ID, fixture.bundleId,
    );
    expect(erased).toHaveLength(0);
  });

  test('dataEraseAt denies stale active rows, then persists expiry and erases R2', async () => {
    const fixture = await seedBundle({ expiryAt: new Date(Date.now() - 1_000) });

    await expect(readBundle(fixture))
      .rejects.toMatchObject({ code: 'ABDM_HIU_CONSENT_INACTIVE', statusCode: 403 });
    expect(getFileFromR2).not.toHaveBeenCalled();

    const sweep = await hiuService.sweepExpiredHiuFetchSessions({ tenantId: TENANT_ID });
    expect(sweep).toMatchObject({
      artifactsExpired: 1,
      requestsExpired: 1,
      bundlesPurged: 1,
      cleanupErrors: 0,
    });
    const state = await prisma.$queryRawUnsafe(
      `SELECT r.status AS request_status, a.status AS artifact_status
         FROM abdm_consent_requests r
         JOIN abdm_consent_artifacts a
           ON a.consent_request_id = r.id AND a.tenant_id = r.tenant_id
        WHERE r.id = $1::integer AND r.tenant_id = $2::uuid`,
      fixture.requestId, TENANT_ID,
    );
    expect(state[0]).toEqual({ request_status: 'expired', artifact_status: 'expired' });
    expect(r2Objects.has(BUNDLE_KEY)).toBe(false);
  });

  test('requested and acknowledged sessions survive until key or consent expiry', async () => {
    const fixture = await seedBundle();
    await prisma.$executeRawUnsafe(
      `DELETE FROM abdm_hiu_received_bundles
        WHERE tenant_id = $1::uuid AND fetch_session_id = $2::integer`,
      TENANT_ID, fixture.sessionId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM abdm_hiu_fetch_pages
        WHERE tenant_id = $1::uuid AND fetch_session_id = $2::integer`,
      TENANT_ID, fixture.sessionId,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE abdm_hiu_fetch_sessions
          SET status = 'requested', parts_received = 0, pages_expected = NULL,
              next_page_number = 1, completed_at = NULL,
              key_material_private_ciphertext = 'enc:requested',
              key_material_expires_at = NOW() + INTERVAL '10 minutes',
              metadata = jsonb_build_object('hiu_bundle_bytes_received', 0)
        WHERE id = $1::integer AND tenant_id = $2::uuid`,
      fixture.sessionId, TENANT_ID,
    );
    const acknowledged = await prisma.$queryRawUnsafe(
      `INSERT INTO abdm_hiu_fetch_sessions
         (tenant_id, environment, consent_artifact_id, patient_uid,
          transaction_id, request_id, hi_types, status, parts_received,
          next_page_number, acknowledged_at, key_material_private_ciphertext,
          key_material_expires_at, metadata)
       SELECT $1::uuid, 'sandbox', $2::integer, $3::uuid,
              'pr878-hiu-acknowledged', 'pr878-hiu-acknowledged-request',
              ARRAY['Prescription']::text[], 'acknowledged', 0, 1, NOW(),
              'enc:acknowledged', NOW() + INTERVAL '10 minutes',
              jsonb_build_object('hiu_bundle_bytes_received', 0)
       RETURNING id`,
      TENANT_ID, fixture.artifactId, PATIENT_UID,
    );

    await expect(hiuService.sweepExpiredHiuFetchSessions({ tenantId: TENANT_ID }))
      .resolves.toMatchObject({ expired: 0, keysScrubbed: 0 });
    let sessions = await prisma.$queryRawUnsafe(
      `SELECT id, status, key_material_private_ciphertext
         FROM abdm_hiu_fetch_sessions
        WHERE tenant_id = $1::uuid AND id = ANY($2::int[])
        ORDER BY id`,
      TENANT_ID, [fixture.sessionId, acknowledged[0].id],
    );
    expect(sessions.map((row) => row.status)).toEqual(['requested', 'acknowledged']);
    expect(sessions.every((row) => row.key_material_private_ciphertext != null)).toBe(true);

    await prisma.$executeRawUnsafe(
      `UPDATE abdm_hiu_fetch_sessions
          SET key_material_expires_at = NOW() - INTERVAL '1 second'
        WHERE id = $1::integer AND tenant_id = $2::uuid`,
      fixture.sessionId, TENANT_ID,
    );
    await expect(hiuService.sweepExpiredHiuFetchSessions({ tenantId: TENANT_ID }))
      .resolves.toMatchObject({ expired: 1 });

    await prisma.$executeRawUnsafe(
      `UPDATE abdm_consent_artifacts
          SET expiry_at = NOW() - INTERVAL '1 second'
        WHERE id = $1::integer AND tenant_id = $2::uuid`,
      fixture.artifactId, TENANT_ID,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE abdm_consent_requests
          SET expiry_at = NOW() - INTERVAL '1 second'
        WHERE id = $1::integer AND tenant_id = $2::uuid`,
      fixture.requestId, TENANT_ID,
    );
    await expect(hiuService.sweepExpiredHiuFetchSessions({ tenantId: TENANT_ID }))
      .resolves.toMatchObject({ artifactsExpired: 1, requestsExpired: 1, expired: 1 });

    sessions = await prisma.$queryRawUnsafe(
      `SELECT id, status, key_material_private_ciphertext
         FROM abdm_hiu_fetch_sessions
        WHERE tenant_id = $1::uuid AND id = ANY($2::int[])
        ORDER BY id`,
      TENANT_ID, [fixture.sessionId, acknowledged[0].id],
    );
    expect(sessions.map((row) => row.status)).toEqual(['expired', 'expired']);
    expect(sessions.every((row) => row.key_material_private_ciphertext == null)).toBe(true);
  });

  test('an in-flight read linearizes before revoke; every read after revoke commit is denied', async () => {
    const fixture = await seedBundle();
    let signalReadStarted;
    const readStarted = new Promise((resolve) => { signalReadStarted = resolve; });
    let releaseRead;
    const holdRead = new Promise((resolve) => { releaseRead = resolve; });
    readGate = async () => {
      signalReadStarted();
      await holdRead;
    };

    const firstRead = readBundle(fixture);
    try {
      await readStarted;
      const revoke = commitSignedRevocation(fixture, 'pr878-hiu-racing-revoke');
      const beforeRelease = await Promise.race([
        revoke.then(() => 'revoked'),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 100)),
      ]);
      expect(beforeRelease).toBe('blocked');

      releaseRead();
      await expect(firstRead).resolves.toMatchObject({
        content: { resourceType: 'Bundle', type: 'document' },
      });
      await expect(revoke).resolves.toMatchObject({ status: 'REVOKED' });
      readGate = null;
      await expect(readBundle(fixture))
        .rejects.toMatchObject({ code: 'ABDM_HIU_CONSENT_INACTIVE', statusCode: 403 });
    } finally {
      releaseRead();
      readGate = null;
      await firstRead.catch(() => {});
    }
  }, 30_000);

  test('claim-specific orphan evidence retries without deleting a durable successor key', async () => {
    await seedBundle();
    const staleKey = `abdm-hiu/${TENANT_ID}/claim-stale/decrypted.json`;
    const staleClaimId = crypto.randomUUID();
    r2Objects.set(staleKey, Buffer.from('{"resourceType":"Bundle","id":"stale"}'));
    const events = await prisma.$queryRawUnsafe(
      `INSERT INTO abdm_webhook_events
         (tenant_id, external_event_id, event_type, source,
          signature_verified, payload, environment, status)
       VALUES
         ($1::uuid, $2::text, 'hiu_data_push', 'abdm_public_callback',
          TRUE, '{}'::jsonb, 'sandbox', 'pending')
       RETURNING id, metadata`,
      TENANT_ID, `pr878-hiu-orphan-${crypto.randomUUID()}`,
    );
    const eventId = Number(events[0].id);
    await hiuService.__testing__.persistOrphanCleanupEvidence({
      tenantId: TENANT_ID,
      eventId,
      claimId: staleClaimId,
      storageKeys: [staleKey, BUNDLE_KEY],
    });
    let evidence = await prisma.$queryRawUnsafe(
      `SELECT id, status, metadata FROM abdm_webhook_events
        WHERE id = $1 AND tenant_id = $2::uuid`,
      eventId, TENANT_ID,
    );
    expect(evidence[0]).toMatchObject({
      status: 'failed',
      metadata: {
        hiu_claim_cleanup: {
          [staleClaimId]: expect.arrayContaining([staleKey, BUNDLE_KEY]),
        },
      },
    });

    failDelete = true;
    await expect(hiuService.__testing__.drainOrphanCleanupEvidence({
      tenantId: TENANT_ID,
      event: evidence[0],
    })).rejects.toMatchObject({ code: 'ABDM_HIU_ORPHAN_CLEANUP_PENDING', statusCode: 503 });
    expect(r2Objects.has(staleKey)).toBe(true);
    expect(r2Objects.has(BUNDLE_KEY)).toBe(true);

    failDelete = false;
    evidence = await prisma.$queryRawUnsafe(
      `SELECT id, metadata FROM abdm_webhook_events
        WHERE id = $1 AND tenant_id = $2::uuid`,
      eventId, TENANT_ID,
    );
    await hiuService.__testing__.drainOrphanCleanupEvidence({
      tenantId: TENANT_ID,
      event: evidence[0],
    });
    expect(r2Objects.has(staleKey)).toBe(false);
    expect(r2Objects.has(BUNDLE_KEY)).toBe(true);
    const cleared = await prisma.$queryRawUnsafe(
      `SELECT metadata FROM abdm_webhook_events
        WHERE id = $1 AND tenant_id = $2::uuid`,
      eventId, TENANT_ID,
    );
    expect(cleared[0].metadata).not.toHaveProperty('hiu_claim_cleanup');
  });

  test('tenant and patient linkage mismatches fail before object storage', async () => {
    const fixture = await seedBundle();
    getFileFromR2.mockClear();

    await expect(readBundle(fixture, OTHER_TENANT_ID))
      .rejects.toMatchObject({ code: 'ABDM_HIU_CONSENT_INACTIVE', statusCode: 403 });
    await prisma.$executeRawUnsafe(
      `UPDATE abdm_hiu_fetch_sessions
          SET patient_uid = $3::uuid
        WHERE id = $1::integer AND tenant_id = $2::uuid`,
      fixture.sessionId, TENANT_ID, OTHER_PATIENT_UID,
    );
    await expect(readBundle(fixture))
      .rejects.toMatchObject({ code: 'ABDM_HIU_CONSENT_INACTIVE', statusCode: 403 });
    expect(getFileFromR2).not.toHaveBeenCalled();
  });
});
