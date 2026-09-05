import 'package:flutter/material.dart';
import 'package:vhhealth_core/services/idempotency_key.dart';

import '../../../core/theme/app_theme.dart';
import '../../../l10n/app_strings.dart';
import '../models/cath_readiness_models.dart';
import 'cath_consumable_formatting.dart';
import 'cath_external_result_sheet.dart';
import 'cath_readiness_formatting.dart';

typedef CathReadinessOrderMissing = Future<CathLabReadiness> Function(
  int caseId, {
  required String idempotencyKey,
});

typedef CathReadinessExternalRecorder = Future<CathLabReadiness> Function(
  int caseId,
  CathExternalResultDraft draft, {
  required String idempotencyKey,
});

typedef CathReadinessWaiver = Future<CathLabReadiness> Function(
  int caseId,
  String item, {
  required String reason,
  required String idempotencyKey,
});

/// Withdrawing a waiver. No reason field: a waiver has to say why a gate was
/// cleared, but lifting one RESTORES the gate — the restrictive direction — so
/// the backend takes an optional reason and the panel does not ask for one.
typedef CathReadinessUnwaiver = Future<CathLabReadiness> Function(
  int caseId,
  String item, {
  required String idempotencyKey,
});

/// The seven pre-procedure lab items on one case, with the four writes the
/// team can make against them: order what is missing, enter an outside result,
/// waive an item with a reason, or withdraw a waiver already recorded.
///
/// Every write is idempotent-keyed. The keys are held per action (and, for the
/// per-item writes, per item) for the life of the panel and are reset ONLY on
/// success: a failed attempt keeps its key so the retry replays instead of
/// recording a second order, a second outside value or a second waiver.
class CathLabReadinessPanel extends StatefulWidget {
  const CathLabReadinessPanel({
    super.key,
    required this.caseId,
    required this.labs,
    required this.onChanged,
    required this.orderMissing,
    required this.recordExternal,
    required this.waiveItem,
    required this.unwaiveItem,
    this.today,
  });

  final int caseId;
  final CathLabReadiness labs;

  /// Called with the readiness the write answered with. The checklist reloads
  /// the whole case on top of it: an item write can flip the `labs` CHECK,
  /// which lives outside this block.
  final ValueChanged<CathLabReadiness> onChanged;

  final CathReadinessOrderMissing orderMissing;
  final CathReadinessExternalRecorder recordExternal;
  final CathReadinessWaiver waiveItem;
  final CathReadinessUnwaiver unwaiveItem;

  /// Injectable "today" for the outside-result sheet's date field.
  final DateTime? today;

  @override
  State<CathLabReadinessPanel> createState() => _CathLabReadinessPanelState();
}

class _CathLabReadinessPanelState extends State<CathLabReadinessPanel> {
  late final IdempotencyAttempt _orderAttempt = IdempotencyAttempt(
    'cath-lab-order-${widget.caseId}',
  );
  final Map<String, IdempotencyAttempt> _externalAttempts = {};
  final Map<String, IdempotencyAttempt> _waiveAttempts = {};
  final Map<String, IdempotencyAttempt> _unwaiveAttempts = {};
  bool _busy = false;

  @override
  void dispose() {
    _orderAttempt.reset();
    for (final attempt in _externalAttempts.values) {
      attempt.reset();
    }
    for (final attempt in _waiveAttempts.values) {
      attempt.reset();
    }
    for (final attempt in _unwaiveAttempts.values) {
      attempt.reset();
    }
    super.dispose();
  }

  IdempotencyAttempt _externalAttempt(String item) =>
      _externalAttempts.putIfAbsent(
        item,
        () => IdempotencyAttempt('cath-lab-external-${widget.caseId}-$item'),
      );

  IdempotencyAttempt _waiveAttempt(String item) => _waiveAttempts.putIfAbsent(
    item,
    () => IdempotencyAttempt('cath-lab-waive-${widget.caseId}-$item'),
  );

