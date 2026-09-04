/**
 * Per-route patient-access guards for the /api/v1/investigations mount
 * (re-audit M: the mount-level patientAccessGuard ran before route match, so
 * path-keyed subjects never resolved and the guard decided nothing; CAN-017
 * had already fixed the booking-by-id family — this extends the same pattern
 * to the rest of the router).
 *
 * Pins, with mocked prisma:
 *   (a) the investigation-row selector resolves uid → patient_id → phone from
 *       the same row id the handler serves, tenant-scoped, null on junk;
 *   (b) guarded routes carry the guard; the CAN-017 booking guard is intact;
 *   (c) list/queue/self/bulk routes are NOT patient-context-forced;
 *   (d) behavior: enforce denies unrelated lab staff on a resolved subject,
 *       allows a care-team member, refuses an unresolvable /uid/:uid subject,
 *       and passes unfiltered lists and phone-only legacy rows.
 */

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '33333333-3333-4333-8333-333333333333';
const ACTOR_UID = '22222222-2222-4222-8222-222222222222';
const PATIENT_ID = 51;

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(async () => 1),
};

const db = {
  invRow: null, // investigations selector join result
  patientRow: null, // accessDecisionService#patientByIdOrUid
  phoneRow: null, // body-phone selector result
  admissionRows: [],
  careTeamRows: [],
};

function routePrisma(sql) {
  if (sql.includes('FROM investigations i')) return db.invRow ? [db.invRow] : [];
  if (sql.includes('FROM users') && sql.includes('REGEXP_REPLACE')) {
    return db.phoneRow ? [db.phoneRow] : [];
  }
  if (sql.includes('FROM users') && sql.includes('$2::int IS NULL OR id = $2::int')) {
    return db.patientRow ? [db.patientRow] : [];
  }
  if (sql.includes('care_team_members')) return db.careTeamRows;
  if (sql.includes('FROM admissions')) return db.admissionRows;
  return [];
}

let mode = 'enforce';

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  prismaReadOnly: prismaMock,
  setTenant: async (_t, fn) => fn(prismaMock),
  setTenantTx: async (_t, fn) => fn(prismaMock),
  pickTenantClient: () => prismaMock,
  circuitBreakerStatus: () => ({}),
}));
jest.unstable_mockModule('../../services/security/careTeamEnforcement.js', () => ({
  CARE_TEAM_ENFORCEMENT_MODES: { OFF: 'off', SHADOW: 'shadow', ENFORCE: 'enforce' },
  resolveEnforcementModeForRequest: jest.fn(async () => mode),
  resolveEnforcementModeForTenant: jest.fn(async () => mode),
}));
jest.unstable_mockModule('../../utils/hipaaAudit.js', () => ({
  logPhiAccess: jest.fn(),
}));

function handlerMock(name) {
  return jest.fn(async (_req, res) => res.status(200).json({ handler: name }));
}
const investigationControllerMock = {
  listInvestigations: handlerMock('listInvestigations'),
  getInvestigationById: handlerMock('getInvestigationById'),
  getPatientInvestigations: handlerMock('getPatientInvestigations'),
  getDoctorInvestigations: handlerMock('getDoctorInvestigations'),
  getInvestigationsByType: handlerMock('getInvestigationsByType'),
  getPendingInvestigations: handlerMock('getPendingInvestigations'),
  markInvestigationCollected: handlerMock('markInvestigationCollected'),
  updateInvestigationStatus: handlerMock('updateInvestigationStatus'),
  addInvestigationResults: handlerMock('addInvestigationResults'),
  getMyInvestigations: handlerMock('getMyInvestigations'),
  getInvestigationsByUID: handlerMock('getInvestigationsByUID'),
  getTestCatalog: handlerMock('getTestCatalog'),
  upsertTestCatalog: handlerMock('upsertTestCatalog'),
  getInvestigationSLADashboard: handlerMock('getInvestigationSLADashboard'),
};
jest.unstable_mockModule('../../controllers/investigation/investigationController.js', () => investigationControllerMock);
const bookingControllerMock = {
  createBooking: handlerMock('createBooking'),
  getMyBookings: handlerMock('getMyBookings'),
  getBookingQueue: handlerMock('getBookingQueue'),
  confirmBooking: handlerMock('confirmBooking'),
  dispatchCollector: handlerMock('dispatchCollector'),
  markCollected: handlerMock('markCollected'),
  startProcessing: handlerMock('startProcessing'),
  uploadResult: handlerMock('bookingUploadResult'),
  getBookingDetail: handlerMock('getBookingDetail'),
  getBookingSLADashboard: handlerMock('getBookingSLADashboard'),
};
jest.unstable_mockModule('../../controllers/investigation/bookingController.js', () => bookingControllerMock);
const bulkControllerMock = {
  updateStatus: handlerMock('bulkUpdateStatus'),
  cancelInvestigations: handlerMock('bulkCancel'),
  assignToTechnician: handlerMock('bulkAssign'),
  scheduleInvestigations: handlerMock('bulkSchedule'),
};
jest.unstable_mockModule('../../controllers/investigation/bulkController.js', () => bulkControllerMock);
const invOrderControllerMock = {
  orderInvestigation: handlerMock('orderInvestigation'),
  legacyInvestigationRequest: handlerMock('legacyInvestigationRequest'),
};
jest.unstable_mockModule('../../controllers/investigation/orderController.js', () => invOrderControllerMock);
const uploadControllerMock = {
  uploadResult: handlerMock('uploadResult'),
  getFiles: handlerMock('getFiles'),
  downloadFile: handlerMock('downloadFile'),
  removeFile: handlerMock('removeFile'),
  getFileInfo: handlerMock('getFileInfo'),
};
jest.unstable_mockModule('../../controllers/investigation/uploadController.js', () => uploadControllerMock);

