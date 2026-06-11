import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafeMock,
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

const { getExecutiveKpi } = await import('../../controllers/admin/executiveKpiController.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

describe('executive KPI tenant scoping', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        revenue_total: 100,
        revenue_collected: 80,
        invoice_count: 2,
        paid: 1,
        pending: 1,
      }])
      .mockResolvedValueOnce([{ total: 10, occupied: 7 }])
      .mockResolvedValueOnce([{ avg_rating: 4.5, responses: 8 }])
      .mockResolvedValueOnce([{ active_doctors: 3, appointments: 12, completed: 9 }]);
  });

  it('adds tenant predicates to revenue, occupancy, satisfaction, and doctor utilisation aggregates', async () => {
    const req = {
      query: { days: '45' },
      tenantId: TENANT_ID,
      user: { tenantId: '99999999-9999-4999-8999-999999999999' },
    };
    const res = makeRes();

    await getExecutiveKpi(req, res);

    const [revenue, beds, feedback, doctor] = queryRawUnsafeMock.mock.calls;

    expect(revenue[0]).toMatch(/FROM invoices[\s\S]*tenant_id = \$1::uuid/);
    expect(revenue.slice(1)).toEqual([TENANT_ID, '45']);

    expect(beds[0]).toMatch(/FROM beds[\s\S]*tenant_id = \$1::uuid/);
    expect(beds.slice(1)).toEqual([TENANT_ID]);

    expect(feedback[0]).toMatch(/FROM feedback/);
    expect(feedback[0]).toMatch(/users u[\s\S]*u\.tenant_id = \$2::uuid/);
    expect(feedback[0]).toMatch(/appointments a[\s\S]*a\.tenant_id = \$2::uuid/);
    expect(feedback.slice(1)).toEqual(['45', TENANT_ID]);

    expect(doctor[0]).toMatch(/FROM appointments[\s\S]*tenant_id = \$1::uuid/);
    expect(doctor.slice(1)).toEqual([TENANT_ID, '45']);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data).toMatchObject({
      windowDays: 45,
      occupancy: { pct: 70 },
      doctorUtilisation: { completionPct: 75 },
    });
  });
});
