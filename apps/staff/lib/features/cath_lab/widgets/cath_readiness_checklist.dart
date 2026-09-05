import 'dart:async';

import 'package:flutter/material.dart';

import '../../../core/theme/app_theme.dart';
import '../../../l10n/app_strings.dart';
import '../models/cath_readiness_models.dart';
import '../services/cath_lab_api_service.dart';
import 'cath_consumable_formatting.dart';
import 'cath_lab_readiness_panel.dart';
import 'cath_readiness_formatting.dart';

typedef CathReadinessLoader = Future<CathCaseReadiness> Function(int caseId);

typedef CathReadinessCheckUpdater = Future<void> Function(
  int caseId, {
  required String checkType,
  required String status,
  String? notes,
});

/// Injectable dependency bundle for the readiness surface, mirroring
/// `CathQuickWinsDependencies`. Every member defaults to the corresponding
/// [CathLabApiService] static, so production wiring passes nothing.
class CathReadinessDependencies {
  const CathReadinessDependencies({
    this.loadReadiness,
    this.updateCheck,
    this.orderMissing,
    this.recordExternal,
    this.waiveItem,
  });

  final CathReadinessLoader? loadReadiness;
  final CathReadinessCheckUpdater? updateCheck;
  final CathReadinessOrderMissing? orderMissing;
  final CathReadinessExternalRecorder? recordExternal;
  final CathReadinessWaiver? waiveItem;
}

/// The per-check readiness list for one cath case: the eight
/// `cath_lab_readiness_checks` rows with their human status control, and — on
/// the `labs` check — the critical-value badge and the seven-item lab panel
/// that explains WHY the check reads the way it does.
///
/// The labs check is auto-managed by the backend: the list renders its status,
/// it does not compute one. A human may still override it from the same
/// control as any other check; the next refresh decides whether that override
/// survives.
class CathReadinessChecklist extends StatefulWidget {
  const CathReadinessChecklist({
    super.key,
    required this.caseId,
    this.dependencies = const CathReadinessDependencies(),
    this.signals,
    this.today,
  });

  final int caseId;
  final CathReadinessDependencies dependencies;

  /// Optional sink for the case header above this list: the readiness this
  /// list has actually loaded, or null while it is unknown (not loaded yet,
  /// rebound to another case, or the last read failed).
  ///
  /// A notifier rather than a callback so publishing does not rebuild the card
  /// around the list, and so "we do not know" is representable — the header
  /// must never render "nothing missing" from a failed read.
  final ValueNotifier<CathCaseReadiness?>? signals;

  /// Injectable "today" for the outside-result sheet's date field.
  final DateTime? today;

  @override
  State<CathReadinessChecklist> createState() => _CathReadinessChecklistState();
}

