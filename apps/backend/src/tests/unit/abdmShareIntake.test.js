/**
 * Scan & Share intake (migration 702) — unit suite, DB + abdmFull mocked.
 *
 * Pins:
 *   1. Callback intake: transport evidence recorded as a PLAIN
 *      abdm_webhook_events row via recordWebhookEvent (receipt_source stays
 *      NULL — 618's CHECK pins non-NULL receipt_source to the two I16 paths),
 *      tenant_id EXPLICIT on the intake INSERT (pre-RLS mount), CM
 *      redeliveries collapse to duplicate=true (202 replay-safe upstream).
 *   2. Fail-closed tenant handling: no tenant context ⇒ throw before any write.
 *   3. Front-desk transitions: match/register/link-visit/dismiss with the
 *      service transition map; the guarded registration flow (exact-phone
 *      probe + dedupe scan ⇒ 409 PATIENT_DUPLICATE_REVIEW_REQUIRED until an
 *      audited override), ABHA linkage riding registerABHA without ever
 *      failing the registration.
 *   4. Shared-profile allowlist: KYC/Aadhaar-adjacent fields are dropped.
 */
import { jest } from '@jest/globals';

const prismaQuery = jest.fn();
const prismaExecute = jest.fn();
// Transaction client handed out by the setTenantTx mock: shares the same
// route dispatch, but is a DISTINCT spy so tests can assert which writes ran
// inside the registration transaction vs on the plain client.
const txQuery = jest.fn(async (sql, ...args) => dispatch(sql, args));
const txExecute = jest.fn(async (sql, ...args) => dispatch(sql, args));
const setTenantTxMock = jest.fn(async (_tenant, fn) => fn({
  $queryRawUnsafe: txQuery, $executeRawUnsafe: txExecute,
}));
const setSystemJobTxMock = jest.fn(async (fn) => fn({
  $queryRawUnsafe: txQuery, $executeRawUnsafe: txExecute,
}));
const recordWebhookEvent = jest.fn();
const markWebhookProcessed = jest.fn();
const findRegistrationDuplicateCandidates = jest.fn();
const recordRegistrationDuplicateOverride = jest.fn();
const registerABHA = jest.fn();
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: prismaQuery, $executeRawUnsafe: prismaExecute },
  setTenant: jest.fn(),
  setTenantTx: setTenantTxMock,
  setSystemJobTx: setSystemJobTxMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../../services/abdmFull/abdmHipHiuService.js', () => ({
  recordWebhookEvent,
  markWebhookProcessed,
}));
jest.unstable_mockModule('../../services/patient/patientDedupeService.js', () => ({
  findRegistrationDuplicateCandidates,
  recordRegistrationDuplicateOverride,
}));
jest.unstable_mockModule('../../services/abdm/abdmService.js', () => ({
  default: { registerABHA },
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (tenantId) => {
    if (!tenantId) {
      const err = new Error('Tenant context is required');
      err.isOperational = true;
      err.statusCode = 403;
      err.code = 'TENANT_REQUIRED';
      throw err;
    }
    return tenantId;
  },
}));

const shareIntakeService = (await import('../../services/abdm/abdmShareIntakeService.js')).default;

const TENANT_ID = '70200000-0000-4000-8000-00000000b002';
const PATIENT_UID = '70200000-0000-4000-8000-0000000007b2';
const NEW_UID = '70200000-0000-4000-8000-0000000007b3';

const BASE_INTAKE = {
  id: 21,
  tenant_id: TENANT_ID,
  environment: 'sandbox',
  request_id: 'req-abc',
  token_number: 'T-21',
  counter_context: 'counter-1',
  abha_number: '91-1234-5678-9012',
  abha_address: 'asha@sbx',
  profile: { name: 'Asha Patient', gender: 'F', yearOfBirth: '1990', mobile: '9876543210' },
  status: 'received',
  matched_patient_uid: null,
  linked_appointment_id: null,
  processed_at: null,
  received_at: new Date(),
  expires_at: new Date(Date.now() + 30 * 60 * 1000),
  metadata: {},
};

