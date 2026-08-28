enum WardIndentStatus {
  requested,
  reserved,
  shortSupply,
  substitutionPending,
  controlledHandoffRequired,
  approved,
  issued,
  partiallyReceived,
  received,
  returnPending,
  reconciliationRequired,
  reconciled,
  rejected,
  cancelled,
  closed,
  unknown,
}

extension WardIndentStatusWire on WardIndentStatus {
  String get wireValue => switch (this) {
    WardIndentStatus.requested => 'requested',
    WardIndentStatus.reserved => 'reserved',
    WardIndentStatus.shortSupply => 'short_supply',
    WardIndentStatus.substitutionPending => 'substitution_pending',
    WardIndentStatus.controlledHandoffRequired => 'controlled_handoff_required',
    WardIndentStatus.approved => 'approved',
    WardIndentStatus.issued => 'issued',
    WardIndentStatus.partiallyReceived => 'partially_received',
    WardIndentStatus.received => 'received',
    WardIndentStatus.returnPending => 'return_pending',
    WardIndentStatus.reconciliationRequired => 'reconciliation_required',
    WardIndentStatus.reconciled => 'reconciled',
    WardIndentStatus.rejected => 'rejected',
    WardIndentStatus.cancelled => 'cancelled',
    WardIndentStatus.closed => 'closed',
    WardIndentStatus.unknown => 'unknown',
  };

  bool get isTerminal => switch (this) {
    WardIndentStatus.rejected ||
    WardIndentStatus.cancelled ||
    WardIndentStatus.closed => true,
    _ => false,
  };
}

class WardIndent {
  const WardIndent({
    required this.id,
    required this.indentNumber,
    required this.status,
    required this.stateVersion,
    required this.ownerRoleCodes,
    required this.items,
    required this.activeSlas,
    required this.events,
    required this.controlledRecovery,
    this.medicationClosure = const WardIndentMedicationClosure.empty(),
    this.patientUid,
    this.encounterId,
    this.admissionId,
    this.wardId,
    this.facilityId,
    this.wardName,
    this.requestedAt,
    this.lastTransitionAt,
    this.notes,
    this.shortSupplyReason,
    this.reconciliationReason,
  });

  final int id;
  final String indentNumber;
  final WardIndentStatus status;
  final int stateVersion;
  final String? patientUid;
  final String? encounterId;
  final int? admissionId;
  final int? wardId;
  final int? facilityId;
  final String? wardName;
  final DateTime? requestedAt;
  final DateTime? lastTransitionAt;
  final String? notes;
  final String? shortSupplyReason;
  final String? reconciliationReason;
  final List<String> ownerRoleCodes;
  final List<WardIndentItem> items;
  final List<WardIndentSla> activeSlas;
  final List<WardIndentEvent> events;
  final List<ControlledHandoffRecovery> controlledRecovery;
  final WardIndentMedicationClosure medicationClosure;

  bool get isTerminal => status.isTerminal;
  bool get isOverdue => activeSlas.any(
    (sla) => const {'breached', 'escalated'}.contains(sla.status),
  );

  double consumedQuantityForItem(int itemId) => medicationClosure.allocations
      .where((allocation) => allocation.wardIndentItemId == itemId)
      .fold(0, (sum, allocation) => sum + allocation.consumedQuantity);

  double returnCeilingForItem(WardIndentItem item) {
    final ceiling = item.quantityReceived - consumedQuantityForItem(item.id);
    return ceiling < item.quantityReturned ? item.quantityReturned : ceiling;
  }

