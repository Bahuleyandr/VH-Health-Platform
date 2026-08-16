import 'api_client.dart';

/// Pharmacy order management API calls.
class PharmacyApiService {
  PharmacyApiService._();

  // ─── Helpers ──────────────────────────────────────────────────────────────

  static Future<Map<String, dynamic>> _get(
    String path, {
    Map<String, String>? query,
  }) async {
    final resp = await ApiClient.get(path, queryParameters: query);
    return _handle(resp);
  }

  static Future<Map<String, dynamic>> _post(
    String path,
    Map<String, dynamic> body,
  ) async {
    final resp = await ApiClient.post(path, body: body);
    return _handle(resp);
  }

  static Future<Map<String, dynamic>> _delete(String path) async {
    final resp = await ApiClient.delete(path);
    return _handle(resp);
  }

  static Map<String, dynamic> _handle(ApiResponse resp) {
    if (resp.isSuccess && resp.raw is Map) {
      final raw = Map<String, dynamic>.from(resp.raw as Map);
      if (raw['success'] == true) {
        final data = raw['data'];
        if (data is Map) return Map<String, dynamic>.from(data);
        if (data is List) return {'data': data};
        return raw;
      }
    }
    throw Exception(resp.message ?? 'Request failed (${resp.statusCode})');
  }

  static List<dynamic> _listFrom(Map<String, dynamic> data, List<String> keys) {
    dynamic value;
    for (final key in keys) {
      value = data[key];
      if (value != null) break;
    }
    value ??= data['data'];
    if (value is Map) {
      return _listFrom(Map<String, dynamic>.from(value), keys);
    }
    if (value is List) return value;
    return const [];
  }

  // ─── Shared Formulary / Medication Catalog ───────────────────────────────

  /// GET /pharmacy-orders/catalog — the same formulary source used by OP/IP
  /// prescribing autocomplete.
  static Future<List<Map<String, dynamic>>> getCatalog({
    String? search,
    String? category,
  }) async {
    final resp = await _get(
      '/pharmacy-orders/catalog',
      query: {
        if (search != null && search.trim().isNotEmpty) 'search': search.trim(),
        if (category != null && category.trim().isNotEmpty)
          'category': category.trim(),
      },
    );
    return _listFrom(resp, const [
      'catalog',
      'items',
      'medications',
    ]).whereType<Map>().map((row) => Map<String, dynamic>.from(row)).toList();
  }

  /// POST /pharmacy-orders/catalog — Pharmacy Incharge/Admin formulary upsert.
  static Future<Map<String, dynamic>> saveCatalogItem({
    int? id,
    required String name,
    String? genericName,
    String? category,
    String? manufacturer,
    num? unitPrice,
    String? packSize,
    bool requiresPrescription = true,
    bool inStock = true,
    int? stockQuantity,
    int? reorderLevel,
  }) async {
    return _post('/pharmacy-orders/catalog', {
      'id': ?id,
      'name': name.trim(),
      'generic_name': genericName?.trim(),
      'category': category?.trim().isNotEmpty == true
          ? category!.trim()
          : 'other',
      'manufacturer': manufacturer?.trim(),
      'unit_price': unitPrice,
      'pack_size': packSize?.trim(),
      'requires_prescription': requiresPrescription,
      'in_stock': inStock,
      'stock_quantity': stockQuantity ?? 0,
      'reorder_level': reorderLevel ?? 10,
    });
  }

  /// DELETE /pharmacy-orders/catalog/:id — soft-removes an active medicine.
  static Future<Map<String, dynamic>> removeCatalogItem(int id) async {
    return _delete('/pharmacy-orders/catalog/$id');
  }

  // ─── Inventory / Stores ──────────────────────────────────────────────────

  /// GET /pharmacy/inventory/v2/items — operational inventory item list.
  static Future<List<Map<String, dynamic>>> getInventoryItems({
    String? search,
    String? schedule,
    String? status,
  }) async {
    final resp = await _get(
      '/pharmacy/inventory/v2/items',
      query: {
        if (search != null && search.trim().isNotEmpty) 'q': search.trim(),
        if (schedule != null && schedule.trim().isNotEmpty)
          'schedule': schedule.trim(),
        if (status != null && status.trim().isNotEmpty) 'status': status.trim(),
      },
    );
    return _listFrom(resp, const [
      'items',
      'inventory',
    ]).whereType<Map>().map((row) => Map<String, dynamic>.from(row)).toList();
  }

