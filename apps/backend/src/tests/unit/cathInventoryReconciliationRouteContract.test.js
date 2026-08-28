import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { jest } from '@jest/globals';

import {
  CATH_INVENTORY_RECONCILIATION_ROUTE_ROLES,
  CATH_LAB_ROUTE_ROLES,
} from '../../config/routeRolePolicy.js';
import {
  CATH_INVENTORY_SHORTFALL_PRESENTATIONS,
  canMutateCathInventoryReconciliationRole,
  canViewCathInventoryReconciliationRole,
  getCathConsumableInventoryReconciliation,
  reconcileCathConsumableInventory,
} from '../../services/clinical/cathLabService.js';
import { __testing__ as routeTesting } from '../../routes/clinical/cathInventoryReconciliationRoutes.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const EXACT_PATH = '/api/v1/cath-lab/cases/9223372036854775807'
  + '/consumables/9007199254740993/inventory-reconcile';
const PHARMACY_OPERATOR_ROLES = [
  'PHARMACIST',
  'PHARMACY_STAFF',
  'PHARMACY_INCHARGE',
];
const COVERAGE_ROLES = ['ADMIN', 'SUPER_ADMIN'];

function source(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

function responseDouble() {
  return {
    json: jest.fn(),
    status: jest.fn().mockReturnThis(),
  };
}

describe('Cath inventory reconciliation route contract', () => {
  test('keeps the dedicated mount exact and does not widen the broad Cath audience', () => {
    expect(new Set(CATH_INVENTORY_RECONCILIATION_ROUTE_ROLES)).toEqual(new Set([
      ...PHARMACY_OPERATOR_ROLES,
      ...COVERAGE_ROLES,
    ]));
    for (const role of PHARMACY_OPERATOR_ROLES) {
      expect(CATH_LAB_ROUTE_ROLES).not.toContain(role);
    }

    const app = source('app.js');
    const exactMount = app.indexOf(
      "'/api/v1/cath-lab/cases/:caseId/consumables/:usageId/inventory-reconcile'",
    );
    const broadMount = app.indexOf("app.use('/api/v1/cath-lab'");

    expect(exactMount).toBeGreaterThan(-1);
    expect(broadMount).toBeGreaterThan(exactMount);
    expect(app.slice(exactMount, broadMount)).toContain(
      'requireRole(...CATH_INVENTORY_RECONCILIATION_ROUTE_ROLES)',
    );
  });

  test('installs read authority on GET and pharmacy-only mutation authority on POST', () => {
    const routes = source('routes/clinical/cathInventoryReconciliationRoutes.js');
    const getIndex = routes.indexOf('router.get(');
    const getAuthorityIndex = routes.indexOf('requireCathInventoryRead', getIndex);
    const postIndex = routes.indexOf('router.post(');
    const postAuthorityIndex = routes.indexOf('requireCathInventoryMutation', postIndex);

    expect(getIndex).toBeGreaterThan(-1);
    expect(getAuthorityIndex).toBeGreaterThan(getIndex);
    expect(getAuthorityIndex).toBeLessThan(postIndex);
    expect(postAuthorityIndex).toBeGreaterThan(postIndex);
  });

  test.each(PHARMACY_OPERATOR_ROLES)('%s can read and reconcile', (role) => {
    expect(canViewCathInventoryReconciliationRole(role)).toBe(true);
    expect(canMutateCathInventoryReconciliationRole(role)).toBe(true);
  });

  test.each(COVERAGE_ROLES)('%s is read-only coverage authority', (role) => {
    expect(canViewCathInventoryReconciliationRole(role)).toBe(true);
    expect(canMutateCathInventoryReconciliationRole(role)).toBe(false);
  });

  test.each([
    'CATH_LAB_STAFF',
    'CATH_LAB_INCHARGE',
    'DOCTOR',
    'NURSING_STAFF',
    'TECHNICIAN',
    'PATIENT',
    '',
    null,
  ])('%s has no reconciliation authority', (role) => {
    expect(canViewCathInventoryReconciliationRole(role)).toBe(false);
    expect(canMutateCathInventoryReconciliationRole(role)).toBe(false);
  });

  test('binds idempotency identity and path only to the two canonical path identifiers', () => {
    const req = {
      body: { ignored: 'the command does not accept a body' },
      params: {
        caseId: '9223372036854775807',
        usageId: '9007199254740993',
      },
    };

    expect(routeTesting.canonicalCommandIdentity(req)).toEqual({
      case_id: '9223372036854775807',
      usage_id: '9007199254740993',
    });
    expect(routeTesting.canonicalCommandPath(req)).toBe(EXACT_PATH);
    expect(routeTesting.canonicalCommandIdentity({
      ...req,
      body: { a: 1, b: 2 },
    })).toEqual(routeTesting.canonicalCommandIdentity(req));

    const routes = source('routes/clinical/cathInventoryReconciliationRoutes.js');
    expect(routes).not.toContain('req.params.id');
    expect(routes).toContain('req.params.caseId');
    expect(routes).toContain("scope: 'cath_consumable_inventory_reconciliation'");
    expect(routes).toContain('required: true');
    expect(routes).toContain('requestBodyForIdempotency: canonicalCommandIdentity');
    expect(routes).toContain('requestPathForIdempotency: canonicalCommandPath');
  });

  test('accepts no POST body and rejects every non-empty or non-object body before mutation', () => {
    for (const body of [undefined, {}]) {
      const next = jest.fn();
      const res = responseDouble();
      routeTesting.requireEmptyBody({ body }, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    }

    for (const body of [{ quantity: 1 }, [], 'body', null]) {
      const next = jest.fn();
      const res = responseDouble();
      routeTesting.requireEmptyBody({ body }, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        details: {
          code: 'CATH_INVENTORY_RECONCILIATION_BODY_NOT_ALLOWED',
        },
        success: false,
      }));
    }

    const routes = source('routes/clinical/cathInventoryReconciliationRoutes.js');
    const postureIndex = routes.indexOf('enforceStaffClinicalWriteDevicePosture');
    const emptyBodyIndex = routes.indexOf('requireEmptyBody', postureIndex);
    const idempotencyIndex = routes.indexOf('requireIdempotencyKey({', emptyBodyIndex);
    const mutationIndex = routes.indexOf('reconcileCathConsumableInventory(', idempotencyIndex);
    expect(postureIndex).toBeGreaterThan(-1);
    expect(emptyBodyIndex).toBeGreaterThan(postureIndex);
    expect(idempotencyIndex).toBeGreaterThan(emptyBodyIndex);
    expect(mutationIndex).toBeGreaterThan(idempotencyIndex);
  });

  test.each([
    ['0', '1'],
    ['01', '1'],
    ['9223372036854775808', '1'],
    ['1', '0'],
    ['1', '01'],
    ['1', '9223372036854775808'],
  ])('rejects non-canonical or out-of-range identifiers before database work: %s/%s', async (
    caseId,
    usageId,
  ) => {
    await expect(getCathConsumableInventoryReconciliation(caseId, usageId, {
      tenantId: TENANT_ID,
    })).rejects.toMatchObject({
      code: 'CATH_LAB_BAD_ID',
      statusCode: 400,
    });
    await expect(reconcileCathConsumableInventory(caseId, usageId, {
      tenantId: TENANT_ID,
    })).rejects.toMatchObject({
      code: 'CATH_LAB_BAD_ID',
      statusCode: 400,
    });
  });

  test('freezes the five-locale shortfall presentation, including Malayalam', () => {
    expect(Object.keys(CATH_INVENTORY_SHORTFALL_PRESENTATIONS)).toEqual([
      'en',
      'hi',
      'ta',
      'te',
      'ml',
    ]);
    expect(Object.fromEntries(
      Object.entries(CATH_INVENTORY_SHORTFALL_PRESENTATIONS).map(([locale, copy]) => [
        locale,
        createHash('sha256').update(JSON.stringify(copy)).digest('hex'),
      ]),
    )).toEqual({
      en: '963577541b98c9d2d8007c673390bec52e72fb85c89a8e5f0beb37c7bbdb4556',
      hi: 'f06afbadd746e3281b3bbf7075e46860d67e18e997bd873a623794e1dcec37b3',
      ta: '6012ee83ba1ffd98e185c650d5934db7cd5615d311543f885723bb036164bf5a',
      te: '57d172bef1bf4d4905236163ca6aaa98534c3f9131bfa66946bc1201179dd6b4',
      ml: '6ba03b0edf618469823d663ae61c3f0d0f0e7000a02d9c6c60fc33075929ff76',
    });
  });
});
