import 'package:flutter/material.dart';

import '../../../core/theme/app_theme.dart';
import '../../../l10n/app_strings.dart';
import '../services/cath_lab_api_service.dart';

typedef CathQuickWinsLoader = Future<CathCaseQuickWins> Function(int caseId);
typedef CathQuickWinsEvidenceRefresher = Future<void> Function(int caseId);
typedef CathQuickWinsOrderSetApplier =
    Future<void> Function(int caseId, String slot);

/// Injectable dependency bundle, mirroring [CathReportDependencies].
class CathQuickWinsDependencies {
  const CathQuickWinsDependencies({
    this.loadQuickWins,
    this.refreshEvidence,
    this.applyOrderSet,
  });

  final CathQuickWinsLoader? loadQuickWins;
  final CathQuickWinsEvidenceRefresher? refreshEvidence;
  final CathQuickWinsOrderSetApplier? applyOrderSet;
}

/// NL-13 P1e quick-wins section for one cath case: live readiness evidence
/// chips (blood-bank crossmatch, signed consent) plus the owner-published
/// pre/post-cath order-set actions. Follows the [CathCaseReportsPanel]
/// expand-to-load pattern so the worklist stays cheap; nothing actionable
/// renders when the tenant has published no mappings and no live evidence
/// exists — the readiness workflow stays manual exactly as today.
class CathQuickWinsPanel extends StatefulWidget {
  const CathQuickWinsPanel({
    super.key,
    required this.caseId,
    this.dependencies = const CathQuickWinsDependencies(),
    this.initiallyExpanded = false,
  });

  final int caseId;
  final CathQuickWinsDependencies dependencies;
  final bool initiallyExpanded;

  @override
  State<CathQuickWinsPanel> createState() => _CathQuickWinsPanelState();
}

class _CathQuickWinsPanelState extends State<CathQuickWinsPanel> {
  bool _loaded = false;
  bool _loading = false;
  bool _busy = false;
  String? _error;
  CathCaseQuickWins? _quickWins;

  CathQuickWinsLoader get _load =>
      widget.dependencies.loadQuickWins ?? CathLabApiService.fetchCaseQuickWins;
  CathQuickWinsEvidenceRefresher get _refresh =>
      widget.dependencies.refreshEvidence ??
      CathLabApiService.refreshReadinessEvidence;
  CathQuickWinsOrderSetApplier get _apply =>
      widget.dependencies.applyOrderSet ?? CathLabApiService.applyOrderSetSlot;

  @override
  void initState() {
    super.initState();
    if (widget.initiallyExpanded) _loadQuickWins();
  }

