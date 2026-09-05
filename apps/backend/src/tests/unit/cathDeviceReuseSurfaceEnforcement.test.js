/**
 * The two device-reuse behaviours that only exist END TO END, driven through
 * supertest with the REAL routers, the REAL role gates and the REAL service —
 * only prisma and the HIPAA audit sink are stubbed.
 *
 *   1. DEVICE HISTORY WRITES A PER-PATIENT ACCESS TRAIL. The answer names every
 *      patient the device touched, and NEITHER mount can log that: the
 *      /api/v1/cath-lab phiAccessLogger resolves a patient from the request and
 *      this request carries none (so it writes patient_id = NULL), and the
 *      /api/v1/cath-reprocessing governance mount has no PHI logger at all. The
 *      shared handler writes the rows itself, one per DISTINCT patient, capped
 *      at the batch helper's 25.
 *
 *   2. SEROLOGY IS PROJECTED BY ROLE. reuse_restriction carries `reasons`
 *      ("HBsAg reactive 2026-08-12") and `markers` (per-marker result and
 *      date). Cath report-read admits RECEPTIONIST and TECHNICIAN, who need the
 *      DECISION but have no business reading which marker came back reactive.
 *
 *   3. THE PRINTED DEVICE LABEL CARRIES NO PATIENT DATA. The label is a
 *      physical artefact that leaves the department on the device, and the
 *      register column that is not device identity — exposure_markers — names
 *      a blood-borne marker a previous patient tested reactive for. The key
 *      set is asserted whole, for every role the /devices sub-tree admits.
 *
 * Census-style siblings (cathLabRouteGuards, cathDeviceReuseRouteWiring) pin
 * the wiring; they cannot fail if the audit call or the projection is deleted,
 * because in both of them the handler body is never run.
 */

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const PATIENT_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const PATIENT_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const CASE_PATIENT = 'cccccccc-3333-4333-8333-333333333333';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn(async () => 1);
const dbStub = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: executeRawUnsafeMock,
};
const setTenant = jest.fn(async (_tenantId, fn) => fn(dbStub));
const setTenantTx = jest.fn(async (_tenantId, fn) => fn(dbStub));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  __esModule: true,
  default: dbStub,
  prismaReadOnly: dbStub,
  setTenant,
  setTenantTx,
  isTenantTransactionClient: () => false,
  circuitBreakerStatus: () => ({}),
  pinSessionTimeZoneToUrl: (url) => url,
  evaluateTenantRlsPosture: () => ({}),
  tenantRlsRuntimeRole: () => null,
  tenantRlsRolePosture: async () => ({}),
  logTenantRlsRolePosture: async () => {},
  rlsDisabledLogLevel: () => 'warn',
  tenantRlsPostureMustFailClosed: () => false,
  ensureTenantRlsRuntimeRoleGrants: async () => {},
}));

// The audit SINK is the spy; everything that decides what to write to it is
// the real code under test.
const logPhiAccessBatch = jest.fn(async () => {});
const logPhiAccess = jest.fn();
jest.unstable_mockModule('../../utils/hipaaAudit.js', () => ({
  logPhiAccess,
  logPhiAccessBatch,
}));

const listCaseConsumableUsage = jest.fn();
const getCase = jest.fn();
jest.unstable_mockModule('../../services/clinical/cathLabService.js', () => ({
  addContrastRadiationRecord: jest.fn(), addDeviceLink: jest.fn(), addHemodynamicSummary: jest.fn(),
  addPostProcedureOrder: jest.fn(), createCase: jest.fn(), getCase,
  listCatalogBatches: jest.fn(), listCases: jest.fn(), listCaseConsumableUsage,
  listConsumableCatalog: jest.fn(), recordConsumableUsage: jest.fn(), recordProcedureLog: jest.fn(),
  transitionCaseStatus: jest.fn(), updateReadinessCheck: jest.fn(),
}));
jest.unstable_mockModule('../../services/clinical/cathQuickWinsService.js', () => ({
  applyCathOrderSetSlot: jest.fn(), getCaseQuickWins: jest.fn(), refreshReadinessEvidence: jest.fn(),
}));
jest.unstable_mockModule('../../services/clinical/cathReportService.js', () => ({
  addReportAddendum: jest.fn(), createReport: jest.fn(), getReport: jest.fn(),
  getSignedReportForPdf: jest.fn(), listReports: jest.fn(), listReportTemplates: jest.fn(),
  markReportPreliminary: jest.fn(), resolveCaseViewerLink: jest.fn(), signReport: jest.fn(),
  supersedeReportTemplate: jest.fn(), updateReport: jest.fn(),
}));
jest.unstable_mockModule('../../services/documents/cathReportPdfService.js', () => ({
  renderCathReportPdf: jest.fn(),
}));

