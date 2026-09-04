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
const { requireRole } = await import('../../middleware/rbacMiddleware.js');
const { DEVICE_HISTORY_PHI_BATCH_CAP } = await import('../../services/clinical/cathDeviceReuseService.js');
const {
  CATH_LAB_ROUTE_ROLES,
  CATH_REPROCESSING_POLICY_ROUTE_ROLES,
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
  return app;
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

  it('more patients than the batch helper accepts are capped, not dropped wholesale', async () => {
    // logPhiAccessBatch throws above 25 entries; an uncapped call would lose
    // every row instead of the overflow.
    const many = Array.from({ length: 30 }, (_, index) => useRow(
      1000 + index,
      `dddddddd-0000-4000-8000-${String(index).padStart(12, '0')}`,
    ));
    historyWith(many);

    await request(appFor('DOCTOR')).get('/api/v1/cath-lab/devices/77/history');

    expect(logPhiAccessBatch.mock.calls[0][0]).toHaveLength(DEVICE_HISTORY_PHI_BATCH_CAP);
    expect(DEVICE_HISTORY_PHI_BATCH_CAP).toBe(25);
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
