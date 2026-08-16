import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../models/client_readiness.dart';
import '../models/offline_command_envelope.dart';
import '../models/offline_write_entry.dart';
import '../services/connectivity_sync_service.dart';
import '../services/offline_action_ids.dart';
import '../services/offline_write_containment.dart';

typedef OfflineSyncTextResolver = String Function(
  String key,
  Map<String, Object?> values,
);
typedef OfflineSyncActorUidResolver = Future<String?> Function();

String _defaultOfflineSyncText(String key, Map<String, Object?> values) {
  const strings = <String, String>{
    'offline_sync.title': 'Sync status',
    'offline_sync.transport.unknown': 'Transport — unknown',
    'offline_sync.transport.available': 'Transport — available',
    'offline_sync.transport.unavailable': 'Transport — unavailable',
    'offline_sync.continuity.signed_out': 'Continuity — signed out',
    'offline_sync.continuity.checking': 'Continuity — checking',
    'offline_sync.continuity.not_ready': 'Continuity — not ready',
    'offline_sync.continuity.clock_uncertain':
        'Continuity — device clock uncertain',
    'offline_sync.continuity.policy_incompatible':
        'Continuity — policy incompatible',
    'offline_sync.continuity.ready_public':
        'Continuity — ready via public route',
    'offline_sync.continuity.ready_internal':
        'Continuity — ready via internal route',
    'offline_sync.continuity.rate_limited': 'Continuity — rate limited',
    'offline_sync.continuity.syncing': 'Continuity — syncing',
    'offline_sync.continuity.review_required': 'Continuity — review required',
    'offline_sync.pending_count': '{count} pending',
    'offline_sync.review_count': '{count} need review',
    'offline_sync.conflict_count': '{count} conflict(s)',
    'offline_sync.offline_queued': 'Offline · {count} queued',
    'offline_sync.syncing': 'Syncing {count}…',
    'offline_sync.sync_in_progress': 'Sync in progress…',
    'offline_sync.sync_now': 'Sync now',
    'offline_sync.empty':
        'No unresolved offline work for the current staff member.',
    'offline_sync.section.unresolved': 'Offline work',
    'offline_sync.field.family': 'Family',
    'offline_sync.field.context': 'Context',
    'offline_sync.field.captured': 'Captured',
    'offline_sync.field.status': 'Status',
    'offline_sync.field.reason': 'Reason',
    'offline_sync.field.blocker': 'Blocker',
    'offline_sync.field.retry_count': 'Retry count',
    'offline_sync.field.capture_owner': 'Capture owner',
    'offline_sync.field.reconciliation_owner': 'Reconciliation owner',
    'offline_sync.field.paper_form_set': 'Paper form set',
    'offline_sync.field.endpoint': 'Action',
    'offline_sync.field.attestation': 'Handoff',
    'offline_sync.state.pending': 'Pending',
    'offline_sync.state.in_flight': 'Sending',
    'offline_sync.state.retry_wait': 'Waiting to retry',
    'offline_sync.state.conflict': 'Conflict',
    'offline_sync.state.needs_review': 'Needs review',
    'offline_sync.state.skipped': 'Skipped this pass',
    'offline_sync.state.attested': 'Needs review · handoff attested',
    'offline_sync.action.retry': 'Retry',
    'offline_sync.action.discard': 'Discard',
    'offline_sync.action.reconcile': 'Reconcile',
    'offline_sync.action.attest': 'Record attested handoff',
    'offline_sync.action.cancel': 'Cancel',
    'offline_sync.reconcile.title': 'Reconcile offline item',
    'offline_sync.reconcile.reason': 'Resolution reason',
    'offline_sync.reconcile.explanation': 'Explanation',
    'offline_sync.reconcile.explanation_required':
        'An explanation is required for this reason.',
    'offline_sync.reconcile.confirmation':
        'I verified that this command was not recorded on the server.',
    'offline_sync.reconcile.submit': 'Record reconciliation',
    'offline_sync.reconcile.failed':
        'Reconciliation was not recorded. Refresh and verify the item.',
    'offline_sync.reconcile.reason.recorded_elsewhere_verified':
        'Recorded elsewhere and verified',
    'offline_sync.reconcile.reason.transferred_to_paper':
        'Transferred to paper',
    'offline_sync.reconcile.reason.manual_entry_verified':
        'Manual entry verified',
    'offline_sync.reconcile.reason.duplicate_confirmed': 'Duplicate confirmed',
    'offline_sync.reconcile.reason.wrong_patient_or_context':
        'Wrong patient or context',
    'offline_sync.reconcile.reason.policy_or_schema_conflict':
        'Policy or schema conflict',
    'offline_sync.reconcile.reason.draft_cancelled': 'Draft cancelled',
    'offline_sync.attestation.title': 'Record attested handoff?',
    'offline_sync.attestation.body': 'Confirm that this item was reviewed — transferred to paper / handed to the reconciliation owner. This attestation cannot be changed.',
    'offline_sync.attestation.confirm': 'Confirm handoff',
    'offline_sync.attestation.success': 'Attested handoff recorded.',
    'offline_sync.attestation.recorded': 'Attested by {actor} at {time}',
    'offline_sync.discard.title': 'Discard offline clinical item?',
    'offline_sync.discard.generic_title': 'Discard offline item?',
    'offline_sync.discard.generic_body':
        'This offline item is not reconciled with the server.',
    'offline_sync.discard.mar_title': 'Discard administration record?',
    'offline_sync.discard.mar_body': 'Administration not recorded on the server — review needed. The medication may have been given offline.',
    'offline_sync.discard.notes_title': 'Discard note data?',
    'offline_sync.discard.notes_body': 'Note data on this device is not reconciled with the server. Review before discarding.',
    'offline_sync.discard.vitals_title': 'Discard vitals?',
    'offline_sync.discard.vitals_body': 'Vitals not recorded on the server — review needed. Review the patient chart before discarding.',
    'offline_sync.discard.prescription_title': 'Discard prescription?',
    'offline_sync.discard.prescription_body':
        'This prescription was not recorded on the server.',
    'offline_sync.discard.order_title': 'Discard medication order?',
    'offline_sync.discard.order_body':
        'This medication order was not placed on the server.',
    'offline_sync.discard.specimen_title': 'Discard specimen collection?',
    'offline_sync.discard.specimen_body':
        'This specimen collection was not recorded on the server.',
    'offline_sync.discard.transfusion_title':
        'Discard transfusion verification?',
    'offline_sync.discard.transfusion_body':
        'This transfusion verification was not recorded on the server.',
    'offline_sync.discard.confirm': 'Discard after reconciliation',
    'offline_sync.role.clinical_safety_lead': 'Clinical safety lead',
    'offline_sync.blocker.none': 'None',
    'offline_sync.blocker.partition_waiting':
        'Waiting behind another item in this action partition',
    'offline_sync.blocker.earlier_item': 'Earlier offline item #{id}',
    'offline_sync.family.prescription_create': 'Prescription create',
    'offline_sync.family.drug_chart_order': 'Drug-chart order',
    'offline_sync.family.mar_administration': 'MAR administration',
    'offline_sync.family.specimen_collection': 'Specimen collection',
    'offline_sync.family.transfusion_verification': 'Transfusion verification',
    'offline_sync.family.authoritative_note': 'Authoritative note',
    'offline_sync.family.vitals': 'Vitals',
    'offline_sync.family.note_draft': 'Note draft',
    'offline_sync.family.unknown': 'Unknown action',
    'c0a.offline_fallback.paper_set.opd_prescription_pads':
        'OPD prescription pads',
    'c0a.offline_fallback.paper_set.inpatient_drug_charts':
        'inpatient drug charts',
    'c0a.offline_fallback.paper_set.mar_sheets': 'MAR sheets',
    'c0a.offline_fallback.paper_set.laboratory_requisition_forms':
        'laboratory requisition forms',
    'c0a.offline_fallback.paper_set.blood_bank_verification_slips':
        'blood-bank verification slips',
    'c0a.offline_fallback.paper_set.nursing_note_forms': 'nursing note forms',
    'offline_sync.reason.contained_prescription_create':
        'Prescription create requires reconciliation',
    'offline_sync.reason.contained_drug_chart_order':
        'Drug-chart order requires reconciliation',
    'offline_sync.reason.contained_mar_administration':
        'MAR administration requires reconciliation',
    'offline_sync.reason.contained_specimen_collection':
        'Specimen collection requires reconciliation',
    'offline_sync.reason.contained_transfusion_verification':
        'Transfusion verification requires reconciliation',
    'offline_sync.reason.contained_authoritative_note':
        'Authoritative note requires reconciliation',
    'offline_sync.reason.unknown_action': 'Unknown offline action',
    'offline_sync.reason.unknown_tenant': 'Unknown tenant',
    'offline_sync.reason.unknown_owner': 'Unknown capture owner',
    'offline_sync.reason.unknown_encryption_version':
        'Unknown encryption version',
    'offline_sync.reason.decrypt_failed':
        'Encrypted clinical data could not be opened',
    'offline_sync.reason.retry_exhausted': 'Automatic retry limit reached',
    'offline_sync.reason.legacy_client_row_requires_reconciliation':
        'Created by an older Staff app — not sent',
    'offline_sync.legacy.title': 'Older Staff app item',
    'offline_sync.legacy.message': 'Created by an older Staff app — not sent. Review against the server or paper record.',
  };

  var result = strings[key] ?? key;
  for (final value in values.entries) {
    result = result.replaceAll('{${value.key}}', '${value.value}');
  }
  return result;
}