// The pre-cath lab readiness rail (Plan 3) is imported by cathLabRoutes and by
// the governance router; stubbed here for the same reason as the services
// above — this suite pins the device-reuse audit trail and serology projection, not the readiness resolver, and the real
// module pulls the whole lab-results graph in behind it.
const refreshCaseLabReadiness = jest.fn();
jest.unstable_mockModule('../../services/clinical/cathLabReadinessService.js', () => ({
  // ITEM_CODES is REAL: cathLabRoutes' :item guard tests membership against it,
  // and a stub list would let the guard pass a code the service refuses.
  ITEM_CODES: Object.freeze(['hb', 'platelets', 'creatinine', 'potassium', 'hiv', 'hbsag', 'hcv']),
  getReadinessSettings: jest.fn(),
  orderMissingLabs: jest.fn(),
  recordExternalLabResult: jest.fn(),
  refreshCaseLabReadiness,
  refreshOpenCasesForPatient: jest.fn(),
  upsertReadinessSettings: jest.fn(),
  waiveLabItem: jest.fn(),
}));
jest.unstable_mockModule('../../services/clinical/cathSchedulingRegistryService.js', () => ({
  addRegistryEntry: jest.fn(), cancelCaseSchedule: jest.fn(), getCaseSchedule: jest.fn(),
  getScheduleStrip: jest.fn(), scheduleCase: jest.fn(),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => TENANT,
  requireTenantId: (value) => value,
}));

jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: () => (_req, _res, next) => next(),
}));

// Per-route patient guards are pinned in cathLabRouteGuards; neutralise them so
// requests reach the handlers this suite is about.
jest.unstable_mockModule('../../middleware/routePatientAccessGuards.js', () => ({
  routePatientGuard: () => (_req, _res, next) => next(),
  selectorTenantOf: () => null,
  positiveIntOrNull: () => null,
  positiveBigIntTextOrNull: () => null,
  PG_INT4_MAX: 2147483647,
  PG_INT8_MAX: 9223372036854775807n,
}));

const { default: cathLabRoutes } = await import('../../routes/clinical/cathLabRoutes.js');
const { default: governanceRoutes } = await import('../../routes/clinical/cathReprocessingPolicyRoutes.js');
const { default: cssdRoutes } = await import('../../routes/cssd/cssdRoutes.js');
const { requireRole } = await import('../../middleware/rbacMiddleware.js');
const {
  DEVICE_HISTORY_PHI_BATCH_CAP,
  DEVICE_LABEL_FIELDS,
} = await import('../../services/clinical/cathDeviceReuseService.js');
const {
  CATH_LAB_ROUTE_ROLES,
  CATH_REPROCESSING_POLICY_ROUTE_ROLES,
  CSSD_DEVICE_ROUTE_ROLES,
  CSSD_ROUTE_ROLES,
} = await import('../../config/routeRolePolicy.js');

function appFor(role) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.id = 'req-abc';
    req.tenantId = TENANT;
    req.user = { uid: ACTOR, id: 9, role, rawRole: role, roles: [role], scope: 'full' };
    next();
  });
  app.use('/api/v1/cath-lab', requireRole(...CATH_LAB_ROUTE_ROLES), cathLabRoutes);
  app.use(
    '/api/v1/cath-reprocessing',
    requireRole(...CATH_REPROCESSING_POLICY_ROUTE_ROLES),
    governanceRoutes,
  );
  // The CSSD mount, exactly as app.js builds it: the wide mount audience, and
  // the router's own narrowing of the /devices sub-tree inside it.
  app.use('/api/v1/cssd', requireRole(...CSSD_ROUTE_ROLES), cssdRoutes);
  return app;
}

/** Collect a binary response body — the label's default answer is a PDF. */
function binaryParser(res, callback) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

/** Route the stubbed prisma by the SQL each read issues. */
function dispatch(handlers) {
  queryRawUnsafeMock.mockImplementation(async (sql) => {
    for (const [needle, rows] of handlers) {
      if (sql.includes(needle)) return typeof rows === 'function' ? rows(sql) : rows;
    }
    return [];
  });
}

const deviceRow = {
  id: 77n, tenant_id: TENANT, facility_id: 4, catalog_item_id: 5, device_tag: 'RP00000077',
  origin_usage_id: 900n, origin_unit_index: 1, cycle_count: 1, max_cycles_snapshot: 3,
  status: 'available', current_usage_id: null, exposure_flag: false, exposure_markers: [],
  last_reprocessed_at: null, last_reprocessed_by: null, last_cycle_type: null,
  last_function_check: null, quarantine_reason: null, quarantined_at: null,
  discard_reason: null, discard_note: null, discarded_at: null, discarded_by: null,
  created_by: null, created_at: null, updated_at: null, metadata: {},
  item_name: 'Diagnostic catheter', category: 'catheter', manufacturer: null, model: null,
};

const useRow = (id, patientUid) => ({
  usage_id: BigInt(id), case_id: 10n, patient_uid: patientUid,
  used_at: '2026-08-01T00:00:00.000Z', reuse_cycle: 1, post_use_disposition: null, kind: 'reuse',
});

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  executeRawUnsafeMock.mockClear();
  logPhiAccessBatch.mockClear();
  logPhiAccess.mockClear();
  listCaseConsumableUsage.mockReset();
  getCase.mockReset();
  refreshCaseLabReadiness.mockReset();
});

