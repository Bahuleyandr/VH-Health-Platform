import 'package:flutter/material.dart';
import 'package:vhhealth/features/teleconsult/models/teleconsult_models.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class TeleconsultStatusPanel extends StatelessWidget {
  const TeleconsultStatusPanel({
    super.key,
    required this.state,
    this.onJoin,
    this.compact = false,
  });

  final TeleconsultLobbyState? state;
  final VoidCallback? onJoin;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final color = _stateColor(theme.colorScheme, state?.joinState);
    final title = _stateTitle(l, state?.joinState);
    final body = state?.message?.trim().isNotEmpty == true
        ? state!.message!
        : _stateBody(l, state?.joinState);

    return Semantics(
      container: true,
      label: '${l.teleconsultBadge}: $title',
      child: Container(
        padding: EdgeInsets.all(compact ? 12 : 16),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.10),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: color.withValues(alpha: 0.28)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.video_call_outlined, color: color),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    title,
                    style: theme.textTheme.titleSmall?.copyWith(
                      color: color,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ],
            ),
            if (!compact) ...[
              const SizedBox(height: 8),
              Text(body, style: theme.textTheme.bodyMedium),
              const SizedBox(height: 8),
              Row(
                children: [
                  Icon(
                    Icons.fiber_manual_record,
                    size: 10,
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      l.teleconsultRecordingOff,
                      style: theme.textTheme.bodySmall,
                    ),
                  ),
                ],
              ),
            ],
            if (onJoin != null) ...[
              const SizedBox(height: 12),
              Align(
                alignment: Alignment.centerRight,
                child: FilledButton.icon(
                  onPressed: onJoin,
                  icon: const Icon(Icons.videocam_outlined, size: 18),
                  label: Text(l.teleconsultJoinVideoConsult),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

Color _stateColor(ColorScheme scheme, TeleconsultJoinState? state) {
  return switch (state) {
    TeleconsultJoinState.lobbyOpen ||
    TeleconsultJoinState.inProgress => scheme.primary,
    TeleconsultJoinState.notYet => scheme.tertiary,
    TeleconsultJoinState.ended ||
    TeleconsultJoinState.cancelled ||
    TeleconsultJoinState.unavailable => scheme.error,
    TeleconsultJoinState.unknown || null => scheme.onSurfaceVariant,
  };
}

String _stateTitle(AppLocalizations l, TeleconsultJoinState? state) {
  return switch (state) {
    TeleconsultJoinState.notYet => l.teleconsultNotYet,
    TeleconsultJoinState.lobbyOpen => l.teleconsultLobbyOpen,
    TeleconsultJoinState.inProgress => l.teleconsultInProgress,
    TeleconsultJoinState.ended => l.teleconsultEnded,
    TeleconsultJoinState.cancelled => l.teleconsultCancelled,
    TeleconsultJoinState.unavailable => l.teleconsultUnavailableYet,
    TeleconsultJoinState.unknown => l.teleconsultStateUnknown,
    null => l.teleconsultStateChecking,
  };
}

String _stateBody(AppLocalizations l, TeleconsultJoinState? state) {
  return switch (state) {
    TeleconsultJoinState.notYet => l.teleconsultNotYetBody,
    TeleconsultJoinState.lobbyOpen => l.teleconsultLobbyOpenBody,
    TeleconsultJoinState.inProgress => l.teleconsultInProgressBody,
    TeleconsultJoinState.ended => l.teleconsultEndedBody,
    TeleconsultJoinState.cancelled => l.teleconsultCancelledBody,
    TeleconsultJoinState.unavailable => l.teleconsultUnavailableBody,
    TeleconsultJoinState.unknown || null => l.teleconsultStateUnknownBody,
  };
}
