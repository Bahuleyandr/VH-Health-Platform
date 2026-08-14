import 'dart:async';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:vhhealth_core/services/idempotency_key.dart';

import '../../../core/theme/app_theme.dart';
import '../../../l10n/app_strings.dart';
import '../models/cath_consumable_models.dart';

class CathConsumableCaptureSheet extends StatefulWidget {
  const CathConsumableCaptureSheet({
    super.key,
    required this.caseId,
    required this.searchCatalog,
    required this.loadBatches,
    required this.createUsage,
    required this.scanCode,
    this.wastageOnly = false,
  });

  final int caseId;
  final Future<List<CathConsumableCatalogItem>> Function({
    String? query,
    String? scan,
  })
  searchCatalog;
  final Future<List<CathInventoryBatch>> Function(int catalogItemId)
  loadBatches;
  final Future<CathCaseConsumableUsage> Function(
    int caseId,
    CathConsumableUsageDraft draft, {
    required String idempotencyKey,
  })
  createUsage;
  final Future<String?> Function() scanCode;
  final bool wastageOnly;

  @override
  State<CathConsumableCaptureSheet> createState() =>
      _CathConsumableCaptureSheetState();
}

class _CathConsumableCaptureSheetState
    extends State<CathConsumableCaptureSheet> {
  final _formKey = GlobalKey<FormState>();
  final _searchController = TextEditingController();
  final _quantityController = TextEditingController(text: '1');
  final _batchController = TextEditingController();
  final _lotController = TextEditingController();
  final _expiryController = TextEditingController();
  final _serialController = TextEditingController();
  final _wastageReasonController = TextEditingController();
  Timer? _debounce;
  int _searchGeneration = 0;
  CathConsumableCatalogItem? _selectedItem;
  List<CathConsumableCatalogItem> _suggestions = const [];
  List<CathInventoryBatch> _batches = const [];
  int? _selectedBatchId;
  DateTime? _expiryDate;
  bool _searching = false;
  bool _scanning = false;
  bool _loadingBatches = false;
  bool _wasted = false;
  bool _saving = false;
  final _captureAttempt = IdempotencyAttempt('cath-consumable-usage');
  String? _error;

  @override
  void initState() {
    super.initState();
    _wasted = widget.wastageOnly;
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _searchController.dispose();
    _quantityController.dispose();
    _batchController.dispose();
    _lotController.dispose();
    _expiryController.dispose();
    _serialController.dispose();
    _wastageReasonController.dispose();
    super.dispose();
  }

  void _onSearchChanged(String value) {
    _debounce?.cancel();
    final query = value.trim();
    if (query.length < 2) {
      _searchGeneration++;
      setState(() {
        _suggestions = const [];
        _searching = false;
      });
      return;
    }
    _debounce = Timer(
      const Duration(milliseconds: 250),
      () => _search(query: query),
    );
  }

  Future<void> _search({String? query, String? scan}) async {
    final generation = ++_searchGeneration;
    setState(() {
      _searching = true;
      _error = null;
    });
    try {
      final items = await widget.searchCatalog(query: query, scan: scan);
      if (!mounted || generation != _searchGeneration) return;
      if (scan != null && items.length == 1) {
        await _selectItem(items.single);
        return;
      }
      setState(() => _suggestions = items);
    } catch (error) {
      if (!mounted || generation != _searchGeneration) return;
      setState(() {
        _suggestions = const [];
        _error = _cleanError(error);
      });
    } finally {
      if (mounted && generation == _searchGeneration) {
        setState(() => _searching = false);
      }
    }
  }

  Future<void> _scan() async {
    if (_scanning || _saving) return;
    setState(() {
      _scanning = true;
      _error = null;
    });
    try {
      final code = await widget.scanCode();
      if (!mounted || code == null || code.trim().isEmpty) return;
      _searchController.text = code.trim();
      _searchController.selection = TextSelection.collapsed(
        offset: _searchController.text.length,
      );
      await _search(scan: code.trim());
    } catch (error) {
      if (mounted) setState(() => _error = _cleanError(error));
    } finally {
      if (mounted) setState(() => _scanning = false);
    }
  }

  Future<void> _selectItem(CathConsumableCatalogItem item) async {
    _searchGeneration++;
    _debounce?.cancel();
    setState(() {
      _selectedItem = item;
      _suggestions = const [];
      _batches = const [];
      _selectedBatchId = null;
      _batchController.clear();
      _lotController.clear();
      _expiryController.clear();
      _expiryDate = null;
      _serialController.clear();
      _error = null;
      _searching = false;
    });
    if (!item.batchTracked) return;
    setState(() => _loadingBatches = true);
    try {
      final batches = await widget.loadBatches(item.id);
      if (!mounted || _selectedItem?.id != item.id) return;
      setState(() => _batches = batches);
    } catch (error) {
      if (mounted && _selectedItem?.id == item.id) {
        setState(() {
          _batches = const [];
          _error = _cleanError(error);
        });
      }
    } finally {
      if (mounted && _selectedItem?.id == item.id) {
        setState(() => _loadingBatches = false);
      }
    }
  }

  void _clearItem() {
    setState(() {
      _selectedItem = null;
      _batches = const [];
      _selectedBatchId = null;
      _batchController.clear();
      _lotController.clear();
      _expiryController.clear();
      _expiryDate = null;
      _serialController.clear();
      _searchController.clear();
      _error = null;
    });
  }

  void _selectBatch(int? id) {
    final batch = id == null
        ? null
        : _batches.cast<CathInventoryBatch?>().firstWhere(
            (candidate) => candidate?.id == id,
            orElse: () => null,
          );
    setState(() {
      _selectedBatchId = batch?.id;
      _batchController.text = batch?.batchNumber ?? '';
      _lotController.text = batch?.lotNumber ?? '';
      _expiryDate = batch?.expiryDate;
      _expiryController.text = batch?.expiryDate == null
          ? ''
          : DateFormat('yyyy-MM-dd').format(batch!.expiryDate!);
    });
  }

  Future<void> _pickExpiryDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _expiryDate ?? now.add(const Duration(days: 365)),
      firstDate: now.subtract(const Duration(days: 3650)),
      lastDate: now.add(const Duration(days: 7300)),
    );
    if (picked == null || !mounted) return;
    setState(() {
      _expiryDate = picked;
      _expiryController.text = DateFormat('yyyy-MM-dd').format(picked);
    });
  }

  Future<void> _save() async {
    final item = _selectedItem;
    if (item == null) {
      setState(
        () => _error = AppStrings.of(
          context,
        ).lookup('s4.lib.cath_lab.consumables.select_required'),
      );
      return;
    }
    if (!(_formKey.currentState?.validate() ?? false) || _saving) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final draft = CathConsumableUsageDraft(
        catalogItemId: item.id,
        quantity: double.parse(_quantityController.text.trim()),
        inventoryBatchId: _selectedBatchId,
        batchNumber: _nullableText(_batchController.text),
        lotNumber: _nullableText(_lotController.text),
        expiryDate: _expiryDate,
        serialNumber: _nullableText(_serialController.text),
        wasted: _wasted,
        wastageReason: _wasted
            ? _nullableText(_wastageReasonController.text)
            : null,
      );
      final usage = await widget.createUsage(
        widget.caseId,
        draft,
        // One key per capture attempt: `_saving` blocks a second tap, this
        // makes a retry of a lost-2xx replay instead of double-consuming stock.
        idempotencyKey: _captureAttempt.keyFor(draft.toJson()),
      );
      if (mounted) Navigator.pop(context, usage);
    } catch (error) {
      if (mounted) setState(() => _error = _cleanError(error));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  String? _quantityValidator(String? value) {
    final quantity = double.tryParse((value ?? '').trim());
    if (quantity == null || quantity <= 0) {
      return AppStrings.of(
        context,
      ).lookup('s4.lib.cath_lab.consumables.quantity_invalid');
    }
    return null;
  }

  String? _requiredValidator(String? value) {
    if ((value ?? '').trim().isNotEmpty) return null;
    return AppStrings.of(
      context,
    ).lookup('s4.lib.cath_lab.consumables.field_required');
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final item = _selectedItem;
    return Form(
      key: _formKey,
      child: ListView(
        padding: EdgeInsets.fromLTRB(
          20,
          8,
          20,
          20 + MediaQuery.viewInsetsOf(context).bottom,
        ),
        children: [
          Text(
            s.lookup('s4.lib.cath_lab.consumables.capture_title'),
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 16),
          if (item == null) ...[
            TextFormField(
              key: const ValueKey('cath-consumable-search'),
              controller: _searchController,
              onChanged: _onSearchChanged,
              textInputAction: TextInputAction.search,
              decoration: InputDecoration(
                labelText: s.lookup('s4.lib.cath_lab.consumables.search_label'),
                hintText: s.lookup('s4.lib.cath_lab.consumables.search_hint'),
                prefixIcon: const Icon(Icons.search),
                suffixIcon: IconButton(
                  key: const ValueKey('cath-consumable-scan'),
                  tooltip: s.lookup('s4.lib.cath_lab.consumables.scan_tooltip'),
                  onPressed: _scanning ? null : _scan,
                  icon: _scanning
                      ? const Padding(
                          padding: EdgeInsets.all(10),
                          child: SizedBox.square(
                            dimension: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          ),
                        )
                      : const Icon(Icons.qr_code_scanner),
                ),
              ),
            ),
            if (_searching) const LinearProgressIndicator(),
            if (_suggestions.isNotEmpty)
              Card(
                margin: const EdgeInsets.only(top: 8),
                child: ListView.separated(
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  itemCount: _suggestions.length,
                  separatorBuilder: (_, _) => const Divider(height: 1),
                  itemBuilder: (context, index) {
                    final suggestion = _suggestions[index];
                    return ListTile(
                      key: ValueKey('cath-consumable-option-${suggestion.id}'),
                      dense: true,
                      title: Text(suggestion.itemName),
                      subtitle: suggestion.supportingLabel.isEmpty
                          ? null
                          : Text(suggestion.supportingLabel),
                      trailing: suggestion.batchTracked
                          ? const Icon(Icons.inventory_2_outlined, size: 20)
                          : null,
                      onTap: () => _selectItem(suggestion),
                    );
                  },
                ),
              ),
          ] else ...[
            Card(
              color: AppTheme.primaryBlue.withValues(alpha: 0.06),
              child: ListTile(
                key: const ValueKey('cath-consumable-selected-item'),
                leading: Icon(
                  item.isImplant
                      ? Icons.medical_information_outlined
                      : Icons.inventory_2_outlined,
                ),
                title: Text(item.itemName),
                subtitle: Text(
                  [
                    _categoryLabel(s, item.category),
                    if (item.supportingLabel.isNotEmpty) item.supportingLabel,
                  ].join(' - '),
                ),
                trailing: IconButton(
                  tooltip: s.lookup('s4.lib.cath_lab.consumables.change_item'),
                  onPressed: _saving ? null : _clearItem,
                  icon: const Icon(Icons.close),
                ),
              ),
            ),
            const SizedBox(height: 12),
            TextFormField(
              key: const ValueKey('cath-consumable-quantity'),
              controller: _quantityController,
              keyboardType: const TextInputType.numberWithOptions(
                decimal: true,
              ),
              decoration: InputDecoration(
                labelText: s.lookup(
                  's4.lib.cath_lab.consumables.quantity_label',
                ),
                suffixText: item.unitLabel,
              ),
              validator: _quantityValidator,
            ),
            if (item.batchTracked) ...[
              const SizedBox(height: 12),
              if (_loadingBatches) ...[
                const LinearProgressIndicator(),
                const SizedBox(height: 8),
                Text(s.lookup('s4.lib.cath_lab.consumables.loading_batches')),
              ] else if (_batches.isNotEmpty) ...[
                DropdownButtonFormField<int>(
                  key: const ValueKey('cath-consumable-batch-picker'),
                  initialValue: _selectedBatchId,
                  isExpanded: true,
                  decoration: InputDecoration(
                    labelText: s.lookup(
                      's4.lib.cath_lab.consumables.batch_label',
                    ),
                  ),
                  items: [
                    for (final batch in _batches)
                      DropdownMenuItem(
                        value: batch.id,
                        child: Text(
                          _batchLabel(s, batch),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                  ],
                  onChanged: _saving ? null : _selectBatch,
                  validator: (value) => value == null
                      ? s.lookup('s4.lib.cath_lab.consumables.batch_required')
                      : null,
                ),
                const SizedBox(height: 12),
                TextFormField(
                  key: const ValueKey('cath-consumable-batch-expiry'),
                  controller: _expiryController,
                  readOnly: true,
                  decoration: InputDecoration(
                    labelText: s.lookup(
                      's4.lib.cath_lab.consumables.expiry_label',
                    ),
                  ),
                  validator: _requiredValidator,
                ),
              ] else ...[
                Text(
                  s.lookup('s4.lib.cath_lab.consumables.manual_batch_hint'),
                  style: TextStyle(color: AppTheme.warningOnSurface),
                ),
                const SizedBox(height: 8),
                TextFormField(
                  key: const ValueKey('cath-consumable-manual-batch'),
                  controller: _batchController,
                  decoration: InputDecoration(
                    labelText: s.lookup(
                      's4.lib.cath_lab.consumables.batch_number_label',
                    ),
                  ),
                  validator: _requiredValidator,
                ),
                const SizedBox(height: 12),
                TextFormField(
                  key: const ValueKey('cath-consumable-manual-lot'),
                  controller: _lotController,
                  decoration: InputDecoration(
                    labelText: s.lookup(
                      's4.lib.cath_lab.consumables.lot_number_label',
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  key: const ValueKey('cath-consumable-manual-expiry'),
                  controller: _expiryController,
                  readOnly: true,
                  onTap: _pickExpiryDate,
                  decoration: InputDecoration(
                    labelText: s.lookup(
                      's4.lib.cath_lab.consumables.expiry_label',
                    ),
                    suffixIcon: const Icon(Icons.calendar_today_outlined),
                  ),
                  validator: _requiredValidator,
                ),
              ],
            ],
            if (item.isImplant) ...[
              const SizedBox(height: 12),
              TextFormField(
                key: const ValueKey('cath-consumable-serial-number'),
                controller: _serialController,
                decoration: InputDecoration(
                  labelText: s.lookup(
                    's4.lib.cath_lab.consumables.serial_number_label',
                  ),
                ),
                validator: _requiredValidator,
              ),
            ],
            const SizedBox(height: 8),
            SwitchListTile.adaptive(
              key: const ValueKey('cath-consumable-wastage-toggle'),
              contentPadding: EdgeInsets.zero,
              title: Text(
                s.lookup('s4.lib.cath_lab.consumables.wastage_label'),
              ),
              subtitle: Text(
                s.lookup('s4.lib.cath_lab.consumables.wastage_hint'),
              ),
              value: _wasted,
              onChanged: _saving || widget.wastageOnly
                  ? null
                  : (value) => setState(() => _wasted = value),
            ),
            if (_wasted) ...[
              const SizedBox(height: 8),
              TextFormField(
                key: const ValueKey('cath-consumable-wastage-reason'),
                controller: _wastageReasonController,
                minLines: 2,
                maxLines: 4,
                decoration: InputDecoration(
                  labelText: s.lookup(
                    's4.lib.cath_lab.consumables.wastage_reason_label',
                  ),
                ),
                validator: _requiredValidator,
              ),
            ],
          ],
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(
              _error!,
              key: const ValueKey('cath-consumable-error'),
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ],
          const SizedBox(height: 20),
          FilledButton.icon(
            key: const ValueKey('cath-consumable-save'),
            onPressed: item == null || _saving ? null : _save,
            icon: _saving
                ? const SizedBox.square(
                    dimension: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.save_outlined),
            label: Text(
              _saving
                  ? s.lookup('s4.lib.cath_lab.consumables.saving')
                  : s.lookup('s4.lib.cath_lab.consumables.save'),
            ),
          ),
        ],
      ),
    );
  }
}

Future<String?> showCathConsumableScanner(BuildContext context) {
  return showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    builder: (_) => const FractionallySizedBox(
      heightFactor: 0.82,
      child: _CathConsumableScanner(),
    ),
  );
}

class _CathConsumableScanner extends StatefulWidget {
  const _CathConsumableScanner();

  @override
  State<_CathConsumableScanner> createState() => _CathConsumableScannerState();
}

class _CathConsumableScannerState extends State<_CathConsumableScanner> {
  final _controller = MobileScannerController(
    detectionSpeed: DetectionSpeed.noDuplicates,
  );
  bool _locked = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_locked || capture.barcodes.isEmpty) return;
    final value = capture.barcodes.first.rawValue?.trim() ?? '';
    if (value.isEmpty) return;
    _locked = true;
    Navigator.pop(context, value);
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Column(
      children: [
        ListTile(
          leading: const Icon(Icons.qr_code_scanner),
          title: Text(s.lookup('s4.lib.cath_lab.consumables.scan_title')),
          subtitle: Text(s.lookup('s4.lib.cath_lab.consumables.scan_hint')),
          trailing: IconButton(
            tooltip: s.actionClose,
            onPressed: () => Navigator.pop(context),
            icon: const Icon(Icons.close),
          ),
        ),
        const Divider(height: 1),
        Expanded(
          child: MobileScanner(controller: _controller, onDetect: _onDetect),
        ),
      ],
    );
  }
}

String _batchLabel(AppStrings s, CathInventoryBatch batch) {
  final expiry = batch.expiryDate == null
      ? s.lookup('s4.lib.cath_lab.consumables.expiry_unknown')
      : DateFormat('yyyy-MM-dd').format(batch.expiryDate!);
  final quantity = _formatQuantity(batch.remainingQuantity);
  return s.format('s4.dynamic.cath_lab.consumables.batch_option', {
    'batch': batch.batchNumber,
    'expiry': expiry,
    'quantity': quantity,
  });
}

String _formatQuantity(double value) {
  return value == value.roundToDouble()
      ? value.toInt().toString()
      : value
            .toStringAsFixed(2)
            .replaceFirst(RegExp(r'0+$'), '')
            .replaceFirst(RegExp(r'\.$'), '');
}

String _humanize(String value) {
  final text = value.replaceAll('_', ' ').trim();
  if (text.isEmpty) return '-';
  return text
      .split(' ')
      .map(
        (part) => part.isEmpty
            ? part
            : '${part[0].toUpperCase()}${part.substring(1)}',
      )
      .join(' ');
}

const _categoryStringKeys = {
  'stent': 's4.lib.cath_lab.consumables.category.stent',
  'balloon': 's4.lib.cath_lab.consumables.category.balloon',
  'guidewire': 's4.lib.cath_lab.consumables.category.guidewire',
  'catheter': 's4.lib.cath_lab.consumables.category.catheter',
  'sheath': 's4.lib.cath_lab.consumables.category.sheath',
  'closure_device': 's4.lib.cath_lab.consumables.category.closure_device',
  'pacemaker': 's4.lib.cath_lab.consumables.category.pacemaker',
  'lead': 's4.lib.cath_lab.consumables.category.lead',
  'other': 's4.lib.cath_lab.consumables.category.other',
};

String _categoryLabel(AppStrings strings, String value) {
  final key = _categoryStringKeys[value];
  return key == null ? _humanize(value) : strings.lookup(key);
}

String? _nullableText(String value) {
  final text = value.trim();
  return text.isEmpty ? null : text;
}

String _cleanError(Object error) {
  return error.toString().replaceFirst(RegExp(r'^Exception:\s*'), '');
}
