import { createHash, randomUUID } from 'node:crypto';

import prisma, { setTenantTx } from '../lib/prisma.js';
import { getMessage, ingestMessage } from '../services/interfaceEngine/interfaceEngineService.js';

process.env.FIELD_ENCRYPTION_KEY = process.env.FIELD_ENCRYPTION_KEY || 'interface-engine-test-field-key-32chars';
process.env.FIELD_KEK_LOCAL_SECRET = process.env.FIELD_KEK_LOCAL_SECRET || 'interface-engine-test-kek-key-32chars';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const TENANT_ID = randomUUID();
const SUFFIX = randomUUID().replaceAll('-', '').slice(0, 12);
const PAYLOAD = `patient_id,name,notes\r\np-${SUFFIX},"Asha, Rao","line one\nline two"`;
const PAYLOAD_HASH = createHash('sha256').update(Buffer.from(PAYLOAD, 'utf8')).digest('hex');
let channel;

describeIfDb('C6.1-E I05 CSV runtime adapter', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'C6.1-E I05 CSV runtime tenant')`,
      TENANT_ID,
      `c61e-i05-csv-runtime-${SUFFIX}`,
    );
    channel = await setTenantTx(TENANT_ID, async (tx) => {
      const systems = await tx.$queryRawUnsafe(
        `INSERT INTO interop_systems
           (tenant_id, system_key, display_name, kind, direction, status)
         VALUES ($1::uuid, $2::text, 'CSV target', 'vh_backend', 'bidirectional', 'active')
         RETURNING id`,
        TENANT_ID,
        `csv-target-${SUFFIX}`,
      );
      // Deliberately NOT activated — see the note in
      // src/tests/helpers/interfaceEngineAdapterRuntimeContract.js. Migration
      // 665 (re-planted by 670) only accepts an active channel for a connector
      // the runtime drives, and `internal_backend` has no driver;
      // `ingestMessage` takes this channel object directly and never reads
      // `status`. Activation is asserted in
      // src/tests/deep/interfaceEngineRuntimeActivation.deep.test.js.
      const channels = await tx.$queryRawUnsafe(
        `INSERT INTO interop_channels
           (tenant_id, channel_key, display_name, source_system_id, target_system_id,
            direction, connector_kind, protocol, status, auth_kind)
         VALUES ($1::uuid, $2::text, 'CSV inbound', $3::integer, $3::integer,
                 'inbound', 'internal_backend', 'csv', 'draft', 'internal')
         RETURNING id, channel_key, direction, protocol, message_types, retention_days`,
        TENANT_ID,
        `csv-in-${SUFFIX}`,
        systems[0].id,
      );
      const versions = await tx.$queryRawUnsafe(
        `INSERT INTO interop_channel_versions
           (tenant_id, channel_id, version_number, status, routing_policy, transform_dsl)
         VALUES ($1::uuid, $2::integer, 1, 'candidate',
                 '{"adapter":"backend.interop.csv"}'::jsonb,
                 '{"kind":"csv-to-backend-adapter","emit":{"adapter":"backend.interop.csv"}}'::jsonb)
         RETURNING id, routing_policy, transform_dsl`,
        TENANT_ID,
        channels[0].id,
      );
      return {
        ...channels[0],
        version_id: versions[0].id,
        routing_policy: versions[0].routing_policy,
        transform_dsl: versions[0].transform_dsl,
      };
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('marks inbound delivered only after a byte-parity backend receipt exists', async () => {
    const accepted = await ingestMessage({
      tenantId: TENANT_ID,
      channel,
      payload: PAYLOAD,
      direction: 'inbound',
      requestId: `csv-${SUFFIX}`,
    });
    expect(accepted.status).toBe('delivered');
    expect(accepted.payload_hash).toBe(PAYLOAD_HASH);

    const detail = await getMessage({ tenantId: TENANT_ID, id: accepted.id });
    expect(detail.receipts).toEqual([
      expect.objectContaining({
        protocol: 'csv',
        direction: 'inbound',
        adapter_key: 'backend.interop.csv',
        adapter_version: 'vhhealth.i05.csv/v1',
        receipt_status: 'accepted',
        payload_sha256: PAYLOAD_HASH,
        payload_bytes: Buffer.byteLength(PAYLOAD, 'utf8'),
        evidence: expect.objectContaining({
          header: ['patient_id', 'name', 'notes'],
          row_count: 1,
          byte_parity_verified: true,
        }),
      }),
    ]);
    expect(detail.attempts.map(attempt => attempt.phase)).toEqual(
      expect.arrayContaining(['receive', 'parse', 'transform', 'deliver_backend']),
    );
  }, 30_000);
});
