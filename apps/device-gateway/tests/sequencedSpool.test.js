import { createHash } from 'node:crypto';
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import {
  I09_GATEWAY_SEQUENCE_CONTRACT,
  SequencedSpoolStore,
  assertResumeState,
  i09DuplicateKey,
} from '../src/spool.js';
import {
  accept,
  enrollment,
  message,
  partition,
  recoveryRuntime,
  resumeState,
  statefulBackend,
} from './recoveryTestHelpers.js';

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

async function rewriteJournal(spool, mutate) {
  const events = (await readFile(spool.journalFile, 'utf8')).trim().split('\n').map(JSON.parse);
  mutate(events);
  let previous = '0'.repeat(64);
  const rewritten = events.map((original, index) => {
    const { event_hash: _hash, event_index: _index, previous_event_hash: _previous, ...body } = original;
    const base = { event_index: index + 1, previous_event_hash: previous, ...body };
    const event = { ...base, event_hash: hash(Buffer.from(canonicalJson(base), 'utf8')) };
    previous = event.event_hash;
    return event;
  });
  await writeFile(spool.journalFile, `${rewritten.map(canonicalJson).join('\n')}\n`, 'utf8');
}

function resealRecord(record) {
  const { record_checksum: _checksum, ...body } = record;
  return { ...body, record_checksum: hash(Buffer.from(canonicalJson(body), 'utf8')) };
}

