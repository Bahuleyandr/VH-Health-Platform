import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';

import '../../../core/models/care_pathway_work_models.dart';
import '../../../core/services/care_pathway_api_service.dart';
import '../../../core/services/clinical_ai_api_service.dart';
import '../../../core/services/clinical_print_service.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/clinical_print_pdf_action.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../core/widgets/online_only_action_state.dart';

import 'package:vhhealth_staff/l10n/app_strings.dart';

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
  InpatientPendingResultsWork? _pendingResultsWork;

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
      final results = await Future.wait<dynamic>([
        MedicalApiService.getDischargeHub(widget.admissionId),
        CarePathwayApiService.getAdmissionPendingResults(widget.admissionId),
      ]);
      if (!mounted) return;
      setState(() {
        _hub = Map<String, dynamic>.from(results[0] as Map);
        _pendingResultsWork = results[1] as InpatientPendingResultsWork;
      });
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

  bool _requireOnline() {
    if (ConnectivitySyncService.instance.isOnline) return true;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: AppText(
          's4.lib.discharge_hub.pathway_actions_require_connection',
        ),
      ),
    );
    return false;
  }

  int? _signedSummaryId() {
    final fromPathway = _pendingResultsWork?.signedSummaryId;
    if (fromPathway != null) return fromPathway;
    final summary = _map(_hub?['summary']);
    if (summary['is_signed'] != true) return null;
    final value = summary['id'];
    if (value is int) return value;
    return int.tryParse(value?.toString() ?? '');
  }

  Future<void> _createPendingResultHandoff(
    DischargePendingResultHandoff item,
  ) async {
    if (!_requireOnline() || !item.canCreateNamedOwnerHandoff) return;
    final busyKey = 'handoff:${item.sourceType}:${item.sourceId}';
    setState(() => _busyKey = busyKey);
    try {
      await CarePathwayApiService.createPendingResultHandoff(
        admissionId: widget.admissionId,
        sourceType: item.sourceType,
        sourceId: item.sourceId,
        resourceReferenceId: item.resourceReferenceId!,
        patientSafeLabel: item.safeLabel,
      );
      if (!mounted) return;
      await _load();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: AppText('s4.lib.discharge_hub.named_owner_handoff_recorded'),
        ),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error.toString())));
    } finally {
      if (mounted) setState(() => _busyKey = null);
    }
  }

  Future<void> _bindPendingResultToSummary(
    DischargePendingResultHandoff item,
  ) async {
    final summaryId = _signedSummaryId();
    if (!_requireOnline() || !item.canBindSignedSummary || summaryId == null) {
      return;
    }
    final busyKey = 'summary:${item.handoffId}';
    setState(() => _busyKey = busyKey);
    try {
      await CarePathwayApiService.bindPendingResultToSignedSummary(
        admissionId: widget.admissionId,
        handoffId: item.handoffId!,
        dischargeSummaryId: summaryId,
      );
      if (!mounted) return;
      await _load();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: AppText(
            's4.lib.discharge_hub.pending_result_bound_to_summary',
          ),
        ),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error.toString())));
    } finally {
      if (mounted) setState(() => _busyKey = null);
    }
  }

  Future<void> _recordFollowUpException() async {
    if (!_requireOnline()) return;
    final controller = TextEditingController();
    final formKey = GlobalKey<FormState>();
    final reason = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const AppText('s4.lib.discharge_hub.follow_up_exception_title'),
        content: Form(
          key: formKey,
          child: TextFormField(
            key: const Key('discharge-follow-up-exception-reason'),
            controller: controller,
            autofocus: true,
            minLines: 3,
            maxLines: 6,
            maxLength: 1000,
            decoration: InputDecoration(
              labelText: AppStrings.of(context)
                  .lookup('s4.lib.discharge_hub.follow_up_exception_reason'),
              border: const OutlineInputBorder(),
            ),
            validator: (value) => value?.trim().isNotEmpty == true
                ? null
                : AppStrings.of(context).lookup(
                    's4.lib.discharge_hub.follow_up_exception_reason_required',
                  ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const AppText('action.cancel'),
          ),
          FilledButton(
            key: const Key('discharge-follow-up-exception-submit'),
            onPressed: () {
              if (formKey.currentState?.validate() != true) return;
              Navigator.pop(dialogContext, controller.text.trim());
            },
            child: const AppText(
              's4.lib.discharge_hub.record_follow_up_exception',
            ),
          ),
        ],
      ),
    );
    controller.dispose();
    if (reason == null || !mounted) return;
    setState(() => _busyKey = 'follow-up-exception');
    try {
      await CarePathwayApiService.recordFollowUpException(
        admissionId: widget.admissionId,
        reason: reason,
      );
      if (!mounted) return;
      await _load();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: AppText('s4.lib.discharge_hub.follow_up_exception_recorded'),
        ),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error.toString())));
    } finally {
      if (mounted) setState(() => _busyKey = null);
    }
  }

  Future<void> _showSafetyFlags(Map<String, dynamic> summary) async {
    final flags = _list(summary['safety_flags']);
    final theme = Theme.of(context);
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      backgroundColor: theme.colorScheme.surface,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              AppText(
                'clinical_ai.draft.safety_header',
                style: theme.textTheme.titleLarge,
              ),
              const SizedBox(height: 12),
              if (flags.isEmpty)
                const AppText(
                  's4.lib.discharge_hub.no_safety_flags_are_attached_to_this_summary',
                )
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
                  child: const AppText('action.close'),
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
        title: const AppText('s4.lib.discharge_hub.signature_details'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (summary['is_signed'] != true)
              const AppText(
                's4.lib.discharge_hub.this_discharge_summary_still_needs_doctor_sign_o',
              )
            else ...[
              Text(
                signedByName.isNotEmpty ? signedByName : 'Signer unavailable',
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
              if (signedByRole.isNotEmpty) Text(signedByRole),
              if (signedBy.isNotEmpty)
                AppText(
                  's4.dynamic.common.user_id',
                  values: {'userId': signedBy},
                ),
              if (signedAt.isNotEmpty)
                AppText(
                  's4.dynamic.common.signed_at',
                  values: {'signedAt': signedAt},
                ),
            ],
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const AppText('action.close'),
          ),
        ],
      ),
    );
  }

  Future<void> _startAiPackage() async {
    if (!OnlineOnlyActionGuard.require(context)) return;
    setState(() => _busyKey = 'ai');
    try {
      final result = await ClinicalAiApiService.startDischargeCompose(
        admissionId: widget.admissionId,
      );
      if (!mounted) return;
      final runId = result['run_id'] ?? result['workflow_run_id'];
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: AppText('s4.lib.discharge_hub.ai_discharge_package_started'),
        ),
      );
      if (runId is int) {
        unawaited(context.push('/clinical-ai/compose/$runId', extra: result));
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: AppText(
            's4.dynamic.discharge_hub.ai_package_failed',
            values: {'error': e},
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => _busyKey = null);
    }
  }

  Future<String?> _askFinishNotes(Map<String, dynamic> item) async {
    final controller = TextEditingController();
    final s = AppStrings.of(context);
    final label = (item['label'] ?? s.lookup('s4.lib.discharge_hub.work_item'))
        .toString();
    final result = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: AppText(
          's4.dynamic.discharge_hub.finish_task_title',
          values: {'label': label},
        ),
        content: TextField(
          controller: controller,
          autofocus: true,
          minLines: 3,
          maxLines: 5,
          decoration: InputDecoration(
            labelText: s.lookup('s4.lib.discharge_hub.completion_note'),
            hintText: s.lookup(
              's4.lib.discharge_hub.advice_given_handover_completed_bill_cleared',
            ),
            border: const OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const AppText('action.cancel'),
          ),
          FilledButton.icon(
            onPressed: () => Navigator.pop(ctx, controller.text),
            icon: const Icon(Icons.task_alt, size: 18),
            label: const AppText('s4.lib.discharge_hub.finish'),
          ),
        ],
      ),
    );
    controller.dispose();
    return result;
  }

  Future<void> _finishWorkItem(Map<String, dynamic> item) async {
    if (!OnlineOnlyActionGuard.require(context)) return;
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
      final s = AppStrings.of(context);
      final label =
          (item['label'] ?? s.lookup('s4.lib.discharge_hub.work_item'))
              .toString();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: AppText(
            's4.dynamic.discharge_hub.task_finished',
            values: {'label': label},
          ),
        ),
      );
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: AppText(
            's4.dynamic.discharge_hub.finish_task_failed',
            values: {'error': e},
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => _busyKey = null);
    }
  }

  void _openSummary() {
    final name = Uri.encodeQueryComponent(_displayName());
    context.push('/emr/discharge/${widget.admissionId}?name=$name');
  }

  Future<void> _printDischargeSummaryPdf() async {
    setState(() => _busyKey = 'summary-print');
    try {
      await ClinicalPrintService.printDischargeSummary(
        admissionId: widget.admissionId,
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: AppText(
            's4.dynamic.discharge_hub.pdf_open_failed',
            values: {'error': e.toString().replaceFirst('Exception: ', '')},
          ),
          backgroundColor: AppTheme.errorRed,
        ),
      );
    } finally {
      if (mounted) setState(() => _busyKey = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: AppText(
          's4.dynamic.discharge_hub.title_for_patient',
          values: {'patient': _displayName()},
        ),
        actions: [
          IconButton(
            tooltip: AppStrings.of(context).lookup('action.refresh'),
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
                  _buildPendingResults(theme),
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
              label: const AppText('action.retry'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildAdmissionBanner(ThemeData theme) {
    final s = AppStrings.of(context);
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
              if (hospitalNumber.isNotEmpty)
                s.format('s4.dynamic.discharge_hub.hospital_id', {
                  'id': hospitalNumber,
                }),
              if (ward.isNotEmpty) ward,
              if (bed.isNotEmpty)
                s.format('s4.dynamic.discharge_hub.bed', {'bed': bed}),
              s.format('s4.dynamic.discharge_hub.admission_id', {
                'id': widget.admissionId,
              }),
            ].join(' · '),
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _chip(
                initiated
                    ? s.lookup('s4.lib.discharge_hub.discharge_initiated')
                    : s.lookup('s4.lib.discharge_hub.not_initiated'),
                initiated ? Colors.orange : Colors.grey,
                Icons.pending_actions,
              ),
              _chip(
                ready
                    ? s.lookup('s4.lib.discharge_hub.ready_for_final_discharge')
                    : s.lookup('s4.lib.discharge_hub.checklist_pending'),
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
    final s = AppStrings.of(context);
    final summary = _map(_hub?['summary']);
    final signed = summary['is_signed'] == true;
    final label =
        (summary['ai_label'] ??
                s.lookup('s4.lib.discharge_hub.no_summary_draft'))
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
              s.lookup('s4.lib.discharge_hub.doctor_summary'),
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
                  label: Text(
                    signed
                        ? s.lookup('s4.lib.prescriptions.signed')
                        : s.lookup('s4.lib.discharge_hub.doctor_review_needed'),
                  ),
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
                _chip(
                  _sourceCountLabel(s, citations),
                  Colors.blue,
                  Icons.source,
                ),
                _safetyFlagButton(theme, summary, flags),
              ],
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 10,
              runSpacing: 10,
              children: [
                FilledButton.icon(
                  onPressed: _openSummary,
                  icon: const Icon(Icons.summarize),
                  label: Text(
                    signed
                        ? s.lookup('s4.lib.discharge_hub.view_signed_summary')
                        : s.lookup('s4.lib.discharge_hub.open_summary_editor'),
                  ),
                ),
                ClinicalPrintPdfAction(
                  key: const Key('discharge-summary-print-share-pdf'),
                  visible: signed,
                  busy: _busyKey == 'summary-print',
                  onPressed: _printDischargeSummaryPdf,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _safetyFlagButton(
    ThemeData theme,
    Map<String, dynamic> summary,
    dynamic rawCount,
  ) {
    final s = AppStrings.of(context);
    final count = int.tryParse('$rawCount') ?? 0;
    final hasFlags = count > 0;
    final color = hasFlags
        ? AppTheme.errorOnSurface
        : AppTheme.successOnSurface;
    return OutlinedButton.icon(
      onPressed: () => _showSafetyFlags(summary),
      icon: Icon(Icons.health_and_safety, size: 18, color: color),
      label: Text(
        hasFlags
            ? _safetyFlagCountLabel(s, count)
            : s.lookup('s4.lib.discharge_hub.no_safety_flags'),
      ),
      style: OutlinedButton.styleFrom(
        visualDensity: VisualDensity.compact,
        minimumSize: const Size(0, 38),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        foregroundColor: color,
        side: BorderSide(color: color),
        backgroundColor: color.withValues(alpha: 0.10),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
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
              _sectionTitle(
                theme,
                AppStrings.of(context)
                    .lookup('s4.lib.discharge_hub.role_work_items'),
                Icons.groups,
              ),
              const SizedBox(height: 8),
              const AppText(
                's4.lib.discharge_hub.start_discharge_to_open_dietary_counselling_phar',
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
          child: _sectionTitle(
            theme,
            AppStrings.of(context)
                .lookup('s4.lib.discharge_hub.role_work_items'),
            Icons.groups,
          ),
        ),
        ...items.map((item) => _workItemCard(theme, item)),
      ],
    );
  }

  Widget _buildPendingResults(ThemeData theme) {
    final s = AppStrings.of(context);
    final pendingWork = _pendingResultsWork;
    final pathway = _map(
      _hub?['pathway'] ??
          _hub?['pathway_evidence'] ??
          _hub?['inpatient_pathway'],
    );
    final pathwayMode =
        (pendingWork?.mode ??
                _hub?['pathway_mode'] ??
                _hub?['mode'] ??
                pathway['mode'] ??
                '')
            .toString()
            .trim()
            .toLowerCase();
    var raw =
        _hub?['pending_result_handoffs'] ??
        _hub?['pending_results'] ??
        pathway['pending_result_handoffs'] ??
        pathway['pending_results'] ??
        _map(pathway['evidence'])['pending_results'];
    if (raw is Map) {
      raw = raw['items'] ?? raw['pending_result_handoffs'];
    }
    final pendingResults =
        pendingWork?.items ??
        _list(raw)
            .map(DischargePendingResultHandoff.fromJson)
            .toList(growable: false);

    return Card(
      key: const Key('discharge-pending-result-handoffs'),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _sectionTitle(
              theme,
              s.lookup('s4.lib.discharge_hub.pending_result_handoffs'),
              Icons.science_outlined,
            ),
            const SizedBox(height: 6),
            Text(
              s.lookup(switch (pathwayMode) {
                'off' => 's4.lib.discharge_hub.pathway_mode_off_explanation',
                'shadow' =>
                  's4.lib.discharge_hub.pathway_mode_shadow_explanation',
                _ => 's4.lib.discharge_hub.pending_result_handoffs_explanation',
              }),
            ),
            const SizedBox(height: 12),
            if (pendingResults.isEmpty)
              Row(
                children: [
                  Icon(
                    Icons.check_circle_outline,
                    size: 20,
                    color: AppTheme.successOnSurface,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      s.lookup(
                        's4.lib.discharge_hub.no_pending_result_handoffs',
                      ),
                    ),
                  ),
                ],
              )
            else
              ...pendingResults.map(
                (item) => Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: _pendingResultCard(
                    theme,
                    item,
                    pathwayMode: pathwayMode,
                  ),
                ),
              ),
            if (pathwayMode == 'active') ...[
              const Divider(height: 22),
              if (pendingWork?.followUpExceptionReason?.isNotEmpty == true)
                Container(
                  key: const Key('discharge-follow-up-exception-recorded'),
                  width: double.infinity,
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: AppTheme.warningOnSurface.withValues(alpha: 0.08),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Text(
                    s.format(
                      's4.dynamic.discharge_hub.follow_up_exception_reason',
                      {'reason': pendingWork!.followUpExceptionReason},
                    ),
                  ),
                )
              else
                OutlinedButton.icon(
                  key: const Key('discharge-record-follow-up-exception'),
                  onPressed: _busyKey == 'follow-up-exception'
                      ? null
                      : _recordFollowUpException,
                  icon: _busyKey == 'follow-up-exception'
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.rule_outlined),
                  label: Text(
                    s.lookup('s4.lib.discharge_hub.record_follow_up_exception'),
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _pendingResultCard(
    ThemeData theme,
    DischargePendingResultHandoff item, {
    required String pathwayMode,
  }) {
    final s = AppStrings.of(context);
    final owner = [
      item.ownerName,
      item.ownerRole,
      item.ownerRoute,
    ].whereType<String>().where((part) => part.isNotEmpty).join(' · ');
    final label = item.safeLabel.isEmpty
        ? s.lookup('s4.lib.discharge_hub.pending_result')
        : item.safeLabel;
    final blockerDetails = item.blockerCodes
        .map((code) => code.trim())
        .where((part) => part.isNotEmpty)
        .toSet()
        .toList();
    final enforcesBlocking =
        item.blocking && pathwayMode != 'off' && pathwayMode != 'shadow';
    final statusKey = enforcesBlocking
        ? 's4.lib.discharge_hub.pending_result_blocks_discharge'
        : item.blocking && pathwayMode == 'shadow'
        ? 's4.lib.discharge_hub.pending_result_would_block_in_active_mode'
        : item.handoffComplete
        ? 's4.lib.discharge_hub.pending_result_handed_off'
        : 's4.lib.discharge_hub.handoff_incomplete';

    return Container(
      key: Key('pending-result-${item.sourceType}-${item.sourceId}'),
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        border: Border.all(
          color:
              (enforcesBlocking
                      ? AppTheme.errorOnSurface
                      : AppTheme.warningOnSurface)
                  .withValues(alpha: 0.35),
        ),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                enforcesBlocking
                    ? Icons.report_outlined
                    : Icons.pending_actions,
                color: enforcesBlocking
                    ? AppTheme.errorOnSurface
                    : AppTheme.warningOnSurface,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      label,
                      style: theme.textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    Text(
                      [
                        item.sourceType.replaceAll('_', ' '),
                        item.currentStatus.replaceAll('_', ' '),
                      ].where((part) => part.isNotEmpty).join(' · '),
                    ),
                  ],
                ),
              ),
              Chip(
                visualDensity: VisualDensity.compact,
                label: Text(s.lookup(statusKey)),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            owner.isEmpty
                ? s.lookup('s4.lib.discharge_hub.named_physician_not_recorded')
                : s.format('s4.dynamic.discharge_hub.named_physician', {
                    'owner': owner,
                  }),
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 6),
          Wrap(
            spacing: 8,
            runSpacing: 6,
            children: [
              _chip(
                item.exactLineage
                    ? s.lookup('s4.lib.discharge_hub.exact_lineage_confirmed')
                    : s.lookup(
                        's4.lib.discharge_hub.exact_lineage_not_confirmed',
                      ),
                item.exactLineage ? Colors.green : Colors.orange,
                item.exactLineage ? Icons.link : Icons.link_off,
              ),
              _chip(
                item.summaryIncluded
                    ? s.lookup(
                        's4.lib.discharge_hub.included_in_signed_summary',
                      )
                    : s.lookup('s4.lib.discharge_hub.not_in_signed_summary'),
                item.summaryIncluded ? Colors.green : Colors.orange,
                item.summaryIncluded
                    ? Icons.description_outlined
                    : Icons.file_present_outlined,
              ),
              _chip(
                item.handoffComplete
                    ? s.lookup('s4.lib.discharge_hub.handoff_accepted')
                    : s.lookup('s4.lib.discharge_hub.handoff_incomplete'),
                item.handoffComplete ? Colors.green : Colors.orange,
                item.handoffComplete
                    ? Icons.how_to_reg_outlined
                    : Icons.person_search_outlined,
              ),
            ],
          ),
          if (pathwayMode == 'active' && item.supportsStaffHandoffAction) ...[
            const SizedBox(height: 10),
            Text(
              s.lookup(
                's4.lib.discharge_hub.pending_result_action_explanation',
              ),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                if (item.handoffId == null)
                  FilledButton.icon(
                    key: Key(
                      'pending-result-create-handoff-${item.sourceType}-${item.sourceId}',
                    ),
                    onPressed:
                        item.canCreateNamedOwnerHandoff &&
                            _busyKey !=
                                'handoff:${item.sourceType}:${item.sourceId}'
                        ? () => _createPendingResultHandoff(item)
                        : null,
                    icon:
                        _busyKey ==
                            'handoff:${item.sourceType}:${item.sourceId}'
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.person_add_alt_1_outlined),
                    label: Text(
                      item.resourceReferenceId == null
                          ? s.lookup(
                              's4.lib.discharge_hub.exact_reference_required',
                            )
                          : s.lookup(
                              's4.lib.discharge_hub.record_named_owner_handoff',
                            ),
                    ),
                  ),
                if (item.canBindSignedSummary)
                  OutlinedButton.icon(
                    key: Key(
                      'pending-result-bind-summary-${item.sourceType}-${item.sourceId}',
                    ),
                    onPressed:
                        _signedSummaryId() != null &&
                            _busyKey != 'summary:${item.handoffId}'
                        ? () => _bindPendingResultToSummary(item)
                        : null,
                    icon: _busyKey == 'summary:${item.handoffId}'
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.note_add_outlined),
                    label: Text(
                      _signedSummaryId() == null
                          ? s.lookup(
                              's4.lib.discharge_hub.signed_summary_required',
                            )
                          : s.lookup(
                              's4.lib.discharge_hub.include_in_signed_summary',
                            ),
                    ),
                  ),
              ],
            ),
          ],
          if (blockerDetails.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              s.lookup(
                pathwayMode == 'off' || pathwayMode == 'shadow'
                    ? 's4.lib.discharge_hub.review_findings'
                    : 's4.lib.discharge_hub.blocking_reasons',
              ),
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
            ...blockerDetails.map(
              (reason) => Padding(
                padding: const EdgeInsets.only(top: 3),
                child: Text('• $reason'),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _workItemCard(ThemeData theme, Map<String, dynamic> item) {
    final s = AppStrings.of(context);
    final type = (item['consult_type'] ?? '').toString();
    final done = item['completed_at'] != null;
    final canComplete = item['actor_can_complete'] == true;
    final owner =
        (item['owner_label'] ?? s.lookup('s4.lib.discharge_hub.hospital_team'))
            .toString();
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
            Text(
              done
                  ? s.format('s4.dynamic.discharge_hub.finished_by', {
                      'name': item['completed_by'] ?? owner,
                    })
                  : owner,
            ),
            if (notes.isNotEmpty) Text(notes),
            if (type == 'pharmacy' && !done)
              const AppText(
                's4.lib.discharge_hub.finishing_this_also_requires_discharge_drugs_dis',
              ),
          ],
        ),
        trailing: done
            ? const AppText('incident_report.done_button')
            : canComplete
            ? OnlineOnlyActionState(
                builder: (context, isOnline, offlineMessage) => Tooltip(
                  message: isOnline ? '' : offlineMessage,
                  child: FilledButton(
                    onPressed: _busyKey == type || !isOnline
                        ? null
                        : () => _finishWorkItem(item),
                    child: _busyKey == type
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const AppText('s4.lib.discharge_hub.finish'),
                  ),
                ),
              )
            : const AppText('appt_queue.tab.pending_prefix'),
      ),
    );
  }

  Widget _buildReadinessCard(ThemeData theme) {
    final s = AppStrings.of(context);
    final readiness = _map(_hub?['readiness']);
    final blockers = _list(readiness['blockers']);
    final ready = readiness['ready'] == true;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _sectionTitle(
              theme,
              s.lookup('s4.lib.discharge_hub.final_discharge_gate'),
              Icons.rule_folder,
            ),
            const SizedBox(height: 8),
            Text(
              ready
                  ? s.lookup('s4.lib.discharge_hub.final_gate_ready')
                  : s.lookup('s4.lib.discharge_hub.final_gate_blocked'),
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
                                  s.lookup('s4.lib.discharge_hub.pending_item'))
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
            const AppText(
              's4.lib.discharge_hub.creates_the_reviewed_discharge_package_from_medi',
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
              label: const AppText('s4.lib.discharge_hub.generate_ai_package'),
            ),
          ],
        ),
      ),
    );
  }

  String _sourceCountLabel(AppStrings s, Object? rawCount) {
    final count = int.tryParse('$rawCount') ?? 0;
    return s.format(
      count == 1
          ? 's4.dynamic.discharge_hub.source_count.one'
          : 's4.dynamic.discharge_hub.source_count.other',
      {'count': count},
    );
  }

  String _safetyFlagCountLabel(AppStrings s, int count) {
    return s.format(
      count == 1
          ? 's4.dynamic.discharge_hub.safety_flag_count.one'
          : 's4.dynamic.discharge_hub.safety_flag_count.other',
      {'count': count},
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
