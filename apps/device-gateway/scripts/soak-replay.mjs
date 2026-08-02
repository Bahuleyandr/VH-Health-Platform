import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GatewayRuntime } from '../src/gateway.js';
import { extractMeta } from '../src/hl7.js';
import { I09_GATEWAY_SEQUENCE_CONTRACT } from '../src/spool.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE_DIR = resolve(here, '../fixtures');
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OFFSET_ID = '33333333-3333-4333-8333-333333333333';
const GATEWAY_ID = 41;
const DEVICE_ID = 42;
const DEVICE_CODE = 'SOAK-MON';
const GENESIS_TOKEN = 'synthetic-soak-genesis';
const EXPECTED_REJECT_FIXTURES = new Set(['malformed_segments.hl7']);

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function normalizedFixture(message, controlId) {
  const segments = String(message).trim().split(/\r?\n|\r/);
  if (!segments[0]?.startsWith('MSH|')) return Buffer.from(String(message), 'utf8');
  const msh = segments[0].split('|');
  if (msh.length < 10 || !msh[8]) return Buffer.from(segments.join('\r'), 'utf8');
  msh[2] = DEVICE_CODE;
  msh[9] = controlId;
  segments[0] = msh.join('|');
  const obrIndex = segments.findIndex((segment) => segment.startsWith('OBR|'));
  if (obrIndex < 0) {
    segments.splice(2, 0, 'OBR|1|||85354-9|||20260731123000+0530');
  } else {
    const obr = segments[obrIndex].split('|');
    while (obr.length <= 7) obr.push('');
    obr[7] = '20260731123000+0530';
    segments[obrIndex] = obr.join('|');
  }
  return Buffer.from(segments.join('\r'), 'utf8');
}

async function loadFixtures(fixtureDir) {
  const names = (await readdir(fixtureDir)).filter((name) => name.endsWith('.hl7')).sort();
  const fixtures = [];
  for (const name of names) {
    const raw = await readFile(resolve(fixtureDir, name), 'utf8');
    if (raw.trim().startsWith('MSH|')) fixtures.push({ name, raw });
  }
  if (fixtures.length === 0) throw new Error(`No .hl7 fixtures found in ${fixtureDir}`);
  return fixtures;
}

function resumeState(state) {
  return {
    contract: I09_GATEWAY_SEQUENCE_CONTRACT,
    interface_family: 'I09',
    tenant_id: TENANT_ID,
    offset_id: OFFSET_ID,
    source_partition: `i09/gateway/${GATEWAY_ID}/device/${DEVICE_ID}`,
    generation: 1,
    recovery_state: state.recoveryState,
    high_water_position: state.highWaterPosition,
    high_water_token: state.highWaterToken,
    retained_from_position: '0',
    retained_from_token: GENESIS_TOKEN,
    resume_cutoff_position: state.cutoffPosition,
    resume_cutoff_token: state.cutoffToken,
    policy_version: 'synthetic-soak-v1',
    policy_signature: 'synthetic-soak-signature',
    retention_policy: 'synthetic-soak-only',
    retention_until: '2027-01-01T00:00:00.000Z',
  };
}

function enrollment() {
  return {
    listener: 'pilot-soak',
    recovery_contract: I09_GATEWAY_SEQUENCE_CONTRACT,
    gateway_registry_id: GATEWAY_ID,
    device_registry_id: DEVICE_ID,
    device_code: DEVICE_CODE,
    allowed_source_ips: ['10.70.0.25'],
    partition_capacity_bytes: 512 * 1024 * 1024,
    global_capacity_bytes: 512 * 1024 * 1024,
    gap_reserve_bytes: 1024 * 1024,
    clock: {
      source: 'synthetic-soak-clock',
      max_skew_ms: 1000,
      max_sample_age_ms: 60_000,
      evidence_path: '/synthetic/soak-clock.json',
    },
  };
}