describe('I09 durable sequenced spool integrity', () => {
  it('pins the backend-compatible duplicate digest and rejects resume contract drift', () => {
    expect(i09DuplicateKey({
      tenantId: '11111111-1111-4111-8111-111111111111',
      deviceRegistryId: 42,
      msh10: 'MSG-001',
    })).toBe('991f87c0783f2f4b19850de0d952198307c3b1270b7fed6ef7e660711cee17eb');
    expect(() => assertResumeState({ ...resumeState(), invented_field: true }))
      .toThrow('resume-state contract fields differ');
    expect(() => assertResumeState({ ...resumeState(), contract: `${I09_GATEWAY_SEQUENCE_CONTRACT}-future` }))
      .toThrow('contract or interface family differs');
  });

  it('keeps local-ahead evidence without inventing HWM and blocks backend-ahead, token mismatch, and regression', async () => {
    const backend = statefulBackend();
    const fixture = await recoveryRuntime({ backend });
    try {
      await accept(fixture.runtime, message('CHAIN-1'));
      const spool = partition(fixture.runtime);
      expect(spool.manifest).toMatchObject({
        head_position: '1',
        backend_high_water_position: '0',
        local_reconciliation_state: null,
      });

      backend.state = { ...backend.state, high_water_position: '1', high_water_token: 'wrong-token' };
      await fixture.runtime.drainPartition(fixture.runtime.enrollments[0]);
      expect(spool.manifest.local_reconciliation_reason).toBe('backend_token_mismatch');
    } finally {
      await fixture.cleanup();
    }

    const aheadBackend = statefulBackend();
    const ahead = await recoveryRuntime({ backend: aheadBackend });
    try {
      aheadBackend.state = { ...aheadBackend.state, high_water_position: '2', high_water_token: 'unknown-ahead' };
      await ahead.runtime.drainPartition(ahead.runtime.enrollments[0]);
      expect(partition(ahead.runtime).manifest.local_reconciliation_reason).toBe('backend_ahead');
    } finally {
      await ahead.cleanup();
    }

    const regressedBackend = statefulBackend(resumeState({ highWaterPosition: '5', highWaterToken: 'token-5' }));
    const regressed = await recoveryRuntime({ backend: regressedBackend });
    try {
      regressedBackend.state = { ...regressedBackend.state, high_water_position: '4', high_water_token: 'token-4' };
      await regressed.runtime.drainPartition(regressed.runtime.enrollments[0]);
      expect(partition(regressed.runtime).manifest.local_reconciliation_state)
        .toBe('reconciliation_required_source_gap');
    } finally {
      await regressed.cleanup();
    }
  });

  it('detects predecessor gaps and a corrupted middle record', async () => {
    const fixture = await recoveryRuntime();
    try {
      await accept(fixture.runtime, message('GAP-1'));
      await accept(fixture.runtime, message('GAP-2'));
      const spool = partition(fixture.runtime);
      await rewriteJournal(spool, (events) => {
        const second = events.find((event) => event.type === 'accepted' && event.record.source_position === '2');
        second.record = resealRecord({ ...second.record, predecessor_token: 'invented-predecessor' });
      });
      await expect(recoveryRuntime({ dir: fixture.dir, backend: fixture.backend }))
        .rejects.toMatchObject({ code: 'SPOOL_CHAIN_CORRUPT' });
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }

    const corrupt = await recoveryRuntime();
    try {
      await accept(corrupt.runtime, message('CORRUPT-1'));
      await accept(corrupt.runtime, message('CORRUPT-2'));
      const spool = partition(corrupt.runtime);
      const raw = await readFile(spool.journalFile, 'utf8');
      await writeFile(spool.journalFile, raw.replace('CORRUPT-1', 'CORRUPT-X'), 'utf8');
      await expect(recoveryRuntime({ dir: corrupt.dir, backend: corrupt.backend }))
        .rejects.toMatchObject({ code: 'SPOOL_JOURNAL_CORRUPT' });
    } finally {
      await rm(corrupt.dir, { recursive: true, force: true });
    }
  });

  it('holds torn tails, refuses a missing manifest, and detects receipt/payload disagreement', async () => {
    const torn = await recoveryRuntime();
    try {
      await accept(torn.runtime, message('TORN-1'));
      await appendFile(partition(torn.runtime).journalFile, '{"partial":');
      const restarted = await recoveryRuntime({ dir: torn.dir, backend: torn.backend });
      expect(partition(restarted.runtime).manifest).toMatchObject({
        local_reconciliation_state: 'reconciliation_required_retention_gap',
        local_reconciliation_reason: 'torn_tail',
      });
    } finally {
      await rm(torn.dir, { recursive: true, force: true });
    }

    const missing = await recoveryRuntime();
    try {
      await accept(missing.runtime, message('MISSING-MANIFEST'));
      await rm(partition(missing.runtime).manifestFile);
      await expect(recoveryRuntime({ dir: missing.dir, backend: missing.backend }))
        .rejects.toMatchObject({ code: 'RECOVERY_MARKER_MISSING' });
    } finally {
      await rm(missing.dir, { recursive: true, force: true });
    }

    const disagreement = await recoveryRuntime();
    try {
      await accept(disagreement.runtime, message('RECEIPT-MISMATCH'));
      const spool = partition(disagreement.runtime);
      await rewriteJournal(spool, (events) => {
        const accepted = events.find((event) => event.type === 'accepted');
        accepted.record = resealRecord({ ...accepted.record, message_b64: null, payload_state: 'present' });
      });
      await expect(recoveryRuntime({ dir: disagreement.dir, backend: disagreement.backend }))
        .rejects.toMatchObject({ code: 'SPOOL_RECEIPT_PAYLOAD_MISMATCH' });
    } finally {
      await rm(disagreement.dir, { recursive: true, force: true });
    }
  });

  it('appends the torn-tail reconciliation event exactly once across repeated drain ticks', async () => {
    const torn = await recoveryRuntime();
    try {
      await accept(torn.runtime, message('TORN-ONCE-1'));
      await appendFile(partition(torn.runtime).journalFile, '{"partial":');
      const restarted = await recoveryRuntime({ dir: torn.dir, backend: torn.backend });
      const spool = partition(restarted.runtime);

      // The drain supervisor re-observes resume state on every tick, before
      // the held-state early-return. Before the fix the in-memory tornTail
      // flag was never reset and the repair append had no dedupe, so every
      // tick appended another fsynced torn_tail reconciliation event forever.
      await restarted.runtime.drainPartition(restarted.runtime.enrollments[0]);
      await restarted.runtime.drainPartition(restarted.runtime.enrollments[0]);
      const events = (await readFile(spool.journalFile, 'utf8')).trim().split('\n').map(JSON.parse);
      expect(events.filter((event) => event.type === 'reconciliation')).toHaveLength(1);
      expect(spool.manifest).toMatchObject({
        local_reconciliation_state: 'reconciliation_required_retention_gap',
        local_reconciliation_reason: 'torn_tail',
      });
      // A clean re-load resets the in-memory flag.
      expect(spool.tornTail).toBe(false);

      // A second torn incident while the partition is already held for
      // torn_tail dedupes the same way block() does: quarantined, no
      // duplicate reconciliation event.
      await appendFile(spool.journalFile, '{"partial-again":');
      await restarted.runtime.drainPartition(restarted.runtime.enrollments[0]);
      const after = (await readFile(spool.journalFile, 'utf8')).trim().split('\n').map(JSON.parse);
      expect(after.filter((event) => event.type === 'reconciliation')).toHaveLength(1);
    } finally {
      await rm(torn.dir, { recursive: true, force: true });
    }
  });

  it('refuses a restored foreign PVC and generation mismatch', async () => {
    const fixture = await recoveryRuntime();
    try {
      await accept(fixture.runtime, message('FOREIGN-1'));
      fixture.backend.state = { ...fixture.backend.state, generation: 2 };
      await expect(recoveryRuntime({ dir: fixture.dir, backend: fixture.backend }))
        .rejects.toMatchObject({ code: 'FOREIGN_PVC_REFUSED' });
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('never wraps PostgreSQL BIGINT positions and holds retirement for owner action', async () => {
    const backend = statefulBackend(resumeState({
      highWaterPosition: '9223372036854775807',
      highWaterToken: 'position-space-tail',
    }));
    const fixture = await recoveryRuntime({ backend });
    try {
      expect(await accept(fixture.runtime, message('POSITION-EXHAUSTED')))
        .toMatchObject({ ackCode: 'AE', errorCode: 'SOURCE_POSITION_EXHAUSTED' });
      expect(partition(fixture.runtime).manifest).toMatchObject({
        head_position: '9223372036854775807',
        local_reconciliation_state: 'reconciliation_required_source_gap',
        local_reconciliation_reason: 'source_position_exhausted',
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('records a durable non-payload gap at the partition hard cap without allocating a position or dropping old data', async () => {
    const configured = enrollment({ partitionCapacity: 7000, globalCapacity: 100000 });
    const fixture = await recoveryRuntime({ enrollments: [configured] });
    try {
      expect((await accept(fixture.runtime, message('CAP-1'))).ackCode).toBe('AA');
      const spool = partition(fixture.runtime);
      const before = spool.manifest.head_position;
      const refused = await accept(fixture.runtime, message('CAP-2', { note: 'X'.repeat(10000) }));
      expect(refused.ackCode).toBe('AR');
      expect(spool.manifest.head_position).toBe(before);
      expect(spool.state.accepted.size).toBe(1);
      expect(spool.state.gaps).toHaveLength(1);
      expect(spool.state.gaps[0]).toMatchObject({
        reason: 'capacity_refusal', scope: 'partition', msh10: 'CAP-2',
      });
      const journal = await readFile(spool.journalFile, 'utf8');
      expect(journal).not.toContain('X'.repeat(100));
    } finally {
      await fixture.cleanup();
    }
  });

  it('enforces one gateway-wide hard cap across independently locked partitions', async () => {
    const first = enrollment({
      listener: 'icu-a', deviceId: 42, deviceCode: 'MON-A', sourceIp: '10.1.1.5',
      partitionCapacity: 50000, globalCapacity: 12000,
    });
    const second = enrollment({
      listener: 'icu-b', deviceId: 43, deviceCode: 'MON-B', sourceIp: '10.1.1.6',
      partitionCapacity: 50000, globalCapacity: 12000,
    });
    const backend = statefulBackend();
    backend.readI09ResumeState = async ({ gatewayRegistryId, deviceRegistryId }) => resumeState({
      gatewayId: gatewayRegistryId,
      deviceId: deviceRegistryId,
    });
    backend.resolveDevice = async ({ device_code: deviceCode }) => ({
      device: { id: deviceCode === 'MON-A' ? 42 : 43, device_code: deviceCode },
    });
    const fixture = await recoveryRuntime({ backend, enrollments: [first, second] });
    try {
      const results = await Promise.all([
        accept(
          fixture.runtime,
          message('GLOBAL-1', { app: 'MON-A', note: 'A'.repeat(4000) }),
          { listener: 'icu-a', sourceIp: '10.1.1.5' },
        ),
        accept(
          fixture.runtime,
          message('GLOBAL-2', { app: 'MON-B', note: 'B'.repeat(4000) }),
          { listener: 'icu-b', sourceIp: '10.1.1.6' },
        ),
      ]);
      expect(results.map((result) => result.ackCode).sort()).toEqual(['AA', 'AR']);
      const partitions = [partition(fixture.runtime, 0), partition(fixture.runtime, 1)];
      expect(partitions.reduce((sum, item) => sum + item.state.accepted.size, 0)).toBe(1);
      expect(partitions.reduce((sum, item) => sum + item.state.gaps.length, 0)).toBe(1);
      expect(partitions.flatMap((item) => item.state.gaps)[0].scope).toBe('global');
    } finally {
      await fixture.cleanup();
    }
  });

  it('returns AE and removes readiness when even reserved gap evidence cannot commit', async () => {
    const configured = enrollment({
      partitionCapacity: 50000,
      globalCapacity: 1,
      gapReserve: 1,
    });
    const fixture = await recoveryRuntime({ enrollments: [configured] });
    try {
      const result = await accept(fixture.runtime, message('NO-GAP-SPACE'));
      expect(result).toMatchObject({
        ackCode: 'AE',
        errorCode: 'SPOOL_GAP_RESERVE_EXHAUSTED',
      });
      expect(fixture.runtime.isReady()).toBe(false);
      expect(partition(fixture.runtime).state.accepted.size).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps replacement gateway and device partitions separate while old backlog remains', async () => {
    const old = await recoveryRuntime();
    try {
      await accept(old.runtime, message('OLD-BACKLOG'));
      const replacementEnrollment = enrollment({
        gatewayId: 51,
        deviceId: 52,
        deviceCode: 'MON-NEW',
        sourceIp: '10.1.1.9',
      });
      const replacementBackend = statefulBackend(resumeState({ gatewayId: 51, deviceId: 52 }));
      replacementBackend.resolveDevice = async () => ({
        device: { id: 52, device_code: 'MON-NEW' },
      });
      const replacement = await recoveryRuntime({
        dir: old.dir,
        backend: replacementBackend,
        enrollments: [replacementEnrollment],
      });
      const next = await accept(
        replacement.runtime,
        message('NEW-BACKLOG', { app: 'MON-NEW' }),
        { sourceIp: '10.1.1.9' },
      );
      expect(next.ackCode).toBe('AA');
      expect(partition(old.runtime).state.accepted.size).toBe(1);
      expect(partition(replacement.runtime).state.accepted.size).toBe(1);
      expect(partition(old.runtime).dir).not.toBe(partition(replacement.runtime).dir);
    } finally {
      await rm(old.dir, { recursive: true, force: true });
    }
  });

  it('requires explicit capacity inputs before a sequenced store can exist', () => {
    expect(() => new SequencedSpoolStore({ rootDir: 'held', globalMaxBytes: 0 }))
      .toThrow('globalMaxBytes must be a positive integer');
  });
});
