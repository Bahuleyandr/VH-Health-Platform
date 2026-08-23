import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../core/config/api_config.dart';
import '../../../core/services/med_rec_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/constrained_content.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../core/widgets/navigation_back_action.dart';
import '../../../l10n/app_strings.dart';
import 'med_rec_detail_screen.dart';

/// B6 — a patient's medication reconciliations (admission / transfer /
/// discharge). Doctors, pharmacists and admins can start a reconciliation;
/// other clinical staff get a read-only list. Tapping a row opens
/// [MedRecDetailScreen] for the per-item decision workflow.
class MedRecScreen extends StatefulWidget {
  /// Null when opened from the dashboard tile — the screen then shows a
  /// patient-UID lookup first (console idiom, like the ED workbench).
  final String? patientUid;
  final String? patientName;

  const MedRecScreen({super.key, this.patientUid, this.patientName});

  @override
  State<MedRecScreen> createState() => _MedRecScreenState();
}

class _MedRecScreenState extends State<MedRecScreen> {
  final _dateFmt = DateFormat('dd MMM, HH:mm');
  final _uidLookup = TextEditingController();
  String? _patientUid;
  bool _loading = true;
  bool _starting = false;
  bool _canDecide = false;
  String? _error;
  List<Map<String, dynamic>> _recs = const [];

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    _patientUid = widget.patientUid;
    final rawRole = await ApiConfig.getRole();
    if (!mounted) return;
    setState(() => _canDecide = medRecCanDecideForRawRole(rawRole));
    if (_patientUid != null && _patientUid!.isNotEmpty) {
      await _load();
    } else {
      setState(() => _loading = false);
    }
  }

  @override
  void dispose() {
    _uidLookup.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final recs = await MedRecApiService.listForPatient(_patientUid!);
      if (!mounted) return;
      setState(() => _recs = recs);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  String _text(Object? value, [String fallback = '']) {
    final text = value?.toString().trim() ?? '';
    return text.isEmpty ? fallback : text;
  }

  Future<void> _openDetail(String recId) async {
    if (recId.isEmpty) return;
    await Navigator.push(
      context,
      MaterialPageRoute<void>(
        builder: (ctx) => MedRecDetailScreen(recId: recId),
      ),
    );
    if (!mounted) return;
    await _load();
  }

  Widget _buildUidLookup(ThemeData theme, AppStrings s) {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            s.medRecTitle,
            style: theme.textTheme.titleLarge?.copyWith(
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            s.lookup('ed_trauma.patient_uid'),
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            key: const ValueKey('med_rec_uid_lookup'),
            controller: _uidLookup,
            decoration: InputDecoration(
              labelText: s.lookup('ed_trauma.patient_uid'),
              border: const OutlineInputBorder(),
              suffixIcon: IconButton(
                icon: const Icon(Icons.arrow_forward),
                onPressed: _openLookup,
              ),
            ),
            onSubmitted: (_) => _openLookup(),
          ),
        ],
      ),
    );
  }

  void _openLookup() {
    final uid = _uidLookup.text.trim();
    if (uid.isEmpty) return;
    setState(() => _patientUid = uid);
    _load();
  }

  Future<void> _startReconciliation() async {
    final result = await showDialog<({String recType, String notes})>(
      context: context,
      builder: (ctx) => const _StartReconciliationDialog(),
    );
    if (result == null || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    final theme = Theme.of(context);
    setState(() => _starting = true);
    try {
      final rec = await MedRecApiService.startReconciliation(
        patientUid: _patientUid!,
        recType: result.recType,
        notes: result.notes.isEmpty ? null : result.notes,
      );
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            '${_recTypeLabel(result.recType)} reconciliation started — '
            'medication sources snapshotted',
          ),
        ),
      );
      final recId = _text(rec['id']);
      if (recId.isNotEmpty) {
        await _openDetail(recId);
      } else {
        await _load();
      }
    } catch (e) {
      if (!mounted) return;
      // e.g. MEDREC_ALREADY_OPEN — an in-progress reconciliation of this
      // type already exists; the server message says so.
      messenger.showSnackBar(
        SnackBar(
          content: Text(e.toString().replaceFirst('Exception: ', '')),
          backgroundColor: theme.colorScheme.error,
        ),
      );
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final theme = Theme.of(context);
    final name = (widget.patientName ?? '').trim();
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(
          name.isEmpty ? 'Medication reconciliation' : 'Med rec — $name',
        ),
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
        child: (_patientUid == null || _patientUid!.isEmpty)
            ? _buildUidLookup(theme, s)
            : _loading
            ? const Center(child: CircularProgressIndicator())
            : _error != null
            ? _ErrorState(message: _error!, onRetry: _load)
            : RefreshIndicator(
                onRefresh: _load,
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
                  children: [
                    if (_canDecide)
                      Align(
                        alignment: Alignment.centerLeft,
                        child: FilledButton.icon(
                          onPressed: _starting ? null : _startReconciliation,
                          icon: _starting
                              ? const SizedBox(
                                  width: 16,
                                  height: 16,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                )
                              : const Icon(Icons.playlist_add_check),
                          label: Text(s.medRecStart),
                        ),
                      ),
                    const SizedBox(height: 12),
                    if (_recs.isEmpty)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 32),
                        child: Center(
                          child: Text(
                            AppStrings.of(context).medRecNoneYet,
                            style: theme.textTheme.bodyMedium?.copyWith(
                              color: theme.colorScheme.onSurfaceVariant,
                            ),
                          ),
                        ),
                      )
                    else
                      ..._recs.map(
                        (rec) => _ReconciliationCard(
                          rec: rec,
                          dateFmt: _dateFmt,
                          onTap: () => _openDetail(_text(rec['id'])),
                        ),
                      ),
                  ],
                ),
              ),
      ),
    );
  }
}

