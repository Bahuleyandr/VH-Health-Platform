import { buildUserTargetingQuery } from '../../utils/notification/notificationHelpers.js';

describe('buildUserTargetingQuery', () => {
  it('parameterizes appointment lookback days instead of interpolating SQL text', () => {
    const { query, params } = buildUserTargetingQuery({
      has_appointments_in_last_days: '30',
    });

    expect(query).toContain("$1::int * INTERVAL '1 day'");
    expect(query).not.toContain('30 days');
    expect(params).toEqual([30]);
  });

  it('rejects non-integer appointment lookback criteria', () => {
    expect(() => buildUserTargetingQuery({
      has_appointments_in_last_days: "1 day'; DROP TABLE users; --",
    })).toThrow('Invalid has_appointments_in_last_days criteria');
  });
});
