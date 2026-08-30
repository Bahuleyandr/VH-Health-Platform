import { readFileSync } from 'node:fs';
import {
  operations as pharmacyOpenApiOperations,
  schemas as pharmacyOpenApiSchemas,
} from '../../../scripts/openapi/schemas/pharmacy.mjs';
import {
  schemas as pharmacyCounterSaleOpenApiSchemas,
} from '../../../scripts/openapi/schemas/pharmacyCounterSale.mjs';

function source(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

function between(text, start, end) {
  return text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
}

describe('pharmacy dispense inventory authority contract', () => {
  const controller = source('controllers/pharmacy/pharmacyOrderController.js');
  const prescriptionController = source('controllers/prescription/ePrescriptionController.js');
  const inventoryComposer = source('services/pharmacy/pharmacyOrderInventoryService.js');
  const inventoryV2 = source('services/pharmacy/inventoryV2Service.js');
  const controlledWitness = source('services/pharmacy/controlledDispenseWitnessService.js');
  const wardWorkflow = source('services/ipd/wardIndentWorkflowService.js');
  const wardClosure = source('services/ipd/wardIndentMedicationClosureService.js');
  const wardRoutes = source('routes/pharmacy/wardIndentRoutes.js');
  const capService = source('services/pharmacy/pharmacyCapService.js');
  const verificationService = source('services/pharmacy/pharmacistVerificationService.js');
  const supply = source('services/pharmacySupply/pharmacySupplyService.js');
  const supplyRoutes = source('routes/admin/pharmacySupplyRoutes.js');
  const orderRoutes = source('routes/pharmacy/orderRoutes.js');
  const pharmacyRoutes = source('routes/pharmacy/index.js');
  const substitutionWitnessRoutes = source('routes/pharmacy/dispenseSubstitutionWitnessRoutes.js');
  const orderValidators = source('validators/pharmacy/orderValidators.js');
  const inventoryAuthorityMigration = source('migrations/753_pharmacy_order_inventory_authority.sql');
  const generatedOpenApi = JSON.parse(source('docs/openapi.json'));

  test('legacy delivery and counter dispense delegate stock to Inventory V2 only', () => {
    const delivery = between(controller, 'export const markDelivered', 'const COUNTER_PAYMENT_MODES');
    const counter = between(controller, 'export const markCounterDispensed', 'export const markUnavailable');

    expect(delivery).toMatch(/allocateOrderInventoryTx\(tx/);
    expect(counter).toMatch(/allocateOrderInventoryTx\(tx/);
    expect(delivery).not.toMatch(/UPDATE\s+pharmacy_catalog/i);
    expect(counter).not.toMatch(/UPDATE\s+pharmacy_catalog/i);
    expect(inventoryComposer).not.toMatch(/UPDATE\s+pharmacy_catalog/i);
    expect(inventoryComposer).toMatch(/FOR UPDATE/);
    expect(inventoryComposer).toMatch(/await recordMovementTx\(tx/);
    expect(inventoryComposer).toMatch(/await dispenseControlledTx\(tx/);
    expect(inventoryComposer).toMatch(/PHARMACY_ORDER_ITEM_UNRESOLVED/);
    expect(inventoryComposer).toMatch(/operation === 'delivery'[\s\S]*orderedQuantity/);
    expect(inventoryComposer).toMatch(/inventory_dispensed_quantity = intendedQuantity/);
    expect(inventoryComposer).toMatch(/prescription: prescriptionProjection/);
    expect(inventoryComposer).toMatch(/PHARMACY_ORDER_CONTROLLED_ALLOCATION_REQUIRED/);
    expect(inventoryComposer).toMatch(/recovery_action/);
    expect(delivery).toMatch(/req\.body\?\.dispensed_items/);
    expect(delivery).toMatch(/applyAuthoritativeDeliveryAllocations/);
    expect(delivery).not.toMatch(/mergeDispensedItems/);
    expect(delivery).toMatch(/applyOrderPrescriptionProjectionTx/);
    expect(delivery).not.toMatch(/pharmacy_order_id IS NULL/);
    expect(counter).not.toMatch(/pharmacy_order_id IS NULL/);
  });

  test('order-controlled witness is server-derived and consumed only by the order composer', () => {
    const quantityGuard = between(
      inventoryComposer,
      'function positiveQuantity',
      'function numericId',
    );
    const resolver = between(
      inventoryComposer,
      'async function resolveOrderControlledWitnessContextTx',
      'export async function requestOrderControlledWitnessApproval',
    );
    const allocator = between(
      inventoryComposer,
      'export async function allocateOrderInventoryTx',
      'export async function applyOrderPrescriptionProjectionTx',
    );
    const counterAuthority = between(
      inventoryComposer,
      'export async function resolveCounterDispenseAuthorityTx',
      'function prescriptionCatalogCandidates',
    );
    const approvalRoute = between(
      orderRoutes,
      "scope: 'pharmacy_order_inventory_witness_approval'",
      '// ── New lifecycle routes',
    );
    expect(controlledWitness).toMatch(
      /pharmacyOrder:\s*'pharmacy_order_inventory_dispense'/,
    );
    expect(orderRoutes).toMatch(
      /\/:id\/controlled-dispense\/witness-approvals'/,
    );
    expect(orderRoutes).toMatch(
      /\/:id\/controlled-dispense\/witness-approvals\/:approvalId\/approve'/,
    );
    expect(orderRoutes).toMatch(/authenticateOrderControlledWitness/);
    expect(approvalRoute.indexOf('await preflightOrderControlledWitnessApproval'))
      .toBeLessThan(approvalRoute.indexOf('await authenticateOrderControlledWitness'));
    expect(orderRoutes).toMatch(/delete req\.body\.password/);
    expect(inventoryComposer).toMatch(/ORDER_CONTROLLED_WITNESS_SELECTOR_KEYS/);
    expect(quantityGuard).toMatch(/\^\(0\|\[1-9\]\[0-9\]\{0,9\}\)/);
    expect(quantityGuard).toMatch(/BigInt\(match\[1\]\) \* 10_000n/);
    expect(quantityGuard).toMatch(/scaledQuantity > 99_999_999_999_999n/);
    expect(quantityGuard).toMatch(/return Number\(scaledQuantity\) \/ 10_000/);
    expect(counterAuthority).toMatch(/nonNegativeMedicationQuantity\(/);
    expect(allocator).toMatch(/nonNegativeMedicationQuantity\(/);
    expect(inventoryComposer).toMatch(/PHARMACY_ORDER_WITNESS_CALLER_AUTHORITY_FORBIDDEN/);
    expect(resolver).toMatch(/patient\.is_active=TRUE/);
    expect(resolver).toMatch(/facility\.status='active'/);
    expect(resolver).toMatch(/assertPharmacyFacilityGrant\(tx/);
    expect(resolver.indexOf('requesterGrant = await assertPharmacyFacilityGrant'))
      .toBeLessThan(resolver.indexOf('const orderRows = await tx.$queryRawUnsafe'));
    expect(resolver).toMatch(/assertVerificationClearedTx\(tx/);
    expect(inventoryComposer).toMatch(/prescription\.lifecycle_status/);
    expect(inventoryComposer).toMatch(/prescriber\.id=prescription\.doctor_id/);
    expect(inventoryComposer).toMatch(/prescription\.signed_by=prescription\.doctor_uid/);
    expect(inventoryComposer).toMatch(/prescription\.locked_by=prescription\.doctor_uid/);
    expect(inventoryComposer).toMatch(/requester_facility_grant_id/);
    expect(inventoryComposer).toMatch(/prescriber_uid/);
    expect(inventoryComposer).toMatch(/prescription_signed_at/);
    expect(inventoryComposer).toMatch(/prescription_locked_at/);
    expect(resolver).toMatch(/orderQuantityEvidence\(orderLine\)/);
    expect(resolver).toMatch(/item\.status='active'/);
    expect(resolver).toMatch(/batch\.status AS batch_status/);
    expect(resolver).toMatch(/inventoryRow\.schedule_class !== 'X'/);
    expect(inventoryComposer).toMatch(/resolvePayload: async \(\{ tx \}\)/);
    expect(inventoryComposer).toMatch(/order_remaining_quantity/);
    expect(allocator).toMatch(/consumeControlledDispenseWitnessApproval\(/);
    expect(allocator).toMatch(/assertPharmacyFacilityGrant\(tx,[\s\S]*forUpdate: true/);
    expect(allocator).toMatch(/loadOrderControlledWitnessPrescriptionTx\(tx,[\s\S]*lockAuthority: true/);
    expect(allocator).toMatch(/scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES\.pharmacyOrder/);
    expect(allocator).toMatch(
      /!needsWitness && allocations\?\.some\([\s\S]*CONTROLLED_DISPENSE_WITNESS_NOT_REQUIRED/,
    );
    expect(allocator).toMatch(/witness_evidence: witnessEvidence/);
    expect(allocator).not.toMatch(/witness_approval_id: allocation\.witness_approval_id/);
    expect(allocator).toMatch(/witness_approval_id: String\(allocation\.witness_approval_id\)/);
    expect(allocator).toMatch(
      /witness_approval_scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES\.pharmacyOrder/,
    );
    expect(allocator).toMatch(/witness_approval_contract: ORDER_CONTROLLED_WITNESS_CONTRACT/);
    expect(allocator).toMatch(/metadata\.witness_facility_grant_id/);
    expect(allocator).toMatch(/witness_facility_grant_id: controlled && needsWitness/);
    expect(controlledWitness).toMatch(/witness_facility_grant_id/);
    expect(inventoryV2).toMatch(/witness_facility_grant_id: witness\?\.facility_grant_id/);
    expect(allocator).toMatch(/witness_approval_id: controlled && needsWitness/);
    expect(inventoryComposer).toMatch(
      /\/api\/v1\/pharmacy-orders\/orders\/\$\{Number\(order\.id\)\}\/controlled-dispense\/witness-approvals/,
    );
    expect(pharmacyOpenApiSchemas.PharmacyOrderControlledWitnessSelection)
      .toMatchObject({
        additionalProperties: false,
        required: [
          'order_line_index', 'inventory_item_id', 'inventory_batch_id', 'quantity',
        ],
      });
    expect(pharmacyOpenApiSchemas.PharmacyOrderControlledWitnessSelection.properties.quantity)
      .toMatchObject({ maximum: 9999999999.9999, multipleOf: 0.0001 });
    expect(pharmacyOpenApiSchemas.PharmacyOrderInventoryAllocation.properties.quantity)
      .toMatchObject({ maximum: 9999999999.9999, multipleOf: 0.0001 });
    for (const alias of ['dispensed_quantity', 'dispensed_qty', 'qty', 'quantity']) {
      expect(pharmacyOpenApiSchemas.PharmacyCounterDispenseLine.properties[alias])
        .toMatchObject({ maximum: 9999999999.9999, multipleOf: 0.0001 });
    }
    for (const prefix of ['/api/v1/pharmacy-orders', '/api/v1/pharmacy']) {
      expect(pharmacyOpenApiOperations[
        `POST ${prefix}/orders/{id}/controlled-dispense/witness-approvals`
      ].request).toBe('PharmacyOrderControlledWitnessSelection');
      expect(pharmacyOpenApiOperations[
        `POST ${prefix}/orders/{id}/controlled-dispense/witness-approvals/{approvalId}/approve`
      ].request).toBe('PharmacyOrderControlledWitnessDecisionRequest');
    }
  });

  test('counter rejects caller line and price authority before movement or billing', () => {
    const merge = between(controller, 'function mergeDispensedItems', 'export const markCounterDispensed');
    const counter = between(controller, 'export const markCounterDispensed', 'export const markUnavailable');

    expect(merge).toMatch(/PHARMACY_ORDER_PRICE_MUTATION_FORBIDDEN/);
    expect(merge).toMatch(/PHARMACY_ORDER_DISPENSE_LINE_UNRESOLVED/);
    expect(merge).toMatch(/PHARMACY_ORDER_DISPENSE_LINE_AMBIGUOUS/);
    expect(merge).toMatch(/order_line_index is required/);
    expect(merge).toMatch(/PHARMACY_ORDER_DISPENSE_LINE_DUPLICATE/);
    expect(merge).not.toMatch(/merged\.price\s*=\s*d\.price/);
    expect(counter).toMatch(/await resolveCounterDispenseAuthorityTx\(tx/);
    expect(counter.indexOf('resolveCounterDispenseAuthorityTx'))
      .toBeLessThan(counter.indexOf('allocateOrderInventoryTx'));
    expect(inventoryComposer).toMatch(/PHARMACY_ORDER_CATALOG_PRICE_REQUIRED/);
    expect(inventoryComposer).toMatch(/inventory_billable_total/);
    expect(inventoryComposer).toMatch(/resolvePrescriptionLineIndexes/);
    expect(inventoryComposer).not.toMatch(/Array position is\s+the only stable identity/);
    expect(inventoryComposer).toMatch(/PHARMACY_ORDER_PRESCRIPTION_LINE_AMBIGUOUS/);
    expect(prescriptionController).toMatch(/order_line_index:\s*medIndex/);
    expect(prescriptionController).toMatch(/prescription_line_index:\s*medIndex/);
    expect(controller).toMatch(/preserveBoundOrderLineIdentity/);
    expect(inventoryComposer.indexOf('resolvePrescriptionLineIndexes(lines'))
      .toBeLessThan(inventoryComposer.indexOf('await recordMovementTx(tx'));
  });

  test('TPA cap is enforced from locked authoritative pricing before stock mutation', () => {
    const delivery = between(controller, 'export const markDelivered', 'const COUNTER_PAYMENT_MODES');
    const counter = between(controller, 'export const markCounterDispensed', 'export const markUnavailable');
    const substitution = inventoryComposer.slice(
      inventoryComposer.indexOf('export async function dispenseSubstitutionCommand'),
    );

    for (const handler of [delivery, counter]) {
      expect(handler).not.toMatch(/probePharmacyCap/);
      expect(handler.indexOf('resolveCounterDispenseAuthorityTx'))
        .toBeLessThan(handler.indexOf('assertPharmacyCapForDispenseTx'));
      expect(handler.indexOf('assertPharmacyCapForDispenseTx'))
        .toBeLessThan(handler.indexOf('allocateOrderInventoryTx'));
    }
    expect(substitution.indexOf('cumulativeBillableTotal'))
      .toBeLessThan(substitution.indexOf('assertPharmacyCapForDispenseTx'));
    expect(substitution.indexOf('assertPharmacyCapForDispenseTx'))
      .toBeLessThan(substitution.indexOf('recordMovementTx'));
    expect(capService).toMatch(/users[\s\S]*tenant_id = \$1::uuid/);
    expect(capService).toMatch(/admissions[\s\S]*tenant_id = \$2::uuid/);
    expect(capService).toMatch(/cap\.tenant_id = \$2::uuid/);
    expect(capService).toMatch(/r\.tenant_id = \$2::uuid/);
    expect(capService).toMatch(/it\.tenant_id = \$2::uuid/);
    expect(controller).toMatch(/TPA_PHARMACY_CAP_OVERRIDE_FORBIDDEN/);
    expect(controller).toMatch(/TPA_PHARMACY_CAP_OVERRIDE_REASON_REQUIRED/);
    expect(controller).toMatch(/TPA pharmacy-cap override by/);
    expect(controller).toMatch(/authorised_by/);
    expect(controller).toMatch(/authorised_role/);
    expect(capService).toMatch(/JOIN billing_invoice_items invoice_item/);
    expect(capService).toMatch(/invoice_item\.source_ref_type = 'pharmacy_order'/);
    expect(capService).toMatch(/tpa_claim_line_decisions/);
    expect(capService).toMatch(/COUNTER_FUNDING_ALLOCATION_REQUIRED/);
    expect(capService).toMatch(/pharmacy_cap_reservations/);
    expect(substitution).toMatch(/resolveAuthoritativeCounterFundingTx\(tx/);
    expect(substitution).toMatch(/requireSubstitutionFundingReauthorisation/);
    expect(inventoryComposer).toMatch(/SUBSTITUTION_FUNDING_REAUTHORISATION_REQUIRED/);
    expect(substitution.indexOf('resolveAuthoritativeCounterFundingTx'))
      .toBeLessThan(substitution.indexOf('assertPharmacyCapForDispenseTx'));
    expect(counter).toMatch(/orderVersion: Number\(order\.inventory_authority_version\)/);
    expect(counter).toMatch(/orderItemsSha256: currentItemsSha256/);
    expect(controller).toMatch(/compensateTerminalPharmacyFundingAuthorityTx/);
    expect(controller).toMatch(/PHARMACY_TERMINAL_PARTIAL_DISPENSE_COMPENSATION_REQUIRED/);
  });

  test('committed delivery and substitution never become retained barcode 5xx responses', () => {
    const delivery = between(controller, 'export const markDelivered', 'const COUNTER_PAYMENT_MODES');
    const substitution = between(
      controller,
      'export const dispenseSubstitution',
      'export const getOrderDispensableContext',
    );
    const barcode = between(
      controller,
      'async function attachPackBarcodeBestEffort',
      'async function attachSignedUrl',
    );

    expect(delivery).toMatch(/await attachPackBarcodeBestEffort\(result, orderId\)/);
    expect(substitution).toMatch(/await attachPackBarcodeBestEffort/);
    expect(delivery).not.toMatch(/await ensurePackBarcode/);
    expect(substitution).not.toMatch(/await ensurePackBarcode/);
    expect(barcode).toMatch(/pack_barcode_pending = true/);
    expect(barcode).toMatch(/pack-label/);
    expect(barcode).not.toMatch(/throw packErr/);
  });

  test('multi-item dispense locks catalog, item, and batch rows in global order', () => {
    expect(inventoryComposer).toMatch(/FROM pharmacy_catalog[\s\S]*ORDER BY id[\s\S]*FOR UPDATE/);
    expect(inventoryComposer).toMatch(/FROM pharmacy_inventory_items[\s\S]*ORDER BY id[\s\S]*FOR UPDATE/);
    expect(inventoryComposer).toMatch(/FROM pharmacy_inventory_batches[\s\S]*ORDER BY id[\s\S]*FOR UPDATE/);
    expect(inventoryComposer).toMatch(/lineContexts\][\s\S]*\.sort|\[\.\.\.lineContexts\]\.sort/);
  });

  test('linked prescriptions are locked and status-version projected with CAS', () => {
    expect(inventoryComposer).toMatch(
      /FROM e_prescriptions[\s\S]*ORDER BY id ASC[\s\S]*FOR UPDATE/,
    );
    expect(inventoryComposer).toMatch(/expected_status: prescriptionStatus/);
    expect(inventoryComposer).toMatch(/expected_revision: Number\(prescription\.revision/);
    expect(inventoryComposer).toMatch(/COALESCE\(revision, 1\) = \$6::int/);
    expect(inventoryComposer).toMatch(/PHARMACY_ORDER_PRESCRIPTION_STATE_CHANGED/);
    expect(inventoryComposer).toMatch(/SUBSTITUTION_PRESCRIPTION_STATE_CHANGED/);
  });

  test('every legacy dispense alias has one canonical required idempotency identity', () => {
    const orderIdempotency = between(
      orderRoutes,
      'const orderDispenseIdempotency',
      'const counterDispenseIdempotency',
    );
    const bodyIdempotency = between(
      pharmacyRoutes,
      'const bodyOrderDispenseIdempotency',
      'const substitutionDispenseIdempotency',
    );
    const substitutionIdempotency = between(
      pharmacyRoutes,
      'const substitutionDispenseIdempotency',
      'function dispenseByBodyOrderId',
    );

    expect(orderIdempotency).toMatch(/required:\s*true/);
    expect(bodyIdempotency).toMatch(/required:\s*true/);
    expect(substitutionIdempotency).toMatch(/required:\s*true/);
    expect(orderRoutes).toContain("orderDispenseIdempotency('delivered')");
    expect(orderRoutes).toContain("orderDispenseIdempotency('resolve-line-identities')");
    expect(orderRoutes).toMatch(
      /'\/:id\/resolve-line-identities'.*orderDispenseIdempotency\('resolve-line-identities'\)/,
    );
    expect(orderRoutes).toContain("const counterDispenseIdempotency = orderDispenseIdempotency('dispense')");
    expect(orderRoutes).toMatch(/'\/:id\/dispense-counter'.*counterDispenseIdempotency/);
    expect(orderRoutes).toMatch(/'\/:id\/dispense'.*counterDispenseIdempotency/);
    expect(pharmacyRoutes).toMatch(/'\/dispense'.*bodyOrderDispenseIdempotency/);
    expect(pharmacyRoutes).toContain("requestPathForIdempotency: '/api/v1/pharmacy-orders/dispense-substitution'");
    expect(pharmacyRoutes).toMatch(/'\/dispense-substitution'[\s\S]*substitutionDispenseIdempotency/);
    expect(orderIdempotency).toMatch(/requestBodyForIdempotency:\s*canonicalOrderDispenseBody/);
    expect(bodyIdempotency).toMatch(/requestBodyForIdempotency:\s*canonicalOrderDispenseBody/);
    expect(orderRoutes).toMatch(/delete body\.order_id/);
    expect(pharmacyRoutes).toMatch(/delete body\.order_id/);
  });

  test('publishes the required idempotency header for every legacy dispense alias', () => {
    const paths = [];
    for (const prefix of ['/api/v1/pharmacy-orders', '/api/v1/pharmacy']) {
      paths.push(
        `${prefix}/dispense`,
        `${prefix}/dispense-substitution`,
        `${prefix}/orders/{id}/delivered`,
        `${prefix}/orders/{id}/dispense-counter`,
        `${prefix}/orders/{id}/dispense`,
      );
    }

    for (const path of paths) {
      const sourceOperation = pharmacyOpenApiOperations[`POST ${path}`];
      expect(sourceOperation.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
      ]));
      expect(generatedOpenApi.paths[path].post.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
      ]));
    }
  });

  test('publishes complete request bodies for every inventory-affecting mutation', () => {
    const expected = new Map();
    for (const prefix of ['/api/v1/pharmacy-orders', '/api/v1/pharmacy']) {
      expected.set(`${prefix}/dispense`, 'PharmacyBodyCounterDispenseRequest');
      expected.set(`${prefix}/orders/{id}/delivered`, 'PharmacyOrderDeliveryRequest');
      expected.set(`${prefix}/orders/{id}/dispense-counter`, 'PharmacyCounterDispenseRequest');
      expected.set(`${prefix}/orders/{id}/dispense`, 'PharmacyCounterDispenseRequest');
    }
    for (const prefix of ['/api/v1/admin/pharmacy-supply', '/api/v1/pharmacy-supply']) {
      expected.set(`${prefix}/stock-movements`, 'PharmacySupplyStockMovementRequest');
    }
    for (const [path, schema] of expected) {
      const operation = pharmacyOpenApiOperations[`POST ${path}`];
      expect(operation.request).toBe(schema);
      expect(generatedOpenApi.paths[path].post.requestBody.content['application/json'].schema)
        .toEqual({ $ref: `#/components/schemas/${schema}` });
    }
  });

  test('publishes exact delivery and counter success plus typed recovery envelopes', () => {
    for (const prefix of ['/api/v1/pharmacy-orders', '/api/v1/pharmacy']) {
      const delivery = pharmacyOpenApiOperations[`POST ${prefix}/orders/{id}/delivered`];
      expect(delivery.response).toBe('PharmacyOrderDeliveryResponse');
      expect(delivery.additionalResponses[409].content['application/json'].schema)
        .toEqual({ $ref: '#/components/schemas/PharmacyOrderDispenseErrorResponse' });
      for (const suffix of ['/dispense', '/orders/{id}/dispense-counter', '/orders/{id}/dispense']) {
        const operation = pharmacyOpenApiOperations[`POST ${prefix}${suffix}`];
        expect(operation.response).toBe('PharmacyCounterDispenseResponse');
        expect(operation.additionalResponses[422].content['application/json'].schema)
          .toEqual({ $ref: '#/components/schemas/PharmacyOrderDispenseErrorResponse' });
      }
    }
    expect(pharmacyOpenApiSchemas.PharmacyOrderDeliveryResult.additionalProperties).toBe(false);
    expect(pharmacyOpenApiSchemas.PharmacyCounterDispenseResult.additionalProperties).toBe(false);
    expect(pharmacyOpenApiSchemas.PharmacyOrderDispenseErrorResponse.properties.details)
      .toEqual({ $ref: '#/components/schemas/PharmacyOrderDispenseRecoveryDetails' });
  });

  test('publishes the required idempotency header for both stock-movement aliases', () => {
    for (const prefix of ['/api/v1/admin/pharmacy-supply', '/api/v1/pharmacy-supply']) {
      const path = `${prefix}/stock-movements`;
      const sourceOperation = pharmacyOpenApiOperations[`POST ${path}`];
      expect(sourceOperation.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
      ]));
      expect(generatedOpenApi.paths[path].post.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
      ]));
    }
  });

  test('admin movements reuse the locked batch primitive and validate direction', () => {
    const appendMovement = between(supply, 'export async function appendStockMovement', 'export async function listStockMovements');

    expect(appendMovement).toMatch(/PHARMACY_STOCK_MOVEMENT_DIRECTION_INVALID/);
    expect(appendMovement).toMatch(/INVENTORY_BATCH_REQUIRED/);
    expect(appendMovement).toMatch(/await recordMovementTx\(tx/);
    expect(appendMovement).toMatch(/loadSupplyMovementItem\(tx, tid, itemId, \{ forUpdate: true \}\)/);
    expect(appendMovement).not.toMatch(/INSERT INTO pharmacy_stock_movements/);
    expect(appendMovement).not.toMatch(/UPDATE pharmacy_inventory_batches/);
    expect(supplyRoutes).toMatch(/router\.post\('\/stock-movements', requireIdempotencyKey\(\{/);
    expect(supplyRoutes).toMatch(/scope:\s*'pharmacy_supply_stock_movement'/);
    expect(supplyRoutes).toMatch(/retainOnServerError:\s*true/);
    expect(supplyRoutes).toMatch(/STOCK_MOVEMENT_CANONICAL_PATH/);
  });

  test('substitution durable identity is checked before mutable clinical preflight', () => {
    const handler = between(controller, 'export const dispenseSubstitution', 'export const getOrderDispensableContext');

    expect(handler.indexOf('findDispenseSubstitutionReplay'))
      .toBeLessThan(handler.indexOf('resolveSubstitutionPhase0'));
    expect(inventoryComposer).toMatch(/SUBSTITUTION_COMMAND_MISMATCH/);
    expect(inventoryComposer).toMatch(/pg_advisory_xact_lock/);
    expect(inventoryComposer).toMatch(/remaining_quantity/);
    expect(inventoryComposer).toMatch(/billable_subtotal/);
    expect(inventoryComposer).toMatch(/batch_evidence/);
    expect(inventoryComposer).toMatch(/FOR UPDATE OF po, ep/);
    expect(inventoryComposer).toMatch(/FOR UPDATE OF pc/);
    expect(inventoryComposer).toMatch(/SUBSTITUTION_AUTHORITY_CHANGED/);
    expect(inventoryComposer).toMatch(/SUBSTITUTION_PRESCRIPTION_STATUS_INVALID/);
    expect(inventoryComposer).toMatch(/PHARMACY_VERIFICATION_REQUIRED/);
    expect(inventoryComposer).toMatch(/resolveAuthenticatedPerformerNameTx/);
    expect(inventoryComposer).not.toMatch(/actorName/);
    expect(inventoryComposer).toMatch(/catalog_id: finalId/);
    expect(inventoryComposer).toMatch(/line_total: cumulativeBillableTotal/);
    expect(inventoryComposer).toMatch(/priorInventoryBillableTotal/);
    expect(inventoryComposer).toMatch(/prescription_revision/);
    expect(inventoryComposer).toMatch(
      /return \{\s*movement_id:[\s\S]*?order_line_index: orderLineIndex,\s*prescription_line_index: prescriptionLineIndex,/,
    );
    expect(handler).toMatch(/verificationGateBlocked/);
  });

  test('patient safety source writes bump the verification fence before they commit', () => {
    expect(inventoryAuthorityMigration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.bump_pharmacy_patient_safety_version_753\(\)/,
    );
    expect(inventoryAuthorityMigration).toMatch(
      /FOREACH source_table IN ARRAY ARRAY\[[\s\S]*'users'[\s\S]*'patient_allergies'[\s\S]*'e_prescriptions'[\s\S]*'clinical_orders'[\s\S]*'lab_results'[\s\S]*'patient_problems'/,
    );
    expect(inventoryAuthorityMigration).toMatch(
      /CREATE TRIGGER trg_pharmacy_patient_safety_version_753 '[\s\S]*BEFORE INSERT OR UPDATE OR DELETE ON public\.%I/,
    );
  });

  test('substitution and witness OpenAPI require origin linkage and reject caller performer identity', () => {
    for (const schemaName of [
      'PharmacyDispenseSubstitutionRequest',
      'PharmacySubstitutionWitnessApprovalRequest',
    ]) {
      const schema = generatedOpenApi.components.schemas[schemaName];
      expect(schema.required).toEqual(expect.arrayContaining(['order_id', 'prescription_id']));
      expect(schema.properties).not.toHaveProperty('performed_by_name');
    }
    expect(orderValidators).toMatch(
      /body\('encounter_id'\)[\s\S]*isInt\(\{ min: 1 \}\)/,
    );
  });

  test('dispense OpenAPI matches runtime quantities, encounter ids, and result evidence', () => {
    for (const schemaName of [
      'PharmacyDispenseSubstitutionRequest',
      'PharmacySubstitutionWitnessApprovalRequest',
    ]) {
      expect(pharmacyOpenApiSchemas[schemaName].properties.encounter_id)
        .toMatchObject({ type: 'integer', minimum: 1 });
      expect(generatedOpenApi.components.schemas[schemaName].properties.encounter_id)
        .toMatchObject({ type: 'integer', minimum: 1 });
    }
    for (const field of [
      'dispensed_quantity',
      'dispensed_qty',
      'qty',
      'quantity',
      'dispensed_quantity_ml',
    ]) {
      expect(pharmacyOpenApiSchemas.PharmacyCounterDispenseLine.properties[field])
        .toMatchObject({ minimum: 0, exclusiveMinimum: true });
    }
    const requiredResult = [
      'order_id',
      'prescription_id',
      'remaining_quantity',
      'fulfilment_status',
      'billable_subtotal',
      'batch_evidence',
      'pack_barcode',
    ];
    expect(pharmacyOpenApiSchemas.PharmacyDispenseSubstitutionResult.required)
      .toEqual(expect.arrayContaining(requiredResult));
    expect(generatedOpenApi.components.schemas.PharmacyDispenseSubstitutionResult.required)
      .toEqual(expect.arrayContaining(requiredResult));
  });

  test('witness aliases share canonical durable request and approval identities', () => {
    expect(substitutionWitnessRoutes).toMatch(/SUBSTITUTION_WITNESS_CANONICAL_PATH/);
    expect(substitutionWitnessRoutes).toMatch(
      /requestPathForIdempotency: SUBSTITUTION_WITNESS_CANONICAL_PATH/,
    );
    expect(substitutionWitnessRoutes).toMatch(
      /requestPathForIdempotency: \(req\) =>[\s\S]*\/\$\{req\.params\.id\}\/approve/,
    );
  });

  test('controlled performer identity requires an active user and active roster row', () => {
    expect(inventoryComposer).toMatch(/FROM users u\s+JOIN staff s/);
    expect(inventoryComposer).not.toMatch(/LEFT JOIN staff s/);
    expect(inventoryComposer).toMatch(/u\.is_active = true/);
    expect(inventoryComposer).toMatch(/u\.status = 'active'/);
    expect(inventoryComposer).toMatch(/s\.is_active = true/);
    expect(inventoryComposer).toMatch(/s\.archived_at IS NULL/);
    expect(inventoryComposer).not.toMatch(/BTRIM\(u\.name\)/);
  });

  test('verification and pack-label authority is tenant-bound and in-transaction locked', () => {
    expect(verificationService).toMatch(/po\.tenant_id = \$2::uuid/);
    expect(verificationService).toMatch(/tenant_id = \$3::uuid/);
    expect(verificationService).toMatch(/assertVerificationClearedTx/);
    expect(verificationService).toMatch(/forUpdate: true/);
    expect(controller).toMatch(/await assertVerificationClearedTx\(tx/);
  });

  test('default in-stock batch feed excludes expired FEFO rows', () => {
    expect(inventoryV2).toMatch(
      /status === 'in_stock'[\s\S]*expiry_date >= \(NOW\(\) AT TIME ZONE 'Asia\/Kolkata'\)::date/,
    );
  });

  test('ward controlled issue and return use typed exact-allocation composers', () => {
    const movementRecorder = between(
      inventoryV2,
      'export async function recordMovementTx',
      'export async function requestControlledDispenseWitnessApproval',
    );
    const controlledIssue = between(
      inventoryV2,
      'export async function dispenseWardControlledAllocationTx',
      'export async function returnWardControlledAllocationTx',
    );
    const controlledReturn = between(
      inventoryV2,
      'export async function returnWardControlledAllocationTx',
      'export async function dispenseControlled',
    );

    expect(wardRoutes).toMatch(/controlled-handoff\/witness-approvals/);
    expect(wardRoutes).toMatch(/controlled-handoff\/witness-approvals\/:approvalId\/approve/);
    expect(wardWorkflow).toMatch(/dispenseWardControlledAllocationTx\(tx/);
    expect(wardWorkflow).toMatch(/WARD_CONTROLLED_HANDOFF_AUTHORITY/);
    expect(wardWorkflow).not.toMatch(/validateControlledEvidence/);
    expect(wardClosure).toMatch(/returnWardControlledAllocationTx\(tx/);
    expect(wardClosure).toMatch(/sourceRegisterId/);
    expect(controlledIssue).toMatch(
      /reference_type: 'controlled_dispense',\s*reference_id: String\(referenceId\)/,
    );
    expect(controlledIssue).toMatch(/allocation_id: String\(allocationId\)/);
    expect(controlledReturn).toMatch(
      /reference_type: 'ward_indent_return',\s*reference_id: `ward-indent-return:\$\{indentId\}:item:\$\{wardItemId\}`/,
    );
    expect(controlledReturn).toMatch(/allocation_id: String\(allocationId\)/);
    expect(movementRecorder).toMatch(
      /facility_authority !== WARD_INVENTORY_RETURN_AUTHORITY[\s\S]*else if \(\s*movement_kind !== 'return'\s*\|\| !\['ward_indent_return_allocation', 'ward_indent_return'\]\.includes\(reference_type\)\s*\)/,
    );
    expect(inventoryV2).toMatch(/clinical_order\.status IN \('ordered', 'verified', 'in_progress'\)/);
    expect(inventoryV2).toMatch(/signedCatalogId !== Number\(catalogId\)/);
  });

  test('ward substitution decision is separate from granted inventory application', () => {
    const clinicianDecision = between(
      wardWorkflow,
      'export async function approveWardIndentSubstitution',
      'export async function applyApprovedWardIndentSubstitution',
    );
    const inventoryApplication = between(
      wardWorkflow,
      'export async function applyApprovedWardIndentSubstitution',
      'export async function rejectWardIndentSubstitution',
    );
    expect(clinicianDecision).not.toMatch(/reserveWardIndentInventoryTx/);
    expect(clinicianDecision).not.toMatch(/pharmacy_catalog_id: catalogId/);
    expect(inventoryApplication).toMatch(/facilityGrantRequired: true/);
    expect(inventoryApplication).toMatch(/reserveWardIndentInventoryTx\(tx/);
    expect(wardRoutes).toMatch(/\/:id\/substitutions\/apply[\s\S]*requireRole\(\.\.\.SUPPLY_ROLES\)/);
  });

  test('handwritten OpenAPI exposes only the governed ward controlled flow', () => {
    for (const prefix of ['/api/v1/pharmacy-orders', '/api/v1/pharmacy']) {
      expect(pharmacyOpenApiOperations[
        `POST ${prefix}/ward-indents/{id}/controlled-handoff`
      ].request).toBe('PharmacyWardControlledHandoffRequest');
      expect(pharmacyOpenApiOperations[
        `POST ${prefix}/ward-indents/{id}/controlled-handoff/witness-approvals`
      ].request).toBe('PharmacyWardControlledWitnessRequest');
      expect(pharmacyOpenApiOperations[
        `POST ${prefix}/ward-indents/{id}/substitutions/apply`
      ].request).toBe('PharmacyWardApplySubstitutionRequest');
    }
  });

  test('handwritten OpenAPI returns canonical ward witness approvals', () => {
    expect(pharmacyOpenApiSchemas).not.toHaveProperty('PharmacyWardControlledWitnessResult');
    expect(JSON.stringify(pharmacyOpenApiSchemas)).not.toContain('witness_payload');
    expect(
      pharmacyOpenApiSchemas.PharmacyWardControlledWitnessResponse.properties.data,
    ).toEqual({
      $ref: '#/components/schemas/PharmacyCounterSaleWitnessApproval',
    });

    const decision = pharmacyOpenApiSchemas.PharmacyWardControlledWitnessDecisionRequest;
    expect(decision.oneOf).toEqual([
      { required: ['employeeId', 'password'] },
      {
        not: {
          anyOf: [
            { required: ['employeeId'] },
            { required: ['password'] },
          ],
        },
      },
    ]);
    expect(decision.properties.employeeId).toEqual({
      type: 'string',
      pattern: '^[A-Z0-9-]{3,20}$',
    });
    expect(decision.properties.password).toEqual({
      type: 'string',
      format: 'password',
      minLength: 6,
      maxLength: 100,
      writeOnly: true,
    });

    const canonicalApproval =
      pharmacyCounterSaleOpenApiSchemas.PharmacyCounterSaleWitnessApproval;
    expect(canonicalApproval.oneOf).toHaveLength(2);
    for (const variant of canonicalApproval.oneOf) {
      expect(variant.properties.scope.enum).toContain('ward_indent_controlled_handoff');
    }
    const approved = canonicalApproval.oneOf.find(
      (variant) => variant.properties.status.enum[0] === 'approved',
    );
    expect(approved.properties.witness).toEqual({
      $ref: '#/components/schemas/PharmacyClinicalControlledWitnessIdentity',
    });
    const clinicalWitness =
      pharmacyCounterSaleOpenApiSchemas.PharmacyClinicalControlledWitnessIdentity;
    expect(clinicalWitness.properties).not.toHaveProperty('facility_grant_id');
    expect(clinicalWitness.properties.role.enum).toEqual(expect.arrayContaining([
      'DOCTOR',
      'DUTY_DOCTOR',
      'NURSING_STAFF',
      'NURSING_INCHARGE',
      'IP_STAFF_NURSE',
      'OP_STAFF_NURSE',
    ]));

    for (const prefix of ['/api/v1/pharmacy-orders', '/api/v1/pharmacy']) {
      const requestOperation = pharmacyOpenApiOperations[
        `POST ${prefix}/ward-indents/{id}/controlled-handoff/witness-approvals`
      ];
      const approvalOperation = pharmacyOpenApiOperations[
        `POST ${prefix}/ward-indents/{id}/controlled-handoff/witness-approvals/{approvalId}/approve`
      ];
      expect(requestOperation.response).toBe('PharmacyWardControlledWitnessResponse');
      expect(approvalOperation.response).toBe('PharmacyWardControlledWitnessResponse');
      expect(requestOperation.responseStatus).toBe(201);
      expect(approvalOperation.responseStatus ?? 200).toBe(200);
      expect(approvalOperation).not.toHaveProperty('responseStatus');
    }
  });

  test('handwritten OpenAPI makes ward historical recovery explicit and exclusive', () => {
    const request = pharmacyOpenApiSchemas.PharmacyWardControlledHandoffRequest;
    const evidenceItems = request.properties.item_evidence.items;
    expect(Object.keys(evidenceItems)).toEqual(['oneOf']);
    expect(evidenceItems.oneOf).toHaveLength(3);

    const [itemOnly, witnessed, historical] = evidenceItems.oneOf;
    expect(itemOnly).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['item_id'],
    });
    expect(Object.keys(itemOnly.properties)).toEqual(['item_id']);
    expect(witnessed).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['item_id', 'witness_approval_id'],
    });
    expect(Object.keys(witnessed.properties)).toEqual(['item_id', 'witness_approval_id']);
    expect(historical).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['item_id', 'historical_recovery'],
    });
    expect(Object.keys(historical.properties)).toEqual(['item_id', 'historical_recovery']);
    for (const variant of evidenceItems.oneOf) {
      expect(variant.properties).not.toHaveProperty('movement_id');
      expect(variant.properties).not.toHaveProperty('register_id');
    }

    const recovery = historical.properties.historical_recovery;
    expect(recovery).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['movement_id', 'register_id', 'reason'],
    });
    expect(Object.keys(recovery.properties)).toEqual(['movement_id', 'register_id', 'reason']);
    const positiveInt32Contract = {
      type: 'integer',
      minimum: 1,
      maximum: 2147483647,
    };
    expect(recovery.properties.movement_id).toEqual(positiveInt32Contract);
    expect(recovery.properties.register_id).toEqual(positiveInt32Contract);
    expect(recovery.properties.reason).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 2000,
      pattern: '\\S',
    });

    for (const prefix of ['/api/v1/pharmacy-orders', '/api/v1/pharmacy']) {
      const operation = pharmacyOpenApiOperations[
        `POST ${prefix}/ward-indents/{id}/controlled-handoff`
      ];
      expect(operation.description).toMatch(
        /existing immutable movement\/register evidence pair[\s\S]*without a second inventory decrement/,
      );
    }
  });

  test('verification gate preserves the typed clinical code', () => {
    const gate = between(controller, 'async function verificationGateBlocked', 'async function emitPharmacyOrderEventInTx');
    expect(gate).toMatch(/relayAppError\(res, gateErr, 'Pharmacy verification gate failed'\)/);
    expect(gate).not.toMatch(/error\(res/);
  });

  test('counter dispense preserves typed inventory failures', () => {
    const counter = between(controller, 'export const markCounterDispensed', 'export const markUnavailable');
    expect(counter).toMatch(/return relayAppError\(res, err, 'Failed to dispense order'\)/);
    expect(counter).not.toMatch(/error\(res, 'Failed to dispense order', HTTP_STATUS\.INTERNAL_SERVER_ERROR\)/);
  });
});
