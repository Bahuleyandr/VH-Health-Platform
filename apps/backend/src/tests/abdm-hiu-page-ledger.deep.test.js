// HIU page ledger crash/retry contract (migration 703) — deep suite.
//
// Runs the final page mutation against real Postgres to prove that bundle
// references, page/count advancement, key destruction, and durable page
// completion share one transaction. A simulated worker crash before commit
// must leave every ledger row retryable rather than producing an undercount.

const { default: prisma, setTenantTx } = await import('../lib/prisma.js');

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const TRANSACTION_ID = 'deep-hiu-page-atomic-703';
const PAYLOAD_SHA256 = 'a'.repeat(64);
const BUNDLE_SHA256 = 'b'.repeat(64);
const CLAIM_ID = '70300000-0000-4000-8000-00000000c1a1';

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM abdm_hiu_fetch_sessions
      WHERE tenant_id = $1::uuid AND transaction_id = $2::text`,
    TENANT_ID, TRANSACTION_ID,
  ).catch(() => {});
}

async function commitFinalPage(sessionId, pageId, { crash = false } = {}) {
  return setTenantTx(TENANT_ID, async (tx) => {
    await tx.$queryRawUnsafe(
      `INSERT INTO abdm_hiu_received_bundles
         (tenant_id, fetch_session_id, fetch_page_id, page_number,
          care_context_reference, hi_type, part_number, bundle_storage_key,
          bundle_sha256, checksum_verified, media_type)
       VALUES ($1::uuid, $2::integer, $3::integer, 1,
               'cc-deep', 'Prescription', 0, 'abdm-hiu/deep/retry.json',
               $4::char(64), true, 'application/fhir+json')`,
      TENANT_ID, sessionId, pageId, BUNDLE_SHA256,
    );
    await tx.$queryRawUnsafe(
      `UPDATE abdm_hiu_fetch_sessions
          SET status = 'completed', parts_received = parts_received + 1,
              pages_expected = 1, next_page_number = next_page_number + 1,
              completed_at = NOW(), key_material_private_ciphertext = NULL,
              updated_at = NOW()
        WHERE id = $1::integer AND tenant_id = $2::uuid
          AND status = 'acknowledged' AND next_page_number = 1`,
      sessionId, TENANT_ID,
    );
    await tx.$queryRawUnsafe(
      `UPDATE abdm_hiu_fetch_pages
          SET status = 'completed', parts_count = 1, completed_at = NOW(),
              updated_at = NOW()
        WHERE id = $1::integer AND tenant_id = $2::uuid
          AND status = 'claimed' AND claim_id = $3::uuid`,
      pageId, TENANT_ID, CLAIM_ID,
    );
    if (crash) throw new Error('simulated worker crash before commit');
  });
}

d('ABDM HIU durable page ledger (703)', () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  test('a pre-commit crash rolls back the full page, then an identical retry commits exactly once', async () => {
    const sessions = await prisma.$queryRawUnsafe(
      `INSERT INTO abdm_hiu_fetch_sessions
         (tenant_id, environment, transaction_id, request_id, status,
          key_material_private_ciphertext, key_material_expires_at)
       VALUES ($1::uuid, 'sandbox', $2::text, 'deep-request-703', 'acknowledged',
               'encrypted-test-key', NOW() + INTERVAL '10 minutes')
       RETURNING id`,
      TENANT_ID, TRANSACTION_ID,
    );
    const sessionId = sessions[0].id;
    const pages = await prisma.$queryRawUnsafe(
      `INSERT INTO abdm_hiu_fetch_pages
         (tenant_id, fetch_session_id, page_number, page_count,
          payload_sha256, status, claim_id)
       VALUES ($1::uuid, $2::integer, 1, 1, $3::char(64), 'claimed', $4::uuid)
       RETURNING id`,
      TENANT_ID, sessionId, PAYLOAD_SHA256, CLAIM_ID,
    );
    const pageId = pages[0].id;

    await expect(commitFinalPage(sessionId, pageId, { crash: true }))
      .rejects.toThrow('simulated worker crash before commit');

    const afterCrash = await prisma.$queryRawUnsafe(
      `SELECT s.status, s.parts_received, s.next_page_number,
              s.key_material_private_ciphertext, p.status AS page_status,
              p.parts_count,
              (SELECT COUNT(*)::integer FROM abdm_hiu_received_bundles b
                WHERE b.tenant_id = s.tenant_id AND b.fetch_session_id = s.id) AS bundle_count
         FROM abdm_hiu_fetch_sessions s
         JOIN abdm_hiu_fetch_pages p
           ON p.tenant_id = s.tenant_id AND p.fetch_session_id = s.id
        WHERE s.id = $1::integer AND s.tenant_id = $2::uuid`,
      sessionId, TENANT_ID,
    );
    expect(afterCrash[0]).toMatchObject({
      status: 'acknowledged',
      parts_received: 0,
      next_page_number: 1,
      key_material_private_ciphertext: 'encrypted-test-key',
      page_status: 'claimed',
      parts_count: 0,
      bundle_count: 0,
    });

    await commitFinalPage(sessionId, pageId);
    const afterRetry = await prisma.$queryRawUnsafe(
      `SELECT s.status, s.parts_received, s.next_page_number,
              s.key_material_private_ciphertext, p.status AS page_status,
              p.parts_count,
              (SELECT COUNT(*)::integer FROM abdm_hiu_received_bundles b
                WHERE b.tenant_id = s.tenant_id AND b.fetch_session_id = s.id) AS bundle_count
         FROM abdm_hiu_fetch_sessions s
         JOIN abdm_hiu_fetch_pages p
           ON p.tenant_id = s.tenant_id AND p.fetch_session_id = s.id
        WHERE s.id = $1::integer AND s.tenant_id = $2::uuid`,
      sessionId, TENANT_ID,
    );
    expect(afterRetry[0]).toMatchObject({
      status: 'completed',
      parts_received: 1,
      next_page_number: 2,
      key_material_private_ciphertext: null,
      page_status: 'completed',
      parts_count: 1,
      bundle_count: 1,
    });
  });
});
