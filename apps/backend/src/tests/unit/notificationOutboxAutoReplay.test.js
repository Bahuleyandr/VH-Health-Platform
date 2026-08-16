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
    failure_reason: 'provider_delivery_outcome_uncertain',
    replay_generation: 0,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  queueMock.mockResolvedValue({ id: 777, duplicate: false });
});

describe('notification outbox bounded auto-replay sweep', () => {
  test('requeues an eligible row as a new intent and stamps the original superseded', async () => {
    queryRawMock
      .mockResolvedValueOnce([]) // exhausted stamp: none
      .mockResolvedValueOnce([candidateRow()]) // candidates
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
        sourceEventKey: 'workflow-escalation:77:5:42:auto-replay:41',
        templateVersion: 'critical-result.v1',
        data: { key: 'value' },
      }),
      expect.objectContaining({ strict: true, replayGeneration: 1 }),
    );

    // Original stamped with the EXACT reason the ordering predicates hardcode.
    const stampCall = queryRawMock.mock.calls[2];
    expect(stampCall[0]).toMatch(/SET failure_reason = \$3::text/);
    expect(stampCall[0]).toMatch(/AND status = 'RECONCILIATION_REQUIRED'/);
    expect(stampCall.slice(1)).toEqual([TENANT, 41, 'operator_replay_superseded']);

    // A cursor paused ON the original is resumed in the same transaction.
    expect(execRawMock).toHaveBeenCalledWith(
      expect.stringMatching(/SET state = 'ready'/),
      TENANT, 'push', 41,
    );

    // System-actor audit provenance: NULL uid, sweep sentinel, recorded
    // duplicate-delivery risk and replacement id.
    const auditCall = queryRawMock.mock.calls[3];
    expect(auditCall[0]).toMatch(/NOTIFICATION_OUTBOX_AUTO_REPLAYED/);
    expect(auditCall[0]).toMatch(/VALUES \(\$1::uuid, NULL, 'system'/);
    const metadata = JSON.parse(auditCall[3]);
    expect(metadata).toMatchObject({
      actor: 'system:auto-replay-sweep',
      prior_failure_reason: 'provider_delivery_outcome_uncertain',
      replacement_outbox_id: 777,
      replay_generation: 1,
      duplicate_delivery_risk_accepted: true,
    });

    expect(recordAutoReplayMock).toHaveBeenCalledWith('requeued', 1);
    expect(recordAutoReplayMock).toHaveBeenCalledWith('exhausted', 0);
    expect(loggerErrorMock).not.toHaveBeenCalled();
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
    expect(sql).toMatch(/created_at > NOW\(\) - INTERVAL '24 hours'/);
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    // Fail-closed allowlist: the two provider-uncertainty reasons only —
    // superseded/exhausted/operator-stamped reasons never match.
    expect(params[1]).toEqual([
      'provider_delivery_outcome_uncertain',
      'provider_state_requires_owner_reconciliation',
    ]);
    expect(params[2]).toBe(2);
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
