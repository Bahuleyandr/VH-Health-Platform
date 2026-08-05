import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';

import '../../../core/models/care_pathway_work_models.dart';
import '../../../core/providers/clinical_inbox_provider.dart';
import '../../../core/services/care_pathway_api_service.dart';
import '../../../core/services/clinical_inbox_api_service.dart';
import '../../../core/widgets/online_only_action_state.dart';
import '../../../core/widgets/post_discharge_cross_sign_sheet.dart';
import '../../../l10n/app_strings.dart';

class ClinicalInboxScreen extends StatefulWidget {
  const ClinicalInboxScreen({super.key});

  @override
  State<ClinicalInboxScreen> createState() => _ClinicalInboxScreenState();
}

class _ClinicalInboxScreenState extends State<ClinicalInboxScreen> {
  Timer? _minuteTimer;
  final Set<String> _acceptingTransfers = {};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(context.read<ClinicalInboxProvider>().refresh());
    });
    _minuteTimer = Timer.periodic(const Duration(minutes: 1), (_) {
      if (!mounted) return;
      setState(() {});
      unawaited(context.read<ClinicalInboxProvider>().refresh());
    });
  }

  @override
  void dispose() {
    _minuteTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final provider = context.watch<ClinicalInboxProvider>();
    final isOnline = ConnectivitySyncService.instance.isOnline;
    final now = DateTime.now();
    final groups = _groupTasks(provider.tasks, now);

    return Scaffold(
      appBar: AppBar(
        title: Text(strings.clinicalInboxTitle),
        actions: [
          IconButton(
            tooltip: strings.actionRefresh,
            icon: provider.isRefreshing
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.refresh),
            onPressed: provider.isRefreshing
                ? null
                : () => unawaited(provider.refresh()),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: provider.refresh,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
          children: [
            if (provider.lastError != null && provider.tasks.isNotEmpty)
              _ErrorBanner(
                message: provider.lastError!,
                onRetry: () => unawaited(provider.refresh()),
              ),
            if (provider.tasks.isEmpty && provider.isRefreshing)
              const Padding(
                padding: EdgeInsets.only(top: 96),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (provider.tasks.isEmpty && provider.lastError != null)
              _ErrorBanner(
                message: provider.lastError!,
                onRetry: () => unawaited(provider.refresh()),
              )
            else if (provider.tasks.isEmpty)
              _EmptyState(message: strings.clinicalInboxEmpty)
            else
              for (final entry in groups.entries) ...[
                _GroupHeader(label: _groupLabel(strings, entry.key)),
                const SizedBox(height: 8),
                for (final task in entry.value)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: _ClinicalInboxTaskCard(
                      task: task,
                      now: now,
                      acceptingTransfer: _acceptingTransfers.contains(task.id),
                      isOnline: isOnline,
                      onOpen: () => _showTaskDetail(context, task),
                      onAcknowledge: () => _acknowledge(context, task),
                      onReview: () => _beginDiagnosticReview(context, task),
                      onAcceptTransfer: () =>
                          _acceptInpatientTransfer(context, task),
                    ),
                  ),
              ],
          ],
        ),
      ),
    );
  }

  Future<void> _acknowledge(
    BuildContext context,
    ClinicalInboxTask task,
  ) async {
    final strings = AppStrings.of(context);
    if (!OnlineOnlyActionGuard.require(context)) return;
    try {
      await context.read<ClinicalInboxProvider>().acknowledge(task.id);
    } catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(strings.clinicalInboxAckFailed('$e'))),
      );
    }
  }

  Future<void> _beginDiagnosticReview(
    BuildContext context,
    ClinicalInboxTask task,
  ) async {
    if (!OnlineOnlyActionGuard.require(context)) return;
    if (task.isPostDischargePendingResultReview) {
      await _beginPostDischargeCrossSign(context, task);
      return;
    }
    final strings = AppStrings.of(context);
    try {
      var currentTask = task;
      if (task.isRoleOwned) {
        currentTask = await context
            .read<ClinicalInboxProvider>()
            .claimForReview(task.id);
      }
      if (!context.mounted) return;
      await showModalBottomSheet<void>(
        context: context,
        showDragHandle: true,
        isScrollControlled: true,
        builder: (_) => _DiagnosticActionSheet(task: currentTask),
      );
    } catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(strings.clinicalInboxActionFailed('$e'))),
      );
    }
  }

  Future<void> _beginPostDischargeCrossSign(
    BuildContext context,
    ClinicalInboxTask task,
  ) async {
    final strings = AppStrings.of(context);
    if (!OnlineOnlyActionGuard.require(
      context,
      message: strings.lookup('clinical_inbox.cross_sign.requires_connection'),
    )) {
      return;
    }
    try {
      final review = await _refreshPostDischargeCrossSignReview(
        context,
        task.pendingResultHandoffId,
      );
      if (!context.mounted) return;
      if (review == null || !review.canCrossSign) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              strings.lookup('clinical_inbox.cross_sign.no_longer_actionable'),
            ),
          ),
        );
        return;
      }
      await showPostDischargeCrossSignSheet(
        context,
        review: review,
        refreshReview: () => _refreshPostDischargeCrossSignReview(
          context,
          review.command.handoffId,
        ),
      );
    } catch (error) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            strings.format('clinical_inbox.cross_sign.failed', {
              'reason': error.toString(),
            }),
          ),
        ),
      );
    }
  }

  Future<PostDischargeCrossSignReview?> _refreshPostDischargeCrossSignReview(
    BuildContext context,
    String handoffId,
  ) async {
    final provider = context.read<ClinicalInboxProvider>();
    await provider.refresh();
    final matches = provider.tasks.where(
      (candidate) =>
          candidate.isPostDischargePendingResultReview &&
          candidate.pendingResultHandoffId == handoffId,
    );
    if (matches.isEmpty) return null;
    final task = matches.first;
    return _postDischargeReviewForTask(task);
  }

  PostDischargeCrossSignReview _postDischargeReviewForTask(
    ClinicalInboxTask task,
  ) {
    return PostDischargeCrossSignReview(
      command: PostDischargeCrossSignCommand(
        admissionId: task.pendingResultAdmissionId!,
        handoffId: task.pendingResultHandoffId,
        generationId: task.diagnosticGenerationId,
        diagnosticActionId: task.diagnosticAuthoritativeActionId,
        generationSnapshotSha256: task.diagnosticGenerationSnapshotSha256,
        actionTaskId: task.id,
      ),
      patientSafeLabel: task.title,
      diagnosticClassification: task.diagnosticClassification,
      diagnosticActionKind: task.diagnosticAuthoritativeActionKind,
      diagnosticDisposition: task.diagnosticAuthoritativeDisposition,
      diagnosticActionOccurredAt: task.diagnosticAuthoritativeActionOccurredAt,
      canCrossSign: task.needsPostDischargeCrossSign,
    );
  }

  Future<void> _acceptInpatientTransfer(
    BuildContext context,
    ClinicalInboxTask task,
  ) async {
    final strings = AppStrings.of(context);
    if (!OnlineOnlyActionGuard.require(
      context,
      message: strings.lookup(
        'clinical_inbox.transfer_accept_requires_connection',
      ),
    )) {
      return;
    }
    final appointmentId = task.sourceAppointmentId;
    if (appointmentId == null ||
        !task.isOpInpatientTransferReview ||
        _acceptingTransfers.contains(task.id)) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            strings.lookup('clinical_inbox.transfer_binding_unavailable'),
          ),
        ),
      );
      return;
    }
    setState(() => _acceptingTransfers.add(task.id));
    try {
      final receipt = await CarePathwayApiService.acceptInpatientTransfer(
        appointmentId: appointmentId,
        handoffId: task.relatedResourceId,
      );
      if (!context.mounted) return;
      await context.read<ClinicalInboxProvider>().refresh();
      if (!context.mounted) return;
      setState(() => _acceptingTransfers.remove(task.id));
      await _showAcceptedAdmissionSource(context, receipt.admissionSource);
    } catch (error) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(error.toString())));
    } finally {
      if (mounted && _acceptingTransfers.contains(task.id)) {
        setState(() => _acceptingTransfers.remove(task.id));
      }
    }
  }

  Future<void> _showAcceptedAdmissionSource(
    BuildContext context,
    OpAdmissionSourceTuple source,
  ) {
    final strings = AppStrings.of(context);
    return showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(strings.lookup('clinical_inbox.transfer_accepted_title')),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              strings.lookup(
                'clinical_inbox.transfer_admission_source_explanation',
              ),
            ),
            const SizedBox(height: 14),
            _DetailLine(
              label: strings.lookup(
                'clinical_inbox.transfer_source_appointment',
              ),
              value: source.appointmentId.toString(),
            ),
            _DetailLine(
              label: strings.lookup('clinical_inbox.transfer_source_pathway'),
              value: source.sourcePathwayInstanceId,
            ),
            _DetailLine(
              label: strings.lookup('clinical_inbox.transfer_source_handoff'),
              value: source.sourceHandoffId,
            ),
            _DetailLine(
              label: strings.lookup(
                'clinical_inbox.transfer_accepted_recipient',
              ),
              value: source.acceptedRecipientUid ?? '-',
            ),
          ],
        ),
        actions: [
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: Text(strings.actionClose),
          ),
        ],
      ),
    );
  }

  void _showTaskDetail(BuildContext context, ClinicalInboxTask task) {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetContext) => _ClinicalInboxTaskDetail(
        task: task,
        acceptingTransfer: _acceptingTransfers.contains(task.id),
        isOnline: ConnectivitySyncService.instance.isOnline,
        onAcknowledge: () => _acknowledge(context, task),
        onReview: () {
          Navigator.pop(sheetContext);
          unawaited(_beginDiagnosticReview(context, task));
        },
        onAcceptTransfer: () {
          Navigator.pop(sheetContext);
          unawaited(_acceptInpatientTransfer(context, task));
        },
      ),
    );
  }
}