String _recTypeLabel(String recType) => switch (recType) {
  'admission' => 'Admission',
  'discharge' => 'Discharge',
  'transfer' => 'Transfer',
  _ => recType,
};

IconData _recTypeIcon(String recType) => switch (recType) {
  'admission' => Icons.login,
  'discharge' => Icons.logout,
  'transfer' => Icons.swap_horiz,
  _ => Icons.medication_outlined,
};

class _ReconciliationCard extends StatelessWidget {
  final Map<String, dynamic> rec;
  final DateFormat dateFmt;
  final VoidCallback onTap;

  const _ReconciliationCard({
    required this.rec,
    required this.dateFmt,
    required this.onTap,
  });

  String _text(Object? value, [String fallback = '']) {
    final text = value?.toString().trim() ?? '';
    return text.isEmpty ? fallback : text;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final recType = _text(rec['rec_type']);
    final status = _text(rec['status'], 'in_progress');
    final statusColor = status == 'completed'
        ? AppTheme.primaryTeal
        : AppTheme.primaryBlue;
    final started = DateTime.tryParse(_text(rec['started_at']));
    final itemCount = int.tryParse(_text(rec['item_count'])) ?? 0;
    final undecided = int.tryParse(_text(rec['undecided_count'])) ?? 0;
    final notes = _text(rec['notes']);
    final countsLabel = undecided > 0
        ? '$itemCount medications · $undecided undecided'
        : '$itemCount medications · all decided';

    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        margin: const EdgeInsets.only(bottom: 10),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: AppTheme.cardSurface,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: AppTheme.divider),
        ),
        child: Row(
          children: [
            Container(
              width: 38,
              height: 38,
              decoration: BoxDecoration(
                color: statusColor.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Icon(_recTypeIcon(recType), color: statusColor),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${_recTypeLabel(recType)} reconciliation',
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  Text(
                    [
                      if (started != null) dateFmt.format(started.toLocal()),
                      countsLabel,
                    ].join(' · '),
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                  if (notes.isNotEmpty)
                    Text(
                      notes,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall,
                    ),
                ],
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
            const SizedBox(width: 4),
            Icon(
              Icons.chevron_right,
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ],
        ),
      ),
    );
  }
}

/// Rec-type picker + optional notes. Owns its [TextEditingController] so
/// disposal follows the dialog's own widget lifecycle.
class _StartReconciliationDialog extends StatefulWidget {
  const _StartReconciliationDialog();

  @override
  State<_StartReconciliationDialog> createState() =>
      _StartReconciliationDialogState();
}

class _StartReconciliationDialogState
    extends State<_StartReconciliationDialog> {
  final _notes = TextEditingController();
  String _recType = 'admission';

  @override
  void dispose() {
    _notes.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return AlertDialog(
      title: Text(AppStrings.of(context).medRecStart),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SegmentedButton<String>(
            segments: MedRecApiService.recTypes
                .map(
                  (recType) => ButtonSegment<String>(
                    value: recType,
                    label: Text(_recTypeLabel(recType)),
                  ),
                )
                .toList(),
            selected: {_recType},
            onSelectionChanged: (selection) =>
                setState(() => _recType = selection.first),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _notes,
            maxLines: 2,
            maxLength: 500,
            decoration: InputDecoration(
              labelText: AppStrings.of(context).medRecNotesOptional,
              hintText: AppStrings.of(context).medRecNotesHint,
            ),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(null),
          child: Text(s.actionCancel),
        ),
        FilledButton(
          onPressed: () =>
              Navigator.of(context)
                  .pop((recType: _recType, notes: _notes.text.trim())),
          child: Text(AppStrings.of(context).medRecStartShort),
        ),
      ],
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