  /// POST /pharmacy/inventory/v2/items — Stores/Purchase or Pharmacy Incharge.
  static Future<Map<String, dynamic>> createInventoryItem({
    required String skuCode,
    required String displayName,
    String? genericName,
    String? brandName,
    String? manufacturer,
    String? form,
    String? strength,
    String? unitLabel,
    String? packSize,
    String? scheduleClass,
    bool isNarcotic = false,
    bool isColdChain = false,
    num? reorderLevel,
    num? reorderQuantity,
  }) async {
    return _post('/pharmacy/inventory/v2/items', {
      'sku_code': skuCode.trim(),
      'display_name': displayName.trim(),
      'generic_name': genericName?.trim(),
      'brand_name': brandName?.trim(),
      'manufacturer': manufacturer?.trim(),
      'form': form?.trim(),
      'strength': strength?.trim(),
      'unit_label': unitLabel?.trim().isNotEmpty == true
          ? unitLabel!.trim()
          : 'each',
      'pack_size': packSize?.trim(),
      'schedule_class': scheduleClass?.trim().isNotEmpty == true
          ? scheduleClass!.trim()
          : null,
      'is_narcotic': isNarcotic,
      'is_cold_chain': isColdChain,
      'reorder_level': reorderLevel,
      'reorder_quantity': reorderQuantity,
    });
  }

  /// GET /pharmacy/inventory/v2/expiry-alerts — cached expiry buckets.
  static Future<List<Map<String, dynamic>>> getExpiryAlerts({
    String? bucket,
  }) async {
    final resp = await _get(
      '/pharmacy/inventory/v2/expiry-alerts',
      query: {
        if (bucket != null && bucket.trim().isNotEmpty) 'bucket': bucket.trim(),
      },
    );
    return _listFrom(resp, const [
      'alerts',
      'expiry_alerts',
      'items',
    ]).whereType<Map>().map((row) => Map<String, dynamic>.from(row)).toList();
  }

  /// POST /pharmacy/inventory/v2/run-expiry-scan.
  static Future<Map<String, dynamic>> runExpiryScan() async {
    return _post('/pharmacy/inventory/v2/run-expiry-scan', {});
  }

  // ─── Pharmacy Orders ──────────────────────────────────────────────────────

  /// POST /pharmacy-orders/orders — create a pharmacy order for a patient.
  static Future<Map<String, dynamic>> placePharmacyOrder({
    required String phone,
    required String orderNote,
    bool urgent = false,
  }) async {
    return _post('/pharmacy-orders/orders', {
      'phone': phone,
      'order_note': orderNote,
      'urgent': urgent,
    });
  }

  /// GET /pharmacy-orders/orders/queue — pharmacy order queue
  static Future<List<dynamic>> getPharmacyOrderQueue({String? status}) async {
    final resp = await _get(
      '/pharmacy-orders/orders/queue',
      query: {'status': ?status},
    );
    return _listFrom(resp, const ['orders', 'queue']);
  }

  /// POST /pharmacy-orders/orders/:id/confirm
  static Future<Map<String, dynamic>> confirmPharmacyOrder(
    int id,
    Map<String, dynamic> data,
  ) async {
    return _post('/pharmacy-orders/orders/$id/confirm', data);
  }

  /// POST /pharmacy-orders/orders/:id/preparing
  static Future<Map<String, dynamic>> markPharmacyPreparing(int id) async {
    return _post('/pharmacy-orders/orders/$id/preparing', {});
  }

  /// POST /pharmacy-orders/orders/:id/dispatch
  static Future<Map<String, dynamic>> dispatchPharmacyOrder(
    int id,
    Map<String, dynamic> data,
  ) async {
    return _post('/pharmacy-orders/orders/$id/dispatch', data);
  }

  /// POST /pharmacy-orders/orders/:id/delivered
  static Future<Map<String, dynamic>> markPharmacyDelivered(int id) async {
    return _post('/pharmacy-orders/orders/$id/delivered', {});
  }

  /// POST /pharmacy-orders/orders/:id/cancel
  static Future<Map<String, dynamic>> cancelPharmacyOrder(
    int id,
    String reason,
  ) async {
    return _post('/pharmacy-orders/orders/$id/cancel', {
      'cancellation_reason': reason,
    });
  }

