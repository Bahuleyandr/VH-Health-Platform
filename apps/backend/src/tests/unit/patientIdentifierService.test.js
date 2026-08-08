/**
 * Phase A2 PR1 — patientIdentifierService unit tests.
 *
 * Mocks prisma.$queryRawUnsafe + $transaction so we can drive every
 * branch (CRUD validation, partial-unique conflict, primary demotion,
 * schema-missing fallbacks) without a live DB.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const transactionMock = jest.fn();
const setTenantTxMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryUnsafeMock,
    $transaction: transactionMock,
  },
  setTenantTx: setTenantTxMock,
}));

const {
  IDENTIFIER_TYPES,
  addPatientIdentifier,
  getPatientIdentifier,
  hashIdentifierValue,
  listPatientIdentifiers,
  lookupByIdentifier,
  reassignIdentifiersForMerge,
  retirePatientIdentifier,
  setPrimaryIdentifier,
} = await import('../../services/patient/patientIdentifierService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const SECONDARY = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  queryUnsafeMock.mockReset();
  transactionMock.mockReset();
  setTenantTxMock.mockReset();
  // Default: $transaction proxies to a tx object backed by the same mock.
  transactionMock.mockImplementation(async (cb) => cb({ $queryRawUnsafe: queryUnsafeMock }));
  // addPatientIdentifier/setPrimaryIdentifier now run under setTenantTx(tid, cb)
  // (sets app.current_tenant_id so RLS enforces inside the tx); proxy it to the
  // same tx mock so the inner statements still record on queryUnsafeMock.
  setTenantTxMock.mockImplementation(async (tenantId, cb) => cb({ $queryRawUnsafe: queryUnsafeMock }));
});

function mockNext(rows) {
  queryUnsafeMock.mockResolvedValueOnce(rows);
}

// ---------------------------------------------------------------------------
// addPatientIdentifier
// ---------------------------------------------------------------------------
describe('addPatientIdentifier', () => {
  it('rejects missing patient_uid', async () => {
    await expect(addPatientIdentifier({ tenantId: TENANT, identifierType: 'mrn', identifierValue: 'X' })).rejects.toThrow(/patient_uid/);
  });

  it('rejects unknown identifier_type', async () => {
    await expect(addPatientIdentifier({ tenantId: TENANT, patientUid: PATIENT, identifierType: 'weird', identifierValue: 'X' })).rejects.toThrow(/identifier_type must be one of/);
  });

  it('rejects empty identifier_value', async () => {
    await expect(addPatientIdentifier({ tenantId: TENANT, patientUid: PATIENT, identifierType: 'mrn', identifierValue: '   ' })).rejects.toThrow(/identifier_value/);
  });

  it('inserts an active row and returns it', async () => {
    mockNext([{ id: 1, patient_uid: PATIENT, identifier_type: 'mrn', identifier_value: 'VH-77001', status: 'active', is_primary: false }]);
    const row = await addPatientIdentifier({
      tenantId: TENANT,
      patientUid: PATIENT,
      identifierType: 'mrn',
      identifierValue: 'VH-77001',
      issuer: 'VH Health Hospital',
      createdBy: 'admin-uid',
    });
    expect(row.id).toBe(1);
    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
    const insertCall = queryUnsafeMock.mock.calls[0];
    expect(insertCall[0]).toMatch(/INSERT INTO patient_identifiers/);
    // tenant, uid, type, value, hash, issuer, assigned, expires, primary, metadata, createdBy
    expect(insertCall[3]).toBe('mrn');
    expect(insertCall[4]).toBe('VH-77001');
    expect(insertCall[5]).toBeNull(); // hash not requested
  });

  it('hashes the value when hashValue=true', async () => {
    mockNext([{ id: 2, identifier_type: 'aadhaar_token' }]);
    await addPatientIdentifier({
      tenantId: TENANT,
      patientUid: PATIENT,
      identifierType: 'aadhaar_token',
      identifierValue: 'AADHAAR-PLAIN',
      hashValue: true,
    });
    const insertCall = queryUnsafeMock.mock.calls[0];
    expect(insertCall[5]).toBe(hashIdentifierValue('AADHAAR-PLAIN'));
    expect(insertCall[5]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('demotes existing primary when isPrimary=true', async () => {
    // First call: demote SET. Second: INSERT.
    mockNext([]);
    mockNext([{ id: 3, is_primary: true }]);
    await addPatientIdentifier({
      tenantId: TENANT,
      patientUid: PATIENT,
      identifierType: 'mrn',
      identifierValue: 'VH-77001',
      isPrimary: true,
    });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/UPDATE patient_identifiers[\s\S]*is_primary = false/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/INSERT INTO patient_identifiers/);
  });

  it('maps a unique-violation to a 409 conflict', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint "uq_patient_identifiers_active_value"'));
    await expect(addPatientIdentifier({
      tenantId: TENANT, patientUid: PATIENT, identifierType: 'mrn', identifierValue: 'VH-77001',
    })).rejects.toMatchObject({ statusCode: 409 });
  });
});

// ---------------------------------------------------------------------------
// listPatientIdentifiers
// ---------------------------------------------------------------------------
describe('listPatientIdentifiers', () => {
  it('rejects missing patient_uid', async () => {
    await expect(listPatientIdentifiers({ tenantId: TENANT })).rejects.toThrow(/patient_uid/);
  });

  it('rejects unknown status', async () => {
    await expect(listPatientIdentifiers({ tenantId: TENANT, patientUid: PATIENT, status: 'frozen' })).rejects.toThrow(/status must be one of/);
  });

  it('returns empty list on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "patient_identifiers" does not exist'));
    const result = await listPatientIdentifiers({ tenantId: TENANT, patientUid: PATIENT });
    expect(result).toEqual({ identifiers: [], count: 0 });
  });

  it('passes status + identifier_type filters into the WHERE clause', async () => {
    mockNext([{ id: 1, identifier_type: 'mrn' }]);
    const result = await listPatientIdentifiers({
      tenantId: TENANT, patientUid: PATIENT, status: 'active', identifierType: 'mrn', limit: 25,
    });
    expect(result.count).toBe(1);
    const args = queryUnsafeMock.mock.calls[0];
    expect(args.slice(1)).toEqual([TENANT, PATIENT, 'active', 'mrn', 25]);
  });
});

// ---------------------------------------------------------------------------
// lookupByIdentifier
// ---------------------------------------------------------------------------
describe('lookupByIdentifier', () => {
  it('looks up by plaintext value when hashValue is false', async () => {
    mockNext([{ id: 1, patient_uid: PATIENT, identifier_type: 'mrn', identifier_value: 'VH-77001' }]);
    const result = await lookupByIdentifier({
      tenantId: TENANT, identifierType: 'mrn', identifierValue: 'VH-77001',
    });
    expect(result.count).toBe(1);
    const args = queryUnsafeMock.mock.calls[0];
    expect(args[3]).toBe('VH-77001');
    expect(args[0]).toMatch(/identifier_value = \$3/);
  });

  it('looks up by hash when hashValue=true', async () => {
    mockNext([{ id: 2 }]);
    await lookupByIdentifier({
      tenantId: TENANT, identifierType: 'aadhaar_token', identifierValue: 'PLAIN', hashValue: true,
    });
    const args = queryUnsafeMock.mock.calls[0];
    expect(args[3]).toBe(hashIdentifierValue('PLAIN'));
    expect(args[0]).toMatch(/identifier_value_hash = \$3/);
  });

  it('returns empty list on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "patient_identifiers" does not exist'));
    const result = await lookupByIdentifier({ tenantId: TENANT, identifierType: 'mrn', identifierValue: 'X' });
    expect(result).toEqual({ identifiers: [], count: 0 });
  });

  it('includes merged identifiers and resolves them to the survivor', async () => {
    mockNext([{
      id: 3, patient_uid: PATIENT, original_patient_uid: SECONDARY,
      status: 'merged_into', merged_into_uid: PATIENT,
      identifier_type: 'mrn', identifier_value: 'VH-99002',
    }]);
    const result = await lookupByIdentifier({
      tenantId: TENANT, identifierType: 'mrn', identifierValue: 'VH-99002',
    });
    expect(result.count).toBe(1);
    const sql = queryUnsafeMock.mock.calls[0][0];
    // Old identifiers stay resolvable after a merge: merged_into rows are
    // included and their patient_uid resolves through merged_into_uid,
    // with active rows sorted first.
    expect(sql).toMatch(/status = 'merged_into' AND merged_into_uid IS NOT NULL/);
    expect(sql).toMatch(/CASE WHEN status = 'merged_into' THEN merged_into_uid/);
    expect(sql).toMatch(/ORDER BY \(status = 'active'\) DESC/);
    expect(result.identifiers[0].patient_uid).toBe(PATIENT);
    expect(result.identifiers[0].original_patient_uid).toBe(SECONDARY);
  });
});

// ---------------------------------------------------------------------------
// getPatientIdentifier
// ---------------------------------------------------------------------------
describe('getPatientIdentifier', () => {
  it('throws 404 when no row matches', async () => {
    mockNext([]);
    await expect(getPatientIdentifier({ tenantId: TENANT, id: 99 })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects non-numeric id', async () => {
    await expect(getPatientIdentifier({ tenantId: TENANT, id: 'abc' })).rejects.toThrow(/positive integer/);
  });
});

// ---------------------------------------------------------------------------
// retirePatientIdentifier
// ---------------------------------------------------------------------------
describe('retirePatientIdentifier', () => {
  it('flips status to retired and clears is_primary', async () => {
    mockNext([{ id: 5, status: 'retired', is_primary: false }]);
    const row = await retirePatientIdentifier({ tenantId: TENANT, id: 5 });
    expect(row.status).toBe('retired');
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/SET status = 'retired', is_primary = false/);
  });

  it('throws 404 when no active row matches', async () => {
    mockNext([]);
    await expect(retirePatientIdentifier({ tenantId: TENANT, id: 99 })).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ---------------------------------------------------------------------------
// setPrimaryIdentifier
// ---------------------------------------------------------------------------
describe('setPrimaryIdentifier', () => {
  it('demotes existing primary then promotes target inside a transaction', async () => {
    // SELECT target / UPDATE demote / UPDATE promote
    mockNext([{ id: 7, patient_uid: PATIENT, identifier_type: 'mrn', status: 'active' }]);
    mockNext([]);
    mockNext([{ id: 7, is_primary: true, identifier_type: 'mrn', status: 'active' }]);
    const row = await setPrimaryIdentifier({ tenantId: TENANT, id: 7 });
    expect(row.is_primary).toBe(true);
    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/UPDATE patient_identifiers[\s\S]*is_primary = false/);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/SET is_primary = true/);
  });

  it('refuses to promote a retired identifier', async () => {
    mockNext([{ id: 8, status: 'retired' }]);
    await expect(setPrimaryIdentifier({ tenantId: TENANT, id: 8 })).rejects.toThrow(/Only active/);
  });

  it('throws 404 when target is missing', async () => {
    mockNext([]);
    await expect(setPrimaryIdentifier({ tenantId: TENANT, id: 999 })).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ---------------------------------------------------------------------------
// reassignIdentifiersForMerge
// ---------------------------------------------------------------------------
describe('reassignIdentifiersForMerge', () => {
  it('rejects merge to self', async () => {
    const tx = { $queryRawUnsafe: queryUnsafeMock };
    await expect(
      reassignIdentifiersForMerge(tx, { tenantId: TENANT, primaryUid: PATIENT, secondaryUid: PATIENT }),
    ).rejects.toThrow(/distinct/);
  });

  it('retargets active rows to the survivor while keeping their original patient_uid', async () => {
    mockNext([
      { id: 21, identifier_type: 'mrn', identifier_value: 'VH-99002' },
      { id: 22, identifier_type: 'mobile', identifier_value: '+919999999999' },
    ]);
    const tx = { $queryRawUnsafe: queryUnsafeMock };
    const result = await reassignIdentifiersForMerge(tx, {
      tenantId: TENANT, primaryUid: PATIENT, secondaryUid: SECONDARY, mergeRequestId: 9,
    });
    expect(result.count).toBe(2);
    const args = queryUnsafeMock.mock.calls[0];
    // Provenance: the row's own patient_uid must NOT be rewritten — only
    // status + merged_into_uid change, and merge metadata is recorded.
    expect(args[0]).not.toMatch(/SET patient_uid/);
    expect(args[0]).toMatch(/SET status = 'merged_into',\s+merged_into_uid = \$1::uuid/);
    expect(args[0]).toMatch(/merge_request_id/);
    expect(args.slice(1)).toEqual([PATIENT, SECONDARY, TENANT, 9]);
  });
});

// ---------------------------------------------------------------------------
// hashIdentifierValue
// ---------------------------------------------------------------------------
describe('hashIdentifierValue', () => {
  it('produces a deterministic 64-char hex hash', () => {
    const a = hashIdentifierValue('AADHAAR-PLAIN');
    const b = hashIdentifierValue('AADHAAR-PLAIN');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('trims whitespace before hashing', () => {
    expect(hashIdentifierValue(' x ')).toBe(hashIdentifierValue('x'));
  });
});

// ---------------------------------------------------------------------------
// IDENTIFIER_TYPES export
// ---------------------------------------------------------------------------
describe('IDENTIFIER_TYPES', () => {
  it('matches the migration CHECK list', () => {
    expect(IDENTIFIER_TYPES).toEqual([
      'mrn', 'uhid', 'abha', 'abha_address', 'mobile', 'aadhaar_token',
      'passport', 'insurance', 'tpa_card', 'employee_id', 'external_emr',
      'national_id', 'driving_license', 'other',
    ]);
  });
});
