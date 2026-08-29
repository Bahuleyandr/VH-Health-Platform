import 'dart:collection';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth_core/services/idempotency_key.dart';

import '../../../core/navigation/staff_route_policy.dart';
import '../../../core/services/pharmacy_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/online_only_action_state.dart';
import '../../../l10n/app_strings.dart';

/// The actor's OWN active pharmacy facility grants, as the server proved them.
/// The counter never types an authority scope — it picks one of these.
typedef CounterSaleFacilityLister =
    Future<List<Map<String, dynamic>>> Function();
typedef CounterSaleItemSearcher = Future<List<Map<String, dynamic>>> Function({
  required int facilityId,
  String? search,
});
typedef CounterSaleCreator = Future<Map<String, dynamic>> Function({
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
});
typedef CounterSaleWitnessApprovalRequester =
    Future<Map<String, dynamic>> Function({
      required Map<String, dynamic> sale,
      required String idempotencyKey,
    });
typedef CounterSaleWitnessApprovalApprover =
    Future<Map<String, dynamic>> Function({
      required String approvalId,
      required Map<String, dynamic> sale,
      required String employeeId,
      required String password,
      required String idempotencyKey,
    });
typedef CounterSaleLister = Future<List<Map<String, dynamic>>> Function({
  String? status,
  String? date,
});
typedef CounterSaleVoider = Future<Map<String, dynamic>> Function(
  String id,
  String reason, {
  required String disposition,
  required String idempotencyKey,
});
typedef CounterSaleGetter = Future<Map<String, dynamic>> Function(String id);
typedef CounterSaleVoidStatusGetter = Future<Map<String, dynamic>> Function(
  String id,
);
typedef CounterSaleVoidReconciler = Future<Map<String, dynamic>> Function(
  String id, {
  required String idempotencyKey,
});
typedef CounterSaleRejectedVoidResolver = Future<Map<String, dynamic>> Function(
  String id, {
  required String reason,
  required String idempotencyKey,
});

const _kPaymentModes = [
  'CASH',
  'CARD',
  'UPI',
  'NETBANKING',
  'CHEQUE',
  'DD',
  'WALLET',
];
const _kScheduled = {'H', 'H1', 'X'};
const _kNeverHandedOver = 'NEVER_HANDED_OVER';
const _kPatientReturned = 'PATIENT_RETURNED';
final _kUuidPattern = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  caseSensitive: false,
);

