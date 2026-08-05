import { jest } from '@jest/globals';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const LEASE_OWNER = '20000000-0000-4000-8000-000000000001';

const query = jest.fn();
const tx = { $queryRawUnsafe: query };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  isTenantTransactionClient: jest.fn(() => true),
  setTenantTx: jest.fn(async (_tenantId, callback) => callback(tx)),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { warn: jest.fn() },
}));
jest.unstable_mockModule('../../observability/reliabilityMetrics.js', () => ({
  recordEventDeadLettered: jest.fn(),
  recordEventOutboxLeaseReaped: jest.fn(),
  recordOutboxOperatorRedrive: jest.fn(),
}));

const { completeClaimedEventFanout } = await import('../../services/events/eventOutboxService.js');
const {
  HELD_MESSAGE_FAMILIES,
  parseHeldMessageBinding,
} = await import('../../validators/clinicalContinuityHeldReleaseSchemas.js');

function claim() {
  return {
    id: '71',
    tenant_id: TENANT_ID,
    attempts: 1,
    lease_owner: LEASE_OWNER,
  };
}

describe('paper-fact held I18 composition', () => {
  beforeEach(() => {
    query.mockReset();
    query
      .mockResolvedValueOnce([{
        id: '71',
        event_type: 'clinical_continuity.paper_fact.recorded',
        payload: { effect_disposition: 'late_pending_only' },
        recovery_effect_disposition: 'late_pending_only',
      }])
      .mockResolvedValueOnce([{ id: 81 }])
      .mockResolvedValueOnce([{ eligible_count: 1, covered_count: 1 }])
      .mockResolvedValueOnce([{ id: '71', status: 'delivered', delivered_at: new Date() }]);
  });

  test('copies blast-radius classification but keeps the paper I18 delivery held and unreleasable', async () => {
    await expect(completeClaimedEventFanout({ claim: claim() })).resolves.toMatchObject({
      delivered: true,
      enqueued: 1,
    });

    const [insertSql, ...insertParams] = query.mock.calls[1];
    expect(insertSql).toContain('subscription.downstream_effect_classification');
    expect(insertSql).toContain("THEN 'held_owner_reconciliation'");
    expect(insertSql).toContain("THEN 'late_pending_only'");
    expect(insertSql).toContain("THEN NULL ELSE NOW() END");
    expect(insertParams.at(-1)).toBe('late_pending_only');
    expect(HELD_MESSAGE_FAMILIES).not.toContain('I18');

    let refusal;
    try {
      parseHeldMessageBinding({
        incident_interface_id: '30000000-0000-4000-8000-000000000001',
        interface_family: 'I18',
        message_id: 81,
        expected_incident_interface_version: 1,
        expected_source_state_fingerprint: 'a'.repeat(64),
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({
      code: 'CONTINUITY_HELD_MESSAGE_FAMILY_NOT_RELEASEABLE',
    });
  });
});