let routes;
function route(needle, impl) {
  routes.unshift([needle, impl]);
}
function dispatch(sql, args) {
  for (const [needle, impl] of routes) {
    if (sql.includes(needle)) return impl(sql, args);
  }
  return [];
}

beforeEach(() => {
  jest.clearAllMocks();
  routes = [];
  prismaQuery.mockImplementation(async (sql, ...args) => dispatch(sql, args));
  prismaExecute.mockImplementation(async (sql, ...args) => dispatch(sql, args));
  recordWebhookEvent.mockResolvedValue({
    event: { id: '31', event_type: 'patient_profile_share', status: 'pending' },
    duplicate: false,
  });
  markWebhookProcessed.mockResolvedValue({ id: '31', status: 'processed' });
  findRegistrationDuplicateCandidates.mockResolvedValue({ candidates: [] });
  recordRegistrationDuplicateOverride.mockResolvedValue({ recorded: 1 });
  registerABHA.mockResolvedValue({ linked: true, verification_status: 'verified' });
});

const SHARE_BODY = {
  requestId: 'req-abc',
  timestamp: new Date().toISOString(),
  profile: {
    hipCode: 'counter-1',
    patient: {
      abhaNumber: '91123456789012',
      abhaAddress: 'Asha@sbx',
      name: 'Asha Patient',
      gender: 'F',
      yearOfBirth: '1990',
      mobile: '9876543210',
      kycVerified: 'true',
      aadhaarLast4: '9999',
    },
  },
};

describe('handlePatientProfileShareCallback', () => {
  it('records plain webhook evidence + the intake row with EXPLICIT tenant_id', async () => {
    route('INSERT INTO abdm_patient_share_intakes', (sql, args) => {
      // Pre-RLS mount: the tenant is the FIRST bound arg, never defaulted.
      expect(args[0]).toBe(TENANT_ID);
      expect(sql).toContain('ON CONFLICT (tenant_id, request_id, environment) DO NOTHING');
      return [BASE_INTAKE];
    });

    const result = await shareIntakeService.handlePatientProfileShareCallback({
      tenantId: TENANT_ID, environment: 'sandbox', body: SHARE_BODY,
    });

    expect(result.duplicate).toBe(false);
    expect(result.tokenNumber).toBe('T-21');
    // Plain 124-shape evidence row — recordWebhookEvent, NOT the I16 intake
    // (recordAuthenticatedAbdmCallback would trip 618's receipt-shape CHECK).
    expect(recordWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID,
      externalEventId: 'req-abc',
      eventType: 'patient_profile_share',
      signatureVerified: true,
      environment: 'sandbox',
    }));
    expect(markWebhookProcessed).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID, id: 31, status: 'processed',
    }));
  });

  it('allowlists the shared profile — KYC/Aadhaar-adjacent fields never persist', async () => {
    let storedProfile;
    route('INSERT INTO abdm_patient_share_intakes', (sql, args) => {
      storedProfile = JSON.parse(args[7]);
      return [BASE_INTAKE];
    });

    await shareIntakeService.handlePatientProfileShareCallback({
      tenantId: TENANT_ID, environment: 'sandbox', body: SHARE_BODY,
    });

    expect(storedProfile).toEqual({
      name: 'Asha Patient', gender: 'F', yearOfBirth: '1990', mobile: '9876543210',
    });
    expect(JSON.stringify(storedProfile)).not.toContain('9999');
    expect(storedProfile).not.toHaveProperty('kycVerified');
    expect(storedProfile).not.toHaveProperty('aadhaarLast4');
  });

  it('collapses a CM redelivery to duplicate=true and marks the event duplicate', async () => {
    route('INSERT INTO abdm_patient_share_intakes', () => []); // ON CONFLICT DO NOTHING
    route('SELECT id, tenant_id, environment', () => [BASE_INTAKE]);
    recordWebhookEvent.mockResolvedValue({
      event: { id: '31', event_type: 'patient_profile_share', status: 'duplicate' },
      duplicate: true,
    });

    const result = await shareIntakeService.handlePatientProfileShareCallback({
      tenantId: TENANT_ID, environment: 'sandbox', body: SHARE_BODY,
    });

    expect(result.duplicate).toBe(true);
    expect(result.intake.id).toBe(21);
    expect(markWebhookProcessed).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'duplicate' }),
    );
  });

  it('refuses a request id that collides with a DIFFERENT ABDM event type', async () => {
    recordWebhookEvent.mockResolvedValue({
      event: { id: '31', event_type: 'consent_on_notify' },
      duplicate: true,
    });

    await expect(shareIntakeService.handlePatientProfileShareCallback({
      tenantId: TENANT_ID, environment: 'sandbox', body: SHARE_BODY,
    })).rejects.toMatchObject({ code: 'ABDM_SHARE_EVENT_COLLISION', statusCode: 409 });
    expect(prismaQuery).not.toHaveBeenCalled();
  });

  it('fails closed without a tenant context — nothing is written', async () => {
    await expect(shareIntakeService.handlePatientProfileShareCallback({
      tenantId: null, environment: 'sandbox', body: SHARE_BODY,
    })).rejects.toMatchObject({ code: 'TENANT_REQUIRED' });
    expect(recordWebhookEvent).not.toHaveBeenCalled();
    expect(prismaQuery).not.toHaveBeenCalled();
  });

  it('requires a requestId', async () => {
    await expect(shareIntakeService.handlePatientProfileShareCallback({
      tenantId: TENANT_ID, environment: 'sandbox', body: { profile: {} },
    })).rejects.toMatchObject({ code: 'ABDM_SHARE_REQUEST_ID_REQUIRED' });
  });
});