  Future<void> _loadQuickWins() async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final quickWins = await _load(widget.caseId);
      if (!mounted) return;
      setState(() {
        _quickWins = quickWins;
        _loaded = true;
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = AppStrings.of(
          context,
        ).lookup('s4.lib.cath_lab.quick_wins.load_failed');
        _loading = false;
      });
    }
  }

  Future<void> _refreshEvidence() async {
    final s = AppStrings.of(context);
    setState(() => _busy = true);
    try {
      await _refresh(widget.caseId);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(s.lookup('s4.lib.cath_lab.quick_wins.evidence_saved')),
        ),
      );
      await _loadQuickWins();
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            s.lookup('s4.lib.cath_lab.quick_wins.evidence_refresh_failed'),
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _applyOrderSet(String slot, CathOrderSetSlot orderSet) async {
    final s = AppStrings.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(s.lookup('s4.lib.cath_lab.quick_wins.apply_confirm_title')),
        content: Text(
          s.format('s4.lib.cath_lab.quick_wins.apply_confirm_body', {
            'title': orderSet.title,
            'count': orderSet.itemCount,
          }),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(s.actionCancel),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(s.actionConfirm),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    setState(() => _busy = true);
    try {
      await _apply(widget.caseId, slot);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(s.lookup('s4.lib.cath_lab.quick_wins.apply_success')),
        ),
      );
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(s.lookup('s4.lib.cath_lab.quick_wins.apply_failed')),
        ),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Theme(
      data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
      child: ExpansionTile(
        tilePadding: EdgeInsets.zero,
        childrenPadding: EdgeInsets.zero,
        initiallyExpanded: widget.initiallyExpanded,
        onExpansionChanged: (expanded) {
          if (expanded && !_loaded) _loadQuickWins();
        },
        title: Text(
          s.lookup('s4.lib.cath_lab.quick_wins.live_evidence'),
          style: Theme.of(
            context,
          ).textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w700),
        ),
        children: [_body(context, s)],
      ),
    );
  }

  Widget _body(BuildContext context, AppStrings s) {
    if (_loading) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 8),
        child: LinearProgressIndicator(minHeight: 2),
      );
    }
    if (_error != null) {
      return Row(
        children: [
          Expanded(
            child: Text(
              _error!,
              style: Theme.of(
                context,
              ).textTheme.bodySmall?.copyWith(color: AppTheme.errorRed),
            ),
          ),
          TextButton(onPressed: _loadQuickWins, child: Text(s.actionRetry)),
        ],
      );
    }
    final quickWins = _quickWins;
    if (quickWins == null) return const SizedBox.shrink();

    final blood = quickWins.bloodEvidence;
    final consent = quickWins.consentEvidence;
    final preCath = quickWins.preCathOrderSet;
    final postCath = quickWins.postCathOrderSet;
    final hasEvidence = blood != null || consent != null;
    final hasOrderSets = preCath != null || postCath != null;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                hasEvidence
                    ? s.lookup('s4.lib.cath_lab.quick_wins.evidence_found')
                    : s.lookup('s4.lib.cath_lab.quick_wins.no_evidence'),
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: AppTheme.textSecondary),
              ),
            ),
            IconButton(
              tooltip: s.lookup('s4.lib.cath_lab.quick_wins.refresh_evidence'),
              visualDensity: VisualDensity.compact,
              onPressed: _busy ? null : _refreshEvidence,
              icon: const Icon(Icons.sync, size: 18),
            ),
          ],
        ),
        if (hasEvidence)
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              if (blood != null) _bloodChip(context, blood),
              if (consent != null) _consentChip(context, consent),
            ],
          ),
        if (hasOrderSets) ...[
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              if (preCath != null)
                _orderSetButton(
                  context,
                  slot: 'pre_cath',
                  orderSet: preCath,
                  label: s.lookup('s4.lib.cath_lab.quick_wins.apply_pre_cath'),
                ),
              if (postCath != null)
                _orderSetButton(
                  context,
                  slot: 'post_cath',
                  orderSet: postCath,
                  label: s.lookup('s4.lib.cath_lab.quick_wins.apply_post_cath'),
                ),
            ],
          ),
        ],
        const SizedBox(height: 8),
      ],
    );
  }

  Widget _bloodChip(BuildContext context, CathBloodReadinessEvidence blood) {
    final s = AppStrings.of(context);
    final label = s.format('s4.lib.cath_lab.quick_wins.blood_chip', {
      'status': s.lookup(
        's4.lib.cath_lab.quick_wins.crossmatch.${blood.crossMatchStatus}',
      ),
    });
    final color = blood.crossMatchCompatible
        ? AppTheme.successGreen
        : blood.crossMatchStatus == 'incompatible'
        ? AppTheme.errorRed
        : AppTheme.warningAmber;
    return Chip(
      avatar: Icon(Icons.bloodtype_outlined, size: 16, color: color),
      label: Text(label),
      labelStyle: Theme.of(context).textTheme.bodySmall,
      side: BorderSide(color: color.withValues(alpha: 0.5)),
      visualDensity: VisualDensity.compact,
    );
  }

  Widget _consentChip(
    BuildContext context,
    CathConsentReadinessEvidence consent,
  ) {
    final s = AppStrings.of(context);
    return Chip(
      avatar: const Icon(
        Icons.verified_outlined,
        size: 16,
        color: AppTheme.successGreen,
      ),
      label: Text(s.lookup('s4.lib.cath_lab.quick_wins.consent_chip')),
      labelStyle: Theme.of(context).textTheme.bodySmall,
      side: BorderSide(color: AppTheme.successGreen.withValues(alpha: 0.5)),
      visualDensity: VisualDensity.compact,
    );
  }

  Widget _orderSetButton(
    BuildContext context, {
    required String slot,
    required CathOrderSetSlot orderSet,
    required String label,
  }) {
    return OutlinedButton.icon(
      onPressed: _busy ? null : () => _applyOrderSet(slot, orderSet),
      icon: const Icon(Icons.playlist_add_check_outlined, size: 18),
      label: Text(label),
    );
  }
}
