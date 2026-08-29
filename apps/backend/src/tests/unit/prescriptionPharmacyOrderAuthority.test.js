import { readFileSync } from 'node:fs';

function source(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

function between(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Missing source boundary: ${start} .. ${end}`);
  }
  return text.slice(startIndex, endIndex);
}

describe('prescription to pharmacy order authority contract', () => {
  const controller = source('controllers/prescription/ePrescriptionController.js');
  const routes = source('routes/prescription/index.js');
  const handler = between(
    controller,
    'export const orderPharmacyFromPrescription',
    '// Shared prescription-access predicate.',
  );

  test('order-pharmacy and refill both require durable idempotency keys', () => {
    const dynamicRoutes = between(
      routes,
      "wrapAutoRBAC(router, 'ePrescriptionDetailRoutes'",
      'export default router',
    );

    expect(dynamicRoutes).toMatch(/'\/:id\/order-pharmacy'[\s\S]*required:\s*true/);
    expect(dynamicRoutes).toMatch(/scope:\s*'prescription_order_pharmacy'/);
    expect(dynamicRoutes).toMatch(/retainOnServerError:\s*true/);
    expect(dynamicRoutes).toMatch(/'\/:id\/order-pharmacy'[\s\S]*durableDomainReceipt:\s*true/);
    expect(dynamicRoutes).toMatch(
      /requestPathForIdempotency:[\s\S]*\/api\/v1\/prescriptions\/\$\{req\.params\.id\}\/order-pharmacy/,
    );
    expect(dynamicRoutes).toMatch(/'\/:id\/refill'[\s\S]*required:\s*true/);
    expect(dynamicRoutes).toMatch(/scope:\s*'prescription_refill'/);
    expect(dynamicRoutes).toMatch(/'\/:id\/refill'[\s\S]*durableDomainReceipt:\s*true/);
    expect(dynamicRoutes).toMatch(
      /requestPathForIdempotency:[\s\S]*\/api\/v1\/prescriptions\/\$\{req\.params\.id\}\/refill/,
    );
  });

  test('locks the tenant prescription and atomically creates, links, and histories the order', () => {
    const transaction = between(
      handler,
      'const pharmacyOrder = await setTenantTx',
      'logAudit(',
    );

    expect(transaction).toMatch(/setTenantTx\(req\.tenantId, async \(tx\)/);
    expect(transaction).toMatch(/lockTenantPatientMergeStability\(tx, req\.tenantId\)/);
    expect(transaction).toMatch(/lockPharmacyCatalogAuthorityTx\(tx, req\.tenantId\)/);
    expect(transaction).toMatch(/FROM e_prescriptions[\s\S]*id=\$1::int AND tenant_id=\$2::uuid[\s\S]*FOR UPDATE/);
    expect(transaction).toMatch(/resolvePharmacyFacility\(tx,[\s\S]*tenantId:\s*req\.tenantId[\s\S]*forUpdate:\s*true/);
    expect(transaction).toMatch(/requireActorGrant:\s*!patientOwnedPlacement/);
    expect(transaction).toMatch(/FROM pharmacy_catalog[\s\S]*tenant_id=\$1::uuid[\s\S]*FOR UPDATE/);
    expect(transaction).toMatch(/INSERT INTO pharmacy_orders[\s\S]*\(tenant_id, facility_id/);
    expect(transaction).toMatch(/UPDATE e_prescriptions[\s\S]*WHERE id=\$3::int AND tenant_id=\$4::uuid/);
    expect(transaction).toMatch(/COALESCE\(revision, 1\)=\$5::int/);
    expect(transaction).toMatch(/INSERT INTO pharmacy_order_history[\s\S]*\(tenant_id, order_id/);
    expect(transaction).toMatch(/recordCanonicalClinicalEvent\([\s\S]*strict:\s*true/);
    expect(transaction).toMatch(/storePharmacyOrderCommandReceiptTx\(tx/);
    expect(transaction).toMatch(/PRESCRIPTION_PHARMACY_ORDER_ALREADY_EXISTS/);
    expect(transaction).toMatch(/PRESCRIPTION_PHARMACY_ORDER_STATE_CHANGED/);
  });

  test('only signed local prescriptions are orderable and caller authority is rechecked', () => {
    expect(handler).toMatch(/PRESCRIPTION_IMPORTED_HISTORY_NOT_ORDERABLE/);
    expect(handler).toMatch(/PRESCRIPTION_PHARMACY_SIGNED_AUTHORITY_REQUIRED/);
    expect(handler).toMatch(/PRESCRIPTION_PHARMACY_ACTIONABLE_STATUS_REQUIRED/);
    expect(handler).toMatch(/patientOwnedPlacement[\s\S]*String\(req\.user\?\.uid/);
    expect(handler).toMatch(/changed_by[\s\S]*canonicalActor\.actor_id/);
    expect(handler).not.toMatch(/'PENDING', 'patient'/);
  });

  test('in-flight retries recover only from the exact durable domain receipt', () => {
    expect(handler).toMatch(/req\.idempotencyClaim\?\.recoveringInFlight/);
    expect(handler).toMatch(/loadPharmacyOrderCommandReceiptTx\(tx/);
    expect(handler).toMatch(/PRESCRIPTION_PHARMACY_DOMAIN_RECEIPT_MISSING/);
    expect(handler).toMatch(/commandKeySha256/);
    expect(handler).toMatch(/requestSha256/);
  });

  test('fails closed on caller-selected non-equivalent or non-canonical catalog identities', () => {
    expect(handler).toMatch(/authoritativeSubstitutionAllowed\(originalRows\[0\], catRes\[0\]\)/);
    expect(handler).toMatch(/PRESCRIPTION_PHARMACY_CATALOG_NOT_EQUIVALENT/);
    expect(handler).toMatch(/PRESCRIPTION_CATALOG_CANONICALIZATION_REQUIRED/);
    expect(handler).toMatch(
      /String\(catRes\[0\]\.name \|\| ''\)\.trim\(\)\.toLowerCase\(\)[\s\S]*String\(medName \|\| ''\)\.trim\(\)\.toLowerCase\(\)/,
    );
  });

  test('rechecks catalog price and clinical identity under the same transaction lock', () => {
    const transaction = between(
      handler,
      'const pharmacyOrder = await setTenantTx',
      'logAudit(',
    );

    expect(transaction).toMatch(/lockedCatalog\.length !== catalogIds\.length/);
    expect(transaction).toMatch(/Number\(line\.price\) !== Number\(finalCatalog\.unit_price\)/);
    expect(transaction).toMatch(/authoritativeSubstitutionAllowed\([\s\S]*catalogById\.get\(originalCatalogId\)[\s\S]*finalCatalog/);
    expect(transaction).toMatch(/PRESCRIPTION_PHARMACY_CATALOG_CHANGED/);
    expect(transaction.indexOf('PRESCRIPTION_PHARMACY_CATALOG_CHANGED'))
      .toBeLessThan(transaction.indexOf('INSERT INTO pharmacy_orders'));
  });

  test('rejects invalid fulfillment modes before constructing order authority', () => {
    expect(handler).toMatch(/VALID_PHARMACY_DELIVERY_TYPES\.has\(delivery_type\)/);
    expect(handler).toMatch(/PRESCRIPTION_PHARMACY_DELIVERY_TYPE_INVALID/);
  });

  test('revalidates signed same-id catalog and pediatric source snapshots', () => {
    const transaction = between(
      handler,
      'const pharmacyOrder = await setTenantTx',
      'logAudit(',
    );
    expect(transaction).toMatch(/assertSignedPrescriptionClinicalAuthorityTx\(tx/);
    expect(controller).toMatch(/PRESCRIPTION_SIGNED_CATALOG_AUTHORITY_CHANGED/);
    expect(controller).toMatch(/PRESCRIPTION_SIGNED_PEDIATRIC_AUTHORITY_CHANGED/);
    expect(controller).toMatch(/FROM vitals_chart[\s\S]*id=\$3::int[\s\S]*FOR UPDATE/);
  });
});
