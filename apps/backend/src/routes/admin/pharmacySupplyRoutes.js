/**
 * Admin routes for pharmacy supply chain (Phase C4).
 * Mounted at /api/v1/admin/pharmacy-supply.
 */

import express from 'express';

import { PHARMACY_SUPPLY_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import rbac from '../../middleware/rbacMiddleware.js';
import { success } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';
import {
  pharmacyFacilityActorFromRequest,
  requestedPharmacyFacilityId,
} from '../../services/pharmacy/pharmacyFacilityAuthorityService.js';
import {
  acknowledgeExpiryAlert,
  addInventoryBatch,
  addPurchaseOrderItem,
  addSubstitute,
  appendStockMovement,
  bridgeForecastToBatches,
  computeExpiryAlerts,
  createGoodsReceipt,
  createPurchaseOrder,
  listBatches,
  listExpiryAlerts,
  listGoodsReceipts,
  listInventoryItems,
  listPurchaseOrders,
  listStockMovements,
  listSubstitutes,
  listSuppliers,
  recordGoodsReceiptItemQc,
  recallBatch,
  receivePurchaseOrderLine,
  transitionGoodsReceipt,
  transitionPurchaseOrder,
  upsertInventoryItem,
  upsertSupplier,
} from '../../services/pharmacySupply/pharmacySupplyService.js';

const router = express.Router();

const STOCK_MOVEMENT_CANONICAL_PATH = '/api/v1/admin/pharmacy-supply/stock-movements';
const DIRECT_RECEIVE_CANONICAL_PATH = '/api/v1/admin/pharmacy-supply/batches';

router.use(rbac(PHARMACY_SUPPLY_ROUTE_ROLES));

// Suppliers
router.put('/suppliers', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await upsertSupplier({
      tenantId: req.tenantId, id: b.id, facilityId: b.facility_id,
      supplierCode: b.supplier_code, displayName: b.display_name,
      legalName: b.legal_name, gstin: b.gstin,
      drugLicenseNumber: b.drug_license_number, pan: b.pan,
      contactEmail: b.contact_email, contactPhone: b.contact_phone,
      address: b.address, paymentTerms: b.payment_terms,
      bankDetails: b.bank_details, status: b.status,
      rating: b.rating, metadata: b.metadata,
      createdBy: req.user?.uid || null,
      ...pharmacyFacilityActorFromRequest(req),
    });
    return success(res, row, 'Supplier saved');
  } catch (err) { return next(err); }
});

router.get('/suppliers', async (req, res, next) => {
  try {
    const result = await listSuppliers({
      tenantId: req.tenantId,
      facilityId: requestedPharmacyFacilityId(req),
      status: req.query.status || null,
      limit: req.query.limit,
      ...pharmacyFacilityActorFromRequest(req),
    });
    return success(res, result, 'Suppliers retrieved');
  } catch (err) { return next(err); }
});

// Inventory items
router.put('/inventory-items', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await upsertInventoryItem({
      tenantId: req.tenantId, id: b.id, facilityId: b.facility_id,
      catalogId: b.catalog_id,
      skuCode: b.sku_code, displayName: b.display_name,
      genericName: b.generic_name, brandName: b.brand_name,
      manufacturer: b.manufacturer, form: b.form, strength: b.strength,
      unitLabel: b.unit_label, packSize: b.pack_size,
      hsnCode: b.hsn_code, scheduleClass: b.schedule_class,
      isNarcotic: b.is_narcotic, isColdChain: b.is_cold_chain,
      reorderLevel: b.reorder_level, reorderQuantity: b.reorder_quantity,
      defaultSupplierId: b.default_supplier_id,
      status: b.status, metadata: b.metadata,
      ...pharmacyFacilityActorFromRequest(req),
    });
    return success(res, row, 'Inventory item saved');
  } catch (err) { return next(err); }
});

router.get('/inventory-items', async (req, res, next) => {
  try {
    const result = await listInventoryItems({
      tenantId: req.tenantId,
      facilityId: requestedPharmacyFacilityId(req),
      status: req.query.status || null,
      isNarcotic: req.query.is_narcotic != null ? req.query.is_narcotic === 'true' : null,
      q: req.query.q || null,
      limit: req.query.limit,
      ...pharmacyFacilityActorFromRequest(req),
    });
    return success(res, result, 'Inventory items retrieved');
  } catch (err) { return next(err); }
});

