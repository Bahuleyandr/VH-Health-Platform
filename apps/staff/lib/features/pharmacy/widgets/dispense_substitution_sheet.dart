import 'package:flutter/material.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

import '../../../core/models/composition_alternatives.dart';
import '../../../core/services/pharmacy_api_service.dart';
import 'composition_alternatives_panel.dart';

typedef DispensableContextLoader =
    Future<Map<String, dynamic>> Function(int orderId);
typedef DispensableBatchLoader =
    Future<List<Map<String, dynamic>>> Function(int catalogId);
typedef SubstitutionDispenser =
    Future<void> Function({
      required String patientUid,
      int? encounterId,
      required int inventoryItemId,
      required int inventoryBatchId,
      required num quantity,
      required int originalCatalogId,
      required int finalCatalogId,
      String? reason,
    });

/// Bottom sheet where a pharmacist dispenses an in-stock, same-formulation alternative
/// for a prescribed brand on a pharmacy order.
///
/// Flow: load the order's patient + prescribed catalog-id lines → mount the existing
/// [CompositionAlternativesPanel] for the selected line → on swap, load that alternative's
/// in-stock batches (FEFO) and collect a batch + quantity → POST dispense-substitution.
/// All equivalence + stock checks are enforced server-side; this is a data-collection UI.
class DispenseSubstitutionSheet extends StatefulWidget {
  const DispenseSubstitutionSheet({
    super.key,
    required this.orderId,
    this.onDispensed,
    this.contextLoader,
    this.batchLoader,
    this.dispenser,
    this.alternativesLoader,
  });

  final int orderId;
  final VoidCallback? onDispensed;

  // Injectable seams (default to PharmacyApiService / the panel's own fetch) — for tests.
  final DispensableContextLoader? contextLoader;
  final DispensableBatchLoader? batchLoader;
  final SubstitutionDispenser? dispenser;
  final CompositionAlternativesLoader? alternativesLoader;

  static Future<void> show(
    BuildContext context, {
    required int orderId,
    VoidCallback? onDispensed,
  }) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom),
        child: DispenseSubstitutionSheet(
          orderId: orderId,
          onDispensed: onDispensed,
        ),
      ),
    );
  }

  @override
  State<DispenseSubstitutionSheet> createState() =>
      _DispenseSubstitutionSheetState();
}

class _DispenseSubstitutionSheetState extends State<DispenseSubstitutionSheet> {
  bool _loading = true;
  bool _loadingBatches = false;
  bool _dispensing = false;
  String? _error;

