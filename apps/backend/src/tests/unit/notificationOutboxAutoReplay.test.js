// src/tests/unit/notificationOutboxAutoReplay.test.js
//
// Bounded auto-replay sweep over notification_outbox RECONCILIATION_REQUIRED
// rows (audit MEDIUM follow-up to F7/F11; migration 690). The sweep must:
//   * requeue eligible rows as NEW intents through the audited operator
//     requeue mechanism (never re-send the row itself — mig-609 contract),
//     with an `:auto-replay:` source-key suffix and replay_generation + 1;
//   * stamp superseded originals with the exact string
//     'operator_replay_superseded' (four ordering predicates hardcode it);
//   * respect the generation bound, the 30-minute backoff, and the 24-hour
//     age ceiling in its selection predicate — and never touch SUPPRESSED;
//   * stamp newly-terminal chains 'auto_replay_exhausted' exactly once and
//     alert (logger.error + auto_replay_total{outcome="exhausted"}).
import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';

const queryRawMock = jest.fn();
const execRawMock = jest.fn();
const setTenantTxMock = jest.fn(async (_tenantId, fn) => fn({
  $queryRawUnsafe: queryRawMock,
  $executeRawUnsafe: execRawMock,
}));
const queueMock = jest.fn();
const recordAutoReplayMock = jest.fn();
const loggerErrorMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: setTenantTxMock,
}));
jest.unstable_mockModule('../../observability/reliabilityMetrics.js', () => ({
  recordOutboxOperatorRedrive: jest.fn(),
  recordNotificationOutboxAutoReplay: recordAutoReplayMock,
}));
jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  notificationOutbox: { queue: queueMock },
}));
jest.unstable_mockModule('../../services/notification/notificationDeliveryLedgerService.js', () => ({
  recordProviderReceiptTx: jest.fn(),
  applyProviderReceiptToCursorTx: jest.fn(),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: loggerErrorMock,
    debug: jest.fn(),
  },
}));

const { autoReplayReconciliationRequiredRows } = await import(
  '../../services/notification/notificationOutboxAdminService.js'
);

function candidateRow(overrides = {}) {
  return {
    id: 41,
    type: 'push',
    channel: 'push',
    recipient_id: '42',
    recipient_phone: null,
    title: 'Critical result still needs review',
    body: 'body',
    payload: { key: 'value' },
    source_event_key: 'workflow-escalation:77:5:42',
    template_version: 'critical-result.v1',
    retry_count: 1,
    created_at: new Date('2026-08-17T05:00:00.000Z'),
    failure_reason: 'provider_delivery_outcome_uncertain',
    replay_generation: 0,
    ...overrides,
  };
}

function mockEligibleReplay(row, {
  attempts = [{ channel: 'push', outcome: 'uncertain' }],
  cursors = [{ channel: 'push' }],
} = {}) {
  queryRawMock
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([row])
    .mockResolvedValueOnce(attempts)
    .mockResolvedValueOnce(cursors)
    .mockResolvedValueOnce([{
      id: row.id,
      status: 'RECONCILIATION_REQUIRED',
      retry_count: row.retry_count,
      failure_reason: 'operator_replay_superseded',
    }])
    .mockResolvedValueOnce([]);
  execRawMock.mockResolvedValueOnce(cursors.length);
}

beforeEach(() => {
  jest.clearAllMocks();
  queryRawMock.mockReset();
  execRawMock.mockReset();
  queueMock.mockReset();
  queueMock.mockResolvedValue({ id: 777, duplicate: false });
});

