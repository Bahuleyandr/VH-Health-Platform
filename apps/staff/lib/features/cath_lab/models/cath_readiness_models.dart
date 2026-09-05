// Pre-procedure readiness models for the cath lab (spec 2026-09-04).
//
// Wire sources, as the routes are actually built:
//   * `GET /cath-lab/cases/:id` answers `{ case: { ..., readiness,
//     readiness_gate, lab_readiness } }` — the eight human checks, the gate
//     that start enforces, and the lab-readiness block.
//   * `GET /cath-lab/cases/:id/readiness/labs` answers the lab-readiness block
//     alone.
//   * `POST .../readiness/labs/order-missing` answers
//     `{ created, skipped, readiness }`.
//   * `POST .../readiness/labs/:item/external-result` answers
//     `{ lab_result_id, item, readiness }`.
//   * `POST .../readiness/labs/:item/waive` answers the lab-readiness block
//     itself.
//
// Every key the backend emits is always present and nullable, so parsing is
// defensive on purpose: a null `state` is `not_ordered` (the fail-safe), a
// null `required` is `true` (an item is required until the payload says
// otherwise), and an unparseable instant is simply absent rather than an
// exception that blanks the whole checklist before a procedure.
library;

/// The seven readiness item codes, in the order
/// `cathLabReadinessService.ITEM_CODES` (which is
/// `labAnalyteCodes.LAB_ANALYTE_ITEM_CODES`) spells them. Pinned against that
/// source by `cath_readiness_checklist_test.dart`.
const cathReadinessItemCodes = <String>[
  'hb',
  'platelets',
  'creatinine',
  'potassium',
  'hiv',
  'hbsag',
  'hcv',
];

/// The item-state vocabulary, in `cathLabReadinessService.ITEM_STATES` order.
/// Pinned against that source by `cath_readiness_checklist_test.dart`.
const cathReadinessItemStates = <String>[
  'result_final',
  'result_preliminary',
  'external_recorded',
  'sample_sent_awaiting_result',
  'ordered_awaiting_sample',
  'not_ordered',
  'stale',
  'waived',
];

/// The blood-borne marker items. They are qualitative: an outside entry sends
/// a token, never a number.
const cathReadinessSerologyItems = <String>{'hiv', 'hbsag', 'hcv'};

/// Units the outside-result sheet prefills per quantitative item. The backend
/// falls back to the same values from `LAB_ANALYTE_ITEMS[item].unit`, so this
/// only saves the operator from typing them.
const cathReadinessDefaultUnits = <String, String>{
  'hb': 'g/dL',
  'platelets': '10^3/uL',
  'creatinine': 'mg/dL',
  'potassium': 'mmol/L',
};

/// The serology values an outside entry may carry. These are WIRE tokens, not
/// display text: `recordExternalLabResult` lower-cases the submitted
/// `value_text` and matches it against its `QUALITATIVE_TOKENS` list, so the
/// sheet localises the LABEL and sends one of these unchanged.
const cathReadinessSerologyValues = <String>[
  'Reactive',
  'Non-reactive',
  'Indeterminate',
];

/// The statuses a human may set on a readiness check.
const cathReadinessCheckStatuses = <String>[
  'pass',
  'fail',
  'waived',
  'not_applicable',
  'pending',
];

/// One of the eight `cath_lab_readiness_checks` rows.
class CathReadinessCheck {
  const CathReadinessCheck({
    required this.checkType,
    required this.status,
    required this.required,
    this.completedBy = '',
    this.notes = '',
    this.criticalWarning = false,
    this.autoManaged = false,
  });

  final String checkType;

  /// `pending | pass | fail | waived | not_applicable`.
  final String status;
  final bool required;
  final String completedBy;
  final String notes;

  /// Set by the labs automation when a resolved value is critical. Carried in
  /// the check's metadata, not as a column.
  final bool criticalWarning;

  /// True once the labs automation owns this check's status. A human control
  /// still overrides it; the next refresh may flip it back.
  final bool autoManaged;

  bool get cleared =>
      const {'pass', 'waived', 'not_applicable'}.contains(status);

  /// This check with the labs automation's own view of it folded in.
  ///
  /// The lab-readiness block answers every lab write with `check_status`,
  /// `critical_warning` and `auto_managed` for the SAME row this list renders,
  /// so adopting them keeps the tile from showing the pre-write status until
  /// the case re-read lands — or, when that re-read fails, indefinitely.
  CathReadinessCheck copyWith({
    String? status,
    bool? criticalWarning,
    bool? autoManaged,
  }) {
    return CathReadinessCheck(
      checkType: checkType,
      status: status ?? this.status,
      required: required,
      completedBy: completedBy,
      notes: notes,
      criticalWarning: criticalWarning ?? this.criticalWarning,
      autoManaged: autoManaged ?? this.autoManaged,
    );
  }

