import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { checkCommand, repoRoot, run } from './lib.mjs';

const validatorVersion = '6.3.11';
const validatorUrl =
  `https://github.com/hapifhir/org.hl7.fhir.core/releases/download/${validatorVersion}/validator_cli.jar`;
const validatorPath = join(homedir(), '.cache', 'fhir-validator', validatorVersion, 'validator_cli.jar');

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

function jsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(dir, name));
}

export async function runFhirStage() {
  const samplesDir = resolve(repoRoot, 'apps/backend/src/services/fhir/__samples__');
  if (!existsSync(samplesDir)) {
    console.log('No FHIR samples directory; skipping FHIR conformance.');
    return;
  }

  if (!checkCommand('java', ['-version'])) {
    throw new Error('Java is required for FHIR conformance validation.');
  }

  const validator = await ensureValidator();

  for (const file of jsonFiles(samplesDir)) {
    console.log(`Informational FHIR validation: ${file}`);
    try {
      run('java', ['-jar', validator, file, '-version', '4.0.1']);
    } catch (error) {
      console.warn(`FHIR informational validation failed but is non-blocking: ${error.message}`);
    }
  }

  const goldenDir = join(samplesDir, 'golden');
  let failures = 0;
  for (const file of jsonFiles(goldenDir)) {
    console.log(`Strict FHIR golden validation: ${file}`);
    try {
      run('java', ['-jar', validator, file, '-version', '4.0.1']);
    } catch {
      failures += 1;
    }
  }

  if (failures > 0) {
    throw new Error(`${failures} FHIR golden bundle(s) failed strict validation.`);
  }

  console.log('FHIR conformance validation passed.');
}
