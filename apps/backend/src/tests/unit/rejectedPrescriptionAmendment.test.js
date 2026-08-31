import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { jest } from '@jest/globals';

const txQuery = jest.fn();
const txExecute = jest.fn();
const setTenantTx = jest.fn();
const lockTenantPatientMergeStability = jest.fn();
const lockPharmacyCatalogAuthorityTx = jest.fn();
const loadReceipt = jest.fn();
const storeReceipt = jest.fn();
const validatePrescriptionSafety = jest.fn();
const recordCanonicalClinicalEvent = jest.fn();
const isGateEnabled = jest.fn();

// tenantService is left live for requireTenantId, and it binds the default
// client at module load. Nothing here reaches it, so the stub reads empty.
const prismaMock = {
  $queryRawUnsafe: jest.fn(async () => []),
  $executeRawUnsafe: jest.fn(async () => 0),
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx,
}));
jest.unstable_mockModule('../../utils/patientMergeStabilityLock.js', () => ({
  lockTenantPatientMergeStability,
}));
jest.unstable_mockModule('../../utils/clinical/prescriptionSafetyCheck.js', () => ({
  validatePrescriptionSafety,
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent,
}));
jest.unstable_mockModule('../../services/staff/credentialingService.js', () => ({
  isGateEnabled,
}));
jest.unstable_mockModule('../../services/pharmacy/pharmacyOrderCommandReceiptService.js', () => ({
  loadPharmacyOrderCommandReceiptTx: loadReceipt,
  storePharmacyOrderCommandReceiptTx: storeReceipt,
  pharmacyCommandRequestSha256: (payload) => createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex'),
}));
jest.unstable_mockModule('../../services/pharmacy/pharmacistVerificationService.js', () => ({
  clinicalOrderItemsSha256: (items) => createHash('sha256')
    .update(JSON.stringify(items))
    .digest('hex'),
  lockPharmacyCatalogAuthorityTx,
}));