  String? _patientUid;
  List<Map<String, dynamic>> _lines = const [];
  Map<String, dynamic>? _selectedLine;
  CompositionAlternativeItem? _chosen;
  List<Map<String, dynamic>> _batches = const [];
  Map<String, dynamic>? _selectedBatch;
  final TextEditingController _qtyCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _qtyCtrl.dispose();
    super.dispose();
  }

  int? get _originalCatalogId =>
      (_selectedLine?['catalog_id'] as num?)?.toInt();

  String get _selectedLabel =>
      (_selectedLine?['name'] as String?) ?? 'Prescribed brand';

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final ctx =
          await (widget.contextLoader ??
              PharmacyApiService.getOrderDispensable)(widget.orderId);
      final lines = ((ctx['lines'] as List?) ?? const [])
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .where((l) => l['catalog_id'] != null)
          .toList();
      setState(() {
        _patientUid = ctx['patient_uid'] as String?;
        _lines = lines;
        _selectedLine = lines.isNotEmpty ? lines.first : null;
        _chosen = null;
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  void _onSelectLine(Map<String, dynamic>? line) {
    setState(() {
      _selectedLine = line;
      _chosen = null;
      _batches = const [];
      _selectedBatch = null;
    });
  }

  Future<void> _onSwap(CompositionAlternativeItem item) async {
    setState(() {
      _chosen = item;
      _batches = const [];
      _selectedBatch = null;
      _loadingBatches = true;
      _error = null;
    });
    try {
      final batches =
          await (widget.batchLoader ??
              PharmacyApiService.getCatalogDispensableBatches)(item.catalogId);
      final defaultQty = (_selectedLine?['quantity'] as num?);
      setState(() {
        _batches = batches;
        _selectedBatch = batches.isNotEmpty ? batches.first : null;
        _qtyCtrl.text = (defaultQty != null && defaultQty > 0 ? defaultQty : 1)
            .toString();
        _loadingBatches = false;
      });
    } catch (e) {
      setState(() {
        _loadingBatches = false;
        _error = e.toString();
      });
    }
  }

  Future<void> _dispense() async {
    final s = AppStrings.of(context);
    final patient = _patientUid;
    final orig = _originalCatalogId;
    final chosen = _chosen;
    final batch = _selectedBatch;
    final qty = num.tryParse(_qtyCtrl.text.trim());
    if (patient == null ||
        orig == null ||
        chosen == null ||
        batch == null ||
        qty == null ||
        qty <= 0) {
      setState(
        () => _error = s.lookup(
          's4.lib.pharmacy.select_substitute_batch_quantity',
        ),
      );
      return;
    }
    setState(() {
      _dispensing = true;
      _error = null;
    });
    try {
      final SubstitutionDispenser dispenser =
          widget.dispenser ?? PharmacyApiService.dispenseSubstitution;
      await dispenser(
        patientUid: patient,
        inventoryItemId: (batch['inventory_item_id'] as num).toInt(),
        inventoryBatchId: (batch['inventory_batch_id'] as num).toInt(),
        quantity: qty,
        originalCatalogId: orig,
        finalCatalogId: chosen.catalogId,
        reason: 'Prescribed brand unavailable; same-formulation substitute',
      );
      if (!mounted) return;
      widget.onDispensed?.call();
      Navigator.of(context).pop();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            s.format('s4.dynamic.pharmacy.dispensed_as_substitute', {
              'name': chosen.displayName,
            }),
          ),
        ),
      );
    } catch (e) {
      setState(() {
        _dispensing = false;
        _error = e.toString();
      });
    }
  }

  String _batchLabel(AppStrings s, Map<String, dynamic> b) {
    final n = b['batch_number'] ?? '—';
    final left = b['remaining_quantity'];
    final exp = (b['expiry_date'] ?? '').toString();
    final expShort = exp.length >= 10 ? exp.substring(0, 10) : exp;
    return s.format('s4.dynamic.pharmacy.substitute_batch_label', {
      'number': n,
      'left': left,
      'expiry': expShort,
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = AppStrings.of(context);
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.of(context).size.height * 0.85,
        ),
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Icon(Icons.swap_horiz),
                  const SizedBox(width: 8),
                  Text(
                    s.lookup('s4.lib.pharmacy.dispense_substitute'),
                    style: theme.textTheme.titleLarge,
                  ),
                  const Spacer(),
                  IconButton(
                    icon: const Icon(Icons.close),
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              if (_loading)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 32),
                  child: Center(child: CircularProgressIndicator()),
                )
              else if (_lines.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 24),
                  child: Text(
                    s.lookup('s4.lib.pharmacy.no_prescribed_catalog_lines'),
                    style: theme.textTheme.bodyMedium,
                  ),
                )
              else ...[
                DropdownButtonFormField<Map<String, dynamic>>(
                  initialValue: _selectedLine,
                  isExpanded: true,
                  decoration: InputDecoration(
                    labelText: s.lookup('s4.lib.pharmacy.prescribed_medicine'),
                    border: const OutlineInputBorder(),
                  ),
                  items: _lines
                      .map(
                        (l) => DropdownMenuItem(
                          value: l,
                          child: Text(
                            (l['name'] as String?) ??
                                s.format('s4.dynamic.pharmacy.item_fallback', {
                                  'id': l['catalog_id'],
                                }),
                          ),
                        ),
                      )
                      .toList(),
                  onChanged: _onSelectLine,
                ),
                const SizedBox(height: 12),
                CompositionAlternativesPanel(
                  key: ValueKey(_originalCatalogId),
                  catalogId: _originalCatalogId,
                  visible: true,
                  doNotSubstitute: false,
                  selectedLabel: _selectedLabel,
                  onSwap: _onSwap,
                  loader: widget.alternativesLoader,
                ),
                if (_chosen != null) ...[
                  const Divider(height: 24),
                  Text(
                    s.format('s4.dynamic.pharmacy.substitute_named', {
                      'name': _chosen!.displayName,
                    }),
                    style: theme.textTheme.titleMedium,
                  ),
                  const SizedBox(height: 8),
                  if (_loadingBatches)
                    const Padding(
                      padding: EdgeInsets.all(8),
                      child: LinearProgressIndicator(),
                    )
                  else if (_batches.isEmpty)
                    Text(
                      s.format('s4.dynamic.pharmacy.no_in_stock_batches_for', {
                        'name': _chosen!.displayName,
                      }),
                      style: theme.textTheme.bodyMedium,
                    )
                  else ...[
                    DropdownButtonFormField<Map<String, dynamic>>(
                      initialValue: _selectedBatch,
                      isExpanded: true,
                      decoration: InputDecoration(
                        labelText: s.lookup(
                          's4.lib.pharmacy.batch_earliest_expiry_first',
                        ),
                        border: const OutlineInputBorder(),
                      ),
                      items: _batches
                          .map(
                            (b) => DropdownMenuItem(
                              value: b,
                              child: Text(_batchLabel(s, b)),
                            ),
                          )
                          .toList(),
                      onChanged: (b) => setState(() => _selectedBatch = b),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _qtyCtrl,
                      keyboardType: const TextInputType.numberWithOptions(
                        decimal: true,
                      ),
                      decoration: InputDecoration(
                        labelText: s.lookup('s4.lib.pharmacy.quantity'),
                        border: const OutlineInputBorder(),
                      ),
                    ),
                  ],
                ],
              ],
              if (_error != null) ...[
                const SizedBox(height: 12),
                Text(_error!, style: TextStyle(color: theme.colorScheme.error)),
              ],
              const SizedBox(height: 16),
              FilledButton.icon(
                icon: _dispensing
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.check),
                label: Text(s.lookup('s4.lib.pharmacy.dispense_substitute')),
                onPressed:
                    (_dispensing || _chosen == null || _selectedBatch == null)
                    ? null
                    : _dispense,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
