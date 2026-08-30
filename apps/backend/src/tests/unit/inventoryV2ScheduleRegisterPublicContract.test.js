import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const txMock = { $queryRawUnsafe: queryRawUnsafeMock };
const setTenantTxMock = jest.fn(async (_tenantId, callback) => callback(txMock));
const assertPharmacyFacilityGrantMock = jest.fn(async () => ({
  actor: { uid: '11111111-1111-4111-8111-111111111111', role: 'PHARMACY_STAFF' },
  facility: { id: 23 },
  grant: { id: 31 },
}));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: txMock,
  isTenantTransactionClient: () => true,
  setTenantTx: setTenantTxMock,
}));

jest.unstable_mockModule('../../services/pharmacy/pharmacyFacilityAuthorityService.js', () => ({
  assertPharmacyFacilityGrant: assertPharmacyFacilityGrantMock,
}));

const { listScheduleRegister } = await import(
  '../../services/pharmacy/inventoryV2Service.js'
);

const TENANT = '00000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '00000000-0000-4000-8000-000000000002';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const FACILITY = 23;
const PUBLIC_KEYS = [
  'id',
  'facility_id',
  'inventory_item_id',
  'inventory_batch_id',
  'created_at',
  'schedule_class',
  'movement_kind',
  'sku_code',
  'display_name',
  'generic_name',
  'brand_name',
  'strength',
  'form',
  'batch_number',
  'expiry_date',
  'quantity',
  'unit_label',
  'running_balance',
  'patient_uid',
  'patient_name',
  'patient_phone',
  'prescription_id',
  'prescription_number',
  'prescriber_uid',
  'prescriber_name',
  'prescriber_registration',
  'patient_id_proof_type',
  'patient_id_proof_last4',
  'performed_by',
  'performed_by_name',
  'witness_uid',
  'witness_name',
  'reference_movement_id',
  'notes',
];

const baseRow = {
  id: '51',
  tenant_id: TENANT,
  facility_id: '23',
  inventory_item_id: '17',
  inventory_batch_id: '19',
  created_at: new Date('2026-08-30T05:15:00.123Z'),
  schedule_class: 'H1',
  movement_kind: 'dispense',
  current_item_id: '17',
  current_item_tenant_id: TENANT,
  current_item_facility_id: '23',
  sku_code: 'MORPH-10',
  display_name: 'Morphine 10 mg tablet',
  generic_name: 'Morphine',
  brand_name: null,
  strength: '10 mg',
  form: 'tablet',
  current_batch_id: '19',
  current_batch_tenant_id: TENANT,
  current_batch_inventory_item_id: '17',
  current_batch_facility_id: '23',
  batch_number: 'LOT-2026-09',
  expiry_date: new Date('2027-09-30T00:00:00.000Z'),
  quantity: '2.5000',
  unit_label: 'tablet',
  running_balance: '17.1250',
  patient_uid: '22222222-2222-4222-8222-222222222222',
  patient_name: 'Patient One',
  patient_phone: null,
  prescription_id: '43',
  prescription_number: 'RX-43',
  prescriber_uid: '33333333-3333-4333-8333-333333333333',
  prescriber_name: 'Dr One',
  prescriber_registration: 'MCI-43',
  patient_id_proof_type: null,
  patient_id_proof_last4: null,
  performed_by: ACTOR,
  performed_by_name: 'Pharmacist One',
  witness_uid: null,
  witness_name: null,
  reference_movement_id: '97',
  notes: null,
  internal_audit_only: 'must-not-leak',
};

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  setTenantTxMock.mockClear();
  assertPharmacyFacilityGrantMock.mockClear();
});