describe('device history writes one HIPAA access row per distinct patient', () => {
  function historyWith(uses) {
    dispatch([
      ['FROM cath_reprocessable_devices d', [deviceRow]],
      ['FROM cath_case_consumable_usage u', uses],
      ['FROM audit_logs', []],
    ]);
  }

  it('two patients on a device produce a batch naming BOTH uids', async () => {
    historyWith([useRow(901, PATIENT_A), useRow(902, PATIENT_B)]);

    const res = await request(appFor('DOCTOR')).get('/api/v1/cath-lab/devices/77/history');

    expect(res.status).toBe(200);
    expect(logPhiAccessBatch).toHaveBeenCalledTimes(1);
    const [entries, options] = logPhiAccessBatch.mock.calls[0];
    expect(entries.map((entry) => entry.patientId)).toEqual([PATIENT_A, PATIENT_B]);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        userId: ACTOR,
        userRole: 'DOCTOR',
        recordType: 'CATH_LAB',
        action: 'VIEW',
        tenantId: TENANT,
      });
      // hipaa_access_log has no resource column, so the device the read was
      // ABOUT rides in the one free-text correlation field.
      expect(entry.requestId).toContain('cath_device:77');
      expect(entry.requestId).toContain('req-abc');
    }
    // Written through a tenant-scoped client, not the bare prisma singleton —
    // hipaa_access_log is RLS-forced.
    expect(options.db).toBe(dbStub);
    expect(setTenant).toHaveBeenCalledWith(TENANT, expect.any(Function));
  });

  it('the same patient across several uses is logged ONCE', async () => {
    historyWith([useRow(901, PATIENT_A), useRow(902, PATIENT_A), useRow(903, PATIENT_B)]);

    await request(appFor('DOCTOR')).get('/api/v1/cath-lab/devices/77/history');

    expect(logPhiAccessBatch.mock.calls[0][0].map((e) => e.patientId)).toEqual([PATIENT_A, PATIENT_B]);
  });

  it('a device with no uses writes nothing at all', async () => {
    historyWith([]);

    const res = await request(appFor('DOCTOR')).get('/api/v1/cath-lab/devices/77/history');

    expect(res.status).toBe(200);
    expect(logPhiAccessBatch).not.toHaveBeenCalled();
  });

  it('more patients than the batch helper accepts are chunked, not dropped', async () => {
    // logPhiAccessBatch throws above 25 entries; an unchunked call would lose
    // every row instead of splitting into slices it can accept.
    const many = Array.from({ length: 30 }, (_, index) => useRow(
      1000 + index,
      `dddddddd-0000-4000-8000-${String(index).padStart(12, '0')}`,
    ));
    historyWith(many);

    const res = await request(appFor('DOCTOR')).get('/api/v1/cath-lab/devices/77/history');

    expect(res.status).toBe(200);
    expect(DEVICE_HISTORY_PHI_BATCH_CAP).toBe(25);
    expect(logPhiAccessBatch).toHaveBeenCalledTimes(2);
    expect(logPhiAccessBatch.mock.calls[0][0]).toHaveLength(25);
    expect(logPhiAccessBatch.mock.calls[1][0]).toHaveLength(5);
    // Both slices carry every distinct patient between them.
    const allPatients = [...logPhiAccessBatch.mock.calls[0][0], ...logPhiAccessBatch.mock.calls[1][0]]
      .map((entry) => entry.patientId);
    expect(new Set(allPatients).size).toBe(30);
  });

  it('a 200-char X-Request-Id still yields a request_id ending in the device token, within 80 chars', async () => {
    historyWith([useRow(901, PATIENT_A)]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.id = 'r'.repeat(200);
      req.tenantId = TENANT;
      req.user = { uid: ACTOR, id: 9, role: 'DOCTOR', rawRole: 'DOCTOR', roles: ['DOCTOR'], scope: 'full' };
      next();
    });
    app.use('/api/v1/cath-lab', cathLabRoutes);

    const res = await request(app).get('/api/v1/cath-lab/devices/77/history');

    expect(res.status).toBe(200);
    const [entry] = logPhiAccessBatch.mock.calls[0][0];
    expect(entry.requestId.length).toBeLessThanOrEqual(80);
    expect(entry.requestId.endsWith('cath_device:77')).toBe(true);
  });

  it('a failing batch still lands the rows through the fire-and-forget fallback', async () => {
    historyWith([useRow(901, PATIENT_A), useRow(902, PATIENT_B)]);
    logPhiAccessBatch.mockRejectedValueOnce(new Error('insert failed'));

    const res = await request(appFor('DOCTOR')).get('/api/v1/cath-lab/devices/77/history');

    // The read is still served — losing the audit is what must not happen, and
    // logPhiAccess carries its own durable file fallback.
    expect(res.status).toBe(200);
    expect(logPhiAccess).toHaveBeenCalledTimes(2);
  });

  it('infection control reaches the SAME read on the governance mount', async () => {
    historyWith([useRow(901, PATIENT_A), useRow(902, PATIENT_B)]);

    const res = await request(appFor('INFECTION_CONTROL_OFFICER'))
      .get('/api/v1/cath-reprocessing/devices/77/history');

    expect(res.status).toBe(200);
    expect(res.body.data.device.device_tag).toBe('RP00000077');
    expect(logPhiAccessBatch.mock.calls[0][0].map((e) => e.patientId)).toEqual([PATIENT_A, PATIENT_B]);
    expect(logPhiAccessBatch.mock.calls[0][0][0].userRole).toBe('INFECTION_CONTROL_OFFICER');
  });

  it('...and an INFECTION_CONTROL_OFFICER still cannot reach it through the cath mount', async () => {
    historyWith([useRow(901, PATIENT_A)]);

    const res = await request(appFor('INFECTION_CONTROL_OFFICER'))
      .get('/api/v1/cath-lab/devices/77/history');

    expect(res.status).toBe(403);
    expect(logPhiAccessBatch).not.toHaveBeenCalled();
  });

  it('a RECEPTIONIST is refused: report-read is no longer enough for a lookback', async () => {
    historyWith([useRow(901, PATIENT_A)]);

    const res = await request(appFor('RECEPTIONIST')).get('/api/v1/cath-lab/devices/77/history');

    expect(res.status).toBe(403);
    expect(res.body.details.code).toBe('CATH_LAB_WORKFLOW_FORBIDDEN');
    expect(logPhiAccessBatch).not.toHaveBeenCalled();
  });
});

