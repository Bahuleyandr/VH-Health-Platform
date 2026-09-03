// A single appointment card in the My-Appointments list. Extracted from
// appointments_screen.dart's _appointmentCard builder — presentational,
// with view-prescription / cancel callbacks the list tab wires up.
import 'package:flutter/material.dart';
import 'package:vhhealth/features/appointments/models/appointment_models.dart';
import 'package:vhhealth/features/teleconsult/models/teleconsult_models.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class AppointmentCard extends StatelessWidget {
  final AppointmentInfo appt;
  final VoidCallback? onOpenDetails;
  final ValueChanged<AppointmentInfo>? onJoinTeleconsult;
  final ValueChanged<AppointmentInfo> onViewPrescription;
  final ValueChanged<AppointmentInfo> onReschedule;
  final ValueChanged<AppointmentInfo> onCancel;
  final TeleconsultLobbyState? teleconsultState;

  const AppointmentCard({
    super.key,
    required this.appt,
    this.onOpenDetails,
    this.onJoinTeleconsult,
    required this.onViewPrescription,
    required this.onReschedule,
    required this.onCancel,
    this.teleconsultState,
  });

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final statusCol = _statusColor(appt.status);
    final statusLabel = _statusLabel(l, appt.status);

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: InkWell(
        onTap: onOpenDetails,
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      appt.doctorName,
                      style: theme.textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                  Semantics(
                    container: true,
                    label: statusLabel,
                    excludeSemantics: true,
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 4,
                      ),
                      decoration: BoxDecoration(
                        color: statusCol.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Text(
                        statusLabel,
                        style: TextStyle(
                          color: statusCol,
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
              if (appt.isTeleconsult) ...[
                const SizedBox(height: 8),
                _TeleconsultStrip(
                  state: teleconsultState,
                  onJoin: teleconsultState?.joinable == true
                      ? () => onJoinTeleconsult?.call(appt)
                      : null,
                ),
              ],
              const SizedBox(height: 8),
              if (appt.department.isNotEmpty)
                Text(
                  appt.department,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              const SizedBox(height: 4),
              Row(
                children: [
                  Icon(
                    Icons.calendar_today,
                    size: 14,
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: 4),
                  Text(appt.date, style: theme.textTheme.bodySmall),
                  const SizedBox(width: 16),
                  Icon(
                    Icons.access_time,
                    size: 14,
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: 4),
                  Text(appt.time, style: theme.textTheme.bodySmall),
                ],
              ),
              if (appt.tokenNumber != null) ...[
                const SizedBox(height: 6),
                Row(
                  children: [
                    Icon(
                      Icons.confirmation_number,
                      size: 14,
                      color: const Color(0xFF00796B),
                    ),
                    const SizedBox(width: 4),
                    Text(
                      l.appointmentCardToken(appt.tokenNumber!),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: const Color(0xFF00796B),
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ],
              if (appt.reason != null && appt.reason!.isNotEmpty) ...[
                const SizedBox(height: 4),
                Text(
                  l.appointmentCardReason(appt.reason!),
                  style: theme.textTheme.bodySmall?.copyWith(
                    fontStyle: FontStyle.italic,
                  ),
                ),
              ],
              if (appt.confirmationNotes != null &&
                  appt.confirmationNotes!.isNotEmpty) ...[
                const SizedBox(height: 4),
                Text(
                  l.appointmentCardNote(appt.confirmationNotes!),
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
              if (appt.status == 'completed') ...[
                const SizedBox(height: 8),
                Align(
                  alignment: Alignment.centerRight,
                  child: TextButton.icon(
                    onPressed: () => onViewPrescription(appt),
                    icon: const Icon(Icons.description_outlined, size: 18),
                    label: Text(l.appointmentsViewPrescription),
                    style: TextButton.styleFrom(
                      foregroundColor: const Color(0xFF00796B),
                    ),
                  ),
                ),
              ],
              if (appt.isUpcoming && appt.status == 'scheduled') ...[
                const SizedBox(height: 8),
                OverflowBar(
                  alignment: MainAxisAlignment.end,
                  spacing: 8,
                  overflowSpacing: 4,
                  children: [
                    TextButton.icon(
                      onPressed: () => onReschedule(appt),
                      icon: const Icon(Icons.edit_calendar_outlined, size: 18),
                      label: Text(l.appointmentsReschedule),
                    ),
                    TextButton.icon(
                      onPressed: () => onCancel(appt),
                      icon: const Icon(Icons.cancel_outlined, size: 18),
                      label: Text(l.commonCancelButton),
                      style: TextButton.styleFrom(foregroundColor: Colors.red),
                    ),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _TeleconsultStrip extends StatelessWidget {
  const _TeleconsultStrip({required this.state, required this.onJoin});

  final TeleconsultLobbyState? state;
  final VoidCallback? onJoin;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final color = theme.colorScheme.primary;
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: color.withValues(alpha: 0.25)),
      ),
      child: Row(
        children: [
          Icon(Icons.videocam_outlined, color: color, size: 18),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  l.teleconsultBadge,
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: color,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                Text(
                  _teleconsultStateLabel(l, state),
                  style: theme.textTheme.bodySmall,
                ),
              ],
            ),
          ),
          if (onJoin != null)
            FilledButton.icon(
              onPressed: onJoin,
              icon: const Icon(Icons.video_call_outlined, size: 18),
              label: Text(l.teleconsultJoinVideoConsult),
            ),
        ],
      ),
    );
  }
}

Color _statusColor(String status) {
  switch (status.toLowerCase()) {
    case 'scheduled':
      return Colors.orange;
    case 'confirmed':
      return const Color(0xFF00796B); // teal
    case 'in_progress':
      return Colors.blue;
    case 'completed':
      return Colors.green;
    case 'cancelled':
      return Colors.red;
    case 'no_show':
      return Colors.grey;
    default:
      return Colors.blueGrey;
  }
}

String _teleconsultStateLabel(
  AppLocalizations l,
  TeleconsultLobbyState? state,
) {
  return switch (state?.joinState) {
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

String _statusLabel(AppLocalizations l, String status) {
  switch (status.toLowerCase()) {
    case 'scheduled':
      return l.appointmentStatusScheduled;
    case 'confirmed':
      return l.appointmentStatusConfirmed;
    case 'in_progress':
      return l.appointmentStatusInProgress;
    case 'completed':
      return l.appointmentStatusCompleted;
    case 'cancelled':
      return l.appointmentStatusCancelled;
    case 'no_show':
      return l.appointmentStatusNoShow;
    default:
      return status.isNotEmpty
          ? status[0].toUpperCase() + status.substring(1)
          : status;
  }
}
