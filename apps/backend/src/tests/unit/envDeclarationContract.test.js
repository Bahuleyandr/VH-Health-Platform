// Env declaration contract (2026-08-23 once-over).
//
// Two halves of one rule: a variable the code READS must be DECLARED
// somewhere an operator will look, and a name DECLARED in a manifest must be
// read by something. Both halves had failed silently —
//   • FIELD_ENCRYPTION_MASTER_KEK, KMS_MASTER_KEY and PHI_SEARCH_HASH_KEY were
//     read at runtime and declared in no manifest, so the features that need
//     them were inert with no boot-time signal;
//   • DATABASE_SSL_MODE and APP_VERSION were declared in the backend ConfigMap
//     and read by nothing at all.
//
// The boot-behaviour cases below spawn validateEnv.js in a controlled
// environment (same technique as validateEnvSecurity.test.js) so they assert
// what a pod actually does, not what the schema object looks like.

import { spawnSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const node = process.execPath;

/** Walk up from the backend package until the repo root (has infra/kubernetes). */
function findRepoRoot() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, 'infra', 'kubernetes'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`Could not locate the repo root from ${process.cwd()}`);
}

const repoRoot = findRepoRoot();
const backendRoot = path.join(repoRoot, 'apps', 'backend');
const readRepo = relative => readFileSync(path.join(repoRoot, relative), 'utf8');

const CONFIGMAP = 'infra/kubernetes/apps/backend/configmap.yaml';
const SEALED_SECRET_EXAMPLE = 'infra/kubernetes/apps/backend/sealed-secret.yaml.example';
const ENV_EXAMPLE = 'apps/backend/.env.example';
const VALIDATE_ENV = 'apps/backend/src/utils/validateEnv.js';

