import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafe,
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

const {
  submitIncident,
  getAllIncidents,
} = await import('../../controllers/staff/incidentController.js');
const {
  submitGrievance,
  getAllGrievances,
} = await import('../../controllers/staff/grievanceController.js');

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

describe('staff incident and grievance controllers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses the returned incident report number in the submit response', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([
        {
          id: 7,
          report_number: 'INC-20260504-a1b2c3d4',
          status: 'submitted',
          created_at: new Date('2026-05-04T08:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([]);

    const req = {
      user: { uid: '930cc1d5-0bd2-4739-86ad-844f59ea439d' },
      body: {
        incident_type: 'patient_fall',
        severity: 'severe',
        title: 'Patient fall near ward desk',
        description: 'Patient slipped while walking to the chair.',
        incident_date: '2026-05-04T08:00:00.000Z',
      },
    };
    const res = makeRes();

    await submitIncident(req, res);

    expect(queryRawUnsafe).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].message).toContain('INC-20260504-a1b2c3d4');
  });

  it('spreads incident list query params instead of passing a parameter array', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0n }]);

    const req = {
      query: {
        status: 'submitted',
        severity: 'severe',
        limit: '10',
        offset: '5',
      },
    };
    const res = makeRes();

    await getAllIncidents(req, res);

    expect(queryRawUnsafe).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      'submitted',
      'severe',
      10,
      5
    );
    expect(queryRawUnsafe).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      'submitted',
      'severe'
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('uses the returned grievance number in the submit response', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([
        {
          id: 11,
          grievance_number: 'GRV-20260504-e5f6a7b8',
          status: 'submitted',
          created_at: new Date('2026-05-04T08:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([]);

    const req = {
      user: { uid: '930cc1d5-0bd2-4739-86ad-844f59ea439d' },
      body: {
        grievance_type: 'workload',
        subject: 'Unsafe ward workload',
        description: 'Too many simultaneous assignments during night shift.',
      },
    };
    const res = makeRes();

    await submitGrievance(req, res);

    expect(queryRawUnsafe).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].message).toContain('GRV-20260504-e5f6a7b8');
  });

  it('spreads grievance list query params instead of passing a parameter array', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0n }]);

    const req = {
      query: {
        status: 'submitted',
        grievance_type: 'workload',
        limit: '10',
        offset: '5',
      },
    };
    const res = makeRes();

    await getAllGrievances(req, res);

    expect(queryRawUnsafe).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      'submitted',
      'workload',
      10,
      5
    );
    expect(queryRawUnsafe).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      'submitted',
      'workload'
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