class _CathReadinessChecklistState extends State<CathReadinessChecklist>
    with AutomaticKeepAliveClientMixin {
  CathCaseReadiness? _readiness;
  bool _loading = false;
  bool _reloadPending = false;
  bool _busy = false;
  String? _error;

  /// Every GET on this surface is a read-through refresh server-side: it
  /// re-resolves the seven items, may flip the `labs` check and writes an
  /// audit row. Scrolling a case off-screen and back must therefore not
  /// dispose and re-fetch it.
  @override
  bool get wantKeepAlive => true;

  CathReadinessLoader get _load =>
      widget.dependencies.loadReadiness ?? CathLabApiService.fetchCaseReadiness;
  CathReadinessCheckUpdater get _updateCheck =>
      widget.dependencies.updateCheck ?? CathLabApiService.updateReadinessCheck;
  CathReadinessOrderMissing get _orderMissing =>
      widget.dependencies.orderMissing ?? CathLabApiService.orderMissingLabs;
  CathReadinessExternalRecorder get _recordExternal =>
      widget.dependencies.recordExternal ??
      CathLabApiService.recordExternalLabResult;
  CathReadinessWaiver get _waiveItem =>
      widget.dependencies.waiveItem ?? CathLabApiService.waiveLabItem;

  @override
  void initState() {
    super.initState();
    unawaited(_reload());
  }

  /// The cases list is rebuilt against a DIFFERENT case whenever the date
  /// changes, the list is pulled to refresh, or a poll replaces it. Without
  /// this, a retained State keeps rendering the previous case's items while
  /// every write the row offers targets the new case's id — the worst possible
  /// combination, since the screen looks right while the writes land on the
  /// wrong patient.
  @override
  void didUpdateWidget(covariant CathReadinessChecklist oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.caseId == widget.caseId) return;
    setState(() {
      _readiness = null;
      _error = null;
      _busy = false;
    });
    // Published out of band: the header that listens to `signals` is a sibling
    // the framework may already have built this frame, and marking it dirty
    // from inside didUpdateWidget would be a markNeedsBuild during its build.
    scheduleMicrotask(() => _publish(null));
    unawaited(_reload());
  }

  void _publish(CathCaseReadiness? value) {
    if (!mounted) return;
    widget.signals?.value = value;
  }

  Future<void> _reload() async {
    if (_loading) {
      // Coalesce rather than drop. The in-flight read may have been ISSUED
      // before the write that prompted this one, so its answer can be the
      // pre-write state; dropping this refresh would leave that on screen.
      _reloadPending = true;
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    final caseId = widget.caseId;
    CathCaseReadiness? loaded;
    var failed = false;
    try {
      loaded = await _load(caseId);
    } catch (_) {
      failed = true;
    }
    if (!mounted) return;
    if (caseId == widget.caseId) {
      setState(() {
        _loading = false;
        if (failed) {
          _error = AppStrings.of(context)
              .lookup('s4.lib.cath_lab.readiness.load_failed');
        } else {
          _readiness = loaded;
          _error = null;
        }
      });
      _publish(failed ? null : loaded);
    } else {
      // Rebound mid-flight: this answer is about the previous case, so it is
      // dropped and the reload didUpdateWidget queued takes over.
      _loading = false;
      _reloadPending = true;
    }
    if (_reloadPending) {
      _reloadPending = false;
      await _reload();
    }
  }

  Future<void> _setStatus(
    CathReadinessCheck check,
    CathLabReadiness? labs,
    String status,
  ) async {
    if (_busy || status == check.status) return;
    final s = AppStrings.of(context);
    String? notes;
    // `pending` is the only status that does not move the start gate, so it is
    // the only one that goes straight through. Everything else is a clinical
    // assertion and is confirmed first.
    if (status != 'pending') {
      final critical =
          check.checkType == 'labs' &&
          status == 'pass' &&
          (check.criticalWarning || labs?.criticalWarning == true);
      final result = await showDialog<_CathReadinessConfirmResult>(
        context: context,
        builder: (dialogContext) => _CathReadinessConfirmDialog(
          title: s.lookup('s4.lib.cath_lab.readiness.confirm_title'),
          body: s.format('s4.lib.cath_lab.readiness.confirm_body', {
            'check': cathReadinessCheckLabel(s, check.checkType),
            'status': cathReadinessCheckStatusLabel(s, status),
          }),
          // Naming the items is the point: "critical value" alone does not
          // tell the person passing the check WHICH value they are passing.
          criticalLine: critical
              ? s.format('s4.lib.cath_lab.readiness.confirm_critical', {
                  'items': cathReadinessItemList(
                    s,
                    labs?.criticalItems ?? const <String>[],
                  ),
                })
              : null,
          automationNote:
              check.checkType == 'labs' &&
                  (check.autoManaged || labs?.autoManaged == true)
              ? s.lookup('s4.lib.cath_lab.readiness.auto_managed_note')
              : null,
          reasonRequired: critical,
          notesLabel: critical
              ? s.lookup('s4.lib.cath_lab.readiness.confirm_reason')
              : s.lookup('s4.lib.cath_lab.readiness.confirm_notes'),
          reasonRequiredLabel: s.lookup(
            's4.lib.cath_lab.readiness.reason_required',
          ),
          cancelLabel: s.actionCancel,
          confirmLabel: s.lookup('s4.lib.cath_lab.readiness.confirm_action'),
        ),
      );
      if (result == null || !mounted) return;
      notes = result.notes;
    }
    setState(() => _busy = true);
    try {
      await _updateCheck(
        widget.caseId,
        checkType: check.checkType,
        status: status,
        notes: notes,
      );
      if (!mounted) return;
      await _reload();
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            error is Exception
                ? cathCleanError(error)
                : s.lookup('s4.lib.cath_lab.readiness.update_failed'),
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// A lab write answers with the refreshed lab block. It is adopted straight
  /// away so the panel does not flicker back to the old rows — including the
  /// `labs` CHECK row, whose status, critical flag and automation ownership
  /// the same block carries. Then the whole case is re-read: the write can
  /// also move the start gate, which lives outside this block.
  void _onLabsChanged(CathLabReadiness labs) {
    final current = _readiness;
    if (current != null) {
      final next = CathCaseReadiness(
        checks: [
          for (final check in current.checks)
            if (check.checkType == 'labs')
              check.copyWith(
                status: labs.checkStatus,
                criticalWarning: labs.criticalWarning,
                autoManaged: labs.autoManaged,
              )
            else
              check,
        ],
        // The gate is NOT guessed from here: `readiness_gate.ready` is
        // computed across all eight checks and only the case read knows it.
        ready: current.ready,
        labs: labs,
      );
      setState(() => _readiness = next);
      _publish(next);
    }
    // Fire-and-forget: the write has already reported its own outcome, and
    // awaiting the refresh inside a `ValueChanged` callback would swallow its
    // error somewhere the operator cannot see it. `_reload` surfaces its own
    // failure inline instead.
    unawaited(_reload());
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final s = AppStrings.of(context);
    final readiness = _readiness;
    final error = _error;
    if (readiness == null || readiness.isEmpty) {
      if (error == null) {
        // Nothing to say yet: the card's own progress row already carries the
        // cleared/total count, so a second spinner would only add noise.
        return const SizedBox.shrink();
      }
      return Padding(
        padding: const EdgeInsets.only(top: 12),
        child: _errorRow(s, error),
      );
    }

    final labs = readiness.labs;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Divider(height: 20),
        Text(
          s.lookup('s4.lib.cath_lab.readiness.checks_title'),
          style: TextStyle(
            fontWeight: FontWeight.w700,
            color: AppTheme.textPrimary,
          ),
        ),
        // A refresh that failed AFTER a write left the rows below standing:
        // the statuses, the critical badge and the gate are all as they were
        // before the write. Saying so inline is the difference between stale
        // and wrong.
        if (error != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: _errorRow(s, error),
          ),
        for (final check in readiness.checks) ...[
          _checkTile(s, check, labs),
          if (check.checkType == 'labs' && labs != null)
            CathLabReadinessPanel(
              caseId: widget.caseId,
              labs: labs,
              onChanged: _onLabsChanged,
              orderMissing: _orderMissing,
              recordExternal: _recordExternal,
              waiveItem: _waiveItem,
              today: widget.today,
            ),
        ],
      ],
    );
  }

  Widget _errorRow(AppStrings s, String message) {
    return Row(
      key: const ValueKey('cath-readiness-error'),
      children: [
        Flexible(
          child: Text(
            message,
            style: const TextStyle(fontSize: 12, color: AppTheme.errorRed),
          ),
        ),
        const SizedBox(width: 8),
        TextButton(
          key: const ValueKey('cath-readiness-retry'),
          onPressed: _loading ? null : () => unawaited(_reload()),
          child: Text(s.actionRetry),
        ),
      ],
    );
  }

  Widget _checkTile(
    AppStrings s,
    CathReadinessCheck check,
    CathLabReadiness? labs,
  ) {
    final critical =
        check.checkType == 'labs' &&
        (check.criticalWarning || labs?.criticalWarning == true);
    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      visualDensity: VisualDensity.compact,
      leading: Icon(
        _statusIcon(check.status),
        color: _statusColor(check.status),
      ),
      title: Row(
        children: [
          Flexible(child: Text(cathReadinessCheckLabel(s, check.checkType))),
          if (critical) ...[
            const SizedBox(width: 8),
            Chip(
              key: const ValueKey('cath-readiness-critical-badge'),
              visualDensity: VisualDensity.compact,
              materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
              backgroundColor: AppTheme.errorRed.withValues(alpha: 0.12),
              side: BorderSide(color: AppTheme.errorRed.withValues(alpha: 0.4)),
              label: Text(
                s.lookup('s4.lib.cath_lab.readiness.critical_value'),
                style: const TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                  color: AppTheme.errorRed,
                ),
              ),
            ),
          ],
        ],
      ),
      trailing: PopupMenuButton<String>(
        key: ValueKey('cath-readiness-status-${check.checkType}'),
        enabled: !_busy,
        tooltip: s.lookup('s4.lib.cath_lab.readiness.set_status'),
        onSelected: (status) => _setStatus(check, labs, status),
        itemBuilder: (menuContext) => [
          for (final status in cathReadinessCheckStatuses)
            PopupMenuItem<String>(
              value: status,
              child: Text(cathReadinessCheckStatusLabel(s, status)),
            ),
        ],
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              cathReadinessCheckStatusLabel(s, check.status),
              style: TextStyle(fontSize: 12, color: AppTheme.textSecondary),
            ),
            const Icon(Icons.arrow_drop_down, size: 18),
          ],
        ),
      ),
    );
  }

  static IconData _statusIcon(String status) {
    switch (status) {
      case 'pass':
      case 'waived':
      case 'not_applicable':
        return Icons.check_circle;
      case 'fail':
        return Icons.cancel;
      default:
        return Icons.radio_button_unchecked;
    }
  }

  static Color _statusColor(String status) {
    switch (status) {
      case 'pass':
        return AppTheme.successGreen;
      case 'waived':
      case 'not_applicable':
        return AppTheme.textSecondary;
      case 'fail':
        return AppTheme.errorRed;
      default:
        return AppTheme.warningAmber;
    }
  }
}

