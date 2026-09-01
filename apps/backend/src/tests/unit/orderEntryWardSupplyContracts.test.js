import { jest } from '@jest/globals';

import {
  createOrdersBulk,
  normalizeOrderInput,
  prepareClinicalOrdersAuthorityTx,
} from '../../services/emr/orderEntryService.js';

const TENANT = '10000000-0000-4000-8000-000000000001';
const PATIENT = '10000000-0000-4000-8000-000000000002';
const DOCTOR = '10000000-0000-4000-8000-000000000003';
const ENCOUNTER = '10000000-0000-4000-8000-000000000004';

const medication = (overrides = {}) => ({
  patient_uid: PATIENT,
  ordered_by: DOCTOR,
  order_type: 'medication',
  encounter_id: ENCOUNTER,
  details: {
    medication_name: 'Ceftriaxone 1 g vial',
    dose: '1 g',
    route: 'IV',
    frequency: 'BD',
    catalog_id: 73,
    quantity_requested: 6,
    unit: 'vial',
    ...overrides,
  },
});

function authorityTx({
  encounterId = ENCOUNTER,
  erVisitId = null,
  erStatus = 'in_treatment',
  encounterErStatus = erStatus,
  admissionStatus = null,
  admissionWardId = 17,
  actorRole = 'DOCTOR',
  catalogActive = true,
} = {}) {
  return {
    $queryRawUnsafe: jest.fn(async (sql) => {
      if (sql.includes('FROM users') && sql.includes('uid = ANY') && !sql.includes('is_active')) {
        return [{ uid: PATIENT }];
      }
      if (sql.includes('FROM users') && sql.includes('is_active = TRUE')) {
        return actorRole == null ? [] : [{ uid: DOCTOR, role: actorRole }];
      }
      if (sql.includes('FROM emergency_visits') && sql.includes('AND id = ANY')) {
        return erVisitId == null ? [] : [{
          id: erVisitId,
          patient_uid: PATIENT,
          encounter_id: encounterId,
          status: erStatus,
        }];
      }
      if (sql.includes('FROM admissions') && sql.includes('encounter_id = ANY')) {
        return admissionStatus == null
          ? []
          : [
              {
                id: 91,
                patient_uid: PATIENT,
                encounter_id: encounterId,
                status: admissionStatus,
                bed_id: admissionWardId == null ? null : 27,
                ward_id: admissionWardId
              }
            ];
      }
      if (sql.includes('FROM emergency_visits') && sql.includes('encounter_id = ANY')) {
        return erVisitId == null ? [] : [{
          id: erVisitId,
          patient_uid: PATIENT,
          encounter_id: encounterId,
          status: encounterErStatus,
        }];
      }
      if (sql.includes('FROM patient_encounters')) return [];
      if (sql.includes('FROM pharmacy_catalog catalog')) {
        return [{
          id: 73,
          name: 'Ceftriaxone 1 g vial',
          generic_name: 'ceftriaxone',
          is_active: catalogActive,
          category: 'antibiotic',
          requires_prescription: true,
          composition_id: 501,
          composition_source: 'curated',
          composition_confidence: 'high',
          strength: '1 g',
          strength_key: '1000mg',
          strength_components: [{ ingredient: 'ceftriaxone', value: 1000, unit: 'mg' }],
          form: 'vial',
          form_key: 'vial',
          release_key: 'ir',
          route: 'IV',
        }];
      }
      if (sql.includes('FROM pharmacy_inventory_items inventory')) return [];
      throw new Error(`Unexpected SQL in authority test: ${sql}`);
    }),
  };
}

