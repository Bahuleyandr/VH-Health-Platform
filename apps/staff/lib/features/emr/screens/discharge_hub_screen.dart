import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/services/clinical_ai_api_service.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';

class DischargeHubScreen extends StatefulWidget {
  final int admissionId;
  final String patientName;

  const DischargeHubScreen({
    super.key,
    required this.admissionId,
    required this.patientName,
  });

  @override
  State<DischargeHubScreen> createState() => _DischargeHubScreenState();
}

class _DischargeHubScreenState extends State<DischargeHubScreen> {
  bool _loading = true;
  String? _busyKey;
  String? _error;
  Map<String, dynamic>? _hub;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final hub = await MedicalApiService.getDischargeHub(widget.admissionId);
      if (!mounted) return;
      setState(() => _hub = hub);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Map<String, dynamic> _map(dynamic value) {
    if (value is Map<String, dynamic>) return value;
    if (value is Map) return Map<String, dynamic>.from(value);
    return <String, dynamic>{};
  }

  List<Map<String, dynamic>> _list(dynamic value) {
    if (value is! List) return const [];
    return value
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
  }

  String _displayName() {
    final admission = _map(_hub?['admission']);
    final fromHub = (admission['patient_name'] ?? '').toString();
    if (fromHub.isNotEmpty) return fromHub;
    if (widget.patientName.trim().isNotEmpty) return widget.patientName;
    return 'Patient';
  }