describe('inventory V2 statutory-register public contract', () => {
  test('returns only exact public keys with canonical IDs, decimals, timestamps, and dates', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([
      baseRow,
      {
        ...baseRow,
        id: '52',
        inventory_batch_id: null,
        current_batch_id: null,
        current_batch_tenant_id: null,
        current_batch_inventory_item_id: null,
        current_batch_facility_id: null,
        batch_number: null,
        expiry_date: null,
        prescription_id: null,
        reference_movement_id: null,
      },
    ]);

    const result = await listScheduleRegister({
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'PHARMACY_STAFF',
      facility_id: FACILITY,
    });

    expect(Object.keys(result[0])).toEqual(PUBLIC_KEYS);
    expect(result[0]).toEqual({
      id: 51,
      facility_id: FACILITY,
      inventory_item_id: 17,
      inventory_batch_id: 19,
      created_at: '2026-08-30T05:15:00.123Z',
      schedule_class: 'H1',
      movement_kind: 'dispense',
      sku_code: 'MORPH-10',
      display_name: 'Morphine 10 mg tablet',
      generic_name: 'Morphine',
      brand_name: null,
      strength: '10 mg',
      form: 'tablet',
      batch_number: 'LOT-2026-09',
      expiry_date: '2027-09-30',
      quantity: 2.5,
      unit_label: 'tablet',
      running_balance: 17.125,
      patient_uid: '22222222-2222-4222-8222-222222222222',
      patient_name: 'Patient One',
      patient_phone: null,
      prescription_id: 43,
      prescription_number: 'RX-43',
      prescriber_uid: '33333333-3333-4333-8333-333333333333',
      prescriber_name: 'Dr One',
      prescriber_registration: 'MCI-43',
      patient_id_proof_type: null,
      patient_id_proof_last4: null,
      performed_by: ACTOR,
      performed_by_name: 'Pharmacist One',
      witness_uid: null,
      witness_name: null,
      reference_movement_id: 97,
      notes: null,
    });
    expect(result[0]).not.toHaveProperty('tenant_id');
    expect(result[0]).not.toHaveProperty('internal_audit_only');
    expect(result[0]).not.toHaveProperty('current_item_id');
    expect(result[0]).not.toHaveProperty('current_item_tenant_id');
    expect(result[0]).not.toHaveProperty('current_item_facility_id');
    expect(result[0]).not.toHaveProperty('current_batch_id');
    expect(result[0]).not.toHaveProperty('current_batch_tenant_id');
    expect(result[0]).not.toHaveProperty('current_batch_inventory_item_id');
    expect(result[0]).not.toHaveProperty('current_batch_facility_id');
    expect(Object.keys(result[1])).toEqual(PUBLIC_KEYS);
    expect(result[1]).toMatchObject({
      inventory_batch_id: null,
      expiry_date: null,
      prescription_id: null,
      reference_movement_id: null,
    });
    const sql = queryRawUnsafeMock.mock.calls[0][0];
    expect(sql).toContain('FROM pharmacy_schedule_register register');
    expect(sql).toContain('LEFT JOIN pharmacy_inventory_items item');
    expect(sql).toContain('LEFT JOIN pharmacy_inventory_batches batch');
    expect(sql).toContain('item.id AS current_item_id');
    expect(sql).toContain('item.tenant_id AS current_item_tenant_id');
    expect(sql).toContain('item.facility_id AS current_item_facility_id');
    expect(sql).toContain('batch.id AS current_batch_id');
    expect(sql).toContain('batch.tenant_id AS current_batch_tenant_id');
    expect(sql).toContain('batch.inventory_item_id AS current_batch_inventory_item_id');
    expect(sql).toContain('batch.facility_id AS current_batch_facility_id');
    expect(sql).toContain('ORDER BY register.created_at DESC, register.id DESC');
  });

  test('rejects a facility ID above PostgreSQL int4 before opening a transaction', async () => {
    await expect(listScheduleRegister({
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'PHARMACY_STAFF',
      facility_id: '2147483648',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'PHARMACY_FACILITY_REQUIRED',
    });
    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  test('rejects an item ID above PostgreSQL int4 before opening a transaction', async () => {
    await expect(listScheduleRegister({
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'PHARMACY_STAFF',
      facility_id: FACILITY,
      item_id: '2147483648',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'PHARMACY_SCHEDULE_REGISTER_FILTER_INVALID',
      details: { field: 'item_id' },
    });
    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  test.each([
    ['id', { id: 'not-an-id' }, 'id'],
    ['inventory item ID', { inventory_item_id: '2147483648' }, 'inventory_item_id'],
    ['inventory batch ID', { inventory_batch_id: '2147483648' }, 'inventory_batch_id'],
    ['quantity', { quantity: 'not-a-decimal' }, 'quantity'],
    ['running balance', { running_balance: '' }, 'running_balance'],
    ['created timestamp', { created_at: 'not-a-timestamp' }, 'created_at'],
    ['expiry date', { expiry_date: '2027-02-30' }, 'expiry_date'],
  ])('fails closed on corrupt statutory-register %s', async (_label, mutation, field) => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ ...baseRow, ...mutation }]);

    await expect(listScheduleRegister({
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'PHARMACY_STAFF',
      facility_id: FACILITY,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_SCHEDULE_REGISTER_ROW_INVALID',
      details: { field },
    });
  });

  test.each([
    ['missing item', {
      current_item_id: null,
      current_item_tenant_id: null,
      current_item_facility_id: null,
    }],
    ['mismatched item ID', { current_item_id: '18' }],
    ['mismatched item tenant', { current_item_tenant_id: OTHER_TENANT }],
    ['mismatched item facility', { current_item_facility_id: '24' }],
  ])('fails closed when current %s authority is inconsistent', async (_label, mutation) => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ ...baseRow, ...mutation }]);

    await expect(listScheduleRegister({
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'PHARMACY_STAFF',
      facility_id: FACILITY,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_SCHEDULE_REGISTER_ROW_INVALID',
    });
  });

  test.each([
    ['missing batch', {
      current_batch_id: null,
      current_batch_tenant_id: null,
      current_batch_inventory_item_id: null,
      current_batch_facility_id: null,
    }],
    ['mismatched batch ID', { current_batch_id: '20' }],
    ['mismatched batch tenant', { current_batch_tenant_id: OTHER_TENANT }],
    ['mismatched batch item', { current_batch_inventory_item_id: '18' }],
    ['mismatched batch facility', { current_batch_facility_id: '24' }],
  ])('fails closed when a non-null register batch has %s evidence', async (_label, mutation) => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ ...baseRow, ...mutation }]);

    await expect(listScheduleRegister({
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'PHARMACY_STAFF',
      facility_id: FACILITY,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_SCHEDULE_REGISTER_ROW_INVALID',
    });
  });

  test.each(['H', 'H1', 'X'])(
    'accepts only canonical statutory class %s with canonical UTC bounds',
    async (scheduleClass) => {
      queryRawUnsafeMock.mockResolvedValueOnce([]);
      const dateFrom = '2026-08-01T00:00:00.000Z';
      const dateTo = '2026-08-31T23:59:59.999Z';

      await listScheduleRegister({
        tenantId: TENANT,
        actorUid: ACTOR,
        actorRole: 'PHARMACY_STAFF',
        facility_id: FACILITY,
        schedule_class: scheduleClass,
        date_from: dateFrom,
        date_to: dateTo,
      });

      expect(queryRawUnsafeMock.mock.calls[0].slice(1)).toEqual([
        TENANT,
        FACILITY,
        scheduleClass,
        dateFrom,
        dateTo,
        200,
      ]);
    },
  );

  test.each([
    ['schedule_class', 'h1'],
    ['date_from', '2026-08-01T05:30:00.000+05:30'],
    ['date_to', '2026-02-30T00:00:00.000Z'],
  ])('rejects non-canonical %s before opening a transaction', async (field, value) => {
    await expect(listScheduleRegister({
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'PHARMACY_STAFF',
      facility_id: FACILITY,
      [field]: value,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'PHARMACY_SCHEDULE_REGISTER_FILTER_INVALID',
      details: { field },
    });
    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  test('rejects a reversed canonical UTC range before opening a transaction', async () => {
    await expect(listScheduleRegister({
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'PHARMACY_STAFF',
      facility_id: FACILITY,
      date_from: '2026-09-01T00:00:00.000Z',
      date_to: '2026-08-31T23:59:59.999Z',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'PHARMACY_SCHEDULE_REGISTER_FILTER_INVALID',
      details: { field: 'date_range' },
    });
    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });
});