describe('GET /devices/lookup projects exposure_markers by role', () => {
  const exposedDeviceRow = { ...deviceRow, exposure_flag: true, exposure_markers: ['hbsag'] };

  function lookupWith(row) {
    dispatch([
      ['FROM cath_lab_cases', [{
        id: 10n, tenant_id: TENANT, patient_uid: CASE_PATIENT, encounter_id: null,
        facility_id: 4, status: 'completed', actual_start_at: null,
      }]],
      ['FROM cath_reprocessable_devices d', [row]],
      ['FROM cath_reprocessing_category_policies', []],
      ['FROM cath_reprocessing_settings', []],
    ]);
  }

  it('a RECEPTIONIST gets the decision fields but not which marker is reactive', async () => {
    lookupWith(exposedDeviceRow);

    const res = await request(appFor('RECEPTIONIST'))
      .get('/api/v1/cath-lab/devices/lookup?case_id=10&tag=RP00000077');

    expect(res.status).toBe(200);
    expect(res.body.data.device.exposure_markers).toEqual([]);
    // The shape and the decision fields survive the projection — only the
    // marker identity is redacted.
    expect(res.body.data.device.exposure_flag).toBe(true);
    expect(res.body.data.device.device_tag).toBe('RP00000077');
    expect(typeof res.body.data.blocked).toBe('boolean');
    expect(typeof res.body.data.requires_acknowledgement).toBe('boolean');
  });

  it('a DOCTOR sees the full marker list', async () => {
    lookupWith(exposedDeviceRow);

    const res = await request(appFor('DOCTOR'))
      .get('/api/v1/cath-lab/devices/lookup?case_id=10&tag=RP00000077');

    expect(res.status).toBe(200);
    expect(res.body.data.device.exposure_markers).toEqual(['hbsag']);
  });
});

describe('serology narrative is projected by role on the cath surfaces', () => {
  const REACTIVE_ROW = {
    id: 1, tenant_id: TENANT, patient_uid: CASE_PATIENT, marker: 'hbsag', marker_label: null,
    result: 'reactive', tested_on: '2026-08-12', source: 'lab', lab_result_id: null,
    evidence: {}, recorded_by: ACTOR, recorded_at: '2026-08-12T00:00:00.000Z',
    voided_at: null, voided_by: null, void_reason: null, notes: null,
  };

  beforeEach(() => {
    dispatch([
      ['FROM cath_lab_cases', [{
        id: 10n, tenant_id: TENANT, patient_uid: CASE_PATIENT, encounter_id: null,
        facility_id: 4, status: 'completed', actual_start_at: null,
      }]],
      ['FROM cath_reprocessing_category_policies', []],
      ['FROM cath_reprocessing_settings', []],
      ['FROM patient_bloodborne_markers', [REACTIVE_ROW]],
    ]);
    listCaseConsumableUsage.mockResolvedValue([]);
  });

  async function restrictionFor(role) {
    const res = await request(appFor(role)).get('/api/v1/cath-lab/cases/10/consumables');
    expect(res.status).toBe(200);
    return res.body.data.reuse_restriction;
  }

  it('the fixture really does produce a restricted status with a named marker', async () => {
    // Positive control: without this, an emptied projection below would be
    // indistinguishable from a fixture that never had anything to redact.
    const doctor = await restrictionFor('DOCTOR');
    expect(doctor.status).toBe('restricted');
    expect(doctor.reasons).toEqual(['HBsAg reactive 2026-08-12']);
    expect(doctor.markers).toHaveLength(1);
    expect(doctor.markers[0]).toMatchObject({ marker: 'hbsag', result: 'reactive' });
  });

  it('a RECEPTIONIST gets the decision and NOT the marker that produced it', async () => {
    const reception = await restrictionFor('RECEPTIONIST');
    expect(reception.status).toBe('restricted');
    expect(reception.reasons).toEqual([]);
    expect(reception.markers).toEqual([]);
    // The shape is preserved so the published schema and the Staff app's
    // parsing hold: emptied, never dropped.
    expect(Object.keys(reception).sort())
      .toEqual(['evaluated_at', 'markers', 'reasons', 'status', 'validity_days']);
    expect(reception.validity_days).toBe(90);
    expect(typeof reception.evaluated_at).toBe('string');
  });

  it('a TECHNICIAN is projected too — cath report-read is not clinical staff', async () => {
    const technician = await restrictionFor('TECHNICIAN');
    expect(technician.reasons).toEqual([]);
    expect(technician.markers).toEqual([]);
  });

  it('GET /cases/:id projects the same key, so the case view is not the way round', async () => {
    const restriction = {
      status: 'restricted',
      reasons: ['HBsAg reactive 2026-08-12'],
      markers: [{ marker: 'hbsag', result: 'reactive', tested_on: '2026-08-12' }],
      validity_days: 90,
      evaluated_at: '2026-09-04T00:00:00.000Z',
    };
    getCase.mockResolvedValue({ id: 10, patient_uid: CASE_PATIENT, reuse_restriction: restriction });

    const reception = await request(appFor('RECEPTIONIST')).get('/api/v1/cath-lab/cases/10');
    expect(reception.status).toBe(200);
    expect(reception.body.data.case.reuse_restriction).toEqual({
      status: 'restricted', validity_days: 90, evaluated_at: '2026-09-04T00:00:00.000Z',
      reasons: [], markers: [],
    });
    // ...and the rest of the case is untouched.
    expect(reception.body.data.case.id).toBe(10);

    const doctor = await request(appFor('DOCTOR')).get('/api/v1/cath-lab/cases/10');
    expect(doctor.body.data.case.reuse_restriction).toEqual(restriction);
  });
});