// Batches
router.post('/batches', requireIdempotencyKey({
  required: true,
  durableDomainReceipt: true,
  retainOnServerError: true,
  scope: 'pharmacy-supply-direct-receive',
  requestPathForIdempotency: DIRECT_RECEIVE_CANONICAL_PATH,
}), async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await addInventoryBatch({
      tenantId: req.tenantId,
      inventoryItemId: b.inventory_item_id,
      facilityId: b.facility_id,
      batchNumber: b.batch_number, lotNumber: b.lot_number,
      manufactureDate: b.manufacture_date, expiryDate: b.expiry_date,
      receivedQuantity: b.received_quantity,
      unitCostMinor: b.unit_cost_minor, mrpMinor: b.mrp_minor,
      supplierId: b.supplier_id, goodsReceiptId: b.goods_receipt_id,
      storageLocationId: b.storage_location_id,
      performedBy: req.user?.uid || null,
      actorRole: req.user?.role || null,
      metadata: b.metadata,
      commandKey: req.idempotencyClaim?.requestKey || req.get('idempotency-key'),
      requestFingerprint: req.idempotencyClaim?.requestBodyHash || null,
    });
    return success(res, row, 'Batch added', 201);
  } catch (err) { return next(err); }
});

router.get('/batches', async (req, res, next) => {
  try {
    const result = await listBatches({
      tenantId: req.tenantId,
      inventoryItemId: req.query.inventory_item_id || null,
      facilityId: requestedPharmacyFacilityId(req),
      status: req.query.status || null,
      expiringWithinDays: req.query.expiring_within_days || null,
      limit: req.query.limit,
      ...pharmacyFacilityActorFromRequest(req),
    });
    return success(res, result, 'Batches retrieved');
  } catch (err) { return next(err); }
});

router.patch('/batches/:id/recall', async (req, res, next) => {
  try {
    const row = await recallBatch({
      tenantId: req.tenantId, id: req.params.id,
      recallReference: req.body?.recall_reference,
      performedBy: req.user?.uid || null,
      actorRole: req.user?.role || null,
    });
    return success(res, row, 'Batch recalled');
  } catch (err) { return next(err); }
});

router.post('/reserve-stock', (_req, _res, next) => next(new AppError(
  'The untyped stock reservation endpoint is retired; use a governed order, ward, counter-sale, or clinical custody workflow',
  410,
  'PHARMACY_SUPPLY_RESERVE_STOCK_RETIRED',
)));

// Purchase orders
router.post('/purchase-orders', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await createPurchaseOrder({
      tenantId: req.tenantId, facilityId: b.facility_id,
      poNumber: b.po_number, supplierId: b.supplier_id, status: b.status,
      expectedAt: b.expected_at, totalAmountMinor: b.total_amount_minor,
      currency: b.currency, notes: b.notes,
      metadata: b.metadata, createdBy: req.user?.uid || null,
      actorRole: req.user?.role || null,
    });
    return success(res, row, 'Purchase order created', 201);
  } catch (err) { return next(err); }
});

router.get('/purchase-orders', async (req, res, next) => {
  try {
    const result = await listPurchaseOrders({
      tenantId: req.tenantId,
      facilityId: requestedPharmacyFacilityId(req),
      supplierId: req.query.supplier_id || null,
      status: req.query.status || null,
      limit: req.query.limit,
      ...pharmacyFacilityActorFromRequest(req),
    });
    return success(res, result, 'Purchase orders retrieved');
  } catch (err) { return next(err); }
});

router.patch('/purchase-orders/:id/transition', async (req, res, next) => {
  try {
    const row = await transitionPurchaseOrder({
      tenantId: req.tenantId, id: req.params.id,
      nextStatus: req.body?.next_status,
      cancellationReason: req.body?.cancellation_reason,
      approvedBy: req.user?.uid || null,
      actorRole: req.user?.role || null,
    });
    return success(res, row, 'Purchase order transitioned');
  } catch (err) { return next(err); }
});

