// Retained-database proof for published 701/703/705 followed by additive 707.
// Runs in an isolated schema inside the configured test database.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
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
const upgrade707 = readFileSync(
  new URL('../migrations/707_abdm_uhi_security_upgrade.sql', import.meta.url), 'utf8',
);

d('ABDM/UHI retained migration 701/703/705 to 707', () => {
  let client;
  let schema;

  async function createPublishedSchema() {
    schema = `abdm_uhi_upgrade_${randomUUID().replaceAll('-', '')}`;
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
      CREATE TABLE abdm_consent_artifacts (id SERIAL PRIMARY KEY);
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
      CREATE FUNCTION app_current_tenant_id_uuid() RETURNS UUID
      LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    `);
    await client.query(published701);
    await client.query(published703);
    await client.query(published705);
  }

  async function seedSession({ events, bundleParts, status = 'completed', partsExpected = 2 }) {
    const tenantId = randomUUID();
    const patientUid = randomUUID();
    const transactionId = `retained-${randomUUID()}`;
    await client.query('INSERT INTO tenants (id) VALUES ($1)', [tenantId]);
    await client.query(
      'INSERT INTO users (tenant_id, uid) VALUES ($1, $2)',
      [tenantId, patientUid],
    );
    const session = await client.query(
      `INSERT INTO abdm_hiu_fetch_sessions
         (tenant_id, environment, patient_uid, transaction_id, status,
          parts_expected, parts_received)
       VALUES ($1, 'sandbox', $2, $3, $4, $5, $6)
       RETURNING id`,
      [tenantId, patientUid, transactionId, status, partsExpected, bundleParts.length],
    );
    for (const event of events) {
      await client.query(
        `INSERT INTO abdm_webhook_events
           (tenant_id, external_event_id, event_type, signature_verified, payload, environment)
         VALUES ($1, $2, 'hiu_data_push', TRUE, $3::jsonb, 'sandbox')`,
        [
          tenantId,
          `${transactionId}:page:${event.pageNumber}`,
          JSON.stringify({ transactionId, pageCount: partsExpected, ...event }),
        ],
      );
    }
    for (const [index, partNumber] of bundleParts.entries()) {
      await client.query(
        `INSERT INTO abdm_hiu_received_bundles
           (tenant_id, fetch_session_id, part_number, bundle_storage_key,
            bundle_sha256, checksum_verified)
         VALUES ($1, $2, $3, $4, $5, TRUE)`,
        [
          tenantId,
          session.rows[0].id,
          partNumber,
          `abdm-hiu/retained/${partNumber}.json`,
          (index + 1).toString(16).padStart(64, '0'),
        ],
      );
    }
    return { tenantId, transactionId, sessionId: session.rows[0].id };
  }

  async function expectUpgradeAbortWithoutRewrite(sessionId) {
    await expect(client.query(upgrade707)).rejects.toMatchObject({ code: '23514' });
    await client.query('ROLLBACK');
    const columns = await client.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'abdm_hiu_received_bundles'
          AND column_name IN ('fetch_page_id', 'page_number')`,
      [schema],
    );
    expect(columns.rows).toHaveLength(0);
    const bundles = await client.query(
      `SELECT part_number FROM abdm_hiu_received_bundles
        WHERE fetch_session_id = $1 ORDER BY part_number`,
      [sessionId],
    );
    return bundles.rows.map(row => row.part_number);
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

  it('converts valid two-page retained evidence and converges on rerun', async () => {
    const retained = await seedSession({
      events: [
        { pageNumber: 1, entryCount: 1 },
        { pageNumber: 2, entryCount: 1 },
      ],
      bundleParts: [0, 1000],
    });

    await client.query(upgrade707);
    await client.query(upgrade707);

    const pages = await client.query(
      `SELECT page_number, page_count, parts_count
         FROM abdm_hiu_fetch_pages
        WHERE tenant_id = $1 AND fetch_session_id = $2
        ORDER BY page_number`,
      [retained.tenantId, retained.sessionId],
    );
    expect(pages.rows).toEqual([
      { page_number: 1, page_count: 2, parts_count: 1 },
      { page_number: 2, page_count: 2, parts_count: 1 },
    ]);
    const bundles = await client.query(
      `SELECT page_number, part_number, fetch_page_id IS NOT NULL AS bound
         FROM abdm_hiu_received_bundles
        WHERE tenant_id = $1 AND fetch_session_id = $2
        ORDER BY page_number`,
      [retained.tenantId, retained.sessionId],
    );
    expect(bundles.rows).toEqual([
      { page_number: 1, part_number: 0, bound: true },
      { page_number: 2, part_number: 0, bound: true },
    ]);
  });

  it('aborts oversized page evidence without relabeling an overflow row as an empty page', async () => {
    const retained = await seedSession({
      events: [
        { pageNumber: 1, entryCount: 1001 },
        { pageNumber: 2, entryCount: 0 },
      ],
      bundleParts: [0, 1000],
    });

    await expect(expectUpgradeAbortWithoutRewrite(retained.sessionId))
      .resolves.toEqual([0, 1000]);
  });

  it('aborts when callback evidence cannot prove the base-1000 identity', async () => {
    const retained = await seedSession({ events: [], bundleParts: [0] });

    await expect(expectUpgradeAbortWithoutRewrite(retained.sessionId))
      .resolves.toEqual([0]);
  });
});
