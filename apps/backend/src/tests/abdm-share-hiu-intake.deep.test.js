// Scan & Share intake + thin-HIU callback paths (migrations 702/703) — deep.
//
// Runs the real services against the test Postgres (gateway mocked). Pins the
// DB-enforced contract the unit suites can only assert by SQL text:
//   1. The profile-share callback records BOTH layers: a PLAIN
//      abdm_webhook_events row (receipt_source NULL — 618's I16 CHECK must not
//      fire for the new path) and the abdm_patient_share_intakes work item
//      with EXPLICIT tenant_id; a CM redelivery collapses on the
//      (tenant, request_id, environment) unique and reports duplicate.
//   2. 702's resolution-evidence CHECK is live (matched without a patient →
//      constraint violation).
//   3. 703's uniques/CHECKs are live: (tenant, transaction_id, environment)
//      unique, bundle sha256 shape CHECK, per-session bundle-content unique.
//   4. The HIU on-request ack stamps the CM transactionId onto the session.
// Self-skips when unconfigured.

import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';

process.env.ABDM_ENABLED = 'true';
process.env.ABDM_HIP_ID = 'share-test-hip';
process.env.ABDM_CALLBACK_SECRET = 'x'.repeat(64);
process.env.ABDM_VERIFY_CONSENT_ARTEFACT = 'true';
process.env.ABDM_CM_PUBLIC_KEY = 'test-key';

jest.unstable_mockModule('../services/abdm/abdmGateway.js', () => ({
  default: {
    initHiuConsentRequest: jest.fn(),
    requestHealthInformation: jest.fn(),
    notifyHiuHealthInfoStatus: jest.fn(),
  },
}));

const { default: prisma } = await import('../lib/prisma.js');
const shareIntakeService = (await import('../services/abdm/abdmShareIntakeService.js')).default;
const hiuService = (await import('../services/abdm/abdmHiuService.js')).default;

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
// Run-unique ids: on a REUSED local DB the abdm_webhook_events cleanup is a
// silent no-op — 618's assert_abdm_i16_receipt_immutable BEFORE DELETE row
// trigger ends with RETURN NEW, which is NULL on DELETE, so every DELETE on
// that table is skipped (pre-existing main-branch quirk, flagged as a
// follow-up). Fixed ids would make a second run see duplicate=true, so every
// id this suite writes through the webhook-dedupe layer is minted per run.
const RUN = randomUUID().slice(0, 8);
const REQUEST_ID = `deep-share-req-${RUN}`;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM abdm_patient_share_intakes WHERE tenant_id = $1::uuid AND request_id LIKE 'deep-share-%'`,
    TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM abdm_hiu_received_bundles WHERE tenant_id = $1::uuid
      AND fetch_session_id IN (
        SELECT id FROM abdm_hiu_fetch_sessions
         WHERE tenant_id = $1::uuid AND transaction_id LIKE 'deep-hiu-%')`,
    TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM abdm_hiu_fetch_sessions WHERE tenant_id = $1::uuid AND transaction_id LIKE 'deep-hiu-%'`,
    TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM abdm_webhook_events WHERE tenant_id = $1::uuid
      AND (external_event_id LIKE 'deep-share-%' OR external_event_id LIKE 'deep-hiu-%')`,
    TENANT_ID,
  ).catch(() => {});
}