  /// POST /pharmacy-orders/dispense-substitution
  ///
  /// Pharmacist dispenses an in-stock, same-formulation alternative in place of a
  /// prescribed brand. The backend re-resolves both catalog ids, re-checks equivalence,
  /// decrements the chosen batch, and writes the canonical clinical timeline + audit
  /// pair atomically. Returns `{ movement_id, original_catalog_id, final_catalog_id,
  /// quantity }`. `finalCatalogId` is the chosen alternative (the panel's onSwap item's
  /// catalogId); `originalCatalogId` is the prescribed brand.
  static Future<Map<String, dynamic>> dispenseSubstitution({
    required String patientUid,
    int? encounterId,
    required int inventoryItemId,
    required int inventoryBatchId,
    required num quantity,
    required int originalCatalogId,
    required int finalCatalogId,
    String? reason,
  }) async {
    return _post('/pharmacy-orders/dispense-substitution', {
      'patient_uid': patientUid,
      'encounter_id': ?encounterId,
      'inventory_item_id': inventoryItemId,
      'inventory_batch_id': inventoryBatchId,
      'quantity': quantity,
      'original_catalog_id': originalCatalogId,
      'final_catalog_id': finalCatalogId,
      'reason': ?reason,
    });
  }

  /// GET /pharmacy-orders/orders/:id/dispensable
  /// The patient + prescribed catalog-id lines behind an order — the context a
  /// pharmacist needs to dispense a same-formulation substitute.
  /// Returns `{ order_id, patient_uid, appointment_id?, admission_id?, lines:[{catalog_id,name,quantity}] }`.
  static Future<Map<String, dynamic>> getOrderDispensable(int orderId) async {
    return _get('/pharmacy-orders/orders/$orderId/dispensable');
  }

  /// GET /pharmacy-orders/catalog/:id/dispensable-batches
  /// In-stock, non-expired, FEFO-ordered batches for a catalog brand — the batch picker.
  /// Each: `{ inventory_item_id, inventory_batch_id, batch_number, remaining_quantity, expiry_date }`.
  static Future<List<Map<String, dynamic>>> getCatalogDispensableBatches(
    int catalogId,
  ) async {
    final data = await _get(
      '/pharmacy-orders/catalog/$catalogId/dispensable-batches',
    );
    return _listFrom(data, [
      'batches',
    ]).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
  }

  // ─── Walk-in Counter Point-of-Sale ───────────────────────────────────────

  /// GET /pharmacy-orders/counter-sales/items — sellable items with usable
  /// stock and the FEFO head batch (number, expiry, MRP unit price).
  static Future<List<Map<String, dynamic>>> getCounterSaleItems({
    String? search,
  }) async {
    final resp = await _get(
      '/pharmacy-orders/counter-sales/items',
      query: {
        if (search != null && search.trim().isNotEmpty) 'q': search.trim(),
      },
    );
    return _listFrom(resp, const [
      'items',
    ]).whereType<Map>().map((row) => Map<String, dynamic>.from(row)).toList();
  }

  /// POST /pharmacy-orders/counter-sales — sell: FEFO dispense + schedule
  /// enforcement + billingV2 PHARMACY invoice + pay-at-counter payment.
  static Future<Map<String, dynamic>> createCounterSale({
    required List<Map<String, dynamic>> lines,
    String? patientUid,
    String? customerName,
    String? customerPhone,
    Map<String, dynamic>? rx,
    Map<String, dynamic>? witness,
    required String paymentMode,
    String? paymentReference,
    String? notes,
  }) async {
    return _post('/pharmacy-orders/counter-sales', {
      'lines': lines,
      'patient_uid': ?patientUid,
      'customer_name': ?customerName,
      'customer_phone': ?customerPhone,
      'rx': ?rx,
      'witness': ?witness,
      'payment_mode': paymentMode,
      'payment_reference': ?paymentReference,
      'notes': ?notes,
    });
  }

  /// GET /pharmacy-orders/counter-sales — recent sales (newest first).
  static Future<List<Map<String, dynamic>>> listCounterSales({
    String? status,
    String? date,
  }) async {
    final resp = await _get(
      '/pharmacy-orders/counter-sales',
      query: {'status': ?status, 'date': ?date},
    );
    return _listFrom(resp, const [
      'sales',
    ]).whereType<Map>().map((row) => Map<String, dynamic>.from(row)).toList();
  }

  /// POST /pharmacy-orders/counter-sales/:id/void — same-day void: billing
  /// refund + exact per-batch restock (register returns for scheduled lines).
  static Future<Map<String, dynamic>> voidCounterSale(
    String id,
    String reason,
  ) async {
    return _post('/pharmacy-orders/counter-sales/$id/void', {'reason': reason});
  }
}
