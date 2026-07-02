// src/tests/unit/reliabilityMetricsReadReplicaLag.test.js
import { jest } from '@jest/globals';

const originalDatabaseReadUrl = process.env.DATABASE_READ_URL;

const primaryQueryRawUnsafeMock = jest.fn();
const readOnlyQueryRawUnsafeMock = jest.fn();
const loggerWarnMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: primaryQueryRawUnsafeMock },
  prismaReadOnly: { $queryRawUnsafe: readOnlyQueryRawUnsafeMock },
  circuitBreakerStatus: () => ({ open: false }),
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
  primaryQueryRawUnsafeMock
    .mockResolvedValueOnce([{ pending: 1, dead_letter: 0, oldest_age: 2 }])
    .mockResolvedValueOnce([{ pending: 3 }])
    .mockResolvedValueOnce([{ pending: 4, failed: 5, dead: 6 }]);
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
    expect(serializeReliabilityMetrics()).not.toContain('db_read_replica_lag_seconds');
  });

  it('queries prismaReadOnly and exposes replica lag when DATABASE_READ_URL is set', async () => {
    process.env.DATABASE_READ_URL = 'postgresql://replica.example/vhhealth';
    mockPrimaryCollectorQueries();
    readOnlyQueryRawUnsafeMock.mockResolvedValueOnce([{ lag_seconds: 17.25 }]);

    await expect(collectReliabilityMetrics()).resolves.toBeUndefined();

    expect(readOnlyQueryRawUnsafeMock).toHaveBeenCalledTimes(1);
    expect(readOnlyQueryRawUnsafeMock.mock.calls[0][0]).toContain('pg_last_xact_replay_timestamp');

    const out = serializeReliabilityMetrics();
    expect(out).toContain('# TYPE db_read_replica_lag_seconds gauge');
    expect(out).toContain('db_read_replica_lag_seconds 17.25');
  });
});
