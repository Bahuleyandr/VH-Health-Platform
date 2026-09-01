export async function assertMigrationBatchSucceeded({
  errors,
  client,
  logger,
  failedFiles = [],
}) {
  if (!Number.isSafeInteger(errors) || errors < 0) {
    throw new TypeError('Migration error count must be a non-negative safe integer');
  }
  if (errors === 0) return;

  // Name the file. The per-migration `! <file> — <code> <message>` line is
  // logger.info, and NODE_ENV=test mutes the logger entirely, so without this
  // a failed run in CI or in a migration Job reports only a count and the
  // operator has to bisect to find out which migration broke.
  const named = Array.isArray(failedFiles) && failedFiles.length > 0
    ? ` (${failedFiles.join(', ')})`
    : '';
  const message =
    `Migration setup failed: ${errors} migration(s) failed${named}; ` +
    'seeds and RLS test-role provisioning were not run.';
  logger.error(message);
  await client.end();
  throw new Error(message);
}

export async function assertMigrationTrackerReady({
  canonicalBaselinePresent,
  trackerTablePresent,
  baselineTracked,
  baselineFile,
  client,
  logger,
}) {
  if (!canonicalBaselinePresent || (trackerTablePresent && baselineTracked)) return;

  const message =
    `Migration setup blocked: canonical baseline schema exists but _migrations does not record ${baselineFile}. ` +
    'No migrations, seeds, or RLS test-role provisioning were run; verify and restore tracker state with the migration recovery runbook before retrying.';
  logger.error(message);
  await client.end();
  throw new Error(message);
}
