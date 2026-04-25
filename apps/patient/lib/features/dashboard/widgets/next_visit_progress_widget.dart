// lib/features/dashboard/widgets/next_visit_progress_widget.dart
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

/// Compact card showing progress between last visit and next visit dates,
/// with a days countdown and doctor name.
///
/// When [detail] is null, shows a CTA to schedule a new visit.
class NextVisitProgressWidget extends StatelessWidget {
  final Map<String, dynamic>? detail;
  final VoidCallback onTap;
  final VoidCallback onSchedule;

  const NextVisitProgressWidget({
    super.key,
    required this.detail,
    required this.onTap,
    required this.onSchedule,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    if (detail == null) {
      return _buildNoAppointment(context, theme, cs);
    }

    return _buildProgressCard(context, theme, cs);
  }

  Widget _buildNoAppointment(
    BuildContext context,
    ThemeData theme,
    ColorScheme cs,
  ) {
    return Card(
      elevation: 0,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      color: cs.primaryContainer.withValues(alpha: 0.4),
      child: InkWell(
        onTap: onSchedule,
        borderRadius: BorderRadius.circular(16),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: cs.primary.withValues(alpha: 0.15),
                  shape: BoxShape.circle,
                ),
                child: Icon(Icons.calendar_today, color: cs.primary, size: 22),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Schedule your next visit',
                      style: theme.textTheme.bodyMedium?.copyWith(
                        fontWeight: FontWeight.bold,
                        color: cs.onSurface,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Stay on top of your health',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: cs.onSurface.withValues(alpha: 0.6),
                      ),
                    ),
                  ],
                ),
              ),
              FilledButton(
                onPressed: onSchedule,
                style: FilledButton.styleFrom(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 8,
                  ),
                ),
                child: const Text('Book Now'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildProgressCard(
    BuildContext context,
    ThemeData theme,
    ColorScheme cs,
  ) {
    final d = detail!;
    final daysUntil = (d['daysUntil'] as num?)?.toInt() ?? 0;
    final progressFraction =
        (d['progressFraction'] as num?)?.toDouble().clamp(0.0, 1.0) ?? 0.0;
    final doctorName = d['doctorName']?.toString();
    final dateStr = d['date']?.toString() ?? '';
    final timeStr = d['time']?.toString() ?? '';

    final String countdownText;
    final Color countdownColor;

    if (daysUntil < 0) {
      countdownText = 'Overdue';
      countdownColor = cs.error;
    } else if (daysUntil == 0) {
      countdownText = 'Visit today!';
      countdownColor = cs.tertiary;
    } else if (daysUntil == 1) {
      countdownText = '1 day until your visit';
      countdownColor = cs.primary;
    } else {
      countdownText = '$daysUntil days until your visit';
      countdownColor = cs.primary;
    }

    // Format the date for display
    String formattedDate = dateStr;
    try {
      final parsed = DateTime.tryParse(dateStr);
      if (parsed != null) {
        formattedDate = DateFormat('dd MMM yyyy').format(parsed);
      }
    } catch (_) {
      // Keep original string
    }

    return Card(
      elevation: 0,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Container(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [
                cs.primaryContainer.withValues(alpha: 0.3),
                cs.primaryContainer.withValues(alpha: 0.6),
              ],
            ),
          ),
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Header row with icon and countdown
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      color: countdownColor.withValues(alpha: 0.15),
                      shape: BoxShape.circle,
                    ),
                    child: Icon(
                      Icons.calendar_month,
                      color: countdownColor,
                      size: 20,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      countdownText,
                      style: theme.textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.bold,
                        color: countdownColor,
                      ),
                    ),
                  ),
                  Icon(
                    Icons.chevron_right,
                    color: cs.onSurface.withValues(alpha: 0.4),
                    size: 20,
                  ),
                ],
              ),

              const SizedBox(height: 12),

              // Progress bar
              ClipRRect(
                borderRadius: BorderRadius.circular(4),
                child: LinearProgressIndicator(
                  value: progressFraction,
                  minHeight: 6,
                  backgroundColor: cs.onSurface.withValues(alpha: 0.1),
                  valueColor: AlwaysStoppedAnimation<Color>(cs.primary),
                ),
              ),

              const SizedBox(height: 8),

              // Last visit / Next visit labels
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    'Last visit',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: cs.onSurface.withValues(alpha: 0.5),
                      fontSize: 11,
                    ),
                  ),
                  Text(
                    'Next visit',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: cs.onSurface.withValues(alpha: 0.5),
                      fontSize: 11,
                    ),
                  ),
                ],
              ),

              const SizedBox(height: 8),

              // Doctor name + date/time
              Row(
                children: [
                  if (doctorName != null && doctorName.isNotEmpty) ...[
                    Icon(
                      Icons.person,
                      size: 14,
                      color: cs.onSurface.withValues(alpha: 0.6),
                    ),
                    const SizedBox(width: 4),
                    Text(
                      'Dr. $doctorName',
                      style: theme.textTheme.bodySmall?.copyWith(
                        fontWeight: FontWeight.w600,
                        color: cs.onSurface.withValues(alpha: 0.8),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      '\u2022',
                      style: TextStyle(
                        color: cs.onSurface.withValues(alpha: 0.4),
                      ),
                    ),
                    const SizedBox(width: 8),
                  ],
                  Text(
                    '$formattedDate${timeStr.isNotEmpty ? ' at $timeStr' : ''}',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: cs.onSurface.withValues(alpha: 0.7),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
