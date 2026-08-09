import { jest } from '@jest/globals';

jest.unstable_mockModule('../../services/health/healthStatsService.js', () => ({
  getHealthStatistics: jest.fn(),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const healthStatsService = await import('../../services/health/healthStatsService.js');
const ctrl = await import('../../controllers/health/healthStatsController.js');

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    req: { id: 'req-1' },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function mockReq(overrides = {}) {
  return { user: { role: 'ADMIN', name: 'Test Admin' }, query: {}, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getHealthStatistics controller', () => {
  it('returns real statistics on success', async () => {
    healthStatsService.getHealthStatistics.mockResolvedValueOnce({
      totals: { total_records: 42, unique_patients: 10, recent_records: 3 },
      by_type: [{ record_type: 'lab', count: 5 }],
      daily_activity: [],
    });
    const res = mockRes();

    await ctrl.getHealthStatistics(mockReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.statistics.totals.total_records).toBe(42);
  });

  it('returns an honest error response when the service fails, not a fake zeroed 200', async () => {
    healthStatsService.getHealthStatistics.mockRejectedValueOnce(
      new Error('relation "health_records" does not exist')
    );
    const res = mockRes();

    await ctrl.getHealthStatistics(mockReq(), res);

    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.data).toBeUndefined();
  });

  it('rejects non-medical roles before calling the service', async () => {
    const res = mockRes();

    await ctrl.getHealthStatistics(mockReq({ user: { role: 'PATIENT' } }), res);

    expect(res.statusCode).toBe(403);
    expect(healthStatsService.getHealthStatistics).not.toHaveBeenCalled();
  });
});
