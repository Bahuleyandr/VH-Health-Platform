// A single appointment card in the My-Appointments list. Extracted from
// appointments_screen.dart's _appointmentCard builder — presentational,
// with view-prescription / cancel callbacks the list tab wires up.
import 'package:flutter/material.dart';
import 'package:vhhealth/features/appointments/models/appointment_models.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class AppointmentCard extends StatelessWidget {
  final AppointmentInfo appt;
  final ValueChanged<AppointmentInfo> onViewPrescription;
  final ValueChanged<AppointmentInfo> onCancel;

  const AppointmentCard({
    super.key,
    required this.appt,
    required this.onViewPrescription,
    required this.onCancel,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final statusCol = _statusColor(appt.status);

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
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
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 4,
                  ),
                  decoration: BoxDecoration(
                    color: statusCol.withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text(
                    _statusLabel(appt.status),
                    style: TextStyle(
                      color: statusCol,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
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
                    'Token #${appt.tokenNumber}',
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
                'Reason: ${appt.reason}',
                style: theme.textTheme.bodySmall?.copyWith(
                  fontStyle: FontStyle.italic,
                ),
              ),
            ],
            if (appt.confirmationNotes != null &&
                appt.confirmationNotes!.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(
                'Note: ${appt.confirmationNotes}',
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
                  label: Text(
                    AppLocalizations.of(context)!.appointmentsViewPrescription,
                  ),
                  style: TextButton.styleFrom(
                    foregroundColor: const Color(0xFF00796B),
                  ),
                ),
              ),
            ],
            if (appt.isUpcoming && appt.status == 'scheduled') ...[
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerRight,
                child: TextButton.icon(
                  onPressed: () => onCancel(appt),
                  icon: const Icon(Icons.cancel_outlined, size: 18),
                  label: const Text('Cancel'),
                  style: TextButton.styleFrom(foregroundColor: Colors.red),
                ),
              ),
            ],
          ],
        ),
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

String _statusLabel(String status) {
  switch (status.toLowerCase()) {
    case 'scheduled':
      return 'Scheduled';
    case 'confirmed':
      return 'Confirmed ✓';
    case 'in_progress':
      return 'In Progress';
    case 'completed':
      return 'Completed';
    case 'cancelled':
      return 'Cancelled';
    case 'no_show':
      return 'No Show';
    default:
      return status.isNotEmpty
          ? status[0].toUpperCase() + status.substring(1)
          : status;
  }
}
