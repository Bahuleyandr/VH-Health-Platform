// lib/features/productivity/screens/order_sets_screen.dart
//
// Order set picker + apply (Sprint 8; reworked for roadmap E1). Doctor
// browses bundle templates, reviews items, and either:
//   * composerMode: reconciles incomplete medication templates against the
//     live formulary, captures ward-supply quantity/unit, and pops the selected
//     raw items back to the CPOE composer basket without writing orders, or
//   * standalone with patient context: places REAL clinical orders through
//     POST /emr/orders/bulk (atomic, server-side CDS), then logs the
//     application via /productivity/order-sets/:id/apply best-effort.
//     (Pre-E1 this screen only wrote the application log row and told the
//     doctor "Applied N orders" while no clinical_orders existed — nursing
//     and lab never saw them.)
//   * standalone without patient context: browse-only.

import 'package:flutter/material.dart';
import 'package:vhhealth_staff/core/services/api_client.dart';
import 'package:vhhealth_staff/core/services/idempotency_attempt_registry.dart';
import 'package:vhhealth_staff/core/services/medical_api_service.dart';
import 'package:vhhealth_staff/core/services/order_payloads.dart';
import 'package:vhhealth_staff/features/doctor/widgets/cds_blocker_modal.dart';
import 'package:vhhealth_staff/features/emr/models/order_draft.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

Future<ApiResponse> submitOrderSetAttempt({
  required IdempotencyAttemptRegistry attempts,
  required String scope,
  required Map<String, dynamic> body,
  required Future<ApiResponse> Function(
    String idempotencyKey,
    Map<String, dynamic> body,
  )
  send,
}) {
  return attempts.execute(
    scope: scope,
    body: body,
    send: send,
    isSuccess: (response) => response.isSuccess,
  );
}

class _OrderSetSummary {
  _OrderSetSummary.fromJson(Map<String, dynamic> j)
    : id = j['id'] as int,
      code = j['code']?.toString() ?? '',
      title = j['title']?.toString() ?? '—',
      specialty = j['specialty']?.toString(),
      description = j['description']?.toString(),
      itemCount = (j['item_count'] as num?)?.toInt() ?? 0,
      conditionCodes = (j['condition_codes'] as List? ?? [])
          .map((c) => c.toString())
          .toList();

  final int id;
  final String code;
  final String title;
  final String? specialty;
  final String? description;
  final int itemCount;
  final List<String> conditionCodes;
}

class _OrderSetItem {
  _OrderSetItem.fromJson(Map<String, dynamic> j)
    : id = j['id'] as int,
      kind = j['kind']?.toString() ?? 'other',
      payload = (j['payload'] is Map)
          ? Map<String, dynamic>.from(j['payload'] as Map)
          : <String, dynamic>{},
      defaultSelected = j['default_selected'] as bool? ?? true;

  final int id;
  final String kind;
  final Map<String, dynamic> payload;
  final bool defaultSelected;

  String get displayLabel {
    switch (kind) {
      case 'med':
        final dose = payload['dose'];
        final freq = payload['frequency'];
        return '${payload['drug'] ?? '—'}'
            '${dose != null ? ' $dose' : ''}'
            '${freq != null ? ' · $freq' : ''}';
      case 'lab':
        return payload['test_name']?.toString() ??
            payload['test_code']?.toString() ??
            '—';
      case 'radiology':
        return payload['study']?.toString() ?? '—';
      default:
        return payload['label']?.toString() ?? kind;
    }
  }
}

const _kindColours = <String, Color>{
  'med': Color(0xFF34D399),
  'lab': Color(0xFF60A5FA),
  'radiology': Color(0xFFA78BFA),
  'diet': Color(0xFFFBBF24),
  'nursing': Color(0xFF06B6D4),
  'vitals': Color(0xFF94A3B8),
  'consult': Color(0xFFF87171),
  'monitor': Color(0xFFE879F9),
  'note': Color(0xFF94A3B8),
  'other': Color(0xFF94A3B8),
};

