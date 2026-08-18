/**
 * assignBedToAdmission — the door-to-bed interval on the audit record.
 *
 * `door_to_bed_minutes` is derived from `bed_pending_since_epoch_ms`, the
 * absolute-instant twin, not from the driver-materialised `bed_pending_since`
 * (PR #881). No mocked row reached this read, so it had no coverage: a dropped
 * twin makes `epochMsOrNull` return null and the audit record silently reports
 * `door_to_bed_minutes: null` for a patient who genuinely waited.
 *
 * That figure is the boarding-time evidence on ASSIGN_BED_TO_ADMISSION, so it
 * is worth pinning in both directions — a real wait, and a bed assigned with no
 * pending interval at all (a direct admission, where NULL is correct).
 */

import { jest } from '@jest/globals';

const txQueryTagged = jest.fn();
const txQueryUnsafe = jest.fn(async () => []);
const usersFindFirst = jest.fn();
const admissionsFindFirst = jest.fn();
const bedsUpdate = jest.fn(async () => ({}));
const admissionsUpdate = jest.fn(async (args) => ({ id: 31, ...args?.data }));
const bedTransfersCreate = jest.fn(async () => ({}));
const auditLogsCreate = jest.fn(async () => ({}));

// assignBedToAdmission touches a number of delegates that have nothing to do
// with the interval under test (ward screening level, canonical event rows).
// Explicit stubs cover everything the assertions depend on; the Proxy supplies
// inert no-ops for the rest so the flow reaches the audit write, rather than
// this test turning into a transcription of unrelated call sites.
const explicitDelegates = {
  users: { findFirst: usersFindFirst },
  admissions: { findFirst: admissionsFindFirst, update: admissionsUpdate },
  beds: { update: bedsUpdate },
  bed_transfers: { create: bedTransfersCreate },
  audit_logs: { create: auditLogsCreate },
};

const inertDelegate = new Proxy({}, {
  get: () => async () => null,
});

const txStub = new Proxy({
  $queryRaw: (...args) => txQueryTagged(...args),
  $queryRawUnsafe: (...args) => txQueryUnsafe(...args),
  ...explicitDelegates,
}, {
  get: (target, prop) => (prop in target ? target[prop] : inertDelegate),
});

// The module graph reaches more of lib/prisma.js than this test uses, and an
// ESM module mock must supply every named export the graph binds — a missing
// one fails the whole suite at load, not at the call site.
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: txQueryUnsafe, $queryRaw: txQueryTagged },
  prismaReadOnly: { $queryRawUnsafe: txQueryUnsafe },
  setTenantTx: async (_tenantId, fn) => fn(txStub),
  setTenant: async (_tenantId, fn) => fn(txStub),
  isTenantTransactionClient: () => true,
  pinSessionTimeZoneToUrl: (url) => url,
  circuitBreakerStatus: () => ({ open: false, consecutiveFailures: 0 }),
  __resetCircuitBreakerForTests: () => {},
  tenantRlsRuntimeRole: () => 'vhhealth',
  evaluateTenantRlsPosture: () => ({ ok: true }),
  tenantRlsRolePosture: async () => ({ ok: true }),
  rlsDisabledLogLevel: () => 'debug',
  logTenantRlsRolePosture: async () => {},
  tenantRlsPostureMustFailClosed: () => false,
  ensureTenantRlsRuntimeRoleGrants: async () => {},
}));

// The canonical timeline write is strict: assignBedToAdmission aborts if it
// does not return a row (the timeline invariant in apps/backend/CLAUDE.md).
// Returning a stub row lets the flow reach its natural end; the invariant
// itself is covered by canonicalTimelineCoverage.test.js, not here.
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  // The one that matters: a strict write must return a row or the
  // transaction aborts before the assertion can run.
  recordCanonicalClinicalEvent: jest.fn(async () => ({ timeline: { id: 1 }, audit: { id: 1 } })),
  currentCanonicalTransactionRevision: jest.fn(async () => 1),
  isSchemaMissing: () => false,
  CANONICAL_GLOBAL_TENANT_SENTINEL: '00000000-0000-0000-0000-000000000000',
  cancelWorkflowSla: jest.fn(async () => null),
  completeWorkflowSla: jest.fn(async () => null),
  ensureEncounterForAppointment: jest.fn(async () => null),
  evaluateMedicationSafety: jest.fn(async () => null),
  getClinicalDocumentationTemplates: jest.fn(async () => null),
  getClinicalDowntimePolicy: jest.fn(async () => null),
  getEncounter: jest.fn(async () => null),
  listClinicalAuditEvents: jest.fn(async () => null),
  listMedicationSafetyReviews: jest.fn(async () => null),
  listWorkflowSlaInstances: jest.fn(async () => null),
  readCanonicalPatientTimeline: jest.fn(async () => null),
  recordClinicalAuditEvent: jest.fn(async () => null),
  recordMedicationSafetyReviews: jest.fn(async () => null),
  recordTimelineEvent: jest.fn(async () => null),
  startWorkflowSla: jest.fn(async () => null),
  transitionEncounter: jest.fn(async () => null),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