class _ClinicalInboxTaskCard extends StatelessWidget {
  final ClinicalInboxTask task;
  final DateTime now;
  final VoidCallback onOpen;
  final VoidCallback onAcknowledge;
  final VoidCallback onReview;
  final VoidCallback onAcceptTransfer;
  final bool acceptingTransfer;
  final bool isOnline;

  const _ClinicalInboxTaskCard({
    required this.task,
    required this.now,
    required this.onOpen,
    required this.onAcknowledge,
    required this.onReview,
    required this.onAcceptTransfer,
    required this.acceptingTransfer,
    required this.isOnline,
  });

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final provider = context.watch<ClinicalInboxProvider>();
    final busy = provider.isMutating(task.id);
    final canAck = task.needsAcknowledgement && !busy && isOnline;
    final canReview = task.needsDoctorAction && !busy && isOnline;
    final canCrossSign = task.needsPostDischargeCrossSign && !busy && isOnline;
    final canAcceptTransfer =
        task.isOpInpatientTransferReview &&
        task.sourceAppointmentId != null &&
        !acceptingTransfer &&
        isOnline;
    final color = _priorityColor(context, task, now);

    return Card(
      margin: EdgeInsets.zero,
      child: InkWell(
        onTap: onOpen,
        borderRadius: BorderRadius.circular(8),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.assignment_late_outlined, color: color),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          task.title,
                          style: Theme.of(context).textTheme.titleMedium
                              ?.copyWith(fontWeight: FontWeight.w700),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          '${strings.clinicalInboxPatient}: ${task.patientLabel.isEmpty ? strings.clinicalInboxUnknownPatient : task.patientLabel}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        Text(
                          '${strings.clinicalInboxSource}: ${task.sourceLabel}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        if (task.isRecoveredCriticalAwareness) ...[
                          const SizedBox(height: 8),
                          Container(
                            width: double.infinity,
                            padding: const EdgeInsets.all(10),
                            decoration: BoxDecoration(
                              color: Theme.of(
                                context,
                              ).colorScheme.errorContainer,
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  strings
                                      .clinicalInboxRecoveredCriticalRequired,
                                  style: const TextStyle(
                                    fontWeight: FontWeight.w700,
                                  ),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  strings
                                      .clinicalInboxRecoveredCriticalBoundary,
                                ),
                              ],
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  _SlaBadge(task: task, now: now),
                ],
              ),
              if (task.description.isNotEmpty) ...[
                const SizedBox(height: 10),
                Text(
                  task.description,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
              const SizedBox(height: 12),
              if (!isOnline &&
                  (task.needsAcknowledgement ||
                      task.needsDoctorAction ||
                      task.needsPostDischargeCrossSign ||
                      task.isOpInpatientTransferReview))
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Text(
                    strings.onlineOnlyActionMessage,
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              Align(
                alignment: Alignment.centerRight,
                child: FilledButton(
                  onPressed: canAcceptTransfer
                      ? onAcceptTransfer
                      : canCrossSign
                      ? onReview
                      : canReview
                      ? onReview
                      : canAck
                      ? onAcknowledge
                      : null,
                  child: busy
                      ? Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                            const SizedBox(width: 8),
                            Text(
                              task.needsDoctorAction ||
                                      task.needsPostDischargeCrossSign
                                  ? strings.clinicalInboxClaiming
                                  : strings.clinicalInboxAcknowledging,
                            ),
                          ],
                        )
                      : acceptingTransfer
                      ? Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                            const SizedBox(width: 8),
                            Text(
                              strings.lookup(
                                'clinical_inbox.accepting_transfer',
                              ),
                            ),
                          ],
                        )
                      : Text(
                          task.isOpInpatientTransferReview
                              ? strings.lookup(
                                  'clinical_inbox.accept_inpatient_transfer',
                                )
                              : task.isPostDischargePendingResultReview
                              ? strings.lookup(
                                  task.needsPostDischargeCrossSign
                                      ? 'clinical_inbox.cross_sign.review'
                                      : 'clinical_inbox.cross_sign.read_only',
                                )
                              : task.needsDoctorAction
                              ? task.isRoleOwned
                                    ? strings.clinicalInboxClaimReview
                                    : strings.clinicalInboxReviewAction
                              : task.needsAcknowledgement
                              ? task.isRecoveredCriticalAwareness
                                    ? strings
                                          .clinicalInboxAcknowledgeRecoveredCritical
                                    : strings.clinicalInboxAcknowledgeCritical
                              : strings.clinicalInboxAcknowledged,
                        ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ClinicalInboxTaskDetail extends StatelessWidget {
  final ClinicalInboxTask task;
  final VoidCallback onAcknowledge;
  final VoidCallback onReview;
  final VoidCallback onAcceptTransfer;
  final bool acceptingTransfer;
  final bool isOnline;

  const _ClinicalInboxTaskDetail({
    required this.task,
    required this.onAcknowledge,
    required this.onReview,
    required this.onAcceptTransfer,
    required this.acceptingTransfer,
    required this.isOnline,
  });

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final provider = context.watch<ClinicalInboxProvider>();
    final currentTask = provider.tasks.firstWhere(
      (candidate) => candidate.id == task.id,
      orElse: () => task,
    );
    final busy = provider.isMutating(currentTask.id);
    final escalations = currentTask.escalations;

    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          left: 20,
          right: 20,
          bottom: MediaQuery.viewInsetsOf(context).bottom + 20,
        ),
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                strings.clinicalInboxTaskDetail,
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 12),
              Text(
                currentTask.title,
                style: Theme.of(context).textTheme.titleMedium,
              ),
              if (currentTask.description.isNotEmpty) ...[
                const SizedBox(height: 8),
                Text(currentTask.description),
              ],
              const SizedBox(height: 16),
              _DetailLine(
                label: strings.clinicalInboxPatient,
                value: currentTask.patientLabel.isEmpty
                    ? strings.clinicalInboxUnknownPatient
                    : currentTask.patientLabel,
              ),
              _DetailLine(
                label: strings.clinicalInboxSourceEvent,
                value: currentTask.sourceLabel,
              ),
              _DetailLine(
                label: strings.clinicalInboxPriority,
                value: currentTask.priority.toUpperCase(),
              ),
              _DetailLine(
                label: strings.clinicalInboxStatus,
                value: currentTask.status.replaceAll('_', ' '),
              ),
              if (currentTask.diagnosticClassification.isNotEmpty)
                _DetailLine(
                  label: strings.clinicalInboxClassification,
                  value: currentTask.diagnosticClassification.toUpperCase(),
                ),
              if (currentTask.diagnosticIsCorrection)
                _DetailLine(
                  label: strings.clinicalInboxCorrection,
                  value:
                      'v${currentTask.diagnosticSourceVersion ?? '-'} • ${currentTask.diagnosticPredecessorGenerationId}',
                ),
              if (currentTask.pathwayOwnerUid.isNotEmpty)
                _DetailLine(
                  label: strings.clinicalInboxCurrentOwner,
                  value: currentTask.pathwayOwnerUid,
                )
              else if (currentTask.assignedToRole.isNotEmpty)
                _DetailLine(
                  label: strings.clinicalInboxRoleQueue,
                  value: currentTask.assignedToRole,
                ),
              if (currentTask.isOpInpatientTransferReview) ...[
                _DetailLine(
                  label: strings.lookup(
                    'clinical_inbox.transfer_source_appointment',
                  ),
                  value: currentTask.sourceAppointmentId?.toString() ?? '-',
                ),
                _DetailLine(
                  label: strings.lookup(
                    'clinical_inbox.transfer_source_handoff',
                  ),
                  value: currentTask.relatedResourceId,
                ),
              ],
              if (currentTask.isPostDischargePendingResultReview) ...[
                _DetailLine(
                  label: strings.lookup(
                    'clinical_inbox.cross_sign.generation_id',
                  ),
                  value: currentTask.diagnosticGenerationId,
                ),
                _DetailLine(
                  label: strings.lookup(
                    'clinical_inbox.cross_sign.generation_hash',
                  ),
                  value: currentTask.diagnosticGenerationSnapshotSha256,
                ),
                _DetailLine(
                  label: strings.lookup(
                    'clinical_inbox.cross_sign.authoritative_action',
                  ),
                  value: currentTask.diagnosticAuthoritativeActionId,
                ),
                _DetailLine(
                  label: strings.lookup(
                    'clinical_inbox.cross_sign.prior_disposition',
                  ),
                  value: currentTask.diagnosticAuthoritativeDisposition,
                ),
              ],
              if (currentTask.dueAt != null)
                _DetailLine(
                  label: strings.clinicalInboxDue,
                  value: _formatDateTime(currentTask.dueAt!),
                ),
              if (currentTask.isRecoveredCriticalAwareness) ...[
                const SizedBox(height: 8),
                Text(
                  strings.clinicalInboxRecoveredCriticalRequired,
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.error,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 4),
                Text(strings.clinicalInboxRecoveredCriticalBoundary),
                if (currentTask.externalRecoverySourceOccurredAt != null)
                  _DetailLine(
                    label: strings.clinicalInboxSourceEvent,
                    value: _formatDateTime(
                      currentTask.externalRecoverySourceOccurredAt!,
                    ),
                  ),
              ],
              const SizedBox(height: 16),
              Text(
                strings.clinicalInboxTierHistory,
                style: Theme.of(context).textTheme.titleSmall,
              ),
              const SizedBox(height: 8),
              if (escalations.isEmpty)
                Text(strings.clinicalInboxNoTierHistory)
              else
                for (final escalation in escalations)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.escalator_warning_outlined),
                    title: Text(
                      strings.clinicalInboxTierLine(
                        escalation.tier,
                        escalation.action,
                      ),
                    ),
                    subtitle: escalation.at == null
                        ? null
                        : Text(_formatDateTime(escalation.at!)),
                  ),
              const SizedBox(height: 12),
              if (!isOnline) ...[
                Text(
                  strings.lookup('online_only.message'),
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
                const SizedBox(height: 12),
              ],
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed:
                      currentTask.isOpInpatientTransferReview &&
                          currentTask.sourceAppointmentId != null &&
                          !acceptingTransfer &&
                          isOnline
                      ? onAcceptTransfer
                      : currentTask.needsPostDischargeCrossSign &&
                            !busy &&
                            isOnline
                      ? onReview
                      : currentTask.needsDoctorAction && !busy && isOnline
                      ? onReview
                      : currentTask.needsAcknowledgement && !busy && isOnline
                      ? onAcknowledge
                      : null,
                  child: busy || acceptingTransfer
                      ? Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                            const SizedBox(width: 8),
                            Text(
                              acceptingTransfer
                                  ? strings.lookup(
                                      'clinical_inbox.accepting_transfer',
                                    )
                                  : currentTask.needsDoctorAction ||
                                        currentTask.needsPostDischargeCrossSign
                                  ? strings.clinicalInboxClaiming
                                  : strings.clinicalInboxAcknowledging,
                            ),
                          ],
                        )
                      : Text(
                          currentTask.isOpInpatientTransferReview
                              ? strings.lookup(
                                  'clinical_inbox.accept_inpatient_transfer',
                                )
                              : currentTask.isPostDischargePendingResultReview
                              ? strings.lookup(
                                  currentTask.needsPostDischargeCrossSign
                                      ? 'clinical_inbox.cross_sign.review'
                                      : 'clinical_inbox.cross_sign.read_only',
                                )
                              : currentTask.needsDoctorAction
                              ? currentTask.isRoleOwned
                                    ? strings.clinicalInboxClaimReview
                                    : strings.clinicalInboxReviewAction
                              : currentTask.needsAcknowledgement
                              ? currentTask.isRecoveredCriticalAwareness
                                    ? strings
                                          .clinicalInboxAcknowledgeRecoveredCritical
                                    : strings.clinicalInboxAcknowledgeCritical
                              : strings.clinicalInboxAcknowledged,
                        ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _DiagnosticActionSheet extends StatefulWidget {
  final ClinicalInboxTask task;

  const _DiagnosticActionSheet({required this.task});

  @override
  State<_DiagnosticActionSheet> createState() => _DiagnosticActionSheetState();
}

class _DiagnosticActionSheetState extends State<_DiagnosticActionSheet> {
  final _formKey = GlobalKey<FormState>();
  final _noteController = TextEditingController();
  final _reasonController = TextEditingController();
  final _evidenceTypeController = TextEditingController();
  final _evidenceIdController = TextEditingController();
  String? _disposition;
  bool _attested = false;
  bool _submitting = false;

  @override
  void dispose() {
    _noteController.dispose();
    _reasonController.dispose();
    _evidenceTypeController.dispose();
    _evidenceIdController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final strings = AppStrings.of(context);
    if (!OnlineOnlyActionGuard.require(context)) return;
    if (!(_formKey.currentState?.validate() ?? false) || !_attested) {
      setState(() {});
      return;
    }
    setState(() => _submitting = true);
    try {
      await context.read<ClinicalInboxProvider>().recordDiagnosticAction(
        DiagnosticActionCommand(
          generationId: widget.task.diagnosticGenerationId,
          taskId: widget.task.id,
          disposition: _disposition!,
          clinicalNote: _noteController.text,
          generationSnapshotSha256:
              widget.task.diagnosticGenerationSnapshotSha256,
          reason: _disposition == 'no_action' ? _reasonController.text : null,
          downstreamResourceType: _disposition == 'no_action'
              ? null
              : _evidenceTypeController.text,
          downstreamResourceId: _disposition == 'no_action'
              ? null
              : _evidenceIdController.text,
        ),
      );
      if (!mounted) return;
      Navigator.pop(context);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(strings.clinicalInboxActionRecorded)),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _submitting = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(strings.clinicalInboxActionFailed('$e'))),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final requiresEvidence =
        _disposition != null && _disposition != 'no_action';
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          left: 20,
          right: 20,
          bottom: MediaQuery.viewInsetsOf(context).bottom + 20,
        ),
        child: SingleChildScrollView(
          child: Form(
            key: _formKey,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  strings.clinicalInboxActionTitle,
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 8),
                Text(widget.task.title),
                const SizedBox(height: 4),
                Text(
                  widget.task.diagnosticClassification.toUpperCase(),
                  style: Theme.of(context).textTheme.labelLarge?.copyWith(
                    color: _priorityColor(context, widget.task, DateTime.now()),
                  ),
                ),
                const SizedBox(height: 16),
                DropdownButtonFormField<String>(
                  initialValue: _disposition,
                  decoration: InputDecoration(
                    labelText: strings.clinicalInboxActionDisposition,
                    border: const OutlineInputBorder(),
                  ),
                  items: [
                    DropdownMenuItem(
                      value: 'treated',
                      child: Text(strings.clinicalInboxActionTreated),
                    ),
                    DropdownMenuItem(
                      value: 'repeated',
                      child: Text(strings.clinicalInboxActionRepeated),
                    ),
                    DropdownMenuItem(
                      value: 'referred',
                      child: Text(strings.clinicalInboxActionReferred),
                    ),
                    DropdownMenuItem(
                      value: 'no_action',
                      child: Text(strings.clinicalInboxActionNoAction),
                    ),
                  ],
                  validator: (value) =>
                      value == null ? strings.clinicalInboxFieldRequired : null,
                  onChanged: _submitting
                      ? null
                      : (value) => setState(() => _disposition = value),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _noteController,
                  enabled: !_submitting,
                  minLines: 3,
                  maxLines: 8,
                  maxLength: 8000,
                  decoration: InputDecoration(
                    labelText: strings.clinicalInboxActionNote,
                    alignLabelWithHint: true,
                    border: const OutlineInputBorder(),
                  ),
                  validator: (value) => value?.trim().isEmpty ?? true
                      ? strings.clinicalInboxFieldRequired
                      : null,
                ),
                if (_disposition == 'no_action') ...[
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: _reasonController,
                    enabled: !_submitting,
                    minLines: 2,
                    maxLines: 5,
                    maxLength: 4000,
                    decoration: InputDecoration(
                      labelText: strings.clinicalInboxActionReason,
                      alignLabelWithHint: true,
                      border: const OutlineInputBorder(),
                    ),
                    validator: (value) => value?.trim().isEmpty ?? true
                        ? strings.clinicalInboxFieldRequired
                        : null,
                  ),
                ],
                if (requiresEvidence) ...[
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: _evidenceTypeController,
                    enabled: !_submitting,
                    maxLength: 80,
                    decoration: InputDecoration(
                      labelText: strings.clinicalInboxActionEvidenceType,
                      border: const OutlineInputBorder(),
                    ),
                    validator: (value) => value?.trim().isEmpty ?? true
                        ? strings.clinicalInboxFieldRequired
                        : null,
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: _evidenceIdController,
                    enabled: !_submitting,
                    maxLength: 160,
                    decoration: InputDecoration(
                      labelText: strings.clinicalInboxActionEvidenceId,
                      border: const OutlineInputBorder(),
                    ),
                    validator: (value) => value?.trim().isEmpty ?? true
                        ? strings.clinicalInboxFieldRequired
                        : null,
                  ),
                ],
                const SizedBox(height: 4),
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  controlAffinity: ListTileControlAffinity.leading,
                  value: _attested,
                  onChanged: _submitting
                      ? null
                      : (value) => setState(() => _attested = value == true),
                  title: Text(strings.clinicalInboxActionAttestation),
                  subtitle: !_attested
                      ? Text(
                          strings.clinicalInboxFieldRequired,
                          style: TextStyle(
                            color: Theme.of(context).colorScheme.error,
                          ),
                        )
                      : null,
                ),
                const SizedBox(height: 12),
                SizedBox(
                  width: double.infinity,
                  child: OnlineOnlyActionState(
                    builder: (context, isOnline, offlineMessage) =>
                        FilledButton.icon(
                          onPressed: _submitting || !isOnline ? null : _submit,
                          icon: _submitting
                              ? const SizedBox(
                                  width: 18,
                                  height: 18,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                )
                              : const Icon(Icons.verified_user_outlined),
                          label: Text(
                            _submitting
                                ? strings.clinicalInboxActionRecording
                                : strings.clinicalInboxActionSubmit,
                          ),
                        ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _DetailLine extends StatelessWidget {
  final String label;
  final String value;

  const _DetailLine({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 120,
            child: Text(
              label,
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
          ),
          Expanded(child: Text(value)),
        ],
      ),
    );
  }
}

class _SlaBadge extends StatelessWidget {
  final ClinicalInboxTask task;
  final DateTime now;

  const _SlaBadge({required this.task, required this.now});

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final overdue = task.isOverdue(now);
    final due = task.dueAt;
    final label = overdue
        ? strings.clinicalInboxSlaOverdue
        : due == null
        ? strings.clinicalInboxSlaNoDue
        : _countdownLabel(strings, due.difference(now));
    final color = overdue
        ? Colors.red.shade700
        : task.priority == 'critical'
        ? Colors.deepOrange.shade700
        : Theme.of(context).colorScheme.primary;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        border: Border.all(color: color.withValues(alpha: 0.45)),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
          color: color,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

class _GroupHeader extends StatelessWidget {
  final String label;

  const _GroupHeader({required this.label});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Text(
        label,
        style: Theme.of(context).textTheme.titleSmall?.copyWith(
          fontWeight: FontWeight.w800,
          letterSpacing: 0,
        ),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  final String message;

  const _EmptyState({required this.message});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 96),
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.assignment_turned_in_outlined,
              size: 48,
              color: Theme.of(context).colorScheme.primary,
            ),
            const SizedBox(height: 12),
            Text(message, style: Theme.of(context).textTheme.titleMedium),
          ],
        ),
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;

  const _ErrorBanner({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    return Card(
      color: Theme.of(context).colorScheme.errorContainer,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          children: [
            Expanded(child: Text(message)),
            TextButton(onPressed: onRetry, child: Text(strings.actionRetry)),
          ],
        ),
      ),
    );
  }
}

