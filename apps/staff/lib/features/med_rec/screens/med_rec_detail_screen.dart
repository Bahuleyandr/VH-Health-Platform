import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../core/config/api_config.dart';
import '../../../core/services/med_rec_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/constrained_content.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../core/widgets/navigation_back_action.dart';
import '../../../l10n/app_strings.dart';

/// Roles allowed to start/decide/complete a reconciliation. Mirrors backend
/// medRecRoutes `canDecide`: DOCTOR_TIERS + ADMIN + pharmacy roles +
/// SUPER_ADMIN. Everyone else on the clinical-staff gate gets read-only.
@visibleForTesting
const Set<String> medRecDeciderRoles = {
  'DOCTOR',
  'DUTY_DOCTOR',
  'CONSULTANT',
  'JUNIOR_DOCTOR',
  'RESIDENT',
  'ADMIN',
  'PHARMACY_STAFF',
  'PHARMACY_INCHARGE',
  'SUPER_ADMIN',
};

bool medRecCanDecideForRawRole(String rawRole) =>
    medRecDeciderRoles.contains(rawRole.trim().toUpperCase());

String medRecStatusLabel(String status) => switch (status) {
  'in_progress' => 'In progress',
  'completed' => 'Completed',
  _ => status,
};

@visibleForTesting
Color medRecDiscrepancyColor(String type) => switch (type) {
  'omitted' => AppTheme.errorOnSurface,
  'dose_changed' => AppTheme.warningOnSurface,
  'added' => AppTheme.primaryBlue,
  'duplicate' => AppTheme.textSecondary,
  _ => AppTheme.textSecondary,
};

@visibleForTesting
Color medRecDecisionColor(String decision) => switch (decision) {
  'continue' => AppTheme.primaryTeal,
  'new' => AppTheme.primaryTeal,
  'change' => AppTheme.primaryBlue,
  'hold' => AppTheme.warningOnSurface,
  'stop' => AppTheme.errorOnSurface,
  _ => AppTheme.textSecondary,
};

/// B6 — one medication reconciliation: grouped source lists, per-item
/// decisions (doctors/pharmacists/admins), discrepancy flags, completion.
/// Completed reconciliations render read-only.
class MedRecDetailScreen extends StatefulWidget {
  /// Reconciliation id — a UUID string (backend `medication_reconciliations.id`).
  final String recId;

  const MedRecDetailScreen({super.key, required this.recId});

  @override
  State<MedRecDetailScreen> createState() => _MedRecDetailScreenState();
}

