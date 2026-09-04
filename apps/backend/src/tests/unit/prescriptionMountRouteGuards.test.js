/**
 * Per-route patient-access guards for the /api/v1/prescriptions mount
 * (re-audit M: the mount-level patientAccessGuard ran before route match, so
 * /:id-shaped subjects never resolved and the guard decided nothing).
 *
 * Pins, with mocked prisma:
 *   (a) selectors resolve the subject from the identifier the handler uses
 *       (e_prescriptions — NOT the unrelated legacy `prescriptions` table),
 *       tenant-scoped, null on junk;
 *   (b) guarded routes carry the guard (read off the router stack);
 *   (c) the /all triage list and /patient/my are NOT patient-context-forced;
 *   (d) behavior: enforce denies unrelated staff on a resolved subject,
 *       allows patient self-access, refuses unresolvable single-subject
 *       requests, and passes unfiltered lists.
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
  rxRow: null, // e_prescriptions selector join result
  patientRow: null, // accessDecisionService#patientByIdOrUid
  phoneRow: null, // /all phone-filter selector
  appointmentRow: { id: 51, uid: '33333333-3333-4333-8333-333333333333' },
  admissionRows: [],
  careTeamRows: [],
};

function routePrisma(sql) {
  if (sql.includes('FROM e_prescriptions ep')) return db.rxRow ? [db.rxRow] : [];
  // The rx-by-appointment SELECTOR only — discriminated from the access
  // engine's own appointment-relationship queries (which must keep falling
  // through to []) by the selector's users-join + patient-role predicate.
  if (
    sql.includes('FROM appointments a')
    && sql.includes('JOIN users p')
    && sql.includes("p.role = 'PATIENT'")
  ) {
    return db.appointmentRow ? [db.appointmentRow] : [];
  }
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
const ePrescriptionControllerMock = {
  createPrescription: handlerMock('createPrescription'),
  updatePrescription: handlerMock('updatePrescription'),
  signPrescription: handlerMock('signPrescription'),
  previewSafetyCheck: handlerMock('previewSafetyCheck'),
  getPrescriptionSafety: handlerMock('getPrescriptionSafety'),
  getPrescription: handlerMock('getPrescription'),
  getPrescriptionByAppointment: handlerMock('getPrescriptionByAppointment'),
  getMyPrescriptions: handlerMock('getMyPrescriptions'),
  getAllPrescriptions: handlerMock('getAllPrescriptions'),
  orderPharmacyFromPrescription: handlerMock('orderPharmacyFromPrescription'),
  downloadPrescriptionPDF: handlerMock('downloadPrescriptionPDF'),
  printPrescriptionPDF: handlerMock('printPrescriptionPDF'),
};
jest.unstable_mockModule('../../controllers/prescription/ePrescriptionController.js', () => ePrescriptionControllerMock);
const pharmacyOrderControllerMock = {
  getCatalog: handlerMock('getCatalog'),
};
jest.unstable_mockModule('../../controllers/pharmacy/pharmacyOrderController.js', () => pharmacyOrderControllerMock);
jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: () => (_req, _res, next) => next(),
}));

const rxModule = await import('../../routes/prescription/index.js');
const { default: prescriptionRoutes, __guardTesting__ } = rxModule;

let actor;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = actor;
  req.tenantId = TENANT;
  req.id = 'req-rx-guard-test';
  next();
});
app.use('/', prescriptionRoutes);

beforeEach(() => {
  mode = 'enforce';
  actor = { id: 9, uid: ACTOR_UID, role: 'PHARMACY_STAFF', phone: '+919000090011', deviceType: 'desktop' };
  db.rxRow = { id: PATIENT_ID, uid: PATIENT_UID };
  db.patientRow = { id: PATIENT_ID, uid: PATIENT_UID };
  db.phoneRow = null;
  db.admissionRows = [];
  db.careTeamRows = [];
  prismaMock.$queryRawUnsafe.mockReset();
  prismaMock.$queryRawUnsafe.mockImplementation(async (sql) => routePrisma(sql));
  prismaMock.$executeRawUnsafe.mockClear();
  Object.values(ePrescriptionControllerMock).forEach((fn) => fn.mockClear());
});

// ── (a) selectors ───────────────────────────────────────────────────────────

describe('selectors resolve from e_prescriptions, tenant-scoped', () => {
  test('by-id selector binds the same rx id with a tenant predicate', async () => {
    const selector = __guardTesting__.selectRxPatientByParam('id');
    const row = await selector({ params: { id: '88' }, tenantId: TENANT });
    expect(row).toEqual({ id: PATIENT_ID, uid: PATIENT_UID });
    const call = prismaMock.$queryRawUnsafe.mock.calls.find(([sql]) => sql.includes('FROM e_prescriptions ep'));
    expect(call[0]).toContain('ep.tenant_id = $1::uuid');
    expect(call[0]).toContain("p.role = 'PATIENT'");
    expect(call.slice(1)).toEqual([TENANT, 88]);
  });

  test('by-id selector returns null without querying on junk or missing tenant', async () => {
    const selector = __guardTesting__.selectRxPatientByParam('id');
    await expect(selector({ params: { id: 'DROP TABLE' }, tenantId: TENANT })).resolves.toBeNull();
    await expect(selector({ params: { id: '88' } })).resolves.toBeNull();
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('appointment selector resolves through the APPOINTMENT row, so the check-then-create probe decides pre-create', async () => {
    // Retargeted (lane M review, F2): a prescription-row selector returned
    // null when the appointment had no rx yet, so in enforce mode the
    // check-then-create probe 403'd and the create flow could never start.
    // The appointment always names exactly one patient; the guard decides on
    // that patient whether the handler's answer is a prescription or empty.
    const row = await __guardTesting__.selectRxPatientByAppointment({
      params: { appointmentId: '412' },
      tenantId: TENANT,
    });
    expect(row).toEqual({ id: PATIENT_ID, uid: PATIENT_UID });
    const call = prismaMock.$queryRawUnsafe.mock.calls.find(([sql]) => sql.includes('FROM appointments a'));
    expect(call[0]).toContain('a.id = $2::int');
    expect(call[0]).toContain("p.role = 'PATIENT'");
    expect(call.slice(1)).toEqual([TENANT, 412]);
    // No e_prescriptions dependency: the subject resolves even when no rx
    // row exists yet — the exact case the old selector broke.
    expect(
      prismaMock.$queryRawUnsafe.mock.calls.some(([sql]) => sql.includes('FROM e_prescriptions ep')),
    ).toBe(false);
  });

  test('body selector hands back body.patient_id for engine-side tenant validation', () => {
    expect(__guardTesting__.selectRxPatientFromBody({ body: { patient_id: 51 } })).toEqual({ id: 51 });
    expect(__guardTesting__.selectRxPatientFromBody({ body: {} })).toBeNull();
  });
});

// ── (b)+(c) route pins ──────────────────────────────────────────────────────

function guardMetasFor(path, method) {
  const layer = prescriptionRoutes.stack.find(
    (l) => l.route?.path === path && l.route.methods?.[method],
  );
  if (!layer) return null;
  return layer.route.stack
    .map((s) => (s.handle?.__wrappedFn ?? s.handle)?.__patientGuard)
    .filter(Boolean);
}

describe('router middleware chains', () => {
  test.each([
    ['post', '/create'], ['post', '/safety-check'],
    ['get', '/appointment/:appointmentId'], ['get', '/pdf/:id'], ['get', '/:id/print-pdf'],
    ['get', '/:id'], ['get', '/:id/safety'], ['put', '/:id'], ['post', '/:id/sign'],
    ['post', '/:id/order-pharmacy'], ['post', '/:id/refill'],
  ])('%s %s carries a context-forcing PRESCRIPTION guard', (method, path) => {
    expect(guardMetasFor(path, method)).toEqual([expect.objectContaining({
      recordType: 'PRESCRIPTION',
      careTeamModeGoverned: true,
      requirePatientContext: true,
      hasSelector: true,
    })]);
  });

  test('/all is guarded for patient-filtered reads but never context-forced', () => {
    expect(guardMetasFor('/all', 'get')).toEqual([expect.objectContaining({
      recordType: 'PRESCRIPTION',
      requirePatientContext: false,
    })]);
  });

  test('self-scoped and catalog routes are NOT patient-guarded', () => {
    expect(guardMetasFor('/patient/my', 'get')).toEqual([]);
    expect(guardMetasFor('/catalog', 'get')).toEqual([]);
  });
});

// ── (d) behavior ────────────────────────────────────────────────────────────

describe('guard decisions', () => {
  test('enforce: unrelated pharmacy staff cannot read a prescription by id', async () => {
    const res = await request(app).get('/88');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PATIENT_ACCESS_DENIED');
    expect(ePrescriptionControllerMock.getPrescription).not.toHaveBeenCalled();
    const call = prismaMock.$queryRawUnsafe.mock.calls.find(([sql]) => sql.includes('FROM e_prescriptions ep'));
    expect(call.slice(1)).toEqual([TENANT, 88]);
  });

  test('enforce: patient self-access to their own prescription is allowed', async () => {
    actor = { id: PATIENT_ID, uid: PATIENT_UID, role: 'PATIENT', phone: '+919000090011' };
    const res = await request(app).get('/88');
    expect(res.status).toBe(200);
    expect(ePrescriptionControllerMock.getPrescription).toHaveBeenCalledTimes(1);
  });

  test('enforce: a patient probing someone else\'s prescription id is denied by the guard', async () => {
    actor = { id: 77, uid: ACTOR_UID, role: 'PATIENT', phone: '+919000090022' };
    const res = await request(app).get('/88');
    expect(res.status).toBe(403);
    expect(ePrescriptionControllerMock.getPrescription).not.toHaveBeenCalled();
  });

  test('enforce: a nonexistent prescription id refuses with PATIENT_CONTEXT_REQUIRED', async () => {
    db.rxRow = null;
    const res = await request(app).get('/88');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PATIENT_CONTEXT_REQUIRED');
    expect(ePrescriptionControllerMock.getPrescription).not.toHaveBeenCalled();
  });

  test('shadow: unrelated staff still reach the handler', async () => {
    mode = 'shadow';
    const res = await request(app).get('/88');
    expect(res.status).toBe(200);
    expect(ePrescriptionControllerMock.getPrescription).toHaveBeenCalledTimes(1);
  });

  test('enforce: nursing staff with an active admission reach the prescription (operational path)', async () => {
    actor = { id: 9, uid: ACTOR_UID, role: 'NURSING_STAFF', phone: '+919000090011', deviceType: 'desktop' };
    db.admissionRows = [{ id: 12 }];
    const res = await request(app).get('/88');
    expect(res.status).toBe(200);
    expect(ePrescriptionControllerMock.getPrescription).toHaveBeenCalledTimes(1);
  });

  test('enforce: /all without a patient filter stays a role-gated list (no forced context)', async () => {
    const res = await request(app).get('/all');
    expect(res.status).toBe(200);
    expect(ePrescriptionControllerMock.getAllPrescriptions).toHaveBeenCalledTimes(1);
  });

  test('enforce: /all?patient_id narrows to one patient and is decided', async () => {
    const res = await request(app).get('/all').query({ patient_id: String(PATIENT_ID) });
    expect(res.status).toBe(403);
    expect(ePrescriptionControllerMock.getAllPrescriptions).not.toHaveBeenCalled();
  });

  test('enforce: create decides on the body patient the service will prescribe against', async () => {
    // DOCTOR (an ePrescriptionCreateRoutes role) with no relationship rows.
    actor = { id: 9, uid: ACTOR_UID, role: 'DOCTOR', phone: '+919000090011', deviceType: 'desktop' };
    const res = await request(app)
      .post('/create')
      .send({ patient_id: PATIENT_ID, doctor_id: 9, medications: [{ name: 'x' }] });
    expect(res.status).toBe(403);
    expect(ePrescriptionControllerMock.createPrescription).not.toHaveBeenCalled();
    // Engine validated the body patient id inside the tenant.
    const validate = prismaMock.$queryRawUnsafe.mock.calls.find(
      ([sql]) => sql.includes('$2::int IS NULL OR id = $2::int'),
    );
    expect(validate.slice(1)).toEqual([TENANT, PATIENT_ID, null]);
  });
});