describe('the FROZEN serology screens on a usage row are projected by the same rule', () => {
  // reuse_screen / post_use_screen (migration 765) are a snapshot of the same
  // restriction the live strip carries, taken at capture and at post-use. They
  // are spec §7.4 evidence and must not be edited, so the only place they can
  // be redacted is on the way out.
  //
  // cathLabService.CATH_CONSUMABLE_USAGE_SELECT does not return either column
  // today — which is exactly why this suite mocks the service rather than the
  // database. It pins the ROUTE's behaviour for the day someone adds
  // `u.reuse_screen,` to that SELECT: report-read admits RECEPTIONIST and
  // TECHNICIAN, so an unprojected column would hand them the marker identity
  // that projectReuseRestrictionForRole redacts one key over.
  const SCREEN = Object.freeze({
    status: 'restricted',
    reasons: ['HBsAg reactive 2026-08-12'],
    markers: [{ marker: 'hbsag', result: 'reactive', tested_on: '2026-08-12' }],
    validity_days: 90,
    evaluated_at: '2026-09-04T00:00:00.000Z',
  });
  const REDACTED = {
    status: 'restricted', validity_days: 90, evaluated_at: '2026-09-04T00:00:00.000Z',
    reasons: [], markers: [],
  };
  const usageRow = () => ({
    id: 501, tenant_id: TENANT, case_id: 10, catalog_item_id: 5, patient_uid: CASE_PATIENT,
    quantity: 1, wasted: false, is_implant: false, category: 'catheter', device_id: null,
    post_use_disposition: 'sent_for_reprocessing', metadata: {},
    reuse_screen: { ...SCREEN }, post_use_screen: { ...SCREEN },
  });

  beforeEach(() => {
    dispatch([
      ['FROM cath_lab_cases', [{
        id: 10n, tenant_id: TENANT, patient_uid: CASE_PATIENT, encounter_id: null,
        facility_id: 4, status: 'completed', actual_start_at: null,
      }]],
      ['FROM cath_reprocessing_category_policies', []],
      ['FROM cath_reprocessing_settings', []],
      ['FROM patient_bloodborne_markers', []],
    ]);
    listCaseConsumableUsage.mockResolvedValue([usageRow()]);
  });

  async function consumableRowFor(role) {
    const res = await request(appFor(role)).get('/api/v1/cath-lab/cases/10/consumables');
    expect(res.status).toBe(200);
    expect(res.body.data.usage).toHaveLength(1);
    return res.body.data.usage[0];
  }

  it('a DOCTOR reads both frozen screens whole', async () => {
    // Positive control: without it, an emptied projection below would be
    // indistinguishable from a fixture that never carried a marker.
    const row = await consumableRowFor('DOCTOR');
    expect(row.reuse_screen).toEqual(SCREEN);
    expect(row.post_use_screen).toEqual(SCREEN);
  });

  it('a RECEPTIONIST gets the frozen DECISION and no marker or reason from either screen', async () => {
    const row = await consumableRowFor('RECEPTIONIST');
    expect(row.reuse_screen).toEqual(REDACTED);
    expect(row.post_use_screen).toEqual(REDACTED);
    // Emptied, never dropped — the shape a client parses is unchanged.
    expect(Object.keys(row.reuse_screen).sort())
      .toEqual(['evaluated_at', 'markers', 'reasons', 'status', 'validity_days']);
    // ...and the rest of the decorated row survives untouched.
    expect(row.id).toBe(501);
    expect(row.allowed_post_use.reason_codes).toEqual(['already_recorded']);
  });

  it('a TECHNICIAN is projected too', async () => {
    const row = await consumableRowFor('TECHNICIAN');
    expect(row.reuse_screen.markers).toEqual([]);
    expect(row.post_use_screen.reasons).toEqual([]);
  });

  it('GET /cases/:id projects the usage rows it embeds, so the case view is not the way round', async () => {
    getCase.mockResolvedValue({
      id: 10, patient_uid: CASE_PATIENT, consumable_usage: [usageRow()], reuse_restriction: SCREEN,
    });

    const reception = await request(appFor('RECEPTIONIST')).get('/api/v1/cath-lab/cases/10');
    expect(reception.status).toBe(200);
    expect(reception.body.data.case.consumable_usage[0].reuse_screen).toEqual(REDACTED);
    expect(reception.body.data.case.consumable_usage[0].post_use_screen).toEqual(REDACTED);

    const doctor = await request(appFor('DOCTOR')).get('/api/v1/cath-lab/cases/10');
    expect(doctor.body.data.case.consumable_usage[0].reuse_screen).toEqual(SCREEN);
  });

  it('a case with no usage list does not grow one', async () => {
    // The projection maps a list; it must not invent the key on a response
    // that never had it — CathLabCase is additionalProperties:false.
    getCase.mockResolvedValue({ id: 10, patient_uid: CASE_PATIENT, reuse_restriction: SCREEN });

    const reception = await request(appFor('RECEPTIONIST')).get('/api/v1/cath-lab/cases/10');
    expect(reception.status).toBe(200);
    expect('consumable_usage' in reception.body.data.case).toBe(false);
  });
});

