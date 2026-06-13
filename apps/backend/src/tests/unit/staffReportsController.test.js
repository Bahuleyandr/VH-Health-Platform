import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafe,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
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
  getIncidentDetail,
  updateIncident,
} = await import('../../controllers/staff/incidentController.js');
const {
  submitGrievance,
  getAllGrievances,
  updateGrievance,
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

  it('preserves the reporter id when an incident is submitted anonymously', async () => {
    const staffUid = '930cc1d5-0bd2-4739-86ad-844f59ea439d';
    queryRawUnsafe
      .mockResolvedValueOnce([
        {
          id: 8,
          report_number: 'INC-20260504-z9y8x7w6',
          status: 'submitted',
          is_anonymous: true,
          created_at: new Date('2026-05-04T08:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([]);

    const req = {
      user: { uid: staffUid },
      body: {
        incident_type: 'near_miss',
        severity: 'moderate',
        title: 'Near miss at medication station',
        description: 'Medication almost given to the wrong patient.',
        incident_date: '2026-05-04T08:00:00.000Z',
        is_anonymous: true,
      },
    };
    const res = makeRes();

    await submitIncident(req, res);

    expect(queryRawUnsafe.mock.calls[0][1]).toBe(staffUid);
    expect(queryRawUnsafe.mock.calls[0][12]).toBe(true);
    expect(res.status).toHaveBeenCalledWith(200);
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

  it('masks anonymous incident reporters for HR and reveals them for admin-tier review', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0n }]);

    await getAllIncidents(
      { query: {}, user: { role: 'HR_STAFF' } },
      makeRes()
    );

    const hrSql = queryRawUnsafe.mock.calls[0][0];
    expect(hrSql).toContain('WHEN ir.is_anonymous AND FALSE THEN ir.reporter_id');
    expect(hrSql).toContain('CASE WHEN ir.is_anonymous AND FALSE THEN u.name ELSE NULL END as anonymous_reporter_name');

    jest.clearAllMocks();
    queryRawUnsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0n }]);

    await getAllIncidents(
      { query: {}, user: { role: 'ADMIN' } },
      makeRes()
    );

    const adminSql = queryRawUnsafe.mock.calls[0][0];
    expect(adminSql).toContain('WHEN ir.is_anonymous AND TRUE THEN ir.reporter_id');
    expect(adminSql).toContain('CASE WHEN ir.is_anonymous AND TRUE THEN u.name ELSE NULL END as anonymous_reporter_name');
  });

  it('does not expose anonymous incident detail through staff detail lookups', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);

    const req = {
      params: { id: '42' },
      user: { uid: '930cc1d5-0bd2-4739-86ad-844f59ea439d' },
    };
    const res = makeRes();

    await getIncidentDetail(req, res);

    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(queryRawUnsafe.mock.calls[0][0]).toContain('ir.reporter_id = $2::uuid');
    expect(queryRawUnsafe.mock.calls[0][0]).not.toContain('ir.is_anonymous = true');
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('records incident status changes, public updates, and internal notes in the report log', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([
        {
          id: 7,
          report_number: 'INC-20260504-a1b2c3d4',
          status: 'submitted',
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 7, status: 'under_review' }]);

    const req = {
      params: { id: '7' },
      user: { uid: '930cc1d5-0bd2-4739-86ad-844f59ea439d' },
      body: {
        status: 'under_review',
        public_update: 'HR has acknowledged the report.',
        internal_note: 'Assign to safety officer.',
      },
    };
    const res = makeRes();

    await updateIncident(req, res);

    const logInserts = queryRawUnsafe.mock.calls.filter((call) =>
      call[0].includes('INSERT INTO report_updates')
    );
    expect(logInserts).toHaveLength(3);
    expect(logInserts[0][3]).toBe('Assign to safety officer.');
    expect(logInserts[1][3]).toBe('HR has acknowledged the report.');
    expect(logInserts[2][3]).toContain('UNDER REVIEW');
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

  it('preserves the reporter id when a grievance is submitted anonymously', async () => {
    const staffUid = '930cc1d5-0bd2-4739-86ad-844f59ea439d';
    queryRawUnsafe
      .mockResolvedValueOnce([
        {
          id: 12,
          grievance_number: 'GRV-20260504-q1w2e3r4',
          status: 'submitted',
          created_at: new Date('2026-05-04T08:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([]);

    const req = {
      user: { uid: staffUid },
      body: {
        grievance_type: 'unfair_treatment',
        subject: 'Anonymous staff grievance',
        description: 'Concern raised without public sender disclosure.',
        is_anonymous: true,
      },
    };
    const res = makeRes();

    await submitGrievance(req, res);

    expect(queryRawUnsafe.mock.calls[0][1]).toBe(staffUid);
    expect(queryRawUnsafe.mock.calls[0][8]).toBe(true);
    expect(res.status).toHaveBeenCalledWith(200);
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

  it('masks anonymous grievance reporters for HR and reveals them for super-admin review', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0n }]);

    await getAllGrievances(
      { query: {}, user: { role: 'HR_STAFF' } },
      makeRes()
    );

    const hrSql = queryRawUnsafe.mock.calls[0][0];
    expect(hrSql).toContain('WHEN sg.is_anonymous AND FALSE THEN sg.reporter_id');
    expect(hrSql).toContain('CASE WHEN sg.is_anonymous AND FALSE THEN u.name ELSE NULL END as anonymous_reporter_name');

    jest.clearAllMocks();
    queryRawUnsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0n }]);

    await getAllGrievances(
      { query: {}, user: { role: 'SUPER_ADMIN' } },
      makeRes()
    );

    const superAdminSql = queryRawUnsafe.mock.calls[0][0];
    expect(superAdminSql).toContain('WHEN sg.is_anonymous AND TRUE THEN sg.reporter_id');
    expect(superAdminSql).toContain('CASE WHEN sg.is_anonymous AND TRUE THEN u.name ELSE NULL END as anonymous_reporter_name');
  });

  it('records grievance status changes and HR notes in the report log', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([
        {
          id: 11,
          grievance_number: 'GRV-20260504-e5f6a7b8',
          status: 'submitted',
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 11, status: 'acknowledged' }]);

    const req = {
      params: { id: '11' },
      user: { uid: '930cc1d5-0bd2-4739-86ad-844f59ea439d' },
      body: {
        status: 'acknowledged',
        public_update: 'HR has acknowledged your grievance.',
        internal_note: 'Needs HR partner review.',
      },
    };
    const res = makeRes();

    await updateGrievance(req, res);

    const logInserts = queryRawUnsafe.mock.calls.filter((call) =>
      call[0].includes('INSERT INTO report_updates')
    );
    expect(logInserts).toHaveLength(3);
    expect(logInserts[0][3]).toBe('Needs HR partner review.');
    expect(logInserts[1][3]).toBe('HR has acknowledged your grievance.');
    expect(logInserts[2][3]).toContain('ACKNOWLEDGED');
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
