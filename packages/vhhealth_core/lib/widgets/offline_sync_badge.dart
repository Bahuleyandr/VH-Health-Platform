import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../services/connectivity_sync_service.dart';
import '../services/offline_queue.dart';

/// Compact status pill shown in the app bar. Hidden when the device is
/// online, the queue is empty, and there are no conflicts. Tap opens a
/// sheet listing conflicts (if any) or a brief sync summary.
class OfflineSyncBadge extends StatelessWidget {
  const OfflineSyncBadge({super.key});

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: ConnectivitySyncService.instance,
      builder: (context, _) {
        final service = ConnectivitySyncService.instance;
        final state = _resolveState(service);
        if (state == null) return const SizedBox.shrink();

        return Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
          child: InkWell(
            borderRadius: BorderRadius.circular(16),
            onTap: () => _openSheet(context),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: state.color.withValues(alpha: 0.15),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: state.color.withValues(alpha: 0.45)),
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
        );
      },
    );
  }

  _BadgeState? _resolveState(ConnectivitySyncService s) {
    // Priority: conflicts > syncing > offline > silent.
    if (s.conflictCount > 0) {
      return _BadgeState(
        label: '${s.conflictCount} conflict${s.conflictCount == 1 ? '' : 's'}',
        color: Colors.red.shade700,
        leading: Icon(
          Icons.error_outline,
          size: 14,
          color: Colors.red.shade700,
        ),
      );
    }
    if (s.isSyncing) {
      return _BadgeState(
        label: s.pendingCount > 0 ? 'Syncing ${s.pendingCount}…' : 'Syncing…',
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
    if (!s.isOnline) {
      return _BadgeState(
        label: s.pendingCount > 0
            ? 'Offline · ${s.pendingCount} queued'
            : 'Offline',
        color: Colors.orange.shade800,
        leading: Icon(Icons.cloud_off, size: 14, color: Colors.orange.shade800),
      );
    }
    if (s.pendingCount > 0) {
      return _BadgeState(
        label: '${s.pendingCount} pending',
        color: Colors.amber.shade800,
        leading: Icon(Icons.schedule, size: 14, color: Colors.amber.shade800),
      );
    }
    return null; // all good — hide badge
  }

  void _openSheet(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => const SyncStatusSheet(),
    );
  }
}

class _BadgeState {
  final String label;
  final Color color;
  final Widget leading;
  _BadgeState({
    required this.label,
    required this.color,
    required this.leading,
  });
}

/// Bottom sheet showing current sync status + any conflicts requiring
/// manual resolution. Discard or Retry each conflicted write.
class SyncStatusSheet extends StatefulWidget {
  const SyncStatusSheet({super.key});

  @override
  State<SyncStatusSheet> createState() => _SyncStatusSheetState();
}

class _SyncStatusSheetState extends State<SyncStatusSheet> {
  late Future<List<Map<String, dynamic>>> _conflictsFuture;

  @override
  void initState() {
    super.initState();
    _conflictsFuture = OfflineQueue.getConflicts();
  }

