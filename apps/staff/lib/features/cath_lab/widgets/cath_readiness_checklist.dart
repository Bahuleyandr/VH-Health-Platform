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
    this.today,
  });

  final int caseId;
  final CathReadinessDependencies dependencies;

  /// Injectable "today" for the outside-result sheet's date field.
  final DateTime? today;

  @override
  State<CathReadinessChecklist> createState() => _CathReadinessChecklistState();
}

class _CathReadinessChecklistState extends State<CathReadinessChecklist> {
  CathCaseReadiness? _readiness;
  bool _loading = false;
  bool _busy = false;
  String? _error;

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
    _reload();
  }

  Future<void> _reload() async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final readiness = await _load(widget.caseId);
      if (!mounted) return;
      setState(() {
        _readiness = readiness;
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = AppStrings.of(context)
            .lookup('s4.lib.cath_lab.readiness.load_failed');
      });
    }
  }

  Future<void> _setStatus(CathReadinessCheck check, String status) async {
    if (_busy || status == check.status) return;
    final s = AppStrings.of(context);
    setState(() => _busy = true);
    try {
      await _updateCheck(
        widget.caseId,
        checkType: check.checkType,
        status: status,
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
  /// away so the panel does not flicker back to the old rows, then the whole
  /// case is re-read: ordering a lab or waiving an item can flip the `labs`
  /// CHECK and the start gate, neither of which lives in that block.
  void _onLabsChanged(CathLabReadiness labs) {
    final current = _readiness;
    if (current != null) {
      setState(() {
        _readiness = CathCaseReadiness(
          checks: current.checks,
          ready: current.ready,
          labs: labs,
        );
      });
    }
    // Fire-and-forget: the write has already reported its own outcome, and
    // awaiting the refresh inside a `ValueChanged` callback would swallow its
    // error somewhere the operator cannot see it.
    unawaited(_reload());
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final readiness = _readiness;
    if (readiness == null) {
      if (_error != null) {
        return Padding(
          padding: const EdgeInsets.only(top: 12),
          child: Text(
            _error!,
            style: const TextStyle(fontSize: 12, color: AppTheme.errorRed),
          ),
        );
      }
      // Nothing to say yet: the card's own progress row already carries the
      // cleared/total count, so a second spinner would only add noise.
      return const SizedBox.shrink();
    }
    if (readiness.isEmpty) return const SizedBox.shrink();

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
        onSelected: (status) => _setStatus(check, status),
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