  Future<void> _showSafetyFlags(Map<String, dynamic> summary) async {
    final flags = _list(summary['safety_flags']);
    final theme = Theme.of(context);
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Safety flags', style: theme.textTheme.titleLarge),
              const SizedBox(height: 12),
              if (flags.isEmpty)
                const Text('No safety flags are attached to this summary.')
              else
                ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 320),
                  child: ListView.separated(
                    shrinkWrap: true,
                    itemCount: flags.length,
                    separatorBuilder: (_, separatorIndex) =>
                        const Divider(height: 16),
                    itemBuilder: (_, index) {
                      final flag = flags[index];
                      final severity = (flag['severity'] ?? 'review')
                          .toString()
                          .toUpperCase();
                      final code = (flag['code'] ?? flag['type'] ?? 'FLAG')
                          .toString();
                      final message =
                          (flag['message'] ??
                                  flag['description'] ??
                                  flag['reason'] ??
                                  'Doctor review required')
                              .toString();
                      return ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: Icon(
                          Icons.health_and_safety,
                          color: AppTheme.errorOnSurface,
                        ),
                        title: Text('$severity - $code'),
                        subtitle: Text(message),
                      );
                    },
                  ),
                ),
              const SizedBox(height: 16),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton(
                  onPressed: () => Navigator.pop(ctx),
                  child: const Text('Close'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _showSignerDetails(Map<String, dynamic> summary) async {
    final signedByName = (summary['signed_by_name'] ?? '').toString().trim();
    final signedByRole = (summary['signed_by_role'] ?? '').toString().trim();
    final signedBy = (summary['signed_by'] ?? '').toString().trim();
    final signedAt = (summary['signed_at'] ?? '').toString().trim();
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Signature details'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (summary['is_signed'] != true)
              const Text('This discharge summary still needs doctor sign-off.')
            else ...[
              Text(
                signedByName.isNotEmpty ? signedByName : 'Signer unavailable',
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
              if (signedByRole.isNotEmpty) Text(signedByRole),
              if (signedBy.isNotEmpty) Text('User ID: $signedBy'),
              if (signedAt.isNotEmpty) Text('Signed at: $signedAt'),
            ],
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Close'),
          ),
        ],
      ),
    );
  }

  Future<void> _startAiPackage() async {
    setState(() => _busyKey = 'ai');
    try {
      final result = await ClinicalAiApiService.startDischargeCompose(
        admissionId: widget.admissionId,
      );
      if (!mounted) return;
      final runId = result['run_id'] ?? result['workflow_run_id'];
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('AI discharge package started')),
      );
      if (runId is int) {
        context.push('/clinical-ai/compose/$runId', extra: result);
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('AI package failed: $e')));
    } finally {
      if (mounted) setState(() => _busyKey = null);
    }
  }

  Future<String?> _askFinishNotes(Map<String, dynamic> item) async {
    final controller = TextEditingController();
    final label = (item['label'] ?? 'work item').toString();
    final result = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Finish $label'),
        content: TextField(
          controller: controller,
          autofocus: true,
          minLines: 3,
          maxLines: 5,
          decoration: const InputDecoration(
            labelText: 'Completion note',
            hintText: 'Advice given, handover completed, bill cleared...',
            border: OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Cancel'),
          ),
          FilledButton.icon(
            onPressed: () => Navigator.pop(ctx, controller.text),
            icon: const Icon(Icons.task_alt, size: 18),
            label: const Text('Finish'),
          ),
        ],
      ),
    );
    controller.dispose();
    return result;
  }

  Future<void> _finishWorkItem(Map<String, dynamic> item) async {
    final type = (item['consult_type'] ?? '').toString();
    if (type.isEmpty) return;
    final notes = await _askFinishNotes(item);
    if (notes == null || !mounted) return;

    setState(() => _busyKey = type);
    try {
      if (type == 'pharmacy') {
        await MedicalApiService.markDischargeDrugsDispensed(widget.admissionId);
      }
      await MedicalApiService.completeDischargeWorkItem(
        widget.admissionId,
        type,
        notes: notes,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('${item['label'] ?? 'Task'} finished')),
      );
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('Could not finish task: $e')));
    } finally {
      if (mounted) setState(() => _busyKey = null);
    }
  }

  void _openSummary() {
    final name = Uri.encodeQueryComponent(_displayName());
    context.push('/emr/discharge/${widget.admissionId}?name=$name');
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text('Discharge Hub - ${_displayName()}'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh),
          ),
          const LogoutAction(),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
          ? _buildError(theme)
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  _buildAdmissionBanner(theme),
                  const SizedBox(height: 12),
                  _buildSummaryCard(theme),
                  const SizedBox(height: 12),
                  _buildWorkItems(theme),
                  const SizedBox(height: 12),
                  _buildReadinessCard(theme),
                  const SizedBox(height: 12),
                  _buildAiCard(theme),
                  const SizedBox(height: 88),
                ],
              ),
            ),
    );
  }

  Widget _buildError(ThemeData theme) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.cloud_off, size: 48, color: theme.colorScheme.error),
            const SizedBox(height: 12),
            Text(_error!, textAlign: TextAlign.center),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: _load,
              icon: const Icon(Icons.refresh),
              label: const Text('Retry'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildAdmissionBanner(ThemeData theme) {
    final admission = _map(_hub?['admission']);
    final ready = _map(_hub?['readiness'])['ready'] == true;
    final initiated = _hub?['discharge_initiated'] == true;
    final ward = (admission['ward'] ?? admission['bed_ward_name'] ?? '')
        .toString();
    final bed = (admission['bed_number'] ?? '').toString();
    final hospitalNumber =
        (admission['patient_hospital_number'] ??
                admission['hospital_number'] ??
                '')
            .toString()
            .trim();
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: theme.colorScheme.primaryContainer.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(_displayName(), style: theme.textTheme.titleLarge),
          const SizedBox(height: 6),
          Text(
            [
              if (hospitalNumber.isNotEmpty) 'Hospital ID $hospitalNumber',
              if (ward.isNotEmpty) ward,
              if (bed.isNotEmpty) 'Bed $bed',
              'Admission #${widget.admissionId}',
            ].join(' · '),
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _chip(
                initiated ? 'Discharge initiated' : 'Not initiated',
                initiated ? Colors.orange : Colors.grey,
                Icons.pending_actions,
              ),
              _chip(
                ready ? 'Ready for final discharge' : 'Checklist pending',
                ready ? Colors.green : Colors.blueGrey,
                ready ? Icons.verified : Icons.rule,
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildSummaryCard(ThemeData theme) {
    final summary = _map(_hub?['summary']);
    final signed = summary['is_signed'] == true;
    final label = (summary['ai_label'] ?? 'No discharge summary draft yet')
        .toString();
    final citations = summary['source_citation_count'] ?? 0;
    final flags = summary['safety_flag_count'] ?? 0;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _sectionTitle(
              theme,
              'Doctor summary',
              signed ? Icons.verified : Icons.edit_document,
            ),
            const SizedBox(height: 8),
            Text(label),
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                ActionChip(
                  avatar: Icon(
                    Icons.draw,
                    size: 16,
                    color: signed
                        ? AppTheme.successOnSurface
                        : AppTheme.warningOnSurface,
                  ),
                  label: Text(signed ? 'Signed' : 'Doctor review needed'),
                  side: BorderSide(
                    color: signed
                        ? AppTheme.successOnSurface
                        : AppTheme.warningOnSurface,
                  ),
                  backgroundColor:
                      (signed
                              ? AppTheme.successOnSurface
                              : AppTheme.warningOnSurface)
                          .withValues(alpha: 0.10),
                  onPressed: () => _showSignerDetails(summary),
                ),
                _chip('$citations sources', Colors.blue, Icons.source),
                ActionChip(
                  avatar: Icon(
                    Icons.health_and_safety,
                    size: 16,
                    color: flags == 0
                        ? AppTheme.successOnSurface
                        : AppTheme.errorOnSurface,
                  ),
                  label: Text('$flags safety flags'),
                  side: BorderSide(
                    color: flags == 0
                        ? AppTheme.successOnSurface
                        : AppTheme.errorOnSurface,
                  ),
                  backgroundColor:
                      (flags == 0
                              ? AppTheme.successOnSurface
                              : AppTheme.errorOnSurface)
                          .withValues(alpha: 0.10),
                  onPressed: () => _showSafetyFlags(summary),
                ),
              ],
            ),
            const SizedBox(height: 12),
            FilledButton.icon(
              onPressed: _openSummary,
              icon: const Icon(Icons.summarize),
              label: Text(
                signed ? 'View signed summary' : 'Open summary editor',
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildWorkItems(ThemeData theme) {
    final items = _list(_hub?['work_items']);
    if (items.isEmpty) {
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _sectionTitle(theme, 'Role work items', Icons.groups),
              const SizedBox(height: 8),
              const Text(
                'Start discharge to open dietary, counselling, pharmacy, physiotherapy, and billing tasks.',
              ),
            ],
          ),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
          child: _sectionTitle(theme, 'Role work items', Icons.groups),
        ),
        ...items.map((item) => _workItemCard(theme, item)),
      ],
    );
  }

  Widget _workItemCard(ThemeData theme, Map<String, dynamic> item) {
    final type = (item['consult_type'] ?? '').toString();
    final done = item['completed_at'] != null;
    final canComplete = item['actor_can_complete'] == true;
    final owner = (item['owner_label'] ?? 'Hospital team').toString();
    final notes = (item['notes'] ?? '').toString();
    return Card(
      child: ListTile(
        leading: Icon(
          done ? Icons.check_circle : _iconForType(type),
          color: done ? Colors.green : theme.colorScheme.primary,
        ),
        title: Text((item['label'] ?? type).toString()),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(done ? 'Finished by ${item['completed_by'] ?? owner}' : owner),
            if (notes.isNotEmpty) Text(notes),
            if (type == 'pharmacy' && !done)
              const Text(
                'Finishing this also requires discharge drugs dispensed.',
              ),
          ],
        ),
        trailing: done
            ? const Text('Done')
            : canComplete
            ? FilledButton(
                onPressed: _busyKey == type
                    ? null
                    : () => _finishWorkItem(item),
                child: _busyKey == type
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('Finish'),
              )
            : const Text('Pending'),
      ),
    );
  }

  Widget _buildReadinessCard(ThemeData theme) {
    final readiness = _map(_hub?['readiness']);
    final blockers = _list(readiness['blockers']);
    final ready = readiness['ready'] == true;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _sectionTitle(theme, 'Final discharge gate', Icons.rule_folder),
            const SizedBox(height: 8),
            Text(
              ready
                  ? 'All required work is complete. Final discharge can proceed from the signed summary screen.'
                  : 'Final discharge stays blocked until every item below is clear.',
            ),
            if (blockers.isNotEmpty) ...[
              const SizedBox(height: 12),
              ...blockers.map(
                (blocker) => Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Icon(
                        Icons.error_outline,
                        color: Colors.orange,
                        size: 20,
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          (blocker['message'] ??
                                  blocker['type'] ??
                                  'Pending item')
                              .toString(),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildAiCard(ThemeData theme) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _sectionTitle(theme, 'Clinical AI package', Icons.auto_awesome),
            const SizedBox(height: 8),
            const Text(
              'Creates the reviewed discharge package from medication reconciliation, aftercare, readiness, and coding modules. It is draft-only until a doctor reviews and signs.',
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: _busyKey == 'ai' ? null : _startAiPackage,
              icon: _busyKey == 'ai'
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.auto_awesome),
              label: const Text('Generate AI package'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _sectionTitle(ThemeData theme, String text, IconData icon) {
    return Row(
      children: [
        Icon(icon, size: 20, color: theme.colorScheme.primary),
        const SizedBox(width: 8),
        Text(text, style: theme.textTheme.titleMedium),
      ],
    );
  }

  Widget _chip(String label, Color color, IconData icon) {
    return Chip(
      avatar: Icon(icon, size: 16, color: color),
      label: Text(label),
      side: BorderSide(color: color.withValues(alpha: 0.35)),
      backgroundColor: color.withValues(alpha: 0.08),
    );
  }

  IconData _iconForType(String type) {
    switch (type) {
      case 'dietary':
        return Icons.restaurant_menu;
      case 'family_counselling':
        return Icons.diversity_3;
      case 'pharmacy':
        return Icons.medication;
      case 'physiotherapy':
        return Icons.accessibility_new;
      case 'billing':
        return Icons.receipt_long;
      default:
        return Icons.task_alt;
    }
  }
}
