import rbacConfig from '../../config/rbacConfig.js';

describe('pharmacy catalog RBAC', () => {
  it('allows clinical users to read the shared formulary but reserves writes for pharmacy incharge/admin', () => {
    expect(rbacConfig.pharmacyCatalogRoutes).toEqual(
      expect.arrayContaining([
        'PHARMACY_STAFF',
        'PHARMACY_INCHARGE',
        'STORES_PURCHASE_INCHARGE',
        'DOCTOR',
        'DUTY_DOCTOR',
        'CONSULTANT',
        'JUNIOR_DOCTOR',
        'RESIDENT',
        'NURSING_STAFF',
        'IP_STAFF_NURSE',
        'OP_STAFF_NURSE',
        'ADMIN',
      ]),
    );

    expect(rbacConfig.pharmacyCatalogAdminRoutes).toEqual(
      expect.arrayContaining(['PHARMACY_INCHARGE', 'ADMIN']),
    );
    expect(rbacConfig.pharmacyCatalogAdminRoutes).not.toContain(
      'PHARMACY_STAFF',
    );
    expect(rbacConfig.pharmacyCatalogAdminRoutes).not.toContain(
      'STORES_PURCHASE_INCHARGE',
    );
    expect(rbacConfig.pharmacyCatalogAdminRoutes).not.toContain('DOCTOR');
    expect(rbacConfig.pharmacyCatalogAdminRoutes).not.toContain(
      'NURSING_STAFF',
    );
  });
});
