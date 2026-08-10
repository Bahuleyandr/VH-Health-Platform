import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jest } from '@jest/globals';
import { GatewayRuntime } from '../src/gateway.js';

const PATIENT_UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const message = (id = 'CTRL-1') => [
  `MSH|^~\\&|MON-ICU-01|ICU||VHHEALTH|20260707090000||ORU^R01|${id}|P|2.5`,
  `PID|1||${PATIENT_UID}||NL7^Patient`,
  'PV1|1|I|BED-01',
  'OBR|1|||VITALS',
  'OBX|1|NM|8867-4^Heart rate||118|/min|||||F',
].join('\r');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function tempRuntime(backendClient, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'vh-gw-durability-test-'));
  const runtime = new GatewayRuntime({ spoolDir: dir, backendClient, ...options });
  return { dir, runtime };
}

const okBackend = (overrides = {}) => ({
  resolveDevice: jest.fn(async () => ({ device: { device_code: 'MON-ICU-01' }, patient_uid: PATIENT_UID })),
  ingest: jest.fn(async () => ({ ok: true })),
  ...overrides,
});

describe('legacy persist-then-ACK ordering (GW-1)', () => {
  it('does not consume the control ID when the spool append fails', async () => {
    const backend = okBackend();
    const { dir, runtime } = await tempRuntime(backend);
    try {
      const spool = runtime.legacySpool('MON-ICU-01');
      const originalAppend = spool.append.bind(spool);
      spool.append = jest.fn(async () => {
        throw Object.assign(new Error('disk fault'), { code: 'EIO' });
      });

      const failed = await runtime.acceptFrame({ listener: 'icu', sourceIp: '10.1.1.5', message: message('CTRL-P1') });
      expect(failed.ackCode).toBe('AE');

      // The retransmit after the failed append must be ACCEPTED and
      // persisted — not swallowed as "AA Duplicate" of an append that never
      // happened. That was the silent-drop window: dedup ran before append.
      spool.append = originalAppend;
      const retry = await runtime.acceptFrame({ listener: 'icu', sourceIp: '10.1.1.5', message: message('CTRL-P1') });
      expect(retry).toMatchObject({ ackCode: 'AA', duplicate: false });
      const entries = await spool.entries();
      expect(entries).toHaveLength(1);
      expect(entries[0].control_id).toBe('CTRL-P1');

      // Only now, after a durable append, is the control ID consumed.
      const duplicate = await runtime.acceptFrame({ listener: 'icu', sourceIp: '10.1.1.5', message: message('CTRL-P1') });
      expect(duplicate).toMatchObject({ ackCode: 'AA', duplicate: true });
      expect(await spool.entries()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent copies of one legacy control ID across sockets', async () => {
    const backend = okBackend();
    const { dir, runtime } = await tempRuntime(backend);
    try {
      const spool = runtime.legacySpool('MON-ICU-01');
      const originalAppend = spool.append.bind(spool);
      let signalFirstAppend;
      let releaseFirstAppend;
      const firstAppendStarted = new Promise((resolve) => { signalFirstAppend = resolve; });
      const firstAppendReleased = new Promise((resolve) => { releaseFirstAppend = resolve; });
      let appendCalls = 0;
      spool.append = async (entry) => {
        appendCalls += 1;
        if (appendCalls === 1) {
          signalFirstAppend();
          await firstAppendReleased;
        }
        return originalAppend(entry);
      };

      const first = runtime.acceptFrame({ listener: 'icu', sourceIp: '10.1.1.5', message: message('CTRL-RACE') });
      await firstAppendStarted;
      const second = runtime.acceptFrame({ listener: 'icu', sourceIp: '10.1.1.5', message: message('CTRL-RACE') });
      await sleep(20);
      releaseFirstAppend();

      const results = await Promise.all([first, second]);
      expect(results.map((result) => result.duplicate).sort()).toEqual([false, true]);
      expect(appendCalls).toBe(1);
      expect(await spool.entries()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not consume the control ID on a spool-full AR refusal', async () => {
    const backend = okBackend();
    const { dir, runtime } = await tempRuntime(backend, { maxSpoolBytes: 10 });
    try {
      const rejected = await runtime.acceptFrame({ listener: 'icu', sourceIp: '10.1.1.5', message: message('CTRL-P2') });
      expect(rejected.ackCode).toBe('AR');

      // Same runtime, capacity restored (operator grew the volume): the
      // retransmit must be accepted, not dropped as a duplicate.
      runtime.legacySpool('MON-ICU-01').maxBytes = 1024 * 1024;
      const retry = await runtime.acceptFrame({ listener: 'icu', sourceIp: '10.1.1.5', message: message('CTRL-P2') });
      expect(retry).toMatchObject({ ackCode: 'AA', duplicate: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('legacy backend-outage buffering (GW-2)', () => {
  it('spools and ACKs during a backend outage, then drains on recovery', async () => {
    let backendUp = false;
    const ingested = [];
    const backend = {
      resolveDevice: jest.fn(async () => {
        if (!backendUp) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        return { device: { device_code: 'MON-ICU-01' }, patient_uid: PATIENT_UID };
      }),
      ingest: jest.fn(async (payload) => {
        if (!backendUp) throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
        ingested.push(payload.control_id || payload.message.match(/CTRL-O[0-9]/)[0]);
        return { ok: true };
      }),
    };
    const { dir, runtime } = await tempRuntime(backend);
    try {
      // Backend down: the gateway must buffer durably, not refuse.
      const first = await runtime.acceptFrame({ listener: 'icu', sourceIp: '10.1.1.5', message: message('CTRL-O1') });
      const second = await runtime.acceptFrame({ listener: 'icu', sourceIp: '10.1.1.5', message: message('CTRL-O2') });
      expect(first).toMatchObject({ ackCode: 'AA', duplicate: false });
      expect(second).toMatchObject({ ackCode: 'AA', duplicate: false });
      const spooled = await runtime.legacySpool('MON-ICU-01').entries();
      expect(spooled).toHaveLength(2);
      // Identity falls back to the MSH sending application while the backend
      // cannot resolve; drain-time ingest re-resolves authoritatively.
      expect(spooled[0]).toMatchObject({ device_code: 'MON-ICU-01', patient_uid: null });

      // A drain attempt during the outage keeps everything (5xx/unreachable
      // is retriable, never dead-lettered).
      await runtime.drainSource('MON-ICU-01');
      expect(await runtime.legacySpool('MON-ICU-01').entries()).toHaveLength(2);

      // Backend recovers: the buffered messages deliver in order.
      backendUp = true;
      await runtime.drainSource('MON-ICU-01');
      expect(ingested).toEqual(['CTRL-O1', 'CTRL-O2']);
      expect(await runtime.legacySpool('MON-ICU-01').entries()).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('still refuses on a definite backend 4xx (unknown/unauthorized device)', async () => {
    const backend = okBackend({
      resolveDevice: jest.fn(async () => {
        throw Object.assign(new Error('device auth refused'), { status: 403, code: 'DEVICE_AUTH_REFUSED' });
      }),
    });
    const { dir, runtime } = await tempRuntime(backend);
    try {
      const result = await runtime.acceptFrame({ listener: 'icu', sourceIp: '10.1.1.5', message: message('CTRL-O3') });
      expect(result.ackCode).toBe('AE');
      expect(await runtime.legacySpool('MON-ICU-01').entries()).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('supervised drains cover legacy spools even with zero I09 enrollments', async () => {
    const backend = okBackend();
    const { dir, runtime } = await tempRuntime(backend);
    try {
      await runtime.acceptFrame({ listener: 'icu', sourceIp: '10.1.1.5', message: message('CTRL-T1') });
      expect(await runtime.legacySpool('MON-ICU-01').entries()).toHaveLength(1);

      runtime.startSupervisedDrains(10);
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && (await runtime.legacySpool('MON-ICU-01').entries()).length > 0) {
        await sleep(10);
      }
      expect(await runtime.legacySpool('MON-ICU-01').entries()).toHaveLength(0);
      expect(backend.ingest).toHaveBeenCalledTimes(1);
    } finally {
      runtime.stopSupervisedDrains();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('drains spools left on disk by a previous process without waiting for a reconnect', async () => {
    const backend = okBackend();
    const { dir, runtime } = await tempRuntime(backend);
    try {
      await runtime.acceptFrame({ listener: 'icu', sourceIp: '10.1.1.5', message: message('CTRL-R1') });
      await runtime.acceptFrame({ listener: 'icu', sourceIp: '10.1.1.5', message: message('CTRL-R2') });

      // Simulate a crash/restart: a fresh runtime with an empty in-memory
      // spool map over the same spool directory. drainAllLegacy discovers the
      // on-disk spool and delivers it — the device does not have to
      // retransmit or even reconnect.
      const ingested = [];
      const restartedBackend = okBackend({
        ingest: jest.fn(async (payload) => {
          ingested.push(payload.message.match(/CTRL-R[0-9]/)[0]);
          return { ok: true };
        }),
      });
      const restarted = new GatewayRuntime({ spoolDir: dir, backendClient: restartedBackend });
      await restarted.drainAllLegacy();
      expect(ingested).toEqual(['CTRL-R1', 'CTRL-R2']);
      // Idempotent: a second pass has nothing left to deliver.
      await restarted.drainAllLegacy();
      expect(restartedBackend.ingest).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a device reconnecting after restart shares the discovered spool instance', async () => {
    const backend = okBackend();
    const { dir, runtime } = await tempRuntime(backend);
    try {
      await runtime.acceptFrame({ listener: 'icu', sourceIp: '10.1.1.5', message: message('CTRL-S1') });

      const restarted = new GatewayRuntime({ spoolDir: dir, backendClient: backend });
      await restarted.discoverLegacySpools();
      const discovered = [...restarted.legacySpools.values()];
      expect(discovered).toHaveLength(1);
      // The same NdjsonSpool object must back both the discovered ref and a
      // live re-accept under the source name — two instances on one file
      // would bypass the mutation mutex.
      expect(restarted.legacySpool('MON-ICU-01')).toBe(discovered[0]);
      expect(await restarted.legacySpool('MON-ICU-01').entries()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