String _resolveText(
  OfflineSyncTextResolver? resolver,
  String key, [
  Map<String, Object?> values = const {},
]) {
  return (resolver ?? _defaultOfflineSyncText)(key, values);
}

String _transportKey(ClientTransportState state) {
  return switch (state) {
    ClientTransportState.unknown => 'offline_sync.transport.unknown',
    ClientTransportState.available => 'offline_sync.transport.available',
    ClientTransportState.unavailable => 'offline_sync.transport.unavailable',
  };
}

String _continuityKey(ContinuityLifecycleState state) {
  return switch (state) {
    ContinuityLifecycleState.signedOut => 'offline_sync.continuity.signed_out',
    ContinuityLifecycleState.checking => 'offline_sync.continuity.checking',
    ContinuityLifecycleState.notReady => 'offline_sync.continuity.not_ready',
    ContinuityLifecycleState.clockUncertain =>
      'offline_sync.continuity.clock_uncertain',
    ContinuityLifecycleState.policyIncompatible =>
      'offline_sync.continuity.policy_incompatible',
    ContinuityLifecycleState.readyPublic =>
      'offline_sync.continuity.ready_public',
    ContinuityLifecycleState.readyInternal =>
      'offline_sync.continuity.ready_internal',
    ContinuityLifecycleState.rateLimited =>
      'offline_sync.continuity.rate_limited',
    ContinuityLifecycleState.syncing => 'offline_sync.continuity.syncing',
    ContinuityLifecycleState.reviewRequired =>
      'offline_sync.continuity.review_required',
  };
}

