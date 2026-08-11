const POSTGRESQL_PROTOCOLS = new Set(['postgres:', 'postgresql:']);
const LOCAL_DATABASE_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const CONNECTION_TARGET_QUERY_PARAMETERS = new Set([
  'db',
  'database',
  'dbname',
  'host',
  'hostaddr',
  'port',
  'service',
  'servicefile',
]);

function inspectSyntheticSeedTarget(connectionString, allowedDatabaseNames) {
  if (typeof connectionString !== 'string' || /\s/u.test(connectionString)) {
    return { validPostgresqlUrl: false, targetOverride: false, localAllowedTarget: false };
  }

  try {
    const url = new URL(connectionString);
    const protocol = url.protocol.toLowerCase();
    const rawHostname = url.hostname.toLowerCase();
    const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
      ? rawHostname.slice(1, -1)
      : rawHostname;
    const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const validPostgresqlUrl = POSTGRESQL_PROTOCOLS.has(protocol)
      && rawHostname.length > 0
      && database.length > 0;
    const targetOverride = [...url.searchParams.keys()].some((key) => (
      CONNECTION_TARGET_QUERY_PARAMETERS.has(key.toLowerCase())
    ));

    return {
      validPostgresqlUrl,
      targetOverride,
      localAllowedTarget: validPostgresqlUrl
        && !targetOverride
        && LOCAL_DATABASE_HOSTS.has(hostname)
        && allowedDatabaseNames.has(database),
    };
  } catch {
    return { validPostgresqlUrl: false, targetOverride: false, localAllowedTarget: false };
  }
}

export function assertCiSetupSeedPolicy({
  skipSeedsArg,
  skipSeedsEnv,
  env = process.env,
}) {
  if (env.NODE_ENV === 'production' && (!skipSeedsArg || !skipSeedsEnv)) {
    throw new Error(
      'Production database setup requires --skip-seeds and CI_DB_SKIP_SEEDS=1; refusing to run before connecting.',
    );
  }
}

export function assertSyntheticSeedTarget({
  connectionString,
  env = process.env,
  scriptName = 'Synthetic seed',
  allowedDatabaseNames = ['vhhealth_test'],
  allowNonTestOverride = true,
}) {
  if (env.NODE_ENV === 'production') {
    throw new Error(`${scriptName} refuses synthetic data when NODE_ENV=production.`);
  }
  if (!connectionString) {
    throw new Error(`${scriptName} requires DATABASE_URL or TEST_DATABASE_URL.`);
  }

  const target = inspectSyntheticSeedTarget(
    connectionString,
    new Set(allowedDatabaseNames),
  );
  if (!target.validPostgresqlUrl) {
    throw new Error(
      `${scriptName} requires a valid PostgreSQL connection URL with an explicit host and database.`,
    );
  }
  if (target.targetOverride) {
    throw new Error(
      `${scriptName} DATABASE_URL must not use connection-target query parameters.`,
    );
  }
  if (target.localAllowedTarget) return;
  if (allowNonTestOverride && env.VH_ALLOW_NON_TEST_DATA_SEED === 'true') return;

  const allowedDatabaseLabel = allowedDatabaseNames.join(' or ');
  const overrideLabel = allowNonTestOverride
    ? ' or VH_ALLOW_NON_TEST_DATA_SEED=true on an intentional disposable non-production database'
    : '';

  throw new Error(
    `${scriptName} requires local ${allowedDatabaseLabel}${overrideLabel}.`,
  );
}
