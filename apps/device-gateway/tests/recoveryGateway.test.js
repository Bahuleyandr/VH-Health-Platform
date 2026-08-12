import { readFile, rm } from 'node:fs/promises';
import { serializeMetrics } from '../src/metrics.js';
import {
  PATIENT_UID,
  accept,
  authorizeReplay,
  message,
  partition,
  recoveryRuntime,
  resumeState,
  statefulBackend,
  trustedClock,
} from './recoveryTestHelpers.js';

describe('I09 sequenced gateway crash and recovery behavior', () => {
  it('proves crash before append leaves no receipt and no AA', async () => {
    const fixture = await recoveryRuntime({
      stageHook: async (stage) => {
        if (stage === 'before_append') throw Object.assign(new Error('synthetic crash'), { code: 'SYNTHETIC_CRASH' });
      },
    });
    try {
      const result = await accept(fixture.runtime, message('CRASH-BEFORE'));
      expect(result.ackCode).toBe('AE');
      expect(partition(fixture.runtime).state.accepted.size).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(['after_journal_before_checkpoint', 'after_commit_before_ack'])(
    'recovers a durable duplicate after crash at %s',
    async (crashStage) => {
      const fixture = await recoveryRuntime({
        stageHook: async (stage) => {
          if (stage === crashStage) throw Object.assign(new Error('synthetic crash'), { code: 'SYNTHETIC_CRASH' });
        },
      });
      try {
        const first = await accept(fixture.runtime, message(`CRASH-${crashStage}`));
        expect(first.ackCode).toBe('AE');
        const restarted = await recoveryRuntime({ dir: fixture.dir, backend: fixture.backend });
        const retry = await accept(restarted.runtime, message(`CRASH-${crashStage}`));
        expect(retry).toMatchObject({ ackCode: 'AA', duplicate: true });
        expect(partition(restarted.runtime).state.accepted.size).toBe(1);
      } finally {
        await rm(fixture.dir, { recursive: true, force: true });
      }
    },
  );

  it('deduplicates after AA and after receipt-only compaction across restart', async () => {
    const fixture = await recoveryRuntime();
    try {
      expect((await accept(fixture.runtime, message('ACKED-1'))).ackCode).toBe('AA');
      let restarted = await recoveryRuntime({ dir: fixture.dir, backend: fixture.backend });
      expect(await accept(restarted.runtime, message('ACKED-1'))).toMatchObject({ ackCode: 'AA', duplicate: true });

      const spool = partition(restarted.runtime);
      authorizeReplay(fixture.backend, spool);
      await restarted.runtime.drainPartition(restarted.runtime.enrollments[0]);
      expect(spool.recordAt('1')).toMatchObject({ payload_state: 'compacted', message_b64: null });

      restarted = await recoveryRuntime({ dir: fixture.dir, backend: fixture.backend });
      expect(await accept(restarted.runtime, message('ACKED-1'))).toMatchObject({ ackCode: 'AA', duplicate: true });
      expect(partition(restarted.runtime).state.accepted.size).toBe(1);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('settles backend commit with a lost response from authoritative HWM', async () => {
    const backend = statefulBackend();
    const fixture = await recoveryRuntime({ backend });
    try {
      await accept(fixture.runtime, message('LOST-RESPONSE'));
      const spool = partition(fixture.runtime);
      authorizeReplay(backend, spool);
      backend.ingestBehavior = async (payload, target) => {
        target.state.high_water_position = payload.recovery.source_position;
        target.state.high_water_token = payload.recovery.source_token;
        target.state.recovery_state = 'ready';
        throw Object.assign(new Error('socket closed after commit'), { code: 'ECONNRESET', ambiguous: true });
      };
      await fixture.runtime.drainPartition(fixture.runtime.enrollments[0]);
      expect(spool.recordAt('1')).toMatchObject({ payload_state: 'compacted' });
      expect(backend.ingested).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    ['timeout', Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })],
    ['5xx', Object.assign(new Error('unavailable'), { status: 503, code: 'UPSTREAM_UNAVAILABLE' })],
  ])('keeps the head pending after backend %s without bypass', async (_label, failure) => {
    const backend = statefulBackend();
    const fixture = await recoveryRuntime({ backend });
    try {
      await accept(fixture.runtime, message('FAIL-1'));
      await accept(fixture.runtime, message('FAIL-2'));
      const spool = partition(fixture.runtime);
      authorizeReplay(backend, spool);
      backend.ingestBehavior = async () => { throw failure; };
      await fixture.runtime.drainPartition(fixture.runtime.enrollments[0]);
      expect(backend.ingested.map((payload) => payload.recovery.source_position)).toEqual(['1']);
      expect(spool.pendingAfter('0').map((record) => record.source_position)).toEqual(['1', '2']);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps a 4xx item and chain in place and blocks every later item', async () => {
    const backend = statefulBackend();
    const fixture = await recoveryRuntime({ backend });
    try {
      await accept(fixture.runtime, message('REFUSE-1'));
      await accept(fixture.runtime, message('REFUSE-2'));
      const spool = partition(fixture.runtime);
      authorizeReplay(backend, spool);
      backend.ingestBehavior = async () => {
        throw Object.assign(new Error('closed envelope refused'), {
          status: 409,
          code: 'EXTERNAL_RECOVERY_ENVELOPE_REFUSED',
        });
      };
      await fixture.runtime.drainPartition(fixture.runtime.enrollments[0]);
      expect(backend.ingested).toHaveLength(1);
      expect(spool.manifest.local_reconciliation_state).toBe('reconciliation_required_source_gap');
      expect(spool.state.accepted.size).toBe(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts trusted clock evidence but refuses skewed, absent, and ambiguous evidence without ordering by time', async () => {
    const cases = [
      [null, 'CLOCK_EVIDENCE_ABSENT'],
      [{ ...trustedClock(), offset_ms: 5000 }, 'CLOCK_EVIDENCE_SKEWED'],
      [{ ...trustedClock(), status: 'unknown' }, 'CLOCK_EVIDENCE_AMBIGUOUS'],
    ];
    const trusted = await recoveryRuntime();
    try {
      expect((await accept(trusted.runtime, message('CLOCK-OK'))).ackCode).toBe('AA');
      expect(partition(trusted.runtime).recordAt('1').source_occurred_at_raw).toBe('20260731123000+0530');
    } finally {
      await trusted.cleanup();
    }
    for (const [evidence, code] of cases) {
      const fixture = await recoveryRuntime({ clockEvidenceProvider: async () => evidence });
      try {
        const result = await accept(fixture.runtime, message(`CLOCK-${code}`));
        expect(result).toMatchObject({ ackCode: 'AE', errorCode: code });
        expect(partition(fixture.runtime).state.accepted.size).toBe(0);
        expect(partition(fixture.runtime).state.gaps).toHaveLength(1);
        expect(partition(fixture.runtime).manifest.local_reconciliation_state)
          .toBe('reconciliation_required_source_gap');
      } finally {
        await fixture.cleanup();
      }
    }
    const ambiguousSource = await recoveryRuntime();
    try {
      expect(await accept(ambiguousSource.runtime, message('CLOCK-SOURCE', { occurrence: '' })))
        .toMatchObject({ ackCode: 'AE', errorCode: 'SOURCE_TIME_AMBIGUOUS' });
    } finally {
      await ambiguousSource.cleanup();
    }
  });

  it('keeps an enrolled source from widening a legacy source during mixed rollout', async () => {
    const backend = statefulBackend();
    const fixture = await recoveryRuntime({ backend, allowLegacy: true });
    try {
      const enrolled = await accept(fixture.runtime, message('MIXED-ENROLLED'));
      const wrongSource = await accept(
        fixture.runtime,
        message('MIXED-WRONG', { app: 'UNENROLLED' }),
      );
      const legacy = await fixture.runtime.acceptFrame({
        listener: 'legacy',
        sourceIp: '10.2.2.5',
        message: message('MIXED-LEGACY', { app: 'LEGACY-MON' }),
      });
      expect(enrolled.ackCode).toBe('AA');
      expect(wrongSource.ackCode).toBe('AE');
      expect(legacy.ackCode).toBe('AA');
      expect(partition(fixture.runtime).state.accepted.size).toBe(1);
      expect(fixture.runtime.legacySpool('LEGACY-MON').entries()).resolves.toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses rotated gateway credentials without persisting either credential and keeps device identities partitioned', async () => {
    const backend = statefulBackend();
    const fixture = await recoveryRuntime({ backend });
    try {
      backend.token = 'old-jwt';
      backend.apiKey = 'old-api-key';
      await accept(fixture.runtime, message('ROTATE-1'));
      backend.token = 'new-jwt';
      backend.apiKey = 'new-api-key';
      await accept(fixture.runtime, message('ROTATE-2'));
      const journal = await readFile(partition(fixture.runtime).journalFile, 'utf8');
      expect(journal).not.toContain('old-jwt');
      expect(journal).not.toContain('new-jwt');
      expect(journal).not.toContain('api-key');
      expect(journal).toContain('"device_registry_id":42');
    } finally {
      await fixture.cleanup();
    }
  });

  it('re-resolves after device credential/registry rotation and refuses an identity change before AA', async () => {
    const backend = statefulBackend();
    let resolvedId = 42;
    let resolutions = 0;
    backend.resolveDevice = async () => {
      resolutions += 1;
      return { device: { id: resolvedId, device_code: resolvedId === 42 ? 'MON-7' : 'MON-ROTATED' } };
    };
    const fixture = await recoveryRuntime({ backend });
    try {
      expect((await accept(fixture.runtime, message('DEVICE-CREDENTIAL-1'))).ackCode).toBe('AA');
      resolvedId = 99;
      expect(await accept(fixture.runtime, message('DEVICE-CREDENTIAL-2')))
        .toMatchObject({ ackCode: 'AE', errorCode: 'SOURCE_IDENTITY_CHANGED' });
      expect(resolutions).toBe(2);
      expect(partition(fixture.runtime).state.accepted.size).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('continues durable spool-only acceptance through gateway credential rotation but not device revocation', async () => {
    const backend = statefulBackend();
    const fixture = await recoveryRuntime({ backend });
    try {
      backend.resolveDevice = async () => {
        throw Object.assign(new Error('gateway JWT expired'), { status: 401, code: 'TOKEN_EXPIRED' });
      };
      expect((await accept(fixture.runtime, message('GATEWAY-ROTATION'))).ackCode).toBe('AA');

      backend.resolveDevice = async () => {
        throw Object.assign(new Error('device revoked'), { status: 403, code: 'DEVICE_AUTH_REFUSED' });
      };
      expect(await accept(fixture.runtime, message('DEVICE-REVOKED')))
        .toMatchObject({ ackCode: 'AE', errorCode: 'DEVICE_AUTH_REFUSED' });
      expect(partition(fixture.runtime).state.accepted.size).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('emits only opaque non-PHI metrics and completes recovery only from ready plus matching HWM/cutoff', async () => {
    const backend = statefulBackend(resumeState());
    const fixture = await recoveryRuntime({ backend });
    try {
      await accept(fixture.runtime, message('PHI-MSH10', { note: 'Patient Secret' }));
      const spool = partition(fixture.runtime);
      authorizeReplay(backend, spool);
      await fixture.runtime.drainPartition(fixture.runtime.enrollments[0]);
      const metrics = serializeMetrics();
      expect(Object.keys(backend.ingested[0]).sort()).toEqual([
        'channel', 'device_code', 'message', 'patient_uid', 'recovery',
      ]);
      expect(Object.keys(backend.ingested[0].recovery)).toEqual([
        'schema', 'interface_family', 'arrival_class', 'tenant_id',
        'gateway_registry_id', 'device_registry_id', 'offset_id',
        'source_partition', 'generation', 'source_position', 'source_token',
        'predecessor_token', 'msh10', 'duplicate_key', 'message_sha256',
        'gateway_received_at', 'clock_evidence',
      ]);
      expect(backend.ingested[0].recovery.arrival_class).toBe('recovery_backlog');
      expect(metrics).not.toContain(PATIENT_UID);
      expect(metrics).not.toContain('PHI-MSH10');
      expect(metrics).not.toContain('Patient Secret');
      expect(backend.state).toMatchObject({
        recovery_state: 'ready',
        high_water_position: backend.state.resume_cutoff_position,
        high_water_token: backend.state.resume_cutoff_token,
      });
      expect(metrics).toContain('gateway_recovery_complete');
    } finally {
      await fixture.cleanup();
    }
  });
});