/// Opens the current-owner offline reconciliation sheet.
///
/// This public entry point lets logout UX route directly to the same review
/// surface as the app-bar badge.
Future<void> showSyncStatusSheet(
  BuildContext context, {
  OfflineSyncTextResolver? textResolver,
  OfflineSyncActorUidResolver? actorUidResolver,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (context) => SyncStatusSheet(
      textResolver: textResolver,
      actorUidResolver: actorUidResolver,
    ),
  );
}

/// Compact, non-colour-only status pill shown in the app bar.
class OfflineSyncBadge extends StatelessWidget {
  final OfflineSyncTextResolver? textResolver;
  final OfflineSyncActorUidResolver? actorUidResolver;

  const OfflineSyncBadge({super.key, this.textResolver, this.actorUidResolver});

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: ConnectivitySyncService.instance,
      builder: (context, _) {
        final service = ConnectivitySyncService.instance;
        final state = _resolveState(service);
        if (state == null) return const SizedBox.shrink();

        return Semantics(
          button: true,
          label: state.label,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
            child: InkWell(
              borderRadius: BorderRadius.circular(16),
              onTap: () => showSyncStatusSheet(
                context,
                textResolver: textResolver,
                actorUidResolver: actorUidResolver,
              ),
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 6,
                ),
                decoration: BoxDecoration(
                  color: state.color.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(
                    color: state.color.withValues(alpha: 0.45),
                  ),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    state.leading,
                    const SizedBox(width: 6),
                    Text(
                      state.label,
                      style: TextStyle(
                        color: state.color,
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  _BadgeState? _resolveState(ConnectivitySyncService service) {
    if (service.needsReviewCount > 0) {
      final label = _resolveText(textResolver, 'offline_sync.review_count', {
        'count': service.needsReviewCount,
      });
      return _BadgeState(
        label: label,
        color: Colors.deepOrange.shade800,
        leading: Icon(
          Icons.assignment_late_outlined,
          size: 14,
          color: Colors.deepOrange.shade800,
        ),
      );
    }
    if (service.conflictCount > 0) {
      final label = _resolveText(textResolver, 'offline_sync.conflict_count', {
        'count': service.conflictCount,
      });
      return _BadgeState(
        label: label,
        color: Colors.red.shade700,
        leading: Icon(
          Icons.error_outline,
          size: 14,
          color: Colors.red.shade700,
        ),
      );
    }
    if (service.isSyncing) {
      final label = service.pendingCount > 0
          ? _resolveText(textResolver, 'offline_sync.syncing', {
              'count': service.pendingCount,
            })
          : _resolveText(textResolver, 'offline_sync.sync_in_progress');
      return _BadgeState(
        label: label,
        color: Colors.blue.shade700,
        leading: SizedBox(
          width: 12,
          height: 12,
          child: CircularProgressIndicator(
            strokeWidth: 2,
            valueColor: AlwaysStoppedAnimation<Color>(Colors.blue.shade700),
          ),
        ),
      );
    }
    if (service.transportState != ClientTransportState.available) {
      final label = _resolveText(
        textResolver,
        _transportKey(service.transportState),
      );
      return _BadgeState(
        label: label,
        color: Colors.orange.shade800,
        leading: Icon(Icons.cloud_off, size: 14, color: Colors.orange.shade800),
      );
    }
    if (service.continuityLifecycleState !=
            ContinuityLifecycleState.readyPublic &&
        service.continuityLifecycleState !=
            ContinuityLifecycleState.readyInternal) {
      final checking =
          service.continuityLifecycleState == ContinuityLifecycleState.checking;
      final label = _resolveText(
        textResolver,
        _continuityKey(service.continuityLifecycleState),
      );
      final color = checking ? Colors.blue.shade700 : Colors.orange.shade800;
      return _BadgeState(
        label: label,
        color: color,
        leading: checking
            ? SizedBox(
                width: 12,
                height: 12,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  valueColor: AlwaysStoppedAnimation<Color>(color),
                ),
              )
            : Icon(Icons.sync_problem, size: 14, color: color),
      );
    }
    if (service.pendingCount > 0) {
      final label = _resolveText(textResolver, 'offline_sync.pending_count', {
        'count': service.pendingCount,
      });
      return _BadgeState(
        label: label,
        color: Colors.amber.shade800,
        leading: Icon(Icons.schedule, size: 14, color: Colors.amber.shade800),
      );
    }
    return null;
  }
}

class _BadgeState {
  final String label;
  final Color color;
  final Widget leading;

  const _BadgeState({
    required this.label,
    required this.color,
    required this.leading,
  });
}

/// Bottom sheet showing every unresolved row for the current capture owner.
class SyncStatusSheet extends StatefulWidget {
  final OfflineSyncTextResolver? textResolver;
  final OfflineSyncActorUidResolver? actorUidResolver;

  const SyncStatusSheet({super.key, this.textResolver, this.actorUidResolver});

  @override
  State<SyncStatusSheet> createState() => _SyncStatusSheetState();
}

class _SyncStatusSheetState extends State<SyncStatusSheet> {
  late Future<List<OfflineWriteEntry>> _entriesFuture;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  void _reload() {
    _entriesFuture = ConnectivitySyncService.instance
        .unresolvedEntriesForCurrentOwner();
  }

  void _refreshUi() {
    if (!mounted) return;
    setState(_reload);
  }

  Future<void> _retry(OfflineWriteEntry entry) async {
    await ConnectivitySyncService.instance.retryConflict(entry.id);
    _refreshUi();
  }

  Future<void> _reconcile(OfflineWriteEntry entry) async {
    final actorUid = await widget.actorUidResolver?.call();
    if (!mounted || actorUid == null || actorUid.trim().isEmpty) return;
    final request = await _showReconciliationDialog(
      context,
      entry,
      actorUid.trim(),
      widget.textResolver,
    );
    if (request == null) return;
    final reconciled = await ConnectivitySyncService.instance.reconcileCommand(
      entry.id,
      request,
    );
    if (!mounted) return;
    if (!reconciled) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            _resolveText(widget.textResolver, 'offline_sync.reconcile.failed'),
          ),
        ),
      );
    }
    _refreshUi();
  }