describe('inpatient CPOE ward-supply capture contract', () => {
  test.each([
    [{ catalog_id: undefined }, 'CLINICAL_ORDER_MEDICATION_CATALOG_REQUIRED'],
    [{ dose: undefined }, 'CLINICAL_ORDER_MEDICATION_DOSE_REQUIRED'],
    [{ route: undefined }, 'CLINICAL_ORDER_MEDICATION_ROUTE_REQUIRED'],
    [{ catalog_id: 'not-an-id' }, 'CLINICAL_ORDER_MEDICATION_CATALOG_INVALID'],
    [{ quantity_requested: undefined }, 'CLINICAL_ORDER_MEDICATION_SUPPLY_QUANTITY_REQUIRED'],
    [{ quantity_requested: 0 }, 'CLINICAL_ORDER_MEDICATION_SUPPLY_QUANTITY_INVALID'],
    [{ unit: undefined }, 'CLINICAL_ORDER_MEDICATION_SUPPLY_UNIT_REQUIRED'],
    [{ unit: 'box' }, 'CLINICAL_ORDER_MEDICATION_SUPPLY_UNIT_INVALID'],
  ])('rejects missing or invalid inpatient supply evidence %#', async (details, code) => {
    await expect(normalizeOrderInput(medication(details))).rejects.toMatchObject({ code });
  });

  test('explicit encounter_id null without ER context cannot create a MAR-bound medication', async () => {
    await expect(normalizeOrderInput({
      ...medication(),
      encounter_id: null,
      details: {
        medication_name: 'Ceftriaxone',
        dose: '1 g',
        route: 'IV',
      },
    })).rejects.toMatchObject({ code: 'CLINICAL_ORDER_MEDICATION_ENCOUNTER_REQUIRED' });
  });

  test('bulk treats explicit encounter_id null as absent instead of inheriting MAR authority', async () => {
    await expect(createOrdersBulk([{
      ...medication(),
      encounter_id: null,
    }], {
      ordered_by: DOCTOR,
      tenantId: TENANT,
    })).rejects.toMatchObject({ code: 'CLINICAL_ORDER_MEDICATION_ENCOUNTER_REQUIRED' });
  });

  test('er_visit_id requires supply evidence before transactional resolution', async () => {
    await expect(normalizeOrderInput({
      ...medication(),
      encounter_id: null,
      er_visit_id: 41,
      details: {
        medication_name: 'Ceftriaxone',
        dose: '1 g',
        route: 'IV',
      },
    })).rejects.toMatchObject({ code: 'CLINICAL_ORDER_MEDICATION_CATALOG_REQUIRED' });
  });

  test.each([0, -1, 1.5, 'not-a-visit'])(
    'rejects invalid er_visit_id instead of treating it as absent (%s)',
    async (erVisitId) => {
      await expect(normalizeOrderInput({
        ...medication(),
        encounter_id: null,
        er_visit_id: erVisitId,
      })).rejects.toMatchObject({ statusCode: 400 });
    },
  );

  test('an ER-only visit resolves its encounter but cannot own MAR ward-supply custody', async () => {
    const normalized = await normalizeOrderInput({
      ...medication(),
      encounter_id: null,
      er_visit_id: 41,
    });
    const tx = authorityTx({ erVisitId: 41 });
    await expect(prepareClinicalOrdersAuthorityTx(tx, TENANT, [normalized])).rejects.toMatchObject({
      statusCode: 409,
      code: 'CLINICAL_ORDER_MEDICATION_WARD_SUPPLY_CONTEXT_REQUIRED'
    });

    expect(normalized.encounter_id).toBe(ENCOUNTER);
  });

  test('locked catalog authority derives the canonical medication name before CDS and MAR', async () => {
    const normalized = await normalizeOrderInput(medication({ medication_name: undefined }));
    await prepareClinicalOrdersAuthorityTx(
      authorityTx({ admissionStatus: 'admitted' }),
      TENANT,
      [normalized],
    );

    expect(normalized.details.medication_name).toBe('Ceftriaxone 1 g vial');
    expect(normalized.details.catalog_authority.prescribed.medication_name)
      .toBe('Ceftriaxone 1 g vial');
  });

  test('rejects a caller medication name that conflicts with the locked catalog', async () => {
    const normalized = await normalizeOrderInput(medication({
      medication_name: 'Unrelated insulin product',
    }));
    await expect(
      prepareClinicalOrdersAuthorityTx(
        authorityTx({ admissionStatus: 'admitted' }),
        TENANT,
        [normalized],
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'CLINICAL_ORDER_MEDICATION_CATALOG_CLINICAL_IDENTITY_MISMATCH',
      details: { mismatched_dimensions: expect.arrayContaining(['medication_name']) },
    });
  });

  test('non-catalog medication orders cannot omit medication identity', async () => {
    await expect(normalizeOrderInput({
      ...medication(),
      details: { dose: '1 g', route: 'IV' },
    })).rejects.toMatchObject({ code: 'CLINICAL_ORDER_MEDICATION_NAME_REQUIRED' });
  });

  test.each(['discharged', 'left_against_advice', 'lwbs', 'expired', 'archived'])(
    'closed ER status cannot own a MAR-bound medication order (%s)',
    async (status) => {
      const normalized = await normalizeOrderInput({
        ...medication(),
        encounter_id: null,
        er_visit_id: 41,
      });
      await expect(
        prepareClinicalOrdersAuthorityTx(authorityTx({ erVisitId: 41, erStatus: status }), TENANT, [
          normalized
        ])
      ).rejects.toMatchObject({
        code: 'CLINICAL_ORDER_MEDICATION_WARD_SUPPLY_CONTEXT_REQUIRED'
      });
    }
  );

  test('the explicitly selected ER visit cannot borrow another active row on the same encounter', async () => {
    const normalized = await normalizeOrderInput({
      ...medication(),
      encounter_id: null,
      er_visit_id: 41,
    });
    await expect(
      prepareClinicalOrdersAuthorityTx(
        authorityTx({
          erVisitId: 41,
          erStatus: 'discharged',
          encounterErStatus: 'in_treatment',
        }),
        TENANT,
        [normalized]
      )
    ).rejects.toMatchObject({
      code: 'CLINICAL_ORDER_MEDICATION_WARD_SUPPLY_CONTEXT_REQUIRED'
    });
  });

  test('active admission without an authoritative ward fails before catalog binding', async () => {
    const normalized = await normalizeOrderInput(medication());
    await expect(
      prepareClinicalOrdersAuthorityTx(
        authorityTx({ admissionStatus: 'admitted', admissionWardId: null }),
        TENANT,
        [normalized]
      )
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'CLINICAL_ORDER_MEDICATION_WARD_REQUIRED'
    });
  });

  test('inactive inpatient admission rejects medication creation transactionally', async () => {
    const normalized = await normalizeOrderInput(medication());
    const tx = authorityTx({ admissionStatus: 'lama' });
    await expect(
      prepareClinicalOrdersAuthorityTx(tx, TENANT, [normalized]),
    ).rejects.toMatchObject({ code: 'CLINICAL_ORDER_MEDICATION_ADMISSION_INACTIVE' });
  });

  test.each(['ADMIN', 'SUPER_ADMIN', 'MEDICAL_SUPERINTENDENT', null])(
    'rejects medication creation without active transactional prescriber authority (%s)',
    async (actorRole) => {
      const normalized = await normalizeOrderInput(medication());
      await expect(
        prepareClinicalOrdersAuthorityTx(
          authorityTx({ actorRole, admissionStatus: 'admitted' }),
          TENANT,
          [normalized],
        ),
      ).rejects.toMatchObject({
        code: 'CLINICAL_ORDER_MEDICATION_ACTIVE_PRESCRIBER_REQUIRED',
      });
    },
  );

  test('nullable catalog active flag fails closed', async () => {
    const normalized = await normalizeOrderInput(medication());
    await expect(
      prepareClinicalOrdersAuthorityTx(
        authorityTx({ admissionStatus: 'admitted', catalogActive: null }),
        TENANT,
        [normalized],
      ),
    ).rejects.toMatchObject({ code: 'CLINICAL_ORDER_MEDICATION_CATALOG_UNAVAILABLE' });
  });
});
