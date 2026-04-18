import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:vhhealth/core/theme/theme_colors.dart';

class AppointmentCard extends StatelessWidget {
  final String? lastAppointment;
  final String? nextAppointment;
  final VoidCallback? onViewHistory;
  final VoidCallback? onScheduleNew;

  const AppointmentCard({
    super.key,
    this.lastAppointment,
    this.nextAppointment,
    this.onViewHistory,
    this.onScheduleNew,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Container(
      margin: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        borderRadius: BorderRadius.circular(20),
        boxShadow: [
          BoxShadow(
            color: theme.colorScheme.primary.withValues(alpha: 0.1),
            blurRadius: 20,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            decoration: BoxDecoration(
              color: theme.colorScheme.primary.withValues(alpha: 0.1),
              borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
            ),
            child: Row(
              children: [
                Icon(LucideIcons.calendar, color: theme.colorScheme.primary, size: 20),
                const SizedBox(width: 8),
                Text(
                  'Appointments',
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                    color: theme.colorScheme.primary,
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                Expanded(
                  child: _buildAppointmentInfo(
                    context,
                    icon: LucideIcons.checkCircle,
                    iconColor: ThemeColors.getSuccessColor(context),
                    label: 'Last Visit',
                    date: lastAppointment,
                    isPast: true,
                  ),
                ),
                Container(
                  height: 50,
                  width: 1,
                  color: theme.colorScheme.outline.withValues(alpha: 0.2),
                  margin: const EdgeInsets.symmetric(horizontal: 16),
                ),
                Expanded(
                  child: _buildAppointmentInfo(
                    context,
                    icon: LucideIcons.clock,
                    iconColor: ThemeColors.getInfoColor(context),
                    label: 'Next Visit',
                    date: nextAppointment,
                    isPast: false,
                  ),
                ),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            decoration: BoxDecoration(
              border: Border(
                top: BorderSide(
                  color: theme.colorScheme.outline.withValues(alpha: 0.2),
                ),
              ),
            ),
            child: Row(
              children: [
                Expanded(
                  child: TextButton.icon(
                    onPressed: onViewHistory,
                    icon: const Icon(LucideIcons.history, size: 16),
                    label: const Text('History'),
                    style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 8)),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: FilledButton.icon(
                    onPressed: onScheduleNew,
                    icon: const Icon(LucideIcons.plus, size: 16),
                    label: const Text('Schedule'),
                    style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 8)),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildAppointmentInfo(
    BuildContext context, {
    required IconData icon,
    required Color iconColor,
    required String label,
    required String? date,
    required bool isPast,
  }) {
    final theme = Theme.of(context);
    final hasDate = date != null && date.isNotEmpty && date != 'Not Available';

    return Column(
      children: [
        Icon(icon, color: iconColor, size: 28),
        const SizedBox(height: 8),
        Text(
          label,
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurface.withValues(alpha: 0.7),
          ),
        ),
        const SizedBox(height: 4),
        Text(
          hasDate ? _formatDate(date) : 'Not Scheduled',
          style: theme.textTheme.bodyMedium?.copyWith(
            fontWeight: FontWeight.bold,
            color: hasDate
                ? theme.colorScheme.onSurface
                : theme.colorScheme.onSurface.withValues(alpha: 0.5),
          ),
          textAlign: TextAlign.center,
        ),
        if (hasDate && !isPast) ...[
          const SizedBox(height: 2),
          Text(
            _getDaysUntil(date),
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.primary,
              fontSize: 11,
            ),
          ),
        ],
      ],
    );
  }

  String _formatDate(String date) {
    try {
      DateTime? d;
      try { d = DateFormat('dd/MM/yyyy').parse(date); } catch (_) {}
      d ??= DateTime.tryParse(date);
      if (d != null) return DateFormat('dd/MM/yyyy').format(d);
    } catch (e) { debugPrint('Dashboard error: $e'); }
    return date;
  }

  String _getDaysUntil(String date) {
    try {
      DateTime? d;
      try { d = DateFormat('dd/MM/yyyy').parse(date); } catch (_) {}
      d ??= DateTime.tryParse(date);
      if (d != null) {
        final diff = DateTime(d.year, d.month, d.day)
            .difference(DateTime(DateTime.now().year, DateTime.now().month, DateTime.now().day))
            .inDays;
        if (diff == 0) return 'Today';
        if (diff == 1) return 'Tomorrow';
        if (diff > 0) return 'In $diff days';
      }
    } catch (e) { debugPrint('Dashboard error: $e'); }
    return '';
  }
}
