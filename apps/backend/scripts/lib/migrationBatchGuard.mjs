export async function assertMigrationBatchSucceeded({ errors, client, logger }) {
  if (!Number.isSafeInteger(errors) || errors < 0) {
    throw new TypeError('Migration error count must be a non-negative safe integer');
  }
  if (errors === 0) return;

  const message =
    `Migration setup failed: ${errors} migration(s) failed; ` +
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