router.post('/purchase-orders/:id/items', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await addPurchaseOrderItem({
      tenantId: req.tenantId, purchaseOrderId: req.params.id,
      inventoryItemId: b.inventory_item_id,
      orderedQuantity: b.ordered_quantity,
      unitPriceMinor: b.unit_price_minor,
      taxRatePct: b.tax_rate_pct,
      notes: b.notes,
      ...pharmacyFacilityActorFromRequest(req),
    });
    return success(res, row, 'PO item added', 201);
  } catch (err) { return next(err); }
});

// Atomic GRN-line orchestration: insert batch + bump PO line +
// insert GRN item + append receive movement + transition parent PO,
// all in one transaction. URL :id is the parent PO (audit context);
// body identifies the line via purchase_order_item_id.
router.post('/purchase-orders/:id/receive-line', requireIdempotencyKey({
  required: true,
  durableDomainReceipt: true,
  retainOnServerError: true,
  scope: 'pharmacy-supply-grn-receive-line',
  requestPathForIdempotency: (req) => (
    `/api/v1/admin/pharmacy-supply/purchase-orders/${encodeURIComponent(String(req.params.id))}/receive-line`
  ),
}), async (req, res, next) => {
  try {
    const b = req.body || {};
    const result = await receivePurchaseOrderLine({
      tenantId: req.tenantId,
      purchaseOrderId: req.params.id,
      purchaseOrderItemId: b.purchase_order_item_id,
      goodsReceiptId: b.goods_receipt_id,
      batchNumber: b.batch_number,
      expiryDate: b.expiry_date,
      receivedQuantity: b.received_quantity,
      lotNumber: b.lot_number,
      manufactureDate: b.manufacture_date,
      unitCostMinor: b.unit_cost_minor,
      supplierId: b.supplier_id,
      storageLocationId: b.storage_location_id,
      performedBy: req.user?.uid || null,
      actorRole: req.user?.role || null,
      commandKey: req.idempotencyClaim?.requestKey || req.get('idempotency-key'),
      requestFingerprint: req.idempotencyClaim?.requestBodyHash || null,
    });
    return success(res, result, 'PO line received', 201);
  } catch (err) { return next(err); }
});

// Goods receipts
router.post('/goods-receipts', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await createGoodsReceipt({
      tenantId: req.tenantId, facilityId: b.facility_id,
      grnNumber: b.grn_number, purchaseOrderId: b.purchase_order_id,
      supplierId: b.supplier_id, invoiceNumber: b.invoice_number,
      invoiceDate: b.invoice_date, totalAmountMinor: b.total_amount_minor,
      notes: b.notes, receivedBy: req.user?.uid || null,
      metadata: b.metadata,
      actorRole: req.user?.role || null,
    });
    return success(res, row, 'Goods receipt created', 201);
  } catch (err) { return next(err); }
});

router.get('/goods-receipts', async (req, res, next) => {
  try {
    const result = await listGoodsReceipts({
      tenantId: req.tenantId,
      facilityId: requestedPharmacyFacilityId(req),
      status: req.query.status || null,
      supplierId: req.query.supplier_id || null,
      limit: req.query.limit,
      ...pharmacyFacilityActorFromRequest(req),
    });
    return success(res, result, 'Goods receipts retrieved');
  } catch (err) { return next(err); }
});

router.patch('/goods-receipts/:id/items/:itemId/qc', async (req, res, next) => {
  try {
    const row = await recordGoodsReceiptItemQc({
      tenantId: req.tenantId,
      goodsReceiptId: req.params.id,
      goodsReceiptItemId: req.params.itemId,
      qcStatus: req.body?.qc_status,
      qcNotes: req.body?.qc_notes,
      performedBy: req.user?.uid || null,
      actorRole: req.user?.role || null,
    });
    return success(res, row, 'Goods receipt line QC recorded');
  } catch (err) { return next(err); }
});

router.patch('/goods-receipts/:id/transition', async (req, res, next) => {
  try {
    const row = await transitionGoodsReceipt({
      tenantId: req.tenantId,
      id: req.params.id,
      action: req.body?.action,
      performedBy: req.user?.uid || null,
      actorRole: req.user?.role || null,
    });
    return success(res, row, 'Goods receipt transitioned');
  } catch (err) { return next(err); }
});

