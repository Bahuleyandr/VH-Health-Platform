import {
  canManageDeliveryTracking,
  canReadDeliveryTracking,
} from '../../controllers/delivery/deliveryTrackingController.js';

const PATIENT_UID = '11111111-1111-4111-8111-111111111111';

describe('delivery tracking authorization helpers', () => {
  it('allows a patient to read only their own pharmacy delivery tracking', () => {
    const order = {
      uid: PATIENT_UID,
      patient_id: 42,
      phone: '+919876543210',
      patient_phone: '+919876543210',
    };

    expect(canReadDeliveryTracking(order, {
      uid: PATIENT_UID,
      id: 42,
      phone: '+919876543210',
      role: 'PATIENT',
    }, 'pharmacy')).toBe(true);

    expect(canReadDeliveryTracking(order, {
      uid: '22222222-2222-4222-8222-222222222222',
      id: 99,
      phone: '+919999999999',
      role: 'PATIENT',
    }, 'pharmacy')).toBe(false);
  });

  it('allows only the assigned delivery actor to manage tracking outside admin/pharmacy overrides', () => {
    const investigationOrder = {
      assigned_collector: 7,
      delivery_person_phone: '+919876543210',
    };

    expect(canManageDeliveryTracking(investigationOrder, {
      id: 7,
      phone: '+919876543210',
      role: 'DELIVERY_STAFF',
    }, 'investigation')).toBe(true);

    expect(canManageDeliveryTracking(investigationOrder, {
      id: 8,
      phone: '+919111111111',
      role: 'DELIVERY_STAFF',
    }, 'investigation')).toBe(false);
  });

  it('limits pharmacy staff override to pharmacy orders', () => {
    expect(canManageDeliveryTracking({}, { role: 'PHARMACY_STAFF' }, 'pharmacy')).toBe(true);
    expect(canManageDeliveryTracking({}, { role: 'PHARMACY_STAFF' }, 'investigation')).toBe(false);
  });
});