function backendFor(state, ingested) {
  return {
    async resolveDevice() {
      return { device: { id: DEVICE_ID, device_code: DEVICE_CODE } };
    },
    async readI09ResumeState() {
      return resumeState(state);
    },
    async ingestI09Recovery(payload) {
      const recovery = payload.recovery;
      if (state.recoveryState !== 'replaying') {
        throw Object.assign(new Error('synthetic offset is not replaying'), {
          status: 409,
          code: 'EXTERNAL_RECOVERY_OFFSET_NOT_REPLAYING',
        });
      }
      const expected = (BigInt(state.highWaterPosition) + 1n).toString();
      if (recovery.source_position !== expected || recovery.predecessor_token !== state.highWaterToken) {
        throw Object.assign(new Error('synthetic source gap'), {
          status: 409,
          code: 'EXTERNAL_RECOVERY_IDENTITY_CONFLICT',
        });
      }
      const controlId = extractMeta(payload.message).controlId;
      if (ingested.includes(controlId)) throw new Error(`duplicate backend execution for ${controlId}`);
      ingested.push(controlId);
      state.highWaterPosition = recovery.source_position;
      state.highWaterToken = recovery.source_token;
      if (state.highWaterPosition === state.cutoffPosition) state.recoveryState = 'ready';
      return { cursor: {
        high_water_position: state.highWaterPosition,
        high_water_token: state.highWaterToken,
        recovery_state: state.recoveryState,
      } };
    },
  };
}

async function newRuntime(dir, backend) {
  const runtime = new GatewayRuntime({
    spoolDir: dir,
    backendClient: backend,
    enrollments: [enrollment()],
    clockEvidenceProvider: async () => ({
      source: 'synthetic-soak-clock',
      status: 'trusted',
      offset_ms: 0,
      sampled_at: new Date().toISOString(),
    }),
  });
  await runtime.initialize();
  return runtime;
}