class _MedRecDetailScreenState extends State<MedRecDetailScreen> {
  final _dateFmt = DateFormat('dd MMM, HH:mm');
  bool _loading = true;
  bool _completing = false;
  bool _canDecide = false;
  String? _error;
  Map<String, dynamic>? _rec;

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    final rawRole = await ApiConfig.getRole();
    if (!mounted) return;
    setState(() => _canDecide = medRecCanDecideForRawRole(rawRole));
    await _load();
  }

  Future<void> _load({bool silent = false}) async {
    if (!silent) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final rec = await MedRecApiService.getReconciliation(widget.recId);
      if (!mounted) return;
      setState(() => _rec = rec);
    } catch (e) {
      if (!mounted) return;
      if (silent) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted && !silent) setState(() => _loading = false);
    }
  }

  String _text(Object? value, [String fallback = '']) {
    final text = value?.toString().trim() ?? '';
    return text.isEmpty ? fallback : text;
  }

  List<Map<String, dynamic>> get _items =>
      ((_rec?['items'] as List?) ?? const [])
          .whereType<Map<String, dynamic>>()
          .toList();

  bool get _inProgress => _text(_rec?['status']) == 'in_progress';

  Future<void> _decide(Map<String, dynamic> item, String decision) async {
    final itemId = int.tryParse(_text(item['id']));
    if (itemId == null) return;
    final result = await showDialog<Map<String, String>>(
      context: context,
      builder: (ctx) => _DecisionDialog(
        decision: decision,
        medicationName: _text(item['medication_name'], 'Medication'),
      ),
    );
    if (result == null || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    final theme = Theme.of(context);
    try {
      final updated = await MedRecApiService.decideItem(
        recId: widget.recId,
        itemId: itemId,
        decision: decision,
        reason: result['reason'],
        newInstructions: result['new_instructions'],
        changedDose: result['changed_dose'],
        changedRoute: result['changed_route'],
        changedFrequency: result['changed_frequency'],
        safetyRationale: result['safety_rationale'],
      );
      if (!mounted) return;
      // Optimistic merge of the returned item, then a silent re-fetch so
      // discrepancy verdicts and counts stay authoritative.
      setState(() {
        final items = (_rec?['items'] as List?) ?? [];
        for (var i = 0; i < items.length; i++) {
          final row = items[i];
          if (row is Map<String, dynamic> &&
              _text(row['id']) == _text(updated['id'])) {
            items[i] = {...row, ...updated};
          }
        }
      });
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            "'${_text(item['medication_name'])}' marked ${decision.toUpperCase()}",
          ),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(
          content: Text(e.toString().replaceFirst('Exception: ', '')),
          backgroundColor: theme.colorScheme.error,
        ),
      );
    }
    await _load(silent: true);
  }

  Future<void> _complete() async {
    final s = AppStrings.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(AppStrings.of(context).medRecCompleteConfirm),
        content: const Text(
          'Every medication needs a documented decision. The backend will '
          'refuse completion while discrepancies remain unresolved.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text(s.actionCancel),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: Text(AppStrings.of(context).actionConfirm),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    final theme = Theme.of(context);
    setState(() => _completing = true);
    try {
      final rec = await MedRecApiService.completeReconciliation(widget.recId);
      if (!mounted) return;
      setState(() => _rec = rec);
      messenger.showSnackBar(
        SnackBar(content: Text(AppStrings.of(context).medRecCompleted)),
      );
    } catch (e) {
      if (!mounted) return;
      // The service refuses completion with a specific reason (undecided
      // items, unresolved high-alert discrepancies, safety blockers) —
      // surface that message verbatim.
      messenger.showSnackBar(
        SnackBar(
          content: Text(e.toString().replaceFirst('Exception: ', '')),
          backgroundColor: theme.colorScheme.error,
          duration: const Duration(seconds: 6),
        ),
      );
    } finally {
      if (mounted) setState(() => _completing = false);
    }
    await _load(silent: true);
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(AppStrings.of(context).medRecTitle),
        actions: [
          IconButton(
            tooltip: s.actionRefresh,
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh),
          ),
          const LogoutAction(),
        ],
      ),
      body: ConstrainedContent(
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : _error != null
            ? _ErrorState(message: _error!, onRetry: _load)
            : _buildBody(context),
      ),
    );
  }

  Widget _buildBody(BuildContext context) {
    final theme = Theme.of(context);
    final rec = _rec;
    if (rec == null) {
      return Center(child: Text(AppStrings.of(context).medRecNotFound));
    }
    final items = _items;
    final decided = items.where((i) => _text(i['decision']).isNotEmpty).length;
    final sections = <String, List<Map<String, dynamic>>>{};
    for (final item in items) {
      sections.putIfAbsent(_text(item['source'], 'other'), () => []).add(item);
    }
    const sectionOrder = ['home', 'active_prescription', 'inpatient'];
    final orderedSources = [
      ...sectionOrder.where(sections.containsKey),
      ...sections.keys.where((sourceKey) => !sectionOrder.contains(sourceKey)),
    ];

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
      children: [
        _buildHeader(theme, rec, decided, items.length),
        if (!_canDecide && _inProgress) ...[
          const SizedBox(height: 12),
          const _InfoBanner(
            icon: Icons.visibility_outlined,
            text: 'Read-only — decisions are made by doctors, pharmacists or admins.',
          ),
        ],
        if (!_inProgress) ...[
          const SizedBox(height: 12),
          _InfoBanner(
            icon: Icons.lock_outline,
            text:
                '${medRecStatusLabel(_text(rec['status']))} — decisions are frozen.',
          ),
        ],
        const SizedBox(height: 8),
        if (items.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 32),
            child: Center(
              child: Text(
                'No medications were found on any source list.',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
          )
        else
          for (final sourceKey in orderedSources) ...[
            Padding(
              padding: const EdgeInsets.only(top: 12, bottom: 6),
              child: Text(
                _sourceLabel(sourceKey),
                style: theme.textTheme.titleSmall?.copyWith(
                  fontWeight: FontWeight.w800,
                ),
              ),
            ),
            ...sections[sourceKey]!.map(
              (item) => _MedRecItemCard(
                item: item,
                canDecide: _canDecide && _inProgress,
                onDecide: (decision) => _decide(item, decision),
              ),
            ),
          ],
        if (_canDecide && _inProgress) ...[
          const SizedBox(height: 20),
          FilledButton.icon(
            onPressed: _completing ? null : _complete,
            icon: _completing
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.task_alt),
            label: Text(AppStrings.of(context).medRecComplete),
          ),
        ],
      ],
    );
  }

  Widget _buildHeader(
    ThemeData theme,
    Map<String, dynamic> rec,
    int decided,
    int total,
  ) {
    final status = _text(rec['status'], 'in_progress');
    final statusColor = status == 'completed'
        ? AppTheme.primaryTeal
        : AppTheme.primaryBlue;
    final started = DateTime.tryParse(_text(rec['started_at']));
    final completed = DateTime.tryParse(_text(rec['completed_at']));
    final notes = _text(rec['notes']);
    final transferContext = _text(rec['transfer_context']);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  '${_recTypeLabel(_text(rec['rec_type']))} reconciliation',
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: statusColor.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  medRecStatusLabel(status),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: statusColor,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            [
              if (started != null)
                'Started ${_dateFmt.format(started.toLocal())}',
              if (completed != null)
                'Completed ${_dateFmt.format(completed.toLocal())}',
              '$decided of $total decided',
            ].join(' · '),
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          if (transferContext.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(
              'Transfer: $transferContext',
              style: theme.textTheme.bodySmall,
            ),
          ],
          if (notes.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(notes, style: theme.textTheme.bodyMedium),
          ],
        ],
      ),
    );
  }

  String _recTypeLabel(String recType) => switch (recType) {
    'admission' => 'Admission',
    'discharge' => 'Discharge',
    'transfer' => 'Transfer',
    _ => recType,
  };

  String _sourceLabel(String source) => switch (source) {
    'home' => 'Home & chronic medications',
    'active_prescription' => 'Active prescriptions',
    'inpatient' => 'Inpatient MAR',
    _ => 'Other medications',
  };
}