describe('front-desk transitions', () => {
  it('match: received → matched with the resolving actor recorded', async () => {
    route('FROM users', () => [{ uid: PATIENT_UID }]);
    route('SELECT id, tenant_id, environment', () => [BASE_INTAKE]);
    route("status = 'matched'", (sql, args) => {
      expect(args[0]).toBe(21);
      expect(args[1]).toBe(TENANT_ID);
      expect(args[2]).toBe(PATIENT_UID);
      expect(sql).toContain("status IN ('received')");
      return [{ ...BASE_INTAKE, status: 'matched', matched_patient_uid: PATIENT_UID, processed_at: new Date() }];
    });

    const intake = await shareIntakeService.matchShareIntake({
      tenantId: TENANT_ID, intakeId: 21, patientUid: PATIENT_UID, actorUid: NEW_UID,
    });
    expect(intake.status).toBe('matched');
  });

  it('match refuses an unknown patient and a non-received intake', async () => {
    route('FROM users', () => []);
    await expect(shareIntakeService.matchShareIntake({
      tenantId: TENANT_ID, intakeId: 21, patientUid: PATIENT_UID,
    })).rejects.toMatchObject({ code: 'PATIENT_NOT_FOUND' });

    route('FROM users', () => [{ uid: PATIENT_UID }]);
    route('SELECT id, tenant_id, environment', () => [{ ...BASE_INTAKE, status: 'dismissed' }]);
    route("status = 'matched'", () => []);
    await expect(shareIntakeService.matchShareIntake({
      tenantId: TENANT_ID, intakeId: 21, patientUid: PATIENT_UID,
    })).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  it('register: exact-phone hit 409s PATIENT_DUPLICATE_REVIEW_REQUIRED with candidates', async () => {
    route('SELECT id, tenant_id, environment', () => [BASE_INTAKE]);
    route('SELECT id, uid, phone, name, role FROM users', () => [{
      id: 7, uid: PATIENT_UID, phone: '+919876543210', name: 'Asha Patient', role: 'PATIENT',
    }]);

    await expect(shareIntakeService.registerFromShareIntake({
      tenantId: TENANT_ID, intakeId: 21, actorUid: NEW_UID,
    })).rejects.toMatchObject({
      code: 'PATIENT_DUPLICATE_REVIEW_REQUIRED',
      statusCode: 409,
      details: expect.objectContaining({ duplicate_review_required: true }),
    });
  });

  it('register: dedupe candidates without an override reason 409 fail-closed', async () => {
    route('SELECT id, tenant_id, environment', () => [BASE_INTAKE]);
    route('SELECT id, uid, phone, name, role FROM users', () => []);
    findRegistrationDuplicateCandidates.mockResolvedValue({
      candidates: [{ uid: PATIENT_UID, confidence_score: 70 }],
    });

    await expect(shareIntakeService.registerFromShareIntake({
      tenantId: TENANT_ID, intakeId: 21, actorUid: NEW_UID, overrideReason: 'short',
    })).rejects.toMatchObject({ code: 'PATIENT_DUPLICATE_REVIEW_REQUIRED' });
    // Nothing was created.
    const insert = prismaQuery.mock.calls.find((c) => c[0].includes('INSERT INTO users'));
    expect(insert).toBeUndefined();
  });

  it('register: creates the patient, links ABHA via registerABHA, intake → registered', async () => {
    route('SELECT id, tenant_id, environment', () => [BASE_INTAKE]);
    route('SELECT id, uid, phone, name, role FROM users', () => []);
    route('INSERT INTO users', (sql, args) => {
      expect(args[0]).toBe('+919876543210');
      expect(args[1]).toBe('Asha Patient');
      expect(args[5]).toBe(TENANT_ID); // explicit tenant on the insert
      return [{ id: 99, uid: NEW_UID }];
    });
    route("status = 'registered'", (sql, args) => {
      expect(args[2]).toBe(NEW_UID);
      return [{ ...BASE_INTAKE, status: 'registered', matched_patient_uid: NEW_UID, processed_at: new Date() }];
    });

    const result = await shareIntakeService.registerFromShareIntake({
      tenantId: TENANT_ID, intakeId: 21, actorUid: NEW_UID, actorRole: 'RECEPTIONIST',
    });

    expect(result.patient.uid).toBe(NEW_UID);
    expect(result.intake.status).toBe('registered');
    expect(registerABHA).toHaveBeenCalledWith(
      NEW_UID, '91-1234-5678-9012', 'asha@sbx',
      expect.objectContaining({ tenantId: TENANT_ID, actorUid: NEW_UID }),
    );
    expect(result.abha_link).toMatchObject({ verification_status: 'verified' });
  });

  it('register: an ABHA linkage refusal is evidence, never a rollback', async () => {
    route('SELECT id, tenant_id, environment', () => [BASE_INTAKE]);
    route('SELECT id, uid, phone, name, role FROM users', () => []);
    route('INSERT INTO users', () => [{ id: 99, uid: NEW_UID }]);
    route("status = 'registered'", () => [{
      ...BASE_INTAKE, status: 'registered', matched_patient_uid: NEW_UID, processed_at: new Date(),
    }]);
    // Post-commit linkage stamp (metadata-only UPDATE, no status change).
    let recordedMeta;
    route('SET metadata = metadata || $3::jsonb', (sql, args) => {
      recordedMeta = JSON.parse(args[2]);
      return [{ ...BASE_INTAKE, status: 'registered', matched_patient_uid: NEW_UID, processed_at: new Date() }];
    });
    registerABHA.mockRejectedValue(Object.assign(new Error('gateway down'), {
      code: 'ABHA_VERIFICATION_FAILED', statusCode: 503, isOperational: true,
    }));

    const result = await shareIntakeService.registerFromShareIntake({
      tenantId: TENANT_ID, intakeId: 21, actorUid: NEW_UID,
    });

    expect(result.intake.status).toBe('registered');
    expect(result.abha_link).toBeNull();
    expect(result.abha_link_error).toBe('ABHA_VERIFICATION_FAILED');
    expect(recordedMeta.abha_link_error).toBe('ABHA_VERIFICATION_FAILED');
  });

  it('register core is atomic: a lost intake-state race rolls the whole registration back in ONE setTenantTx', async () => {
    // The intake left the registrable state between the pre-check and the
    // transition (e.g. concurrently dismissed). The transition returns no row
    // → the service throws INSIDE setTenantTx, so the user INSERT and the
    // override evidence roll back with it — no orphaned patient.
    route('SELECT id, tenant_id, environment', () => [BASE_INTAKE]);
    route('SELECT id, uid, phone, name, role FROM users', () => []);
    route('INSERT INTO users', () => [{ id: 99, uid: NEW_UID }]);
    route("status = 'registered'", () => []); // raced: no longer received/matched

    await expect(shareIntakeService.registerFromShareIntake({
      tenantId: TENANT_ID, intakeId: 21, actorUid: NEW_UID,
    })).rejects.toMatchObject({ code: 'ABDM_SHARE_INTAKE_STATE' });

    // The registration core ran on the TRANSACTION client…
    expect(setTenantTxMock).toHaveBeenCalledTimes(1);
    const txInsert = txQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO users'));
    expect(txInsert).toBeTruthy();
    // …not on the plain client (which would not roll back)…
    const plainInsert = prismaQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO users'));
    expect(plainInsert).toBeUndefined();
    // …and the post-commit ABHA phase never started.
    expect(registerABHA).not.toHaveBeenCalled();
  });

  it('register: an audited override reason creates anyway and records the override', async () => {
    route('SELECT id, tenant_id, environment', () => [BASE_INTAKE]);
    route('SELECT id, uid, phone, name, role FROM users', () => []);
    route('INSERT INTO users', () => [{ id: 99, uid: NEW_UID }]);
    route("status = 'registered'", () => [{ ...BASE_INTAKE, status: 'registered', matched_patient_uid: NEW_UID, processed_at: new Date() }]);
    findRegistrationDuplicateCandidates.mockResolvedValue({
      candidates: [{ uid: PATIENT_UID, confidence_score: 70 }],
    });

    const result = await shareIntakeService.registerFromShareIntake({
      tenantId: TENANT_ID, intakeId: 21, actorUid: NEW_UID,
      overrideReason: 'reviewed with patient at counter',
    });

    expect(result.duplicate_override).toBe(true);
    expect(recordRegistrationDuplicateOverride).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID,
      newPatientUid: NEW_UID,
      reason: 'reviewed with patient at counter',
    }));
  });

  it('link-visit requires a resolved intake and a tenant-scoped appointment of that patient', async () => {
    route('SELECT id, tenant_id, environment', () => [{ ...BASE_INTAKE, status: 'matched', matched_patient_uid: PATIENT_UID }]);
    route('FROM appointments a', (sql, args) => {
      expect(args).toEqual([301, TENANT_ID, PATIENT_UID]);
      return [{ id: 301 }];
    });
    route("status = 'linked_visit'", () => [{
      ...BASE_INTAKE, status: 'linked_visit', matched_patient_uid: PATIENT_UID, linked_appointment_id: 301,
    }]);

    const intake = await shareIntakeService.linkVisitToIntake({
      tenantId: TENANT_ID, intakeId: 21, appointmentId: 301, actorUid: NEW_UID,
    });
    expect(intake.status).toBe('linked_visit');

    // Unresolved intake refuses.
    route('SELECT id, tenant_id, environment', () => [BASE_INTAKE]);
    await expect(shareIntakeService.linkVisitToIntake({
      tenantId: TENANT_ID, intakeId: 21, appointmentId: 301,
    })).rejects.toMatchObject({ code: 'ABDM_SHARE_INTAKE_UNRESOLVED' });
  });

  it('sweep expires only unactioned received intakes', async () => {
    route("SET status = 'expired'", (sql) => {
      expect(sql).toContain("status = 'received'");
      return [{ id: 1 }];
    });
    const result = await shareIntakeService.sweepExpiredShareIntakes();
    expect(result).toEqual({ expired: 1 });
  });
});
