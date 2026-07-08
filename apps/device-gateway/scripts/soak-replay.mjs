import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GatewayRuntime } from '../src/gateway.js';
import { extractMeta } from '../src/hl7.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE_DIR = resolve(here, '../fixtures');
const PATIENT_UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EXPECTED_REJECT_FIXTURES = new Set(['malformed_segments.hl7']);

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function withControlId(message, controlId) {
  const segments = String(message).trim().split(/\r?\n|\r/);
  const msh = segments[0].split('|');
  msh[9] = controlId;
  segments[0] = msh.join('|');
  return segments.join('\r');
}

async function loadFixtures(fixtureDir) {
  const names = (await readdir(fixtureDir)).filter((name) => name.endsWith('.hl7')).sort();
  const fixtures = [];
  for (const name of names) {
    const raw = await readFile(join(fixtureDir, name), 'utf8');
    if (raw.trim().startsWith('MSH|')) fixtures.push({ name, raw });
  }
  if (fixtures.length === 0) {
    throw new Error(`No .hl7 fixtures found in ${fixtureDir}`);
  }
  return fixtures;
}

export async function runSoakReplay({
  fixtureDir = DEFAULT_FIXTURE_DIR,
  cycles = 250,
  duplicateEvery = 25,
  spoolDir = null,
} = {}) {
  const fixtures = await loadFixtures(fixtureDir);
  const ownedTemp = !spoolDir;
  const dir = spoolDir || await mkdtemp(join(tmpdir(), 'vh-device-gateway-soak-'));
  const accepted = new Set();
  const ingested = [];
  let rejected = 0;
  const duplicateAcks = [];

  const backendClient = {
    async resolveDevice({ device_code: deviceCode }) {
      return {
        device: { device_code: deviceCode || 'MON-ICU-01' },
        patient_uid: PATIENT_UID,
      };
    },
    async ingest({ message }) {
      const controlId = extractMeta(message).controlId;
      ingested.push(controlId);
      return { ok: true, control_id: controlId };
    },
  };

  const runtime = new GatewayRuntime({
    spoolDir: dir,
    backendClient,
    maxSpoolBytes: 512 * 1024 * 1024,
  });

  try {
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      for (let index = 0; index < fixtures.length; index += 1) {
        const fixture = fixtures[index];
        const controlId = `SOAK-${cycle}-${index}-${fixture.name.replace(/[^a-z0-9]/gi, '-')}`;
        const message = withControlId(fixture.raw, controlId);
        const result = await runtime.acceptFrame({
          listener: 'pilot-soak',
          sourceIp: '10.70.0.25',
          message,
          channel: 'BED-01',
        });
        if (result.ackCode !== 'AA') {
          if (EXPECTED_REJECT_FIXTURES.has(fixture.name)) {
            rejected += 1;
            continue;
          }
          throw new Error(`Fixture ${fixture.name} was not accepted: ${result.ackCode}`);
        }
        if (EXPECTED_REJECT_FIXTURES.has(fixture.name)) {
          throw new Error(`Negative fixture ${fixture.name} was unexpectedly accepted`);
        }
        accepted.add(controlId);
        if (duplicateEvery > 0 && accepted.size % duplicateEvery === 0) {
          const duplicate = await runtime.acceptFrame({
            listener: 'pilot-soak',
            sourceIp: '10.70.0.25',
            message,
            channel: 'BED-01',
          });
          if (!duplicate.duplicate || duplicate.ackCode !== 'AA') {
            throw new Error(`Duplicate ${controlId} was not AA-deduped`);
          }
          duplicateAcks.push(controlId);
        }
      }
    }

    for (const source of runtime.spools.keys()) {
      await runtime.drainSource(source);
    }

    const uniqueIngested = new Set(ingested);
    const lost = [...accepted].filter((controlId) => !uniqueIngested.has(controlId));
    const duplicated = ingested.filter((controlId, index) => ingested.indexOf(controlId) !== index);
    const remaining = [];
    for (const [source, spool] of runtime.spools.entries()) {
      const entries = await spool.entries();
      if (entries.length > 0) remaining.push({ source, count: entries.length });
    }
    if (lost.length || duplicated.length || remaining.length) {
      throw new Error(JSON.stringify({ lost, duplicated, remaining }));
    }

    return {
      fixtures: fixtures.length,
      cycles,
      accepted: accepted.size,
      rejected,
      ingested: ingested.length,
      duplicateAcks: duplicateAcks.length,
      spoolDir: dir,
    };
  } finally {
    if (ownedTemp) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runSoakReplay({
    fixtureDir: resolve(argValue('fixtures', DEFAULT_FIXTURE_DIR)),
    cycles: Number.parseInt(argValue('cycles', '250'), 10) || 250,
    duplicateEvery: Number.parseInt(argValue('duplicate-every', '25'), 10) || 0,
    spoolDir: argValue('spool-dir', null),
  });
  console.log(JSON.stringify(result, null, 2));
}