  factory WardIndent.fromJson(Map<String, dynamic> json) {
    final workflow = _map(json['workflow']);
    return WardIndent(
      id: _int(json['id']) ?? 0,
      indentNumber:
          _string(json['indent_number']) ?? '#${_int(json['id']) ?? 0}',
      status: _wardIndentStatus(json['status']),
      stateVersion: _int(json['state_version']) ?? 0,
      patientUid: _string(json['patient_uid']),
      encounterId: _string(json['encounter_id']),
      admissionId: _int(json['admission_id']),
      wardId: _int(json['ward_id']),
      facilityId: _int(json['facility_id']),
      wardName: _string(json['ward_name']),
      requestedAt: _date(json['requested_at'] ?? json['created_at']),
      lastTransitionAt: _date(json['last_transition_at']),
      notes: _string(json['notes']),
      shortSupplyReason: _string(json['short_supply_reason']),
      reconciliationReason: _string(json['reconciliation_reason']),
      ownerRoleCodes: _strings(
        workflow['owner_role_codes'] ?? json['owner_role_codes'],
      ),
      items: _maps(json['items']).map(WardIndentItem.fromJson).toList(),
      activeSlas: _maps(workflow['active_slas'])
          .map(WardIndentSla.fromJson)
          .toList(),
      events: _maps(workflow['events']).map(WardIndentEvent.fromJson).toList(),
      controlledRecovery: _maps(workflow['pending_controlled_handoff_evidence'])
          .map(ControlledHandoffRecovery.fromJson)
          .toList(),
      medicationClosure: WardIndentMedicationClosure.fromJson(
        _map(workflow['medication_closure']),
      ),
    );
  }
}

class WardIndentItem {
  const WardIndentItem({
    required this.id,
    required this.name,
    required this.quantityRequested,
    required this.quantityReserved,
    required this.quantityApproved,
    required this.quantityIssued,
    required this.quantityReceived,
    required this.quantityReturnRequested,
    required this.quantityReturned,
    required this.quantityVarianceResolved,
    this.catalogId,
    this.originalCatalogId,
    this.proposedCatalogId,
    this.proposedName,
    this.proposedQuantity,
    this.substitutionStatus,
    this.substitutionReason,
    this.substitutionAcknowledgedBy,
    this.substitutionAcknowledgedAt,
    this.fulfilmentStatus,
    this.controlledReferenceId,
    this.controlledMovementId,
    this.controlledRegisterId,
    this.reconciliationDisposition,
    this.reconciliationNote,
  });

  final int id;
  final int? catalogId;
  final int? originalCatalogId;
  final int? proposedCatalogId;
  final String name;
  final String? proposedName;
  final double quantityRequested;
  final double quantityReserved;
  final double quantityApproved;
  final double quantityIssued;
  final double quantityReceived;
  final double quantityReturnRequested;
  final double quantityReturned;
  final double quantityVarianceResolved;
  final double? proposedQuantity;
  final String? substitutionStatus;
  final String? substitutionReason;
  final String? substitutionAcknowledgedBy;
  final DateTime? substitutionAcknowledgedAt;
  final String? fulfilmentStatus;
  final String? controlledReferenceId;
  final int? controlledMovementId;
  final int? controlledRegisterId;
  final String? reconciliationDisposition;
  final String? reconciliationNote;

  bool get isControlled => controlledReferenceId != null;
  bool get needsSubstitutionAcknowledgement =>
      substitutionStatus == 'approved' && substitutionAcknowledgedAt == null;
  double get outstandingReceipt => quantityIssued - quantityReceived;
  double get outstandingReturn => quantityReturnRequested - quantityReturned;
  double get unresolvedVariance =>
      quantityIssued - quantityReceived - quantityVarianceResolved;

  factory WardIndentItem.fromJson(Map<String, dynamic> json) {
    return WardIndentItem(
      id: _int(json['id']) ?? 0,
      catalogId: _int(json['pharmacy_catalog_id']),
      originalCatalogId: _int(json['original_pharmacy_catalog_id']),
      proposedCatalogId: _int(json['proposed_pharmacy_catalog_id']),
      name: _string(json['item_name']) ?? 'Item #${_int(json['id']) ?? 0}',
      proposedName: _string(json['proposed_item_name']),
      quantityRequested: _double(json['quantity_requested']),
      quantityReserved: _double(json['quantity_reserved']),
      quantityApproved: _double(json['quantity_approved']),
      quantityIssued: _double(json['quantity_issued']),
      quantityReceived: _double(json['quantity_received']),
      quantityReturnRequested: _double(json['quantity_return_requested']),
      quantityReturned: _double(json['quantity_returned']),
      quantityVarianceResolved: _double(json['quantity_variance_resolved']),
      proposedQuantity: _nullableDouble(json['proposed_quantity']),
      substitutionStatus: _string(json['substitution_status']),
      substitutionReason: _string(json['substitution_reason']),
      substitutionAcknowledgedBy: _string(json['substitution_acknowledged_by']),
      substitutionAcknowledgedAt: _date(json['substitution_acknowledged_at']),
      fulfilmentStatus: _string(json['fulfilment_status']),
      controlledReferenceId: _string(json['controlled_reference_id']),
      controlledMovementId: _int(json['controlled_movement_id']),
      controlledRegisterId: _int(json['controlled_register_id']),
      reconciliationDisposition: _string(json['reconciliation_disposition']),
      reconciliationNote: _string(json['reconciliation_note']),
    );
  }
}