export async function runSoakReplay({
  fixtureDir = DEFAULT_FIXTURE_DIR,
  cycles = 250,
  duplicateEvery = 25,
  restartEvery = 100,
  spoolDir = null,
} = {}) {
  const fixtures = await loadFixtures(fixtureDir);
  const ownedTemp = !spoolDir;
  const dir = spoolDir || await mkdtemp(resolve(tmpdir(), 'vh-device-gateway-soak-'));
  const accepted = new Map();
  const ingested = [];
  const state = {
    recoveryState: 'paused',
    highWaterPosition: '0',
    highWaterToken: GENESIS_TOKEN,
    cutoffPosition: null,
    cutoffToken: null,
  };
  const backend = backendFor(state, ingested);
  let runtime = await newRuntime(dir, backend);
  let rejected = 0;
  let duplicateAcks = 0;
  let restarts = 0;

  try {
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      for (let index = 0; index < fixtures.length; index += 1) {
        const fixture = fixtures[index];
        const controlId = `SOAK-${cycle}-${index}-${fixture.name.replace(/[^a-z0-9]/gi, '-')}`;
        const payload = normalizedFixture(fixture.raw, controlId);
        const result = await runtime.acceptFrame({
          listener: 'pilot-soak',
          sourceIp: '10.70.0.25',
          message: payload,
          channel: 'BED-01',
        });
        if (result.ackCode !== 'AA') {
          if (EXPECTED_REJECT_FIXTURES.has(fixture.name)) {
            rejected += 1;
            continue;
          }
          throw new Error(`Fixture ${fixture.name} was not accepted: ${result.ackCode}/${result.errorCode}`);
        }
        if (EXPECTED_REJECT_FIXTURES.has(fixture.name)) {
          throw new Error(`Negative fixture ${fixture.name} was unexpectedly accepted`);
        }
        accepted.set(controlId, payload);
        if (duplicateEvery > 0 && accepted.size % duplicateEvery === 0) {
          const duplicate = await runtime.acceptFrame({
            listener: 'pilot-soak',
            sourceIp: '10.70.0.25',
            message: payload,
            channel: 'BED-01',
          });
          if (!duplicate.duplicate || duplicate.ackCode !== 'AA') {
            throw new Error(`Duplicate ${controlId} was not durably AA-deduped`);
          }
          duplicateAcks += 1;
        }
        if (restartEvery > 0 && accepted.size % restartEvery === 0) {
          runtime = await newRuntime(dir, backend);
          restarts += 1;
        }
      }
    }

    const enrollmentConfig = runtime.enrollments[0];
    const spool = runtime.partitionByEnrollment.get(runtime.enrollmentKey(enrollmentConfig));
    state.cutoffPosition = spool.manifest.head_position;
    state.cutoffToken = spool.recordAt(state.cutoffPosition)?.source_token || GENESIS_TOKEN;
    state.recoveryState = 'replaying';
    await runtime.drainPartition(enrollmentConfig);

    runtime = await newRuntime(dir, backend);
    restarts += 1;
    const finalEnrollment = runtime.enrollments[0];
    const finalSpool = runtime.partitionByEnrollment.get(runtime.enrollmentKey(finalEnrollment));
    const records = [...finalSpool.state.accepted.values()]
      .sort((a, b) => Number(BigInt(a.source_position) - BigInt(b.source_position)));
    const positions = records.map((record) => record.source_position);
    const expectedPositions = records.map((_, index) => String(index + 1));
    const acceptedIds = new Set(accepted.keys());
    const ingestedIds = new Set(ingested);
    const lost = [...acceptedIds].filter((controlId) => !ingestedIds.has(controlId));
    const duplicated = ingested.filter((controlId, index) => ingested.indexOf(controlId) !== index);
    const notCompacted = records.filter((record) => record.payload_state !== 'compacted');
    if (lost.length || duplicated.length || notCompacted.length
      || positions.join(',') !== expectedPositions.join(',')
      || finalSpool.state.gaps.length > 0
      || finalSpool.manifest.local_reconciliation_state
      || state.recoveryState !== 'ready'
      || state.highWaterPosition !== state.cutoffPosition
      || state.highWaterToken !== state.cutoffToken) {
      throw new Error(JSON.stringify({
        lost, duplicated, notCompacted: notCompacted.length,
        positionsMatch: positions.join(',') === expectedPositions.join(','),
        gaps: finalSpool.state.gaps.length,
        reconciliation: finalSpool.manifest.local_reconciliation_state,
        recoveryState: state.recoveryState,
      }));
    }

    const last = records.at(-1);
    if (last) {
      const duplicate = await runtime.acceptFrame({
        listener: 'pilot-soak',
        sourceIp: '10.70.0.25',
        message: accepted.get(last.msh10),
        channel: 'BED-01',
      });
      if (!duplicate.duplicate || duplicate.ackCode !== 'AA') {
        throw new Error('receipt-only duplicate failed after final restart');
      }
      duplicateAcks += 1;
    }

    return {
      fixtures: fixtures.length,
      cycles,
      accepted: accepted.size,
      rejected,
      ingested: ingested.length,
      duplicateAcks,
      restarts,
      positions: records.length,
      recoveryState: state.recoveryState,
      lost: 0,
      duplicated: 0,
      renumbered: 0,
      silentlyDiscarded: 0,
      spoolDir: dir,
    };
  } finally {
    if (ownedTemp) await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runSoakReplay({
    fixtureDir: resolve(argValue('fixtures', DEFAULT_FIXTURE_DIR)),
    cycles: Number.parseInt(argValue('cycles', '250'), 10) || 250,
    duplicateEvery: Number.parseInt(argValue('duplicate-every', '25'), 10) || 0,
    restartEvery: Number.parseInt(argValue('restart-every', '100'), 10) || 0,
    spoolDir: argValue('spool-dir', null),
  });
  console.log(JSON.stringify(result, null, 2));
}