class OrderSetsScreen extends StatefulWidget {
  const OrderSetsScreen({
    super.key,
    this.encounterId,
    this.patientUid,
    this.composerMode = false,
  });
  final int? encounterId;
  final String? patientUid;

  /// When true the detail screen pops the SELECTED RAW ITEMS
  /// (List&lt;Map&gt; of {kind, payload}) back through this screen to the
  /// CPOE composer instead of placing orders itself.
  final bool composerMode;

  @override
  State<OrderSetsScreen> createState() => _OrderSetsScreenState();
}

class _OrderSetsScreenState extends State<OrderSetsScreen> {
  bool _loading = true;
  String? _error;
  List<_OrderSetSummary> _sets = [];
  String _query = '';

  @override
  void initState() {
    super.initState();
    _fetch();
  }

  Future<void> _fetch() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final response = await ApiClient.get(
        '/productivity/order-sets',
        queryParameters: {if (_query.isNotEmpty) 'q': _query, 'limit': '100'},
      );
      if (!mounted) return;
      if (response.isSuccess) {
        final list = response.dataAsList();
        setState(() {
          _sets = list
              .whereType<Map<String, dynamic>>()
              .map(_OrderSetSummary.fromJson)
              .toList();
          _loading = false;
        });
      } else {
        setState(() {
          _error = response.failureMessage(
            AppStrings.of(context).orderSetsLoadFailed,
          );
          _loading = false;
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const AppText('s4.lib.order_sets.order_sets')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: TextField(
              decoration: InputDecoration(
                hintText: AppStrings.of(context)
                    .lookup('s4.lib.order_sets.search_pneumonia_sepsis'),
                prefixIcon: const Icon(Icons.search),
                border: const OutlineInputBorder(),
                isDense: true,
              ),
              onSubmitted: (v) {
                _query = v.trim();
                _fetch();
              },
            ),
          ),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _error != null
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Text(_error!, textAlign: TextAlign.center),
                    ),
                  )
                : _sets.isEmpty
                ? const Center(
                    child: AppText('s4.lib.order_sets.no_order_sets'),
                  )
                : RefreshIndicator(
                    onRefresh: _fetch,
                    child: ListView.separated(
                      padding: const EdgeInsets.all(12),
                      itemCount: _sets.length,
                      separatorBuilder: (_, _) => const SizedBox(height: 8),
                      itemBuilder: (_, i) => _SetCard(
                        summary: _sets[i],
                        encounterId: widget.encounterId,
                        patientUid: widget.patientUid,
                        composerMode: widget.composerMode,
                      ),
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}

class _SetCard extends StatelessWidget {
  const _SetCard({
    required this.summary,
    this.encounterId,
    this.patientUid,
    this.composerMode = false,
  });
  final _OrderSetSummary summary;
  final int? encounterId;
  final String? patientUid;
  final bool composerMode;

  Future<void> _open(BuildContext context) async {
    final navigator = Navigator.of(context);
    final result = await navigator.push<List<Map<String, dynamic>>>(
      MaterialPageRoute(
        builder: (_) => OrderSetDetailScreen(
          orderSetId: summary.id,
          encounterId: encounterId,
          patientUid: patientUid,
          composerMode: composerMode,
        ),
      ),
    );
    // Composer picker: chain the selected items up to the composer.
    if (composerMode && result != null && navigator.mounted) {
      navigator.pop(result);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => _open(context),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      summary.title,
                      style: theme.textTheme.titleMedium,
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 2,
                    ),
                    decoration: BoxDecoration(
                      color: theme.colorScheme.surfaceContainerHigh,
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: Text(
                      AppStrings.of(context)
                          .orderSetsItemCount(summary.itemCount),
                      style: theme.textTheme.bodySmall,
                    ),
                  ),
                ],
              ),
              if (summary.specialty != null) ...[
                const SizedBox(height: 4),
                Text(
                  summary.specialty!,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.outline,
                  ),
                ),
              ],
              if (summary.description != null) ...[
                const SizedBox(height: 6),
                Text(summary.description!),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class OrderSetDetailScreen extends StatefulWidget {
  const OrderSetDetailScreen({
    super.key,
    required this.orderSetId,
    this.encounterId,
    this.patientUid,
    this.composerMode = false,
  });
  final int orderSetId;
  final int? encounterId;
  final String? patientUid;
  final bool composerMode;

  @override
  State<OrderSetDetailScreen> createState() => _OrderSetDetailScreenState();
}

class _OrderSetDetailScreenState extends State<OrderSetDetailScreen> {
  bool _loading = true;
  String? _error;
  Map<String, dynamic>? _set;
  List<_OrderSetItem> _items = [];
  final Set<int> _selected = <int>{};
  final Map<int, Map<String, dynamic>> _reconciledMedicationPayloads = {};
  bool _applying = false;
  final IdempotencyAttemptRegistry _orderCreateAttempts =
      IdempotencyAttemptRegistry();

  @override
  void dispose() {
    _orderCreateAttempts.clear();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    _fetch();
  }

  Future<void> _fetch() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final response = await ApiClient.get(
        '/productivity/order-sets/${widget.orderSetId}',
      );
      if (!mounted) return;
      if (response.isSuccess) {
        final data = response.dataAsMap();
        setState(() {
          _set = data;
          _items = (data['items'] as List? ?? [])
              .whereType<Map<String, dynamic>>()
              .map(_OrderSetItem.fromJson)
              .toList();
          _selected.clear();
          _reconciledMedicationPayloads.clear();
          for (final it in _items) {
            if (it.defaultSelected) _selected.add(it.id);
          }
          _loading = false;
        });
      } else {
        setState(() {
          _error = response.failureMessage(
            AppStrings.of(context).orderSetsItemLoadFailed,
          );
          _loading = false;
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  List<Map<String, dynamic>> get _selectedRawItems => _items
      .where((it) => _selected.contains(it.id))
      .map(
        (it) => {
          'id': it.id,
          'kind': it.kind,
          'payload': _reconciledMedicationPayloads[it.id] ?? it.payload,
        },
      )
      .toList();

  Future<bool> _reconcileSelectedMedicationItems() async {
    for (final item in _items.where(
      (candidate) =>
          _selected.contains(candidate.id) && candidate.kind == 'med',
    )) {
      final payload = _reconciledMedicationPayloads[item.id] ?? item.payload;
      if (_reconciledMedicationPayloads.containsKey(item.id) &&
          !medicationOrderSetPayloadNeedsReconciliation(
            payload,
            liveCatalogSelected: true,
          )) {
        continue;
      }
      final reconciled = await showDialog<Map<String, dynamic>>(
        context: context,
        barrierDismissible: false,
        builder: (_) => _MedicationOrderSetReconciliationDialog(
          medicationLabel: item.displayLabel,
          payload: payload,
        ),
      );
      if (!mounted || reconciled == null) return false;
      setState(() => _reconciledMedicationPayloads[item.id] = reconciled);
    }
    return true;
  }

  /// Composer picker: reconcile medication identity and ward supply, then hand
  /// the selected raw items back. The eventual order write remains in the
  /// composer and still goes through its atomic bulk CPOE boundary.
  Future<void> _returnToComposer() async {
    if (_applying) return;
    setState(() {
      _applying = true;
      _error = null;
    });
    final ready = await _reconcileSelectedMedicationItems();
    if (!mounted) return;
    if (!ready) {
      setState(() => _applying = false);
      return;
    }
    Navigator.of(context).pop(_selectedRawItems);
  }

  /// Standalone with patient context: place REAL clinical orders through
  /// the atomic bulk CPOE endpoint (full server-side CDS), then log the
  /// set application for usage analytics best-effort. Pre-E1 this method
  /// only wrote the analytics row — see the file header.
  Future<void> _apply() async {
    final s = AppStrings.of(context);
    final patientUid = widget.patientUid;
    if (patientUid == null || patientUid.isEmpty) return;
    setState(() {
      _applying = true;
      _error = null;
    });
    try {
      final ready = await _reconcileSelectedMedicationItems();
      if (!mounted) return;
      if (!ready) {
        setState(() => _applying = false);
        return;
      }
      final applied = _selectedRawItems;
      final skipped = _items
          .where((it) => !_selected.contains(it.id))
          .map((it) => {'id': it.id, 'kind': it.kind})
          .toList();
      final drafts = applied
          .map(orderDraftFromSetItem)
          .whereType<OrderDraft>()
          .toList();
      if (drafts.isEmpty) {
        setState(() {
          _applying = false;
          _error = s.orderSetsNoPlaceableItems;
        });
        return;
      }
      if (drafts.any((draft) => !medicationHasAuthoritativeCatalog(draft))) {
        setState(() {
          _applying = false;
          _error = s.lookup('s4.lib.drug_chart.catalog_selection_required');
        });
        return;
      }
      final incompleteDirections = drafts
          .map(medicationClinicalDirectionsFailure)
          .whereType<MedicationClinicalDirectionsValidationFailure>()
          .firstOrNull;
      if (incompleteDirections != null) {
        setState(() {
          _applying = false;
          _error =
              '${incompleteDirections == MedicationClinicalDirectionsValidationFailure.doseRequired ? s.ordersDosage : s.ordersRoute}: ${s.admissionRequired}';
        });
        return;
      }
      if (drafts.any((draft) => medicationWardSupplyFailure(draft) != null)) {
        setState(() {
          _applying = false;
          _error =
              '${s.lookup('mar_scan.supply.title')}: '
              '${s.lookup('s4.lib.pharmacy.quantity')} / '
              '${s.lookup('s4.lib.pharmacy.metric_unit')} '
              '${s.labelRequired.toLowerCase()}';
        });
        return;
      }
      final orders = [
        for (final d in drafts)
          buildBulkOrderItem(
            d,
            patientUid: patientUid,
            encounterId: widget.encounterId?.toString(),
          ),
      ];
      final attemptScope =
          'clinical-order-set:${widget.orderSetId}:$patientUid';
      final requestBody = <String, dynamic>{'orders': orders};
      final response = await submitOrderSetAttempt(
        attempts: _orderCreateAttempts,
        scope: attemptScope,
        body: requestBody,
        send: (key, body) => MedicalApiService.createEmrOrdersBulkRaw(
          (body['orders'] as List).cast<Map<String, dynamic>>(),
          idempotencyKey: key,
        ),
      );
      if (!mounted) return;
      if (!response.isSuccess) {
        final cds = parseCdsBlockerDetails(response.raw);
        if (cds.blockers.isNotEmpty) {
          setState(() => _applying = false);
          await CdsBlockerModal.show(
            context,
            blockers: cds.blockers,
            warnings: cds.warnings,
            allowOverride: false,
          );
          return;
        }
        setState(() {
          _applying = false;
          _error = response.failureMessage(s.orderSetsApplyFailed);
        });
        return;
      }
      // Usage-analytics log — best-effort, never blocks the clinical path.
      try {
        await ApiClient.post(
          '/productivity/order-sets/${widget.orderSetId}/apply',
          body: {
            if (widget.encounterId != null) 'encounter_id': widget.encounterId,
            'patient_uid': patientUid,
            'items_applied': applied,
            'items_skipped': skipped,
          },
        );
      } catch (_) {
        // Analytics row only — the clinical orders are already placed.
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(s.orderSetsPlacedToast(drafts.length))),
      );
      Navigator.of(context).pop(const <Map<String, dynamic>>[]);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _applying = false;
        _error = e.toString();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(_set?['title']?.toString() ?? 'Order set')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text(_error!, textAlign: TextAlign.center),
              ),
            )
          : ListView.builder(
              padding: const EdgeInsets.all(8),
              itemCount: _items.length,
              itemBuilder: (_, i) {
                final it = _items[i];
                final selected = _selected.contains(it.id);
                return CheckboxListTile(
                  value: selected,
                  onChanged: (v) {
                    setState(() {
                      if (v == true) {
                        _selected.add(it.id);
                      } else {
                        _selected.remove(it.id);
                      }
                    });
                  },
                  controlAffinity: ListTileControlAffinity.leading,
                  title: Text(it.displayLabel),
                  subtitle: Wrap(
                    spacing: 6,
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 6,
                          vertical: 2,
                        ),
                        decoration: BoxDecoration(
                          color: (_kindColours[it.kind] ?? Colors.grey)
                              .withValues(alpha: 0.15),
                          borderRadius: BorderRadius.circular(4),
                        ),
                        child: Text(
                          it.kind,
                          style: theme.textTheme.labelSmall?.copyWith(
                            color: _kindColours[it.kind] ?? Colors.grey,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                      if (it.kind == 'med' && it.payload['route'] != null)
                        AppText(
                          's4.dynamic.order_sets.via_route',
                          values: {'route': it.payload['route']},
                        ),
                      if (it.kind == 'med' &&
                          it.payload['duration_days'] != null)
                        AppText(
                          's4.dynamic.order_sets.duration_days',
                          values: {'days': it.payload['duration_days']},
                        ),
                    ],
                  ),
                );
              },
            ),
      bottomNavigationBar: _set == null || !_canAct
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: FilledButton.icon(
                  onPressed: _applying || _selected.isEmpty
                      ? null
                      : widget.composerMode
                      ? _returnToComposer
                      : _apply,
                  icon: _applying
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : Icon(
                          widget.composerMode
                              ? Icons.playlist_add_check
                              : Icons.check,
                        ),
                  label: Text(_actionLabel(AppStrings.of(context))),
                ),
              ),
            ),
    );
  }

