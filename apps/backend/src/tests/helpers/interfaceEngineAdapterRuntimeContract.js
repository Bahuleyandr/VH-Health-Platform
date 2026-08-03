import { createHash, randomUUID } from 'node:crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { getMessage, ingestMessage } from '../../services/interfaceEngine/interfaceEngineService.js';

process.env.FIELD_ENCRYPTION_KEY = process.env.FIELD_ENCRYPTION_KEY || 'interface-engine-test-field-key-32chars';
process.env.FIELD_KEK_LOCAL_SECRET = process.env.FIELD_KEK_LOCAL_SECRET || 'interface-engine-test-kek-key-32chars';

export function defineI05AdapterRuntimeContract({
  protocol,
  payload,
  backendAdapterKey,
  adapterVersion,
  expectedEvidence,
} = {}) {
  const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  const describeIfDb = databaseUrl ? describe : describe.skip;
  const tenantId = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const payloadHash = createHash('sha256').update(Buffer.from(payload, 'utf8')).digest('hex');
  let channel;

  describeIfDb(`C6.1-E I05 ${protocol} runtime adapter`, () => {
    beforeAll(async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO tenants (id, slug, name)
         VALUES ($1::uuid, $2::text, 'C6.1-E I05 runtime tenant')`,
        tenantId,
        `c61e-i05-${protocol}-${suffix}`,
      );
      channel = await setTenantTx(tenantId, async (tx) => {
        const systems = await tx.$queryRawUnsafe(
          `INSERT INTO interop_systems
             (tenant_id, system_key, display_name, kind, direction, status)
           VALUES ($1::uuid, $2::text, 'I05 runtime target', 'vh_backend', 'bidirectional', 'active')
           RETURNING id`,
          tenantId,
          `${protocol}-target-${suffix}`,
        );
        const channels = await tx.$queryRawUnsafe(
          `INSERT INTO interop_channels
             (tenant_id, channel_key, display_name, source_system_id, target_system_id,
              direction, connector_kind, protocol, status, auth_kind)
           VALUES ($1::uuid, $2::text, 'I05 inbound', $3::integer, $3::integer,
                   'inbound', 'internal_backend', $4::text, 'active', 'internal')
           RETURNING id, channel_key, direction, protocol, message_types, retention_days`,
          tenantId,
          `${protocol}-in-${suffix}`,
          systems[0].id,
          protocol,
        );
        const versions = await tx.$queryRawUnsafe(
          `INSERT INTO interop_channel_versions
             (tenant_id, channel_id, version_number, status, routing_policy, transform_dsl)
           VALUES ($1::uuid, $2::integer, 1, 'active',
                   jsonb_build_object('adapter', $3::text),
                   jsonb_build_object('kind', $4::text, 'emit', jsonb_build_object('adapter', $3::text)))
           RETURNING id, routing_policy, transform_dsl`,
          tenantId,
          channels[0].id,
          backendAdapterKey,
          `${protocol}-to-backend-adapter`,
        );
        await tx.$executeRawUnsafe(
          'UPDATE interop_channels SET active_version_id = $3::integer WHERE tenant_id = $1::uuid AND id = $2::integer',
          tenantId,
          channels[0].id,
          versions[0].id,
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

    test('marks inbound delivered only after an exact-byte adapter receipt exists', async () => {
      const accepted = await ingestMessage({
        tenantId,
        channel,
        payload,
        direction: 'inbound',
        requestId: `${protocol}-${suffix}`,
      });
      expect(accepted.status).toBe('delivered');
      expect(accepted.payload_hash).toBe(payloadHash);
      const detail = await getMessage({ tenantId, id: accepted.id });
      expect(detail.receipts).toEqual([
        expect.objectContaining({
          protocol,
          direction: 'inbound',
          adapter_key: backendAdapterKey,
          adapter_version: adapterVersion,
          receipt_status: 'accepted',
          payload_sha256: payloadHash,
          payload_bytes: Buffer.byteLength(payload, 'utf8'),
          evidence: expect.objectContaining({
            ...expectedEvidence,
            byte_parity_verified: true,
          }),
        }),
      ]);
      expect(detail.attempts.map(attempt => attempt.phase)).toEqual(
        expect.arrayContaining(['receive', 'parse', 'transform', 'deliver_backend']),
      );
    }, 30_000);
  });
}
