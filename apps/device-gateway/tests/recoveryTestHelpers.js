import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayRuntime } from '../src/gateway.js';
import { I09_GATEWAY_SEQUENCE_CONTRACT } from '../src/spool.js';

export const TENANT_ID = '11111111-1111-4111-8111-111111111111';
export const PATIENT_UID = '22222222-2222-4222-8222-222222222222';
export const OFFSET_ID = '33333333-3333-4333-8333-333333333333';
export const GENESIS_TOKEN = 'backend-genesis-token';

export function message(id = 'MSG-1', { app = 'MON-7', occurrence = '20260731123000+0530', note = '' } = {}) {
  return Buffer.from([
    `MSH|^~\\&|${app}|ICU|||20260731123100+0530||ORU^R01|${id}|P|2.5`,
    `PID|||${PATIENT_UID}`,
    `OBR|1|||85354-9|||${occurrence}`,
    'OBX|1|NM|8867-4^Heart rate||88|/min',
    ...(note ? [`NTE|1||${note}`] : []),
  ].join('\r'), 'utf8');
}

export function resumeState({
  gatewayId = 41,
  deviceId = 42,
  generation = 1,
  recoveryState = 'paused',
  highWaterPosition = '0',
  highWaterToken = GENESIS_TOKEN,
  cutoffPosition = null,
  cutoffToken = null,
} = {}) {
  return {
    contract: I09_GATEWAY_SEQUENCE_CONTRACT,
    interface_family: 'I09',
    tenant_id: TENANT_ID,
    offset_id: OFFSET_ID,
    source_partition: `i09/gateway/${gatewayId}/device/${deviceId}`,
    generation,
    recovery_state: recoveryState,
    high_water_position: highWaterPosition,
    high_water_token: highWaterToken,
    retained_from_position: highWaterPosition,
    retained_from_token: highWaterToken,
    resume_cutoff_position: cutoffPosition,
    resume_cutoff_token: cutoffToken,
    policy_version: 'c6.1-test',
    policy_signature: 'synthetic-signature',
    retention_policy: 'synthetic-only',
    retention_until: '2027-01-01T00:00:00.000Z',
  };
}

export function enrollment({
  listener = 'icu', gatewayId = 41, deviceId = 42, deviceCode = 'MON-7',
  sourceIp = '10.1.1.5', partitionCapacity = 1024 * 1024,
  globalCapacity = 8 * 1024 * 1024, gapReserve = 64 * 1024,
} = {}) {
  return {
    listener,
    recovery_contract: I09_GATEWAY_SEQUENCE_CONTRACT,
    gateway_registry_id: gatewayId,
    device_registry_id: deviceId,
    device_code: deviceCode,
    allowed_source_ips: [sourceIp],
    partition_capacity_bytes: partitionCapacity,
    global_capacity_bytes: globalCapacity,
    gap_reserve_bytes: gapReserve,
    clock: {
      source: 'test-clock',
      max_skew_ms: 1000,
      max_sample_age_ms: 60_000,
      evidence_path: '/held/test-clock-evidence.json',
    },
  };
}

export function trustedClock() {
  return {
    source: 'test-clock',
    status: 'trusted',
    offset_ms: 5,
    sampled_at: new Date().toISOString(),
  };
}

export function statefulBackend(initial = resumeState()) {
  const backend = {
    state: { ...initial },
    ingested: [],
    resumeReads: 0,
    ingestBehavior: null,
    async readI09ResumeState() {
      backend.resumeReads += 1;
      return { ...backend.state };
    },
    async ingestI09Recovery(payload) {
      backend.ingested.push(payload);
      if (backend.ingestBehavior) return backend.ingestBehavior(payload, backend);
      const recovery = payload.recovery;
      if (backend.state.recovery_state !== 'replaying') {
        throw Object.assign(new Error('not replaying'), {
          status: 409,
          code: 'EXTERNAL_RECOVERY_OFFSET_NOT_REPLAYING',
        });
      }
      if (BigInt(recovery.source_position) !== BigInt(backend.state.high_water_position) + 1n
        || recovery.predecessor_token !== backend.state.high_water_token) {
        throw Object.assign(new Error('source gap'), {
          status: 409,
          code: 'EXTERNAL_RECOVERY_IDENTITY_CONFLICT',
        });
      }
      backend.state.high_water_position = recovery.source_position;
      backend.state.high_water_token = recovery.source_token;
      if (recovery.source_position === backend.state.resume_cutoff_position) {
        backend.state.recovery_state = 'ready';
      }
      return { cursor: {
        high_water_position: backend.state.high_water_position,
        high_water_token: backend.state.high_water_token,
        recovery_state: backend.state.recovery_state,
      } };
    },
    async resolveDevice() {
      return { device: { id: 42, device_code: 'MON-7' }, patient_uid: PATIENT_UID };
    },
    async ingest(payload) {
      backend.ingested.push(payload);
      return { ok: true };
    },
    async ingestColdChain() {
      return { action: 'reading_recorded' };
    },
  };
  return backend;
}

export async function recoveryRuntime({
  dir = null,
  backend = statefulBackend(),
  enrollments = [enrollment()],
  clockEvidenceProvider = async () => trustedClock(),
  stageHook = null,
} = {}) {
  const owned = !dir;
  const root = dir || await mkdtemp(join(tmpdir(), 'vh-i09-gateway-test-'));
  const runtime = new GatewayRuntime({
    spoolDir: root,
    backendClient: backend,
    enrollments,
    clockEvidenceProvider,
    stageHook,
  });
  await runtime.initialize();
  return {
    dir: root,
    runtime,
    backend,
    cleanup: async () => { if (owned) await rm(root, { recursive: true, force: true }); },
  };
}

export async function accept(runtime, payload = message(), options = {}) {
  return runtime.acceptFrame({
    listener: options.listener || 'icu',
    sourceIp: options.sourceIp || '10.1.1.5',
    message: payload,
    channel: options.channel || 'BED-1',
  });
}

export function partition(runtime, enrollmentIndex = 0) {
  const item = runtime.enrollments[enrollmentIndex];
  return runtime.partitionByEnrollment.get(runtime.enrollmentKey(item));
}

export function authorizeReplay(backend, spool, cutoffPosition = spool.manifest.head_position) {
  const record = spool.recordAt(cutoffPosition);
  backend.state = {
    ...backend.state,
    recovery_state: 'replaying',
    resume_cutoff_position: cutoffPosition,
    resume_cutoff_token: record?.source_token || spool.manifest.base_token,
  };
}