function walk(dir, extensions, out = [], { skipDirs = [] } = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    if (skipDirs.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, extensions, out, { skipDirs });
    else if (extensions.some(ext => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

function runValidateEnv(extraEnv = {}) {
  return spawnSync(
    node,
    ['--input-type=module', '-e', "import './src/utils/validateEnv.js';"],
    {
      cwd: backendRoot,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        NODE_ENV: 'production',
        API_KEY: 'test-api-key',
        DATABASE_URL: 'postgresql://postgres@127.0.0.1:55432/vhhealth_test',
        JWT_SECRET: 'test-jwt-secret-at-least-32-chars',
        FIELD_ENCRYPTION_KEY: 'test-field-encryption-key-32chars!!',
        TOTP_ENCRYPTION_KEY: 'test-totp-encryption-key-32chars!!!!',
        BACKUP_ENCRYPTION_KEY: 'test-backup-encryption-key-32chars!!',
        TENANT_BASE_HOST: 'vhhealth.app',
        ...extraEnv,
      },
      encoding: 'utf8',
    },
  );
}

const output = result => `${result.stdout}${result.stderr}`;

// Structurally valid sample material. These are throwaway test values, not
// deployment secrets: 32 and 8 decoded bytes of a fixed byte pattern.
const KEY_32_BYTES = Buffer.alloc(32, 7).toString('base64');
const OTHER_32_BYTES = Buffer.alloc(32, 9).toString('base64');
const KEY_8_BYTES = Buffer.alloc(8, 7).toString('base64');
const MASTER_KEK = 'test-field-encryption-master-kek-32chars';

describe('FIELD_ENCRYPTION_MASTER_KEK declaration + boot posture', () => {
  it('boots without it but warns, naming every path that fails closed', () => {
    const result = runValidateEnv();
    const text = output(result);

    expect(result.status).toBe(0);
    expect(text).toContain('FIELD_ENCRYPTION_MASTER_KEK is not set');
    // The warning has to be actionable on its own — an operator reading pod
    // logs must learn WHICH features are dead, not just that a name is unset.
    expect(text).toContain('payroll run generation');
    expect(text).toContain('payslip-password reveal');
    expect(text).toContain('HL7 I03 inbound recovery');
    expect(text).toContain('PHI re-wrap');
  }, 20000);

  it('reports the configured posture instead of warning once it is set', () => {
    const result = runValidateEnv({ FIELD_ENCRYPTION_MASTER_KEK: MASTER_KEK });
    const text = output(result);

    expect(result.status).toBe(0);
    expect(text).toContain('Per-tenant field-encryption master KEK: configured');
    expect(text).not.toContain('FIELD_ENCRYPTION_MASTER_KEK is not set');
  }, 20000);

  it('refuses to boot on a present-but-too-short master KEK', () => {
    const result = runValidateEnv({ FIELD_ENCRYPTION_MASTER_KEK: 'too-short' });

    expect(result.status).toBe(1);
    expect(output(result)).toContain('FIELD_ENCRYPTION_MASTER_KEK');
  }, 20000);

  it('is declared in .env.example and in the sealed-secret schema', () => {
    expect(readRepo(ENV_EXAMPLE)).toContain('FIELD_ENCRYPTION_MASTER_KEK');
    expect(readRepo(SEALED_SECRET_EXAMPLE))
      .toMatch(/^ {4}FIELD_ENCRYPTION_MASTER_KEK: PLACEHOLDER/m);
  });
});

describe('PHI shadow-column subsystem (migration 132) declaration', () => {
  it('reports DORMANT when neither key is set — the shipped posture', () => {
    const text = output(runValidateEnv());

    expect(text).toContain('PHI shadow-column envelope encryption: DORMANT by configuration');
  }, 20000);

  it('reports ARMED when both keys are set', () => {
    const result = runValidateEnv({
      KMS_MASTER_KEY: KEY_32_BYTES,
      PHI_SEARCH_HASH_KEY: OTHER_32_BYTES,
    });

    expect(result.status).toBe(0);
    expect(output(result)).toContain('PHI shadow-column envelope encryption: ARMED');
  }, 20000);

  it.each([
    ['KMS_MASTER_KEY', { KMS_MASTER_KEY: KEY_32_BYTES }, 'PHI_SEARCH_HASH_KEY'],
    ['PHI_SEARCH_HASH_KEY', { PHI_SEARCH_HASH_KEY: KEY_32_BYTES }, 'KMS_MASTER_KEY'],
  ])('refuses to boot half-armed with only %s set', (_present, env, missing) => {
    const result = runValidateEnv(env);
    const text = output(result);

    expect(result.status).toBe(1);
    expect(text).toContain('half-armed');
    expect(text).toContain(missing);
  }, 20000);

  it('refuses a KMS_MASTER_KEY that does not decode to exactly 32 bytes', () => {
    const result = runValidateEnv({
      KMS_MASTER_KEY: KEY_8_BYTES,
      PHI_SEARCH_HASH_KEY: OTHER_32_BYTES,
    });

    expect(result.status).toBe(1);
    expect(output(result)).toContain('KMS_MASTER_KEY must base64-decode to exactly 32 bytes');
  }, 20000);

  it('refuses a PHI_SEARCH_HASH_KEY shorter than 16 decoded bytes', () => {
    const result = runValidateEnv({
      KMS_MASTER_KEY: KEY_32_BYTES,
      PHI_SEARCH_HASH_KEY: KEY_8_BYTES,
    });

    expect(result.status).toBe(1);
    expect(output(result)).toContain('PHI_SEARCH_HASH_KEY must base64-decode to at least 16 bytes');
  }, 20000);

  it('refuses a KMS_PROVIDER naming one of the throwing stub providers', () => {
    const result = runValidateEnv({ KMS_PROVIDER: 'aws-kms' });

    expect(result.status).toBe(1);
    expect(output(result)).toContain('KMS_PROVIDER must be "env"');
  }, 20000);

  it('keeps both keys out of the live sealed-secret schema, commented not absent', () => {
    const schema = readRepo(SEALED_SECRET_EXAMPLE);

    // Dormancy must be recorded, not merely unmentioned.
    expect(schema).toContain('KMS_MASTER_KEY');
    expect(schema).toContain('PHI_SEARCH_HASH_KEY');
    // …but neither may be an active key an operator would seal by default.
    expect(schema).not.toMatch(/^ {4}KMS_MASTER_KEY:/m);
    expect(schema).not.toMatch(/^ {4}PHI_SEARCH_HASH_KEY:/m);
  });
});

describe('client force-upgrade gates', () => {
  it('prints the resolved state of both gates so "disabled" is visible', () => {
    const text = output(runValidateEnv());

    expect(text).toContain('Client force-upgrade gates');
    expect(text).toContain('patient=DISABLED (0)');
    expect(text).toContain('staff=DISABLED (0)');
  }, 20000);

  it('prints the armed staff minimum when one is configured', () => {
    const result = runValidateEnv({ MIN_STAFF_VERSION_CODE: '42' });

    expect(result.status).toBe(0);
    expect(output(result)).toContain('staff=min build 42');
  }, 20000);

  it('declares both codes in the backend ConfigMap as the literal string "0"', () => {
    const configmap = readRepo(CONFIGMAP);

    // Explicitly "0", never "" — Joi.number() rejects an empty string, which
    // would take the pod down rather than disable the gate.
    expect(configmap).toMatch(/^\s*MIN_STAFF_VERSION_CODE:\s*"0"\s*$/m);
    expect(configmap).toMatch(/^\s*MIN_PATIENT_VERSION_CODE:\s*"0"\s*$/m);
  });
});

describe('no ConfigMap key is declared without a consumer', () => {
  it('every backend ConfigMap key is read by backend code or another manifest', () => {
    const configmap = readRepo(CONFIGMAP);
    const declared = [...configmap.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map(m => m[1]);
    expect(declared.length).toBeGreaterThan(20);

    // A backend reader: the literal name appearing as a whole uppercase token
    // in backend JS. Whole-token matching is what keeps this honest —
    // APP_VERSION is not "read" by CONTINUITY_ACTION_APP_VERSION_INVALID.
    //
    // `src/tests` is excluded on purpose. It is production code that has to
    // consume a declared key; a test (this file included) merely NAMING a
    // retired variable in a comment must not vouch for it. Leaving tests in
    // made this assertion pass with DATABASE_SSL_MODE re-added — caught by
    // mutation-testing the rule before trusting it.
    const backendTokens = new Set();
    const backendFiles = [
      ...walk(path.join(backendRoot, 'src'), ['.js', '.mjs'], [], { skipDirs: ['tests'] }),
      ...walk(path.join(backendRoot, 'scripts'), ['.js', '.mjs'], [], { skipDirs: ['test'] }),
    ];
    for (const file of backendFiles) {
      for (const match of readFileSync(file, 'utf8').matchAll(/[A-Z][A-Z0-9_]{2,}/g)) {
        backendTokens.add(match[0]);
      }
    }

    // A manifest consumer: another workload projecting the key into its own
    // env (`key: NAME`, `name: NAME`) or a Kustomize replacement source
    // (`data.NAME`). The ConfigMap itself is excluded — declaring a key is not
    // consuming it, which is the whole point of this test.
    const configmapPath = path.join(repoRoot, CONFIGMAP);
    const manifestRefs = new Set();
    for (const file of walk(path.join(repoRoot, 'infra', 'kubernetes'), ['.yaml', '.yml', '.sh'])) {
      if (path.resolve(file) === path.resolve(configmapPath)) continue;
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/(?:key:\s*|name:\s*|data\.)([A-Z][A-Z0-9_]{2,})/g)) {
        manifestRefs.add(match[1]);
      }
    }

    const orphans = declared.filter(key => !backendTokens.has(key) && !manifestRefs.has(key));
    expect(orphans).toEqual([]);
  }, 30000);
});

describe('every audited runtime read is declared where an operator looks', () => {
  // name → the file whose `process.env.<name>` read made it load-bearing.
  const AUDITED = [
    ['FIELD_ENCRYPTION_MASTER_KEK', 'apps/backend/src/services/security/tenantKekProvider.js'],
    ['KMS_MASTER_KEY', 'apps/backend/src/services/security/kmsProviderService.js'],
    ['KMS_PROVIDER', 'apps/backend/src/services/security/kmsProviderService.js'],
    ['PHI_SEARCH_HASH_KEY', 'apps/backend/src/services/security/phiColumnEncryption.js'],
    ['MIN_STAFF_VERSION_CODE', 'apps/backend/src/routes/configRoutes.js'],
    ['MIN_PATIENT_VERSION_CODE', 'apps/backend/src/routes/configRoutes.js'],
  ];

  it.each(AUDITED)('%s is read by its named source and declared in .env.example + validateEnv', (name, source) => {
    // Anchor the pairing: if the read moves or disappears, this test says so
    // instead of quietly pinning a declaration nothing needs any more.
    expect(readRepo(source)).toContain(`process.env.${name}`);
    expect(readRepo(ENV_EXAMPLE)).toContain(name);
    expect(readRepo(VALIDATE_ENV)).toMatch(new RegExp(`^\\s*${name}: Joi`, 'm'));
  });
});

// Guard against the walker silently scanning nothing (an empty corpus would
// make the orphan check above pass vacuously).
it('walks a non-empty backend corpus', () => {
  const files = walk(path.join(backendRoot, 'src'), ['.js']);
  expect(files.length).toBeGreaterThan(100);
  expect(statSync(files[0]).size).toBeGreaterThan(0);
});