// Keeping the pathway mode out of ACTIVE skips the primary-physician assertion,
// which is unrelated to the interval under test.
jest.unstable_mockModule('../../services/emr/inpatientPathwayDomainService.js', () => ({
  establishInitialPrimaryPhysicianTx: jest.fn(async () => null),
  getInpatientDischargeEvidence: jest.fn(async () => null),
  getInpatientDischargeEvidenceTx: jest.fn(async () => null),
  publishInpatientSourceEventTx: jest.fn(async () => null),
  recordPrimaryPhysicianChangeTx: jest.fn(async () => null),
  resolveInpatientPathwayModeTx: jest.fn(async () => 'off'),
}));

const admissionService = (await import('../../services/emr/admissionService.js')).default;

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const ASSIGNED_BY = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  [txQueryTagged, txQueryUnsafe, usersFindFirst, admissionsFindFirst,
    bedsUpdate, admissionsUpdate, bedTransfersCreate, auditLogsCreate].forEach((m) => m.mockReset());
  txQueryUnsafe.mockResolvedValue([]);
  usersFindFirst.mockResolvedValue({ id: 5, name: 'Test Patient' });
  admissionsFindFirst.mockResolvedValue({ expected_los_days: null, admitted_at: new Date() });
  bedsUpdate.mockResolvedValue({});
  admissionsUpdate.mockResolvedValue({ id: 31, bed_id: 12 });
  bedTransfersCreate.mockResolvedValue({});
  auditLogsCreate.mockResolvedValue({});
});

/**
 * `pendingMinutes: null` models a direct admission that never boarded — a
 * genuine SQL NULL, where a null interval is the right answer.
 */
function mockAssignment({ pendingMinutes }) {
  const admission = {
    id: 31,
    tenant_id: TENANT,
    patient_uid: PATIENT_UID,
    status: 'admitted',
    bed_id: null,
    admission_type: 'inpatient',
    ward: 'General',
    bed_pending_since: null,
    bed_pending_since_epoch_ms: null,
  };
  if (pendingMinutes != null) {
    const since = new Date(Date.now() - pendingMinutes * 60000);
    admission.bed_pending_since = since.toISOString();
    admission.bed_pending_since_epoch_ms = BigInt(since.getTime());
  }

  const bed = {
    id: 12, status: 'available', bed_number: 'B-12',
    bed_type: 'general', ward_id: 3, ward_name: 'General',
  };

  // Tagged-template calls arrive as (stringsArray, ...values); joining the
  // static parts is enough to tell the two reads apart.
  txQueryTagged.mockImplementation(async (strings) => {
    const text = Array.isArray(strings) ? strings.join(' ? ') : String(strings);
    if (text.includes('FROM admissions')) return [admission];
    if (text.includes('FROM beds')) return [bed];
    throw new Error(`Unexpected tagged query in assignBedToAdmission unit test: ${text}`);
  });
}

const auditMetadata = () => auditLogsCreate.mock.calls[0][0].data.metadata;

test('the audit record carries the real boarding wait, read from the instant twin', async () => {
  mockAssignment({ pendingMinutes: 90 });

  await admissionService.assignBedToAdmission(31, 12, ASSIGNED_BY, { tenantId: TENANT });

  expect(auditLogsCreate).toHaveBeenCalledTimes(1);
  expect(auditMetadata()).toMatchObject({
    bed_number: 'B-12',
    door_to_bed_minutes: 90,
  });
});

test('a bed assigned with no pending interval records a null wait, not a 1970 one', async () => {
  // bed_pending_since is a genuine SQL NULL here. The distinction that matters:
  // null, and emphatically not the ~29,000,000 minutes an epoch-0 read gives.
  mockAssignment({ pendingMinutes: null });

  await admissionService.assignBedToAdmission(31, 12, ASSIGNED_BY, { tenantId: TENANT });

  expect(auditMetadata().door_to_bed_minutes).toBeNull();
});
