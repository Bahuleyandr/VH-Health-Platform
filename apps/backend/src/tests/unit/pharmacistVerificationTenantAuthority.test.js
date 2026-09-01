import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();
const executeRawUnsafe = jest.fn();
const setTenantTx = jest.fn();
const validatePrescriptionSafety = jest.fn();
const loadActiveTherapySnapshot = jest.fn();
const loadDrugKbRevision = jest.fn();
const recordCanonicalClinicalEvent = jest.fn();
const recordMedicationSafetyReviews = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafe },
  setTenantTx,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('../../utils/clinical/prescriptionSafetyCheck.js', () => ({
  loadActiveTherapySnapshot,
  validatePrescriptionSafety,
}));
jest.unstable_mockModule('../../services/clinical/drugKnowledgeBaseService.js', () => ({
  evaluateDrugKb: jest.fn(),
  loadDrugKbRevision,
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent,
  recordMedicationSafetyReviews,
}));

const {
  assertVerificationCleared,
  clinicalCatalogAuthoritySha256Tx,
  clinicalOrderItemsSha256,
  ensurePackBarcode,
  getPackLabel,
  orderItemsToMedications,
  verifyOrder,
} = await import('../../services/pharmacy/pharmacistVerificationService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR_UID = '22222222-2222-4222-8222-222222222222';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';

// Values the service itself pins; a snapshot that claims a different revision
// or ruleset is stale by definition, so the fixtures below have to carry the
// current ones for a test to isolate the ONE field it means to invalidate.
const KB_REVISION = 1;
const CLINICAL_RULESET_VERSION = 2;
const ACTIVE_THERAPY_SHA = 'a'.repeat(64);
const SAFETY_VERSION = 9;

// Every statement the service issues is answered by SQL identity rather than by
// call ordinal. Migrations 752/753 inserted new authority reads AHEAD of the
// order lookup — tenant merge-stability and pharmacy-catalog advisory locks, the
// same-tenant pharmacist actor gate, and the grant-backed facility custody probe
// (users+staff, then pharmacy_staff_facility_grants) — so an ordinal fixture
// silently feeds the wrong row to the wrong query. Routing on the statement lets
// every assertion below name the exact query it is pinning.
//
// Order matters: the first matching kind wins, so the narrow patterns come
// first (loadOrder also contains "u.role = 'PATIENT'", and the pack-barcode
// UPDATE also starts with "UPDATE pharmacy_orders").
const QUERY_KINDS = [
  ['advisory_lock', /pg_advisory_xact_lock/],
  ['order', /FROM pharmacy_orders po/],
  ['pack_barcode_update', /UPDATE pharmacy_orders[\s\S]{0,40}pack_barcode/],
  ['verify_update', /UPDATE pharmacy_orders SET/],
  ['verifier_actor', /role=ANY\(\$3::text\[\]\)/],
  ['facility_actor', /FROM users actor/],
  ['facility_grants', /FROM pharmacy_staff_facility_grants/],
  ['linked_prescriptions', /FROM e_prescriptions/],
  ['active_patient', /role='PATIENT'/],
  ['command_receipt', /FROM pharmacy_order_command_receipts/],
  ['safety_version', /FROM pharmacy_patient_safety_versions/],
  ['catalog', /FROM pharmacy_catalog/],
  ['compositions', /FROM drug_compositions/],
];

function kindOf(sql) {
  const text = String(sql);
  const hit = QUERY_KINDS.find(([, pattern]) => pattern.test(text));
  return hit ? hit[0] : null;
}

let routes = new Map();

// Fail closed: an unrouted statement throws instead of quietly resolving
// undefined, so a fixture that no longer covers the production query surfaces
// as a named error rather than as a passing test on the wrong branch.
function answer(sql) {
  const kind = kindOf(sql);
  if (!kind) throw new Error(`unrouted SQL in fixture: ${String(sql).slice(0, 160)}`);
  if (!routes.has(kind)) throw new Error(`no fixture routed for query kind '${kind}'`);
  return routes.get(kind);
}

const route = (kind, rows) => routes.set(kind, rows);
const readOnlyTx = { $queryRawUnsafe: async (sql) => answer(sql) };

const callsOfKind = (kind) => queryRawUnsafe.mock.calls
  .filter((call) => kindOf(call[0]) === kind);

function onlyCall(kind) {
  const calls = callsOfKind(kind);
  expect(calls).toHaveLength(1);
  return calls[0];
}

const CATALOG_ROWS = [{
  id: 17,
  name: 'Drug A',
  generic_name: 'drug-a',
  composition_id: 5,
  strength: '500 mg',
  strength_key: '500mg',
  strength_components: null,
  form: 'TAB',
  form_key: 'tab',
  release_key: 'ir',
  route: 'PO',
  composition_source: 'curated',
  composition_confidence: 'high',
}];
const COMPOSITION_ROWS = [{
  id: 5,
  composition_key: 'drug-a-500',
  display_label: 'Drug A 500 mg',
  active_ingredients: ['drug-a'],
}];

const ITEMS = [{
  order_line_index: 0,
  prescription_line_index: 0,
  catalog_id: 17,
  name: 'Drug A',
  ordered_qty: 2,
}];

// The catalog-authority hash is derived from the same governed catalog and
// composition rows production reads, so it is computed through the exported
// helper instead of being duplicated in the fixture. A hand-written constant
// would drift the moment the projection changes and would then mask, rather
// than detect, a real catalog-identity regression.
const catalogSha = (itemsList) => clinicalCatalogAuthoritySha256Tx(readOnlyTx, {
  tenantId: TENANT,
  itemsList,
});

function clearedOrder(overrides = {}) {
  return {
    id: 71,
    order_number: 'PO-71',
    status: 'CONFIRMED',
    delivery_type: 'PICKUP',
    patient_id: 91,
    patient_uid: PATIENT_UID,
    patient_name: 'Patient',
    items_list: ITEMS,
    tenant_id: TENANT,
    facility_id: 7,
    // patient_manual origin with zero linked prescriptions is the valid
    // linkage shape; without it the prescription-authority gate fires first
    // and no test below reaches the invariant it names.
    authority_origin: 'patient_manual',
    clinical_verification_status: 'verified',
    inventory_authority_version: 4,
    clinically_verified_order_version: 4,
    clinical_verification_items_sha256: clinicalOrderItemsSha256(ITEMS),
    clinical_verification_active_therapy_sha256: ACTIVE_THERAPY_SHA,
    clinical_verification_safety_version: SAFETY_VERSION,
    clinical_verification_kb_version: KB_REVISION,
    clinical_verification_ruleset_version: CLINICAL_RULESET_VERSION,
    ...overrides,
  };
}

let lastTx;

beforeEach(() => {
  jest.clearAllMocks();
  routes = new Map();
  route('advisory_lock', []);
  route('catalog', CATALOG_ROWS);
  route('compositions', COMPOSITION_ROWS);
  route('linked_prescriptions', []);
  route('safety_version', [{ version: SAFETY_VERSION }]);
  route('command_receipt', []);
  route('active_patient', [{ uid: PATIENT_UID }]);
  route('verifier_actor', [{ id: 5, uid: ACTOR_UID, role: 'PHARMACY_STAFF' }]);
  route('facility_actor', [{
    id: 5,
    uid: ACTOR_UID,
    role: 'PHARMACY_STAFF',
    user_name: 'Pharmacist',
    staff_name: 'Pharmacist',
    staff_id: 3,
  }]);
  route('facility_grants', [{ id: '11', granted_at: new Date('2026-01-01T00:00:00Z') }]);

  queryRawUnsafe.mockImplementation(async (sql) => answer(sql));
  setTenantTx.mockImplementation(async (_tenantId, callback) => {
    lastTx = { $queryRawUnsafe: queryRawUnsafe, $executeRawUnsafe: executeRawUnsafe };
    return callback(lastTx);
  });
  executeRawUnsafe.mockResolvedValue(1);
  validatePrescriptionSafety.mockResolvedValue({ safe: true, blockers: [], warnings: [] });
  loadActiveTherapySnapshot.mockResolvedValue({
    sha256: ACTIVE_THERAPY_SHA, blockers: [], evidence: [], medications: [],
  });
  loadDrugKbRevision.mockResolvedValue(KB_REVISION);
  recordCanonicalClinicalEvent.mockResolvedValue({ id: 1 });
  recordMedicationSafetyReviews.mockResolvedValue([]);
});

describe('pharmacist verification tenant authority', () => {
  test('verification lookup cannot see an order outside the request tenant', async () => {
    route('order', []);

    await expect(verifyOrder(71, {
      tenantId: TENANT,
      actorUid: ACTOR_UID,
      actorRole: 'PHARMACY_STAFF',
      commandKeySha256: 'c'.repeat(64),
      requestSha256: 'd'.repeat(64),
    })).rejects.toMatchObject({ statusCode: 404 });

    const [sql, orderId, tenantId] = onlyCall('order');
    expect(sql).toContain('po.tenant_id = $2::uuid');
    expect(sql).toContain('u.tenant_id = po.tenant_id');
    expect(sql).toContain("u.role = 'PATIENT'");
    expect(sql).toContain('(po.patient_id IS NULL OR u.uid IS NOT NULL)');
    expect([orderId, tenantId]).toEqual([71, TENANT]);
    // The same-tenant pharmacist gate is fail-closed AHEAD of the order read:
    // an unknown order must never be probed by an actor this tenant does not
    // recognise. Pinning the ordering is strictly more than the old fixture,
    // which asserted only that the order lookup was the very first statement.
    const actorCall = onlyCall('verifier_actor');
    expect(queryRawUnsafe.mock.calls.indexOf(actorCall))
      .toBeLessThan(queryRawUnsafe.mock.calls.indexOf(onlyCall('order')));
    expect(actorCall.slice(1)).toEqual([TENANT, ACTOR_UID, ['PHARMACY_STAFF', 'PHARMACY_INCHARGE']]);
  });

  test('pack-label lookup fails closed under the same tenant predicate', async () => {
    route('order', []);

    await expect(getPackLabel(71, TENANT))
      .rejects.toMatchObject({ statusCode: 404 });

    const [sql, ...args] = onlyCall('order');
    expect(sql).toContain('tenant_id = $2::uuid');
    // Migration 753 replaced the old `facility_id = (SELECT … facilities …)`
    // subquery with a composite JOIN. Asserting the three join predicates plus
    // the active-status filter is strictly stronger than the previous loose
    // regex: it pins tenant-composite facility custody AND that a de-activated
    // facility can no longer surface its orders.
    expect(sql).toMatch(/JOIN facilities facility/);
    expect(sql).toMatch(/facility\.tenant_id=po\.tenant_id/);
    expect(sql).toMatch(/facility\.id=po\.facility_id/);
    expect(sql).toMatch(/facility\.status='active'/);
    expect(args).toEqual([71, TENANT]);
  });

  test('barcode recovery update is tenant-bound and non-enumerating', async () => {
    route('pack_barcode_update', []);

    await expect(ensurePackBarcode(71, TENANT))
      .rejects.toMatchObject({ statusCode: 404 });

    const call = onlyCall('pack_barcode_update');
    expect(call[0]).toContain('tenant_id = $3::uuid');
    expect(call[1]).toBe(71);
    expect(call[3]).toBe(TENANT);
  });

  test('cleared status is rejected when the verified version or item snapshot is stale', async () => {
    // Only the verified order version is stale — every other provenance field
    // matches the live authority. That isolation is what proves the version
    // alone trips the gate, instead of an incidental null mismatch doing it.
    route('order', [clearedOrder({
      clinical_verification_catalog_sha256: await catalogSha(ITEMS),
      clinically_verified_order_version: 3,
    })]);

    await expect(assertVerificationCleared(71, TENANT)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_VERIFICATION_STALE',
    });

    const [sql] = onlyCall('order');
    expect(sql).toMatch(/tenant_id = \$2::uuid/);
    expect(sql).toMatch(/JOIN facilities facility[\s\S]*facility\.status='active'/);
  });

  test('the clinical snapshot hash includes stable line identity and ordered quantity', () => {
    const base = [{
      order_line_index: 0,
      prescription_line_index: 0,
      catalog_id: 17,
      name: 'Drug A',
      ordered_qty: 2,
    }];
    const quantityChanged = [{ ...base[0], ordered_qty: 3 }];
    const identityChanged = [{ ...base[0], prescription_line_index: 1 }];

    expect(clinicalOrderItemsSha256(base)).not.toBe(clinicalOrderItemsSha256(quantityChanged));
    expect(clinicalOrderItemsSha256(base)).not.toBe(clinicalOrderItemsSha256(identityChanged));
  });

  test('verification medication projection preserves the authoritative catalog identity', () => {
    expect(orderItemsToMedications([{
      catalog_id: 17,
      name: 'Drug A',
      dosage: '500 mg',
    }])).toEqual([expect.objectContaining({
      catalog_id: 17,
      name: 'Drug A',
      dose: '500 mg',
    })]);
  });

  test('verification persists only through tenant, facility, version, and item-snapshot CAS', async () => {
    route('order', [{
      id: 71,
      order_number: 'PO-71',
      status: 'CONFIRMED',
      patient_id: 91,
      patient_uid: PATIENT_UID,
      patient_name: 'Patient',
      items_list: ITEMS,
      tenant_id: TENANT,
      facility_id: 7,
      authority_origin: 'patient_manual',
      inventory_authority_version: 4,
      clinical_verification_status: 'pending',
    }]);
    route('verify_update', []);

    await expect(verifyOrder(71, {
      tenantId: TENANT,
      actorUid: ACTOR_UID,
      actorRole: 'PHARMACY_STAFF',
      commandKeySha256: 'c'.repeat(64),
      requestSha256: 'd'.repeat(64),
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_VERIFY_STATE_CHANGED',
    });

    // Pinning the transaction options alongside the tenant is strictly stronger
    // than the old two-argument form: the whole verify CAS is only sound if it
    // runs SERIALIZABLE, so a silent downgrade to the default isolation level
    // must fail this test rather than slip through.
    expect(setTenantTx).toHaveBeenCalledWith(
      TENANT,
      expect.any(Function),
      { isolationLevel: 'Serializable', timeout: 30000 },
    );
    expect(executeRawUnsafe.mock.calls[0][0]).toMatch(
      /INSERT INTO pharmacy_patient_safety_versions[\s\S]*ON CONFLICT/,
    );
    expect(executeRawUnsafe.mock.calls[0].slice(1)).toEqual([TENANT, 91]);
    const safetyCall = onlyCall('safety_version');
    expect(safetyCall[0]).toMatch(
      /pharmacy_patient_safety_versions[\s\S]*tenant_id=\$1::uuid[\s\S]*patient_id=\$2::int[\s\S]*FOR UPDATE/,
    );
    expect(safetyCall.slice(1)).toEqual([TENANT, 91]);
    // The full option set the safety engine is now driven with. Pinning
    // `requireActiveTherapyAuthority: true` and the exact tenant-scoped `db`
    // is strictly stronger than the old single-key `{ tenantId }`: it proves
    // the gate cannot silently drop active-therapy authority or run the
    // safety check outside the verification transaction.
    expect(validatePrescriptionSafety).toHaveBeenCalledWith(
      91,
      [expect.objectContaining({ catalog_id: 17, name: 'Drug A' })],
      {
        tenantId: TENANT,
        knowledgeRevision: KB_REVISION,
        db: lastTx,
        excludePrescriptionId: null,
        excludePharmacyOrderId: 71,
        requireActiveTherapyAuthority: true,
      },
    );
    const update = onlyCall('verify_update');
    expect(update[0]).toMatch(/tenant_id = \$8::uuid/);
    expect(update[0]).toMatch(/facility_id = \$11::int/);
    expect(update[0]).toMatch(/inventory_authority_version = \$6::int/);
    expect(update[0]).toMatch(/items_list IS NOT DISTINCT FROM \$10::jsonb/);
    expect(update[0]).toMatch(/clinical_verification_safety_version = \$12::bigint/);
    expect(update[6]).toBe(4);
    expect(update[8]).toBe(TENANT);
    expect(update[10]).toBe(JSON.stringify(ITEMS));
    expect(update[11]).toBe(7);
    expect(update[12]).toBe(SAFETY_VERSION);
    expect(recordMedicationSafetyReviews).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEvent).not.toHaveBeenCalled();
  });

  test('a changed patient safety version invalidates an otherwise matching verification', async () => {
    // Everything matches except the safety version the order was verified at.
    route('order', [clearedOrder({
      clinical_verification_catalog_sha256: await catalogSha(ITEMS),
      clinical_verification_safety_version: SAFETY_VERSION - 1,
    })]);

    await expect(assertVerificationCleared(71, TENANT)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_VERIFICATION_STALE',
    });

    // The live safety version is no longer LEFT JOINed onto the order read; it
    // is its own tenant+patient-scoped statement against the authority table.
    // Binding both arguments is strictly stronger than the old SQL-text regex,
    // which never proved the read was scoped to THIS tenant and patient.
    const safetyCall = onlyCall('safety_version');
    expect(safetyCall[0]).toMatch(
      /FROM pharmacy_patient_safety_versions[\s\S]*tenant_id=\$1::uuid[\s\S]*patient_id=\$2::int/,
    );
    expect(safetyCall.slice(1)).toEqual([TENANT, 91]);
  });

  test('pack-label fails before reading or issuing a barcode when verification provenance is stale', async () => {
    route('order', [clearedOrder({
      clinical_verification_catalog_sha256: await catalogSha(ITEMS),
      clinical_verification_items_sha256: 'stale-hash',
    })]);

    await expect(getPackLabel(71, TENANT)).rejects.toMatchObject({
      code: 'PHARMACY_VERIFICATION_STALE',
    });

    // The old assertion proxied this invariant through a total call count of 1,
    // which the 752/753 authority locks and reads legitimately broke. Naming the
    // forbidden statements is stronger: no barcode may be written at all, and
    // the order may be read exactly once — the FOR UPDATE provenance read — so
    // getPackLabel cannot fall through to its second, unlocked load.
    expect(callsOfKind('pack_barcode_update')).toHaveLength(0);
    expect(onlyCall('order')[0]).toMatch(/FOR UPDATE OF po, facility/);
  });
});
