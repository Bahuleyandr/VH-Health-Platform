import 'package:flutter/material.dart';

import '../../../core/theme/app_theme.dart';
import '../../../l10n/app_strings.dart';
import '../models/staff_teleconsult_models.dart';

String staffTeleconsultStateLabel(
  AppStrings s,
  StaffTeleconsultJoinState state,
) {
  return switch (state) {
    StaffTeleconsultJoinState.notYet => s.lookup(
      'staff_teleconsult.state.not_yet',
    ),
    StaffTeleconsultJoinState.lobbyOpen => s.lookup(
      'staff_teleconsult.state.lobby_open',
    ),
    StaffTeleconsultJoinState.inProgress => s.lookup(
      'staff_teleconsult.state.in_progress',
    ),
    StaffTeleconsultJoinState.ended => s.lookup(
      'staff_teleconsult.state.ended',
    ),
    StaffTeleconsultJoinState.cancelled => s.lookup(
      'staff_teleconsult.state.cancelled',
    ),
    StaffTeleconsultJoinState.unavailable => s.lookup(
      'staff_teleconsult.state.unavailable',
    ),
    StaffTeleconsultJoinState.unknown => s.lookup(
      'staff_teleconsult.state.unknown',
    ),
  };
}

class StaffTeleconsultBadge extends StatelessWidget {
  const StaffTeleconsultBadge({
    super.key,
    required this.state,
    this.compact = false,
  });

  final StaffTeleconsultLobbyState? state;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final joinState = state?.joinState ?? StaffTeleconsultJoinState.unknown;
    final color = switch (joinState) {
      StaffTeleconsultJoinState.lobbyOpen => AppTheme.warningOnSurface,
      StaffTeleconsultJoinState.inProgress => AppTheme.successGreen,
      StaffTeleconsultJoinState.cancelled => AppTheme.errorOnSurface,
      StaffTeleconsultJoinState.ended => AppTheme.textSecondary,
      _ => AppTheme.primaryBlue,
    };
    final label = compact
        ? s.lookup('staff_teleconsult.badge')
        : staffTeleconsultStateLabel(s, joinState);
    return Container(
      key: const Key('staff-teleconsult-queue-badge'),
      padding: EdgeInsets.symmetric(
        horizontal: compact ? 8 : 10,
        vertical: compact ? 4 : 5,
      ),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(99),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.video_call_outlined, color: color, size: 14),
          if (!compact) ...[
            const SizedBox(width: 5),
            Flexible(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: color,
                  fontSize: 11,
                  fontWeight: FontWeight.w900,
                ),
              ),
            ),
          ] else ...[
            const SizedBox(width: 4),
            Text(
              label,
              style: TextStyle(
                color: color,
                fontSize: 11,
                fontWeight: FontWeight.w900,
              ),
            ),
          ],
        ],
      ),
    );
  }
}
