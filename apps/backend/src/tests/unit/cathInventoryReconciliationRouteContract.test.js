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
    expect(routes.slice(getIndex, postIndex)).toContain('guardCathCase');
  });

  test('requires patient/case authority and an exact active facility grant even for GET coverage', () => {
    const routes = source('routes/clinical/cathInventoryReconciliationRoutes.js');
    const service = source('services/clinical/cathLabService.js');
    const getService = service.slice(
      service.indexOf('export async function getCathConsumableInventoryReconciliation'),
      service.indexOf('function boundedCathAssignmentRecoveryLimit'),
    );
    expect(routes).toContain("const guardCathCase = cathCaseGuard('caseId')");
    expect(getService).toContain('await assertPharmacyFacilityGrant(tx');
    expect(getService).toContain('facilityId: Number(record.facility_id)');
    expect(getService).toContain('actorUid: actor.uid');
    expect(getService).toContain('forUpdate: false');
    expect(service).toContain('AND cath_case.facility_id = usage.facility_id');
    expect(service).toContain('AND inventory_batch.facility_id = usage.facility_id');
    expect(service).toContain(
      'AND inventory_batch.batch_number IS NOT DISTINCT FROM usage.batch_number',
    );
    expect(service).toContain('JOIN clinical_timeline_events timeline');
    expect(service).toContain('JOIN clinical_audit_events clinical_audit');
    expect(service).toContain("AND task.metadata->>'inventory_batch_id' = usage.inventory_batch_id::text");
    expect(service).toContain("AND sla.metadata->>'inventory_facility_id' = usage.facility_id::text");
    expect(service).toContain('JOIN notification_outbox outbox');
    expect(service).toContain("AND outbox.payload->>'facility_id' = usage.facility_id::text");
    expect(service).toContain("outbox.payload->>'recipient_facility_grant_id'");
  });

  test('binds reconciliation to a locked facility grant and the hardened inventory ledger', () => {
    const service = source('services/clinical/cathLabService.js');
    const reconciliation = service.slice(
      service.indexOf('export async function reconcileCathConsumableInventory'),
      service.indexOf('export async function recordConsumableUsage'),
    );
    const movement = service.slice(
      service.indexOf('async function recordCathReconciliationMovementTx'),
      service.indexOf('export async function getCathConsumableInventoryReconciliation'),
    );

    expect(reconciliation).toContain('await assertPharmacyFacilityGrant(tx');
    expect(reconciliation).toContain('forUpdate: true');
    expect(reconciliation).toContain('facility_id: record.facility_id');
    expect(reconciliation).toContain('Legacy Cath usage has no exact facility inventory batch');
    expect(movement).toContain('await recordMovementTx(tx');
    expect(movement).toContain('expected_facility_id: Number(usage.facility_id)');
    expect(movement).toContain('actor_facility_grant_id');
    expect(movement).not.toContain('UPDATE pharmacy_inventory_batches');
  });

  test('persists clinical history and the facility-bound pharmacy task atomically', () => {
    const service = source('services/clinical/cathLabService.js');
    const usage = service.slice(
      service.indexOf('export async function recordConsumableUsage'),
      service.indexOf('export async function getCathConsumablesBillingSettings'),
    );
    const canonicalIndex = usage.indexOf('const event = requireCanonicalEvent');
    const taskIndex = usage.indexOf('await materializeCathInventoryShortfallTx');

    expect(canonicalIndex).toBeGreaterThan(-1);
    expect(taskIndex).toBeGreaterThan(canonicalIndex);
    expect(usage).toContain('const canonicalActor = await cathCanonicalActorTx');
    expect(usage).toContain('facility_id: Number(cathCase.facility_id)');
    expect(usage).toContain("mapping_contract: 'cath_facility_catalog_inventory_v1'");
    expect(usage).toContain('canonical_actor_uid: canonicalActor.uid');
    expect(usage).not.toContain('applyConsumableInventoryDecrement');
  });

  test('derives a new Cath case facility from the locked encounter authority', () => {
    const service = source('services/clinical/cathLabService.js');
    const create = service.slice(
      service.indexOf('export async function createCase'),
      service.indexOf('export async function listCases'),
    );
    expect(create).toContain("encounter.metadata->>'facility_id'");
    expect(create).toContain('FOR KEY SHARE OF encounter');
    expect(create).toContain('facilityId = encounterFacilityId');
    expect(create).toContain('Cath-lab encounter facility authority is not active');
    expect(create).toContain(
      'facility_id is required when a Cath-lab case has no encounter',
    );
  });

  test('governs Cath catalog, case, and usage recovery with durable exact receipts', () => {
    const service = source('services/clinical/cathLabService.js');
    const usageRecovery = service.slice(
      service.indexOf('async function reattachCathUsageAuthorityTx'),
      service.indexOf('export async function resolveCathConsumableAuthorityRecovery'),
    );
    const recovery = service.slice(
      service.indexOf('export async function resolveCathConsumableAuthorityRecovery'),
      service.indexOf('export async function listCatalogBatches'),
    );
    expect(recovery).toContain("'cath_consumable_catalog', 'cath_consumable_usage', 'cath_lab_case'");
    expect(recovery).toContain('await assertPharmacyFacilityGrant(tx');
    expect(recovery).toContain('forUpdate: true');
    expect(recovery).toContain("app.pharmacy_recovery_command_key_sha256");
    expect(recovery).toContain('const targetBefore = await cathRecoveryTargetSnapshotTx');
    expect(recovery).toContain('const targetAfter = await cathRecoveryTargetSnapshotTx');
    expect(recovery).toContain('await setCathRecoveryEvidenceTx');
    expect(recovery).toContain("set_config('app.pharmacy_recovery_actor_uid'");
    expect(recovery).toContain("action === 'REATTACH'");
    expect(recovery).toContain("['PRESERVE', 'CANCEL']");
    expect(recovery).toContain(
      'Cath usage recovery must be governed by the exact pinned case facility',
    );
    expect(recovery).toContain("case_recovery.entity_type='cath_lab_case'");
    expect(recovery).toContain("case_recovery.reason_code='CATH_CASE_FACILITY_UNRESOLVED'");
    expect(recovery).toContain('terminalAgainstRecoveringCase');
    expect(usageRecovery).toContain(
      'Cath usage cannot be reattached until the case facility recovery is resolved',
    );
    expect(usageRecovery).toContain(
      'Existing Cath stock movement custody cannot be rebound by changing clinical usage authority',
    );
    expect(usageRecovery).toContain('timeline.id AS exact_timeline_event_id');
    expect(usageRecovery).toContain('clinical_audit.id AS exact_audit_event_id');
    expect(recovery).toContain('Cath authority recovery reason does not match its governed resolver');
    expect(recovery).toContain('encounter no longer matches its same-tenant patient');
    expect(recovery).toContain('Cath case recovery encounter has no exact facility authority');
    expect(recovery).toContain(
      'Cath case recovery facility must match the encounter facility authority',
    );
    expect(recovery).toContain('AND facility_id IS NOT DISTINCT FROM $5::int');
    expect(recovery).toContain("metadata=COALESCE(metadata, '{}'::jsonb) || $6::jsonb");
    expect(service).toContain('Cath-lab encounter has no exact facility authority');
    expect(recovery).toContain("SET status='cancelled'");
    expect(recovery).toContain("SET status='SUPPRESSED'");
    expect(recovery).toContain(
      'SET facility_id=NULL, inventory_item_id=NULL, inventory_batch_id=NULL',
    );
    expect(recovery).toContain("status='RESOLVED'");
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
