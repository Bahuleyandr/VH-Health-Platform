import { resolveClinicalImportAuthority } from '../../routes/documents/documentRoutes.js';

const ACTOR_UID = '10000000-0000-4000-8000-000000000001';
const ITEM_UID = '20000000-0000-4000-8000-000000000002';
const TENANT_UID = '30000000-0000-4000-8000-000000000003';

function request(headers = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    tenantId: TENANT_UID,
    user: { uid: ACTOR_UID, role: 'MEDICAL_RECORDS' },
    get: name => normalized[name.toLowerCase()] ?? '',
  };
}

describe('clinical import correction authority headers', () => {
  test.each([
    ['missing manifest index', {
      'X-VH-Import-Correction-Item-Id': ITEM_UID,
    }],
    ['missing item id', {
      'X-VH-Import-Correction-Manifest-Index': '0',
    }],
    ['malformed item id', {
      'X-VH-Import-Correction-Item-Id': 'not-a-uuid',
      'X-VH-Import-Correction-Manifest-Index': '0',
    }],
    ['negative index', {
      'X-VH-Import-Correction-Item-Id': ITEM_UID,
      'X-VH-Import-Correction-Manifest-Index': '-1',
    }],
    ['non-canonical leading zero', {
      'X-VH-Import-Correction-Item-Id': ITEM_UID,
      'X-VH-Import-Correction-Manifest-Index': '01',
    }],
    ['fractional index', {
      'X-VH-Import-Correction-Item-Id': ITEM_UID,
      'X-VH-Import-Correction-Manifest-Index': '1.0',
    }],
    ['out-of-contract index', {
      'X-VH-Import-Correction-Item-Id': ITEM_UID,
      'X-VH-Import-Correction-Manifest-Index': '10000',
    }],
  ])('rejects a %s before any patient or database lookup', async (_label, headers) => {
    await expect(resolveClinicalImportAuthority(request(headers), {}, 'fhir_bundle'))
      .rejects.toMatchObject({
        statusCode: 400,
        code: 'IMPORT_CORRECTION_BINDING_INVALID',
      });
  });

  test.each([
    ['ordinary import', {}],
    ['bounded correction pair', {
      'X-VH-Import-Correction-Item-Id': ITEM_UID,
      'X-VH-Import-Correction-Manifest-Index': '9999',
    }],
  ])('accepts the %s header shape and continues to normal authority validation', async (
    _label,
    headers,
  ) => {
    await expect(resolveClinicalImportAuthority(request(headers), {}, 'fhir_bundle'))
      .rejects.toMatchObject({
        statusCode: 400,
        code: 'IMPORT_TARGET_PATIENT_REQUIRED',
      });
  });
});