class _MedRecItemCard extends StatelessWidget {
  final Map<String, dynamic> item;
  final bool canDecide;
  final ValueChanged<String> onDecide;

  const _MedRecItemCard({
    required this.item,
    required this.canDecide,
    required this.onDecide,
  });

  String _text(Object? value, [String fallback = '']) {
    final text = value?.toString().trim() ?? '';
    return text.isEmpty ? fallback : text;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final decision = _text(item['decision']);
    final discrepancy = _text(item['discrepancy_type']);
    final flagged = discrepancy.isNotEmpty && discrepancy != 'unchanged';
    final regimen = [
      _text(item['dose']),
      _text(item['route']),
      _text(item['frequency']),
    ].where((part) => part.isNotEmpty).join(' · ');
    final reason = _text(item['decision_reason']);
    final instructions = _text(item['new_instructions']);
    final changed = [
      if (_text(item['changed_dose']).isNotEmpty)
        'dose → ${_text(item['changed_dose'])}',
      if (_text(item['changed_route']).isNotEmpty)
        'route → ${_text(item['changed_route'])}',
      if (_text(item['changed_frequency']).isNotEmpty)
        'frequency → ${_text(item['changed_frequency'])}',
    ].join(', ');

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: flagged
              ? medRecDiscrepancyColor(discrepancy).withValues(alpha: 0.6)
              : AppTheme.divider,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      _text(item['medication_name'], 'Unnamed medication'),
                      style: theme.textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    if (regimen.isNotEmpty)
                      Text(
                        regimen,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                  ],
                ),
              ),
              if (flagged)
                _Pill(
                  label: discrepancy.replaceAll('_', ' ').toUpperCase(),
                  color: medRecDiscrepancyColor(discrepancy),
                ),
              if (decision.isNotEmpty) ...[
                const SizedBox(width: 6),
                _Pill(
                  label: decision.toUpperCase(),
                  color: medRecDecisionColor(decision),
                ),
              ],
            ],
          ),
          if (reason.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text('Reason: $reason', style: theme.textTheme.bodySmall),
          ],
          if (changed.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text('Change: $changed', style: theme.textTheme.bodySmall),
          ],
          if (instructions.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              'Instructions: $instructions',
              style: theme.textTheme.bodySmall,
            ),
          ],
          if (canDecide) ...[
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerRight,
              child: PopupMenuButton<String>(
                tooltip: AppStrings.of(context).medRecDecisionTooltip,
                onSelected: onDecide,
                itemBuilder: (ctx) => MedRecApiService.decisions
                    .map(
                      (choice) => PopupMenuItem<String>(
                        value: choice,
                        child: Text(_decisionLabel(choice)),
                      ),
                    )
                    .toList(),
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 6,
                  ),
                  decoration: BoxDecoration(
                    border: Border.all(color: theme.colorScheme.primary),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        decision.isEmpty ? 'Decide' : 'Change decision',
                        style: theme.textTheme.labelLarge?.copyWith(
                          color: theme.colorScheme.primary,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      Icon(
                        Icons.arrow_drop_down,
                        color: theme.colorScheme.primary,
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  String _decisionLabel(String decision) => switch (decision) {
    'continue' => 'Continue',
    'stop' => 'Stop',
    'hold' => 'Hold',
    'change' => 'Change',
    'new' => 'New',
    _ => decision,
  };
}

class _Pill extends StatelessWidget {
  final String label;
  final Color color;

  const _Pill({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: theme.textTheme.labelSmall?.copyWith(
          color: color,
          fontWeight: FontWeight.w800,
        ),
      ),
    );
  }
}

/// Collects the fields a decision needs before the PATCH. Reason is required
/// for stop/hold/change (service `MEDREC_REASON_REQUIRED`); a change must
/// also spell out WHAT changes — structured dose/route/frequency or free-text
/// instructions (`MEDREC_CHANGE_DETAIL_REQUIRED`). Stop/change may carry an
/// optional safety rationale, which the backend wires into a
/// medication_safety_reviews row. Owns its controllers so disposal follows
/// the dialog's own widget lifecycle.
class _DecisionDialog extends StatefulWidget {
  final String decision;
  final String medicationName;

  const _DecisionDialog({required this.decision, required this.medicationName});

  @override
  State<_DecisionDialog> createState() => _DecisionDialogState();
}

class _DecisionDialogState extends State<_DecisionDialog> {
  final _reason = TextEditingController();
  final _instructions = TextEditingController();
  final _changedDose = TextEditingController();
  final _changedRoute = TextEditingController();
  final _changedFrequency = TextEditingController();
  final _safetyRationale = TextEditingController();
  String? _validationError;

  bool get _requiresReason =>
      const ['stop', 'hold', 'change'].contains(widget.decision);
  bool get _isChange => widget.decision == 'change';
  bool get _allowsSafetyRationale =>
      const ['stop', 'change'].contains(widget.decision);

  @override
  void dispose() {
    _reason.dispose();
    _instructions.dispose();
    _changedDose.dispose();
    _changedRoute.dispose();
    _changedFrequency.dispose();
    _safetyRationale.dispose();
    super.dispose();
  }

  void _submit() {
    final reason = _reason.text.trim();
    if (_requiresReason && reason.isEmpty) {
      setState(
        () => _validationError =
            "A reason is required for a '${widget.decision}' decision.",
      );
      return;
    }
    final hasChangeDetail =
        _changedDose.text.trim().isNotEmpty ||
        _changedRoute.text.trim().isNotEmpty ||
        _changedFrequency.text.trim().isNotEmpty ||
        _instructions.text.trim().isNotEmpty;
    if (_isChange && !hasChangeDetail) {
      setState(
        () => _validationError =
            'A change must spell out what changes — dose, route, frequency '
            'or instructions.',
      );
      return;
    }
    final result = <String, String>{
      if (reason.isNotEmpty) 'reason': reason,
      if (_instructions.text.trim().isNotEmpty)
        'new_instructions': _instructions.text.trim(),
      if (_isChange && _changedDose.text.trim().isNotEmpty)
        'changed_dose': _changedDose.text.trim(),
      if (_isChange && _changedRoute.text.trim().isNotEmpty)
        'changed_route': _changedRoute.text.trim(),
      if (_isChange && _changedFrequency.text.trim().isNotEmpty)
        'changed_frequency': _changedFrequency.text.trim(),
      if (_allowsSafetyRationale && _safetyRationale.text.trim().isNotEmpty)
        'safety_rationale': _safetyRationale.text.trim(),
    };
    Navigator.of(context).pop(result);
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final theme = Theme.of(context);
    return AlertDialog(
      title: Text(
        '${widget.decision.toUpperCase()} — ${widget.medicationName}',
      ),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              controller: _reason,
              autofocus: true,
              maxLines: 2,
              maxLength: 500,
              decoration: InputDecoration(
                labelText: _requiresReason ? 'Reason (required)' : 'Reason',
                hintText: AppStrings.of(context).medRecReasonHint,
              ),
            ),
            if (_isChange) ...[
              const SizedBox(height: 8),
              TextField(
                controller: _changedDose,
                decoration: InputDecoration(
                  labelText: AppStrings.of(context).medRecNewDose,
                ),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _changedRoute,
                decoration: InputDecoration(
                  labelText: AppStrings.of(context).medRecNewRoute,
                ),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _changedFrequency,
                decoration: InputDecoration(
                  labelText: AppStrings.of(context).medRecNewFrequency,
                ),
              ),
            ],
            if (_isChange || widget.decision == 'new') ...[
              const SizedBox(height: 8),
              TextField(
                controller: _instructions,
                maxLines: 2,
                decoration: InputDecoration(
                  labelText: AppStrings.of(context).medRecInstructions,
                  hintText: AppStrings.of(context).medRecInstructionsHint,
                ),
              ),
            ],
            if (_allowsSafetyRationale) ...[
              const SizedBox(height: 8),
              TextField(
                controller: _safetyRationale,
                maxLines: 2,
                decoration: InputDecoration(
                  labelText: AppStrings.of(context).medRecSafetyRationale,
                  hintText: AppStrings.of(context).medRecSafetyRationaleHint,
                ),
              ),
            ],
            if (_validationError != null) ...[
              const SizedBox(height: 8),
              Text(
                _validationError!,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.error,
                ),
              ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(null),
          child: Text(s.actionCancel),
        ),
        FilledButton(
          onPressed: _submit,
          child: Text(AppStrings.of(context).medRecSaveDecision),
        ),
      ],
    );
  }
}

class _InfoBanner extends StatelessWidget {
  final IconData icon;
  final String text;

  const _InfoBanner({required this.icon, required this.text});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Row(
        children: [
          Icon(icon, size: 18, color: theme.colorScheme.onSurfaceVariant),
          const SizedBox(width: 8),
          Expanded(child: Text(text, style: theme.textTheme.bodySmall)),
        ],
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;

  const _ErrorState({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = AppStrings.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.cloud_off, size: 48, color: theme.colorScheme.error),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh),
              label: Text(s.actionRetry),
            ),
          ],
        ),
      ),
    );
  }
}