  factory CathReadinessCheck.fromJson(Map<String, dynamic> json) {
    final meta = json['metadata'] is Map
        ? Map<String, dynamic>.from(json['metadata'] as Map)
        : const <String, dynamic>{};
    return CathReadinessCheck(
      checkType: _text(json['check_type']),
      status: _text(json['status'], fallback: 'pending'),
      required: json['required'] != false,
      completedBy: _text(json['completed_by']),
      notes: _text(json['notes']),
      criticalWarning: meta['critical_warning'] == true,
      autoManaged: meta['auto_managed'] == true,
    );
  }
}

/// One resolved lab item on a case.
class CathLabReadinessItem {
  const CathLabReadinessItem({
    required this.itemCode,
    required this.required,
    required this.state,
    required this.isCritical,
    this.valueText = '',
    this.valueNumeric,
    this.unit = '',
    this.abnormalFlag = '',
    this.observedAt,
    this.orderedAt,
    this.source = '',
    this.waivedAt,
    this.waiveReason = '',
  });

  final String itemCode;
  final bool required;
  final String state;
  final bool isCritical;
  final String valueText;
  final double? valueNumeric;
  final String unit;
  final String abnormalFlag;
  final DateTime? observedAt;
  final DateTime? orderedAt;

  /// `lab_result | external | waiver`, or empty when nothing is on record.
  final String source;
  final DateTime? waivedAt;
  final String waiveReason;

  /// Whether the item no longer needs an action from the team.
  ///
  /// Wider than the service's `AVAILABLE_STATES` by one state: an outside
  /// result is a value on record for the OPERATOR even where the tenant has
  /// `external_results_count` off, in which case the check stays pending and
  /// the row still says "external, unverified". Offering "enter outside
  /// result" again over a value already entered is the worse failure.
  bool get available => const {
    'result_final',
    'result_preliminary',
    'external_recorded',
    'waived',
  }.contains(state);

  bool get awaiting =>
      state == 'ordered_awaiting_sample' ||
      state == 'sample_sent_awaiting_result';

  bool get isSerology => cathReadinessSerologyItems.contains(itemCode);

  factory CathLabReadinessItem.fromJson(Map<String, dynamic> json) {
    return CathLabReadinessItem(
      itemCode: _text(json['item_code']),
      required: json['required'] != false,
      state: _text(json['state'], fallback: 'not_ordered'),
      isCritical: json['is_critical'] == true,
      valueText: _text(json['value_text']),
      valueNumeric: _double(json['value_numeric']),
      unit: _text(json['unit']),
      abnormalFlag: _text(json['abnormal_flag']),
      observedAt: _date(json['observed_at']),
      orderedAt: _date(json['ordered_at']),
      source: _text(json['source']),
      waivedAt: _date(json['waived_at']),
      waiveReason: _text(json['waive_reason']),
    );
  }
}

/// One entry of the server's `missing[]`: a REQUIRED item the backend does not
/// count as available, with the state it is stuck in.
///
/// The server is the only authority on this list and the client cannot
/// recompute it. `cathLabReadinessService.isAvailable` counts an
/// `external_recorded` item only where the tenant has `external_results_count`
/// on, and that setting is not projected into this payload — so a client-side
/// "what is missing" would call an externally-recorded item done on a tenant
/// where the gate still counts it missing, and offer no way out of it.
class CathLabReadinessMissing {
  const CathLabReadinessMissing({required this.item, required this.state});

  /// The item code, matching one of [cathReadinessItemCodes].
  final String item;

  /// The item's state, matching one of [cathReadinessItemStates].
  final String state;

  factory CathLabReadinessMissing.fromJson(Map<String, dynamic> json) {
    return CathLabReadinessMissing(
      item: _text(json['item']),
      state: _text(json['state'], fallback: 'not_ordered'),
    );
  }
}

/// The `lab_readiness` block: the seven items plus the check-level decision
/// the automation reached over them.
class CathLabReadiness {
  const CathLabReadiness({
    required this.caseId,
    required this.checkStatus,
    required this.autoManaged,
    required this.criticalWarning,
    required this.criticalItems,
    required this.items,
    required this.missing,
    required this.orderableNow,
    required this.caseStarted,
  });

  final int caseId;
  final String checkStatus;
  final bool autoManaged;
  final bool criticalWarning;

  /// Item codes whose resolved value is critical.
  final List<String> criticalItems;
  final List<CathLabReadinessItem> items;

  /// The required items the SERVER still counts as missing, in payload order.
  /// This is what the start gate is computed from, so it is also what the
  /// waive exit is offered against.
  final List<CathLabReadinessMissing> missing;