const invModule = await import('../../routes/investigation/investigationRoutes.js');
const { default: investigationRoutes, __guardTesting__ } = invModule;

let actor;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = actor;
  req.tenantId = TENANT;
  req.id = 'req-inv-guard-test';
  next();
});
app.use('/', investigationRoutes);

beforeEach(() => {
  mode = 'enforce';
  actor = { id: 9, uid: ACTOR_UID, role: 'LAB_STAFF', phone: '+919000090011', deviceType: 'desktop' };
  db.invRow = { id: PATIENT_ID, uid: PATIENT_UID };
  db.patientRow = { id: PATIENT_ID, uid: PATIENT_UID };
  db.phoneRow = null;
  db.admissionRows = [];
  db.careTeamRows = [];
  prismaMock.$queryRawUnsafe.mockReset();
  prismaMock.$queryRawUnsafe.mockImplementation(async (sql) => routePrisma(sql));
  prismaMock.$executeRawUnsafe.mockClear();
  [investigationControllerMock, bookingControllerMock, bulkControllerMock,
    invOrderControllerMock, uploadControllerMock]
    .forEach((mocks) => Object.values(mocks).forEach((fn) => fn.mockClear()));
});

// ── (a) selectors ───────────────────────────────────────────────────────────

describe('investigation-row selector', () => {
  test('resolves the patient from the same investigation id, tenant-scoped, uid→patient_id→phone', async () => {
    const row = await __guardTesting__.selectInvestigationPatient({
      params: { id: '31' },
      tenantId: TENANT,
    });
    expect(row).toEqual({ id: PATIENT_ID, uid: PATIENT_UID });
    const call = prismaMock.$queryRawUnsafe.mock.calls.find(([sql]) => sql.includes('FROM investigations i'));
    expect(call[0]).toContain('i.tenant_id = $1::uuid');
    expect(call[0]).toContain("p.role = 'PATIENT'");
    expect(call[0]).toContain('i.uid IS NOT NULL AND p.uid = i.uid');
    expect(call[0]).toContain('i.patient_id IS NOT NULL AND p.id = i.patient_id');
    expect(call[0]).toContain('p.phone = i.phone');
    expect(call.slice(1)).toEqual([TENANT, 31]);
  });

  test('returns null (no query, no throw) on junk id / missing tenant', async () => {
    await expect(__guardTesting__.selectInvestigationPatient({ params: { id: '31abc' }, tenantId: TENANT }))
      .resolves.toBeNull();
    await expect(__guardTesting__.selectInvestigationPatient({ params: { id: '31' } }))
      .resolves.toBeNull();
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('booking-create selector mirrors resolveBookingPatient (self / body.patient_id / patient_phone)', async () => {
    await expect(__guardTesting__.selectBookingCreatePatient({
      user: { id: 51, role: 'PATIENT' },
      body: { patient_id: 999 },
      tenantId: TENANT,
    })).resolves.toEqual({ id: 51 });
    await expect(__guardTesting__.selectBookingCreatePatient({
      user: { id: 9, role: 'RECEPTIONIST' },
      body: { patient_id: 51 },
      tenantId: TENANT,
    })).resolves.toEqual({ id: 51 });
    db.phoneRow = { id: PATIENT_ID, uid: PATIENT_UID };
    await expect(__guardTesting__.selectBookingCreatePatient({
      user: { id: 9, role: 'RECEPTIONIST' },
      body: { patient_phone: '+919000090011' },
      tenantId: TENANT,
    })).resolves.toEqual({ id: PATIENT_ID, uid: PATIENT_UID });
    const call = prismaMock.$queryRawUnsafe.mock.calls.find(([sql]) => sql.includes('REGEXP_REPLACE'));
    expect(call[0]).toContain('tenant_id = $1::uuid');
  });

  test('list-filter selector yields a subject only when the caller filters by patient', () => {
    expect(__guardTesting__.selectListFilterPatient({ query: {} })).toBeNull();
    expect(__guardTesting__.selectListFilterPatient({ query: { patient_uid: PATIENT_UID } }))
      .toEqual({ uid: PATIENT_UID });
    expect(__guardTesting__.selectListFilterPatient({ query: { patient_id: '51' } }))
      .toEqual({ id: '51' });
  });
});

// ── (b)+(c) route pins ──────────────────────────────────────────────────────

function routeLayer(path, method) {
  return investigationRoutes.stack.find(
    (l) => l.route?.path === path && l.route.methods?.[method],
  );
}

function guardMetasFor(path, method) {
  const layer = routeLayer(path, method);
  if (!layer) return null;
  return layer.route.stack
    .map((s) => (s.handle?.__wrappedFn ?? s.handle)?.__patientGuard)
    .filter(Boolean);
}

describe('router middleware chains', () => {
  test.each([
    ['get', '/:id'], ['get', '/:id/files'], ['get', '/:id/files/:fileId'],
    ['get', '/:id/files/:fileId/download'], ['post', '/:id/collected'],
    ['post', '/:id/upload'], ['delete', '/:id/files/:fileId'],
    ['put', '/:id/status'], ['put', '/:id/results'], ['post', '/'],
    ['post', '/bookings/create'],
  ])('%s %s carries an INVESTIGATION guard without forced context', (method, path) => {
    expect(guardMetasFor(path, method)).toEqual([expect.objectContaining({
      recordType: 'INVESTIGATION',
      careTeamModeGoverned: true,
      requirePatientContext: false,
      hasSelector: true,
    })]);
  });

  test.each([
    ['get', '/patient/:patient_id'], ['get', '/uid/:uid'], ['post', '/order'],
  ])('%s %s names a single subject and forces patient context', (method, path) => {
    expect(guardMetasFor(path, method)).toEqual([expect.objectContaining({
      recordType: 'INVESTIGATION',
      requirePatientContext: true,
    })]);
  });

  test('/list is guarded for patient-filtered reads but never context-forced', () => {
    expect(guardMetasFor('/list', 'get')).toEqual([expect.objectContaining({
      requirePatientContext: false,
    })]);
  });

  test.each([
    ['get', '/catalog'], ['get', '/sla-dashboard'], ['get', '/status/pending'],
    ['get', '/my'], ['get', '/bookings/my'], ['get', '/bookings/queue'],
    ['get', '/bookings/sla'], ['get', '/doctor/:doctor_id'], ['get', '/type/:type'],
    ['post', '/bulk/status'], ['post', '/catalog'],
  ])('%s %s (list/queue/self/bulk) is NOT patient-guarded', (method, path) => {
    expect(guardMetasFor(path, method)).toEqual([]);
  });

  test.each([
    ['get', '/bookings/:id'], ['post', '/bookings/:id/confirm'],
    ['post', '/bookings/:id/dispatch'], ['post', '/bookings/:id/collected'],
    ['post', '/bookings/:id/processing'], ['post', '/bookings/:id/result'],
  ])('CAN-017 booking guard is still on %s %s', (method, path) => {
    const layer = routeLayer(path, method);
    const hasResourceGuard = layer.route.stack.some(
      (s) => (s.handle?.__wrappedFn ?? s.handle)?.name === 'patientAccessGuardForResourceMiddleware',
    );
    expect(hasResourceGuard).toBe(true);
  });
});

// ── (d) behavior ────────────────────────────────────────────────────────────

describe('guard decisions', () => {
  test('enforce: lab staff with no relationship cannot read an investigation by id', async () => {
    const res = await request(app).get('/31');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PATIENT_ACCESS_DENIED');
    expect(investigationControllerMock.getInvestigationById).not.toHaveBeenCalled();
    const call = prismaMock.$queryRawUnsafe.mock.calls.find(([sql]) => sql.includes('FROM investigations i'));
    expect(call.slice(1)).toEqual([TENANT, 31]);
  });

  test('enforce: nursing staff on the patient\'s active care team may update the investigation', async () => {
    actor = { id: 9, uid: ACTOR_UID, role: 'NURSING_STAFF', phone: '+919000090011', deviceType: 'desktop' };
    db.careTeamRows = [{ care_team_id: 4 }];
    const res = await request(app).put('/31/results').send({ results: 'ok' });
    expect(res.status).toBe(200);
    expect(investigationControllerMock.addInvestigationResults).toHaveBeenCalledTimes(1);
  });

  // Documents the enforce-mode posture the report flags for human review:
  // LAB_STAFF sits at PHI access level NONE in rolePolicyGraph (it is not in
  // CLINICAL_ROLE_SET), so accessDecisionService denies it on ANY resolved
  // patient subject BEFORE relationship checks — a care-team row does not
  // help. Shadow (the default) only logs this; flipping a tenant to enforce
  // makes it a real 403. If the platform wants lab staff working named-patient
  // investigations under enforce, the role model must grant them a PHI path
  // first — that is a governance decision, not a guard bug.
  test('enforce: LAB_STAFF is denied on a resolved subject even WITH a care-team row (role has no PHI scope)', async () => {
    db.careTeamRows = [{ care_team_id: 4 }];
    const res = await request(app).put('/31/results').send({ results: 'ok' });
    expect(res.status).toBe(403);
    expect(investigationControllerMock.addInvestigationResults).not.toHaveBeenCalled();
  });

  test('enforce: a phone-only legacy row with no registered patient stays workable (context not forced)', async () => {
    db.invRow = null;
    const res = await request(app).get('/31');
    expect(res.status).toBe(200);
    expect(investigationControllerMock.getInvestigationById).toHaveBeenCalledTimes(1);
  });

  test('shadow: unrelated lab staff still reach the handler', async () => {
    mode = 'shadow';
    const res = await request(app).get('/31');
    expect(res.status).toBe(200);
    expect(investigationControllerMock.getInvestigationById).toHaveBeenCalledTimes(1);
  });

  test('enforce: /uid/:uid refuses when the uid resolves no patient in the tenant', async () => {
    db.patientRow = null;
    const res = await request(app).get(`/uid/${PATIENT_UID}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PATIENT_CONTEXT_REQUIRED');
    expect(investigationControllerMock.getInvestigationsByUID).not.toHaveBeenCalled();
  });

  test('enforce: patient self-read via /uid/:uid is allowed', async () => {
    actor = { id: PATIENT_ID, uid: PATIENT_UID, role: 'PATIENT', phone: '+919000090011' };
    const res = await request(app).get(`/uid/${PATIENT_UID}`);
    expect(res.status).toBe(200);
    expect(investigationControllerMock.getInvestigationsByUID).toHaveBeenCalledTimes(1);
  });

  test('enforce: /list without a filter stays a role-gated list; a patient filter is decided', async () => {
    const unfiltered = await request(app).get('/list');
    expect(unfiltered.status).toBe(200);
    expect(investigationControllerMock.listInvestigations).toHaveBeenCalledTimes(1);

    const filtered = await request(app).get('/list').query({ patient_uid: PATIENT_UID });
    expect(filtered.status).toBe(403);
    expect(investigationControllerMock.listInvestigations).toHaveBeenCalledTimes(1);
  });

  test('enforce: bulk status update stays on the role gate (multi-subject, deliberately unguarded)', async () => {
    const res = await request(app)
      .post('/bulk/status')
      .send({ investigation_ids: [1, 2], status: 'COMPLETED' });
    expect(res.status).toBe(200);
    expect(bulkControllerMock.updateStatus).toHaveBeenCalledTimes(1);
  });
});
