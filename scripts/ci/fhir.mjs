import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { cacheDir, checkCommand, repoRoot, run } from './lib.mjs';

const validatorVersion = '6.3.11';
const validatorUrl =
  `https://github.com/hapifhir/org.hl7.fhir.core/releases/download/${validatorVersion}/validator_cli.jar`;
const validatorRoot =
  process.env.FHIR_VALIDATOR_CACHE_DIR || cacheDir('fhir-validator') || join(homedir(), '.cache', 'fhir-validator');
const validatorPath = join(validatorRoot, validatorVersion, 'validator_cli.jar');
const validatorArgs = ['-version', '4.0.1', '-tx', 'n/a'];

async function ensureValidator() {
  if (existsSync(validatorPath)) return validatorPath;

  mkdirSync(dirname(validatorPath), { recursive: true });
  console.log(`Downloading FHIR validator ${validatorVersion}...`);
  const tmpPath = `${validatorPath}.tmp-${process.pid}`;
  try {
    run('curl', [
      '--fail',
      '--location',
      '--retry',
      '5',
      '--retry-all-errors',
      '--connect-timeout',
      '30',
      '--output',
      tmpPath,
      validatorUrl,
    ]);
    renameSync(tmpPath, validatorPath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
  return validatorPath;
}

function installJavaIfPossible() {
  if (process.platform !== 'linux') return false;
  if (process.getuid && process.getuid() !== 0) return false;

  console.log('Java not found; installing OpenJDK 17 for FHIR validation.');
  run('apt-get', ['update']);
  run('apt-get', ['install', '-y', '--no-install-recommends', 'openjdk-17-jre-headless']);
  return true;
}

function jsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(dir, name));
}

export async function runFhirStage({ install = false } = {}) {
  const samplesDir = resolve(repoRoot, 'apps/backend/src/services/fhir/__samples__');
  if (!existsSync(samplesDir)) {
    // A missing samples tree previously skipped the stage silently, which made
    // the gate permanently green (R9 audit, fixed 2026-08-10).
    throw new Error(`FHIR samples directory is missing (${samplesDir}) — golden fixtures are a required gate.`);
  }

  if (!checkCommand('java', ['-version']) && !(install && installJavaIfPossible())) {
    throw new Error('Java is required for FHIR conformance validation.');
  }

  const validator = await ensureValidator();

  for (const file of jsonFiles(samplesDir)) {
    console.log(`Informational FHIR validation: ${file}`);
    try {
      run('java', ['-jar', validator, file, ...validatorArgs]);
    } catch (error) {
      console.warn(`FHIR informational validation failed but is non-blocking: ${error.message}`);
    }
  }

  const goldenDir = join(samplesDir, 'golden');
  const goldenFiles = jsonFiles(goldenDir);
  if (goldenFiles.length === 0) {
    // An absent/empty golden/ used to mean zero strict iterations and a
    // guaranteed pass (R9 audit, fixed 2026-08-10). It is a required gate now.
    throw new Error(
      `No golden FHIR fixtures found in ${goldenDir} — golden fixtures are a required gate. Restore them.`
    );
  }
  let failures = 0;
  for (const file of goldenFiles) {
    console.log(`Strict FHIR golden validation: ${file}`);
    try {
      run('java', ['-jar', validator, file, ...validatorArgs]);
    } catch {
      failures += 1;
    }
  }

  if (failures > 0) {
    throw new Error(`${failures} FHIR golden bundle(s) failed strict validation.`);
  }

  console.log('FHIR conformance validation passed.');
}