Map<_ClinicalInboxGroup, List<ClinicalInboxTask>> _groupTasks(
  List<ClinicalInboxTask> tasks,
  DateTime now,
) {
  final grouped = <_ClinicalInboxGroup, List<ClinicalInboxTask>>{};
  for (final task in tasks) {
    final group = task.isOverdue(now)
        ? _ClinicalInboxGroup.overdue
        : task.status == 'in_progress' && !task.needsDoctorAction
        ? _ClinicalInboxGroup.acknowledged
        : task.status == 'in_progress'
        ? _ClinicalInboxGroup.inProgress
        : switch (task.priority) {
            'critical' => _ClinicalInboxGroup.critical,
            'high' => _ClinicalInboxGroup.high,
            _ => _ClinicalInboxGroup.normal,
          };
    grouped.putIfAbsent(group, () => []).add(task);
  }
  return grouped;
}

String _groupLabel(AppStrings strings, _ClinicalInboxGroup group) {
  return switch (group) {
    _ClinicalInboxGroup.overdue => strings.clinicalInboxGroupOverdue,
    _ClinicalInboxGroup.critical => strings.clinicalInboxGroupCritical,
    _ClinicalInboxGroup.high => strings.clinicalInboxGroupHigh,
    _ClinicalInboxGroup.normal => strings.clinicalInboxGroupNormal,
    _ClinicalInboxGroup.acknowledged => strings.clinicalInboxGroupAcknowledged,
    _ClinicalInboxGroup.inProgress => strings.clinicalInboxGroupInProgress,
  };
}

Color _priorityColor(
  BuildContext context,
  ClinicalInboxTask task,
  DateTime now,
) {
  if (task.isOverdue(now)) return Colors.red.shade700;
  return switch (task.priority) {
    'critical' => Colors.deepOrange.shade700,
    'high' => Colors.orange.shade800,
    _ => Theme.of(context).colorScheme.primary,
  };
}

String _countdownLabel(AppStrings strings, Duration remaining) {
  if (remaining.inMinutes <= 0) return strings.clinicalInboxSlaDueNow;
  if (remaining.inMinutes < 60) {
    return strings.clinicalInboxSlaDueMinutes(remaining.inMinutes);
  }
  final hours = remaining.inHours;
  final minutes = remaining.inMinutes.remainder(60);
  return strings.clinicalInboxSlaDueHours(hours, minutes);
}

String _formatDateTime(DateTime value) {
  final local = value.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${local.year}-${two(local.month)}-${two(local.day)} '
      '${two(local.hour)}:${two(local.minute)}';
}

enum _ClinicalInboxGroup {
  overdue,
  critical,
  high,
  normal,
  inProgress,
  acknowledged,
}