// Stock movements
router.post('/stock-movements', requireIdempotencyKey({
  required: true,
  scope: 'pharmacy_supply_stock_movement',
  retainOnServerError: true,
  durableDomainReceipt: true,
  requestPathForIdempotency: STOCK_MOVEMENT_CANONICAL_PATH,
}), async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await appendStockMovement({
      tenantId: req.tenantId,
      inventoryItemId: b.inventory_item_id,
      inventoryBatchId: b.inventory_batch_id,
      movementKind: b.movement_kind,
      quantityDelta: b.quantity_delta,
      referenceType: b.reference_type,
      referenceId: b.reference_id,
      performedBy: req.user?.uid || null,
      notes: b.notes, metadata: b.metadata,
      commandKey: req.idempotencyClaim?.requestKey || req.get('idempotency-key'),
      requestFingerprint: req.idempotencyClaim?.requestBodyHash || null,
      actorRole: req.user?.role || null,
    });
    return success(res, row, 'Stock movement appended', 201);
  } catch (err) { return next(err); }
});

router.get('/stock-movements', async (req, res, next) => {
  try {
    const result = await listStockMovements({
      tenantId: req.tenantId,
      facilityId: requestedPharmacyFacilityId(req),
      inventoryItemId: req.query.inventory_item_id || null,
      inventoryBatchId: req.query.inventory_batch_id || null,
      movementKind: req.query.movement_kind || null,
      limit: req.query.limit,
      ...pharmacyFacilityActorFromRequest(req),
    });
    return success(res, result, 'Stock movements retrieved');
  } catch (err) { return next(err); }
});

// Forecast bridge — wires pharmacy_inventory_batches into the existing
// clinical_ai_inventory_alerts forecast surface.
router.post('/forecast-bridge', async (req, res, next) => {
  try {
    const result = await bridgeForecastToBatches({
      tenantId: req.tenantId,
      facilityId: requestedPharmacyFacilityId(req),
      lookbackDays: req.body?.lookback_days,
      ...pharmacyFacilityActorFromRequest(req),
    });
    return success(res, result, 'Forecast bridge complete');
  } catch (err) { return next(err); }
});

// Expiry alerts
router.post('/expiry-alerts/scan', async (req, res, next) => {
  try {
    const result = await computeExpiryAlerts({
      tenantId: req.tenantId,
      facilityId: requestedPharmacyFacilityId(req),
      lookaheadDays: req.body?.lookahead_days,
      ...pharmacyFacilityActorFromRequest(req),
    });
    return success(res, result, 'Expiry-alert scan complete');
  } catch (err) { return next(err); }
});

router.get('/expiry-alerts', async (req, res, next) => {
  try {
    const result = await listExpiryAlerts({
      tenantId: req.tenantId,
      facilityId: requestedPharmacyFacilityId(req),
      status: req.query.status || null,
      severity: req.query.severity || null,
      limit: req.query.limit,
      ...pharmacyFacilityActorFromRequest(req),
    });
    return success(res, result, 'Expiry alerts retrieved');
  } catch (err) { return next(err); }
});

router.patch('/expiry-alerts/:id/acknowledge', async (req, res, next) => {
  try {
    const row = await acknowledgeExpiryAlert({
      tenantId: req.tenantId, id: req.params.id,
      acknowledgedBy: req.user?.uid || null,
      resolution: req.body?.resolution,
      actorRole: req.user?.role || null,
    });
    return success(res, row, 'Expiry alert acknowledged');
  } catch (err) { return next(err); }
});

// Substitutes
router.post('/substitutes', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await addSubstitute({
      tenantId: req.tenantId,
      primaryItemId: b.primary_item_id,
      substituteItemId: b.substitute_item_id,
      substitutionKind: b.substitution_kind,
      isBidirectional: b.is_bidirectional,
      notes: b.notes, status: b.status, metadata: b.metadata,
      createdBy: req.user?.uid || null,
      actorRole: req.user?.role || null,
    });
    return success(res, row, 'Substitute pair added', 201);
  } catch (err) { return next(err); }
});

router.get('/substitutes', async (req, res, next) => {
  try {
    const result = await listSubstitutes({
      tenantId: req.tenantId,
      facilityId: requestedPharmacyFacilityId(req),
      primaryItemId: req.query.primary_item_id || null,
      status: req.query.status || null,
      ...pharmacyFacilityActorFromRequest(req),
    });
    return success(res, result, 'Substitutes retrieved');
  } catch (err) { return next(err); }
});

export default router;
