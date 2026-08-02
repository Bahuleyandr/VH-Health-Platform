const INTERFACE_ENGINE_TABLES = Object.freeze([
  'interop_backend_delivery_receipts',
  'interop_message_attempts',
  'interop_messages',
  'interop_transform_tests',
  'interop_replay_batches',
  'interop_worker_leases',
  'interop_channel_versions',
  'interop_channels',
  'interop_systems',
  'tenant_interop_secrets',
]);

export async function purgeInterfaceEngineTestData(prisma, tenantIds) {
  const tenants = [...new Set((tenantIds || []).filter(Boolean))];
  if (tenants.length === 0) return { total: 0 };

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    for (const tenantId of tenants) {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_tenant_id', $1::text, true)`,
        tenantId,
      );
      for (const table of INTERFACE_ENGINE_TABLES) {
        await tx.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = $1::uuid`,
          tenantId,
        );
      }
      await tx.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, tenantId);
    }

    const counts = Object.fromEntries(INTERFACE_ENGINE_TABLES.map(table => [table, 0]));
    counts.tenants = 0;
    for (const tenantId of tenants) {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_tenant_id', $1::text, true)`,
        tenantId,
      );
      for (const table of INTERFACE_ENGINE_TABLES) {
        const rows = await tx.$queryRawUnsafe(
          `SELECT COUNT(*)::integer AS count FROM ${table} WHERE tenant_id = $1::uuid`,
          tenantId,
        );
        counts[table] += Number(rows[0]?.count || 0);
      }
      const tenantRows = await tx.$queryRawUnsafe(
        `SELECT COUNT(*)::integer AS count FROM tenants WHERE id = $1::uuid`,
        tenantId,
      );
      counts.tenants += Number(tenantRows[0]?.count || 0);
    }
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    if (total !== 0) {
      throw new Error(`Interface-engine test cleanup left stranded rows: ${JSON.stringify(counts)}`);
    }
    return { ...counts, total };
  });
}

export default { purgeInterfaceEngineTestData };
