// Retained-database proof for the published HIU migration 707 followed by the
// additive evidence/count reconciliation in migration 714.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
const published701 = readFileSync(
  new URL('../migrations/701_abha_enrolment_sessions.sql', import.meta.url), 'utf8',
);
const published703 = readFileSync(
  new URL('../migrations/703_abdm_hiu_fetch_sessions.sql', import.meta.url), 'utf8',
);
const published705 = readFileSync(
  new URL('../migrations/705_uhi_transactions.sql', import.meta.url), 'utf8',
);
const published707 = readFileSync(
  new URL('../migrations/707_abdm_uhi_security_upgrade.sql', import.meta.url), 'utf8',
);
const upgrade714 = readFileSync(
  new URL('../migrations/714_abdm_hiu_page_evidence_reconciliation.sql', import.meta.url),
  'utf8',
);

d('ABDM HIU retained migration 707 → 714', () => {
  let client;
  let schema;

  async function createPublishedSchema() {
    schema = `abdm_hiu_714_${randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`
      CREATE TABLE tenants (id UUID PRIMARY KEY);
      CREATE TABLE users (
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        uid UUID NOT NULL,
        PRIMARY KEY (tenant_id, uid)
      );
      CREATE TABLE appointments (id SERIAL PRIMARY KEY);
      CREATE TABLE abdm_consent_artifacts (
        id SERIAL PRIMARY KEY,
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        environment VARCHAR(20) NOT NULL DEFAULT 'sandbox',
        signed_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE abdm_data_transfers (id SERIAL PRIMARY KEY);
      CREATE TABLE abdm_webhook_events (
        id SERIAL PRIMARY KEY,
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        external_event_id VARCHAR(160) NOT NULL,
        event_type VARCHAR(120) NOT NULL,
        signature_verified BOOLEAN NOT NULL DEFAULT FALSE,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        environment VARCHAR(20) NOT NULL DEFAULT 'sandbox'
      );
      CREATE TABLE tenant_interop_secrets (
        id SERIAL PRIMARY KEY,
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        kind VARCHAR(40) NOT NULL,
        sender_identifier VARCHAR(255) NOT NULL,
        secret_ciphertext TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'active'
      );
      CREATE FUNCTION app_current_tenant_id_uuid() RETURNS UUID
      LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    `);
    await client.query(published701);
    await client.query(published703);
    await client.query(published705);
  }

  async function seedSession({
    status = 'completed',
    pageCount = 1,
    legacyPartNumbers = [0],
    eventPayloads = [],
  } = {}) {
    const tenantId = randomUUID();
    const patientUid = randomUUID();
    const transactionId = `retained-714-${randomUUID()}`;
    await client.query('INSERT INTO tenants (id) VALUES ($1)', [tenantId]);
    await client.query(
      'INSERT INTO users (tenant_id, uid) VALUES ($1, $2)',
      [tenantId, patientUid],
    );
    await client.query(
      `INSERT INTO tenant_interop_secrets
         (tenant_id, kind, sender_identifier, secret_ciphertext, status)
       VALUES ($1, 'abdm_callback', 'HIP-RETAINED', 'retained-ciphertext', 'active')`,
      [tenantId],
    );
    const artifact = await client.query(
      `INSERT INTO abdm_consent_artifacts
         (tenant_id, environment, signed_payload, metadata)
       VALUES (
         $1,
         'sandbox',
         jsonb_build_object('hip', jsonb_build_object('id', 'HIP-RETAINED')),
         jsonb_build_object('source', 'hiu_consent_notify')
       )
       RETURNING id`,
      [tenantId],
    );
    const session = await client.query(
      `INSERT INTO abdm_hiu_fetch_sessions
         (tenant_id, environment, consent_artifact_id, patient_uid, transaction_id,
          status, parts_expected, parts_received)
       VALUES ($1, 'sandbox', $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        tenantId,
        artifact.rows[0].id,
        patientUid,
        transactionId,
        status,
        pageCount,
        legacyPartNumbers.length,
      ],
    );
    for (const payload of eventPayloads) {
      await client.query(
        `INSERT INTO abdm_webhook_events
           (tenant_id, external_event_id, event_type, signature_verified, payload, environment)
         VALUES ($1, $2, 'hiu_data_push', TRUE, $3::jsonb, 'sandbox')`,
        [
          tenantId,
          `${transactionId}:page:${payload.pageNumber}`,
          JSON.stringify({ transactionId, ...payload }),
        ],
      );
    }
    for (const [index, partNumber] of legacyPartNumbers.entries()) {
      await client.query(
        `INSERT INTO abdm_hiu_received_bundles
           (tenant_id, fetch_session_id, part_number, bundle_storage_key,
            bundle_sha256, checksum_verified)
         VALUES ($1, $2, $3, $4, $5, TRUE)`,
        [
          tenantId,
          session.rows[0].id,
          partNumber,
          `abdm-hiu/retained-714/${partNumber}.json`,
          (index + 1).toString(16).padStart(64, '0'),
        ],
      );
    }
    return { tenantId, transactionId, sessionId: session.rows[0].id };
  }

  async function installBoundPageState(retained, {
    pageNumber,
    pageCount,
    payloadSha256,
    partNumber = 0,
  }) {
    await client.query(`
      ALTER TABLE abdm_hiu_fetch_sessions
        ADD COLUMN pages_expected INTEGER,
        ADD COLUMN next_page_number INTEGER NOT NULL DEFAULT 1;
      CREATE TABLE abdm_hiu_fetch_pages (
        id SERIAL PRIMARY KEY,
        tenant_id UUID NOT NULL REFERENCES tenants(id),
        fetch_session_id INTEGER NOT NULL,
        page_number INTEGER NOT NULL,
        page_count INTEGER NOT NULL,
        payload_sha256 CHAR(64) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'claimed',
        claim_id UUID NOT NULL,
        claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        parts_count INTEGER NOT NULL DEFAULT 0,
        failure_reason VARCHAR(500),
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id, fetch_session_id, id, page_number),
        UNIQUE (tenant_id, fetch_session_id, page_number)
      );
      ALTER TABLE abdm_hiu_received_bundles
        ADD COLUMN fetch_page_id INTEGER,
        ADD COLUMN page_number INTEGER;
    `);
    await client.query(
      `UPDATE abdm_hiu_fetch_sessions
          SET pages_expected = $3, next_page_number = $3 + 1
        WHERE tenant_id = $1 AND id = $2`,
      [retained.tenantId, retained.sessionId, pageCount],
    );
    const page = await client.query(
      `INSERT INTO abdm_hiu_fetch_pages
         (tenant_id, fetch_session_id, page_number, page_count, payload_sha256,
          status, claim_id, parts_count, completed_at)
       VALUES ($1, $2, $3, $4, $5, 'completed', $6, 1, NOW())
       RETURNING id`,
      [
        retained.tenantId,
        retained.sessionId,
        pageNumber,
        pageCount,
        payloadSha256,
        randomUUID(),
      ],
    );
    await client.query(
      `INSERT INTO abdm_hiu_received_bundles
         (tenant_id, fetch_session_id, fetch_page_id, page_number, part_number,
          bundle_storage_key, bundle_sha256, checksum_verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)`,
      [
        retained.tenantId,
        retained.sessionId,
        page.rows[0].id,
        pageNumber,
        partNumber,
        `abdm-hiu/retained-714/bound-${pageNumber}-${partNumber}.json`,
        'f'.repeat(64),
      ],
    );
    await client.query(
      `UPDATE abdm_hiu_fetch_sessions
          SET parts_received = parts_received + 1
        WHERE tenant_id = $1 AND id = $2`,
      [retained.tenantId, retained.sessionId],
    );
  }

  async function expect714Abort(sessionId) {
    await expect(client.query(upgrade714)).rejects.toMatchObject({ code: '23514' });
    await client.query('ROLLBACK');
    const state = await client.query(
      `SELECT parts_received FROM abdm_hiu_fetch_sessions WHERE id = $1`,
      [sessionId],
    );
    return state.rows[0].parts_received;
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
  });

  beforeEach(createPublishedSchema);

  afterEach(async () => {
    await client.query('RESET search_path').catch(() => {});
    if (schema) await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    schema = null;
  });

  afterAll(async () => {
    await client?.end().catch(() => {});
  });

  it('repairs a published-707 mixed-page undercount and converges on rerun', async () => {
    const page2PayloadSha = '2'.repeat(64);
    const retained = await seedSession({
      pageCount: 2,
      legacyPartNumbers: [0],
      eventPayloads: [
        { pageNumber: 1, pageCount: 2, entryCount: 1 },
        {
          pageNumber: 2,
          pageCount: 2,
          entryCount: 1,
          payloadSha256: page2PayloadSha,
          authenticatedHipId: 'HIP-RETAINED',
        },
      ],
    });
    await installBoundPageState(retained, {
      pageNumber: 2,
      pageCount: 2,
      payloadSha256: page2PayloadSha,
    });

    await client.query(published707);
    const corrupted = await client.query(
      'SELECT parts_received FROM abdm_hiu_fetch_sessions WHERE id = $1',
      [retained.sessionId],
    );
    expect(corrupted.rows[0].parts_received).toBe(1);

    await client.query(upgrade714);
    await client.query(upgrade714);

    const session = await client.query(
      `SELECT parts_received, pages_expected, next_page_number
         FROM abdm_hiu_fetch_sessions WHERE id = $1`,
      [retained.sessionId],
    );
    expect(session.rows[0]).toEqual({
      parts_received: 2,
      pages_expected: 2,
      next_page_number: 3,
    });
    const artifact = await client.query(
      `SELECT metadata->>'hip_id' AS hip_id
         FROM abdm_consent_artifacts
        WHERE tenant_id = $1`,
      [retained.tenantId],
    );
    expect(artifact.rows[0].hip_id).toBe('HIP-RETAINED');
    const pages = await client.query(
      `SELECT page_number, parts_count
         FROM abdm_hiu_fetch_pages
        WHERE fetch_session_id = $1 ORDER BY page_number`,
      [retained.sessionId],
    );
    expect(pages.rows).toEqual([
      { page_number: 1, parts_count: 1 },
      { page_number: 2, parts_count: 1 },
    ]);
  });

  it('fails closed when published 707 bound native and legacy parts onto one page', async () => {
    const pagePayloadSha = '1'.repeat(64);
    const retained = await seedSession({
      pageCount: 1,
      legacyPartNumbers: [1],
      eventPayloads: [{
        pageNumber: 1,
        pageCount: 1,
        entryCount: 2,
        payloadSha256: pagePayloadSha,
        authenticatedHipId: 'HIP-RETAINED',
      }],
    });
    await installBoundPageState(retained, {
      pageNumber: 1,
      pageCount: 1,
      payloadSha256: pagePayloadSha,
    });
    await client.query(published707);

    await expect(expect714Abort(retained.sessionId)).resolves.toBe(1);
  });

  it('fails closed when signed evidence names a different HIP', async () => {
    const retained = await seedSession({
      pageCount: 1,
      legacyPartNumbers: [0],
      eventPayloads: [{ pageNumber: 1, pageCount: 1, entryCount: 1 }],
    });
    await client.query(published707);
    const page = await client.query(
      `SELECT BTRIM(payload_sha256) AS payload_sha256
         FROM abdm_hiu_fetch_pages WHERE fetch_session_id = $1`,
      [retained.sessionId],
    );
    await client.query(
      `UPDATE abdm_webhook_events
          SET payload = payload || jsonb_build_object(
            'payloadSha256', $2::text,
            'authenticatedHipId', 'OTHER-HIP'
          )
        WHERE tenant_id = $1`,
      [retained.tenantId, page.rows[0].payload_sha256],
    );

    await expect(expect714Abort(retained.sessionId)).resolves.toBe(1);
  });

  it('fails closed on an out-of-int32 callback page count retained by 707', async () => {
    const retained = await seedSession({
      pageCount: 1,
      legacyPartNumbers: [0],
      eventPayloads: [{ pageNumber: 1, pageCount: 2147483648, entryCount: 1 }],
    });
    await client.query(published707);

    await expect(expect714Abort(retained.sessionId)).resolves.toBe(1);
  });
});
