// src/tests/unit/reliabilityMetricsReadReplicaLag.test.js
import { jest } from '@jest/globals';
import {
  PATHWAY_PROJECTOR_CONSUMER_KEY,
  PATHWAY_PROJECTOR_GENERATION,
} from '../../config/pathwayProjectorConfig.js';

const originalDatabaseReadUrl = process.env.DATABASE_READ_URL;

const primaryQueryRawUnsafeMock = jest.fn();
const readOnlyQueryRawUnsafeMock = jest.fn();
const loggerWarnMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: primaryQueryRawUnsafeMock },
  prismaReadOnly: { $queryRawUnsafe: readOnlyQueryRawUnsafeMock },
  circuitBreakerStatus: () => ({ open: false }),
  isTenantTransactionClient: () => true,
  setTenant: async (_tenantId, fn) => fn({ $queryRawUnsafe: primaryQueryRawUnsafeMock }),
  setTenantTx: async (_tenantId, fn) => fn({ $queryRawUnsafe: primaryQueryRawUnsafeMock }),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: loggerWarnMock,
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const {
  collectReliabilityMetrics,
  serializeReliabilityMetrics,
} = await import('../../observability/reliabilityMetrics.js');

function mockPrimaryCollectorQueries() {
  primaryQueryRawUnsafeMock.mockImplementation(async (sql) => {
    if (/FROM event_outbox/.test(sql)) return [{ pending: 1, dead_letter: 0, oldest_age: 2 }];
    if (/FROM tenants\b/.test(sql)) return [{ id: '00000000-0000-4000-8000-000000000001' }];
    if (/FROM notification_outbox/.test(sql)) {
      return [{ pending: 3, failed: 0, reconciliation_required: 0, dead_letter: 0, paused_rejected: 0, paused_uncertain: 0 }];
    }
    if (/FROM webhook_deliveries/.test(sql)) {
      return [{ pending: 4, failed: 5, dead: 6, in_flight: 0, stale_in_flight: 0, parked: 0 }];
    }
    if (/FROM pathway_projector_inbox\b/.test(sql) && /consumer_key = \$1/.test(sql)) {
      return [{ pending: 7, oldest_age: 8, leased: 9, dead: 10 }];
    }
    if (/FROM event_consumer_offsets offsets/.test(sql)) return [{ pending: 11 }];
    if (/WITH live_offsets AS/.test(sql)) {
      return [{ observed_at: 1_800_000_000, offsets_observed: 0, scopes: [] }];
    }
    if (/WITH pathway_keys/.test(sql)) return [];
    if (/WITH registry AS/.test(sql)) {
      return [{
        active_devices: 0,
        silent_devices: 0,
        unverified_rows: 0,
        active_associations: 0,
        unassociated_messages: 0,
        open_excursions: 0,
        suppressed: {},
      }];
    }
    return [];
  });
}

function expectPathwayProjectorQueryScope() {
  const pathwayCall = primaryQueryRawUnsafeMock.mock.calls.find(([sql]) => (
    /FROM pathway_projector_inbox\b/.test(sql) && /consumer_key = \$1/.test(sql)
  ));
  const [sql, consumerKey, generation] = pathwayCall;
  expect(sql).toContain('FROM pathway_projector_inbox');
  expect(sql).toContain('WHERE consumer_key = $1');
  expect(sql).toContain('AND generation = $2');
  expect(sql).toContain("AND status IN ('pending', 'dead')");
  expect(consumerKey).toBe(PATHWAY_PROJECTOR_CONSUMER_KEY);
  expect(generation).toBe(PATHWAY_PROJECTOR_GENERATION);

  const retiredCall = primaryQueryRawUnsafeMock.mock.calls.find(([sql]) => (
    /FROM event_consumer_offsets offsets/.test(sql)
  ));
  const [retiredSql, retiredConsumerKey] = retiredCall;
  expect(retiredSql).toContain('FROM event_consumer_offsets offsets');
  expect(retiredSql).toContain('JOIN pathway_projector_inbox inbox');
  expect(retiredSql).toContain('offsets.intake_retired_at IS NOT NULL');
  expect(retiredSql).toContain("inbox.status = 'pending'");
  expect(retiredConsumerKey).toBe(PATHWAY_PROJECTOR_CONSUMER_KEY);
}

beforeEach(() => {
  jest.clearAllMocks();
  primaryQueryRawUnsafeMock.mockReset();
  readOnlyQueryRawUnsafeMock.mockReset();
  loggerWarnMock.mockReset();
  delete process.env.DATABASE_READ_URL;
});

afterAll(() => {
  if (originalDatabaseReadUrl === undefined) delete process.env.DATABASE_READ_URL;
  else process.env.DATABASE_READ_URL = originalDatabaseReadUrl;
});

describe('reliabilityMetrics read-replica lag', () => {
  it('does not query or expose the replica lag gauge when DATABASE_READ_URL is unset', async () => {
    mockPrimaryCollectorQueries();

    await expect(collectReliabilityMetrics()).resolves.toBeUndefined();

    expect(readOnlyQueryRawUnsafeMock).not.toHaveBeenCalled();
    expectPathwayProjectorQueryScope();
    const out = serializeReliabilityMetrics();
    expect(out).toContain('pathway_projector_inbox_pending_rows 7');
    expect(out).toContain('pathway_projector_inbox_oldest_pending_age_seconds 8');
    expect(out).toContain('pathway_projector_inbox_leased_rows 9');
    expect(out).toContain('pathway_projector_inbox_dead_rows 10');
    expect(out).toContain('pathway_projector_inbox_retired_pending_rows 11');
    expect(out).not.toMatch(/^pathway_projector_inbox_(?:pending_rows|oldest_pending_age_seconds|leased_rows|dead_rows|retired_pending_rows)\{/m);
    expect(out).not.toContain('db_read_replica_lag_seconds');
  });

  it('queries prismaReadOnly and exposes replica lag when DATABASE_READ_URL is set', async () => {
    process.env.DATABASE_READ_URL = 'postgresql://replica.example/vhhealth';
    mockPrimaryCollectorQueries();
    readOnlyQueryRawUnsafeMock.mockResolvedValueOnce([{ lag_seconds: 17.25 }]);

    await expect(collectReliabilityMetrics()).resolves.toBeUndefined();

    expect(readOnlyQueryRawUnsafeMock).toHaveBeenCalledTimes(1);
    expect(readOnlyQueryRawUnsafeMock.mock.calls[0][0]).toContain('pg_last_xact_replay_timestamp');
    expectPathwayProjectorQueryScope();

    const out = serializeReliabilityMetrics();
    expect(out).toContain('# TYPE db_read_replica_lag_seconds gauge');
    expect(out).toContain('db_read_replica_lag_seconds 17.25');
  });
});
