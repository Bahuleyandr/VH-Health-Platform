import '../../../core/models/composition_alternatives.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/services/pharmacy_api_service.dart';
import '../models/ward_indent_models.dart';
import 'ward_indent_role_policy.dart';

class WardIndentInventoryItem {
  const WardIndentInventoryItem({
    required this.id,
    required this.displayName,
    required this.isNarcotic,
    this.catalogId,
    this.facilityId,
    this.compositionId,
    this.scheduleClass,
    this.unitLabel,
    this.unreservedQuantity = 0,
    this.batches = const [],
  });

  final int id;
  final int? catalogId;
  final int? facilityId;
  final int? compositionId;
  final String displayName;
  final String? scheduleClass;
  final String? unitLabel;
  final bool isNarcotic;
  final double unreservedQuantity;
  final List<WardIndentInventoryBatch> batches;

  bool get isControlled =>
      const {'H', 'H1', 'X'}.contains(scheduleClass) || isNarcotic;
  bool get requiresWitness => scheduleClass == 'X' || isNarcotic;

  factory WardIndentInventoryItem.fromJson(Map<String, dynamic> json) {
    return WardIndentInventoryItem(
      id: _int(json['id']) ?? 0,
      catalogId: _int(json['catalog_id']),
      facilityId: _int(json['facility_id']),
      compositionId: _int(json['composition_id']),
      displayName:
          _string(json['display_name']) ??
          _string(json['generic_name']) ??
          'Inventory item #${_int(json['id']) ?? 0}',
      scheduleClass: _string(json['schedule_class'])?.toUpperCase(),
      unitLabel: _string(json['unit_label']),
      isNarcotic: json['is_narcotic'] == true,
      unreservedQuantity: _double(json['unreserved_quantity']),
      batches: _maps(json['batches'])
          .map(WardIndentInventoryBatch.fromJson)
          .toList(growable: false),
    );
  }
}

class WardIndentInventoryBatch {
  const WardIndentInventoryBatch({
    required this.id,
    required this.inventoryItemId,
    required this.batchNumber,
    required this.remainingQuantity,
    this.unreservedQuantity = 0,
    this.lotNumber,
    this.status,
    this.expiryDate,
  });

  final int id;
  final int inventoryItemId;
  final String batchNumber;
  final double remainingQuantity;
  final double unreservedQuantity;
  final String? lotNumber;
  final String? status;
  final DateTime? expiryDate;

  factory WardIndentInventoryBatch.fromJson(Map<String, dynamic> json) {
    return WardIndentInventoryBatch(
      id: _int(json['id']) ?? 0,
      inventoryItemId: _int(json['inventory_item_id']) ?? 0,
      batchNumber:
          _string(json['batch_number']) ??
          _string(json['lot_number']) ??
          'Batch #${_int(json['id']) ?? 0}',
      remainingQuantity: _double(json['remaining_quantity']),
      unreservedQuantity:
          _nullableDouble(json['unreserved_quantity']) ??
          _double(json['remaining_quantity']),
      lotNumber: _string(json['lot_number']),
      status: _string(json['status']),
      expiryDate: DateTime.tryParse(json['expiry_date']?.toString() ?? ''),
    );
  }
}

class WardIndentPage {
  const WardIndentPage({
    required this.items,
    required this.hasMore,
    this.nextBeforeRequestedAt,
    this.nextBeforeId,
  });

  final List<WardIndent> items;
  final bool hasMore;
  final DateTime? nextBeforeRequestedAt;
  final int? nextBeforeId;
}

abstract interface class WardIndentGateway {
  Future<WardIndentPage> listIndents({
    bool overdueOnly = false,
    String? worklist,
    DateTime? beforeRequestedAt,
    int? beforeId,
    int limit = 100,
  });

  Future<WardIndent> getIndent(int id);

  Future<WardIndent> mutateIndent(
    WardIndent indent,
    WardIndentAction action, {
    required Map<String, dynamic> payload,
    required String idempotencyKey,
  });

  Future<List<WardIndentInventoryItem>> listInventoryItems({int? catalogId});

  Future<List<WardIndentInventoryBatch>> listInventoryBatches(int itemId);

  Future<List<WardIndentInventoryItem>> listInventoryCandidates(
    int indentId,
    int itemId,
  );

  Future<CompositionAlternativesResult> getCatalogAlternatives(int catalogId);

  Future<Map<String, dynamic>> requestWardControlledWitnessApproval({
    required int indentId,
    required int itemId,
    required Object allocationId,
    required String idempotencyKey,
  });