  Future<void> _attest(OfflineWriteEntry entry) async {
    final actorUid = await widget.actorUidResolver?.call();
    if (actorUid == null || actorUid.trim().isEmpty) return;
    final recorded = await ConnectivitySyncService.instance.attestHandoff(
      entry.id,
      actorUid: actorUid.trim(),
    );
    if (!mounted) return;
    if (recorded) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            _resolveText(
              widget.textResolver,
              'offline_sync.attestation.success',
            ),
          ),
        ),
      );
    }
    _refreshUi();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return DraggableScrollableSheet(
      initialChildSize: 0.72,
      minChildSize: 0.4,
      maxChildSize: 0.95,
      expand: false,
      builder: (_, scrollController) => ListenableBuilder(
        listenable: ConnectivitySyncService.instance,
        builder: (context, _) {
          final service = ConnectivitySyncService.instance;
          return ListView(
            controller: scrollController,
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
            children: [
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(
                    color: theme.colorScheme.outline.withValues(alpha: 0.3),
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Text(
                _resolveText(widget.textResolver, 'offline_sync.title'),
                style: theme.textTheme.titleLarge,
              ),
              const SizedBox(height: 12),
              _StatusRow(
                icon: service.transportState == ClientTransportState.available
                    ? Icons.network_check
                    : Icons.signal_wifi_connected_no_internet_4,
                color: service.transportState == ClientTransportState.available
                    ? Colors.green.shade700
                    : Colors.orange.shade800,
                label: _resolveText(
                  widget.textResolver,
                  _transportKey(service.transportState),
                ),
              ),
              const SizedBox(height: 6),
              _StatusRow(
                icon: switch (service.continuityLifecycleState) {
                  ContinuityLifecycleState.readyPublic ||
                  ContinuityLifecycleState.readyInternal =>
                    Icons.verified_outlined,
                  ContinuityLifecycleState.checking ||
                  ContinuityLifecycleState.syncing => Icons.sync,
                  ContinuityLifecycleState.reviewRequired =>
                    Icons.assignment_late_outlined,
                  _ => Icons.sync_problem,
                },
                color: switch (service.continuityLifecycleState) {
                  ContinuityLifecycleState.readyPublic ||
                  ContinuityLifecycleState.readyInternal =>
                    Colors.green.shade700,
                  ContinuityLifecycleState.checking ||
                  ContinuityLifecycleState.syncing => Colors.blue.shade700,
                  ContinuityLifecycleState.reviewRequired =>
                    Colors.deepOrange.shade800,
                  _ => Colors.orange.shade800,
                },
                label: _resolveText(
                  widget.textResolver,
                  _continuityKey(service.continuityLifecycleState),
                ),
              ),
              const SizedBox(height: 6),
              _StatusRow(
                icon: Icons.schedule,
                color: theme.colorScheme.onSurface,
                label: _resolveText(
                  widget.textResolver,
                  'offline_sync.pending_count',
                  {'count': service.pendingCount},
                ),
              ),
              if (service.needsReviewCount > 0) ...[
                const SizedBox(height: 6),
                _StatusRow(
                  icon: Icons.assignment_late_outlined,
                  color: Colors.deepOrange.shade800,
                  label: _resolveText(
                    widget.textResolver,
                    'offline_sync.review_count',
                    {'count': service.needsReviewCount},
                  ),
                ),
              ],
              if (service.isSyncing) ...[
                const SizedBox(height: 6),
                _StatusRow(
                  icon: Icons.sync,
                  color: Colors.blue.shade700,
                  label: _resolveText(
                    widget.textResolver,
                    'offline_sync.sync_in_progress',
                  ),
                ),
              ],
              const SizedBox(height: 20),
              Row(
                children: [
                  Expanded(
                    child: Text(
                      _resolveText(
                        widget.textResolver,
                        'offline_sync.section.unresolved',
                      ),
                      style: theme.textTheme.titleMedium,
                    ),
                  ),
                  TextButton.icon(
                    onPressed:
                        service.canAttemptSync && service.pendingCount > 0
                        ? () async {
                            await service.syncPending();
                            _refreshUi();
                          }
                        : null,
                    icon: const Icon(Icons.sync, size: 18),
                    label: Text(
                      _resolveText(
                        widget.textResolver,
                        'offline_sync.sync_now',
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              FutureBuilder<List<OfflineWriteEntry>>(
                future: _entriesFuture,
                builder: (context, snapshot) {
                  if (snapshot.connectionState != ConnectionState.done) {
                    return const Padding(
                      padding: EdgeInsets.all(24),
                      child: Center(
                        child: SizedBox(
                          width: 24,
                          height: 24,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      ),
                    );
                  }
                  final entries = snapshot.data ?? const <OfflineWriteEntry>[];
                  if (entries.isEmpty) {
                    return Padding(
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      child: Text(
                        _resolveText(widget.textResolver, 'offline_sync.empty'),
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: theme.colorScheme.onSurface.withValues(
                            alpha: 0.7,
                          ),
                        ),
                      ),
                    );
                  }
                  return Column(
                    children: [
                      for (final entry in entries)
                        OfflineWriteStatusRow(
                          entry: entry,
                          textResolver: widget.textResolver,
                          onRetry: entry.canRetry ? () => _retry(entry) : null,
                          onReconcile:
                              _canReconcile(entry) &&
                                  widget.actorUidResolver != null
                              ? () => _reconcile(entry)
                              : null,
                          onAttest:
                              entry.canAttestHandoff &&
                                  widget.actorUidResolver != null
                              ? () => _attest(entry)
                              : null,
                        ),
                    ],
                  );
                },
              ),
            ],
          );
        },
      ),
    );
  }
}

bool _canReconcile(OfflineWriteEntry entry) {
  if (entry.isSkipped) return false;
  if (!entry.envelopeReady) return entry.status == OfflineWriteStatus.conflict;
  return switch (entry.durableState) {
    OfflineCommandState.pending ||
    OfflineCommandState.retryWait ||
    OfflineCommandState.needsReview => true,
    _ => false,
  };
}

Future<OfflineReconciliationRequest?> _showReconciliationDialog(
  BuildContext context,
  OfflineWriteEntry entry,
  String actorUid,
  OfflineSyncTextResolver? textResolver,
) {
  return showDialog<OfflineReconciliationRequest>(
    context: context,
    barrierDismissible: false,
    builder: (dialogContext) => _ReconciliationDialog(
      entry: entry,
      actorUid: actorUid,
      textResolver: textResolver,
    ),
  );
}

class _ReconciliationDialog extends StatefulWidget {
  const _ReconciliationDialog({
    required this.entry,
    required this.actorUid,
    required this.textResolver,
  });

  final OfflineWriteEntry entry;
  final String actorUid;
  final OfflineSyncTextResolver? textResolver;

  @override
  State<_ReconciliationDialog> createState() => _ReconciliationDialogState();
}

class _ReconciliationDialogState extends State<_ReconciliationDialog> {
  late final TextEditingController _explanationController;
  late final List<OfflineReconciliationReason> _reasons;
  late OfflineReconciliationReason _reason;
  var _confirmed = false;

  @override
  void initState() {
    super.initState();
    _explanationController = TextEditingController();
    final isDraft = OfflineActionIds.isDraft(
      widget.entry.actionId ?? OfflineActionIds.unknown,
    );
    _reasons = [
      OfflineReconciliationReason.recordedElsewhereVerified,
      if (!isDraft) OfflineReconciliationReason.transferredToPaper,
      OfflineReconciliationReason.manualEntryVerified,
      OfflineReconciliationReason.duplicateConfirmed,
      OfflineReconciliationReason.wrongPatientOrContext,
      OfflineReconciliationReason.policyOrSchemaConflict,
      if (isDraft) OfflineReconciliationReason.draftCancelled,
    ];
    _reason = _reasons.first;
  }

  @override
  void dispose() {
    _explanationController.dispose();
    super.dispose();
  }

  String _text(String key, [Map<String, Object?> values = const {}]) {
    return _resolveText(widget.textResolver, key, values);
  }

  bool get _explanationRequired =>
      _reason == OfflineReconciliationReason.wrongPatientOrContext ||
      _reason == OfflineReconciliationReason.policyOrSchemaConflict;

  bool get _canSubmit =>
      _confirmed &&
      (!_explanationRequired || _explanationController.text.trim().isNotEmpty);

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(_text('offline_sync.reconcile.title')),
      content: SizedBox(
        width: 520,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              DropdownButtonFormField<OfflineReconciliationReason>(
                initialValue: _reason,
                decoration: InputDecoration(
                  labelText: _text('offline_sync.reconcile.reason'),
                ),
                items: [
                  for (final reason in _reasons)
                    DropdownMenuItem(
                      value: reason,
                      child: Text(
                        _text('offline_sync.reconcile.reason.${reason.code}'),
                      ),
                    ),
                ],
                onChanged: (reason) {
                  if (reason == null) return;
                  setState(() => _reason = reason);
                },
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _explanationController,
                minLines: 2,
                maxLines: 4,
                onChanged: (_) => setState(() {}),
                decoration: InputDecoration(
                  labelText: _text('offline_sync.reconcile.explanation'),
                  errorText:
                      _explanationRequired &&
                          _explanationController.text.trim().isEmpty
                      ? _text('offline_sync.reconcile.explanation_required')
                      : null,
                ),
              ),
              const SizedBox(height: 8),
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                value: _confirmed,
                onChanged: (value) =>
                    setState(() => _confirmed = value ?? false),
                title: Text(
                  _text('offline_sync.reconcile.confirmation'),
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(_text('offline_sync.action.cancel')),
        ),
        FilledButton(
          onPressed: _canSubmit
              ? () {
                  Navigator.of(context).pop(
                    OfflineReconciliationRequest(
                      reason: _reason,
                      actorUuid: widget.actorUid,
                      confirmedNotRecordedOnServer: true,
                      explanation: _explanationController.text.trim().isEmpty
                          ? null
                          : _explanationController.text.trim(),
                    ),
                  );
                }
              : null,
          child: Text(_text('offline_sync.reconcile.submit')),
        ),
      ],
    );
  }
}

class _StatusRow extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String label;

  const _StatusRow({
    required this.icon,
    required this.color,
    required this.label,
  });

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: label,
      child: Row(
        children: [
          Icon(icon, size: 18, color: color),
          const SizedBox(width: 10),
          Text(label, style: Theme.of(context).textTheme.bodyMedium),
        ],
      ),
    );
  }
}