  void _reload() {
    setState(() {
      _conflictsFuture = OfflineQueue.getConflicts();
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return DraggableScrollableSheet(
      initialChildSize: 0.5,
      minChildSize: 0.3,
      maxChildSize: 0.9,
      expand: false,
      builder: (_, scrollController) => ListenableBuilder(
        listenable: ConnectivitySyncService.instance,
        builder: (context, _) {
          final s = ConnectivitySyncService.instance;
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
              Text('Sync status', style: theme.textTheme.titleLarge),
              const SizedBox(height: 12),
              _StatusRow(
                icon: s.isOnline ? Icons.cloud_done : Icons.cloud_off,
                color: s.isOnline
                    ? Colors.green.shade700
                    : Colors.orange.shade800,
                label: s.isOnline ? 'Online' : 'Offline',
              ),
              const SizedBox(height: 6),
              _StatusRow(
                icon: Icons.schedule,
                color: theme.colorScheme.onSurface,
                label:
                    '${s.pendingCount} pending write${s.pendingCount == 1 ? '' : 's'}',
              ),
              if (s.isSyncing) ...[
                const SizedBox(height: 6),
                _StatusRow(
                  icon: Icons.sync,
                  color: Colors.blue.shade700,
                  label: 'Sync in progress…',
                ),
              ],
              const SizedBox(height: 20),
              Row(
                children: [
                  Expanded(
                    child: Text(
                      'Conflicts',
                      style: theme.textTheme.titleMedium,
                    ),
                  ),
                  TextButton.icon(
                    onPressed: s.isOnline && !s.isSyncing
                        ? () => s.syncPending()
                        : null,
                    icon: const Icon(Icons.sync, size: 18),
                    label: const Text('Sync now'),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              FutureBuilder<List<Map<String, dynamic>>>(
                future: _conflictsFuture,
                builder: (context, snap) {
                  if (snap.connectionState != ConnectionState.done) {
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
                  final conflicts = snap.data ?? const [];
                  if (conflicts.isEmpty) {
                    return Padding(
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      child: Text(
                        'No conflicts. Everything is either synced or waiting to be sent.',
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: theme.colorScheme.onSurface.withValues(
                            alpha: 0.7,
                          ),
                        ),
                      ),
                    );
                  }
                  return Column(
                    children: conflicts
                        .map(
                          (c) => ConflictRow(
                            conflict: c,
                            onDiscard: () async {
                              await ConnectivitySyncService.instance
                                  .discardConflict(c['id'] as int);
                              _reload();
                            },
                            onRetry: () async {
                              await ConnectivitySyncService.instance
                                  .retryConflict(c['id'] as int);
                              _reload();
                            },
                          ),
                        )
                        .toList(),
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
    return Row(
      children: [
        Icon(icon, size: 18, color: color),
        const SizedBox(width: 10),
        Text(label, style: Theme.of(context).textTheme.bodyMedium),
      ],
    );
  }
}

/// A single conflicted offline-write row, with Discard / Retry actions.
///
/// Pure widget: it takes the conflict map plus [onDiscard] / [onRetry]
/// callbacks, so it can be driven directly in tests without faking the
/// `ConnectivitySyncService` singleton (a DB-backed [ChangeNotifier]).
///
/// MAR administrations (`endpoint` containing `/clinical/mar/`) get a
/// clinically-framed message — the drug was PHYSICALLY given offline, so a
/// server rejection is "not recorded on the server, review needed", never a
/// silent drop — and **Discard is gated behind a confirmation dialog**
/// (discarding a MAR conflict = an un-recorded administration of a drug that
/// was actually given). Non-MAR conflicts keep the generic rendering and
/// discard immediately.
class ConflictRow extends StatelessWidget {
  final Map<String, dynamic> conflict;

  /// Called when the user confirms discarding this conflicted write. For MAR
  /// conflicts this fires only AFTER the confirmation dialog is accepted.
  final VoidCallback onDiscard;

  /// Called when the user retries this conflicted write.
  final VoidCallback onRetry;

  const ConflictRow({
    super.key,
    required this.conflict,
    required this.onDiscard,
    required this.onRetry,
  });

  /// True for a MAR administration write (a medication that was physically
  /// given at the bedside). Such conflicts need clinical framing + a
  /// confirm-on-discard guard.
  static bool _isMarConflict(String endpoint) =>
      endpoint.contains('/clinical/mar/');

  /// True for a queued clinical ORDER create (`/emr/orders`). Discarding one
  /// means an ordered medication was never ordered — so it gets clinical
  /// framing + a confirm-on-discard guard, like MAR.
  static bool _isOrderConflict(String endpoint) =>
      endpoint.contains('/emr/orders');

  /// True for a queued e-PRESCRIPTION create (`/prescriptions/`). Discarding one means a
  /// prescription the clinician composed was never recorded — clinical framing + confirm.
  static bool _isPrescriptionConflict(String endpoint) =>
      endpoint.contains('/prescriptions/');

  /// Bedside transfusion verification that was recorded locally but rejected
  /// during drain needs clinical framing + confirm-on-discard.
  static bool _isTransfusionConflict(String endpoint) =>
      endpoint.contains('/blood-bank/') && endpoint.contains('/verify-bedside');

  /// Bedside specimen collection that was recorded locally but rejected during
  /// drain needs clinical framing + confirm-on-discard.
  static bool _isSpecimenConflict(String endpoint) =>
      endpoint.contains('/lab/samples/') && endpoint.contains('/collect');

  Future<void> _handleDiscard(BuildContext context, String endpoint) async {
    final isMar = _isMarConflict(endpoint);
    final isOrder = _isOrderConflict(endpoint);
    final isRx = _isPrescriptionConflict(endpoint);
    final isTransfusion = _isTransfusionConflict(endpoint);
    final isSpecimen = _isSpecimenConflict(endpoint);
    if (!isMar && !isOrder && !isRx && !isTransfusion && !isSpecimen) {
      onDiscard();
      return;
    }
    final String title;
    final String message;
    if (isTransfusion) {
      title = 'Discard transfusion verification?';
      message =
          'Discard this transfusion verification? It was recorded on this device but NOT recorded on the server.';
    } else if (isSpecimen) {
      title = 'Discard specimen collection?';
      message =
          'Discard this specimen collection? It was recorded on this device but NOT recorded on the server.';
    } else if (isRx) {
      title = 'Discard prescription?';
      message = 'Discard this prescription? It was NOT recorded on the server.';
    } else if (isOrder) {
      title = 'Discard medication order?';
      message =
          'Discard this medication order? It was NOT placed on the server.';
    } else {
      title = 'Discard administration record?';
      message =
          'Discard this administration record? The medication was given but '
          'will NOT be recorded.';
    }
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogCtx) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogCtx).pop(false),
            child: const Text('Cancel'),
          ),
          TextButton(
            style: TextButton.styleFrom(foregroundColor: Colors.red.shade700),
            onPressed: () => Navigator.of(dialogCtx).pop(true),
            child: const Text('Discard'),
          ),
        ],
      ),
    );
    if (confirmed == true) {
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
    final isMar = _isMarConflict(endpoint);
    final isOrder = _isOrderConflict(endpoint);
    final isRx = _isPrescriptionConflict(endpoint);
    final isTransfusion = _isTransfusionConflict(endpoint);
    final isSpecimen = _isSpecimenConflict(endpoint);
    final createdAt = conflict['created_at'] as int?;
    final createdLabel = createdAt != null
        ? DateFormat(
            'dd MMM HH:mm',
          ).format(DateTime.fromMillisecondsSinceEpoch(createdAt))
        : '';

    // For a MAR conflict the drug was physically given offline; surface a
    // clinically-clear, review-needed message instead of the bare reason.
    // For an order conflict the ordered drug was never placed on the server.
    // For a prescription conflict the prescription was never recorded on the server.
    final reasonWidget = isMar
        ? Text(
            'Administration not recorded on the server — review needed. '
            '$reason. The medication was given offline.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: Colors.red.shade700,
              fontWeight: FontWeight.w600,
            ),
          )
        : isOrder
        ? Text(
            'Medication order not placed on the server — review needed. $reason.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: Colors.red.shade700,
              fontWeight: FontWeight.w600,
            ),
          )
        : isRx
        ? Text(
            'Prescription not recorded on the server — review needed. $reason.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: Colors.red.shade700,
              fontWeight: FontWeight.w600,
            ),
          )
        : isTransfusion
        ? Text(
            'Transfusion verification not recorded on the server — review needed. $reason.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: Colors.red.shade700,
              fontWeight: FontWeight.w600,
            ),
          )
        : isSpecimen
        ? Text(
            'Specimen collection not recorded on the server — review needed. $reason.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: Colors.red.shade700,
              fontWeight: FontWeight.w600,
            ),
          )
        : Text(
            reason,
            style: theme.textTheme.bodySmall?.copyWith(
              color: Colors.red.shade700,
            ),
          );

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
            reasonWidget,
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: () => _handleDiscard(context, endpoint),
                  child: const Text('Discard'),
                ),
                const SizedBox(width: 4),
                FilledButton.tonal(
                  onPressed: onRetry,
                  child: const Text('Retry'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