describe('notification outbox bounded auto-replay sweep', () => {
  test('requeues an eligible row as a new intent and stamps the original superseded', async () => {
    queryRawMock
      .mockResolvedValueOnce([]) // exhausted stamp: none
      .mockResolvedValueOnce([candidateRow()]) // candidates
      .mockResolvedValueOnce([{ channel: 'push', outcome: 'uncertain' }]) // latest channel outcome
      .mockResolvedValueOnce([{ channel: 'push' }]) // cursor paused on the original
      .mockResolvedValueOnce([{ // superseded stamp on the original
        id: 41, status: 'RECONCILIATION_REQUIRED', retry_count: 1,
        failure_reason: 'operator_replay_superseded',
      }])
      .mockResolvedValueOnce([]); // audit insert
    execRawMock.mockResolvedValue(1); // cursor resume

    const result = await autoReplayReconciliationRequiredRows({ tenantId: TENANT, limit: 25 });

    expect(result).toMatchObject({
      tenant_id: TENANT,
      requeued: 1,
      exhausted: 0,
      replacements: [{ id: 41, replacement_id: 777 }],
    });

    // Requeue is a NEW intent: distinct :auto-replay: marker, generation + 1,
    // strict tx queueing — never a status change on the original row.
    expect(queueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        type: 'push',
        channel: 'push',
        recipientId: '42',
        sourceEventKey: expect.stringMatching(
          /^workflow-escalation:77:5:42:auto-replay:41:[0-9a-f]{64}$/,
        ),
        templateVersion: 'critical-result.v1',
        data: expect.objectContaining({
          key: 'value',
          __replay_chain_started_at_ms: Date.parse('2026-08-17T05:00:00.000Z'),
        }),
        deliveryChannels: ['push'],
      }),
      expect.objectContaining({ strict: true, replayGeneration: 1 }),
    );

    // Original stamped with the EXACT reason the ordering predicates hardcode.
    const stampCall = queryRawMock.mock.calls[4];
    expect(stampCall[0]).toMatch(/SET failure_reason = \$3::text/);
    expect(stampCall[0]).toMatch(/AND status = 'RECONCILIATION_REQUIRED'/);
    expect(stampCall.slice(1)).toEqual([TENANT, 41, 'operator_replay_superseded']);

    // A cursor paused ON the original is resumed in the same transaction.
    expect(execRawMock).toHaveBeenCalledWith(
      expect.stringMatching(/SET state = 'ready'/),
      TENANT, 41,
    );

    // System-actor audit provenance: NULL uid, sweep sentinel, recorded
    // duplicate-delivery risk and replacement id.
    const auditCall = queryRawMock.mock.calls[5];
    expect(auditCall[0]).toMatch(/NOTIFICATION_OUTBOX_AUTO_REPLAYED/);
    expect(auditCall[0]).toMatch(/VALUES \(\$1::uuid, NULL, 'system'/);
    const metadata = JSON.parse(auditCall[3]);
    expect(metadata).toMatchObject({
      actor: 'system:auto-replay-sweep',
      prior_failure_reason: 'provider_delivery_outcome_uncertain',
      replacement_outbox_id: 777,
      replay_generation: 1,
      duplicate_delivery_risk_accepted: true,
      replay_channels: ['push'],
    });

    expect(recordAutoReplayMock).toHaveBeenCalledWith('requeued', 1);
    expect(recordAutoReplayMock).toHaveBeenCalledWith('exhausted', 0);
    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  test('replays only the uncertain channel and resumes the cursor actually blocked on the row', async () => {
    const sourceEventKey = 'm'.repeat(255);
    queryRawMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([candidateRow({
        channel: 'push',
        source_event_key: sourceEventKey,
      })])
      .mockResolvedValueOnce([
        { channel: 'push', outcome: 'acknowledged' },
        { channel: 'sms', outcome: 'uncertain' },
      ])
      .mockResolvedValueOnce([{ channel: 'sms' }])
      .mockResolvedValueOnce([{
        id: 41, status: 'RECONCILIATION_REQUIRED', retry_count: 1,
        failure_reason: 'operator_replay_superseded',
      }])
      .mockResolvedValueOnce([]);
    execRawMock.mockResolvedValue(1);

    await autoReplayReconciliationRequiredRows({ tenantId: TENANT });

    expect(queueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'sms',
        deliveryChannels: ['sms'],
      }),
      expect.objectContaining({ strict: true, replayGeneration: 1 }),
    );
    expect(queueMock.mock.calls[0][0].deliveryChannels).not.toContain('push');
    expect(queueMock.mock.calls[0][0].sourceEventKey).not.toBe(sourceEventKey);
    expect(queueMock.mock.calls[0][0].sourceEventKey).toHaveLength(255);
    expect(execRawMock).toHaveBeenCalledWith(
      expect.stringMatching(/blocked_outbox_id = \$2::integer/),
      TENANT,
      41,
    );
    const metadata = JSON.parse(queryRawMock.mock.calls[5][3]);
    expect(metadata).toMatchObject({
      replay_channels: ['sms'],
      resumed_channels: ['sms'],
    });
  });

  test('replaces an exact 255-character key that defeated append-then-slice replay keys', async () => {
    const sourceEventKey = `${'x'.repeat(175)}:${'x'.repeat(64)}:auto-replay:41`;
    expect(sourceEventKey).toHaveLength(255);
    expect(`${sourceEventKey}:auto-replay:41`.slice(0, 255)).toBe(sourceEventKey);
    mockEligibleReplay(candidateRow({ source_event_key: sourceEventKey }));

    await autoReplayReconciliationRequiredRows({ tenantId: TENANT });

    const replacementKey = queueMock.mock.calls[0][0].sourceEventKey;
    expect(replacementKey).toHaveLength(255);
    expect(replacementKey).not.toBe(sourceEventKey);
    expect(replacementKey[175]).toBe('~');
    expect(replacementKey).toMatch(/~auto-replay:41:[0-9a-f]{64}$/);
    expect(queryRawMock.mock.calls[4][0]).toMatch(/SET failure_reason = \$3::text/);
  });

  test('uses the same bounded key when the serializable transaction is retried', async () => {
    const row = candidateRow({ source_event_key: 'z'.repeat(255) });
    mockEligibleReplay(row);
    mockEligibleReplay(row);
    queueMock
      .mockResolvedValueOnce({ id: 777, duplicate: false })
      .mockResolvedValueOnce({ id: 778, duplicate: false });

    const first = await autoReplayReconciliationRequiredRows({ tenantId: TENANT });
    const retry = await autoReplayReconciliationRequiredRows({ tenantId: TENANT });

    expect(queueMock.mock.calls[0][0].sourceEventKey).toBe(
      queueMock.mock.calls[1][0].sourceEventKey,
    );
    expect(queueMock.mock.calls[0][0].sourceEventKey).toHaveLength(255);
    expect(first.replacements).toEqual([{ id: 41, replacement_id: 777 }]);
    expect(retry.replacements).toEqual([{ id: 41, replacement_id: 778 }]);
  });

  test.each([
    ['the original row', { id: 41, duplicate: true }],
    ['a distinct FAILED duplicate', { id: 778, status: 'FAILED', duplicate: true }],
    ['a distinct SUPPRESSED duplicate', { id: 779, status: 'SUPPRESSED', duplicate: true }],
    ['no replacement', null],
  ])('fails closed before superseding or resuming when queue returns %s', async (_label, queued) => {
    const row = candidateRow({ source_event_key: 'q'.repeat(255) });
    queryRawMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([{ channel: 'push', outcome: 'uncertain' }])
      .mockResolvedValueOnce([{ channel: 'push' }]);
    queueMock.mockResolvedValueOnce(queued);

    await expect(autoReplayReconciliationRequiredRows({ tenantId: TENANT }))
      .rejects.toMatchObject({
        code: 'NOTIFICATION_OUTBOX_REPLAY_REPLACEMENT_COLLISION',
        statusCode: 409,
      });

    expect(queryRawMock).toHaveBeenCalledTimes(4);
    expect(execRawMock).not.toHaveBeenCalled();
    expect(recordAutoReplayMock).not.toHaveBeenCalled();
  });

  test('selection predicate enforces bound, backoff, age ceiling, and the fail-closed reason allowlist', async () => {
    queryRawMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await autoReplayReconciliationRequiredRows({ tenantId: TENANT });

    const [sql, ...params] = queryRawMock.mock.calls[1];
    // Only RECONCILIATION_REQUIRED is ever selected — SUPPRESSED (payroll
    // supersede semantics, terminal by design) is untouchable by construction.
    expect(sql).toMatch(/AND status = 'RECONCILIATION_REQUIRED'/);
    expect(sql).not.toMatch(/SUPPRESSED/);
    // Bound below the max generation; 30-min backoff; 24-h age ceiling;
    // per-tenant lock-free batch.
    expect(sql).toMatch(/replay_generation < \$3::smallint/);
    expect(sql).toMatch(/COALESCE\(last_attempt_at, created_at\) < NOW\(\) - INTERVAL '30 minutes'/);
    expect(sql).toMatch(/jsonb_typeof\(payload -> \$5::text\) = 'number'/);
    expect(sql).toMatch(/to_timestamp/);
    expect(sql).toMatch(/ELSE NULL/);
    expect(sql).toMatch(/> NOW\(\) - INTERVAL '24 hours'/);
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    // Fail-closed allowlist: the two provider-uncertainty reasons only —
    // superseded/exhausted/operator-stamped reasons never match.
    expect(params[1]).toEqual([
      'provider_delivery_outcome_uncertain',
      'provider_state_requires_owner_reconciliation',
    ]);
    expect(params[2]).toBe(2);
    expect(params[4]).toBe('__replay_chain_started_at_ms');
    expect(queueMock).not.toHaveBeenCalled();
  });

  test('preserves the original chain start across replay generations', async () => {
    const chainStartedAt = Date.parse('2026-08-15T05:00:00.000Z');
    mockEligibleReplay(candidateRow({
      replay_generation: 1,
      created_at: new Date('2026-08-17T05:00:00.000Z'),
      payload: {
        key: 'value',
        __replay_chain_started_at_ms: chainStartedAt,
      },
    }));

    await autoReplayReconciliationRequiredRows({ tenantId: TENANT });

    expect(queueMock.mock.calls[0][0].data).toMatchObject({
      key: 'value',
      __replay_chain_started_at_ms: chainStartedAt,
    });
  });

  test('fails closed when a replay generation has no durable root-chain start', async () => {
    mockEligibleReplay(candidateRow({ replay_generation: 1 }));

    await expect(autoReplayReconciliationRequiredRows({ tenantId: TENANT }))
      .rejects.toThrow('no valid root start time');

    expect(queueMock).not.toHaveBeenCalled();
  });

  test('stamps newly-terminal chains exhausted exactly once and alerts', async () => {
    queryRawMock
      .mockResolvedValueOnce([{ id: 90, replay_generation: 2 }]) // exhausted stamp
      .mockResolvedValueOnce([]); // no requeue candidates

    const result = await autoReplayReconciliationRequiredRows({ tenantId: TENANT });

    expect(result).toMatchObject({ requeued: 0, exhausted: 1 });
    const [sql, ...params] = queryRawMock.mock.calls[0];
    expect(sql).toMatch(/SET failure_reason = \$2::text/);
    expect(sql).toMatch(/replay_generation >= \$3::smallint/);
    // The idempotence marker: only rows still carrying an auto-replayable
    // reason are stamped, so the second sweep matches nothing.
    expect(params).toEqual([
      TENANT,
      'auto_replay_exhausted',
      2,
      ['provider_delivery_outcome_uncertain', 'provider_state_requires_owner_reconciliation'],
    ]);
    expect(recordAutoReplayMock).toHaveBeenCalledWith('exhausted', 1);
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock.mock.calls[0][0]).toMatch(
      /notification-outbox-auto-replay: chain terminal — outbox row 90/,
    );
    expect(queueMock).not.toHaveBeenCalled();
  });

  test('runs under the serializable tenant transaction fence', async () => {
    queryRawMock.mockResolvedValue([]);
    await autoReplayReconciliationRequiredRows({ tenantId: TENANT });
    expect(setTenantTxMock).toHaveBeenCalledWith(
      TENANT,
      expect.any(Function),
      { isolationLevel: 'Serializable' },
    );
  });
});
