import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/states/empty_state.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../l10n/app_strings.dart';
import '../models/cath_consumable_models.dart';
import '../services/cath_lab_api_service.dart';
import 'cath_consumable_capture_sheet.dart';

typedef CathConsumableCatalogLoader =
    Future<List<CathConsumableCatalogItem>> Function({
      String? query,
      String? scan,
    });
typedef CathConsumableBatchLoader = Future<List<CathInventoryBatch>> Function(
  int catalogItemId,
);
typedef CathCaseConsumableLoader =
    Future<List<CathCaseConsumableUsage>> Function(int caseId);
typedef CathConsumableCreator = Future<CathCaseConsumableUsage> Function(
  int caseId,
  CathConsumableUsageDraft draft, {
  required String idempotencyKey,
});
typedef CathConsumableScanner = Future<String?> Function();

class CathConsumableDependencies {
  const CathConsumableDependencies({
    this.searchCatalog,
    this.loadBatches,
    this.loadUsage,
    this.createUsage,
    this.scanCode,
  });

  final CathConsumableCatalogLoader? searchCatalog;
  final CathConsumableBatchLoader? loadBatches;
  final CathCaseConsumableLoader? loadUsage;
  final CathConsumableCreator? createUsage;
  final CathConsumableScanner? scanCode;
}

class CathCaseConsumablesPanel extends StatefulWidget {
  const CathCaseConsumablesPanel({
    super.key,
    required this.cathCase,
    this.dependencies = const CathConsumableDependencies(),
    this.initiallyExpanded = false,
    this.canAddUsage = true,
  });

  final CathLabCaseSummary cathCase;
  final CathConsumableDependencies dependencies;
  final bool initiallyExpanded;
  final bool canAddUsage;

  @override
  State<CathCaseConsumablesPanel> createState() =>
      _CathCaseConsumablesPanelState();
}

class _CathCaseConsumablesPanelState extends State<CathCaseConsumablesPanel> {
  bool _loaded = false;
  bool _loading = false;
  String? _error;
  List<CathCaseConsumableUsage> _usage = const [];

  CathConsumableCatalogLoader get _searchCatalog =>
      widget.dependencies.searchCatalog ??
      CathLabApiService.searchConsumableCatalog;
  CathConsumableBatchLoader get _loadBatches =>
      widget.dependencies.loadBatches ??
      CathLabApiService.fetchConsumableBatches;
  CathCaseConsumableLoader get _loadUsage =>
      widget.dependencies.loadUsage ??
      CathLabApiService.fetchConsumablesForCase;
  CathConsumableCreator get _createUsage =>
      widget.dependencies.createUsage ??
      CathLabApiService.createConsumableUsage;

  @override
  void initState() {
    super.initState();
    if (widget.initiallyExpanded) _load();
  }