  IdempotencyAttempt _unwaiveAttempt(String item) =>
      _unwaiveAttempts.putIfAbsent(
        item,
        () => IdempotencyAttempt('cath-lab-unwaive-${widget.caseId}-$item'),
      );

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  /// Runs one write, surfacing the backend's own refusal message — a 409 on a
  /// started case or a 400 on a rejected value says something the operator
  /// needs to read, which a generic "could not save" would throw away.
  Future<void> _run(Future<CathLabReadiness> Function() write) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final labs = await write();
      if (!mounted) return;
      widget.onChanged(labs);
    } catch (error) {
      _toast(cathCleanError(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _orderMissing() async {
    final s = AppStrings.of(context);
    await _run(() async {
      final labs = await widget.orderMissing(
        widget.caseId,
        idempotencyKey: _orderAttempt.keyFor(const <String, dynamic>{}),
      );
      _orderAttempt.reset();
      _toast(s.lookup('s4.lib.cath_lab.readiness.order_missing_done'));
      return labs;
    });
  }

  Future<void> _enterExternal(CathLabReadinessItem item) async {
    final s = AppStrings.of(context);
    final draft = await CathExternalResultSheet.show(
      context,
      itemCode: item.itemCode,
      today: widget.today,
    );
    if (draft == null || !mounted) return;
    await _run(() async {
      final labs = await widget.recordExternal(
        widget.caseId,
        draft,
        idempotencyKey: _externalAttempt(item.itemCode).keyFor(draft.toJson()),
      );
      _externalAttempt(item.itemCode).reset();
      _toast(s.lookup('s4.lib.cath_lab.readiness.external_saved'));
      return labs;
    });
  }

  Future<void> _waive(CathLabReadinessItem item) async {
    final s = AppStrings.of(context);
    final reason = await _askWaiveReason(s, item);
    if (reason == null || !mounted) return;
    await _run(() async {
      final labs = await widget.waiveItem(
        widget.caseId,
        item.itemCode,
        reason: reason,
        idempotencyKey: _waiveAttempt(item.itemCode)
            .keyFor(<String, dynamic>{'reason': reason}),
      );
      _waiveAttempt(item.itemCode).reset();
      _toast(s.lookup('s4.lib.cath_lab.readiness.waived_done'));
      return labs;
    });
  }

  /// Withdrawing a waiver. Confirmed first, because it moves the start gate in
  /// the RESTRICTIVE direction: the item goes back to being resolved from lab
  /// evidence, so a case that read ready can stop reading ready because of this
  /// tap. There is no reason box — the backend does not require one — so this
  /// is the plain confirm, not the waive dialog with its field.
  Future<void> _unwaive(CathLabReadinessItem item) async {
    final s = AppStrings.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => _UnwaiveConfirmDialog(
        title: s.lookup('s4.lib.cath_lab.readiness.unwaive'),
        body: s.format('s4.lib.cath_lab.readiness.unwaive_confirm', {
          'item': cathReadinessItemLabel(s, item.itemCode),
        }),
        cancelLabel: s.actionCancel,
        confirmLabel: s.lookup('s4.lib.cath_lab.readiness.unwaive'),
      ),
    );
    if (confirmed != true || !mounted) return;
    await _run(() async {
      final labs = await widget.unwaiveItem(
        widget.caseId,
        item.itemCode,
        idempotencyKey: _unwaiveAttempt(item.itemCode)
            .keyFor(const <String, dynamic>{}),
      );
      _unwaiveAttempt(item.itemCode).reset();
      _toast(s.lookup('s4.lib.cath_lab.readiness.unwaived_done'));
      return labs;
    });
  }

  /// The dialog OWNS its controller (see [_WaiveReasonDialog]). Disposing one
  /// created here, in a `finally` after the `await`, tears the controller down
  /// while the route is still playing its exit animation and rebuilding the
  /// field — "A TextEditingController was used after being disposed".
  Future<String?> _askWaiveReason(AppStrings s, CathLabReadinessItem item) {
    return showDialog<String>(
      context: context,
      builder: (dialogContext) => _WaiveReasonDialog(
        title: s.format('s4.lib.cath_lab.readiness.waive_title', {
          'item': cathReadinessItemLabel(s, item.itemCode),
        }),
        reasonLabel: s.lookup('s4.lib.cath_lab.readiness.waive_reason'),
        reasonRequiredLabel: s.lookup(
          's4.lib.cath_lab.readiness.reason_required',
        ),
        cancelLabel: s.actionCancel,
        confirmLabel: s.lookup('s4.lib.cath_lab.readiness.waive'),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final labs = widget.labs;
    final showOrderMissing = labs.orderableNow.isNotEmpty && !labs.caseStarted;
    return Padding(
      padding: const EdgeInsets.only(left: 16, right: 8, bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final item in labs.items) _itemRow(s, item, labs),
          if (showOrderMissing)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: FilledButton.icon(
                key: const ValueKey('cath-lab-order-missing'),
                onPressed: _busy ? null : _orderMissing,
                icon: const Icon(Icons.playlist_add_outlined, size: 18),
                label: Text(
                  s.lookup('s4.lib.cath_lab.readiness.order_missing'),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _itemRow(
    AppStrings s,
    CathLabReadinessItem item,
    CathLabReadiness labs,
  ) {
    final value = cathReadinessValueLine(item);
    // Two SEPARATE rules, because one gate produced a dead end.
    //
    // Outside entry is offered while nothing is on record for the item at all
    // — and `available` counts `external_recorded`, so an item that already
    // carries an outside value is never offered a second one.
    //
    // The waive exit is driven by the SERVER's `missing[]` instead. On a
    // tenant with `external_results_count` off, an externally-recorded item is
    // still missing as far as the gate is concerned; gating the waiver on the
    // same `available` flag left that item with no outside entry (a value is
    // already on record) and no waiver (it looks available) and therefore no
    // way to make the case ready.
    final canEnterExternal = !labs.caseStarted && !item.available;
    final canWaive =
        !labs.caseStarted &&
        item.required &&
        item.state != 'waived' &&
        labs.missingItemCodes.contains(item.itemCode);
    // The exit FROM a waiver, offered on exactly the rows that carry one. It is
    // deliberately NOT gated on the server's `missing[]`: a waived item is
    // never missing — that is what the waiver did — so reusing the waive rule
    // here would hide the only way back out of it. Like every other write on
    // this panel it disappears once the case has started.
    final canUnwaive = !labs.caseStarted && item.state == 'waived';
    return Padding(
      key: ValueKey('cath-lab-item-${item.itemCode}'),
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  cathReadinessItemLabel(s, item.itemCode),
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
              ),
              _stateChip(s, item),
            ],
          ),
          if (value.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Row(
                children: [
                  Flexible(
                    child: Text(
                      value,
                      style: TextStyle(color: AppTheme.textSecondary),
                    ),
                  ),
                  if (item.isCritical) ...[
                    const SizedBox(width: 6),
                    _tag(
                      s.lookup('s4.lib.cath_lab.readiness.critical'),
                      AppTheme.errorRed,
                    ),
                  ],
                ],
              ),
            ),
          if (_timingLine(s, item) case final line?)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                line,
                style: TextStyle(fontSize: 12, color: AppTheme.textSecondary),
              ),
            ),
          if (item.state == 'waived' && item.waiveReason.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                s.format('s4.lib.cath_lab.readiness.waive_reason_line', {
                  'reason': item.waiveReason,
                }),
                style: TextStyle(fontSize: 12, color: AppTheme.textSecondary),
              ),
            ),
          if (canEnterExternal || canWaive || canUnwaive)
            Wrap(
              spacing: 8,
              children: [
                if (canEnterExternal)
                  TextButton(
                    key: ValueKey('cath-lab-external-${item.itemCode}'),
                    onPressed: _busy ? null : () => _enterExternal(item),
                    child: Text(
                      s.lookup('s4.lib.cath_lab.readiness.enter_external'),
                    ),
                  ),
                if (canWaive)
                  TextButton(
                    key: ValueKey('cath-lab-waive-${item.itemCode}'),
                    onPressed: _busy ? null : () => _waive(item),
                    child: Text(s.lookup('s4.lib.cath_lab.readiness.waive')),
                  ),
                if (canUnwaive)
                  TextButton(
                    key: ValueKey('cath-lab-unwaive-${item.itemCode}'),
                    onPressed: _busy ? null : () => _unwaive(item),
                    child: Text(s.lookup('s4.lib.cath_lab.readiness.unwaive')),
                  ),
              ],
            ),
        ],
      ),
    );
  }

  /// The date that explains the state: when an awaiting item was ordered, when
  /// a waived item was waived, and how old a stale or recorded value is. Null
  /// when the state carries no instant worth showing.
  ///
  /// The waiver is tested FIRST and gets its own line. `resolveItemState`
  /// leaves a value on a waived item, so the observed branch would otherwise
  /// date a waiver "As of" the value it was waived over — which reads as the
  /// item having a current result.
  String? _timingLine(AppStrings s, CathLabReadinessItem item) {
    if (item.state == 'waived' && item.waivedAt != null) {
      return s.format('s4.lib.cath_lab.readiness.waived_on', {
        'date': cathReadinessDisplayDate(item.waivedAt!),
      });
    }
    if (item.awaiting && item.orderedAt != null) {
      return s.format('s4.lib.cath_lab.readiness.ordered_on', {
        'date': cathReadinessDisplayDate(item.orderedAt!),
      });
    }
    if (item.observedAt != null) {
      return s.format('s4.lib.cath_lab.readiness.observed_line', {
        'date': cathReadinessDisplayDate(item.observedAt!),
      });
    }
    return null;
  }

  Widget _stateChip(AppStrings s, CathLabReadinessItem item) =>
      _tag(cathReadinessStateLabel(s, item.state), _stateColor(item.state));

  static Color _stateColor(String state) {
    switch (state) {
      case 'result_final':
        return AppTheme.successGreen;
      case 'result_preliminary':
        return AppTheme.primaryTeal;
      case 'external_recorded':
        return AppTheme.primaryBlue;
      case 'sample_sent_awaiting_result':
      case 'ordered_awaiting_sample':
        return AppTheme.warningAmber;
      case 'not_ordered':
        return AppTheme.errorRed;
      default:
        // `stale` and `waived`: on record, but not a live clearing value.
        return AppTheme.textSecondary;
    }
  }

  Widget _tag(String label, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w600,
          color: color,
        ),
      ),
    );
  }
}

