import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jest } from '@jest/globals';
import { NdjsonSpool } from '../src/spool.js';
import { GatewayRuntime } from '../src/gateway.js';
import { setLogSink } from '../src/logger.js';

async function tempSpool() {
  const dir = await mkdtemp(join(tmpdir(), 'vh-gw-spool-test-'));
  const spool = new NdjsonSpool({ dir, source: 'test-source' });
  return { dir, spool };
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

describe('NdjsonSpool mutation mutex (GW-L1)', () => {
  it('does not discard an append racing a remove (deterministic interleaving)', async () => {
    const { dir, spool } = await tempSpool();
    try {
      const first = await spool.append({ message: 'one' });
      // Force the hazardous window: remove() snapshots entries, then pauses
      // before its rewrite. Without the mutex, the append lands inside that
      // window and the rewrite silently discards it.
      const originalEntries = spool.entries.bind(spool);
      spool.entries = async () => {
        const snapshot = await originalEntries();
        await sleep(50);
        return snapshot;
      };
      const removal = spool.remove(first.id);
      await sleep(5); // let remove() enter its snapshot+pause window first
      const appended = spool.append({ message: 'two' });
      await Promise.all([removal, appended]);
      spool.entries = originalEntries;
      const remaining = await spool.entries();
      expect(remaining.map((entry) => entry.message)).toEqual(['two']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent removes without resurrecting removed entries', async () => {
    const { dir, spool } = await tempSpool();
    try {
      const a = await spool.append({ message: 'a' });
      const b = await spool.append({ message: 'b' });
      await spool.append({ message: 'c' });
      await Promise.all([spool.remove(a.id), spool.remove(b.id)]);
      const remaining = await spool.entries();
      expect(remaining.map((entry) => entry.message)).toEqual(['c']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serializes deadLetter against concurrent appends', async () => {
    const { dir, spool } = await tempSpool();
    try {
      const doomed = await spool.append({ message: 'doomed' });
      const originalEntries = spool.entries.bind(spool);
      spool.entries = async () => {
        const snapshot = await originalEntries();
        await sleep(50);
        return snapshot;
      };
      const dead = spool.deadLetter(doomed, 'test_reason');
      await sleep(5);
      const appended = spool.append({ message: 'kept' });
      await Promise.all([dead, appended]);
      spool.entries = originalEntries;
      const remaining = await spool.entries();
      expect(remaining.map((entry) => entry.message)).toEqual(['kept']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('quarantines a torn dead-letter tail before appending the next dead-letter entry', async () => {
    const { dir, spool } = await tempSpool();
    try {
      const doomed = await spool.append({ message: 'doomed' });
      // Simulate a crash mid-append to the dead-letter file: a partial JSON
      // line with no terminating newline. Before the fix deadLetter appended
      // straight onto the torn bytes, corrupting both evidence records.
      const tornBytes = '{"id":"dead-partial","reason":"trunc';
      await writeFile(spool.deadFile, tornBytes, { flag: 'a' });

      await spool.deadLetter(doomed, 'test_reason');

      // The new dead-letter entry is a clean, parseable line.
      const raw = await readFile(spool.deadFile, 'utf8');
      expect(raw.endsWith('\n')).toBe(true);
      const lines = raw.split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ id: doomed.id, reason: 'test_reason' });
      expect(await spool.entries()).toHaveLength(0);

      // The torn bytes were preserved verbatim as a sidecar evidence file,
      // exactly like the live spool's torn-tail handling.
      const evidenceNames = (await readdir(dir))
        .filter((name) => name.includes('.torn-tail.') && name.endsWith('.evidence'));
      expect(evidenceNames).toHaveLength(1);
      expect(evidenceNames[0].startsWith('test-source.dead.')).toBe(true);
      expect(await readFile(join(dir, evidenceNames[0]), 'utf8')).toBe(tornBytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('drainLegacySource failure labeling (GW-L1)', () => {
  const message = (id) => [
    `MSH|^~\\&|MON-ICU-01|ICU||VHHEALTH|20260707090000||ORU^R01|${id}|P|2.5`,
    'PID|1||aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa||NL7^Patient',
    'OBX|1|NM|8867-4^Heart rate||90|/min|||||F',
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

  async function seededRuntime(backend, ids = ['CTRL-1']) {
    const dir = await mkdtemp(join(tmpdir(), 'vh-gw-drain-test-'));
    const runtime = new GatewayRuntime({ spoolDir: dir, backendClient: backend, allowLegacy: true });
    for (const id of ids) {
      await runtime.acceptFrame({ listener: 'icu', sourceIp: '10.1.1.5', message: message(id) });
    }
    return { dir, runtime };
  }

  it('labels a statusless non-timeout error backend_unreachable, not backend_timeout', async () => {
    const backend = {
      resolveDevice: jest.fn(async () => ({ device: { device_code: 'MON-ICU-01' } })),
      ingest: jest.fn(async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      }),
    };
    const { dir, runtime } = await seededRuntime(backend);
    try {
      await runtime.drainLegacySource('MON-ICU-01');
      const logged = entries.find((entry) => entry.event === 'legacy_drain_delivery_failed');
      expect(logged).toMatchObject({ reason: 'backend_unreachable' });
      expect(await runtime.legacySpool('MON-ICU-01').entries()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('labels timeout-coded errors backend_timeout', async () => {
    const backend = {
      resolveDevice: jest.fn(async () => ({ device: { device_code: 'MON-ICU-01' } })),
      ingest: jest.fn(async () => {
        throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
      }),
    };
    const { dir, runtime } = await seededRuntime(backend);
    try {
      await runtime.drainLegacySource('MON-ICU-01');
      const logged = entries.find((entry) => entry.event === 'legacy_drain_delivery_failed');
      expect(logged).toMatchObject({ reason: 'backend_timeout', error_code: 'ETIMEDOUT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('labels a post-ingest remove failure as spool_remove_failed and stops the pass', async () => {
    const backend = {
      resolveDevice: jest.fn(async () => ({ device: { device_code: 'MON-ICU-01' } })),
      ingest: jest.fn(async () => ({ ok: true })),
    };
    const { dir, runtime } = await seededRuntime(backend, ['CTRL-1', 'CTRL-2']);
    try {
      const spool = runtime.legacySpool('MON-ICU-01');
      const originalRemove = spool.remove.bind(spool);
      spool.remove = jest.fn(async () => {
        throw Object.assign(new Error('disk fault'), { code: 'EIO' });
      });
      await runtime.drainLegacySource('MON-ICU-01');
      // Ingest succeeded exactly once; the failed remove stopped the pass so
      // the second entry was not delivered with a broken spool.
      expect(backend.ingest).toHaveBeenCalledTimes(1);
      const logged = entries.find((entry) => entry.event === 'legacy_spool_remove_failed');
      expect(logged).toMatchObject({ level: 'error', error_code: 'EIO' });
      expect(entries.find((entry) => entry.event === 'legacy_drain_delivery_failed')).toBeUndefined();
      expect(await spool.entries()).toHaveLength(2);
      // Once the spool recovers, the next drain pass completes.
      spool.remove = originalRemove;
      await runtime.drainLegacySource('MON-ICU-01');
      expect(await spool.entries()).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