  /// Catalogue order codes that would cover the still-missing required items.
  /// Empty means there is nothing left to order — the button hides.
  ///
  /// `open_order_codes` is deliberately NOT modelled: the client never needs
  /// it, because `order-missing` filters the already-open codes out on the
  /// server before it places anything.
  final List<String> orderableNow;

  /// True once the procedure has actually started. Every write action hides:
  /// the record of what was known BEFORE the case must not be edited after it.
  final bool caseStarted;

  /// The missing item codes, for a membership test on one row.
  Set<String> get missingItemCodes =>
      missing.map((entry) => entry.item).toSet();

  factory CathLabReadiness.fromJson(Map<String, dynamic> json) {
    return CathLabReadiness(
      caseId: _int(json['case_id']) ?? 0,
      checkStatus: _text(json['check_status'], fallback: 'pending'),
      autoManaged: json['auto_managed'] == true,
      criticalWarning: json['critical_warning'] == true,
      criticalItems: _strings(json['critical_items']),
      items: _maps(json['items'])
          .map(CathLabReadinessItem.fromJson)
          .toList(growable: false),
      missing: _maps(json['missing'])
          .map(CathLabReadinessMissing.fromJson)
          .toList(growable: false),
      orderableNow: _strings(json['orderable_now']),
      caseStarted: json['case_started'] == true,
    );
  }
}

/// `GET /cath-lab/cases/:id` projected down to what the checklist renders.
class CathCaseReadiness {
  const CathCaseReadiness({
    required this.checks,
    required this.ready,
    required this.labs,
  });

  final List<CathReadinessCheck> checks;

  /// `readiness_gate.ready` — whether the case may start at all.
  final bool ready;

  /// Null when the case payload carried no lab-readiness block: the refresh
  /// degrades to null rather than failing the case view, and "we do not know"
  /// must not render as "nothing is missing".
  final CathLabReadiness? labs;

  bool get isEmpty => checks.isEmpty && labs == null;

  factory CathCaseReadiness.fromJson(Map<String, dynamic> json) {
    return CathCaseReadiness(
      checks: _maps(json['readiness'])
          .map(CathReadinessCheck.fromJson)
          .toList(growable: false),
      ready:
          json['readiness_gate'] is Map &&
          (json['readiness_gate'] as Map)['ready'] == true,
      labs: json['lab_readiness'] is Map
          ? CathLabReadiness.fromJson(
              Map<String, dynamic>.from(json['lab_readiness'] as Map),
            )
          : null,
    );
  }
}

/// One outside-lab entry, as the external-result route wants it.
class CathExternalResultDraft {
  const CathExternalResultDraft({
    required this.item,
    required this.valueText,
    required this.observedOn,
    required this.externalLabName,
    this.valueNumeric,
    this.unit,
    this.externalReportRef,
    this.notes,
  });

  final String item;

  /// The serology token for a qualitative item; the number as typed for a
  /// quantitative one. Always sent: the backend stores it as the display value.
  final String valueText;
  final double? valueNumeric;
  final String? unit;

  /// `YYYY-MM-DD`, never in the future — the backend refuses a later date
  /// against the ward's clinical day.
  final String observedOn;
  final String externalLabName;
  final String? externalReportRef;
  final String? notes;

  Map<String, dynamic> toJson() => {
    'value_text': valueText,
    if (valueNumeric != null) 'value_numeric': valueNumeric,
    if ((unit ?? '').isNotEmpty) 'unit': unit,
    'observed_on': observedOn,
    'external_lab_name': externalLabName,
    if ((externalReportRef ?? '').isNotEmpty)
      'external_report_ref': externalReportRef,
    if ((notes ?? '').isNotEmpty) 'notes': notes,
  };
}

String _text(Object? value, {String fallback = ''}) {
  final text = value?.toString().trim() ?? '';
  return text.isEmpty ? fallback : text;
}

DateTime? _date(Object? value) {
  final text = _text(value);
  if (text.isEmpty) return null;
  return DateTime.tryParse(text)?.toLocal();
}

double? _double(Object? value) {
  if (value is num) return value.toDouble();
  final text = _text(value);
  return text.isEmpty ? null : double.tryParse(text);
}

int? _int(Object? value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(_text(value));
}

List<String> _strings(Object? value) {
  if (value is! List) return const [];
  return value
      .map((entry) => _text(entry))
      .where((entry) => entry.isNotEmpty)
      .toList(growable: false);
}

List<Map<String, dynamic>> _maps(Object? value) {
  if (value is! List) return const [];
  return value
      .whereType<Map>()
      .map((entry) => Map<String, dynamic>.from(entry))
      .toList(growable: false);
}