Map<String, dynamic>? _counterSaleMap(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : null;

String _counterSaleCode(Object? value, {String fallback = 'UNKNOWN'}) {
  final normalized = value?.toString().trim().toUpperCase() ?? '';
  return normalized.isEmpty ? fallback : normalized;
}

String localizedCounterSaleStatus(AppStrings strings, Object? value) {
  const supported = {
    'IN_PROGRESS',
    'COMPLETED',
    'VOID_PENDING_REFUND',
    'VOIDED',
    'FAILED',
  };
  final code = _counterSaleCode(value);
  return strings.lookup(
    supported.contains(code)
        ? 's4.lib.counter_sale.status.${code.toLowerCase()}'
        : 's4.lib.counter_sale.status.unknown',
  );
}

String localizedCounterSaleVoidWorkflowStatus(
  AppStrings strings,
  Object? value,
) {
  const supported = {
    'NOT_REQUESTED',
    'AWAITING_FINANCE_APPROVAL',
    'AWAITING_FINANCE_PAYOUT',
    'AWAITING_GATEWAY_PAYOUT',
    'AWAITING_GATEWAY_EVIDENCE',
    'AWAITING_PAYOUT_EVIDENCE',
    'READY_TO_RECONCILE',
    'REFUND_REJECTED_REVIEW',
    'VOIDED',
    'CANCELLED_HANDOVER_CONFIRMED',
    'PENDING_REVIEW',
  };
  final code = _counterSaleCode(value, fallback: 'PENDING_REVIEW');
  return strings.lookup(
    supported.contains(code)
        ? 's4.lib.counter_sale.workflow_status.${code.toLowerCase()}'
        : 's4.lib.counter_sale.workflow_status.unknown',
  );
}

String localizedCounterSaleVoidReadiness(AppStrings strings, Object? value) {
  const supported = {
    'READY',
    'ORIGINAL_PAYMENT_REFERENCE_MISSING',
    'OUTSIDE_SAME_DAY_WINDOW',
    'PENDING_REFUND',
    'VOIDED',
    'NOT_COMPLETED',
  };
  final code = _counterSaleCode(value);
  return strings.lookup(
    supported.contains(code)
        ? 's4.lib.counter_sale.void_readiness.${code.toLowerCase()}'
        : 's4.lib.counter_sale.void_readiness.unknown',
  );
}

String localizedCounterSaleRefundStatus(AppStrings strings, Object? value) {
  const supported = {'PENDING', 'APPROVED', 'PAID', 'REJECTED'};
  final code = _counterSaleCode(value);
  return strings.lookup(
    supported.contains(code)
        ? 's4.lib.counter_sale.refund_status.${code.toLowerCase()}'
        : 's4.lib.counter_sale.refund_status.unknown',
  );
}

String? safeCounterSaleActionRoute(Object? action) {
  final map = _counterSaleMap(action);
  final raw = map?['deep_link']?.toString().trim();
  if (raw == null || raw.isEmpty) return null;
  return StaffRoutePolicy.sanitizeExternalRoute(raw);
}

dynamic _canonicalJsonValue(dynamic value) {
  if (value is Map) {
    final sorted = SplayTreeMap<String, dynamic>();
    for (final entry in value.entries) {
      sorted[entry.key.toString()] = _canonicalJsonValue(entry.value);
    }
    return sorted;
  }
  if (value is List) return value.map(_canonicalJsonValue).toList();
  return value;
}

String _saleFingerprint(Map<String, dynamic> sale) =>
    jsonEncode(_canonicalJsonValue(sale));

class _WitnessCredentials {
  const _WitnessCredentials(this.employeeId, this.password);

  final String employeeId;
  final String password;
}

class _VoidRequestDraft {
  const _VoidRequestDraft({required this.reason, required this.disposition});

  final String reason;
  final String disposition;

  Map<String, dynamic> get payload => {
    'reason': reason,
    'disposition': disposition,
  };
}

class _PendingVoidIntent {
  _PendingVoidIntent(this.draft, String saleId)
    : attempt = IdempotencyAttempt('counter-sale-$saleId-void');

  final _VoidRequestDraft draft;
  final IdempotencyAttempt attempt;
  bool ambiguous = false;
}

class _PendingHandoverResolutionIntent {
  _PendingHandoverResolutionIntent(this.reason, String saleId)
    : attempt = IdempotencyAttempt(
        'counter-sale-$saleId-void-handover-resolution',
      );

  final String reason;
  final IdempotencyAttempt attempt;
  bool ambiguous = false;
}

enum _WitnessAttemptStage { request, approval }

class _CartLine {
  _CartLine(this.item, this.quantity);
  final Map<String, dynamic> item;
  double quantity;
  int? prescriptionLineIndex;

  int get itemId => (item['id'] as num).toInt();
  String get name => (item['display_name'] ?? '').toString();
  String? get scheduleClass => item['schedule_class']?.toString();
  bool get isNarcotic => item['is_narcotic'] == true;
  bool get isScheduled =>
      isNarcotic || _kScheduled.contains(scheduleClass ?? '');
  bool get isWitnessed => isNarcotic || scheduleClass == 'X';
  double? get unitPrice => (item['fefo_unit_price'] as num?)?.toDouble();
  String? get batchNumber => item['fefo_batch_number']?.toString();
  String? get expiry {
    final raw = item['fefo_expiry_date']?.toString();
    if (raw == null || raw.isEmpty) return null;
    return raw.split('T').first;
  }
}

/// Pharmacy point-of-sale: facility-bound item search with FEFO
/// batch/expiry/MRP preview, exact patient/eRx line capture for Schedule
/// H/H1/X items (witness for X/narcotic), pay-at-counter, and same-day void.
/// The backend owns pricing, allocation and schedule enforcement.
class CounterSaleScreen extends StatefulWidget {
  const CounterSaleScreen({
    super.key,
    this.initialSaleId,
    this.listFacilities,
    this.searchItems,
    this.createSale,
    this.requestWitnessApproval,
    this.approveWitnessApproval,
    this.listSales,
    this.voidSale,
    this.getSale,
    this.getVoidStatus,
    this.reconcileVoid,
    this.resolveRejectedVoid,
  });

  final String? initialSaleId;
  final CounterSaleFacilityLister? listFacilities;
  final CounterSaleItemSearcher? searchItems;
  final CounterSaleCreator? createSale;
  final CounterSaleWitnessApprovalRequester? requestWitnessApproval;
  final CounterSaleWitnessApprovalApprover? approveWitnessApproval;
  final CounterSaleLister? listSales;
  final CounterSaleVoider? voidSale;
  final CounterSaleGetter? getSale;
  final CounterSaleVoidStatusGetter? getVoidStatus;
  final CounterSaleVoidReconciler? reconcileVoid;
  final CounterSaleRejectedVoidResolver? resolveRejectedVoid;

  @override
  State<CounterSaleScreen> createState() => _CounterSaleScreenState();
}

class _CounterSaleScreenState extends State<CounterSaleScreen> {
  final _searchCtrl = TextEditingController();
  final _customerNameCtrl = TextEditingController();
  final _customerPhoneCtrl = TextEditingController();
  final _patientUidCtrl = TextEditingController();
  final _rxPrescriptionIdCtrl = TextEditingController();
  final _paymentRefCtrl = TextEditingController();

  // Server-proved facility grants for THIS actor. `_selectedFacilityId` is only
  // ever one of these ids — the counter cannot name a facility it holds no
  // active grant for, and the backend re-proves the grant on every call.
  List<Map<String, dynamic>> _facilities = const [];
  bool _facilitiesLoading = false;
  int? _selectedFacilityId;

  List<Map<String, dynamic>> _results = const [];
  final List<_CartLine> _cart = [];
  bool _searching = false;
  int _searchGeneration = 0;
  bool _selling = false;
  bool _witnessBusy = false;
  bool _walkIn = true;
  String _paymentMode = 'CASH';
  String? _witnessApprovalId;
  String? _witnessApprovalFingerprint;
  String? _approvedWitnessName;
  bool _witnessApproved = false;
  final _witnessRequestAttempt = IdempotencyAttempt(
    'counter-sale-witness-request',
  );
  final _witnessApprovalAttempt = IdempotencyAttempt(
    'counter-sale-witness-approval',
  );
  final _saleAttempt = IdempotencyAttempt('counter-sale-create');
  String? _ambiguousSaleFingerprint;

  List<Map<String, dynamic>> _recent = const [];
  bool _recentLoading = false;
  final Map<String, _PendingVoidIntent> _voidIntents = {};
  final Map<String, IdempotencyAttempt> _reconcileAttempts = {};
  final Map<String, _PendingHandoverResolutionIntent> _resolutionIntents = {};
  final Map<String, Map<String, dynamic>> _voidWorkflows = {};
  final Set<String> _voidingSaleIds = {};
  final Set<String> _reconcilingSaleIds = {};
  final Set<String> _resolvingSaleIds = {};

  @override
  void initState() {
    super.initState();
    _loadFacilities();
    _loadRecent(selectSaleId: widget.initialSaleId);
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    _customerNameCtrl.dispose();
    _customerPhoneCtrl.dispose();
    _patientUidCtrl.dispose();
    _rxPrescriptionIdCtrl.dispose();
    _paymentRefCtrl.dispose();
    _saleAttempt.reset();
    for (final intent in _voidIntents.values) {
      intent.attempt.reset();
    }
    for (final attempt in _reconcileAttempts.values) {
      attempt.reset();
    }
    for (final intent in _resolutionIntents.values) {
      intent.attempt.reset();
    }
    super.dispose();
  }

  bool get _needsRx => _cart.any((l) => l.isScheduled);
  bool get _needsWitness => _cart.any((l) => l.isWitnessed);

  static int? _grantedFacilityId(Map<String, dynamic> grant) {
    final raw = grant['facility_id'];
    final value = raw is num
        ? raw.toInt()
        : int.tryParse(raw?.toString().trim() ?? '');
    return value != null && value > 0 ? value : null;
  }

  /// Never a free-typed value: the selection must still be one of the grants
  /// the server returned, so a revoked grant drops the scope on the next load.
  int? get _facilityId {
    final selected = _selectedFacilityId;
    if (selected == null) return null;
    final granted = _facilities.any(
      (grant) => _grantedFacilityId(grant) == selected,
    );
    return granted ? selected : null;
  }

  Future<void> _loadFacilities() async {
    setState(() => _facilitiesLoading = true);
    try {
      final lister =
          widget.listFacilities ?? PharmacyApiService.getCounterSaleFacilities;
      final facilities = await lister();
      if (!mounted) return;
      setState(() {
        _facilities = facilities;
        final ids = facilities
            .map(_grantedFacilityId)
            .whereType<int>()
            .toList(growable: false);
        if (_selectedFacilityId != null &&
            !ids.contains(_selectedFacilityId)) {
          _selectedFacilityId = null;
          _searchGeneration += 1;
          _searching = false;
          _results = const [];
          _clearWitnessApprovalState();
        }
        // A single granted facility is not a choice — bind it.
        if (_selectedFacilityId == null && ids.length == 1) {
          _selectedFacilityId = ids.first;
        }
      });
    } catch (e) {
      if (mounted) _snack('$e', error: true);
    } finally {
      if (mounted) setState(() => _facilitiesLoading = false);
    }
  }

  void _selectFacility(int? facilityId) {
    if (facilityId == _selectedFacilityId) return;
    setState(() {
      _selectedFacilityId = facilityId;
      _searchGeneration += 1;
      _searching = false;
      _results = const [];
      _clearWitnessApprovalState();
    });
  }

  int? get _prescriptionId {
    final value = int.tryParse(_rxPrescriptionIdCtrl.text.trim());
    return value != null && value > 0 ? value : null;
  }

  bool get _hasRegisteredPatientUid =>
      _kUuidPattern.hasMatch(_patientUidCtrl.text.trim());
  bool get _hasCustomerIdentity => _walkIn
      ? _customerNameCtrl.text.trim().isNotEmpty
      : _hasRegisteredPatientUid;
  bool get _hasRegisteredScheduledPatient =>
      !_needsRx || (!_walkIn && _hasRegisteredPatientUid);
  bool get _hasExactRxMapping =>
      !_needsRx ||
      (_prescriptionId != null &&
          _cart
              .where((line) => line.isScheduled)
              .every((line) => line.prescriptionLineIndex != null));
  bool get _needsPaymentReference => _paymentMode != 'CASH';
  bool get _hasRequiredPaymentReference =>
      !_needsPaymentReference || _paymentRefCtrl.text.trim().isNotEmpty;

  Map<String, dynamic> _currentSalePayload() {
    final paymentReference = _paymentRefCtrl.text.trim();
    return {
      'facility_id': _facilityId,
      'lines': _cart
          .map(
            (line) => {
              'inventory_item_id': line.itemId,
              'quantity': line.quantity,
              if (line.isScheduled)
                'prescription_line_index': line.prescriptionLineIndex,
            },
          )
          .toList(),
      if (_walkIn) 'customer_name': _customerNameCtrl.text.trim(),
      if (_walkIn && _customerPhoneCtrl.text.trim().isNotEmpty)
        'customer_phone': _customerPhoneCtrl.text.trim(),
      if (!_walkIn) 'patient_uid': _patientUidCtrl.text.trim(),
      if (_needsRx) 'rx': {'prescription_id': _prescriptionId},
      'payment_mode': _paymentMode,
      if (paymentReference.isNotEmpty) 'payment_reference': paymentReference,
    };
  }

  bool get _hasCurrentWitnessApproval =>
      _witnessApproved &&
      _witnessApprovalId != null &&
      _witnessApprovalFingerprint == _saleFingerprint(_currentSalePayload());

  void _clearWitnessApprovalState() {
    _witnessApprovalId = null;
    _witnessApprovalFingerprint = null;
    _approvedWitnessName = null;
    _witnessApproved = false;
    _witnessRequestAttempt.reset();
    _witnessApprovalAttempt.reset();
  }

  void _invalidateWitnessApproval() {
    setState(() {
      if (_witnessApprovalId != null) _clearWitnessApprovalState();
    });
  }

  double get _estimatedTotal =>
      _cart.fold(0, (sum, line) => sum + (line.unitPrice ?? 0) * line.quantity);

  void _snack(String message, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: error ? Colors.red.shade700 : null,
      ),
    );
  }

  Future<void> _runSearch() async {
    final s = AppStrings.of(context);
    final facilityId = _facilityId;
    if (facilityId == null) {
      _snack(s.lookup('s4.lib.counter_sale.facility_required'), error: true);
      return;
    }
    final q = _searchCtrl.text.trim();
    final searchGeneration = ++_searchGeneration;
    setState(() => _searching = true);
    try {
      final searcher =
          widget.searchItems ?? PharmacyApiService.getCounterSaleItems;
      final items = await searcher(
        facilityId: facilityId,
        search: q.isEmpty ? null : q,
      );
      if (!mounted ||
          searchGeneration != _searchGeneration ||
          _facilityId != facilityId) {
        return;
      }
      setState(() => _results = items);
    } catch (e) {
      _snack('$e', error: true);
    } finally {
      if (mounted && searchGeneration == _searchGeneration) {
        setState(() => _searching = false);
      }
    }
  }

  Future<void> _addToCart(Map<String, dynamic> item) async {
    final s = AppStrings.of(context);
    final qtyCtrl = TextEditingController(text: '1');
    final qty = await showDialog<double>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(item['display_name']?.toString() ?? ''),
        content: TextField(
          controller: qtyCtrl,
          autofocus: true,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: InputDecoration(
            labelText: s.lookup('s4.lib.counter_sale.quantity'),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text(s.actionCancel),
          ),
          FilledButton(
            onPressed: () =>
                Navigator.pop(ctx, double.tryParse(qtyCtrl.text.trim())),
            child: Text(s.lookup('s4.lib.counter_sale.quantity')),
          ),
        ],
      ),
    );
    if (qty == null || qty <= 0) return;
    setState(() {
      _clearWitnessApprovalState();
      final existing = _cart.where(
        (l) => l.itemId == (item['id'] as num).toInt(),
      );
      if (existing.isNotEmpty) {
        existing.first.quantity += qty;
      } else {
        final line = _CartLine(item, qty);
        _cart.add(line);
        if (line.isScheduled) _walkIn = false;
      }
    });
  }

  Future<bool> _confirmChangedAmbiguousAttempt({
    required String titleKey,
    required String bodyKey,
  }) async {
    final s = AppStrings.of(context);
    return await showDialog<bool>(
          context: context,
          barrierDismissible: false,
          builder: (dialogContext) => AlertDialog(
            title: Text(s.lookup(titleKey)),
            content: Text(s.lookup(bodyKey)),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialogContext, false),
                child: Text(s.actionCancel),
              ),
              FilledButton(
                key: const ValueKey('counter-sale-new-attempt-confirm'),
                onPressed: () => Navigator.pop(dialogContext, true),
                child: Text(
                  s.lookup('s4.lib.counter_sale.new_attempt_confirm'),
                ),
              ),
            ],
          ),
        ) ??
        false;
  }

  Map<String, dynamic>? _saleFromResult(Map<String, dynamic> result) {
    final nested = _counterSaleMap(result['sale']);
    if (nested != null) return nested;
    final data = _counterSaleMap(result['data']);
    return _counterSaleMap(data?['sale']);
  }

  void _upsertRecentSale(Map<String, dynamic> sale) {
    final id = sale['id']?.toString().trim();
    if (id == null || id.isEmpty) return;
    _recent = [
      sale,
      ..._recent.where((existing) => existing['id']?.toString() != id),
    ];
  }

  Future<void> _sell() async {
    final s = AppStrings.of(context);
    if (_cart.isEmpty || _selling) return;
    if (!OnlineOnlyActionGuard.require(context)) return;
    if (_facilityId == null) {
      _snack(s.lookup('s4.lib.counter_sale.facility_required'), error: true);
      return;
    }
    if (!_hasRegisteredScheduledPatient) {
      _snack(
        s.lookup('s4.lib.counter_sale.scheduled_patient_required'),
        error: true,
      );
      return;
    }
    if (!_hasExactRxMapping) {
      _snack(s.lookup('s4.lib.counter_sale.rx_mapping_required'), error: true);
      return;
    }
    if (!_hasRequiredPaymentReference) {
      _snack(
        s.lookup('s4.lib.counter_sale.payment_reference_required'),
        error: true,
      );
      return;
    }
    final sale = _currentSalePayload();
    if (_needsWitness &&
        (!_hasCurrentWitnessApproval || _witnessApprovalId == null)) {
      _snack(s.lookup('s4.lib.counter_sale.witness_required'), error: true);
      return;
    }
    final createPayload = <String, dynamic>{
      ...sale,
      if (_needsWitness) 'witness_approval_id': _witnessApprovalId,
    };
    final fingerprint = _saleFingerprint(createPayload);
    if (_ambiguousSaleFingerprint != null &&
        _ambiguousSaleFingerprint != fingerprint) {
      final confirmed = await _confirmChangedAmbiguousAttempt(
        titleKey: 's4.lib.counter_sale.sale_changed_title',
        bodyKey: 's4.lib.counter_sale.sale_changed_body',
      );
      if (!confirmed || !mounted) return;
      _saleAttempt.reset();
      setState(() => _ambiguousSaleFingerprint = null);
    }
    final idempotencyKey = _saleAttempt.keyFor(createPayload);
    setState(() => _selling = true);
    try {
      final creator = widget.createSale ?? PharmacyApiService.createCounterSale;
      final result = await creator(
        facilityId: sale['facility_id'] as int,
        lines: List<Map<String, dynamic>>.from(sale['lines'] as List),
        patientUid: sale['patient_uid']?.toString(),
        customerName: sale['customer_name']?.toString(),
        customerPhone: sale['customer_phone']?.toString(),
        rx: sale['rx'] is Map
            ? Map<String, dynamic>.from(sale['rx'] as Map)
            : null,
        witnessApprovalId: _needsWitness ? _witnessApprovalId : null,
        paymentMode: sale['payment_mode'].toString(),
        paymentReference: sale['payment_reference']?.toString(),
        idempotencyKey: idempotencyKey,
      );
      final completedSale = _saleFromResult(result);
      final completedStatus = _counterSaleCode(completedSale?['status']);
      final completedId = completedSale?['id']?.toString().trim() ?? '';
      if (completedId.isEmpty || completedStatus != 'COMPLETED') {
        throw StateError(
          'Counter sale result is not authoritatively completed',
        );
      }
      final invoice = result['invoice'];
      final invoiceNumber = invoice is Map
          ? (invoice['invoice_number']?.toString() ?? '—')
          : '—';
      _saleAttempt.reset();
      _snack(s.format('s4.lib.counter_sale.sold', {'invoice': invoiceNumber}));
      setState(() {
        _ambiguousSaleFingerprint = null;
        _upsertRecentSale(completedSale!);
        _clearWitnessApprovalState();
        _cart.clear();
        _rxPrescriptionIdCtrl.clear();
        _paymentRefCtrl.clear();
        _customerNameCtrl.clear();
        _customerPhoneCtrl.clear();
        _patientUidCtrl.clear();
      });
      await _loadRecent();
      await _runSearch();
    } catch (e) {
      final message = e.toString().toLowerCase();
      if (_needsWitness &&
          (message.contains('witness') || message.contains('approval'))) {
        if (mounted) {
          _saleAttempt.reset();
          setState(() {
            _ambiguousSaleFingerprint = null;
            _clearWitnessApprovalState();
          });
        }
        _snack(_safeWitnessError(e, s), error: true);
      } else {
        if (mounted) {
          setState(() => _ambiguousSaleFingerprint = fingerprint);
        }
        _snack(
          s.lookup('s4.lib.counter_sale.sale_response_unconfirmed'),
          error: true,
        );
      }
    } finally {
      if (mounted) setState(() => _selling = false);
    }
  }

  Future<_WitnessCredentials?> _collectWitnessCredentials(AppStrings s) async {
    var employeeId = '';
    var password = '';
    return showDialog<_WitnessCredentials>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        title: Text(s.lookup('s4.lib.counter_sale.witness_auth_title')),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(s.lookup('s4.lib.counter_sale.witness_review_hint')),
              const SizedBox(height: 8),
              ..._cart.map(
                (line) => Text(
                  '${line.name} × ${line.quantity.toStringAsFixed(line.quantity == line.quantity.truncateToDouble() ? 0 : 2)}',
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const ValueKey('counter-sale-witness-employee-id'),
                autofocus: true,
                textCapitalization: TextCapitalization.characters,
                onChanged: (value) => employeeId = value,
                decoration: InputDecoration(
                  labelText: s.lookup(
                    's4.lib.counter_sale.witness_employee_id',
                  ),
                ),
              ),
              const SizedBox(height: 8),
              TextField(
                key: const ValueKey('counter-sale-witness-password'),
                obscureText: true,
                enableSuggestions: false,
                autocorrect: false,
                onChanged: (value) => password = value,
                decoration: InputDecoration(
                  labelText: s.lookup('s4.lib.counter_sale.witness_password'),
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text(s.actionCancel),
          ),
          FilledButton(
            key: const ValueKey('counter-sale-witness-approve-submit'),
            onPressed: () {
              final normalizedEmployeeId = employeeId.trim().toUpperCase();
              if (normalizedEmployeeId.isEmpty || password.isEmpty) return;
              Navigator.pop(
                ctx,
                _WitnessCredentials(normalizedEmployeeId, password),
              );
            },
            child: Text(s.lookup('s4.lib.counter_sale.witness_approve')),
          ),
        ],
      ),
    );
  }

  String _safeWitnessError(Object error, AppStrings s) {
    final message = error.toString().toLowerCase();
    if (message.contains('expired')) {
      return s.lookup('s4.lib.counter_sale.witness_expired');
    }
    if (message.contains('consumed') || message.contains('already')) {
      return s.lookup('s4.lib.counter_sale.witness_used');
    }
    if (message.contains('own controlled dispense') ||
        message.contains('self')) {
      return s.lookup('s4.lib.counter_sale.witness_self');
    }
    if (message.contains('role') || message.contains('eligible')) {
      return s.lookup('s4.lib.counter_sale.witness_role');
    }
    if (message.contains('match') || message.contains('different')) {
      return s.lookup('s4.lib.counter_sale.witness_changed');
    }
    return s.lookup('s4.lib.counter_sale.witness_auth_failed');
  }

  bool _isDefinitiveWitnessError(Object error) {
    final message = error.toString().toLowerCase();
    return message.contains('invalid employee') ||
        message.contains('invalid credential') ||
        message.contains('password') ||
        message.contains('deactivated') ||
        message.contains('inactive') ||
        message.contains('unauthorized') ||
        message.contains('forbidden') ||
        message.contains('locked') ||
        message.contains('too many') ||
        message.contains('required') ||
        message.contains('expired') ||
        message.contains('consumed') ||
        message.contains('already') ||
        message.contains('match') ||
        message.contains('different') ||
        message.contains('own controlled dispense') ||
        message.contains('self') ||
        message.contains('role') ||
        message.contains('eligible') ||
        message.contains('not found') ||
        message.contains('missing') ||
        message.contains('idempotency');
  }

  Future<void> _requestOrApproveWitness() async {
    final s = AppStrings.of(context);
    if (_witnessBusy || !_needsWitness || _cart.isEmpty) return;
    if (_facilityId == null) {
      _snack(s.lookup('s4.lib.counter_sale.facility_required'), error: true);
      return;
    }
    if (!_hasRegisteredScheduledPatient) {
      _snack(
        s.lookup('s4.lib.counter_sale.scheduled_patient_required'),
        error: true,
      );
      return;
    }
    if (!_hasExactRxMapping) {
      _snack(s.lookup('s4.lib.counter_sale.rx_mapping_required'), error: true);
      return;
    }
    final sale = _currentSalePayload();
    final fingerprint = _saleFingerprint(sale);
    var attemptStage = _WitnessAttemptStage.request;
    setState(() => _witnessBusy = true);
    try {
      var approvalId = _witnessApprovalFingerprint == fingerprint
          ? _witnessApprovalId
          : null;
      if (approvalId == null) {
        final requester =
            widget.requestWitnessApproval ??
            PharmacyApiService.requestCounterSaleWitnessApproval;
        final pending = await requester(
          sale: sale,
          idempotencyKey: _witnessRequestAttempt.keyFor(sale),
        );
        final returnedApprovalId = pending['id']?.toString().trim() ?? '';
        if (!RegExp(r'^[1-9][0-9]*$').hasMatch(returnedApprovalId)) {
          throw StateError('Witness approval id missing');
        }
        approvalId = returnedApprovalId;
        if (!mounted) return;
        if (_saleFingerprint(_currentSalePayload()) != fingerprint) {
          throw StateError('Sale changed while requesting witness approval');
        }
        _witnessRequestAttempt.reset();
        setState(() {
          _witnessApprovalId = approvalId;
          _witnessApprovalFingerprint = fingerprint;
          _witnessApproved = false;
          _approvedWitnessName = null;
        });
      }

      final credentials = await _collectWitnessCredentials(s);
      if (credentials == null || !mounted) return;
      final approver =
          widget.approveWitnessApproval ??
          PharmacyApiService.approveCounterSaleWitnessApproval;
      attemptStage = _WitnessAttemptStage.approval;
      final approved = await approver(
        approvalId: approvalId,
        sale: sale,
        employeeId: credentials.employeeId,
        password: credentials.password,
        idempotencyKey: _witnessApprovalAttempt.keyFor({
          'approvalId': approvalId,
          'sale': sale,
          'employeeId': credentials.employeeId,
        }),
      );
      if (!mounted) return;
      if (_saleFingerprint(_currentSalePayload()) != fingerprint) {
        throw StateError('Sale changed while witness approval was pending');
      }
      _witnessApprovalAttempt.reset();
      final witness = approved['witness'];
      final witnessName = witness is Map ? witness['name']?.toString() : null;
      setState(() {
        _witnessApprovalId = approvalId;
        _witnessApprovalFingerprint = fingerprint;
        _witnessApproved = true;
        _approvedWitnessName = witnessName;
      });
      _snack(s.lookup('s4.lib.counter_sale.witness_approved'));
    } catch (error) {
      if (mounted) {
        final message = error.toString().toLowerCase();
        if (_isDefinitiveWitnessError(error)) {
          if (attemptStage == _WitnessAttemptStage.request) {
            _witnessRequestAttempt.reset();
          } else {
            _witnessApprovalAttempt.reset();
          }
        }
        final invalidApproval =
            message.contains('expired') ||
            message.contains('consumed') ||
            message.contains('already') ||
            message.contains('match') ||
            message.contains('different');
        setState(() {
          if (invalidApproval) {
            _clearWitnessApprovalState();
          } else {
            _witnessApproved = false;
            _approvedWitnessName = null;
          }
        });
      }
      _snack(_safeWitnessError(error, s), error: true);
    } finally {
      if (mounted) setState(() => _witnessBusy = false);
    }
  }

  Future<void> _loadRecent({String? selectSaleId}) async {
    setState(() => _recentLoading = true);
    try {
      final lister = widget.listSales ?? PharmacyApiService.listCounterSales;
      final sales = List<Map<String, dynamic>>.from(await lister());
      final selectedId = selectSaleId?.trim();
      if (selectedId != null && selectedId.isNotEmpty) {
        final getter = widget.getSale ?? PharmacyApiService.getCounterSale;
        final detail = await getter(selectedId);
        sales.removeWhere((sale) => sale['id']?.toString() == selectedId);
        sales.insert(0, detail);
      }
      if (!mounted) return;
      setState(() => _recent = sales);
      if (selectedId != null && selectedId.isNotEmpty) {
        await _loadVoidWorkflow(selectedId, announceError: true);
      }
    } catch (error) {
      if (mounted && selectSaleId != null) {
        _snack('$error', error: true);
      }
    } finally {
      if (mounted) setState(() => _recentLoading = false);
    }
  }

  Future<Map<String, dynamic>?> _loadVoidWorkflow(
    String saleId, {
    bool announceError = false,
  }) async {
    try {
      final getter =
          widget.getVoidStatus ?? PharmacyApiService.getCounterSaleVoidStatus;
      final workflow = await getter(saleId);
      if (!mounted) return null;
      final sale = _counterSaleMap(workflow['sale']);
      setState(() {
        _voidWorkflows[saleId] = workflow;
        if (sale != null) _upsertRecentSale(sale);
      });
      return workflow;
    } catch (error) {
      if (announceError && mounted) {
        _snack('$error', error: true);
      }
      return null;
    }
  }

  Future<_VoidRequestDraft?> _collectVoidDraft(
    Map<String, dynamic> sale,
  ) async {
    final s = AppStrings.of(context);
    final saleId = sale['id'].toString();
    final existing = _voidIntents[saleId]?.draft;
    final reasonCtrl = TextEditingController(text: existing?.reason ?? '');
    String? disposition = existing?.disposition;
    final draft = await showDialog<_VoidRequestDraft>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: Text(s.lookup('s4.lib.counter_sale.void_action')),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(s.lookup('s4.lib.counter_sale.void_nonterminal_hint')),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  key: const ValueKey('counter-sale-void-disposition'),
                  initialValue: disposition,
                  decoration: InputDecoration(
                    labelText: s.lookup('s4.lib.counter_sale.void_disposition'),
                  ),
                  items: [
                    DropdownMenuItem(
                      value: _kNeverHandedOver,
                      child: Text(
                        s.lookup(
                          's4.lib.counter_sale.disposition.never_handed_over',
                        ),
                      ),
                    ),
                    DropdownMenuItem(
                      value: _kPatientReturned,
                      child: Text(
                        s.lookup(
                          's4.lib.counter_sale.disposition.patient_returned',
                        ),
                      ),
                    ),
                  ],
                  onChanged: (value) =>
                      setDialogState(() => disposition = value),
                ),
                const SizedBox(height: 8),
                Text(
                  switch (disposition) {
                    _kPatientReturned => s.lookup(
                      's4.lib.counter_sale.patient_returned_quarantine',
                    ),
                    _kNeverHandedOver => s.lookup(
                      's4.lib.counter_sale.never_handed_over_restock',
                    ),
                    _ => s.lookup(
                      's4.lib.counter_sale.disposition_required_hint',
                    ),
                  },
                  key: const ValueKey('counter-sale-disposition-explanation'),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(height: 12),
                TextField(
                  key: const ValueKey('counter-sale-void-reason'),
                  controller: reasonCtrl,
                  autofocus: true,
                  onChanged: (_) => setDialogState(() {}),
                  decoration: InputDecoration(
                    labelText: s.lookup('s4.lib.counter_sale.void_reason'),
                  ),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: Text(s.actionCancel),
            ),
            FilledButton(
              key: const ValueKey('counter-sale-void-submit'),
              onPressed:
                  disposition != _kNeverHandedOver ||
                      reasonCtrl.text.trim().isEmpty
                  ? null
                  : () => Navigator.pop(
                      ctx,
                      _VoidRequestDraft(
                        reason: reasonCtrl.text.trim(),
                        disposition: disposition!,
                      ),
                    ),
              child: Text(s.lookup('s4.lib.counter_sale.void_action')),
            ),
          ],
        ),
      ),
    );
    return draft;
  }

  Future<void> _voidSale(Map<String, dynamic> sale) async {
    final s = AppStrings.of(context);
    final saleId = sale['id']?.toString().trim() ?? '';
    if (saleId.isEmpty || _voidingSaleIds.contains(saleId)) return;
    if (!OnlineOnlyActionGuard.require(context)) return;
    final draft = await _collectVoidDraft(sale);
    if (draft == null || !mounted) return;
    final existing = _voidIntents[saleId];
    if (existing != null &&
        existing.ambiguous &&
        _saleFingerprint(existing.draft.payload) !=
            _saleFingerprint(draft.payload)) {
      final confirmed = await _confirmChangedAmbiguousAttempt(
        titleKey: 's4.lib.counter_sale.void_changed_title',
        bodyKey: 's4.lib.counter_sale.void_changed_body',
      );
      if (!confirmed || !mounted) return;
      existing.attempt.reset();
      _voidIntents.remove(saleId);
    }
    final intent = _voidIntents.putIfAbsent(
      saleId,
      () => _PendingVoidIntent(draft, saleId),
    );
    final idempotencyKey = intent.attempt.keyFor({
      'sale_id': saleId,
      ...intent.draft.payload,
    });
    setState(() => _voidingSaleIds.add(saleId));
    try {
      final voider = widget.voidSale ?? PharmacyApiService.voidCounterSale;
      final result = await voider(
        saleId,
        intent.draft.reason,
        disposition: intent.draft.disposition,
        idempotencyKey: idempotencyKey,
      );
      final updatedSale = _saleFromResult(result);
      final status = _counterSaleCode(updatedSale?['status']);
      if (updatedSale == null ||
          !{'VOID_PENDING_REFUND', 'VOIDED'}.contains(status)) {
        throw StateError('Counter sale void result is not authoritative');
      }
      if (!mounted) return;
      final workflow = await _loadVoidWorkflow(saleId);
      if (workflow == null) {
        throw StateError('Counter sale void refresh was not confirmed');
      }
      intent.ambiguous = false;
      final terminalStatus = _counterSaleCode(
        _counterSaleMap(workflow['sale'])?['status'],
      );
      if (terminalStatus == 'VOIDED') {
        intent.attempt.reset();
        _voidIntents.remove(saleId);
        _snack(s.lookup('s4.lib.counter_sale.void_reconciled'));
      } else {
        _snack(s.lookup('s4.lib.counter_sale.void_pending_refund'));
      }
    } catch (e) {
      intent.ambiguous = true;
      final message = e.toString().toLowerCase();
      _snack(
        message.contains('patient_returned') ||
                message.contains('patient returned') ||
                message.contains('quarantine')
            ? s.lookup('s4.lib.counter_sale.patient_returned_blocked')
            : s.lookup('s4.lib.counter_sale.void_response_unconfirmed'),
        error: true,
      );
    } finally {
      if (mounted) setState(() => _voidingSaleIds.remove(saleId));
    }
  }

  Future<void> _reconcileVoid(String saleId) async {
    if (_reconcilingSaleIds.contains(saleId)) return;
    if (!OnlineOnlyActionGuard.require(context)) return;
    final strings = AppStrings.of(context);
    final workflow = _voidWorkflows[saleId];
    final payload = {
      'sale_id': saleId,
      'void_request_id': _counterSaleMap(
        workflow?['void_request'],
      )?['id']?.toString(),
      'refund_id': _counterSaleMap(workflow?['refund'])?['id']?.toString(),
    };
    final attempt = _reconcileAttempts.putIfAbsent(
      saleId,
      () => IdempotencyAttempt('counter-sale-$saleId-void-reconcile'),
    );
    final idempotencyKey = attempt.keyFor(payload);
    setState(() => _reconcilingSaleIds.add(saleId));
    try {
      final reconciler =
          widget.reconcileVoid ?? PharmacyApiService.reconcileCounterSaleVoid;
      await reconciler(saleId, idempotencyKey: idempotencyKey);
      if (!mounted) return;
      final refreshed = await _loadVoidWorkflow(saleId, announceError: true);
      if (refreshed == null) {
        throw StateError(
          'Counter sale reconciliation refresh was not confirmed',
        );
      }
      final status = _counterSaleCode(
        _counterSaleMap(refreshed['sale'])?['status'],
      );
      if (status == 'VOIDED') {
        attempt.reset();
        _reconcileAttempts.remove(saleId);
        _voidIntents.remove(saleId)?.attempt.reset();
        _snack(strings.lookup('s4.lib.counter_sale.void_reconciled'));
      } else {
        _snack(strings.lookup('s4.lib.counter_sale.reconcile_still_pending'));
      }
    } catch (_) {
      _snack(
        strings.lookup('s4.lib.counter_sale.reconcile_response_unconfirmed'),
        error: true,
      );
    } finally {
      if (mounted) setState(() => _reconcilingSaleIds.remove(saleId));
    }
  }

  Future<String?> _collectHandoverResolutionReason(String saleId) async {
    final strings = AppStrings.of(context);
    final existing = _resolutionIntents[saleId]?.reason;
    final controller = TextEditingController(text: existing ?? '');
    final reason = await showDialog<String>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: Text(
            strings.lookup('s4.lib.counter_sale.handover_resolution_title'),
          ),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                strings.lookup(
                  's4.lib.counter_sale.handover_resolution_warning',
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const ValueKey('counter-sale-handover-resolution-reason'),
                controller: controller,
                autofocus: true,
                onChanged: (_) => setDialogState(() {}),
                decoration: InputDecoration(
                  labelText: strings.lookup(
                    's4.lib.counter_sale.handover_resolution_reason',
                  ),
                ),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext),
              child: Text(strings.actionCancel),
            ),
            FilledButton(
              key: const ValueKey('counter-sale-handover-resolution-submit'),
              onPressed: controller.text.trim().isEmpty
                  ? null
                  : () => Navigator.pop(dialogContext, controller.text.trim()),
              child: Text(
                strings.lookup(
                  's4.lib.counter_sale.handover_resolution_confirm',
                ),
              ),
            ),
          ],
        ),
      ),
    );
    return reason;
  }

  Future<void> _resolveRejectedVoid(String saleId) async {
    if (_resolvingSaleIds.contains(saleId)) return;
    if (!OnlineOnlyActionGuard.require(context)) return;
    final strings = AppStrings.of(context);
    final reason = await _collectHandoverResolutionReason(saleId);
    if (reason == null || !mounted) return;
    final existing = _resolutionIntents[saleId];
    if (existing != null && existing.ambiguous && existing.reason != reason) {
      final confirmed = await _confirmChangedAmbiguousAttempt(
        titleKey: 's4.lib.counter_sale.handover_resolution_changed_title',
        bodyKey: 's4.lib.counter_sale.handover_resolution_changed_body',
      );
      if (!confirmed || !mounted) return;
      existing.attempt.reset();
      _resolutionIntents.remove(saleId);
    }
    final intent = _resolutionIntents.putIfAbsent(
      saleId,
      () => _PendingHandoverResolutionIntent(reason, saleId),
    );
    final idempotencyKey = intent.attempt.keyFor({
      'resolution': 'CUSTOMER_HANDOVER_CONFIRMED',
      'reason': intent.reason,
    });
    setState(() => _resolvingSaleIds.add(saleId));
    try {
      final resolver =
          widget.resolveRejectedVoid ??
          PharmacyApiService.resolveRejectedCounterSaleVoid;
      await resolver(
        saleId,
        reason: intent.reason,
        idempotencyKey: idempotencyKey,
      );
      if (!mounted) return;
      final refreshed = await _loadVoidWorkflow(saleId, announceError: true);
      final refreshedSale = _counterSaleMap(refreshed?['sale']);
      final terminal =
          refreshed != null &&
          _counterSaleCode(refreshed['workflow_status']) ==
              'CANCELLED_HANDOVER_CONFIRMED' &&
          _counterSaleCode(refreshedSale?['status']) == 'COMPLETED';
      if (!terminal) {
        throw StateError(
          'Counter sale handover resolution refresh was not confirmed',
        );
      }
      intent.attempt.reset();
      _resolutionIntents.remove(saleId);
      _voidIntents.remove(saleId)?.attempt.reset();
      _reconcileAttempts.remove(saleId)?.reset();
      _snack(
        strings.lookup('s4.lib.counter_sale.handover_resolution_completed'),
      );
    } catch (_) {
      intent.ambiguous = true;
      _snack(
        strings.lookup(
          's4.lib.counter_sale.handover_resolution_response_unconfirmed',
        ),
        error: true,
      );
    } finally {
      if (mounted) setState(() => _resolvingSaleIds.remove(saleId));
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return DefaultTabController(
      length: 2,
      initialIndex: widget.initialSaleId == null ? 0 : 1,
      child: Scaffold(
        appBar: AppBar(
          title: Text(s.lookup('s4.lib.counter_sale.title')),
          bottom: TabBar(
            tabs: [
              Tab(text: s.lookup('s4.lib.counter_sale.sell_tab')),
              Tab(text: s.lookup('s4.lib.counter_sale.recent_tab')),
            ],
          ),
        ),
        body: TabBarView(children: [_buildSellTab(s), _buildRecentTab(s)]),
      ),
    );
  }

  Widget _buildSellTab(AppStrings s) {
    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        _buildFacilitySection(s),
        const SizedBox(height: 12),
        _buildSearchSection(s),
        const SizedBox(height: 12),
        _buildCartSection(s),
        const SizedBox(height: 12),
        _buildCustomerSection(s),
        if (_needsRx) ...[const SizedBox(height: 12), _buildRxSection(s)],
        if (_needsWitness) ...[
          const SizedBox(height: 12),
          _buildWitnessSection(s),
        ],
        const SizedBox(height: 12),
        _buildPaymentSection(s),
        if (_ambiguousSaleFingerprint != null) ...[
          const SizedBox(height: 12),
          Card(
            key: const ValueKey('counter-sale-ambiguous-sale'),
            color: AppTheme.warningAmber.withValues(alpha: 0.12),
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Text(
                s.lookup('s4.lib.counter_sale.sale_response_unconfirmed'),
              ),
            ),
          ),
        ],
        const SizedBox(height: 16),
        OnlineOnlyActionState(
          builder: (context, isOnline, offlineMessage) => Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (!isOnline)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Text(
                    offlineMessage,
                    key: const ValueKey('counter-sale-offline-message'),
                    style: TextStyle(color: Colors.orange.shade800),
                  ),
                ),
              FilledButton.icon(
                key: const ValueKey('counter-sale-sell'),
                onPressed:
                    !isOnline ||
                        _cart.isEmpty ||
                        _selling ||
                        _facilityId == null ||
                        !_hasCustomerIdentity ||
                        !_hasRegisteredScheduledPatient ||
                        !_hasExactRxMapping ||
                        !_hasRequiredPaymentReference ||
                        (_needsWitness && !_hasCurrentWitnessApproval)
                    ? null
                    : _sell,
                icon: _selling
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.point_of_sale),
                label: Text(
                  s.lookup(
                    _ambiguousSaleFingerprint == null
                        ? 's4.lib.counter_sale.sell'
                        : 's4.lib.counter_sale.retry_sale',
                  ),
                ),
                style: FilledButton.styleFrom(
                  minimumSize: const Size.fromHeight(48),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 24),
      ],
    );
  }

  Widget _buildFacilitySection(AppStrings s) {
    final entries = <DropdownMenuItem<int>>[];
    for (final grant in _facilities) {
      final facilityId = _grantedFacilityId(grant);
      if (facilityId == null) continue;
      final name = grant['display_name']?.toString().trim() ?? '';
      final code = grant['facility_code']?.toString().trim() ?? '';
      final label = [
        name.isEmpty ? '#$facilityId' : name,
        if (code.isNotEmpty) '($code)',
      ].join(' ');
      entries.add(
        DropdownMenuItem<int>(value: facilityId, child: Text(label)),
      );
    }
    final hasGrant = entries.isNotEmpty;
    final selected = _facilityId;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // The subtree key carries the authoritative selection so a grant
            // revoked server-side (or the single-grant auto-bind) re-seeds the
            // form field instead of leaving a stale facility on screen.
            KeyedSubtree(
              key: ValueKey(
                'counter-sale-facility-${selected ?? 0}-${entries.length}',
              ),
              child: DropdownButtonFormField<int>(
                key: const ValueKey('counter-sale-facility-id'),
                initialValue: selected,
                items: entries,
                // Locked once the cart holds stock priced at one facility, and
                // while the granted list is still being proved by the server.
                onChanged: !hasGrant || _facilitiesLoading || _cart.isNotEmpty
                    ? null
                    : _selectFacility,
                isExpanded: true,
                decoration: InputDecoration(
                  labelText: s.lookup('s4.lib.counter_sale.facility_id'),
                  helperText: s.lookup('s4.lib.counter_sale.facility_hint'),
                ),
              ),
            ),
            if (!hasGrant && !_facilitiesLoading)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  s.lookup('s4.lib.counter_sale.facility_none'),
                  key: const ValueKey('counter-sale-facility-none'),
                  style: TextStyle(color: Colors.red.shade700),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildSearchSection(AppStrings s) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              key: const ValueKey('counter-sale-search'),
              controller: _searchCtrl,
              onSubmitted: (_) => _runSearch(),
              decoration: InputDecoration(
                hintText: s.lookup('s4.lib.counter_sale.search_hint'),
                prefixIcon: const Icon(Icons.search),
                suffixIcon: _searching
                    ? const Padding(
                        padding: EdgeInsets.all(12),
                        child: SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      )
                    : IconButton(
                        icon: const Icon(Icons.arrow_forward),
                        onPressed: _runSearch,
                      ),
              ),
            ),
            ..._results.take(8).map((item) {
              final inStock = ((item['in_stock_quantity'] as num?) ?? 0)
                  .toDouble();
              final schedule = item['schedule_class']?.toString();
              final price = (item['fefo_unit_price'] as num?)?.toDouble();
              final expiry = item['fefo_expiry_date']
                  ?.toString()
                  .split('T')
                  .first;
              return ListTile(
                dense: true,
                title: Text(item['display_name']?.toString() ?? ''),
                subtitle: Text(
                  [
                    if (inStock > 0)
                      s.format('s4.lib.counter_sale.in_stock', {
                        'count': inStock.toStringAsFixed(0),
                      })
                    else
                      s.lookup('s4.lib.counter_sale.out_of_stock'),
                    if (expiry != null && item['fefo_batch_number'] != null)
                      s.format('s4.lib.counter_sale.batch_line', {
                        'batch': item['fefo_batch_number'].toString(),
                        'expiry': expiry,
                      }),
                  ].join(' · '),
                ),
                leading: schedule != null || item['is_narcotic'] == true
                    ? Chip(
                        label: Text(
                          item['is_narcotic'] == true ? 'X' : schedule ?? '',
                          style: const TextStyle(fontSize: 11),
                        ),
                        backgroundColor: Colors.red.shade50,
                        visualDensity: VisualDensity.compact,
                      )
                    : null,
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (price != null) Text('₹${price.toStringAsFixed(2)}'),
                    IconButton(
                      icon: const Icon(Icons.add_circle_outline),
                      onPressed: inStock > 0 ? () => _addToCart(item) : null,
                    ),
                  ],
                ),
              );
            }),
          ],
        ),
      ),
    );
  }

  Widget _buildCartSection(AppStrings s) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: _cart.isEmpty
            ? Text(
                s.lookup('s4.lib.counter_sale.cart_empty'),
                style: TextStyle(color: Colors.grey.shade600),
              )
            : Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  ..._cart.map(
                    (line) => ListTile(
                      dense: true,
                      title: Text(line.name),
                      subtitle: Text(
                        [
                          if (line.batchNumber != null && line.expiry != null)
                            s.format('s4.lib.counter_sale.batch_line', {
                              'batch': line.batchNumber!,
                              'expiry': line.expiry!,
                            }),
                          if (line.scheduleClass != null || line.isNarcotic)
                            'Schedule ${line.isNarcotic ? 'X' : line.scheduleClass}',
                        ].join(' · '),
                      ),
                      trailing: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            '× ${line.quantity.toStringAsFixed(line.quantity.truncateToDouble() == line.quantity ? 0 : 2)}',
                          ),
                          if (line.unitPrice != null)
                            Padding(
                              padding: const EdgeInsets.only(left: 8),
                              child: Text(
                                '₹${(line.unitPrice! * line.quantity).toStringAsFixed(2)}',
                              ),
                            ),
                          IconButton(
                            icon: const Icon(Icons.delete_outline),
                            onPressed: () => setState(() {
                              _clearWitnessApprovalState();
                              _cart.remove(line);
                            }),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const Divider(),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Expanded(
                        child: Text(
                          s.lookup('s4.lib.counter_sale.estimated_total'),
                          style: const TextStyle(fontSize: 12),
                        ),
                      ),
                      Text(
                        '₹${_estimatedTotal.toStringAsFixed(2)}',
                        style: const TextStyle(fontWeight: FontWeight.bold),
                      ),
                    ],
                  ),
                ],
              ),
      ),
    );
  }

  Widget _buildCustomerSection(AppStrings s) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SegmentedButton<bool>(
              segments: [
                ButtonSegment(
                  value: true,
                  label: Text(s.lookup('s4.lib.counter_sale.walk_in')),
                ),
                ButtonSegment(
                  value: false,
                  label: Text(
                    s.lookup('s4.lib.counter_sale.registered_patient'),
                  ),
                ),
              ],
              selected: {_walkIn},
              onSelectionChanged: (v) {
                if (_needsRx && v.first) {
                  _snack(
                    s.lookup('s4.lib.counter_sale.scheduled_patient_required'),
                    error: true,
                  );
                  return;
                }
                setState(() {
                  _clearWitnessApprovalState();
                  _walkIn = v.first;
                });
              },
            ),
            const SizedBox(height: 8),
            if (_walkIn) ...[
              TextField(
                key: const ValueKey('counter-sale-customer-name'),
                controller: _customerNameCtrl,
                onChanged: (_) => _invalidateWitnessApproval(),
                decoration: InputDecoration(
                  labelText: s.lookup('s4.lib.counter_sale.customer_name'),
                ),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _customerPhoneCtrl,
                onChanged: (_) => _invalidateWitnessApproval(),
                keyboardType: TextInputType.phone,
                decoration: InputDecoration(
                  labelText: s.lookup('s4.lib.counter_sale.customer_phone'),
                ),
              ),
            ] else
              TextField(
                key: const ValueKey('counter-sale-patient-uid'),
                controller: _patientUidCtrl,
                onChanged: (_) => _invalidateWitnessApproval(),
                decoration: InputDecoration(
                  labelText: s.lookup('s4.lib.counter_sale.patient_uid'),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildRxSection(AppStrings s) {
    return Card(
      key: const ValueKey('counter-sale-rx'),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              s.lookup('s4.lib.counter_sale.rx_section'),
              style: const TextStyle(fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 4),
            Text(
              s.lookup('s4.lib.counter_sale.rx_exact_mapping_hint'),
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 8),
            TextField(
              key: const ValueKey('counter-sale-prescription-id'),
              controller: _rxPrescriptionIdCtrl,
              keyboardType: TextInputType.number,
              onChanged: (_) => _invalidateWitnessApproval(),
              decoration: InputDecoration(
                labelText: s.lookup('s4.lib.counter_sale.rx_prescription_id'),
              ),
            ),
            ..._cart
                .where((line) => line.isScheduled)
                .map(
                  (line) => Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: TextFormField(
                      key: ValueKey('counter-sale-rx-line-${line.itemId}'),
                      initialValue: line.prescriptionLineIndex?.toString(),
                      keyboardType: TextInputType.number,
                      onChanged: (value) {
                        final parsed = int.tryParse(value.trim());
                        line.prescriptionLineIndex =
                            parsed != null && parsed >= 0 ? parsed : null;
                        _invalidateWitnessApproval();
                      },
                      decoration: InputDecoration(
                        labelText: s.format(
                          's4.lib.counter_sale.rx_line_index',
                          {'medicine': line.name},
                        ),
                      ),
                    ),
                  ),
                ),
          ],
        ),
      ),
    );
  }

  Widget _buildWitnessSection(AppStrings s) {
    return Card(
      key: const ValueKey('counter-sale-witness'),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              s.lookup('s4.lib.counter_sale.witness_section'),
              style: const TextStyle(fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 8),
            Text(s.lookup('s4.lib.counter_sale.witness_two_person_hint')),
            const SizedBox(height: 8),
            Row(
              children: [
                Icon(
                  _hasCurrentWitnessApproval
                      ? Icons.verified_user
                      : Icons.person_add_alt_1,
                  color: _hasCurrentWitnessApproval
                      ? AppTheme.successGreen
                      : Colors.orange.shade800,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    _hasCurrentWitnessApproval
                        ? s.format('s4.lib.counter_sale.witness_approved_by', {
                            'name':
                                _approvedWitnessName ??
                                s.lookup(
                                  's4.lib.counter_sale.witness_canonical_staff',
                                ),
                          })
                        : _witnessApprovalId == null
                        ? s.lookup('s4.lib.counter_sale.witness_not_requested')
                        : s.lookup('s4.lib.counter_sale.witness_pending'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              key: const ValueKey('counter-sale-witness-request'),
              onPressed:
                  _witnessBusy ||
                      _facilityId == null ||
                      !_hasRegisteredScheduledPatient ||
                      !_hasExactRxMapping
                  ? null
                  : _requestOrApproveWitness,
              icon: _witnessBusy
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.how_to_reg),
              label: Text(
                _witnessApprovalId == null
                    ? s.lookup('s4.lib.counter_sale.witness_request')
                    : s.lookup('s4.lib.counter_sale.witness_approve'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildPaymentSection(AppStrings s) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            DropdownButtonFormField<String>(
              key: const ValueKey('counter-sale-payment-mode'),
              initialValue: _paymentMode,
              decoration: InputDecoration(
                labelText: s.lookup('s4.lib.counter_sale.payment_mode'),
              ),
              items: _kPaymentModes
                  .map((m) => DropdownMenuItem(value: m, child: Text(m)))
                  .toList(),
              onChanged: (v) => setState(() {
                _clearWitnessApprovalState();
                _paymentMode = v ?? 'CASH';
              }),
            ),
            if (_paymentMode == 'CASH')
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(
                  s.lookup('s4.lib.counter_sale.cash_drawer_hint'),
                  style: TextStyle(fontSize: 12, color: Colors.orange.shade800),
                ),
              )
            else ...[
              const SizedBox(height: 8),
              TextField(
                key: const ValueKey('counter-sale-payment-reference'),
                controller: _paymentRefCtrl,
                onChanged: (_) {
                  _invalidateWitnessApproval();
                },
                decoration: InputDecoration(
                  labelText: s.lookup(
                    's4.lib.counter_sale.original_payment_reference',
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Map<String, dynamic> _workflowForSale(Map<String, dynamic> sale) {
    final saleId = sale['id']?.toString() ?? '';
    final existing = _voidWorkflows[saleId];
    if (existing != null) return existing;
    final saleStatus = _counterSaleCode(sale['status']);
    final refundStatus = _counterSaleCode(sale['void_refund_status']);
    final requestStatus = _counterSaleCode(sale['void_request_status']);
    final workflowStatus = switch ((saleStatus, refundStatus)) {
      ('VOIDED', _) => 'VOIDED',
      ('COMPLETED', _) when requestStatus == 'CANCELLED_HANDOVER_CONFIRMED' =>
        'CANCELLED_HANDOVER_CONFIRMED',
      ('VOID_PENDING_REFUND', 'PENDING') => 'AWAITING_FINANCE_APPROVAL',
      ('VOID_PENDING_REFUND', 'APPROVED') => 'AWAITING_FINANCE_PAYOUT',
      ('VOID_PENDING_REFUND', 'PAID') => 'READY_TO_RECONCILE',
      ('VOID_PENDING_REFUND', 'REJECTED') => 'REFUND_REJECTED_REVIEW',
      ('VOID_PENDING_REFUND', _) => 'PENDING_REVIEW',
      _ => 'NOT_REQUESTED',
    };
    return {
      'workflow_status': workflowStatus,
      'sale': sale,
      if (sale['void_request_id'] != null)
        'void_request': {
          'id': sale['void_request_id'],
          'status': sale['void_request_status'],
        },
      if (sale['void_refund_id'] != null)
        'refund': {
          'id': sale['void_refund_id'],
          'approval_status': sale['void_refund_status'],
        },
    };
  }

  Widget _buildVoidWorkflow(
    AppStrings s,
    Map<String, dynamic> sale,
    Map<String, dynamic> workflow,
  ) {
    final saleId = sale['id'].toString();
    final request = _counterSaleMap(workflow['void_request']);
    final refund = _counterSaleMap(workflow['refund']);
    final actions = _counterSaleMap(workflow['actions']);
    final financeRoute = safeCounterSaleActionRoute(
      _counterSaleMap(actions?['finance_review']),
    );
    final pharmacyRoute = safeCounterSaleActionRoute(
      _counterSaleMap(actions?['pharmacy_reconciliation']),
    );
    final workflowStatus = _counterSaleCode(
      workflow['workflow_status'],
      fallback: 'PENDING_REVIEW',
    );
    final refundStatus =
        refund?['approval_status'] ?? sale['void_refund_status'];
    final requestId = request?['id'] ?? sale['void_request_id'];
    final refundId = refund?['id'] ?? sale['void_refund_id'];
    final isPending = _counterSaleCode(sale['status']) == 'VOID_PENDING_REFUND';
    final isRejectedReview = workflowStatus == 'REFUND_REJECTED_REVIEW';
    final isResolutionAmbiguous = _resolutionIntents[saleId]?.ambiguous == true;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            localizedCounterSaleVoidWorkflowStatus(s, workflowStatus),
            key: ValueKey('counter-sale-workflow-status-$saleId'),
            style: const TextStyle(fontWeight: FontWeight.w700),
          ),
          if (requestId != null)
            Text(
              s.format('s4.lib.counter_sale.void_request_reference', {
                'id': requestId,
              }),
            ),
          if (refundId != null)
            Text(
              s.format('s4.lib.counter_sale.refund_reference', {
                'id': refundId,
                'status': localizedCounterSaleRefundStatus(s, refundStatus),
              }),
            ),
          if (isPending)
            Text(s.lookup('s4.lib.counter_sale.restock_pending_evidence')),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              if (financeRoute != null)
                OutlinedButton.icon(
                  key: ValueKey('counter-sale-finance-route-$saleId'),
                  onPressed: () => context.push(financeRoute),
                  icon: const Icon(Icons.account_balance_wallet_outlined),
                  label: Text(
                    s.lookup('s4.lib.counter_sale.open_finance_workflow'),
                  ),
                ),
              if (pharmacyRoute != null && pharmacyRoute != '/pharmacy')
                OutlinedButton.icon(
                  onPressed: () => context.push(pharmacyRoute),
                  icon: const Icon(Icons.inventory_2_outlined),
                  label: Text(
                    s.lookup('s4.lib.counter_sale.open_reconciliation'),
                  ),
                ),
              if (isPending && !isRejectedReview)
                OnlineOnlyActionState(
                  builder: (context, isOnline, _) => FilledButton.icon(
                    key: ValueKey('counter-sale-reconcile-$saleId'),
                    onPressed: !isOnline || _reconcilingSaleIds.contains(saleId)
                        ? null
                        : () => _reconcileVoid(saleId),
                    icon: _reconcilingSaleIds.contains(saleId)
                        ? const SizedBox.square(
                            dimension: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.sync),
                    label: Text(
                      s.lookup('s4.lib.counter_sale.reconcile_action'),
                    ),
                  ),
                ),
              if (isRejectedReview)
                OnlineOnlyActionState(
                  builder: (context, isOnline, _) => FilledButton.icon(
                    key: ValueKey('counter-sale-handover-resolution-$saleId'),
                    onPressed: !isOnline || _resolvingSaleIds.contains(saleId)
                        ? null
                        : () => _resolveRejectedVoid(saleId),
                    icon: _resolvingSaleIds.contains(saleId)
                        ? const SizedBox.square(
                            dimension: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.assignment_turned_in_outlined),
                    label: Text(
                      s.lookup(
                        isResolutionAmbiguous
                            ? 's4.lib.counter_sale.handover_resolution_retry'
                            : 's4.lib.counter_sale.handover_resolution_action',
                      ),
                    ),
                  ),
                ),
              OutlinedButton.icon(
                key: ValueKey('counter-sale-refresh-$saleId'),
                onPressed: () => _loadVoidWorkflow(saleId, announceError: true),
                icon: const Icon(Icons.refresh),
                label: Text(s.lookup('action.refresh')),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildRecentTab(AppStrings s) {
    if (_recentLoading && _recent.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_recent.isEmpty) {
      return Center(child: Text(s.lookup('s4.lib.counter_sale.no_recent')));
    }
    return RefreshIndicator(
      onRefresh: _loadRecent,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _recent.length,
        itemBuilder: (context, index) {
          final sale = _recent[index];
          final saleId = sale['id']?.toString() ?? '';
          final status = _counterSaleCode(sale['status']);
          final invoiceNumber = sale['invoice_number']?.toString();
          final total = (sale['total_amount'] as num?)?.toDouble() ?? 0;
          final paymentMode = _counterSaleCode(sale['payment_mode']);
          final paymentReference = sale['payment_reference']?.toString().trim();
          final voidReadiness = _counterSaleCode(sale['void_readiness']);
          final who =
              sale['customer_name']?.toString() ??
              sale['patient_uid']?.toString() ??
              '';
          final statusColor = switch (status) {
            'COMPLETED' => AppTheme.successGreen,
            'VOID_PENDING_REFUND' => AppTheme.warningAmber,
            'VOIDED' => Colors.grey,
            _ => Colors.red.shade400,
          };
          final workflow = _workflowForSale(sale);
          final hasVoidHistory =
              sale['void_request_id'] != null ||
              sale['void_request_status'] != null ||
              _counterSaleMap(workflow['void_request']) != null;
          final isAmbiguousVoid = _voidIntents[saleId]?.ambiguous == true;
          final canRequestVoid =
              status == 'COMPLETED' &&
              voidReadiness == 'READY' &&
              (!hasVoidHistory || isAmbiguousVoid);
          final showReadinessBlock =
              status == 'COMPLETED' &&
              !isAmbiguousVoid &&
              voidReadiness != 'READY';
          return Card(
            child: Column(
              children: [
                ListTile(
                  title: Text('${invoiceNumber ?? '#${sale['id']}'} · $who'),
                  subtitle: Text(
                    [
                      '₹${total.toStringAsFixed(2)}',
                      paymentMode,
                      if (paymentReference != null &&
                          paymentReference.isNotEmpty)
                        s.format(
                          's4.lib.counter_sale.original_payment_reference_value',
                          {'reference': paymentReference},
                        ),
                    ].join(' · '),
                  ),
                  leading: Chip(
                    label: Text(
                      localizedCounterSaleStatus(s, status),
                      style: const TextStyle(fontSize: 11),
                    ),
                    backgroundColor: statusColor.withValues(alpha: 0.15),
                    visualDensity: VisualDensity.compact,
                  ),
                  trailing: canRequestVoid
                      ? OnlineOnlyActionState(
                          builder: (context, isOnline, _) => TextButton(
                            key: ValueKey('counter-sale-void-${sale['id']}'),
                            onPressed:
                                !isOnline || _voidingSaleIds.contains(saleId)
                                ? null
                                : () => _voidSale(sale),
                            child: Text(
                              s.lookup(
                                isAmbiguousVoid
                                    ? 's4.lib.counter_sale.retry_void'
                                    : 's4.lib.counter_sale.void_action',
                              ),
                            ),
                          ),
                        )
                      : null,
                ),
                if (showReadinessBlock)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                    child: Text(
                      localizedCounterSaleVoidReadiness(s, voidReadiness),
                      key: ValueKey(
                        'counter-sale-missing-payment-reference-$saleId',
                      ),
                      style: TextStyle(color: Colors.orange.shade900),
                    ),
                  ),
                if (status == 'VOID_PENDING_REFUND' || hasVoidHistory)
                  _buildVoidWorkflow(s, sale, workflow),
              ],
            ),
          );
        },
      ),
    );
  }
}