/// What the confirm dialog pops. A null result is a cancel; a non-null one
/// with null [notes] is a confirmation the operator left unannotated — the two
/// are NOT the same, which is why this is a type rather than a nullable
/// string.
class _CathReadinessConfirmResult {
  const _CathReadinessConfirmResult(this.notes);

  final String? notes;
}

/// The confirmation for a status that moves the start gate.
///
/// Stateful purely so the controller's life is the ROUTE's life: it is
/// disposed when the dialog is finally removed from the tree, not when
/// `showDialog`'s future completes — which is one exit animation too early
/// (see `_WaiveReasonDialog`, which learned the same lesson).
class _CathReadinessConfirmDialog extends StatefulWidget {
  const _CathReadinessConfirmDialog({
    required this.title,
    required this.body,
    required this.criticalLine,
    required this.automationNote,
    required this.reasonRequired,
    required this.notesLabel,
    required this.reasonRequiredLabel,
    required this.cancelLabel,
    required this.confirmLabel,
  });

  final String title;
  final String body;

  /// Names the critical items when this is a hand-pass over one. Null
  /// otherwise.
  final String? criticalLine;

  /// Warns that automation owns this check and may set it back. Null when it
  /// does not.
  final String? automationNote;

  /// True when the backend will file a safety review over this pass, whose
  /// override reason is exactly what is typed here.
  final bool reasonRequired;

