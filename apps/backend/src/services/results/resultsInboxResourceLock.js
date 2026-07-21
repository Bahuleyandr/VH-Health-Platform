export async function lockResultsInboxResourceTx({
  tx,
  tenantId,
  resourceType,
  resourceId,
}) {
  await tx.$queryRawUnsafe(
    `SELECT pg_advisory_xact_lock(
              hashtextextended(
                jsonb_build_array($1::text, $2::text, $3::text)::text,
                0
              )
            )::text AS resource_locked`,
    tenantId,
    String(resourceType || ''),
    String(resourceId || ''),
  );
}
