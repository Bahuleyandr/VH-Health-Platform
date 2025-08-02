import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:intl/intl.dart';

// Option 1: Card-based Appointment Widget
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
          // Header
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: theme.colorScheme.primary.withValues(alpha: 0.1),
              borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
            ),
            child: Row(
              children: [
                Icon(
                  LucideIcons.calendar,
                  color: theme.colorScheme.primary,
                ),
                const SizedBox(width: 12),
                Text(
                  'Appointments',
                  style: theme.textTheme.titleLarge?.copyWith(
                    fontWeight: FontWeight.bold,
                    color: theme.colorScheme.primary,
                  ),
                ),
              ],
            ),
          ),
          
          // Appointments
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              children: [
                _buildAppointmentRow(
                  context,
                  icon: LucideIcons.checkCircle,
                  iconColor: theme.colorScheme.tertiary,
                  label: 'Last Appointment',
                  date: lastAppointment,
                  isPast: true,
                ),
                const SizedBox(height: 16),
                Divider(
                  color: theme.colorScheme.outline.withValues(alpha: 0.2),
                ),
                const SizedBox(height: 16),
                _buildAppointmentRow(
                  context,
                  icon: LucideIcons.clock,
                  iconColor: theme.colorScheme.primary,
                  label: 'Upcoming Appointment',
                  date: nextAppointment,
                  isPast: false,
                ),
              ],
            ),
          ),
          
          // Action buttons
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
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
                    icon: const Icon(LucideIcons.history, size: 18),
                    label: const Text('History'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: FilledButton.icon(
                    onPressed: onScheduleNew,
                    icon: const Icon(LucideIcons.plus, size: 18),
                    label: const Text('Schedule'),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildAppointmentRow(
    BuildContext context, {
    required IconData icon,
    required Color iconColor,
    required String label,
    required String? date,
    required bool isPast,
  }) {
    final theme = Theme.of(context);
    final hasDate = date != null && date.isNotEmpty;
    
    return Row(
      children: [
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: iconColor.withValues(alpha: 0.1),
            shape: BoxShape.circle,
          ),
          child: Icon(
            icon,
            color: iconColor,
            size: 24,
          ),
        ),
        const SizedBox(width: 16),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                label,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurface.withValues(alpha: 0.7),
                ),
              ),
              const SizedBox(height: 4),
              Text(
                hasDate ? _formatDate(date) : 'Not Scheduled',
                style: theme.textTheme.bodyLarge?.copyWith(
                  fontWeight: FontWeight.bold,
                  color: hasDate 
                    ? theme.colorScheme.onSurface 
                    : theme.colorScheme.onSurface.withValues(alpha: 0.5),
                ),
              ),
              if (hasDate && !isPast) ...[
                const SizedBox(height: 4),
                Text(
                  _getDaysUntil(date),
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.primary,
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }

  String _formatDate(String date) {
    try {
      // Try parsing different date formats
      DateTime? parsedDate;
      
      // Try dd/MM/yyyy format first
      try {
        parsedDate = DateFormat('dd/MM/yyyy').parse(date);
      } catch (_) {
        // Try other formats
        parsedDate = DateTime.tryParse(date);
      }
      
      if (parsedDate != null) {
        return DateFormat('dd/MM/yyyy').format(parsedDate);
      }
    } catch (_) {
      // Return original if parsing fails
    }
    return date;
  }

  String _getDaysUntil(String date) {
    try {
      DateTime? parsedDate;
      
      try {
        parsedDate = DateFormat('dd/MM/yyyy').parse(date);
      } catch (_) {
        parsedDate = DateTime.tryParse(date);
      }
      
      if (parsedDate != null) {
        final now = DateTime.now();
        final difference = parsedDate.difference(now).inDays;
        
        if (difference == 0) return 'Today';
        if (difference == 1) return 'Tomorrow';
        if (difference > 0) return 'In $difference days';
        return 'Overdue';
      }
    } catch (_) {
      // Silent fail
    }
    return '';
  }
}

// Option 2: Minimal Timeline Widget
class AppointmentTimeline extends StatelessWidget {
  final String? lastAppointment;
  final String? nextAppointment;
  final VoidCallback? onTap;

  const AppointmentTimeline({
    super.key,
    this.lastAppointment,
    this.nextAppointment,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    
    return GestureDetector(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(
          gradient: LinearGradient(
            colors: [
              theme.colorScheme.primary.withValues(alpha: 0.05),
              theme.colorScheme.secondary.withValues(alpha: 0.05),
            ],
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
          ),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: theme.colorScheme.outline.withValues(alpha: 0.2),
          ),
        ),
        child: Row(
          children: [
            // Past appointment
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    LucideIcons.checkCircle2,
                    color: Colors.green,
                    size: 32,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Last Visit',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurface.withValues(alpha: 0.7),
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    lastAppointment ?? 'No record',
                    style: theme.textTheme.bodyMedium?.copyWith(
                      fontWeight: FontWeight.bold,
                    ),
                    textAlign: TextAlign.center,
                  ),
                ],
              ),
            ),
            
            // Timeline connector
            Container(
              height: 60,
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Container(
                    width: 40,
                    height: 2,
                    color: theme.colorScheme.primary.withValues(alpha: 0.3),
                  ),
                  Icon(
                    LucideIcons.arrowRight,
                    color: theme.colorScheme.primary,
                    size: 20,
                  ),
                ],
              ),
            ),
            
            // Next appointment
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    LucideIcons.calendarClock,
                    color: Colors.blue,
                    size: 32,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Next Visit',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurface.withValues(alpha: 0.7),
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    nextAppointment ?? 'Schedule now',
                    style: theme.textTheme.bodyMedium?.copyWith(
                      fontWeight: FontWeight.bold,
                      color: nextAppointment != null 
                        ? null 
                        : theme.colorScheme.primary,
                    ),
                    textAlign: TextAlign.center,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// Option 3: Compact Info Bar
class AppointmentInfoBar extends StatelessWidget {
  final String? lastAppointment;
  final String? nextAppointment;
  final VoidCallback? onTap;

  const AppointmentInfoBar({
    super.key,
    this.lastAppointment,
    this.nextAppointment,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    
    return GestureDetector(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.all(16),
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
        decoration: BoxDecoration(
          color: theme.colorScheme.primaryContainer,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          children: [
            Icon(
              LucideIcons.calendar,
              color: theme.colorScheme.onPrimaryContainer,
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Text(
                        'Last: ',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onPrimaryContainer.withValues(alpha: 0.7),
                        ),
                      ),
                      Text(
                        lastAppointment ?? 'No record',
                        style: theme.textTheme.bodySmall?.copyWith(
                          fontWeight: FontWeight.bold,
                          color: theme.colorScheme.onPrimaryContainer,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      Text(
                        'Next: ',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onPrimaryContainer.withValues(alpha: 0.7),
                        ),
                      ),
                      Text(
                        nextAppointment ?? 'Not scheduled',
                        style: theme.textTheme.bodySmall?.copyWith(
                          fontWeight: FontWeight.bold,
                          color: theme.colorScheme.onPrimaryContainer,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            Icon(
              LucideIcons.chevronRight,
              color: theme.colorScheme.onPrimaryContainer.withValues(alpha: 0.5),
            ),
          ],
        ),
      ),
    );
  }
}