/// The waive-reason prompt. Stateful purely so the controller's life is the
/// ROUTE's life: it is disposed when the dialog is finally removed from the
/// tree, not when `showDialog`'s future completes — which is one exit
/// animation too early.
class _WaiveReasonDialog extends StatefulWidget {
  const _WaiveReasonDialog({
    required this.title,
    required this.reasonLabel,
    required this.reasonRequiredLabel,
    required this.cancelLabel,
    required this.confirmLabel,
  });

  final String title;
  final String reasonLabel;
  final String reasonRequiredLabel;
  final String cancelLabel;
  final String confirmLabel;

  @override
  State<_WaiveReasonDialog> createState() => _WaiveReasonDialogState();
}

class _WaiveReasonDialogState extends State<_WaiveReasonDialog> {
  final _controller = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.title),
      content: TextField(
        key: const ValueKey('cath-lab-waive-reason'),
        controller: _controller,
        autofocus: true,
        maxLines: 2,
        decoration: InputDecoration(
          labelText: widget.reasonLabel,
          errorText: _error,
        ),
        onChanged: (_) {
          if (_error != null) setState(() => _error = null);
        },
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(widget.cancelLabel),
        ),
        FilledButton(
          key: const ValueKey('cath-lab-waive-confirm'),
          onPressed: () {
            final reason = _controller.text.trim();
            // The backend answers 400 without a reason. A dialog that just
            // refused to close said nothing about why, so the refusal is now
            // stated on the field itself.
            if (reason.isEmpty) {
              setState(() => _error = widget.reasonRequiredLabel);
              return;
            }
            Navigator.of(context).pop(reason);
          },
          child: Text(widget.confirmLabel),
        ),
      ],
    );
  }
}

/// The plain confirmation in front of withdrawing a waiver. Stateless on
/// purpose: it asks one question and carries no field, so there is no
/// controller whose life has to outlast the route — the lesson
/// [_WaiveReasonDialog] records does not apply here.
class _UnwaiveConfirmDialog extends StatelessWidget {
  const _UnwaiveConfirmDialog({
    required this.title,
    required this.body,
    required this.cancelLabel,
    required this.confirmLabel,
  });

  final String title;
  final String body;
  final String cancelLabel;
  final String confirmLabel;

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      key: const ValueKey('cath-lab-unwaive-dialog'),
      title: Text(title),
      content: Text(body),
      actions: [
        TextButton(
          key: const ValueKey('cath-lab-unwaive-cancel'),
          onPressed: () => Navigator.of(context).pop(false),
          child: Text(cancelLabel),
        ),
        FilledButton(
          key: const ValueKey('cath-lab-unwaive-confirm'),
          onPressed: () => Navigator.of(context).pop(true),
          child: Text(confirmLabel),
        ),
      ],
    );
  }
}
