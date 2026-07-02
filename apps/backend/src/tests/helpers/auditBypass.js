export async function withAuditBypass(prisma, fn) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
    return fn(tx);
  });
}

export async function deleteWithAuditBypass(prisma, sql, ...params) {
  return withAuditBypass(prisma, (tx) => tx.$executeRawUnsafe(sql, ...params));
}
