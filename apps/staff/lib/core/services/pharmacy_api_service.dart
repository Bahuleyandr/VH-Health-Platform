import 'api_client.dart';

class PharmacyWardIndentPage {
  const PharmacyWardIndentPage({
    required this.items,
    required this.hasMore,
    this.nextBeforeRequestedAt,
    this.nextBeforeId,
  });

  final List<Map<String, dynamic>> items;
  final bool hasMore;
  final DateTime? nextBeforeRequestedAt;
  final int? nextBeforeId;
}

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

  static Future<Map<String, dynamic>> _getEnvelope(
    String path, {
    Map<String, String>? query,
  }) async {
    final resp = await ApiClient.get(path, queryParameters: query);
    return _successEnvelope(resp);
  }

  static Future<Map<String, dynamic>> _post(
    String path,
    Map<String, dynamic> body, {
    String? idempotencyKey,
  }) async {
    final resp = await ApiClient.post(
      path,
      body: body,
      idempotencyKey: idempotencyKey,
    );
    return _handle(resp);
  }

  static Future<Map<String, dynamic>> _delete(String path) async {
    final resp = await ApiClient.delete(path);
    return _handle(resp);
  }

  static Map<String, dynamic> _handle(ApiResponse resp) {
    final raw = _successEnvelope(resp);
    final data = raw['data'];
    if (data is Map) return Map<String, dynamic>.from(data);
    if (data is List) return {'data': data};
    return raw;
  }

  static Map<String, dynamic> _successEnvelope(ApiResponse resp) {
    if (resp.isSuccess && resp.raw is Map) {
      final raw = Map<String, dynamic>.from(resp.raw as Map);
      if (raw['success'] == true) return raw;
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
    int? catalogId,
  }) async {
    final resp = await _get(
      '/pharmacy/inventory/v2/items',
      query: {
        if (search != null && search.trim().isNotEmpty) 'q': search.trim(),
        if (schedule != null && schedule.trim().isNotEmpty)
          'schedule': schedule.trim(),
        if (status != null && status.trim().isNotEmpty) 'status': status.trim(),
        if (catalogId != null) 'catalog_id': '$catalogId',
      },
    );
    return _listFrom(resp, const [
      'items',
      'inventory',
    ]).whereType<Map>().map((row) => Map<String, dynamic>.from(row)).toList();
  }

  /// GET /pharmacy/inventory/v2/batches — tenant batches for one inventory
  /// item. Ward dispensing uses this instead of choosing stock by drug name.
  static Future<List<Map<String, dynamic>>> getInventoryBatches({
    required int itemId,
    String status = 'in_stock',
  }) async {
    final resp = await _get(
      '/pharmacy/inventory/v2/batches',
      query: {'item_id': '$itemId', 'status': status},
    );
    return _listFrom(resp, const [
      'batches',
      'items',
    ]).whereType<Map>().map((row) => Map<String, dynamic>.from(row)).toList();
  }

  /// Starts the independently authenticated witness ceremony for a Schedule
  /// X or narcotic ward dispense. [dispense] must be reused byte-for-byte by
  /// the approval and final dispense calls.
  static Future<Map<String, dynamic>> requestControlledDispenseWitnessApproval({
    required Map<String, dynamic> dispense,
    required String idempotencyKey,
  }) async {
    return _post(
      '/pharmacy/inventory/v2/controlled-dispense/witness-approvals',
      dispense,
      idempotencyKey: idempotencyKey,
    );
  }

  /// Authenticates a second staff member without replacing the dispenser's
  /// session, then approves the exact controlled-dispense payload.
  static Future<Map<String, dynamic>> approveControlledDispenseWitnessApproval({
    required String approvalId,
    required Map<String, dynamic> dispense,
    required String employeeId,
    required String password,
    required String idempotencyKey,
  }) async {
    return _post(
      '/pharmacy/inventory/v2/controlled-dispense/witness-approvals/'
      '$approvalId/approve',
      {
        'dispense': dispense,
        'employeeId': employeeId.trim().toUpperCase(),
        'password': password,
      },
      idempotencyKey: idempotencyKey,
    );
  }

  /// Commits one controlled stock decrement and its statutory register row in
  /// the backend's single tenant transaction.
  static Future<Map<String, dynamic>> dispenseControlledInventory({
    required Map<String, dynamic> dispense,
    required String idempotencyKey,
  }) async {
    return _post(
      '/pharmacy/inventory/v2/controlled-dispense',
      dispense,
      idempotencyKey: idempotencyKey,
    );
  }

  /// Records an Inventory V2 movement. Controlled returns are committed with
  /// their statutory schedule-register row by the backend in the same tenant
  /// transaction.
  static Future<Map<String, dynamic>> recordInventoryMovement({
    required Map<String, dynamic> movement,
    required String idempotencyKey,
  }) {
    return _post(
      '/pharmacy/inventory/v2/movements',
      movement,
      idempotencyKey: idempotencyKey,
    );
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

  // ─── Ward-to-pharmacy indents ───────────────────────────────────────────

  /// GET /pharmacy-orders/ward-indents — the authoritative inpatient supply
  /// queue introduced by MED-01.
  static Future<List<Map<String, dynamic>>> listWardIndents({
    int? wardId,
    String? status,
    int? admissionId,
    String? patientUid,
    bool overdueOnly = false,
    String? worklist,
    DateTime? beforeRequestedAt,
    int? beforeId,
    int limit = 100,
  }) async {
    final page = await listWardIndentPage(
      wardId: wardId,
      status: status,
      admissionId: admissionId,
      patientUid: patientUid,
      overdueOnly: overdueOnly,
      worklist: worklist,
      beforeRequestedAt: beforeRequestedAt,
      beforeId: beforeId,
      limit: limit,
    );
    return page.items;
  }

  static Future<PharmacyWardIndentPage> listWardIndentPage({
    int? wardId,
    String? status,
    int? admissionId,
    String? patientUid,
    bool overdueOnly = false,
    String? worklist,
    DateTime? beforeRequestedAt,
    int? beforeId,
    int limit = 100,
  }) async {
    if ((beforeRequestedAt == null) != (beforeId == null)) {
      throw ArgumentError(
        'beforeRequestedAt and beforeId must be supplied together',
      );
    }
    final envelope = await _getEnvelope(
      '/pharmacy-orders/ward-indents',
      query: {
        if (wardId != null) 'ward_id': '$wardId',
        if (status != null && status.trim().isNotEmpty) 'status': status.trim(),
        if (admissionId != null) 'admission_id': '$admissionId',
        if (patientUid != null && patientUid.trim().isNotEmpty)
          'patient_uid': patientUid.trim(),
        if (overdueOnly) 'overdue_only': 'true',
        if (worklist != null && worklist.trim().isNotEmpty)
          'worklist': worklist.trim(),
        if (beforeRequestedAt != null)
          'before_requested_at': beforeRequestedAt.toUtc().toIso8601String(),
        if (beforeId != null) 'before_id': '$beforeId',
        'limit': '$limit',
      },
    );
    final items = _listFrom(
      {'data': envelope['data']},
      const ['indents', 'ward_indents'],
    ).whereType<Map>().map((row) => Map<String, dynamic>.from(row)).toList();
    final meta = envelope['meta'] is Map
        ? Map<String, dynamic>.from(envelope['meta'] as Map)
        : const <String, dynamic>{};
    final pagination = meta['pagination'] is Map
        ? Map<String, dynamic>.from(meta['pagination'] as Map)
        : const <String, dynamic>{};
    final hasMore = pagination['has_more'] == true;
    final nextRequestedAt = DateTime.tryParse(
      pagination['before_requested_at']?.toString() ?? '',
    );
    final nextId = pagination['before_id'] is num
        ? (pagination['before_id'] as num).toInt()
        : int.tryParse(pagination['before_id']?.toString() ?? '');
    if (hasMore && (nextRequestedAt == null || nextId == null)) {
      throw const FormatException(
        'Ward indent pagination response did not include a complete cursor',
      );
    }
    return PharmacyWardIndentPage(
      items: items,
      hasMore: hasMore,
      nextBeforeRequestedAt: nextRequestedAt,
      nextBeforeId: nextId,
    );
  }

  /// GET /pharmacy-orders/ward-indents/:id — items, owner/SLA projection,
  /// event history, and controlled-handoff recovery evidence.
  static Future<Map<String, dynamic>> getWardIndent(int id) {
    return _get('/pharmacy-orders/ward-indents/$id');
  }

  /// Loads same-facility, catalog-matched stock candidates for one exact ward
  /// indent line, including unreserved FEFO batch capacity.
  static Future<List<Map<String, dynamic>>> getWardIndentInventoryCandidates(
    int indentId,
    int itemId,
  ) async {
    final response = await _get(
      '/pharmacy-orders/ward-indents/$indentId/items/$itemId/'
      'inventory-candidates',
    );
    return _listFrom(response, const ['candidates'])
        .whereType<Map>()
        .map((row) => Map<String, dynamic>.from(row))
        .toList(growable: false);
  }

  /// POST one canonical ward-indent transition. The backend re-authorizes the
  /// actor, requires this intent key, and rejects a stale [expectedVersion].
  static Future<Map<String, dynamic>> mutateWardIndent(
    int id, {
    required String actionPath,
    required int expectedVersion,
    Map<String, dynamic> payload = const {},
    required String idempotencyKey,
  }) {
    return _post('/pharmacy-orders/ward-indents/$id/$actionPath', {
      ...payload,
      'expected_version': expectedVersion,
    }, idempotencyKey: idempotencyKey);
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
    String? witnessApprovalId,
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
      'witness_approval_id': ?witnessApprovalId,
    });
  }

  /// POST /pharmacy-orders/dispense-substitution/witness-approvals
  ///
  /// Creates a short-lived pending witness approval bound to the authenticated
  /// dispenser and the exact prospective Schedule X / narcotic substitution
  /// payload. The payload must be byte-identical to the eventual dispense body
  /// (minus witness_approval_id) or consumption fails closed.
  static Future<Map<String, dynamic>> requestSubstitutionWitnessApproval({
    required Map<String, dynamic> substitution,
    required String idempotencyKey,
  }) async {
    return _post(
      '/pharmacy-orders/dispense-substitution/witness-approvals',
      substitution,
      idempotencyKey: idempotencyKey,
    );
  }

  /// Authenticates the second staff member without replacing the dispenser's
  /// session, then approves the same substitution payload that was requested.
  static Future<Map<String, dynamic>> approveSubstitutionWitnessApproval({
    required String approvalId,
    required Map<String, dynamic> substitution,
    required String employeeId,
    required String password,
    required String idempotencyKey,
  }) async {
    return _post(
      '/pharmacy-orders/dispense-substitution/witness-approvals/$approvalId/approve',
      {
        'substitution': substitution,
        'employeeId': employeeId.trim().toUpperCase(),
        'password': password,
      },
      idempotencyKey: idempotencyKey,
    );
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
  static Future<Map<String, dynamic>> requestCounterSaleWitnessApproval({
    required Map<String, dynamic> sale,
    required String idempotencyKey,
  }) async {
    return _post(
      '/pharmacy-orders/counter-sales/witness-approvals',
      sale,
      idempotencyKey: idempotencyKey,
    );
  }

  /// Authenticates the second staff member without replacing the seller's
  /// session, then approves the same sale payload that was requested.
  static Future<Map<String, dynamic>> approveCounterSaleWitnessApproval({
    required String approvalId,
    required Map<String, dynamic> sale,
    required String employeeId,
    required String password,
    required String idempotencyKey,
  }) async {
    return _post(
      '/pharmacy-orders/counter-sales/witness-approvals/$approvalId/approve',
      {
        'sale': sale,
        'employeeId': employeeId.trim().toUpperCase(),
        'password': password,
      },
      idempotencyKey: idempotencyKey,
    );
  }

  static Future<Map<String, dynamic>> createCounterSale({
    required List<Map<String, dynamic>> lines,
    String? patientUid,
    String? customerName,
    String? customerPhone,
    Map<String, dynamic>? rx,
    String? witnessApprovalId,
    required String paymentMode,
    String? paymentReference,
    String? notes,
    required String idempotencyKey,
  }) async {
    return _post('/pharmacy-orders/counter-sales', {
      'lines': lines,
      'patient_uid': ?patientUid,
      'customer_name': ?customerName,
      'customer_phone': ?customerPhone,
      'rx': ?rx,
      'witness_approval_id': ?witnessApprovalId,
      'payment_mode': paymentMode,
      if (paymentReference != null)
        'payment_reference': paymentReference.trim(),
      'notes': ?notes,
    }, idempotencyKey: idempotencyKey);
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

  /// GET /pharmacy-orders/counter-sales/:id — authoritative sale, refund and
  /// void-reconciliation state after a money/stock mutation.
  static Future<Map<String, dynamic>> getCounterSale(String id) {
    return _get('/pharmacy-orders/counter-sales/${id.trim()}');
  }

  /// POST /pharmacy-orders/counter-sales/:id/void — requests a same-day void.
  /// Billing approval and payout remain independent; exact per-batch restock
  /// follows only after paid-refund evidence is reconciled.
  static Future<Map<String, dynamic>> voidCounterSale(
    String id,
    String reason, {
    required String disposition,
    required String idempotencyKey,
  }) async {
    return _post('/pharmacy-orders/counter-sales/$id/void', {
      'reason': reason.trim(),
      'disposition': disposition.trim().toUpperCase(),
    }, idempotencyKey: idempotencyKey);
  }

  /// GET /pharmacy-orders/counter-sales/:id/void-status — authoritative
  /// finance, payout and exact-restock reconciliation state.
  static Future<Map<String, dynamic>> getCounterSaleVoidStatus(String id) {
    return _get('/pharmacy-orders/counter-sales/${id.trim()}/void-status');
  }

  /// POST /pharmacy-orders/counter-sales/:id/void/reconcile — rechecks the
  /// exact refund evidence and closes the sale/restock only when it is paid.
  static Future<Map<String, dynamic>> reconcileCounterSaleVoid(
    String id, {
    required String idempotencyKey,
  }) {
    return _post(
      '/pharmacy-orders/counter-sales/${id.trim()}/void/reconcile',
      const {},
      idempotencyKey: idempotencyKey,
    );
  }

  /// POST /pharmacy-orders/counter-sales/:id/void/rejection/resolve — records
  /// that medication was handed over after finance rejected the refund. This
  /// cancels the void obligation without refunding or returning stock.
  static Future<Map<String, dynamic>> resolveRejectedCounterSaleVoid(
    String id, {
    required String reason,
    required String idempotencyKey,
  }) {
    return _post(
      '/pharmacy-orders/counter-sales/${id.trim()}/void/rejection/resolve',
      {'resolution': 'CUSTOMER_HANDOVER_CONFIRMED', 'reason': reason.trim()},
      idempotencyKey: idempotencyKey,
    );
  }
}