typedef OfflineWriteDiscardCallback = Future<void> Function(
  bool reconciliationConfirmed,
);

/// Pure row widget for a typed v5 offline-write entry.
class OfflineWriteStatusRow extends StatelessWidget {
  final OfflineWriteEntry entry;
  final OfflineSyncTextResolver? textResolver;
  final Future<void> Function()? onRetry;
  final OfflineWriteDiscardCallback? onDiscard;
  final Future<void> Function()? onReconcile;
  final Future<void> Function()? onAttest;

  const OfflineWriteStatusRow({
    super.key,
    required this.entry,
    this.textResolver,
    this.onRetry,
    this.onDiscard,
    this.onReconcile,
    this.onAttest,
  });

  String _text(String key, [Map<String, Object?> values = const {}]) {
    return _resolveText(textResolver, key, values);
  }

  Future<void> _handleDiscard(BuildContext context) async {
    final guard = clinicalDiscardGuardFor(entry.method, entry.endpoint);
    if (guard == null) {
      await onDiscard?.call(false);
      return;
    }
    final confirmed = await _showDiscardConfirmation(
      context,
      guard,
      textResolver,
    );
    if (confirmed) await onDiscard?.call(true);
  }

  Future<void> _handleAttestation(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(_text('offline_sync.attestation.title')),
        content: Text(_text('offline_sync.attestation.body')),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(_text('offline_sync.action.cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(_text('offline_sync.attestation.confirm')),
          ),
        ],
      ),
    );
    if (confirmed == true) await onAttest?.call();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final created = DateFormat('dd MMM yyyy HH:mm').format(entry.createdAt);
    final statusKey = entry.isSkipped
        ? 'skipped'
        : entry.isHandoffAttested
        ? 'attested'
        : entry.status.value;
    final statusLabel = _codeLabel('offline_sync.state', statusKey);
    final statusStyle = _statusPresentation(statusKey);
    final reason = entry.reviewReasonCode != null
        ? _codeLabel('offline_sync.reason', entry.reviewReasonCode!)
        : entry.conflictReason ?? '—';
    final blockerBase = entry.isSkipped
        ? entry.blockerRowId == null
              ? _text('offline_sync.blocker.partition_waiting')
              : _text('offline_sync.blocker.earlier_item', {
                  'id': entry.blockerRowId,
                })
        : _text('offline_sync.blocker.none');
    final blockerReason = entry.blockerReasonCode;
    final blocker = entry.isSkipped && blockerReason != null
        ? '$blockerBase · ${_blockerReasonLabel(blockerReason)}'
        : blockerBase;
    final reconciliationOwner =
        entry.reconciliationOwnerId == 'role:clinical_safety_lead'
        ? _text('offline_sync.role.clinical_safety_lead')
        : entry.reconciliationOwnerId ?? '—';
    final paperFormSetKey = offlinePaperFormSetKeyForFamily(
      entry.classification.family,
    );
    final isLegacy =
        entry.stateReasonCode ==
        OfflineWriteReviewReason.legacyClientRowRequiresReconciliation.code;
    final showRetry = !isLegacy && entry.canRetry && onRetry != null;
    final showDiscard = !isLegacy && entry.canDiscard && onDiscard != null;
    final showReconcile = _canReconcile(entry) && onReconcile != null;
    final showAttest = entry.canAttestHandoff && onAttest != null;

    return Card(
      elevation: 0,
      margin: const EdgeInsets.only(bottom: 10),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: theme.colorScheme.outlineVariant),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  statusStyle.icon,
                  size: 20,
                  color: statusStyle.color,
                  semanticLabel: statusLabel,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    isLegacy
                        ? _text('offline_sync.legacy.title')
                        : entry.contextLabel ?? entry.endpoint,
                    style: theme.textTheme.bodyLarge?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                Semantics(
                  label: '${_text('offline_sync.field.status')}: $statusLabel',
                  child: Chip(
                    avatar: Icon(
                      statusStyle.icon,
                      size: 16,
                      color: statusStyle.color,
                    ),
                    label: Text(statusLabel),
                    side: BorderSide(color: statusStyle.color),
                    backgroundColor: statusStyle.color.withValues(alpha: 0.08),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            if (isLegacy) ...[
              Semantics(
                liveRegion: true,
                child: Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: theme.colorScheme.errorContainer,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Text(
                    _text('offline_sync.legacy.message'),
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.onErrorContainer,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 8),
            ],
            _EntryField(
              label: _text('offline_sync.field.family'),
              value: _text('offline_sync.family.${entry.familyKey}'),
            ),
            if (!isLegacy) ...[
              _EntryField(
                label: _text('offline_sync.field.context'),
                value: entry.contextLabel ?? '—',
              ),
              _EntryField(
                label: _text('offline_sync.field.endpoint'),
                value: '${entry.method} ${entry.endpoint}',
                monospace: true,
              ),
            ],
            _EntryField(
              label: _text('offline_sync.field.captured'),
              value: created,
            ),
            _EntryField(
              label: _text('offline_sync.field.status'),
              value: statusLabel,
            ),
            _EntryField(
              label: _text('offline_sync.field.reason'),
              value: reason,
            ),
            if (!isLegacy) ...[
              _EntryField(
                label: _text('offline_sync.field.blocker'),
                value: blocker,
              ),
              _EntryField(
                label: _text('offline_sync.field.retry_count'),
                value: '${entry.retryCount}',
              ),
              _EntryField(
                label: _text('offline_sync.field.capture_owner'),
                value: entry.staffId ?? '—',
              ),
              _EntryField(
                label: _text('offline_sync.field.reconciliation_owner'),
                value: reconciliationOwner,
              ),
            ],
            if (paperFormSetKey != null)
              _EntryField(
                label: _text('offline_sync.field.paper_form_set'),
                value: _text(paperFormSetKey),
              ),
            if (entry.isHandoffAttested)
              _EntryField(
                label: _text('offline_sync.field.attestation'),
                value: _text('offline_sync.attestation.recorded', {
                  'actor': entry.handoffAttestedBy ?? '—',
                  'time': entry.handoffAttestedAt == null
                      ? '—'
                      : DateFormat('dd MMM yyyy HH:mm')
                            .format(entry.handoffAttestedAt!),
                }),
              ),
            if (showRetry || showDiscard || showReconcile || showAttest) ...[
              const SizedBox(height: 10),
              Wrap(
                alignment: WrapAlignment.end,
                spacing: 8,
                runSpacing: 8,
                children: [
                  if (showDiscard)
                    TextButton(
                      onPressed: () => _handleDiscard(context),
                      child: Text(_text('offline_sync.action.discard')),
                    ),
                  if (showReconcile)
                    TextButton.icon(
                      onPressed: onReconcile,
                      icon: const Icon(Icons.fact_check_outlined),
                      label: Text(_text('offline_sync.action.reconcile')),
                    ),
                  if (showRetry)
                    FilledButton.tonal(
                      onPressed: onRetry,
                      child: Text(_text('offline_sync.action.retry')),
                    ),
                  if (showAttest)
                    FilledButton.icon(
                      onPressed: () => _handleAttestation(context),
                      icon: const Icon(Icons.assignment_turned_in_outlined),
                      label: Text(_text('offline_sync.action.attest')),
                    ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  String _blockerReasonLabel(String reasonCode) {
    if (OfflineWriteReviewReason.fromCode(reasonCode) != null) {
      return _text('offline_sync.reason.$reasonCode');
    }
    final status = OfflineWriteStatus.fromValue(reasonCode);
    if (status != null) {
      return _text('offline_sync.state.${status.value}');
    }
    return reasonCode.replaceAll('_', ' ');
  }

  String _codeLabel(String prefix, String code) {
    final key = '$prefix.$code';
    final localized = _text(key);
    return localized == key ? code.replaceAll('_', ' ') : localized;
  }
}

class _EntryField extends StatelessWidget {
  final String label;
  final String value;
  final bool monospace;

  const _EntryField({
    required this.label,
    required this.value,
    this.monospace = false,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Semantics(
        label: '$label: $value',
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 136,
              child: Text(
                label,
                style: theme.textTheme.bodySmall?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            Expanded(
              child: Text(
                value,
                style: theme.textTheme.bodySmall?.copyWith(
                  fontFamily: monospace ? 'monospace' : null,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _StatusPresentation {
  final IconData icon;
  final Color color;

  const _StatusPresentation(this.icon, this.color);
}

_StatusPresentation _statusPresentation(String status) {
  return switch (status) {
    'pending' => _StatusPresentation(Icons.schedule, Colors.amber.shade800),
    'in_flight' => _StatusPresentation(Icons.sync, Colors.blue.shade700),
    'retry_wait' => _StatusPresentation(
      Icons.replay_outlined,
      Colors.amber.shade900,
    ),
    'conflict' => _StatusPresentation(Icons.error_outline, Colors.red.shade700),
    'skipped' => _StatusPresentation(
      Icons.pause_circle_outline,
      Colors.blueGrey.shade700,
    ),
    'attested' => _StatusPresentation(
      Icons.assignment_turned_in_outlined,
      Colors.teal.shade700,
    ),
    _ => _StatusPresentation(
      Icons.assignment_late_outlined,
      Colors.deepOrange.shade800,
    ),
  };
}

enum ClinicalDiscardGuard {
  prescription,
  order,
  mar,
  specimen,
  transfusion,
  notes,
  vitals,
}

/// Existing Staff localization key for the recorded downtime paper set.
///
/// Controls and unknown actions deliberately return null: C0A does not assign
/// them one of the six quarantined-family fallback forms.
@visibleForTesting
String? offlinePaperFormSetKeyForFamily(OfflineWriteActionFamily family) {
  return switch (family) {
    OfflineWriteActionFamily.prescriptionCreate =>
      'c0a.offline_fallback.paper_set.opd_prescription_pads',
    OfflineWriteActionFamily.drugChartOrder =>
      'c0a.offline_fallback.paper_set.inpatient_drug_charts',
    OfflineWriteActionFamily.marAdministration =>
      'c0a.offline_fallback.paper_set.mar_sheets',
    OfflineWriteActionFamily.specimenCollection =>
      'c0a.offline_fallback.paper_set.laboratory_requisition_forms',
    OfflineWriteActionFamily.transfusionVerification =>
      'c0a.offline_fallback.paper_set.blood_bank_verification_slips',
    OfflineWriteActionFamily.authoritativeNote =>
      'c0a.offline_fallback.paper_set.nursing_note_forms',
    OfflineWriteActionFamily.vitals ||
    OfflineWriteActionFamily.noteDraft ||
    OfflineWriteActionFamily.unknown => null,
  };
}

/// Returns the clinical confirmation guard for a stored conflict action.
///
/// The scope intentionally exceeds C0A containment: every mutating notes route
/// and the vitals control are protected too.
@visibleForTesting
ClinicalDiscardGuard? clinicalDiscardGuardFor(String method, String endpoint) {
  final normalizedMethod = method.toUpperCase();
  if (!OfflineWriteContainment.requiresReconciledDiscard(
    method: normalizedMethod,
    path: endpoint,
  )) {
    return null;
  }
  final family = OfflineWriteContainment.classify(
    method: normalizedMethod,
    path: endpoint,
  ).family;
  return switch (family) {
    OfflineWriteActionFamily.prescriptionCreate =>
      ClinicalDiscardGuard.prescription,
    OfflineWriteActionFamily.drugChartOrder => ClinicalDiscardGuard.order,
    OfflineWriteActionFamily.marAdministration => ClinicalDiscardGuard.mar,
    OfflineWriteActionFamily.specimenCollection =>
      ClinicalDiscardGuard.specimen,
    OfflineWriteActionFamily.transfusionVerification =>
      ClinicalDiscardGuard.transfusion,
    OfflineWriteActionFamily.vitals => ClinicalDiscardGuard.vitals,
    OfflineWriteActionFamily.authoritativeNote ||
    OfflineWriteActionFamily.noteDraft ||
    OfflineWriteActionFamily.unknown => ClinicalDiscardGuard.notes,
  };
}

String _discardKey(ClinicalDiscardGuard guard, String suffix) {
  final family = switch (guard) {
    ClinicalDiscardGuard.prescription => 'prescription',
    ClinicalDiscardGuard.order => 'order',
    ClinicalDiscardGuard.mar => 'mar',
    ClinicalDiscardGuard.specimen => 'specimen',
    ClinicalDiscardGuard.transfusion => 'transfusion',
    ClinicalDiscardGuard.notes => 'notes',
    ClinicalDiscardGuard.vitals => 'vitals',
  };
  return 'offline_sync.discard.${family}_$suffix';
}

Future<bool> _showDiscardConfirmation(
  BuildContext context,
  ClinicalDiscardGuard guard,
  OfflineSyncTextResolver? textResolver,
) async {
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: Text(_resolveText(textResolver, _discardKey(guard, 'title'))),
      content: Text(_resolveText(textResolver, _discardKey(guard, 'body'))),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(dialogContext).pop(false),
          child: Text(_resolveText(textResolver, 'offline_sync.action.cancel')),
        ),
        TextButton(
          style: TextButton.styleFrom(foregroundColor: Colors.red.shade700),
          onPressed: () => Navigator.of(dialogContext).pop(true),
          child: Text(
            _resolveText(textResolver, 'offline_sync.discard.confirm'),
          ),
        ),
      ],
    ),
  );
  return confirmed == true;
}

/// Backward-compatible pure conflict row used by focused safety widget tests.
///
/// Runtime Sync status uses [OfflineWriteStatusRow], whose controls are driven
/// by service-authorized typed entries. This adapter preserves the existing
/// callback test surface while applying the same widened confirmation guard.
class ConflictRow extends StatelessWidget {
  final Map<String, dynamic> conflict;
  final VoidCallback onDiscard;
  final VoidCallback onRetry;
  final OfflineSyncTextResolver? textResolver;

  const ConflictRow({
    super.key,
    required this.conflict,
    required this.onDiscard,
    required this.onRetry,
    this.textResolver,
  });

  Future<void> _handleDiscard(
    BuildContext context,
    String method,
    String endpoint,
  ) async {
    final guard = clinicalDiscardGuardFor(method, endpoint);
    if (guard == null) {
      onDiscard();
      return;
    }
    if (await _showDiscardConfirmation(context, guard, textResolver)) {
      onDiscard();
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final endpoint = conflict['endpoint'] as String? ?? '';
    final method = conflict['method'] as String? ?? '';
    final label = conflict['context_label'] as String? ?? endpoint;
    final reason = conflict['conflict_reason'] as String? ?? 'Conflict';
    final guard = clinicalDiscardGuardFor(method, endpoint);
    final createdAt = conflict['created_at'] as int?;
    final createdLabel = createdAt == null
        ? ''
        : DateFormat('dd MMM HH:mm')
              .format(DateTime.fromMillisecondsSinceEpoch(createdAt));
    final reasonText = guard == ClinicalDiscardGuard.mar
        ? '${_resolveText(textResolver, 'offline_sync.discard.mar_body')} $reason'
        : guard == ClinicalDiscardGuard.notes
        ? '${_resolveText(textResolver, 'offline_sync.discard.notes_body')} $reason'
        : guard == ClinicalDiscardGuard.vitals
        ? '${_resolveText(textResolver, 'offline_sync.discard.vitals_body')} $reason'
        : guard == ClinicalDiscardGuard.order
        ? 'Medication order not placed on the server — review needed. $reason.'
        : guard == ClinicalDiscardGuard.prescription
        ? 'Prescription not recorded on the server — review needed. $reason.'
        : guard == ClinicalDiscardGuard.transfusion
        ? 'Transfusion verification not recorded on the server — review needed. $reason.'
        : guard == ClinicalDiscardGuard.specimen
        ? 'Specimen collection not recorded on the server — review needed. $reason.'
        : reason;

    return Card(
      elevation: 0,
      margin: const EdgeInsets.only(bottom: 8),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: Colors.red.shade200),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.error_outline, size: 18, color: Colors.red.shade700),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    label,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                if (createdLabel.isNotEmpty)
                  Text(
                    createdLabel,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurface.withValues(alpha: 0.6),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              '$method $endpoint',
              style: theme.textTheme.bodySmall?.copyWith(
                fontFamily: 'monospace',
                color: theme.colorScheme.onSurface.withValues(alpha: 0.7),
              ),
            ),
            const SizedBox(height: 6),
            Text(
              reasonText,
              style: theme.textTheme.bodySmall?.copyWith(
                color: Colors.red.shade700,
                fontWeight: guard == null ? null : FontWeight.w600,
              ),
            ),
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: () => _handleDiscard(context, method, endpoint),
                  child: Text(
                    _resolveText(textResolver, 'offline_sync.action.discard'),
                  ),
                ),
                const SizedBox(width: 4),
                FilledButton.tonal(
                  onPressed: onRetry,
                  child: Text(
                    _resolveText(textResolver, 'offline_sync.action.retry'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
