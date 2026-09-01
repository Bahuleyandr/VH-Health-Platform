import { jest } from '@jest/globals';

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn() },
}));
jest.unstable_mockModule('../../utils/clinical/prescriptionSafetyCheck.js', () => ({
  validatePrescriptionSafety: jest.fn(async () => ({ warnings: [], blockers: [] })),
  checkAntithromboticInteractions: jest.fn(() => ({ warnings: [], blockers: [] })),
}));

const { buildWardIndentRecoveryProjection } = await import(
  '../../services/clinical/drugChartService.js'
);

const admission = {
  id: 73,
  status: 'admitted',
  patient_uid: '10000000-0000-4000-8000-000000000001',
  patient_name: 'Test Patient',
  hospital_id: 'VH-000073',
  encounter_id: '20000000-0000-4000-8000-000000000001',
  ward_id: 5,
  ward_name: 'Ward A',
  tenant_id: '40000000-0000-4000-8000-000000000001',
};

function medicationOrder(overrides = {}) {
  return {
    id: 91,
    order_number: 'ORD-91',
    patient_uid: admission.patient_uid,
    encounter_id: admission.encounter_id,
    tenant_id: admission.tenant_id,
    order_type: 'medication',
    status: 'ordered',
    priority: 'routine',
    verified_by: null,
    verified_at: null,
    details: {
      catalog_id: 41,
      medication_name: 'Caller text must not become the item label',
      quantity_requested: 2.5,
      quantity_unit: ' tablets ',
      route: 'oral',
      dose: '500 mg',
      frequency: 'TID',
      dose_times: ['08:00', '14:00', '20:00'],
    },
    ...overrides,
  };
}

describe('buildWardIndentRecoveryProjection', () => {
  it('projects only server-bound fields and read-only admission context', () => {
    const projection = buildWardIndentRecoveryProjection({
      admission,
      orders: [medicationOrder()],
      linkedClinicalOrderIds: [],
      catalogs: [{ id: 41, name: 'Paracetamol 500 mg tablet' }],
    });

    expect(projection).toEqual({
      kind: 'order_bound_recovery',
      online_only: true,
      admission: {
        id: 73,
        status: 'admitted',
        patient_uid: admission.patient_uid,
        patient_name: 'Test Patient',
        hospital_id: 'VH-000073',
        encounter_id: admission.encounter_id,
        ward_id: 5,
        ward_name: 'Ward A',
      },
      eligible_orders: [{
        clinical_order_id: 91,
        order_number: 'ORD-91',
        status: 'ordered',
        priority: 'routine',
        catalog_id: 41,
        item_label: 'Paracetamol 500 mg tablet',
        quantity: 2.5,
        unit: 'tablets',
        route: 'oral',
        dose: '500 mg',
        frequency: 'TID',
        schedule: ['08:00', '14:00', '20:00'],
      }],
    });
    expect(projection.eligible_orders[0]).not.toHaveProperty('patient_uid');
    expect(projection.eligible_orders[0]).not.toHaveProperty('unit_price');
  });

  it('excludes linked, inactive, non-medication, and incompletely verified orders', () => {
    const projection = buildWardIndentRecoveryProjection({
      admission,
      orders: [
        medicationOrder({ id: 1 }),
        medicationOrder({ id: 2, status: 'discontinued' }),
        medicationOrder({ id: 3, order_type: 'investigation' }),
        medicationOrder({ id: 4, status: 'verified' }),
        medicationOrder({
          id: 5,
          status: 'verified',
          verified_by: '30000000-0000-4000-8000-000000000001',
          verified_at: '2026-08-28T10:00:00.000Z',
        }),
      ],
      linkedClinicalOrderIds: [1],
      catalogs: [{ id: 41, name: 'Paracetamol 500 mg tablet' }],
    });

    expect(projection.eligible_orders.map((order) => order.clinical_order_id)).toEqual([5]);
  });

  it('excludes every tenant-global clinical-order link supplied by the authority query', () => {
    const projection = buildWardIndentRecoveryProjection({
      admission,
      orders: [medicationOrder()],
      linkedClinicalOrderIds: [91],
      catalogs: [{ id: 41, name: 'Paracetamol 500 mg tablet' }],
    });

    expect(projection.eligible_orders).toEqual([]);
  });

  it('excludes orders outside the selected admission and tenant', () => {
    const projection = buildWardIndentRecoveryProjection({
      admission,
      orders: [
        medicationOrder({ id: 1, patient_uid: '50000000-0000-4000-8000-000000000001' }),
        medicationOrder({ id: 2, encounter_id: '60000000-0000-4000-8000-000000000001' }),
        medicationOrder({ id: 3, tenant_id: '70000000-0000-4000-8000-000000000001' }),
      ],
      linkedClinicalOrderIds: [],
      catalogs: [{ id: 41, name: 'Paracetamol 500 mg tablet' }],
    });

    expect(projection.eligible_orders).toEqual([]);
  });

  it('excludes orders whose canonical catalog, quantity, or unit is not requestable', () => {
    const projection = buildWardIndentRecoveryProjection({
      admission,
      orders: [
        medicationOrder({ id: 1, details: { quantity: 1, unit: 'tablet' } }),
        medicationOrder({ id: 2, details: { catalog_id: 42, quantity: 1, unit: 'tablet' } }),
        medicationOrder({ id: 3, details: { catalog_id: 41, quantity: 1.234, unit: 'tablet' } }),
        medicationOrder({ id: 4, details: { catalog_id: 41, quantity: 1 } }),
        medicationOrder({ id: 5, details: { catalog_id: true, quantity: 1, unit: 'tablet' } }),
        medicationOrder({ id: 6, details: { catalog_id: 41, quantity: true, unit: 'tablet' } }),
        medicationOrder({ id: 7, details: { catalog_id: 41, quantity: 1, unit: true } }),
        medicationOrder({ id: 8, details: { catalog_id: 41, quantity: '1.230', unit: 'tablet' } }),
      ],
      linkedClinicalOrderIds: [],
      catalogs: [{ id: 41, name: 'Paracetamol 500 mg tablet' }],
    });

    expect(projection.eligible_orders).toEqual([]);
  });

  it.each(['discharged', 'lama', 'unknown', ''])(
    'returns no eligible orders for a non-active %s admission',
    (status) => {
      const projection = buildWardIndentRecoveryProjection({
        admission: { ...admission, status },
        orders: [medicationOrder()],
        linkedClinicalOrderIds: [],
        catalogs: [{ id: 41, name: 'Paracetamol 500 mg tablet' }],
      });

      expect(projection.eligible_orders).toEqual([]);
      expect(projection.admission.status).toBe(status);
    },
  );

  it('keeps transferred admissions eligible for order-bound recovery', () => {
    const projection = buildWardIndentRecoveryProjection({
      admission: { ...admission, status: 'transferred' },
      orders: [medicationOrder()],
      linkedClinicalOrderIds: [],
      catalogs: [{ id: 41, name: 'Paracetamol 500 mg tablet' }],
    });

    expect(projection.eligible_orders).toHaveLength(1);
  });
});
