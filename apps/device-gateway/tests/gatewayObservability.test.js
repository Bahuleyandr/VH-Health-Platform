import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jest } from '@jest/globals';
import { GatewayRuntime } from '../src/gateway.js';
import { logEvent, setLogSink } from '../src/logger.js';
import { serializeMetrics } from '../src/metrics.js';

const PATIENT_UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const message = (id = 'CTRL-1') => [
  `MSH|^~\\&|MON-ICU-01|ICU||VHHEALTH|20260707090000||ORU^R01|${id}|P|2.5`,
  `PID|1||${PATIENT_UID}||NL7^Patient`,
  'PV1|1|I|BED-01',
  'OBR|1|||VITALS',
  'OBX|1|NM|8867-4^Heart rate||118|/min|||||F',
].join('\r');

let entries;
let previousSink;

beforeEach(() => {
  entries = [];
  previousSink = setLogSink((entry) => entries.push(entry));
});

afterEach(() => {
  setLogSink(previousSink);
});

async function tempRuntime(backendClient) {
  const dir = await mkdtemp(join(tmpdir(), 'vh-gw-obs-test-'));
  const runtime = new GatewayRuntime({ spoolDir: dir, backendClient });
  return { dir, runtime };
}

describe('logger PHI hygiene', () => {
  it('drops non-allowlisted fields and free-text values', () => {
    const entry = logEvent('error', 'mllp_refusal', {
      reason: 'spool_corrupt',
      error_code: 'X',
      message: 'MSH|^~\\&|secret hl7 payload',
      patient_uid: PATIENT_UID,
      hl7: message(),
    });
    expect(entry).not.toHaveProperty('message');
    expect(entry).not.toHaveProperty('patient_uid');
    expect(entry).not.toHaveProperty('hl7');
    expect(JSON.stringify(entry)).not.toContain(PATIENT_UID);
    expect(JSON.stringify(entry)).not.toContain('MSH|');
  });
});

describe('refusal-path logging (GW-M1)', () => {
  it('preserves the underlying error code when a statusless resolve failure falls back to spool-only', async () => {
    const backend = {
      resolveDevice: jest.fn(async () => {
        throw Object.assign(new Error('surprising internal failure'), { code: 'SOMETHING_WEIRD' });
      }),
    };
    const { dir, runtime } = await tempRuntime(backend);
    try {
      const result = await runtime.acceptFrame({
        listener: 'icu', sourceIp: '10.1.1.5', message: message('CTRL-LOG-1'),
      });
      // A statusless resolve failure is indistinguishable from a backend
      // outage, so the legacy path spools durably and ACKs instead of
      // refusing — but the warn log still preserves the real error identity.
      expect(result.ackCode).toBe('AA');
      const warned = entries.find((entry) => entry.event === 'legacy_accept_backend_unavailable');
      expect(warned).toMatchObject({
        level: 'warn',
        reason: 'backend_unreachable',
        error_code: 'SOMETHING_WEIRD',
        error_name: 'Error',
      });
      const serialized = JSON.stringify(entries);
      expect(serialized).not.toContain('CTRL-LOG-1');
      expect(serialized).not.toContain(PATIENT_UID);
      expect(serialized).not.toContain('surprising internal failure');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('still refuses with the preserved error code on a definite backend 4xx', async () => {
    const backend = {
      resolveDevice: jest.fn(async () => {
        throw Object.assign(new Error('unknown device'), { code: 'DEVICE_NOT_FOUND', status: 404 });
      }),
    };
    const { dir, runtime } = await tempRuntime(backend);
    try {
      const result = await runtime.acceptFrame({
        listener: 'icu', sourceIp: '10.1.1.5', message: message('CTRL-LOG-2'),
      });
      expect(result.ackCode).toBe('AE');
      const refusal = entries.find((entry) => entry.event === 'mllp_refusal');
      expect(refusal).toMatchObject({
        level: 'error',
        reason: 'spool_corrupt',
        error_code: 'DEVICE_NOT_FOUND',
        error_name: 'Error',
        ack_code: 'AE',
      });
      expect(await runtime.legacySpool('MON-ICU-01').entries()).toHaveLength(0);
      const serialized = JSON.stringify(entries);
      expect(serialized).not.toContain('CTRL-LOG-2');
      expect(serialized).not.toContain(PATIENT_UID);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('logs malformed-frame refusals without embedding frame content', async () => {
    const { dir, runtime } = await tempRuntime({});
    try {
      const result = await runtime.acceptFrame({
        listener: 'icu', sourceIp: '10.1.1.5', message: 'not-hl7-at-all',
      });
      expect(result.ackCode).toBe('AE');
      const refusal = entries.find((entry) => entry.event === 'mllp_refusal');
      expect(refusal).toBeDefined();
      expect(JSON.stringify(entries)).not.toContain('not-hl7-at-all');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('supervised drain logging (GW-M1)', () => {
  it('logs errors escaping drainPartition instead of swallowing them', async () => {
    const { dir, runtime } = await tempRuntime({});
    try {
      runtime.enrollments = [{ listener: 'icu' }]; // non-empty so the timer starts
      runtime.drainPartition = async () => {
        throw Object.assign(new Error('drain exploded'), { code: 'DRAIN_BOOM', status: 500 });
      };
      runtime.startSupervisedDrains(5);
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline
        && !entries.some((entry) => entry.event === 'supervised_drain_failed')) {
        await new Promise((resolve) => { setTimeout(resolve, 10); });
      }
      runtime.stopSupervisedDrains();
      const logged = entries.find((entry) => entry.event === 'supervised_drain_failed');
      expect(logged).toMatchObject({
        level: 'error',
        error_code: 'DRAIN_BOOM',
        error_status: 500,
      });
      expect(JSON.stringify(entries)).not.toContain('drain exploded');
    } finally {
      runtime.stopSupervisedDrains();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('recovery-state gauge transitions (GW-L2)', () => {
  it('zeroes the previous state series when a partition transitions', async () => {
    const { dir, runtime } = await tempRuntime({});
    const fakePartition = (state) => ({
      ref: 'gwl2testref',
      stats: () => ({
        depth: 0,
        oldestAgeSeconds: 0,
        headPosition: '0',
        backendHighWaterPosition: '0',
        recoveryState: state,
        reconciliationState: null,
      }),
    });
    try {
      await runtime.refreshPartitionMetrics(fakePartition('replaying'));
      expect(serializeMetrics())
        .toContain('gateway_recovery_state{partition_ref="gwl2testref",state="replaying"} 1');
      await runtime.refreshPartitionMetrics(fakePartition('ready'));
      const metrics = serializeMetrics();
      expect(metrics)
        .toContain('gateway_recovery_state{partition_ref="gwl2testref",state="replaying"} 0');
      expect(metrics)
        .toContain('gateway_recovery_state{partition_ref="gwl2testref",state="ready"} 1');
      // Re-reporting the same state leaves it at 1.
      await runtime.refreshPartitionMetrics(fakePartition('ready'));
      expect(serializeMetrics())
        .toContain('gateway_recovery_state{partition_ref="gwl2testref",state="ready"} 1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('metrics stay PHI-free alongside logging', () => {
  it('does not leak identifiers into serialized metrics', () => {
    expect(serializeMetrics()).not.toContain(PATIENT_UID);
  });
});
