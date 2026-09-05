import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../core/services/idempotency_attempt_registry.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/states/empty_state.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../l10n/app_strings.dart';
import '../models/cath_consumable_models.dart';
import '../services/cath_lab_api_service.dart';
import 'cath_consumable_capture_sheet.dart';
import 'cath_consumable_formatting.dart';
import 'cath_reuse_restriction_strip.dart';

/// One open post-use command identity per usage row, held OUTSIDE the widget
/// tree: a `recordPostUse` that threw may still have been applied server-side,
/// and the panel rebuilds (or the sheet is reopened) between the failure and
/// the retry. A key minted per attempt would make the retry a second command
/// and mint a second batch of CSSD devices; this one replays instead. The
/// scope is completed only on a definitive success, so the NEXT deliberate
/// disposition of the same row is a genuinely separate write.
final IdempotencyAttemptRegistry _cathPostUseAttempts =
    IdempotencyAttemptRegistry();

String _cathPostUseScope(int usageId) => 'cath-post-use-$usageId';

// Cath catalog and batch reads are case-scoped on the backend — the case is
// what pins the facility the operator may see — so both loaders carry the
// ACTIVE case id rather than letting the sheet search across facilities.
typedef CathConsumableCatalogLoader =
    Future<List<CathConsumableCatalogItem>> Function({
      required int caseId,
      String? query,
      String? scan,
    });
typedef CathConsumableBatchLoader = Future<List<CathInventoryBatch>> Function(
  int catalogItemId, {
  required int caseId,
});
typedef CathCaseConsumableLoader =
    Future<List<CathCaseConsumableUsage>> Function(int caseId);
typedef CathConsumableCreator = Future<CathCaseConsumableUsage> Function(
  int caseId,
  CathConsumableUsageDraft draft, {
  required String idempotencyKey,
});
typedef CathConsumableScanner = Future<String?> Function();
// The reuse-aware read of the same route [CathCaseConsumableLoader] hits: it
// keeps the case-level restriction and reprocessable categories the plain
// usage list throws away.
typedef CathCaseConsumablesLoader = Future<CathCaseConsumablesPayload> Function(
  int caseId,
);
typedef CathDeviceLookupFn = Future<CathDeviceLookup> Function(
  int caseId,
  String tag,
);
typedef CathPostUseRecorder = Future<CathPostUseResult> Function(
  int caseId,
  int usageId,
  CathPostUseDraft draft, {
  required String idempotencyKey,
});

class CathConsumableDependencies {
  const CathConsumableDependencies({
    this.searchCatalog,
    this.loadBatches,
    this.loadUsage,
    this.createUsage,
    this.scanCode,
    this.loadConsumables,
    this.lookupDevice,
    this.recordPostUse,
  });

  final CathConsumableCatalogLoader? searchCatalog;
  final CathConsumableBatchLoader? loadBatches;
  final CathCaseConsumableLoader? loadUsage;
  final CathConsumableCreator? createUsage;
  final CathConsumableScanner? scanCode;
  final CathCaseConsumablesLoader? loadConsumables;
  final CathDeviceLookupFn? lookupDevice;
  final CathPostUseRecorder? recordPostUse;
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
  CathReuseRestriction? _restriction;
  Set<String> _reprocessableCategories = const {};

  CathConsumableCatalogLoader get _searchCatalog =>
      widget.dependencies.searchCatalog ??
      CathLabApiService.searchConsumableCatalog;
  CathConsumableBatchLoader get _loadBatches =>
      widget.dependencies.loadBatches ??
      CathLabApiService.fetchConsumableBatches;
  CathConsumableCreator get _createUsage =>
      widget.dependencies.createUsage ??
      CathLabApiService.createConsumableUsage;