describe('pre-cath lab readiness: serology VALUES are projected by the same rule', () => {
  // The premise of this suite, one surface over. GET /cases/:id/readiness/labs
  // and the lab_readiness block on GET /cases/:id are cath REPORT-READ — which
  // is right, the front desk needs "labs pending" before the case is called —
  // but the items carry value_text / value_numeric / abnormal_flag for hiv,
  // hbsag and hcv. Handing a RECEPTIONIST "hbsag: reactive" one key away from
  // the reuse strip this file redacts would make the checklist the way round
  // the projection. Same for CRITICALITY: only a reactive marker is critical,
  // so is_critical on the hbsag row, and the bare code in critical_items (top
  // level AND in the labs check's metadata), name what the values withhold.
  const READINESS_ITEM = (overrides) => ({
    item_code: 'hb', required: true, state: 'result_final', value_text: '12.4',
    value_numeric: 12.4, unit: 'g/dL', abnormal_flag: null, is_critical: false,
    observed_at: '2026-09-01T04:00:00.000Z', source: 'lab_result', lab_result_id: 41,
    investigation_id: null, specimen_id: null, ordered_at: null,
    waived_by: null, waived_at: null, waive_reason: null, ...overrides,
  });
  const REACTIVE_HBSAG = READINESS_ITEM({
    item_code: 'hbsag', value_text: 'reactive', value_numeric: null, unit: null,
    abnormal_flag: 'AA', is_critical: true, lab_result_id: 77,
  });
  const CRITICAL_POTASSIUM = READINESS_ITEM({
    item_code: 'potassium', value_text: '6.9', value_numeric: 6.9, unit: 'mmol/L',
    abnormal_flag: 'HH', is_critical: true, lab_result_id: 42,
  });
  const readiness = () => ({
    case_id: 10, check_status: 'pending', auto_managed: true, critical_warning: true,
    critical_items: ['potassium', 'hbsag'],
    items: [READINESS_ITEM({}), { ...CRITICAL_POTASSIUM }, { ...REACTIVE_HBSAG }],
    missing: [], orderable_now: [], open_order_codes: [],
    settings: {
      lab_validity_days: 30, serology_validity_days: 90, auto_pass: true,
      external_results_count: true,
      required_items: ['hb', 'platelets', 'creatinine', 'potassium', 'hiv', 'hbsag', 'hcv'],
    },
    case_started: false,
  });
  const labsCheckRow = () => ({
    id: 5, check_type: 'labs', status: 'pending', required: true,
    metadata: {
      auto_managed: true, critical_warning: true, critical_items: ['potassium', 'hbsag'],
      auto_pending_reason: 'hiv not ordered',
      live_evidence: [READINESS_ITEM({}), { ...CRITICAL_POTASSIUM }, { ...REACTIVE_HBSAG }],
      live_evidence_refreshed_at: '2026-09-04T00:00:00.000Z',
    },
  });

  const hbsagOf = (items) => items.find((row) => row.item_code === 'hbsag');

  beforeEach(() => {
    refreshCaseLabReadiness.mockResolvedValue(readiness());
    getCase.mockResolvedValue({
      id: 10, patient_uid: CASE_PATIENT,
      lab_readiness: readiness(), readiness: [labsCheckRow()],
    });
  });

  it('positive control: a CATH_LAB_STAFF reads the reactive marker on both surfaces', async () => {
    // Without this, an emptied projection below is indistinguishable from a
    // fixture that never carried a value.
    const labs = await request(appFor('CATH_LAB_STAFF'))
      .get('/api/v1/cath-lab/cases/10/readiness/labs');
    expect(labs.status).toBe(200);
    expect(hbsagOf(labs.body.data.items)).toMatchObject({
      value_text: 'reactive', abnormal_flag: 'AA', is_critical: true,
    });
    expect(labs.body.data.critical_items).toEqual(['potassium', 'hbsag']);

    const view = await request(appFor('CATH_LAB_STAFF')).get('/api/v1/cath-lab/cases/10');
    expect(view.status).toBe(200);
    expect(hbsagOf(view.body.data.case.lab_readiness.items).value_text).toBe('reactive');
    expect(view.body.data.case.lab_readiness.critical_items).toEqual(['potassium', 'hbsag']);
    expect(hbsagOf(view.body.data.case.readiness[0].metadata.live_evidence).value_text)
      .toBe('reactive');
    expect(hbsagOf(view.body.data.case.readiness[0].metadata.live_evidence).is_critical)
      .toBe(true);
    expect(view.body.data.case.readiness[0].metadata.critical_items)
      .toEqual(['potassium', 'hbsag']);
  });

  it('a RECEPTIONIST gets the STATE and a null value on the readiness GET', async () => {
    const res = await request(appFor('RECEPTIONIST'))
      .get('/api/v1/cath-lab/cases/10/readiness/labs');

    expect(res.status).toBe(200);
    const hbsag = hbsagOf(res.body.data.items);
    expect(hbsag.value_text).toBeNull();
    expect(hbsag.value_numeric).toBeNull();
    expect(hbsag.abnormal_flag).toBeNull();
    // The checklist the front desk is admitted for is all still there.
    expect(hbsag.state).toBe('result_final');
    expect(hbsag.observed_at).toBe('2026-09-01T04:00:00.000Z');
    expect(hbsag.source).toBe('lab_result');
    // Criticality on a qualitative marker IS the result: false, key kept.
    expect(hbsag.is_critical).toBe(false);
    // ...and the name is not left sitting in the critical list either, while
    // the advisory that SOME critical value exists still stands.
    expect(res.body.data.critical_items).toEqual(['potassium']);
    expect(res.body.data.critical_warning).toBe(true);
    // Blanked, never dropped: CathLabReadinessItem is additionalProperties:false
    // with every key required, so the key set must not move.
    expect(Object.keys(hbsag).sort()).toEqual(Object.keys(REACTIVE_HBSAG).sort());
    // ...and the quantitative items beside it are untouched: the critical
    // potassium is still named, still flagged, still valued.
    expect(res.body.data.items[0]).toMatchObject({ item_code: 'hb', value_text: '12.4' });
    expect(res.body.data.items[1]).toEqual(CRITICAL_POTASSIUM);
  });

  it('a RECEPTIONIST gets the same treatment inside GET /cases/:id', async () => {
    const res = await request(appFor('RECEPTIONIST')).get('/api/v1/cath-lab/cases/10');

    expect(res.status).toBe(200);
    expect(hbsagOf(res.body.data.case.lab_readiness.items)).toMatchObject({
      value_text: null, value_numeric: null, abnormal_flag: null, state: 'result_final',
      is_critical: false,
    });
    expect(res.body.data.case.lab_readiness.critical_items).toEqual(['potassium']);
    // The labs CHECK row carries a verbatim copy of the same items in
    // metadata.live_evidence — redacting only lab_readiness would leave the
    // values one key over on the very same response.
    const evidence = res.body.data.case.readiness[0].metadata.live_evidence;
    expect(hbsagOf(evidence).value_text).toBeNull();
    expect(hbsagOf(evidence).abnormal_flag).toBeNull();
    expect(hbsagOf(evidence).is_critical).toBe(false);
    // metadata carries its OWN copy of critical_items — filtering only the
    // readiness block would leave the name one key over on this same response.
    expect(res.body.data.case.readiness[0].metadata.critical_items).toEqual(['potassium']);
    expect(res.body.data.case.readiness[0].metadata.critical_warning).toBe(true);
    expect(evidence).toHaveLength(3);
    expect(res.body.data.case.readiness[0].metadata.auto_pending_reason).toBe('hiv not ordered');
  });

  it('a TECHNICIAN is projected too — cath report-read is not clinical staff', async () => {
    const res = await request(appFor('TECHNICIAN'))
      .get('/api/v1/cath-lab/cases/10/readiness/labs');

    expect(res.status).toBe(200);
    expect(hbsagOf(res.body.data.items).value_text).toBeNull();
    expect(hbsagOf(res.body.data.items).is_critical).toBe(false);
    expect(res.body.data.critical_items).toEqual(['potassium']);
  });

  it('a null lab_readiness (degraded refresh) does not become an object', async () => {
    getCase.mockResolvedValue({ id: 10, patient_uid: CASE_PATIENT, lab_readiness: null });

    const res = await request(appFor('RECEPTIONIST')).get('/api/v1/cath-lab/cases/10');

    expect(res.status).toBe(200);
    expect(res.body.data.case.lab_readiness).toBeNull();
    // ...and a case row that carried no readiness list does not grow one.
    expect('readiness' in res.body.data.case).toBe(false);
  });
});