class WardIndentMedicationClosure {
  const WardIndentMedicationClosure({
    required this.allocations,
    required this.movementLineage,
    required this.financialEvents,
  });

  const WardIndentMedicationClosure.empty()
    : allocations = const [],
      movementLineage = const [],
      financialEvents = const [];

  final List<WardIndentInventoryAllocation> allocations;
  final List<Map<String, dynamic>> movementLineage;
  final List<Map<String, dynamic>> financialEvents;

  List<WardIndentInventoryAllocation> allocationsForItem(int itemId) =>
      allocations
          .where((allocation) => allocation.wardIndentItemId == itemId)
          .toList(growable: false);

  factory WardIndentMedicationClosure.fromJson(Map<String, dynamic> json) {
    return WardIndentMedicationClosure(
      allocations: _maps(json['allocations'])
          .map(WardIndentInventoryAllocation.fromJson)
          .toList(growable: false),
      movementLineage: _maps(json['movement_lineage']),
      financialEvents: _maps(json['financial_events']),
    );
  }
}

class WardIndentInventoryAllocation {
  const WardIndentInventoryAllocation({
    required this.id,
    required this.wardIndentId,
    required this.wardIndentItemId,
    required this.inventoryItemId,
    required this.inventoryBatchId,
    required this.status,
    required this.reservedQuantity,
    required this.issuedQuantity,
    required this.receivedQuantity,
    required this.consumedQuantity,
    required this.returnedQuantity,
    required this.custodyAvailableQuantity,
    this.inventoryItemName,
    this.skuCode,
    this.batchNumber,
    this.lotNumber,
    this.expiryDate,
    this.batchStatus,
    this.remainingQuantity,
  });

  final String id;
  final int wardIndentId;
  final int wardIndentItemId;
  final int inventoryItemId;
  final int inventoryBatchId;
  final String status;
  final double reservedQuantity;
  final double issuedQuantity;
  final double receivedQuantity;
  final double consumedQuantity;
  final double returnedQuantity;
  final double custodyAvailableQuantity;
  final String? inventoryItemName;
  final String? skuCode;
  final String? batchNumber;
  final String? lotNumber;
  final DateTime? expiryDate;
  final String? batchStatus;
  final double? remainingQuantity;

  double get issueAvailableQuantity => reservedQuantity - issuedQuantity;
  bool get hasIssueQuantity => issueAvailableQuantity > 0;
  bool get hasCustodyQuantity => custodyAvailableQuantity > 0;

  factory WardIndentInventoryAllocation.fromJson(Map<String, dynamic> json) {
    final received = _double(json['received_quantity']);
    final consumed = _double(json['consumed_quantity']);
    final returned = _double(json['returned_quantity']);
    return WardIndentInventoryAllocation(
      id: _string(json['id']) ?? '0',
      wardIndentId: _int(json['ward_indent_id']) ?? 0,
      wardIndentItemId: _int(json['ward_indent_item_id']) ?? 0,
      inventoryItemId: _int(json['inventory_item_id']) ?? 0,
      inventoryBatchId: _int(json['inventory_batch_id']) ?? 0,
      status: (_string(json['status']) ?? '').toLowerCase(),
      reservedQuantity: _double(json['reserved_quantity']),
      issuedQuantity: _double(json['issued_quantity']),
      receivedQuantity: received,
      consumedQuantity: consumed,
      returnedQuantity: returned,
      custodyAvailableQuantity:
          _nullableDouble(json['custody_available_quantity']) ??
          (received - consumed - returned),
      inventoryItemName: _string(json['inventory_item_name']),
      skuCode: _string(json['sku_code']),
      batchNumber: _string(json['batch_number']),
      lotNumber: _string(json['lot_number']),
      expiryDate: _date(json['expiry_date']),
      batchStatus: _string(json['batch_status']),
      remainingQuantity: _nullableDouble(json['remaining_quantity']),
    );
  }
}