d('Scan & Share + HIU deep (702/703 DB contract)', () => {
  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  const SHARE_BODY = {
    requestId: REQUEST_ID,
    profile: {
      hipCode: 'counter-7',
      patient: {
        abhaNumber: '70200000000001',
        abhaAddress: 'deepshare@sbx',
        name: 'Deep Share Patient',
        gender: 'F',
        yearOfBirth: '1992',
        mobile: '9000702001',
      },
    },
  };

  test('callback records the plain webhook row (receipt_source NULL) + the intake, and a redelivery collapses', async () => {
    const first = await shareIntakeService.handlePatientProfileShareCallback({
      tenantId: TENANT_ID, environment: 'sandbox', body: SHARE_BODY,
    });
    expect(first.duplicate).toBe(false);
    expect(first.intake.status).toBe('received');
    expect(first.tokenNumber).toBeTruthy();

    // The transport-evidence row is a PLAIN 124-shape row: receipt_source
    // stays NULL so 618's I16 receipt-shape CHECK never constrains this path.
    const events = await prisma.$queryRawUnsafe(
      `SELECT event_type, receipt_source, signature_verified, status
         FROM abdm_webhook_events
        WHERE tenant_id = $1::uuid AND external_event_id = $2 AND environment = 'sandbox'`,
      TENANT_ID, REQUEST_ID,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: 'patient_profile_share',
      receipt_source: null,
      signature_verified: true,
      status: 'processed',
    });

    // The intake row landed with the EXPLICIT tenant (pre-RLS mount posture).
    const intakes = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id, status, abha_number, profile
         FROM abdm_patient_share_intakes
        WHERE tenant_id = $1::uuid AND request_id = $2 AND environment = 'sandbox'`,
      TENANT_ID, REQUEST_ID,
    );
    expect(intakes).toHaveLength(1);
    expect(intakes[0].tenant_id).toBe(TENANT_ID);
    expect(intakes[0].abha_number).toBe('70-2000-0000-0001');
    // Allowlisted profile only.
    expect(intakes[0].profile).toMatchObject({ name: 'Deep Share Patient' });

    // CM redelivery: collapses on the unique, replay-safe.
    const second = await shareIntakeService.handlePatientProfileShareCallback({
      tenantId: TENANT_ID, environment: 'sandbox', body: SHARE_BODY,
    });
    expect(second.duplicate).toBe(true);
    const countRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM abdm_patient_share_intakes
        WHERE tenant_id = $1::uuid AND request_id = $2 AND environment = 'sandbox'`,
      TENANT_ID, REQUEST_ID,
    );
    expect(countRows[0].n).toBe(1);
  });

  test('702 resolution-evidence CHECK: matched without a patient is impossible', async () => {
    await expect(prisma.$executeRawUnsafe(
      `UPDATE abdm_patient_share_intakes
          SET status = 'matched'
        WHERE tenant_id = $1::uuid AND request_id = $2 AND environment = 'sandbox'`,
      TENANT_ID, REQUEST_ID,
    )).rejects.toThrow(/chk_abdm_share_intake_resolution_evidence/);
  });

  test('703 constraints: txn unique, sha256 shape CHECK, per-page part unique', async () => {
    const sessionRows = await prisma.$queryRawUnsafe(
      `INSERT INTO abdm_hiu_fetch_sessions
         (tenant_id, environment, transaction_id, request_id, status)
       VALUES ($1::uuid, 'sandbox', 'deep-hiu-txn-${RUN}', 'deep-hiu-req-a-${RUN}', 'requested')
       RETURNING id`,
      TENANT_ID,
    );
    const sessionId = sessionRows[0].id;

    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO abdm_hiu_fetch_sessions
         (tenant_id, environment, transaction_id, request_id, status)
       VALUES ($1::uuid, 'sandbox', 'deep-hiu-txn-${RUN}', 'deep-hiu-req-b-${RUN}', 'requested')`,
      TENANT_ID,
    )).rejects.toThrow(/duplicate key value/);

    const pageRows = await prisma.$queryRawUnsafe(
      `INSERT INTO abdm_hiu_fetch_pages
         (tenant_id, fetch_session_id, page_number, page_count,
          payload_sha256, status, claim_id)
       VALUES ($1::uuid, $2::integer, 1, 1, $3::char(64), 'claimed', $4::uuid)
       RETURNING id`,
      TENANT_ID, sessionId, 'c'.repeat(64), '70300000-0000-4000-8000-00000000d703',
    );
    const pageId = pageRows[0].id;

    // sha256 shape CHECK refuses a non-hex digest.
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO abdm_hiu_received_bundles
         (tenant_id, fetch_session_id, fetch_page_id, page_number, part_number,
          bundle_storage_key, bundle_sha256)
       VALUES ($1::uuid, $2::integer, $3::integer, 1, 0,
               'abdm-hiu/x/1.json', $4)`,
      TENANT_ID, sessionId, pageId, 'Z'.repeat(64),
    )).rejects.toThrow(/chk_abdm_hiu_bundle_sha/);

    // A page/part identity can commit only once, even if retry bytes differ.
    const sha = 'a'.repeat(64);
    await prisma.$executeRawUnsafe(
      `INSERT INTO abdm_hiu_received_bundles
         (tenant_id, fetch_session_id, fetch_page_id, page_number, part_number,
          bundle_storage_key, bundle_sha256)
       VALUES ($1::uuid, $2::integer, $3::integer, 1, 0,
               'abdm-hiu/x/1.json', $4)`,
      TENANT_ID, sessionId, pageId, sha,
    );
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO abdm_hiu_received_bundles
         (tenant_id, fetch_session_id, fetch_page_id, page_number, part_number,
          bundle_storage_key, bundle_sha256)
       VALUES ($1::uuid, $2::integer, $3::integer, 1, 0,
               'abdm-hiu/x/1-again.json', $4)`,
      TENANT_ID, sessionId, pageId, 'd'.repeat(64),
    )).rejects.toThrow(/uq_abdm_hiu_bundle_page_part/);
  });

  test('the HIU on-request ack stamps the CM transactionId and acknowledges the session', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO abdm_hiu_fetch_sessions
         (tenant_id, environment, transaction_id, request_id, status,
          key_material_private_ciphertext, key_material_nonce, key_material_expires_at)
       VALUES ($1::uuid, 'sandbox', 'deep-hiu-seed-${RUN}', 'deep-hiu-req-9-${RUN}', 'requested',
               'enc:placeholder', 'nonce', NOW() + INTERVAL '30 minutes')`,
      TENANT_ID,
    );

    const result = await hiuService.handleHiuHealthInfoOnRequest({
      tenantId: TENANT_ID,
      environment: 'sandbox',
      body: {
        requestId: `deep-hiu-ack-9-${RUN}`,
        resp: { requestId: `deep-hiu-req-9-${RUN}` },
        hiRequest: { transactionId: `deep-hiu-txn-9-${RUN}`, sessionStatus: 'ACKNOWLEDGED' },
      },
    });
    expect(result.duplicate).toBe(false);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT transaction_id, status, acknowledged_at
         FROM abdm_hiu_fetch_sessions
        WHERE tenant_id = $1::uuid AND request_id = 'deep-hiu-req-9-${RUN}'`,
      TENANT_ID,
    );
    expect(rows[0]).toMatchObject({ transaction_id: `deep-hiu-txn-9-${RUN}`, status: 'acknowledged' });
    expect(rows[0].acknowledged_at).not.toBeNull();

    // Replayed ack collapses on the webhook-event dedupe.
    const replay = await hiuService.handleHiuHealthInfoOnRequest({
      tenantId: TENANT_ID,
      environment: 'sandbox',
      body: {
        requestId: `deep-hiu-ack-9-${RUN}`,
        resp: { requestId: `deep-hiu-req-9-${RUN}` },
        hiRequest: { transactionId: `deep-hiu-txn-9-${RUN}` },
      },
    });
    expect(replay.duplicate).toBe(true);
  });
});
