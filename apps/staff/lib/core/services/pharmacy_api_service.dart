import 'package:vhhealth_core/services/idempotency_key.dart';

import 'api_client.dart';

class PharmacyApiException implements Exception {
  const PharmacyApiException({
    required this.statusCode,
    required this.message,
    this.code,
    this.details,
  });

  final int statusCode;
  final String? code;
  final String message;
  final Map<String, dynamic>? details;

  @override
  String toString() => code == null ? message : '$message ($code)';
}

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

  static final Map<int, IdempotencyAttempt> _verificationAttempts = {};
  static final Map<int, IdempotencyAttempt> _counterDispenseAttempts = {};
  static final Map<int, IdempotencyAttempt> _facilityAssignmentAttempts = {};
  static final Map<int, IdempotencyAttempt> _lineIdentityAttempts = {};
  static final Map<String, IdempotencyAttempt> _orderMutationAttempts = {};

  // ─── Helpers ──────────────────────────────────────────────────────────────

  static Future<Map<String, dynamic>> _get(
    String path, {
    Map<String, String>? query,
  }) async {
    final resp = await ApiClient.get(path, queryParameters: query);
    _throwTypedError(resp);
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

  static Future<Map<String, dynamic>> _postWithTypedError(
    String path,
    Map<String, dynamic> body, {
    String? idempotencyKey,
  }) async {
    final resp = await ApiClient.post(
      path,
      body: body,
      idempotencyKey: idempotencyKey,
    );
    _throwTypedError(resp);
    return _handle(resp);
  }

  static void _throwTypedError(ApiResponse resp) {
    if (resp.isSuccess) return;
    final raw = resp.raw is Map
        ? Map<String, dynamic>.from(resp.raw as Map)
        : const <String, dynamic>{};
    final details = raw['details'] is Map
        ? Map<String, dynamic>.from(raw['details'] as Map)
        : const <String, dynamic>{};
    throw PharmacyApiException(
      statusCode: resp.statusCode,
      code: resp.code ?? raw['code']?.toString() ?? details['code']?.toString(),
      message: resp.message ?? raw['message']?.toString() ?? 'Request failed',
      details: details.isEmpty ? null : details,
    );
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

  static int _requireCounterSaleFacility(Object? value) {
    final facilityId = value is num
        ? value.toInt()
        : int.tryParse(value?.toString().trim() ?? '');
    if (facilityId == null || facilityId <= 0) {
      throw ArgumentError.value(
        value,
        'facilityId',
        'A positive dispensing facility ID is required',
      );
    }
    return facilityId;
  }

  static Future<Map<String, dynamic>> _idempotentOrderMutation(
    int id,
    String action,
    Map<String, dynamic> body,
  ) async {
    final scope = '$action:$id';
    final attempt = _orderMutationAttempts.putIfAbsent(
      scope,
      () => IdempotencyAttempt('pharmacy-order-$action-$id'),
    );
    try {
      final result = await _postWithTypedError(
        '/pharmacy-orders/orders/$id/$action',
        body,
        idempotencyKey: attempt.keyFor(body),
      );
      attempt.reset();
      _orderMutationAttempts.remove(scope);
      return result;
    } on PharmacyApiException catch (error) {
      if (error.statusCode >= 400 && error.statusCode < 500) {
        attempt.reset();
        _orderMutationAttempts.remove(scope);
      }
      rethrow;
    }
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
    int? facilityId,
  }) async {
    final resp = await _get(
      '/pharmacy/inventory/v2/items',
      query: {
        if (search != null && search.trim().isNotEmpty) 'q': search.trim(),
        if (schedule != null && schedule.trim().isNotEmpty)
          'schedule': schedule.trim(),
        if (status != null && status.trim().isNotEmpty) 'status': status.trim(),
        if (catalogId != null) 'catalog_id': '$catalogId',
        if (facilityId != null) 'facility_id': '$facilityId',
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
    int? facilityId,
    String status = 'in_stock',
  }) async {
    final resp = await _get(
      '/pharmacy/inventory/v2/batches',
      query: {
        'item_id': '$itemId',
        'status': status,
        if (facilityId != null) 'facility_id': '$facilityId',
      },
    );
    return _listFrom(resp, const [
      'batches',
      'items',
    ]).whereType<Map>().map((row) => Map<String, dynamic>.from(row)).toList();
  }

  /// Starts the independently authenticated witness ceremony for one exact
  /// Schedule X or narcotic pharmacy-order allocation. The backend derives
  /// the patient, prescription, facility and catalog authority from [orderId].
  static Future<Map<String, dynamic>> requestOrderControlledWitnessApproval({
    required int orderId,
    required Map<String, dynamic> selection,
    required String idempotencyKey,
  }) async {
    return _postWithTypedError(
      '/pharmacy-orders/orders/$orderId/'
      'controlled-dispense/witness-approvals',
      selection,
      idempotencyKey: idempotencyKey,
    );
  }

  /// Creates one immutable, typed disposal for an exact Inventory V2 batch.
  /// Facility custody is selected only from the actor's server-proved grants;
  /// the backend derives and revalidates the grant, supplier, catalogue,
  /// storage, performer, movement and statutory-register authority.
  static Future<Map<String, dynamic>> disposeInventoryBatch({
    required Map<String, dynamic> disposal,
    required String idempotencyKey,
  }) async {
    return _postWithTypedError(
      '/pharmacy/inventory/v2/disposals',
      disposal,
      idempotencyKey: idempotencyKey,
    );
  }

  /// Starts the independent witness ceremony required only for Schedule X or
  /// narcotic disposal. The request is bound to the exact unchanged intent.
  static Future<Map<String, dynamic>> requestInventoryDisposalWitnessApproval({
    required Map<String, dynamic> disposal,
    required String idempotencyKey,
  }) async {
    return _postWithTypedError(
      '/pharmacy/inventory/v2/disposals/witness-approvals',
      disposal,
      idempotencyKey: idempotencyKey,
    );
  }

  /// Authenticates an independent staff witness without replacing the current
  /// disposal operator's session, then approves the unchanged disposal intent.
  static Future<Map<String, dynamic>> approveInventoryDisposalWitnessApproval({
    required String approvalId,
    required Map<String, dynamic> disposal,
    required String employeeId,
    required String password,
    required String idempotencyKey,
  }) async {
    return _postWithTypedError(
      '/pharmacy/inventory/v2/disposals/witness-approvals/$approvalId/approve',
      {
        'disposal': disposal,
        'employeeId': employeeId.trim().toUpperCase(),
        'password': password,
      },
      idempotencyKey: idempotencyKey,
    );
  }

  /// Authenticates a second staff member without replacing the dispenser's
  /// session, then approves the unchanged server-derived order allocation.
  static Future<Map<String, dynamic>> approveOrderControlledWitnessApproval({
    required int orderId,
    required String approvalId,
    required Map<String, dynamic> selection,
    required String employeeId,
    required String password,
    required String idempotencyKey,
  }) async {
    return _postWithTypedError(
      '/pharmacy-orders/orders/$orderId/'
      'controlled-dispense/witness-approvals/$approvalId/approve',
      {
        'selection': selection,
        'employeeId': employeeId.trim().toUpperCase(),
        'password': password,
      },
      idempotencyKey: idempotencyKey,
    );
  }

  static Future<Map<String, dynamic>> requestWardControlledWitnessApproval({
    required int indentId,
    required int itemId,
    required Object allocationId,
    required String idempotencyKey,
  }) async {
    return _postWithTypedError(
      '/pharmacy-orders/ward-indents/$indentId/'
      'controlled-handoff/witness-approvals',
      {'item_id': itemId, 'allocation_id': '$allocationId'},
      idempotencyKey: idempotencyKey,
    );
  }

  static Future<Map<String, dynamic>> approveWardControlledWitnessApproval({
    required int indentId,
    required String approvalId,
    required int itemId,
    required Object allocationId,
    required String employeeId,
    required String password,
    required String idempotencyKey,
  }) async {
    return _postWithTypedError(
      '/pharmacy-orders/ward-indents/$indentId/'
      'controlled-handoff/witness-approvals/$approvalId/approve',
      {
        'item_id': itemId,
        'allocation_id': '$allocationId',
        'employeeId': employeeId.trim().toUpperCase(),
        'password': password,
      },
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
    int? facilityId,
  }) async {
    final resp = await _get(
      '/pharmacy/inventory/v2/expiry-alerts',
      query: {
        if (bucket != null && bucket.trim().isNotEmpty) 'bucket': bucket.trim(),
        if (facilityId != null) 'facility_id': '$facilityId',
      },
    );
    return _listFrom(resp, const [
      'alerts',
      'expiry_alerts',
      'items',
    ]).whereType<Map>().map((row) => Map<String, dynamic>.from(row)).toList();
  }

  /// POST /pharmacy/inventory/v2/run-expiry-scan.
  static Future<Map<String, dynamic>> runExpiryScan({int? facilityId}) async {
    return _post('/pharmacy/inventory/v2/run-expiry-scan', {
      'facility_id': ?facilityId,
    });
  }

  // ─── Pharmacy Orders ──────────────────────────────────────────────────────

  /// GET /pharmacy-orders/orders/queue — pharmacy order queue
  static Future<List<dynamic>> getPharmacyOrderQueue({String? status}) async {
    final resp = await _get(
      '/pharmacy-orders/orders/queue',
      query: {'status': ?status},
    );
    return _listFrom(resp, const ['orders', 'queue']);
  }

  // ─── Ward-to-pharmacy indents ───────────────────────────────────────────

  /// POST /pharmacy-orders/ward-indents — creates the authoritative request
  /// with its admission/patient/encounter linkage and one stable command key.
  static Future<Map<String, dynamic>> createWardIndent({
    int? wardId,
    int? admissionId,
    String? encounterId,
    String? patientUid,
    String indentType = 'pharmacy',
    required List<Map<String, dynamic>> items,
    String? notes,
    required String idempotencyKey,
  }) {
    return _postWithTypedError('/pharmacy-orders/ward-indents', {
      'ward_id': ?wardId,
      'admission_id': ?admissionId,
      'encounter_id': ?encounterId,
      'patient_uid': ?patientUid,
      'indent_type': indentType,
      'items': items.map((item) => Map<String, dynamic>.from(item)).toList(),
      'notes': ?notes,
    }, idempotencyKey: idempotencyKey);
  }

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
    return _idempotentOrderMutation(
      id,
      'confirm',
      Map<String, dynamic>.from(data),
    );
  }

  /// POST /pharmacy-orders/orders/:id/verify
  static Future<Map<String, dynamic>> verifyPharmacyOrder(
    int id, {
    String decision = 'verified',
    String? notes,
    String? overrideReason,
    bool manualAllergyReviewCompleted = false,
  }) async {
    final normalizedDecision = decision.trim().toLowerCase();
    if (!const {
      'verified',
      'override',
      'rejected',
    }.contains(normalizedDecision)) {
      throw ArgumentError.value(
        decision,
        'decision',
        'must be verified, override, or rejected',
      );
    }
    final normalizedNotes = notes?.trim();
    final normalizedOverrideReason = overrideReason?.trim();
    if (normalizedDecision == 'override' &&
        (normalizedOverrideReason == null ||
            normalizedOverrideReason.length < 10 ||
            normalizedOverrideReason.length > 1000)) {
      throw ArgumentError.value(
        overrideReason,
        'overrideReason',
        'must contain 10 to 1000 characters for an override',
      );
    }
    if (normalizedDecision == 'override' && !manualAllergyReviewCompleted) {
      throw ArgumentError.value(
        manualAllergyReviewCompleted,
        'manualAllergyReviewCompleted',
        'must be true for an override',
      );
    }
    if (normalizedDecision == 'rejected' &&
        (normalizedNotes == null ||
            normalizedNotes.length < 10 ||
            normalizedNotes.length > 500)) {
      throw ArgumentError.value(
        notes,
        'notes',
        'must contain 10 to 500 characters for a rejection',
      );
    }
    final body = <String, dynamic>{
      'decision': normalizedDecision,
      if (normalizedNotes != null && normalizedNotes.isNotEmpty)
        'notes': normalizedNotes,
      if (normalizedOverrideReason != null &&
          normalizedOverrideReason.isNotEmpty)
        'override_reason': normalizedOverrideReason,
      if (manualAllergyReviewCompleted) 'manual_allergy_review_completed': true,
    };
    final attempt = _verificationAttempts.putIfAbsent(
      id,
      () => IdempotencyAttempt('pharmacy-order-verify-$id'),
    );
    try {
      final result = await _postWithTypedError(
        '/pharmacy-orders/orders/$id/verify',
        body,
        idempotencyKey: attempt.keyFor(body),
      );
      attempt.reset();
      _verificationAttempts.remove(id);
      return result;
    } on PharmacyApiException catch (error) {
      if (error.statusCode >= 400 && error.statusCode < 500) {
        attempt.reset();
        _verificationAttempts.remove(id);
      }
      rethrow;
    }
  }

  /// POST /pharmacy-orders/orders/:id/preparing
  static Future<Map<String, dynamic>> markPharmacyPreparing(int id) async {
    return _idempotentOrderMutation(id, 'preparing', const {});
  }

  /// POST /pharmacy-orders/orders/:id/dispatch
  static Future<Map<String, dynamic>> dispatchPharmacyOrder(
    int id,
    Map<String, dynamic> data,
  ) async {
    final body = Map<String, dynamic>.from(data);
    if (body.containsKey('delivery_person') ||
        body.containsKey('delivery_person_phone')) {
      throw ArgumentError(
        'Delivery identity must use delivery_assignee_uid, not free text',
      );
    }
    final assigneeUid = body['delivery_assignee_uid']?.toString().trim() ?? '';
    if (!RegExp(
      r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
    ).hasMatch(assigneeUid)) {
      throw ArgumentError.value(
        body['delivery_assignee_uid'],
        'delivery_assignee_uid',
        'must be a canonical courier UID',
      );
    }
    body['delivery_assignee_uid'] = assigneeUid;
    return _idempotentOrderMutation(id, 'dispatch', body);
  }

  /// GET /pharmacy-orders/orders/:id/delivery-assignees
  static Future<List<Map<String, dynamic>>> getPharmacyDeliveryAssignees(
    int id,
  ) async {
    final response = await _get(
      '/pharmacy-orders/orders/$id/delivery-assignees',
    );
    return _listFrom(response, const ['delivery_assignees'])
        .whereType<Map>()
        .map((row) => Map<String, dynamic>.from(row))
        .toList(growable: false);
  }

  /// GET /pharmacy-orders/orders/assigned — exact active-facility courier
  /// custody only; the server derives the assignee from the authenticated UID.
  static Future<List<Map<String, dynamic>>>
  getAssignedPharmacyDeliveries() async {
    final response = await _get('/pharmacy-orders/orders/assigned');
    return _listFrom(response, const ['deliveries'])
        .whereType<Map>()
        .map((row) => Map<String, dynamic>.from(row))
        .toList(growable: false);
  }

  static Future<Map<String, dynamic>> updatePharmacyDeliveryLocation(
    int id, {
    required double latitude,
    required double longitude,
    double? accuracy,
  }) {
    return _postWithTypedError('/delivery/location-update', {
      'order_type': 'pharmacy',
      'order_id': id,
      'lat': latitude,
      'lng': longitude,
      if (accuracy != null) 'accuracy': accuracy,
    });
  }

  static Future<Map<String, dynamic>> stopPharmacyDeliveryTracking(int id) {
    return _postWithTypedError('/delivery/stop-tracking', {
      'order_type': 'pharmacy',
      'order_id': id,
    });
  }

  /// Assigned courier consumes the patient one-time token. Pharmacy in-charge
  /// use is an explicitly reasoned break-glass completion.
  static Future<Map<String, dynamic>> completePharmacyDelivery(
    int id, {
    required String handoffToken,
    String? breakGlassReason,
  }) async {
    final token = handoffToken.trim();
    if (token.length < 20 || token.length > 200) {
      throw ArgumentError.value(
        handoffToken,
        'handoffToken',
        'must contain 20 to 200 characters',
      );
    }
    final reason = breakGlassReason?.trim();
    if (reason != null && (reason.length < 10 || reason.length > 500)) {
      throw ArgumentError.value(
        breakGlassReason,
        'breakGlassReason',
        'must contain 10 to 500 characters',
      );
    }
    return _idempotentOrderMutation(id, 'delivered', {
      'handoff_token': token,
      if (reason != null) 'break_glass_reason': reason,
    });
  }

  static Future<Map<String, dynamic>> reissuePharmacyDeliveryHandoff(
    int id, {
    required String reason,
    String? deliveryAssigneeUid,
  }) {
    final normalizedReason = reason.trim();
    if (normalizedReason.length < 10 || normalizedReason.length > 500) {
      throw ArgumentError.value(
        reason,
        'reason',
        'must contain 10 to 500 characters',
      );
    }
    return _idempotentOrderMutation(id, 'delivery-handoff/reissue', {
      'reason': normalizedReason,
      if (deliveryAssigneeUid != null)
        'delivery_assignee_uid': deliveryAssigneeUid.trim(),
    });
  }

  static Future<Map<String, dynamic>> requestPharmacyDeliveryReturn(
    int id, {
    required String reason,
  }) {
    final normalizedReason = reason.trim();
    if (normalizedReason.length < 10 || normalizedReason.length > 500) {
      throw ArgumentError.value(
        reason,
        'reason',
        'must contain 10 to 500 characters',
      );
    }
    return _idempotentOrderMutation(id, 'delivery-return/request', {
      'reason': normalizedReason,
    });
  }

  static Future<Map<String, dynamic>> completePharmacyDeliveryReturn(
    int id, {
    required String disposition,
    required String reason,
  }) {
    final normalizedDisposition = disposition.trim().toLowerCase();
    if (!const {'returned', 'quarantined'}.contains(normalizedDisposition)) {
      throw ArgumentError.value(
        disposition,
        'disposition',
        'must be returned or quarantined',
      );
    }
    final normalizedReason = reason.trim();
    if (normalizedReason.length < 10 || normalizedReason.length > 500) {
      throw ArgumentError.value(
        reason,
        'reason',
        'must contain 10 to 500 characters',
      );
    }
    return _idempotentOrderMutation(id, 'delivery-return/complete', {
      'disposition': normalizedDisposition,
      'reason': normalizedReason,
    });
  }

  /// POST /pharmacy-orders/orders/:id/dispense-counter
  /// [data.amount_collected] is the cumulative collected amount for the
  /// cumulative authoritative dispense total.
  static Future<Map<String, dynamic>> markPharmacyCounterDispensed(
    int id,
    Map<String, dynamic> data,
  ) async {
    final body = Map<String, dynamic>.from(data);
    final paymentMode = body['payment_mode']?.toString().trim().toLowerCase();
    final amountCollected = body['amount_collected'];
    if (paymentMode == null ||
        !const {
          'cash',
          'card',
          'upi',
          'wallet',
          'insurance',
          'corporate_tpa',
          'none',
        }.contains(paymentMode)) {
      throw ArgumentError.value(
        body['payment_mode'],
        'payment_mode',
        'is not supported',
      );
    }
    if (amountCollected is! num ||
        !amountCollected.isFinite ||
        amountCollected < 0) {
      throw ArgumentError.value(
        amountCollected,
        'amount_collected',
        'must be a finite non-negative number',
      );
    }
    final tpaReference = body['tpa_reference']?.toString().trim() ?? '';
    if (const {'insurance', 'corporate_tpa'}.contains(paymentMode) &&
        tpaReference.isEmpty) {
      throw ArgumentError.value(
        body['tpa_reference'],
        'tpa_reference',
        'is required for insurance or corporate TPA funding',
      );
    }
    if (tpaReference.length > 160) {
      throw ArgumentError.value(
        body['tpa_reference'],
        'tpa_reference',
        'must contain at most 160 characters',
      );
    }
    body['payment_mode'] = paymentMode;
    if (tpaReference.isNotEmpty) body['tpa_reference'] = tpaReference;
    final attempt = _counterDispenseAttempts.putIfAbsent(
      id,
      () => IdempotencyAttempt('pharmacy-order-counter-dispense-$id'),
    );
    try {
      final result = await _postWithTypedError(
        '/pharmacy-orders/orders/$id/dispense-counter',
        body,
        idempotencyKey: attempt.keyFor(body),
      );
      attempt.reset();
      _counterDispenseAttempts.remove(id);
      return result;
    } on PharmacyApiException catch (error) {
      if (error.statusCode >= 400 && error.statusCode < 500) {
        attempt.reset();
        _counterDispenseAttempts.remove(id);
      }
      rethrow;
    }
  }

  /// POST /pharmacy-orders/orders/:id/cancel
  static Future<Map<String, dynamic>> cancelPharmacyOrder(
    int id,
    String reason,
  ) async {
    final normalizedReason = reason.trim();
    if (normalizedReason.length < 3 || normalizedReason.length > 500) {
      throw ArgumentError.value(
        reason,
        'reason',
        'must contain 3 to 500 characters',
      );
    }
    return _idempotentOrderMutation(id, 'cancel', {
      'cancellation_reason': normalizedReason,
    });
  }

  static Future<Map<String, dynamic>> markPharmacyUnavailable(
    int id, {
    required String reason,
  }) {
    final normalizedReason = reason.trim();
    if (normalizedReason.isEmpty || normalizedReason.length > 500) {
      throw ArgumentError.value(
        reason,
        'reason',
        'must contain 1 to 500 characters',
      );
    }
    return _idempotentOrderMutation(id, 'unavailable', {
      'reason': normalizedReason,
    });
  }

  static Future<Map<String, dynamic>> assignPharmacyOrderFacility(
    int id, {
    required int facilityId,
  }) async {
    final body = <String, dynamic>{'facility_id': facilityId};
    final attempt = _facilityAssignmentAttempts.putIfAbsent(
      id,
      () => IdempotencyAttempt('pharmacy-order-assign-facility-$id'),
    );
    try {
      final result = await _postWithTypedError(
        '/pharmacy-orders/orders/$id/assign-facility',
        body,
        idempotencyKey: attempt.keyFor(body),
      );
      attempt.reset();
      _facilityAssignmentAttempts.remove(id);
      return result;
    } on PharmacyApiException catch (error) {
      if (error.statusCode >= 400 && error.statusCode < 500) {
        attempt.reset();
        _facilityAssignmentAttempts.remove(id);
      }
      rethrow;
    }
  }

  static Future<Map<String, dynamic>> resolvePharmacyOrderLineIdentities(
    int id, {
    required List<Map<String, dynamic>> lineMappings,
  }) async {
    final body = <String, dynamic>{
      'line_mappings': lineMappings
          .map((mapping) => Map<String, dynamic>.from(mapping))
          .toList(growable: false),
    };
    final attempt = _lineIdentityAttempts.putIfAbsent(
      id,
      () => IdempotencyAttempt('pharmacy-order-resolve-line-identities-$id'),
    );
    try {
      final result = await _postWithTypedError(
        '/pharmacy-orders/orders/$id/resolve-line-identities',
        body,
        idempotencyKey: attempt.keyFor(body),
      );
      attempt.reset();
      _lineIdentityAttempts.remove(id);
      return result;
    } on PharmacyApiException catch (error) {
      if (error.statusCode >= 400 && error.statusCode < 500) {
        attempt.reset();
        _lineIdentityAttempts.remove(id);
      }
      rethrow;
    }
  }

  /// POST /pharmacy-orders/dispense-substitution
  ///
  /// Pharmacist dispenses an in-stock, same-formulation alternative in place of a
  /// prescribed brand. The backend re-resolves both catalog ids, re-checks equivalence,
  /// decrements the chosen batch, and writes the canonical clinical timeline + audit
  /// pair atomically. The result includes order/prescription linkage, cumulative
  /// fulfilment, immutable billing and batch evidence, and pack-barcode state.
  /// `finalCatalogId` is the chosen alternative (the panel's onSwap item's catalogId);
  /// `originalCatalogId` is the prescribed brand.
  static Future<Map<String, dynamic>> dispenseSubstitution({
    required int orderId,
    required int prescriptionId,
    required int orderLineIndex,
    required int prescriptionLineIndex,
    required String patientUid,
    int? encounterId,
    required int inventoryItemId,
    required int inventoryBatchId,
    required num quantity,
    required int originalCatalogId,
    required int finalCatalogId,
    String? reason,
    String? witnessApprovalId,
    required String paymentMode,
    required num amountCollected,
    String? tpaReference,
    required String idempotencyKey,
  }) async {
    final normalizedPaymentMode = paymentMode.trim().toLowerCase();
    if (!const {
      'cash',
      'card',
      'upi',
      'wallet',
      'insurance',
      'corporate_tpa',
    }.contains(normalizedPaymentMode)) {
      throw ArgumentError.value(paymentMode, 'paymentMode', 'is not supported');
    }
    if (!amountCollected.isFinite || amountCollected < 0) {
      throw ArgumentError.value(
        amountCollected,
        'amountCollected',
        'must be non-negative',
      );
    }
    if (const {'insurance', 'corporate_tpa'}.contains(normalizedPaymentMode) &&
        (tpaReference == null || tpaReference.trim().isEmpty)) {
      throw ArgumentError.value(
        tpaReference,
        'tpaReference',
        'is required for insurance or corporate TPA funding',
      );
    }
    if (tpaReference != null && tpaReference.trim().length > 160) {
      throw ArgumentError.value(
        tpaReference,
        'tpaReference',
        'must contain at most 160 characters',
      );
    }
    return _postWithTypedError('/pharmacy-orders/dispense-substitution', {
      'order_id': orderId,
      'prescription_id': prescriptionId,
      'order_line_index': orderLineIndex,
      'prescription_line_index': prescriptionLineIndex,
      'patient_uid': patientUid,
      'encounter_id': ?encounterId,
      'inventory_item_id': inventoryItemId,
      'inventory_batch_id': inventoryBatchId,
      'quantity': quantity,
      'original_catalog_id': originalCatalogId,
      'final_catalog_id': finalCatalogId,
      'reason': ?reason,
      'witness_approval_id': ?witnessApprovalId,
      'payment_mode': normalizedPaymentMode,
      'amount_collected': amountCollected,
      if (tpaReference != null && tpaReference.trim().isNotEmpty)
        'tpa_reference': tpaReference.trim(),
    }, idempotencyKey: idempotencyKey);
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
    return _postWithTypedError(
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
    return _postWithTypedError(
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
  /// Returns `{ order_id, patient_uid, appointment_id?, admission_id?,
  /// lines:[{prescription_id,catalog_id,name,quantity}] }`.
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

  /// GET /pharmacy-orders/counter-sales/facilities — the authenticated actor's
  /// OWN active pharmacy facility grants, derived server-side from the bearer.
  /// The POS facility picker is fed from this: the client never chooses its own
  /// authority scope, and the server re-proves the grant on every counter call.
  static Future<List<Map<String, dynamic>>> getCounterSaleFacilities() async {
    final resp = await _get('/pharmacy-orders/counter-sales/facilities');
    return _listFrom(resp, const [
      'facilities',
    ]).whereType<Map>().map((row) => Map<String, dynamic>.from(row)).toList();
  }

  /// GET /pharmacy-orders/counter-sales/items — sellable items with usable
  /// stock and the FEFO head batch (number, expiry, MRP unit price).
  static Future<List<Map<String, dynamic>>> getCounterSaleItems({
    required int facilityId,
    String? search,
  }) async {
    final exactFacilityId = _requireCounterSaleFacility(facilityId);
    final resp = await _get(
      '/pharmacy-orders/counter-sales/items',
      query: {
        'facility_id': exactFacilityId.toString(),
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
    _requireCounterSaleFacility(sale['facility_id']);
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
    _requireCounterSaleFacility(sale['facility_id']);
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
    required int facilityId,
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
    final exactFacilityId = _requireCounterSaleFacility(facilityId);
    return _post('/pharmacy-orders/counter-sales', {
      'facility_id': exactFacilityId,
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