class WardIndentSla {
  const WardIndentSla({
    required this.id,
    required this.status,
    this.ruleCode,
    this.dueAt,
    this.breachedAt,
  });

  final int id;
  final String status;
  final String? ruleCode;
  final DateTime? dueAt;
  final DateTime? breachedAt;

  factory WardIndentSla.fromJson(Map<String, dynamic> json) {
    return WardIndentSla(
      id: _int(json['id']) ?? 0,
      status: (_string(json['status']) ?? '').toLowerCase(),
      ruleCode: _string(json['rule_code']),
      dueAt: _date(json['due_at']),
      breachedAt: _date(json['breached_at']),
    );
  }
}

class WardIndentEvent {
  const WardIndentEvent({
    required this.id,
    required this.action,
    required this.stateVersion,
    required this.toStatus,
    required this.details,
    this.fromStatus,
    this.reason,
    this.occurredAt,
  });

  final int id;
  final String action;
  final int stateVersion;
  final String? fromStatus;
  final String toStatus;
  final String? reason;
  final DateTime? occurredAt;
  final Map<String, dynamic> details;

  factory WardIndentEvent.fromJson(Map<String, dynamic> json) {
    return WardIndentEvent(
      id: _int(json['id']) ?? 0,
      action: _string(json['action']) ?? '',
      stateVersion: _int(json['state_version']) ?? 0,
      fromStatus: _string(json['from_status']),
      toStatus: _string(json['to_status']) ?? '',
      reason: _string(json['reason']),
      occurredAt: _date(json['occurred_at']),
      details: _map(json['details']),
    );
  }
}

class ControlledHandoffRecovery {
  const ControlledHandoffRecovery({
    required this.itemId,
    required this.status,
    required this.candidateCount,
    this.movementId,
    this.registerId,
  });

  final int itemId;
  final String status;
  final int candidateCount;
  final int? movementId;
  final int? registerId;

  bool get isRecoverable =>
      status == 'available' &&
      candidateCount == 1 &&
      movementId != null &&
      registerId != null;

  factory ControlledHandoffRecovery.fromJson(Map<String, dynamic> json) {
    return ControlledHandoffRecovery(
      itemId: _int(json['item_id']) ?? 0,
      status: (_string(json['status']) ?? 'missing').toLowerCase(),
      candidateCount: _int(json['candidate_count']) ?? 0,
      movementId: _int(json['movement_id']),
      registerId: _int(json['register_id']),
    );
  }
}

WardIndentStatus _wardIndentStatus(Object? value) {
  final wire = value?.toString().trim().toLowerCase();
  return WardIndentStatus.values.firstWhere(
    (status) => status != WardIndentStatus.unknown && status.wireValue == wire,
    orElse: () => WardIndentStatus.unknown,
  );
}

int? _int(Object? value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '');
}

double _double(Object? value) => _nullableDouble(value) ?? 0;

double? _nullableDouble(Object? value) {
  if (value is num) return value.toDouble();
  return double.tryParse(value?.toString() ?? '');
}

String? _string(Object? value) {
  final text = value?.toString().trim() ?? '';
  return text.isEmpty || text.toLowerCase() == 'null' ? null : text;
}

DateTime? _date(Object? value) => DateTime.tryParse(value?.toString() ?? '');

Map<String, dynamic> _map(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : <String, dynamic>{};

List<Map<String, dynamic>> _maps(Object? value) => value is List
    ? value
          .whereType<Map>()
          .map((entry) => Map<String, dynamic>.from(entry))
          .toList()
    : const [];

List<String> _strings(Object? value) => value is List
    ? value
          .map((entry) => entry.toString().trim().toUpperCase())
          .where((entry) => entry.isNotEmpty)
          .toList()
    : const [];