  final String notesLabel;
  final String reasonRequiredLabel;
  final String cancelLabel;
  final String confirmLabel;

  @override
  State<_CathReadinessConfirmDialog> createState() =>
      _CathReadinessConfirmDialogState();
}

class _CathReadinessConfirmDialogState
    extends State<_CathReadinessConfirmDialog> {
  final _controller = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _confirm() {
    final notes = _controller.text.trim();
    // `updateReadinessCheck` files the pass over a critical value as a
    // platform safety review and uses these notes as the override reason. An
    // empty box would file the boilerplate instead, so the record would say a
    // critical value was acknowledged and say nothing about why.
    if (widget.reasonRequired && notes.isEmpty) {
      setState(() => _error = widget.reasonRequiredLabel);
      return;
    }
    Navigator.of(context)
        .pop(_CathReadinessConfirmResult(notes.isEmpty ? null : notes));
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      key: const ValueKey('cath-readiness-confirm'),
      title: Text(widget.title),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(widget.body),
          if (widget.criticalLine case final line?) ...[
            const SizedBox(height: 10),
            Text(
              line,
              style: const TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w600,
                color: AppTheme.errorRed,
              ),
            ),
          ],
          if (widget.automationNote case final note?) ...[
            const SizedBox(height: 10),
            Text(
              note,
              style: TextStyle(fontSize: 12, color: AppTheme.textSecondary),
            ),
          ],
          const SizedBox(height: 12),
          TextField(
            key: const ValueKey('cath-readiness-confirm-notes'),
            controller: _controller,
            autofocus: widget.reasonRequired,
            maxLines: 2,
            decoration: InputDecoration(
              labelText: widget.notesLabel,
              errorText: _error,
            ),
            onChanged: (_) {
              if (_error != null) setState(() => _error = null);
            },
          ),
        ],
      ),
      actions: [
        TextButton(
          key: const ValueKey('cath-readiness-confirm-cancel'),
          onPressed: () => Navigator.of(context).pop(),
          child: Text(widget.cancelLabel),
        ),
        FilledButton(
          key: const ValueKey('cath-readiness-confirm-ok'),
          onPressed: _confirm,
          child: Text(widget.confirmLabel),
        ),
      ],
    );
  }
}