  Future<Map<String, dynamic>> approveWardControlledWitnessApproval({
    required int indentId,
    required String approvalId,
    required int itemId,
    required Object allocationId,
    required String employeeId,
    required String password,
    required String idempotencyKey,
  });

}

class ApiWardIndentGateway implements WardIndentGateway {
  const ApiWardIndentGateway();

  @override
  Future<WardIndentPage> listIndents({
    bool overdueOnly = false,
    String? worklist,
    DateTime? beforeRequestedAt,
    int? beforeId,
    int limit = 100,
  }) async {
    final page = await PharmacyApiService.listWardIndentPage(
      overdueOnly: overdueOnly,
      worklist: worklist,
      beforeRequestedAt: beforeRequestedAt,
      beforeId: beforeId,
      limit: limit,
    );
    return WardIndentPage(
      items: page.items.map(WardIndent.fromJson).toList(growable: false),
      hasMore: page.hasMore,
      nextBeforeRequestedAt: page.nextBeforeRequestedAt,
      nextBeforeId: page.nextBeforeId,
    );
  }

  @override
  Future<WardIndent> getIndent(int id) async {
    return WardIndent.fromJson(await PharmacyApiService.getWardIndent(id));
  }

  @override
  Future<WardIndent> mutateIndent(
    WardIndent indent,
    WardIndentAction action, {
    required Map<String, dynamic> payload,
    required String idempotencyKey,
  }) async {
    final result = await PharmacyApiService.mutateWardIndent(
      indent.id,
      actionPath: action.apiPath,
      expectedVersion: indent.stateVersion,
      payload: payload,
      idempotencyKey: idempotencyKey,
    );
    return WardIndent.fromJson(result);
  }

  @override
  Future<List<WardIndentInventoryItem>> listInventoryItems({
    int? catalogId,
  }) async {
    final rows = await PharmacyApiService.getInventoryItems(
      status: 'active',
      catalogId: catalogId,
    );
    return rows.map(WardIndentInventoryItem.fromJson).toList(growable: false);
  }

  @override
  Future<List<WardIndentInventoryBatch>> listInventoryBatches(
    int itemId,
  ) async {
    final rows = await PharmacyApiService.getInventoryBatches(itemId: itemId);
    return rows.map(WardIndentInventoryBatch.fromJson).toList(growable: false);
  }

  @override
  Future<List<WardIndentInventoryItem>> listInventoryCandidates(
    int indentId,
    int itemId,
  ) async {
    final rows = await PharmacyApiService.getWardIndentInventoryCandidates(
      indentId,
      itemId,
    );
    return rows.map(WardIndentInventoryItem.fromJson).toList(growable: false);
  }

  @override
  Future<CompositionAlternativesResult> getCatalogAlternatives(int catalogId) {
    return MedicalApiService.getCatalogAlternatives(catalogId);
  }

  @override
  Future<Map<String, dynamic>> requestWardControlledWitnessApproval({
    required int indentId,
    required int itemId,
    required Object allocationId,
    required String idempotencyKey,
  }) {
    return PharmacyApiService.requestWardControlledWitnessApproval(
      indentId: indentId,
      itemId: itemId,
      allocationId: allocationId,
      idempotencyKey: idempotencyKey,
    );
  }

  @override
  Future<Map<String, dynamic>> approveWardControlledWitnessApproval({
    required int indentId,
    required String approvalId,
    required int itemId,
    required Object allocationId,
    required String employeeId,
    required String password,
    required String idempotencyKey,
  }) {
    return PharmacyApiService.approveWardControlledWitnessApproval(
      indentId: indentId,
      approvalId: approvalId,
      itemId: itemId,
      allocationId: allocationId,
      employeeId: employeeId,
      password: password,
      idempotencyKey: idempotencyKey,
    );
  }

}

int? _int(Object? value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '');
}

double _double(Object? value) {
  if (value is num) return value.toDouble();
  return double.tryParse(value?.toString() ?? '') ?? 0;
}

double? _nullableDouble(Object? value) {
  if (value is num) return value.toDouble();
  return double.tryParse(value?.toString() ?? '');
}

String? _string(Object? value) {
  final text = value?.toString().trim() ?? '';
  return text.isEmpty || text.toLowerCase() == 'null' ? null : text;
}

List<Map<String, dynamic>> _maps(Object? value) => value is List
    ? value
          .whereType<Map>()
          .map((entry) => Map<String, dynamic>.from(entry))
          .toList(growable: false)
    : const [];