const {
  amendRejectedPrescription,
  normalizeRejectedPrescriptionAmendment,
} = await import('../../services/pharmacy/rejectedPrescriptionAmendmentService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const PRESCRIBER_UID = '22222222-2222-4222-8222-222222222222';
const OTHER_UID = '33333333-3333-4333-8333-333333333333';
const OLD_ITEMS = [{
  order_line_index: 0,
  prescription_line_index: 0,
  catalog_id: 17,
  name: 'Old Drug',
  ordered_quantity: 1,
}];
const OLD_ITEMS_HASH = createHash('sha256').update(JSON.stringify(OLD_ITEMS)).digest('hex');
const BODY = {
  expected_prescription_revision: 4,
  expected_order_version: 6,
  amendment_reason: 'Replace the rejected medication with the reviewed dose.',
  medications: [{
    catalog_id: 19,
    ordered_quantity: 2,
    dose: '500 mg',
    frequency: 'BD',
    route: 'oral',
    duration: '5 days',
    instructions: 'After food',
  }],
};

function preflight() {
  return [{
    id: 41,
    patient_id: 91,
    patient_uid: PATIENT_UID,
    pharmacy_order_id: 71,
  }];
}

function patient() {
  return [{ id: 91, uid: PATIENT_UID }];
}

function rejectedOrder(overrides = {}) {
  return [{
    id: 71,
    patient_id: 91,
    facility_id: 7,
    facility_status: 'active',
    order_number: 'PO-71',
    status: 'ON_HOLD',
    authority_origin: 'e_prescription',
    items_list: OLD_ITEMS,
    payment_status: 'pending',
    amount_collected: 0,
    partial_dispense: false,
    dispensed_by: null,
    dispensed_at: null,
    dispensed_medications: null,
    inventory_authority_version: 6,
    clinical_verification_status: 'rejected',
    clinically_verified_order_version: 6,
    clinical_verification_items_sha256: OLD_ITEMS_HASH,
    clinical_verification_catalog_sha256: 'c'.repeat(64),
    clinical_verification_active_therapy_sha256: 'a'.repeat(64),
    clinical_verification_safety_version: 9n,
    clinical_verification_kb_version: 11n,
    clinical_verification_ruleset_version: 3,
    clinically_verified_by: OTHER_UID,
    clinically_verified_at: new Date('2026-08-29T06:00:00.000Z'),
    clinical_verification_notes: 'Dose must be corrected',
    clinical_verification_findings: [{ type: 'DOSE_REVIEW' }],
    prescribed_by: PRESCRIBER_UID,
    ...overrides,
  }];
}

function linkedPrescription(overrides = {}) {
  return [{
    id: 41,
    patient_id: 91,
    patient_uid: PATIENT_UID,
    doctor_id: 21,
    doctor_uid: PRESCRIBER_UID,
    medications: [{ catalog_id: 17, name: 'Old Drug' }],
    status: 'pharmacy_linked',
    pharmacy_opted: true,
    pharmacy_order_id: 71,
    revision: 4,
    lifecycle_status: 'signed',
    signed_at: new Date('2026-08-29T05:00:00.000Z'),
    signed_by: PRESCRIBER_UID,
    locked_at: new Date('2026-08-29T05:00:00.000Z'),
    locked_by: PRESCRIBER_UID,
    original_prescriber_role: 'DOCTOR',
    ...overrides,
  }];
}

function actor(uid = PRESCRIBER_UID, role = 'DOCTOR') {
  return [{ id: uid === PRESCRIBER_UID ? 21 : 31, uid, role, name: 'Clinician' }];
}

function catalog() {
  return [{
    catalog_id: 19,
    name: 'Canonical Drug',
    generic_name: 'Canonical Generic',
    category: 'antibiotic',
    description: null,
    unit_price: '12.50',
    composition_id: null,
    strength: '500 mg',
    form: 'tablet',
    route: 'oral',
  }];
}

function primeTransaction({
  preflightRows = preflight(),
  order = rejectedOrder(),
  rx = linkedPrescription(),
  clinician = actor(),
  catalogRows = catalog(),
  inventoryRows = [],
  coveringAuthorityRows = [{
    id: 501,
    care_team_id: 301,
    relationship_kind: 'covering_doctor',
    access_scope: { prescriptions: 'write' },
    team_kind: 'longitudinal',
    appointment_id: null,
    admission_id: null,
  }],
  appointmentRows = [],
  admissionRows = [],
  breakGlassRows = [],
  privilegeRows = [{ id: 601 }],
  progressTable = null,
} = {}) {
  txQuery.mockImplementation(async (sql) => {
    // `pharmacy_order_id=$2::int` ends in `id=$2::int`, so an unanchored pattern
    // also swallows the linked-prescription read below and answers it with the
    // preflight row. Pin the preflight to its unaliased FROM ... WHERE.
    if (/FROM e_prescriptions\s+WHERE tenant_id=\$1::uuid AND id=\$2::int/.test(sql)) return preflightRows;
    if (/FROM pharmacy_orders po/.test(sql)) return order;
    if (/FROM e_prescriptions prescription[\s\S]*pharmacy_order_id=\$2::int/.test(sql)) return rx;
    if (/FROM users p/.test(sql)) return patient();
    if (/FROM users\s/.test(sql)) return clinician;
    if (/FROM care_team_members/.test(sql)) return coveringAuthorityRows;
    if (/FROM appointments appointment/.test(sql)) return appointmentRows;
    if (/FROM admissions admission/.test(sql)) return admissionRows;
    if (/FROM patient_access_break_glass/.test(sql)) return breakGlassRows;
    if (/FROM pharmacy_catalog/.test(sql)) return catalogRows;
    if (/FROM drug_compositions/.test(sql)) return [];
    if (/FROM pharmacy_inventory_items/.test(sql)) return inventoryRows;
    if (/FROM staff_credentials/.test(sql)) return privilegeRows;
    if (/clock_timestamp\(\) AS amended_at/.test(sql)) {
      return [{ amended_at: new Date('2026-08-29T07:00:00.000Z') }];
    }
    if (progressTable && sql.includes(progressTable)) return [{ id: 1 }];
    return [];
  });
}

function queryCallOrder(pattern) {
  const index = txQuery.mock.calls.findIndex(([sql]) => pattern.test(sql));
  expect(index).toBeGreaterThanOrEqual(0);
  return txQuery.mock.invocationCallOrder[index];
}

function querySql(pattern) {
  const call = txQuery.mock.calls.find(([sql]) => pattern.test(sql));
  expect(call).toBeDefined();
  return call[0];
}

beforeEach(() => {
  jest.resetAllMocks();
  setTenantTx.mockImplementation(async (_tenantId, callback) => callback({
    $queryRawUnsafe: txQuery,
    $executeRawUnsafe: txExecute,
  }));
  loadReceipt.mockResolvedValue(null);
  storeReceipt.mockResolvedValue(undefined);
  lockTenantPatientMergeStability.mockResolvedValue(undefined);
  lockPharmacyCatalogAuthorityTx.mockResolvedValue(undefined);
  isGateEnabled.mockReturnValue(false);
  txExecute.mockResolvedValue(1);
  validatePrescriptionSafety.mockResolvedValue({ safe: true, blockers: [], warnings: [] });
  recordCanonicalClinicalEvent.mockResolvedValue({ timeline: { id: 1 }, audit: { id: 2 } });
});

describe('rejected prescription amendment authority', () => {
  test('original prescriber atomically advances exact versions and preserves rejected verification evidence', async () => {
    primeTransaction();

    const result = await amendRejectedPrescription({
      prescriptionId: 41,
      tenantId: TENANT,
      actorUid: PRESCRIBER_UID,
      actorRole: 'DOCTOR',
      idempotencyKey: 'rx-amend-41-1',
      body: BODY,
    });

    expect(result).toMatchObject({
      prescription_id: 41,
      pharmacy_order_id: 71,
      status: 'ON_HOLD',
      clinical_verification_status: 'rejected',
      amendment_state: 'pending_reverification',
      prescription_revision: 5,
      order_version: 7,
      rejected_items_sha256: OLD_ITEMS_HASH,
      authorization_basis: 'original_prescriber',
      covering_authority_id: null,
      covering_authority_source: null,
      controlled_privilege_id: null,
      amended_at: '2026-08-29T07:00:00.000Z',
      idempotent_replay: false,
      medications: [expect.objectContaining({
        catalog_id: 19,
        name: 'Canonical Drug',
        ordered_quantity: 2,
        amendment_state: 'pending_reverification',
      })],
      items_list: [expect.objectContaining({
        order_line_index: 0,
        prescription_line_index: 0,
        catalog_id: 19,
        name: 'Canonical Drug',
        price: 12.5,
        line_total: 25,
      })],
    });
    const preflightCall = queryCallOrder(/FROM e_prescriptions[\s\S]*id=\$2::int/);
    const actorCall = queryCallOrder(/FROM users\s+[\s\S]*uid=\$2::uuid/);
    const orderCall = queryCallOrder(/FROM pharmacy_orders po/);
    const prescriptionCall = queryCallOrder(/FROM e_prescriptions prescription/);
    const patientCall = queryCallOrder(/FROM users p/);
    expect(setTenantTx).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(querySql(/FROM e_prescriptions[\s\S]*id=\$2::int/))
      .toMatch(/WHERE tenant_id=\$1::uuid AND id=\$2::int/);
    expect(preflightCall).toBeLessThan(lockTenantPatientMergeStability.mock.invocationCallOrder[0]);
    expect(lockTenantPatientMergeStability.mock.invocationCallOrder[0])
      .toBeLessThan(lockPharmacyCatalogAuthorityTx.mock.invocationCallOrder[0]);
    expect(lockPharmacyCatalogAuthorityTx.mock.invocationCallOrder[0]).toBeLessThan(actorCall);
    expect(actorCall).toBeLessThan(loadReceipt.mock.invocationCallOrder[0]);
    expect(querySql(/FROM users\s+[\s\S]*uid=\$2::uuid/)).toMatch(
      /is_active=TRUE[\s\S]*status='active'[\s\S]*FOR UPDATE/,
    );
    expect(loadReceipt.mock.invocationCallOrder[0]).toBeLessThan(orderCall);
    expect(orderCall).toBeLessThan(prescriptionCall);
    expect(prescriptionCall).toBeLessThan(patientCall);
    expect(storeReceipt.mock.invocationCallOrder[0])
      .toBeLessThan(txExecute.mock.invocationCallOrder[0]);
    expect(loadReceipt).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      tenantId: TENANT,
      orderId: 71,
      action: 'amend_rejected_rx',
      requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(storeReceipt).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      tenantId: TENANT,
      orderId: 71,
      action: 'amend_rejected_rx',
      requestSha256: loadReceipt.mock.calls[0][1].requestSha256,
      payload: expect.objectContaining({
        prescription_revision: 5,
        order_version: 7,
        amended_at: '2026-08-29T07:00:00.000Z',
      }),
    }));
    expect(txExecute).toHaveBeenCalledTimes(3);
    expect(txExecute.mock.calls[0][0]).toMatch(/UPDATE e_prescriptions/);
    expect(txExecute.mock.calls[1][0]).toMatch(/UPDATE pharmacy_orders/);
    // The rejected-verification evidence must never be REWRITTEN, but it is
    // legitimately read back in the compare-and-swap guard. Split the statement
    // so the negatives bind to the SET half only, and assert the guards on the
    // WHERE half instead of merely tolerating them.
    const [orderSetClause, orderWhereClause] = txExecute.mock.calls[1][0].split(/\bWHERE\b/);
    expect(orderSetClause).not.toMatch(/clinical_verification_(status|notes|findings)\s*=/);
    expect(orderSetClause).not.toMatch(/clinically_verified_(by|at|order_version)\s*=/);
    expect(orderWhereClause).toMatch(/clinical_verification_status='rejected'/);
    expect(orderWhereClause).toMatch(/clinically_verified_order_version=\$10::int/);
    expect(orderWhereClause).toMatch(/clinical_verification_items_sha256=\$11/);
    expect(txExecute.mock.calls[2][0]).toMatch(/INSERT INTO pharmacy_order_history/);
    const historyEvidence = JSON.parse(txExecute.mock.calls[2][5]);
    expect(historyEvidence).toMatchObject({
      rejected_prescription_snapshot: expect.objectContaining({
        id: 41,
        doctor_id: 21,
        doctor_uid: PRESCRIBER_UID,
        lifecycle_status: 'signed',
        revision: 4,
        signed_by: PRESCRIBER_UID,
        locked_by: PRESCRIBER_UID,
      }),
      rejected_order_snapshot: expect.objectContaining({
        id: 71,
        status: 'ON_HOLD',
        prescribed_by: PRESCRIBER_UID,
        inventory_authority_version: 6,
        clinical_verification_status: 'rejected',
        clinically_verified_order_version: 6,
        clinical_verification_items_sha256: OLD_ITEMS_HASH,
        clinical_verification_notes: 'Dose must be corrected',
        clinical_verification_safety_version: '9',
        clinical_verification_kb_version: '11',
      }),
      rejected_prescription_medications: linkedPrescription()[0].medications,
      rejected_order_items: OLD_ITEMS,
      prior_signature: {
        signed_at: '2026-08-29T05:00:00.000Z',
        signed_by: PRESCRIBER_UID,
        locked_at: '2026-08-29T05:00:00.000Z',
        locked_by: PRESCRIBER_UID,
      },
      preserved_rejection: expect.objectContaining({
        rejected_by: OTHER_UID,
        notes: 'Dose must be corrected',
      }),
    });
    expect(recordCanonicalClinicalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventStatus: 'pending_reverification',
        beforeState: expect.objectContaining({
          medications: linkedPrescription()[0].medications,
          items_list: OLD_ITEMS,
          doctor_uid: PRESCRIBER_UID,
          prescribed_by: PRESCRIBER_UID,
          signed_by: PRESCRIBER_UID,
          locked_by: PRESCRIBER_UID,
          prescription: expect.objectContaining({
            lifecycle_status: 'signed',
            revision: 4,
          }),
          pharmacy_order: expect.objectContaining({
            clinical_verification_status: 'rejected',
            clinical_verification_items_sha256: OLD_ITEMS_HASH,
          }),
        }),
        payload: expect.objectContaining({
          authorization_basis: 'original_prescriber',
          preserved_rejection: expect.objectContaining({
            notes: 'Dose must be corrected',
          }),
        }),
      }),
      { db: expect.objectContaining({ $executeRawUnsafe: txExecute }), strict: true },
    );
    expect(querySql(/FROM e_prescriptions prescription/)).toMatch(
      /JOIN users prescriber[\s\S]*prescriber\.id=prescription\.doctor_id[\s\S]*prescriber\.uid=prescription\.doctor_uid[\s\S]*FOR UPDATE OF prescription, prescriber/,
    );
  });

  test('same-tenant clinical leader requires and immutably records explicit covering authority', async () => {
    primeTransaction({ clinician: actor(OTHER_UID, 'CMO') });
    const body = {
      ...BODY,
      authorization_reason: 'Covering the absent prescriber after consultant review.',
    };

    await expect(amendRejectedPrescription({
      prescriptionId: 41,
      tenantId: TENANT,
      actorUid: OTHER_UID,
      actorRole: 'CMO',
      idempotencyKey: 'rx-amend-41-cover',
      body,
    })).resolves.toMatchObject({
      authorization_basis: 'same_tenant_clinical_leader',
      covering_authority_id: 501,
      covering_authority_source: 'care_team',
      amended_by: OTHER_UID,
      amended_by_role: 'CMO',
    });

    expect(storeReceipt).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      payload: expect.objectContaining({
        authorization_basis: 'same_tenant_clinical_leader',
        covering_authority_id: 501,
        covering_authority_source: 'care_team',
        amended_by: OTHER_UID,
      }),
    }));
    const historyEvidence = JSON.parse(txExecute.mock.calls[2][5]);
    expect(historyEvidence).toMatchObject({
      authorization_reason: 'Covering the absent prescriber after consultant review.',
      covering_authority_source: 'care_team',
      covering_authority_evidence: {
        id: 501,
        care_team_id: 301,
        relationship_kind: 'covering_doctor',
      },
    });
    expect(querySql(/FROM care_team_members/)).toMatch(
      /JOIN care_teams team[\s\S]*team\.status='active'[\s\S]*FOR UPDATE OF member, team/,
    );
  });

  test('wrong tenant is non-enumerating inside tenant RLS context and performs no write', async () => {
    primeTransaction({ preflightRows: [] });

    await expect(amendRejectedPrescription({
      prescriptionId: 41,
      tenantId: TENANT,
      actorUid: PRESCRIBER_UID,
      actorRole: 'DOCTOR',
      idempotencyKey: 'rx-amend-wrong-tenant',
      body: BODY,
    })).rejects.toMatchObject({ statusCode: 404, code: 'PRESCRIPTION_AMENDMENT_NOT_FOUND' });

    expect(setTenantTx).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(querySql(/FROM e_prescriptions/)).toMatch(
      /WHERE tenant_id=\$1::uuid AND id=\$2::int/,
    );
    expect(lockTenantPatientMergeStability).not.toHaveBeenCalled();
    expect(storeReceipt).not.toHaveBeenCalled();
    expect(txExecute).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEvent).not.toHaveBeenCalled();
  });

  test('a different ordinary clinician fails before receipt and domain writes', async () => {
    primeTransaction({ clinician: actor(OTHER_UID, 'DOCTOR') });

    await expect(amendRejectedPrescription({
      prescriptionId: 41,
      tenantId: TENANT,
      actorUid: OTHER_UID,
      actorRole: 'DOCTOR',
      idempotencyKey: 'rx-amend-wrong-actor',
      body: BODY,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PRESCRIPTION_AMENDMENT_ACTOR_NOT_AUTHORIZED',
    });

    expect(storeReceipt).not.toHaveBeenCalled();
    expect(txExecute).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEvent).not.toHaveBeenCalled();
  });

  test('covering clinical leader without an explicit reason fails before receipt and writes', async () => {
    primeTransaction({ clinician: actor(OTHER_UID, 'MEDICAL_SUPERINTENDENT') });

    await expect(amendRejectedPrescription({
      prescriptionId: 41,
      tenantId: TENANT,
      actorUid: OTHER_UID,
      actorRole: 'MEDICAL_SUPERINTENDENT',
      idempotencyKey: 'rx-amend-cover-no-reason',
      body: BODY,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'PRESCRIPTION_AMENDMENT_AUTHORIZATION_REASON_REQUIRED',
    });

    expect(storeReceipt).not.toHaveBeenCalled();
    expect(txExecute).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEvent).not.toHaveBeenCalled();
  });

  test('covering clinical leader without locked patient-specific authority fails closed', async () => {
    primeTransaction({
      clinician: actor(OTHER_UID, 'CMO'),
      coveringAuthorityRows: [],
      breakGlassRows: [],
    });

    await expect(amendRejectedPrescription({
      prescriptionId: 41,
      tenantId: TENANT,
      actorUid: OTHER_UID,
      actorRole: 'CMO',
      idempotencyKey: 'rx-amend-cover-no-patient-authority',
      body: {
        ...BODY,
        authorization_reason: 'Covering the absent prescriber after consultant review.',
      },
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PRESCRIPTION_AMENDMENT_COVERING_AUTHORITY_REQUIRED',
    });

    expect(querySql(/FROM patient_access_break_glass/)).toMatch(
      /actor_uid=\$3::uuid[\s\S]*actor_role[\s\S]*status='active'[\s\S]*expires_at > clock_timestamp\(\)[\s\S]*FOR UPDATE/,
    );
    expect(storeReceipt).not.toHaveBeenCalled();
    expect(txExecute).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEvent).not.toHaveBeenCalled();
  });

  test('covering clinical leader can use an exact active patient break-glass session with immutable evidence', async () => {
    primeTransaction({
      clinician: actor(OTHER_UID, 'MEDICAL_SUPERINTENDENT'),
      coveringAuthorityRows: [],
      breakGlassRows: [{ id: 701, reason: 'Emergency prescribing coverage' }],
    });

    const result = await amendRejectedPrescription({
      prescriptionId: 41,
      tenantId: TENANT,
      actorUid: OTHER_UID,
      actorRole: 'MEDICAL_SUPERINTENDENT',
      idempotencyKey: 'rx-amend-cover-break-glass',
      body: {
        ...BODY,
        authorization_reason: 'Emergency rejected-prescription correction after clinical review.',
      },
    });

    expect(result).toMatchObject({
      covering_authority_id: 701,
      covering_authority_source: 'patient_access_break_glass',
    });
    expect(JSON.parse(txExecute.mock.calls[2][5])).toMatchObject({
      covering_authority_evidence: {
        source: 'patient_access_break_glass',
        id: 701,
        break_glass_reason: 'Emergency prescribing coverage',
      },
    });
  });

  test('expired episode-scoped care-team membership is not accepted as covering authority', async () => {
    primeTransaction({
      clinician: actor(OTHER_UID, 'CMO'),
      coveringAuthorityRows: [{
        id: 502,
        care_team_id: 302,
        relationship_kind: 'covering_doctor',
        access_scope: {},
        team_kind: 'op',
        appointment_id: 801,
        admission_id: null,
      }],
      appointmentRows: [],
      breakGlassRows: [],
    });

    await expect(amendRejectedPrescription({
      prescriptionId: 41,
      tenantId: TENANT,
      actorUid: OTHER_UID,
      actorRole: 'CMO',
      idempotencyKey: 'rx-amend-cover-stale-episode',
      body: {
        ...BODY,
        authorization_reason: 'Covering the absent prescriber after consultant review.',
      },
    })).rejects.toMatchObject({ code: 'PRESCRIPTION_AMENDMENT_COVERING_AUTHORITY_REQUIRED' });

    expect(querySql(/FROM appointments appointment/)).toMatch(
      /appointment_date >= \(CURRENT_DATE - INTERVAL '30 days'\)[\s\S]*FOR UPDATE/,
    );
    expect(storeReceipt).not.toHaveBeenCalled();
    expect(txExecute).not.toHaveBeenCalled();
  });

  test.each([
    [{ status: 'CONFIRMED' }, 'PRESCRIPTION_AMENDMENT_WRONG_STATE'],
    [{ inventory_authority_version: 7 }, 'PRESCRIPTION_AMENDMENT_STALE_ORDER_VERSION'],
    [{ clinical_verification_items_sha256: 'f'.repeat(64) }, 'PRESCRIPTION_AMENDMENT_REJECTION_EVIDENCE_CHANGED'],
  ])('wrong or already-amended order state %j fails with no writes', async (change, code) => {
    primeTransaction({ order: rejectedOrder(change) });

    await expect(amendRejectedPrescription({
      prescriptionId: 41,
      tenantId: TENANT,
      actorUid: PRESCRIBER_UID,
      actorRole: 'DOCTOR',
      idempotencyKey: `rx-amend-wrong-state-${code}`,
      body: BODY,
    })).rejects.toMatchObject({ statusCode: 409, code });

    expect(storeReceipt).not.toHaveBeenCalled();
    expect(txExecute).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEvent).not.toHaveBeenCalled();
  });

  test.each([
    ['unsigned lifecycle', { lifecycle_status: 'locked' }, {}],
    ['missing signature time', { signed_at: null }, {}],
    ['signature actor mismatch', { signed_by: OTHER_UID }, {}],
    ['lock actor mismatch', { locked_by: OTHER_UID }, {}],
    ['noncanonical prescriber identity', { original_prescriber_role: null }, {}],
    ['order and eRx prescriber mismatch', {}, { prescribed_by: OTHER_UID }],
  ])('exact prescription lifecycle and prescriber coherence rejects %s', async (
    _label,
    prescriptionChange,
    orderChange,
  ) => {
    primeTransaction({
      rx: linkedPrescription(prescriptionChange),
      order: rejectedOrder(orderChange),
    });

    await expect(amendRejectedPrescription({
      prescriptionId: 41,
      tenantId: TENANT,
      actorUid: PRESCRIBER_UID,
      actorRole: 'DOCTOR',
      idempotencyKey: 'rx-amend-lifecycle-incoherent',
      body: BODY,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PRESCRIPTION_AMENDMENT_STALE_PRESCRIPTION',
    });

    expect(storeReceipt).not.toHaveBeenCalled();
    expect(txExecute).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEvent).not.toHaveBeenCalled();
  });

  test.each([
    'pharmacy_stock_movements',
    'billing_invoice_items',
    'pharmacy_payment_allocations',
    'pharmacy_cap_reservations',
    'pharmacy_order_history',
  ])('authoritative %s progress prevents rejected-line rewrite', async (progressTable) => {
    primeTransaction({ progressTable });

    await expect(amendRejectedPrescription({
      prescriptionId: 41,
      tenantId: TENANT,
      actorUid: PRESCRIBER_UID,
      actorRole: 'DOCTOR',
      idempotencyKey: `rx-amend-progress-${progressTable}`,
      body: BODY,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PRESCRIPTION_AMENDMENT_ORDER_ALREADY_PROGRESSED',
    });

    expect(querySql(new RegExp(`FROM ${progressTable}`))).toMatch(/FOR KEY SHARE/);
    expect(storeReceipt).not.toHaveBeenCalled();
    expect(txExecute).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEvent).not.toHaveBeenCalled();
  });

  test('revoked or expired controlled prescribing privilege is rechecked under the amendment transaction lock', async () => {
    primeTransaction({
      catalogRows: [{ ...catalog()[0], category: 'controlled narcotic' }],
      inventoryRows: [{
        catalog_id: 19,
        schedule_class: 'H1',
        is_narcotic: true,
        facility_id: 7,
        status: 'active',
      }],
      privilegeRows: [],
    });
    isGateEnabled.mockReturnValue(true);

    await expect(amendRejectedPrescription({
      prescriptionId: 41,
      tenantId: TENANT,
      actorUid: PRESCRIBER_UID,
      actorRole: 'DOCTOR',
      idempotencyKey: 'rx-amend-controlled-revoked',
      body: BODY,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'CLINICAL_PRIVILEGE_REQUIRED',
    });

    expect(querySql(/FROM staff_credentials/)).toMatch(
      /JOIN privilege_catalog privilege[\s\S]*privilege\.status='active'[\s\S]*credential\.status='active'[\s\S]*renewal_status='current'[\s\S]*valid_from <= CURRENT_DATE[\s\S]*valid_until >= CURRENT_DATE[\s\S]*FOR UPDATE OF credential, privilege/,
    );
    expect(txQuery.mock.calls.filter(([sql]) => /FROM staff_credentials/.test(sql))[1][0]).toMatch(
      /privilege_catalog_id IS NULL[\s\S]*FOR UPDATE OF credential/,
    );
    expect(storeReceipt).not.toHaveBeenCalled();
    expect(txExecute).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEvent).not.toHaveBeenCalled();
  });

  test('safety blocker fails before durable receipt and every domain write', async () => {
    primeTransaction();
    validatePrescriptionSafety.mockResolvedValueOnce({
      safe: false,
      blockers: [{ type: 'DRUG_INTERACTION', severity: 'HIGH' }],
      warnings: [],
    });

    await expect(amendRejectedPrescription({
      prescriptionId: 41,
      tenantId: TENANT,
      actorUid: PRESCRIBER_UID,
      actorRole: 'DOCTOR',
      idempotencyKey: 'rx-amend-safety-blocked',
      body: BODY,
    })).rejects.toMatchObject({
      statusCode: 422,
      code: 'PRESCRIPTION_AMENDMENT_SAFETY_BLOCKED',
    });

    expect(storeReceipt).not.toHaveBeenCalled();
    expect(txExecute).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEvent).not.toHaveBeenCalled();
  });

  test('order compare-and-swap failure aborts before history or canonical event', async () => {
    primeTransaction();
    txExecute.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await expect(amendRejectedPrescription({
      prescriptionId: 41,
      tenantId: TENANT,
      actorUid: PRESCRIBER_UID,
      actorRole: 'DOCTOR',
      idempotencyKey: 'rx-amend-order-cas',
      body: BODY,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PRESCRIPTION_AMENDMENT_STALE_ORDER_VERSION',
    });

    expect(storeReceipt).toHaveBeenCalledTimes(1);
    expect(txExecute).toHaveBeenCalledTimes(2);
    expect(recordCanonicalClinicalEvent).not.toHaveBeenCalled();
  });

  test('durable replay revalidates tenant actor and role before disclosure and writes nothing', async () => {
    primeTransaction();
    loadReceipt.mockResolvedValueOnce({
      payload: {
        prescription_id: 41,
        pharmacy_order_id: 71,
        amendment_state: 'pending_reverification',
        prescription_revision: 5,
        order_version: 7,
        idempotent_replay: false,
      },
    });

    await expect(amendRejectedPrescription({
      prescriptionId: 41,
      tenantId: TENANT,
      actorUid: PRESCRIBER_UID,
      actorRole: 'DOCTOR',
      idempotencyKey: 'rx-amend-replay',
      body: BODY,
    })).resolves.toMatchObject({
      prescription_revision: 5,
      order_version: 7,
      idempotent_replay: true,
    });

    expect(lockTenantPatientMergeStability).toHaveBeenCalledTimes(1);
    expect(lockPharmacyCatalogAuthorityTx).toHaveBeenCalledTimes(1);
    expect(txQuery).toHaveBeenCalledTimes(2);
    expect(queryCallOrder(/FROM users\s+[\s\S]*uid=\$2::uuid/))
      .toBeLessThan(loadReceipt.mock.invocationCallOrder[0]);
    expect(txQuery.mock.calls.some(([sql]) => /FROM pharmacy_orders po/.test(sql))).toBe(false);
    expect(storeReceipt).not.toHaveBeenCalled();
    expect(txExecute).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEvent).not.toHaveBeenCalled();
  });

  test('durable replay is denied when the bound actor is inactive or its token role changed', async () => {
    primeTransaction({ clinician: actor(PRESCRIBER_UID, 'CMO') });
    loadReceipt.mockResolvedValueOnce({ payload: { prescription_id: 41 } });

    await expect(amendRejectedPrescription({
      prescriptionId: 41,
      tenantId: TENANT,
      actorUid: PRESCRIBER_UID,
      actorRole: 'DOCTOR',
      idempotencyKey: 'rx-amend-replay-role-changed',
      body: BODY,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PRESCRIPTION_AMENDMENT_ACTOR_AUTHORITY_REQUIRED',
    });

    expect(loadReceipt).not.toHaveBeenCalled();
    expect(storeReceipt).not.toHaveBeenCalled();
    expect(txExecute).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEvent).not.toHaveBeenCalled();
  });

  test('durable receipt request-hash mismatch fails before every domain write', async () => {
    primeTransaction();
    loadReceipt.mockRejectedValueOnce(Object.assign(new Error('receipt mismatch'), {
      statusCode: 409,
      code: 'PHARMACY_ORDER_COMMAND_IDEMPOTENCY_CONFLICT',
    }));

    await expect(amendRejectedPrescription({
      prescriptionId: 41,
      tenantId: TENANT,
      actorUid: PRESCRIBER_UID,
      actorRole: 'DOCTOR',
      idempotencyKey: 'rx-amend-receipt-mismatch',
      body: BODY,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_ORDER_COMMAND_IDEMPOTENCY_CONFLICT',
    });

    expect(storeReceipt).not.toHaveBeenCalled();
    expect(txExecute).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEvent).not.toHaveBeenCalled();
  });

  test('request validation rejects client-supplied identity or price fields', () => {
    expect(() => normalizeRejectedPrescriptionAmendment({
      ...BODY,
      medications: [{
        ...BODY.medications[0],
        name: 'Client-forged drug name',
        price: 0,
      }],
    })).toThrow(expect.objectContaining({
      statusCode: 400,
      code: 'PRESCRIPTION_AMENDMENT_INVALID_REQUEST',
    }));
  });

  test('dedicated route hard-enforces patient access before claiming durable idempotency', () => {
    const routeSource = readFileSync(
      new URL('../../routes/prescription/index.js', import.meta.url),
      'utf8',
    );
    const rbacSource = readFileSync(
      new URL('../../config/rbacConfig.js', import.meta.url),
      'utf8',
    );
    expect(routeSource).toMatch(
      /function enforcedPrescriptionGuard[\s\S]*?careTeamModeGoverned: false[\s\S]*?const guardRejectedRxAmendment = enforcedPrescriptionGuard\([\s\S]*?selectRxPatientByParam\('id'\)[\s\S]*?requirePatientContext: true/,
    );
    expect(routeSource).toMatch(
      /wrapAutoRBAC\(router, 'ePrescriptionRejectedAmendmentRoutes'[\s\S]*?'\/:id\/amend-rejected-pharmacy-order'[\s\S]*?rejectMobileClinicalWrite,[\s\S]*?guardRejectedRxAmendment,[\s\S]*?requireIdempotencyKey\(\{[\s\S]*?durableDomainReceipt: true/,
    );
    expect(rbacSource).toMatch(
      /ePrescriptionRejectedAmendmentRoutes:\s*\[\s*DOCTOR,\s*DUTY_DOCTOR,\s*CMO,\s*MEDICAL_SUPERINTENDENT\s*\]/,
    );
  });
});