  Future<void> _load() async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final usage = await _loadUsage(widget.cathCase.id);
      if (!mounted) return;
      setState(() {
        _usage = usage;
        _loaded = true;
      });
    } catch (error) {
      if (mounted) setState(() => _error = _cleanError(error));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _openCapture() async {
    final usage = await showModalBottomSheet<CathCaseConsumableUsage>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      builder: (sheetContext) => FractionallySizedBox(
        heightFactor: 0.94,
        child: CathConsumableCaptureSheet(
          caseId: widget.cathCase.id,
          wastageOnly: const {
            'ready',
            'cancelled',
          }.contains(widget.cathCase.status.trim().toLowerCase()),
          searchCatalog: _searchCatalog,
          loadBatches: _loadBatches,
          createUsage: _createUsage,
          scanCode:
              widget.dependencies.scanCode ??
              () => showCathConsumableScanner(sheetContext),
        ),
      ),
    );
    if (usage == null || !mounted) return;
    setState(() {
      _loaded = true;
      _error = null;
      _usage = [usage, ..._usage.where((existing) => existing.id != usage.id)];
    });
    final s = AppStrings.of(context);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          usage.hasInventoryWarning
              ? s.format('s4.dynamic.cath_lab.consumables.saved_warning', {
                  'warning': usage.inventoryWarning,
                })
              : s.lookup('s4.lib.cath_lab.consumables.saved'),
        ),
        backgroundColor: usage.hasInventoryWarning
            ? AppTheme.warningAmber
            : AppTheme.successGreen,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      clipBehavior: Clip.antiAlias,
      child: ExpansionTile(
        key: ValueKey('cath-consumables-expand-${widget.cathCase.id}'),
        initiallyExpanded: widget.initiallyExpanded,
        onExpansionChanged: (expanded) {
          if (expanded && !_loaded) _load();
        },
        leading: const Icon(Icons.inventory_2_outlined),
        title: Text(
          widget.cathCase.requestedProcedure.isEmpty
              ? s.lookup('s4.lib.cath_lab.procedure_not_set')
              : widget.cathCase.requestedProcedure,
          style: const TextStyle(fontWeight: FontWeight.w700),
        ),
        subtitle: Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Wrap(
            spacing: 12,
            runSpacing: 4,
            children: [
              Text(
                s.format('s4.lib.cath_lab.procedure_logs_count', {
                  'count': widget.cathCase.procedureCount,
                }),
              ),
              Text(
                s.format('s4.lib.cath_lab.device_links_count', {
                  'count': widget.cathCase.deviceLinkCount,
                }),
              ),
              if (_loaded)
                Text(
                  s.format('s4.dynamic.cath_lab.consumables.usage_count', {
                    'count': _usage.length,
                  }),
                ),
            ],
          ),
        ),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (widget.canAddUsage)
                  Align(
                    alignment: Alignment.centerRight,
                    child: FilledButton.icon(
                      key: ValueKey(
                        'cath-consumables-add-${widget.cathCase.id}',
                      ),
                      onPressed: _openCapture,
                      icon: const Icon(Icons.add),
                      label: Text(s.lookup('s4.lib.cath_lab.consumables.add')),
                    ),
                  ),
                if (_loading) ...[
                  const SizedBox(height: 16),
                  const LinearProgressIndicator(),
                  const SizedBox(height: 8),
                  Text(
                    s.lookup('s4.lib.cath_lab.consumables.loading_usage'),
                    textAlign: TextAlign.center,
                  ),
                ] else if (_error != null) ...[
                  SizedBox(
                    height: 220,
                    child: ErrorState(message: _error!, onRetry: _load),
                  ),
                ] else if (_loaded && _usage.isEmpty) ...[
                  SizedBox(
                    height: 210,
                    child: EmptyState(
                      icon: Icons.inventory_2_outlined,
                      title: s.lookup('s4.lib.cath_lab.consumables.no_usage'),
                    ),
                  ),
                ] else ...[
                  const SizedBox(height: 12),
                  for (final usage in _usage) _UsageCard(usage: usage),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _UsageCard extends StatelessWidget {
  const _UsageCard({required this.usage});

  final CathCaseConsumableUsage usage;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final batch = usage.lotNumber.isNotEmpty
        ? usage.lotNumber
        : usage.batchNumber;
    return Card(
      key: ValueKey('cath-consumable-usage-${usage.id}'),
      color: usage.wasted
          ? AppTheme.warningAmber.withValues(alpha: 0.06)
          : null,
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Text(
                    usage.itemName,
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                ),
                _UsageChip(
                  label: s.format('s4.dynamic.cath_lab.consumables.quantity', {
                    'quantity': _formatQuantity(usage.quantity),
                    'unit': usage.unitLabel,
                  }),
                  color: AppTheme.primaryBlue,
                ),
                if (usage.wasted) ...[
                  const SizedBox(width: 6),
                  _UsageChip(
                    label: s.lookup('s4.lib.cath_lab.consumables.wasted_badge'),
                    color: AppTheme.warningAmber,
                  ),
                ],
              ],
            ),
            if (batch.isNotEmpty || usage.expiryDate != null) ...[
              const SizedBox(height: 8),
              Text(
                [
                  if (batch.isNotEmpty)
                    s.format('s4.dynamic.cath_lab.consumables.batch', {
                      'batch': batch,
                    }),
                  if (usage.expiryDate != null)
                    s.format('s4.dynamic.cath_lab.consumables.expiry', {
                      'expiry': DateFormat('yyyy-MM-dd')
                          .format(usage.expiryDate!),
                    }),
                ].join(' - '),
                style: TextStyle(color: AppTheme.textSecondary),
              ),
            ],
            if (usage.serialNumber.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(
                s.format('s4.dynamic.cath_lab.consumables.serial', {
                  'serial': usage.serialNumber,
                }),
                style: TextStyle(color: AppTheme.textSecondary),
              ),
            ],
            if (usage.wastageReason.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(usage.wastageReason),
            ],
            if (usage.usedByName.isNotEmpty || usage.recordedAt != null) ...[
              const SizedBox(height: 8),
              Text(
                [
                  if (usage.usedByName.isNotEmpty) usage.usedByName,
                  if (usage.recordedAt != null)
                    DateFormat('dd MMM yyyy, hh:mm a')
                        .format(usage.recordedAt!),
                ].join(' - '),
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
            if (usage.hasInventoryWarning) ...[
              const SizedBox(height: 8),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: AppTheme.warningAmber.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(Icons.warning_amber_outlined, size: 18),
                    const SizedBox(width: 8),
                    Expanded(child: Text(usage.inventoryWarning)),
                  ],
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _UsageChip extends StatelessWidget {
  const _UsageChip({required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontSize: 12,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

String _formatQuantity(double value) {
  return value == value.roundToDouble()
      ? value.toInt().toString()
      : value
            .toStringAsFixed(2)
            .replaceFirst(RegExp(r'0+$'), '')
            .replaceFirst(RegExp(r'\.$'), '');
}

String _cleanError(Object error) {
  return error.toString().replaceFirst(RegExp(r'^Exception:\s*'), '');
}
