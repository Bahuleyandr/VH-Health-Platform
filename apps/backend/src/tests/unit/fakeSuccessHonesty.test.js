import { jest } from '@jest/globals';

const queryRaw = jest.fn();
const queryRawUnsafe = jest.fn();
const prismaMock = { $queryRaw: queryRaw, $queryRawUnsafe: queryRawUnsafe };

const getDoctorStats = jest.fn();
const getNotificationsByPhone = jest.fn();
const getMyNotifications = jest.fn();
const getNotificationList = jest.fn();
const getNotificationStats = jest.fn();
const getInvestigationStats = jest.fn();

jest.unstable_mockModule('@prisma/client', () => ({
  Prisma: {
    raw: (value) => value,
    sql: (strings, ...values) => ({ strings, values }),
  },
}));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  prismaReadOnly: prismaMock,
  setTenant: async (_tenantId, fn) => fn(prismaMock),
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
  pickTenantClient: () => prismaMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID: '00000000-0000-4000-8000-000000000001',
  requireTenantId: (tenantId) => tenantId || '00000000-0000-4000-8000-000000000001',
  resolveTenantOrThrow: (req) => req?.tenantId || '00000000-0000-4000-8000-000000000001',
}));

jest.unstable_mockModule('../../services/sosService.js', () => ({}));

jest.unstable_mockModule('../../services/doctor/doctorStatsService.js', () => ({
  doctorStatsService: { getDoctorStats },
}));

jest.unstable_mockModule('../../services/notification/notificationService.js', () => ({
  notificationService: {
    getNotificationsByPhone,
    getMyNotifications,
    getNotificationList,
    getNotificationStats,
  },
}));

jest.unstable_mockModule('../../services/investigation/analyticsService.js', () => ({
  getInvestigationStats,
}));

jest.unstable_mockModule('../../utils/logAudit.js', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

const { getEmergencyServices } = await import('../../controllers/sosController.js');
const { doctorStatsController } = await import('../../controllers/doctor/doctorStatsController.js');
const { notificationController } = await import('../../controllers/notification/notificationController.js');
const { getInvestigationStatistics } = await import('../../controllers/investigation/analyticsController.js');
const { default: departmentStatsService } = await import('../../services/department/departmentStatsService.js');
const { default: departmentService } = await import('../../services/department/departmentService.js');

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('SOS emergency directory reports a database fault instead of an empty success', async () => {
  queryRaw.mockRejectedValueOnce(new Error('database unavailable'));
  const res = makeRes();

  await getEmergencyServices({ user: { role: 'ADMIN' } }, res);

  expect(res.status).toHaveBeenCalledWith(500);
  expect(res.json.mock.calls[0][0]).toMatchObject({ success: false });
});

test('doctor statistics report a service fault instead of zeroed statistics', async () => {
  getDoctorStats.mockRejectedValueOnce(new Error('database unavailable'));
  const res = makeRes();

  await doctorStatsController.getDoctorStats(
    { params: { id: '7' }, query: { months: '6' }, user: { id: 7, role: 'DOCTOR' } },
    res,
  );

  expect(res.status).toHaveBeenCalledWith(500);
  expect(res.json.mock.calls[0][0]).toMatchObject({ success: false });
});

test.each([
  ['phone notification list', getNotificationsByPhone, notificationController.getByPhone, { params: { phone: '+919999999999' }, query: {}, user: { uid: 'u1', role: 'ADMIN' } }],
  ['notification list', getNotificationList, notificationController.getList, { query: {}, user: { uid: 'u1', role: 'ADMIN' } }],
  ['notification statistics', getNotificationStats, notificationController.getStats, { query: { days: '7' }, user: { uid: 'u1', role: 'ADMIN' } }],
])('%s reports a service fault instead of an empty success', async (_name, serviceMock, handler, req) => {
  serviceMock.mockRejectedValueOnce(new Error('database unavailable'));
  const res = makeRes();

  await handler(req, res);

  expect(res.status).toHaveBeenCalledWith(500);
  expect(res.json.mock.calls[0][0]).toMatchObject({ success: false });
});

test('a missing notification user is not presented as an empty inbox', async () => {
  getMyNotifications.mockRejectedValueOnce(new Error('User not found'));
  const res = makeRes();

  await notificationController.getMine({ query: {}, user: { uid: 'u1', role: 'PATIENT' } }, res);

  expect(res.status).toHaveBeenCalledWith(404);
  expect(res.json.mock.calls[0][0]).toMatchObject({
    success: false,
    message: 'User not found',
  });
});

test('department statistics propagate a database fault instead of returning zeroes', async () => {
  queryRaw.mockRejectedValueOnce(new Error('database unavailable'));

  await expect(departmentStatsService.getDepartmentStats('7')).rejects.toThrow('database unavailable');
});

test('available departments propagate a database fault instead of returning an empty directory', async () => {
  queryRaw.mockRejectedValueOnce(new Error('database unavailable'));

  await expect(departmentService.getAvailableDepartments()).rejects.toThrow('database unavailable');
});

test('investigation analytics report a database fault instead of zeroed operational totals', async () => {
  getInvestigationStats.mockRejectedValueOnce(new Error('database unavailable'));
  const res = makeRes();

  await getInvestigationStatistics({ query: { days: '30' }, user: { uid: 'u1' } }, res);

  expect(res.status).toHaveBeenCalledWith(500);
  expect(res.json.mock.calls[0][0]).toMatchObject({ success: false });
});