describe('the printed CSSD device label carries no patient or serology data', () => {
  // The physical label travels with the device: out of CSSD, along a corridor,
  // onto a tray in the cath lab. Everything on it is device identity — tag,
  // catalogue item, category, cycle N of max, facility, print time — and the
  // one device column that is NOT identity is exposure_markers, which names a
  // blood-borne marker a PREVIOUS patient tested reactive for. That belongs on
  // the console (where a role gate decides who reads it, see the lookup suite
  // above) and never on a sticker. So the assertion is a key-set equality, for
  // every role that can reach the route, not a spot check.
  const LABEL_ROW = {
    id: 77n,
    device_tag: 'RP00000077',
    cycle_count: 1,
    max_cycles_snapshot: 3,
    facility_id: 4,
    item_name: 'Diagnostic catheter',
    category: 'catheter',
    facility_name: 'Venkataeswara Hospitals, Nandanam',
  };
  // Anything a serology-bearing surface on this router could leak. `patient`
  // catches patient_uid; the three marker codes catch exposure_markers.
  const FORBIDDEN = /hbsag|\bhiv\b|\bhcv\b|patient|serolog|exposure|reactive/i;

  beforeEach(() => {
    dispatch([['FROM cath_reprocessable_devices d', [LABEL_ROW]]]);
  });

  it.each([...CSSD_DEVICE_ROUTE_ROLES])(
    'a %s reads exactly the seven label fields and nothing patient-shaped',
    async (role) => {
      const res = await request(appFor(role))
        .get('/api/v1/cssd/devices/77/label?format=json');

      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data).sort()).toEqual([...DEVICE_LABEL_FIELDS].sort());
      expect(res.body.data).toMatchObject({
        device_tag: 'RP00000077',
        category: 'catheter',
        catalogue_item: 'Diagnostic catheter',
        reuse_cycle: 1,
        max_cycles: 3,
        facility_name: 'Venkataeswara Hospitals, Nandanam',
      });
      // Not just the top-level keys: nothing ANYWHERE in the answer.
      expect(JSON.stringify(res.body)).not.toMatch(FORBIDDEN);
    },
  );

  it('the published seven are the seven the service returns', () => {
    // DEVICE_LABEL_FIELDS is what the OpenAPI overlay is pinned against
    // (cathDeviceReuseOpenApiSource.test.js); this asserts the runtime answer
    // matches it, so neither copy can move alone.
    expect([...DEVICE_LABEL_FIELDS]).toEqual([
      'device_tag', 'category', 'catalogue_item', 'reuse_cycle',
      'max_cycles', 'facility_name', 'printed_at',
    ]);
  });

  it('defaults to a PDF, and the bytes really are one', async () => {
    const res = await request(appFor('OT_NURSE'))
      .get('/api/v1/cssd/devices/77/label')
      .buffer(true)
      .parse(binaryParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(Number(res.headers['content-length'])).toBe(res.body.length);
  });

  it('writes one cssd.device.label_printed audit row naming the tag and the format', async () => {
    executeRawUnsafeMock.mockClear();
    await request(appFor('OT_NURSE')).get('/api/v1/cssd/devices/77/label?format=json');

    const audits = executeRawUnsafeMock.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO audit_logs'));
    expect(audits).toHaveLength(1);
    const [, tenantArg, , , action, resource, resourceId, metadata] = audits[0];
    expect(action).toBe('cssd.device.label_printed');
    expect(resource).toBe('cath_reprocessable_devices');
    expect(resourceId).toBe('77');
    expect(tenantArg).toBe(TENANT);
    expect(JSON.parse(metadata)).toEqual({ device_tag: 'RP00000077', format: 'json' });
    // No PHI access row: the label has no patient subject to log one against.
    expect(logPhiAccess).not.toHaveBeenCalled();
    expect(logPhiAccessBatch).not.toHaveBeenCalled();
  });

  it('looks the device up TENANT-PINNED, inside a tenant-scoped transaction', async () => {
    queryRawUnsafeMock.mockClear();
    setTenantTx.mockClear();
    await request(appFor('OT_NURSE')).get('/api/v1/cssd/devices/77/label?format=json');

    const [sql, ...params] = queryRawUnsafeMock.mock.calls
      .find(([text]) => String(text).includes('FROM cath_reprocessable_devices d'));
    expect(sql).toContain('d.tenant_id = $1::uuid');
    // The catalogue and facility joins are tenant-pinned too: a bare id join
    // would name another tenant's facility on this tenant's label.
    expect(sql).toContain('c.tenant_id = d.tenant_id');
    expect(sql).toContain('f.tenant_id = d.tenant_id');
    expect(params).toEqual([TENANT, 77]);
    expect(setTenantTx).toHaveBeenCalledWith(TENANT, expect.any(Function));
  });

  it('an unknown device id is a 404, not an empty label', async () => {
    dispatch([['FROM cath_reprocessable_devices d', []]]);

    const res = await request(appFor('OT_NURSE'))
      .get('/api/v1/cssd/devices/999/label?format=json');

    expect(res.status).toBe(404);
    // AppError codes with no details ride at the TOP level of the envelope,
    // not under `details` (responseHelper.error's topLevel branch).
    expect(res.body.code).toBe('CATH_DEVICE_NOT_FOUND');
  });

  it('a non-numeric id is a 400 before any lookup', async () => {
    queryRawUnsafeMock.mockClear();

    const res = await request(appFor('OT_NURSE'))
      .get('/api/v1/cssd/devices/7e2/label?format=json');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CATH_LAB_BAD_ID');
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('an unknown format is a 400, not a silent PDF', async () => {
    const res = await request(appFor('OT_NURSE'))
      .get('/api/v1/cssd/devices/77/label?format=xlsx');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CSSD_DEVICE_LABEL_FORMAT_INVALID');
  });

  it('the label is behind the /devices narrowing, not the wider CSSD mount', async () => {
    // HR_STAFF holds the CSSD mount (the audit-facing board) and not the
    // device sub-tree. A label print is a device read like any other.
    const refused = await request(appFor('HR_STAFF'))
      .get('/api/v1/cssd/devices/77/label?format=json');
    expect(refused.status).toBe(403);

    // ...and the same account still reads the board it IS admitted for.
    const board = await request(appFor('HR_STAFF')).get('/api/v1/cssd/board');
    expect(board.status).toBe(200);
  });
});