  /// An injected [CathConsumableDependencies.loadUsage] still wins, so the
  /// tests written before reuse existed keep working — they simply see a
  /// `clear` restriction and no reprocessable category, which is exactly the
  /// UI a tenant with reprocessing off gets.
  CathCaseConsumablesLoader get _loadConsumables =>
      widget.dependencies.loadConsumables ??
      (widget.dependencies.loadUsage != null
          ? (caseId) async => CathCaseConsumablesPayload(
              usage: await widget.dependencies.loadUsage!(caseId),
              restriction: const CathReuseRestriction(
                status: 'clear',
                reasons: [],
                validityDays: 90,
              ),
              reprocessableCategories: const {},
            )
          : CathLabApiService.fetchCaseConsumablesWithReuse);
  CathDeviceLookupFn get _lookupDevice =>
      widget.dependencies.lookupDevice ??
      CathLabApiService.lookupReusableDevice;
  CathPostUseRecorder get _recordPostUse =>
      widget.dependencies.recordPostUse ?? CathLabApiService.recordPostUse;

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
      final payload = await _loadConsumables(widget.cathCase.id);
      if (!mounted) return;
      setState(() {
        _usage = payload.usage;
        _restriction = payload.restriction;
        _reprocessableCategories = payload.reprocessableCategories;
        _loaded = true;
      });
    } catch (error) {
      if (mounted) setState(() => _error = cathCleanError(error));
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
          reprocessableCategories: _reprocessableCategories,
          restriction: _restriction,
          lookupDevice: _lookupDevice,
          scanCode:
              widget.dependencies.scanCode ??
              () => showCathConsumableScanner(sheetContext),
        ),
      ),
    );
    if (usage == null || !mounted) return;
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
    // Re-read rather than splice the POST's row in: the create response is
    // undecorated, so a spliced row would carry no `allowed_post_use` and the
    // post-use buttons would only appear after a manual collapse/expand.
    await _load();
  }

  Future<void> _openPostUse(
    CathCaseConsumableUsage usage,
    String disposition,
  ) async {
    final options = usage.allowedPostUse;
    if (options == null) return;
    final draft = await showModalBottomSheet<CathPostUseDraft>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      builder: (_) => _PostUseSheet(
        usage: usage,
        disposition: disposition,
        options: options,
        restriction: _restriction,
      ),
    );
    if (draft == null || !mounted) return;
    final scope = _cathPostUseScope(usage.id);
    try {
      final result = await _recordPostUse(
        widget.cathCase.id,
        usage.id,
        draft,
        idempotencyKey: _cathPostUseAttempts.keyFor(scope, draft.toJson()),
      );
      // Only a definitive success ends the attempt. A throw leaves the key
      // open so the operator's retry replays this same command.
      _cathPostUseAttempts.complete(scope);
      if (!mounted) return;
      final s = AppStrings.of(context);
      final alreadyDiscarded = result.deviceAlreadyDiscarded;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            [
              s.lookup(
                alreadyDiscarded
                    ? 's4.lib.cath_lab.consumables.post_use_device_already_discarded'
                    : 's4.lib.cath_lab.consumables.post_use_saved',
              ),
              if (result.deviceTags.isNotEmpty) result.deviceTags.join(', '),
            ].join(' - '),
          ),
          backgroundColor: alreadyDiscarded
              ? AppTheme.warningAmber
              : AppTheme.successGreen,
        ),
      );
      await _load();
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(cathCleanError(error)),
          backgroundColor: AppTheme.errorRed,
        ),
      );
      // The call may have been applied before it failed, so the buttons on
      // screen can no longer be trusted: re-read what the server will accept.
      if (mounted) await _load();
    }
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
                if (_restriction != null && !_restriction!.isClear) ...[
                  const SizedBox(height: 12),
                  CathReuseRestrictionStrip(
                    key: ValueKey(
                      'cath-reuse-restriction-${widget.cathCase.id}',
                    ),
                    restriction: _restriction!,
                  ),
                ],
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
                  for (final usage in _usage)
                    _UsageCard(
                      usage: usage,
                      onPostUse: widget.canAddUsage
                          ? (disposition) => _openPostUse(usage, disposition)
                          : null,
                    ),
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
  const _UsageCard({required this.usage, this.onPostUse});

  final CathCaseConsumableUsage usage;
  final void Function(String disposition)? onPostUse;

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
                    'quantity': cathFormatQuantity(usage.quantity),
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
            if (usage.isReused) ...[
              const SizedBox(height: 6),
              Wrap(
                spacing: 6,
                children: [
                  _UsageChip(
                    label: s.lookup('s4.lib.cath_lab.consumables.reused_badge'),
                    color: AppTheme.primaryBlue,
                  ),
                  if (usage.deviceTag.isNotEmpty)
                    _UsageChip(
                      label: s.format(
                        's4.dynamic.cath_lab.consumables.device_tag',
                        {'tag': usage.deviceTag},
                      ),
                      color: AppTheme.textSecondary,
                    ),
                  if (usage.deviceExposureFlag)
                    _UsageChip(
                      label: s.lookup(
                        's4.lib.cath_lab.consumables.exposure_badge',
                      ),
                      color: AppTheme.errorRed,
                      // The brand red is tuned for a filled surface; body text
                      // on the 12%-alpha chip needs the on-surface token to
                      // clear WCAG AA in both themes.
                      textColor: AppTheme.errorOnSurface,
                    ),
                ],
              ),
            ],
            // The server recomputes what it will accept on every post-use
            // call; these buttons only mirror the last listing it sent.
            if (onPostUse != null &&
                usage.allowedPostUse != null &&
                !usage.allowedPostUse!.isEmpty) ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  if (usage.allowedPostUse!.canReprocess)
                    FilledButton.tonalIcon(
                      key: ValueKey('cath-post-use-reprocess-${usage.id}'),
                      onPressed: () => onPostUse!('reprocess'),
                      icon: const Icon(
                        Icons.local_laundry_service_outlined,
                        size: 18,
                      ),
                      label: Text(
                        s.lookup('s4.lib.cath_lab.consumables.post_use_send'),
                      ),
                    ),
                  if (usage.allowedPostUse!.canReprocess &&
                      usage.allowedPostUse!.canDiscard)
                    const SizedBox(width: 8),
                  if (usage.allowedPostUse!.canDiscard)
                    OutlinedButton.icon(
                      key: ValueKey('cath-post-use-discard-${usage.id}'),
                      onPressed: () => onPostUse!('discard'),
                      icon: const Icon(Icons.delete_outline, size: 18),
                      label: Text(
                        s.lookup(
                          's4.lib.cath_lab.consumables.post_use_discard',
                        ),
                      ),
                    ),
                ],
              ),
            ],
            if (usage.postUseDisposition.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(
                cathHumanize(usage.postUseDisposition),
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Collects the one decision the post-use call needs. Everything the operator
/// may choose is bounded by [options], which the server recomputes anyway —
/// this sheet exists so the common case is one tap and a confirm, not so the
/// client can decide what is allowed.
class _PostUseSheet extends StatefulWidget {
  const _PostUseSheet({
    required this.usage,
    required this.disposition,
    required this.options,
    this.restriction,
  });

  final CathCaseConsumableUsage usage;
  final String disposition;
  final CathPostUseOptions options;
  final CathReuseRestriction? restriction;

  @override
  State<_PostUseSheet> createState() => _PostUseSheetState();
}

/// Mirror of `POST_USE_UNITS_CAP` in
/// `apps/backend/src/services/clinical/cathDeviceReuseService.js` — the
/// absolute number of CSSD devices ONE post-use call may mint. Clamping here
/// keeps the field from offering a number the route would reject outright
/// with `CATH_DEVICE_UNITS_CAP`; the server remains the authority.
const _postUseUnitsCeiling = 50;

class _PostUseSheetState extends State<_PostUseSheet> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _unitsController;
  final _ackController = TextEditingController();
  final _noteController = TextEditingController();
  String? _discardReason;

  bool get _isReprocess => widget.disposition == 'reprocess';

  /// Only a reprocess returns the device to service, so only a reprocess can
  /// need the exposure acknowledgement the backend asks for.
  bool get _requiresAcknowledgement =>
      _isReprocess && widget.options.requiresAcknowledgement;
  int get _unitsMax => widget.options.unitsMax < _postUseUnitsCeiling
      ? widget.options.unitsMax
      : _postUseUnitsCeiling;

  @override
  void initState() {
    super.initState();
    _unitsController = TextEditingController(text: '$_unitsMax');
    _discardReason =
        widget.options.discardReason ?? cathDeviceDiscardReasons.last;
  }

  @override
  void dispose() {
    _unitsController.dispose();
    _ackController.dispose();
    _noteController.dispose();
    super.dispose();
  }

  String? _unitsValidator(String? value) {
    final s = AppStrings.of(context);
    final units = int.tryParse((value ?? '').trim());
    if (units == null || units < 1 || units > _unitsMax) {
      return s.lookup('s4.lib.cath_lab.consumables.quantity_invalid');
    }
    return null;
  }

  String? _requiredValidator(String? value) {
    if ((value ?? '').trim().isNotEmpty) return null;
    return AppStrings.of(context)
        .lookup('s4.lib.cath_lab.consumables.field_required');
  }

  void _confirm() {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    Navigator.pop(
      context,
      CathPostUseDraft(
        disposition: widget.disposition,
        // A zero `units` is refused by the route's positive-integer check,
        // so an exhausted row omits the field and lets the server resolve it.
        units: _isReprocess && _unitsMax >= 1
            ? (_unitsMax <= 1
                  ? _unitsMax
                  : int.parse(_unitsController.text.trim()))
            : null,
        discardReason: _isReprocess ? null : _discardReason,
        discardNote: _isReprocess
            ? null
            : cathNullableText(_noteController.text),
        // The acknowledgement is what lets a device go BACK into service; a
        // discard takes it out of service, so demanding one there would block
        // the safe disposition behind an attestation about reuse.
        acknowledgementReason: _requiresAcknowledgement
            ? cathNullableText(_ackController.text)
            : null,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final reasonLocked = widget.options.discardReason != null;
    return Form(
      key: _formKey,
      child: ListView(
        shrinkWrap: true,
        padding: EdgeInsets.fromLTRB(
          20,
          8,
          20,
          20 + MediaQuery.viewInsetsOf(context).bottom,
        ),
        children: [
          Text(
            s.lookup(
              _isReprocess
                  ? 's4.lib.cath_lab.consumables.post_use_send'
                  : 's4.lib.cath_lab.consumables.post_use_discard',
            ),
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 4),
          Text(
            widget.usage.itemName,
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          if (widget.restriction != null && !widget.restriction!.isClear) ...[
            const SizedBox(height: 12),
            CathReuseRestrictionStrip(restriction: widget.restriction!),
          ],
          if (_isReprocess && _unitsMax > 1) ...[
            const SizedBox(height: 12),
            TextFormField(
              key: const ValueKey('cath-post-use-units'),
              controller: _unitsController,
              keyboardType: TextInputType.number,
              decoration: InputDecoration(
                labelText: s.lookup(
                  's4.lib.cath_lab.consumables.post_use_units',
                ),
                helperText: '1 - $_unitsMax',
              ),
              validator: _unitsValidator,
            ),
          ],
          if (!_isReprocess) ...[
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              key: const ValueKey('cath-post-use-reason'),
              initialValue: _discardReason,
              isExpanded: true,
              decoration: InputDecoration(
                labelText: s.lookup(
                  's4.lib.cath_lab.consumables.post_use_discard_reason',
                ),
              ),
              items: [
                for (final reason in cathDeviceDiscardReasons)
                  DropdownMenuItem(
                    value: reason,
                    child: Text(
                      cathHumanize(reason),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
              ],
              // A reason the backend already fixed (max cycles reached, a
              // blood-borne restriction) is shown, not offered for editing.
              onChanged: reasonLocked
                  ? null
                  : (value) => setState(() => _discardReason = value),
            ),
            const SizedBox(height: 12),
            TextFormField(
              key: const ValueKey('cath-post-use-note'),
              controller: _noteController,
              minLines: 2,
              maxLines: 3,
              decoration: InputDecoration(
                // Not the wastage reason: this note rides a discard
                // disposition, which is a different column and a different
                // decision from opening a unit and not using it.
                labelText: s.lookup(
                  's4.lib.cath_lab.consumables.post_use_note',
                ),
              ),
            ),
          ],
          if (_requiresAcknowledgement) ...[
            const SizedBox(height: 12),
            TextFormField(
              key: const ValueKey('cath-post-use-acknowledgement'),
              controller: _ackController,
              minLines: 2,
              maxLines: 3,
              decoration: InputDecoration(
                labelText: s.lookup(
                  's4.lib.cath_lab.consumables.acknowledgement_label',
                ),
              ),
              validator: _requiredValidator,
            ),
          ],
          const SizedBox(height: 20),
          FilledButton.icon(
            key: const ValueKey('cath-post-use-confirm'),
            onPressed: _confirm,
            icon: const Icon(Icons.check),
            // This confirms a disposition; it does not record a usage row.
            label: Text(
              s.lookup('s4.lib.cath_lab.consumables.post_use_confirm'),
            ),
          ),
        ],
      ),
    );
  }
}

class _UsageChip extends StatelessWidget {
  const _UsageChip({required this.label, required this.color, this.textColor});

  final String label;
  final Color color;

  /// Overrides the label colour where [color] is a filled-surface brand token
  /// that would not meet contrast as text on the chip's tinted background.
  final Color? textColor;

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
          color: textColor ?? color,
          fontSize: 12,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}
