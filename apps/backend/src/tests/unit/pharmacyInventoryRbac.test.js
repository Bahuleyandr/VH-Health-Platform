import rbacConfig from '../../config/rbacConfig.js';
import {
  PHARMACY_CONTROLLED_DISPENSE_ROLES,
  PHARMACY_INVENTORY_ADMIN_ROLES,
  PHARMACY_INVENTORY_MAINTAIN_ROLES,
  PHARMACY_INVENTORY_READ_ROLES,
} from '../../routes/pharmacy/inventoryV2Routes.js';

describe('pharmacy inventory RBAC', () => {
  it('registers explicit wrapper keys for legacy pharmacy inventory routes', () => {
    expect(rbacConfig.pharmacyStaffInventoryRoutes).toEqual(expect.arrayContaining([
      'PHARMACY_STAFF',
      'PHARMACY_INCHARGE',
      'STORES_PURCHASE_INCHARGE',
      'ADMIN',
    ]));
    expect(rbacConfig.pharmacyStaffMedicationRoutes).toEqual(expect.arrayContaining([
      'PHARMACY_STAFF',
      'PHARMACY_INCHARGE',
      'STORES_PURCHASE_INCHARGE',
      'ADMIN',
    ]));
    expect(rbacConfig.pharmacyAdminMedicationRoutes).toEqual([
      'PHARMACY_INCHARGE',
      'ADMIN',
    ]);
  });

  it('allows stores/purchase to maintain inventory but not controlled dispensing', () => {
    expect(PHARMACY_INVENTORY_READ_ROLES).toContain('STORES_PURCHASE_INCHARGE');
    expect(PHARMACY_INVENTORY_MAINTAIN_ROLES).toContain('STORES_PURCHASE_INCHARGE');
    expect(PHARMACY_INVENTORY_ADMIN_ROLES).toContain('STORES_PURCHASE_INCHARGE');
    expect(PHARMACY_CONTROLLED_DISPENSE_ROLES).not.toContain('STORES_PURCHASE_INCHARGE');
  });

  it('keeps the canonical pharmacist role wired through inventory and dispensing', () => {
    expect(PHARMACY_INVENTORY_READ_ROLES).toContain('PHARMACIST');
    expect(PHARMACY_INVENTORY_MAINTAIN_ROLES).toContain('PHARMACIST');
    expect(PHARMACY_CONTROLLED_DISPENSE_ROLES).toContain('PHARMACIST');
  });
});