  /// Browse-only when there is neither a composer to feed nor a patient to
  /// order against.
  bool get _canAct =>
      widget.composerMode ||
      (widget.patientUid != null && widget.patientUid!.isNotEmpty);

  String _actionLabel(AppStrings s) {
    if (_applying) return s.orderSetsApplying;
    if (widget.composerMode) {
      return s.orderSetsAddToBasket(_selected.length);
    }
    return s.orderSetsApplyCount(_selected.length, _items.length);
  }
}

class _MedicationOrderSetReconciliationDialog extends StatefulWidget {
  const _MedicationOrderSetReconciliationDialog({
    required this.medicationLabel,
    required this.payload,
  });

  final String medicationLabel;
  final Map<String, dynamic> payload;

  @override
  State<_MedicationOrderSetReconciliationDialog> createState() =>
      _MedicationOrderSetReconciliationDialogState();
}

class _MedicationOrderSetReconciliationDialogState
    extends State<_MedicationOrderSetReconciliationDialog> {
  final _searchController = TextEditingController();
  final _doseController = TextEditingController();
  final _quantityController = TextEditingController();
  List<Map<String, dynamic>> _catalogResults = const [];
  Map<String, dynamic>? _selectedCatalog;
  String? _supplyUnit;
  int _searchGeneration = 0;
  bool _searching = false;
  bool _catalogUnavailable = false;
  bool _attempted = false;

  @override
  void initState() {
    super.initState();
    final payload = widget.payload;
    _doseController.text = payload['dose']?.toString() ?? '';
    _quantityController.text = payload['quantity_requested']?.toString() ?? '';
    _supplyUnit = canonicalMedicationWardSupplyUnit(payload['unit']);
    final medicationName =
        payload['medication_name']?.toString().trim().isNotEmpty == true
        ? payload['medication_name'].toString().trim()
        : payload['drug']?.toString().trim() ?? '';
    _searchController.text = medicationName;
    if (medicationName.length >= 2) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _searchCatalog(medicationName);
      });
    }
  }

  @override
  void dispose() {
    _searchGeneration++;
    _searchController.dispose();
    _doseController.dispose();
    _quantityController.dispose();
    super.dispose();
  }

  Future<void> _searchCatalog(String raw) async {
    final generation = ++_searchGeneration;
    final query = raw.trim();
    if (query.length < 2) {
      setState(() {
        _selectedCatalog = null;
        _attempted = false;
        _searching = false;
        _catalogUnavailable = false;
        _catalogResults = const [];
      });
      return;
    }
    setState(() {
      _selectedCatalog = null;
      _attempted = false;
      _searching = true;
      _catalogUnavailable = false;
    });
    await Future<void>.delayed(const Duration(milliseconds: 250));
    if (!mounted || generation != _searchGeneration) return;
    try {
      final rows = await MedicalApiService.searchMedicationCatalog(query);
      if (!mounted || generation != _searchGeneration) return;
      setState(() {
        _searching = false;
        _catalogUnavailable = false;
        _catalogResults = rows
            .where(
              (row) =>
                  medicationHasAuthoritativeCatalog(
                    orderDraftFromMedCatalogRow(row),
                  ) &&
                  medicationHasAuthoritativeCatalogRoute(
                    orderDraftFromMedCatalogRow(row),
                  ),
            )
            .take(8)
            .toList(growable: false);
      });
    } catch (_) {
      if (!mounted || generation != _searchGeneration) return;
      setState(() {
        _searching = false;
        _catalogUnavailable = true;
        _catalogResults = const [];
      });
    }
  }

  void _selectCatalog(Map<String, dynamic> row) {
    final draft = orderDraftFromMedCatalogRow(row);
    final name = draft.details['medication_name']?.toString() ?? '';
    setState(() {
      _selectedCatalog = row;
      _searchController.value = TextEditingValue(
        text: name,
        selection: TextSelection.collapsed(offset: name.length),
      );
      _catalogResults = const [];
      _catalogUnavailable = false;
      _attempted = false;
    });
  }

  String? _validationMessage(AppStrings strings) {
    if (_selectedCatalog == null) {
      return strings.lookup('s4.lib.drug_chart.catalog_selection_required');
    }
    final selectedDraft = orderDraftFromMedCatalogRow(_selectedCatalog!);
    if (!medicationHasAuthoritativeCatalogRoute(selectedDraft)) {
      return '${strings.ordersRoute}: ${strings.admissionRequired}';
    }
    if (_doseController.text.trim().isEmpty) {
      return '${strings.ordersDosage}: ${strings.admissionRequired}';
    }
    final failure = validateMedicationWardSupply(
      quantity: _quantityController.text,
      unit: _supplyUnit,
    );
    return switch (failure) {
      MedicationWardSupplyValidationFailure.quantityRequired ||
      MedicationWardSupplyValidationFailure.quantityInvalid => strings.lookup(
        'mar_scan.supply.quantity_error',
      ),
      MedicationWardSupplyValidationFailure.unitRequired ||
      MedicationWardSupplyValidationFailure.unitInvalid =>
        '${strings.lookup('s4.lib.pharmacy.metric_unit')}: ${strings.labelRequired}',
      null => null,
    };
  }

  void _confirm() {
    final message = _validationMessage(AppStrings.of(context));
    if (message != null) {
      setState(() => _attempted = true);
      return;
    }
    Navigator.of(context).pop(
      reconcileMedicationOrderSetPayload(
        payload: widget.payload,
        catalogRow: _selectedCatalog!,
        dose: _doseController.text,
        quantityRequested: _quantityController.text,
        unit: _supplyUnit,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final validationMessage = _attempted ? _validationMessage(strings) : null;
    final selectedDraft = _selectedCatalog == null
        ? null
        : orderDraftFromMedCatalogRow(_selectedCatalog!);
    return AlertDialog(
      title: Text(strings.lookup('mar_scan.supply.title')),
      content: SizedBox(
        width: 560,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(widget.medicationLabel),
              const SizedBox(height: 16),
              TextField(
                key: const Key('order-set-medication-catalog-search'),
                controller: _searchController,
                decoration: InputDecoration(
                  labelText: strings.lookup('drug_chart.column.drug'),
                  hintText: strings.lookup(
                    's4.lib.prescriptions.type_drug_name',
                  ),
                  border: const OutlineInputBorder(),
                  suffixIcon: _searching
                      ? const Padding(
                          padding: EdgeInsets.all(12),
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.search),
                ),
                onChanged: _searchCatalog,
              ),
              if (_catalogUnavailable) ...[
                const SizedBox(height: 8),
                Text(
                  strings.lookup('s4.lib.drug_chart.catalog_unavailable'),
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ],
              if (_catalogResults.isNotEmpty)
                ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 220),
                  child: ListView.builder(
                    shrinkWrap: true,
                    itemCount: _catalogResults.length,
                    itemBuilder: (_, index) {
                      final row = _catalogResults[index];
                      final draft = orderDraftFromMedCatalogRow(row);
                      return ListTile(
                        dense: true,
                        title: Text(draft.title),
                        subtitle: Text(draft.subtitle),
                        onTap: () => _selectCatalog(row),
                      );
                    },
                  ),
                ),
              if (selectedDraft != null) ...[
                const SizedBox(height: 8),
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.check_circle_outline),
                  title: Text(selectedDraft.title),
                  subtitle: Text(selectedDraft.subtitle),
                ),
              ],
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      key: const Key('order-set-medication-dose'),
                      controller: _doseController,
                      decoration: InputDecoration(
                        labelText: strings.ordersDosage,
                        border: const OutlineInputBorder(),
                      ),
                      onChanged: (_) {
                        if (_attempted) setState(() {});
                      },
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: InputDecorator(
                      key: const Key('order-set-medication-route'),
                      decoration: InputDecoration(
                        labelText: strings.ordersRoute,
                        border: const OutlineInputBorder(),
                      ),
                      child: Text(
                        selectedDraft?.details['route']?.toString() ?? '—',
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      key: const Key('order-set-medication-supply-quantity'),
                      controller: _quantityController,
                      keyboardType: const TextInputType.numberWithOptions(
                        decimal: true,
                      ),
                      decoration: InputDecoration(
                        labelText: strings.lookup('s4.lib.pharmacy.quantity'),
                        border: const OutlineInputBorder(),
                      ),
                      onChanged: (_) {
                        if (_attempted) setState(() {});
                      },
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: DropdownButtonFormField<String>(
                      key: const Key('order-set-medication-supply-unit'),
                      initialValue: _supplyUnit,
                      isExpanded: true,
                      decoration: InputDecoration(
                        labelText: strings.lookup(
                          's4.lib.pharmacy.metric_unit',
                        ),
                        border: const OutlineInputBorder(),
                      ),
                      items: medicationWardSupplyUnits
                          .map(
                            (unit) => DropdownMenuItem(
                              value: unit,
                              child: Text(
                                strings.medicationWardSupplyUnit(unit),
                              ),
                            ),
                          )
                          .toList(growable: false),
                      onChanged: (value) => setState(() {
                        _supplyUnit = value;
                        _attempted = false;
                      }),
                    ),
                  ),
                ],
              ),
              if (validationMessage != null) ...[
                const SizedBox(height: 8),
                Text(
                  validationMessage,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(strings.actionCancel),
        ),
        FilledButton(
          key: const Key('order-set-medication-reconcile-confirm'),
          onPressed: _confirm,
          child: Text(strings.actionConfirm),
        ),
      ],
    );
  }
}
