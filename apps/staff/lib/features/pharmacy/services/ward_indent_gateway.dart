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
    this.compositionId,
    this.scheduleClass,
    this.unitLabel,
  });

  final int id;
  final int? catalogId;
  final int? compositionId;
  final String displayName;
  final String? scheduleClass;
  final String? unitLabel;
  final bool isNarcotic;

  bool get isControlled =>
      const {'H', 'H1', 'X'}.contains(scheduleClass) || isNarcotic;
  bool get requiresWitness => scheduleClass == 'X' || isNarcotic;

  factory WardIndentInventoryItem.fromJson(Map<String, dynamic> json) {
    return WardIndentInventoryItem(
      id: _int(json['id']) ?? 0,
      catalogId: _int(json['catalog_id']),
      compositionId: _int(json['composition_id']),
      displayName:
          _string(json['display_name']) ??
          _string(json['generic_name']) ??
          'Inventory item #${_int(json['id']) ?? 0}',
      scheduleClass: _string(json['schedule_class'])?.toUpperCase(),
      unitLabel: _string(json['unit_label']),
      isNarcotic: json['is_narcotic'] == true,
    );
  }
}

class WardIndentInventoryBatch {
  const WardIndentInventoryBatch({
    required this.id,
    required this.inventoryItemId,
    required this.batchNumber,
    required this.remainingQuantity,
    this.expiryDate,
  });

  final int id;
  final int inventoryItemId;
  final String batchNumber;
  final double remainingQuantity;
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

  Future<CompositionAlternativesResult> getCatalogAlternatives(int catalogId);

  Future<Map<String, dynamic>> requestControlledDispenseWitnessApproval({
    required Map<String, dynamic> dispense,
    required String idempotencyKey,
  });

  Future<Map<String, dynamic>> approveControlledDispenseWitnessApproval({
    required String approvalId,
    required Map<String, dynamic> dispense,
    required String employeeId,
    required String password,
    required String idempotencyKey,
  });

  Future<Map<String, dynamic>> dispenseControlledInventory({
    required Map<String, dynamic> dispense,
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
  Future<CompositionAlternativesResult> getCatalogAlternatives(int catalogId) {
    return MedicalApiService.getCatalogAlternatives(catalogId);
  }

  @override
  Future<Map<String, dynamic>> requestControlledDispenseWitnessApproval({
    required Map<String, dynamic> dispense,
    required String idempotencyKey,
  }) {
    return PharmacyApiService.requestControlledDispenseWitnessApproval(
      dispense: dispense,
      idempotencyKey: idempotencyKey,
    );
  }

  @override
  Future<Map<String, dynamic>> approveControlledDispenseWitnessApproval({
    required String approvalId,
    required Map<String, dynamic> dispense,
    required String employeeId,
    required String password,
    required String idempotencyKey,
  }) {
    return PharmacyApiService.approveControlledDispenseWitnessApproval(
      approvalId: approvalId,
      dispense: dispense,
      employeeId: employeeId,
      password: password,
      idempotencyKey: idempotencyKey,
    );
  }

  @override
  Future<Map<String, dynamic>> dispenseControlledInventory({
    required Map<String, dynamic> dispense,
    required String idempotencyKey,
  }) {
    return PharmacyApiService.dispenseControlledInventory(
      dispense: dispense,
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

String? _string(Object? value) {
  final text = value?.toString().trim() ?? '';
  return text.isEmpty || text.toLowerCase() == 'null' ? null : text;
}
