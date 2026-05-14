// Draggable bottom-sheet showing a doctor's full profile (bio, education,
// qualifications, weekly schedule, consultation fee). Extracted from
// departments_screen.dart's _showDoctorDetail; the screen still owns the
// showModalBottomSheet call and wires onBook.
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class DoctorDetailSheet extends StatelessWidget {
  final Map<String, dynamic> doctor;
  final String deptName;
  final bool isAvailableToday;
  final VoidCallback onBook;

  const DoctorDetailSheet({
    super.key,
    required this.doctor,
    required this.deptName,
    required this.isAvailableToday,
    required this.onBook,
  });

  String get _todayName => DateFormat('EEEE').format(DateTime.now());

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final loc = AppLocalizations.of(context)!;
    final cs = theme.colorScheme;
    final qualifications = doctor['qualifications'] as List<dynamic>? ?? [];
    final availDays = doctor['available_days'] as List<dynamic>? ?? [];
    final availHours = doctor['available_hours'] as Map<String, dynamic>? ?? {};
    final fee = doctor['consultation_fee'];
    final exp = doctor['experience_years'];
    final bio = doctor['bio'] as String? ?? '';
    final education = doctor['education'] as String? ?? '';
    final docName = (doctor['name'] ?? loc.departmentsDoctor).toString();

    return DraggableScrollableSheet(
      initialChildSize: 0.75,
      minChildSize: 0.5,
      maxChildSize: 0.95,
      builder: (_, controller) => Container(
        decoration: BoxDecoration(
          color: theme.scaffoldBackgroundColor,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
        ),
        child: ListView(
          controller: controller,
          padding: const EdgeInsets.all(20),
          children: [
            // Handle
            Center(
              child: Container(
                width: 40,
                height: 4,
                margin: const EdgeInsets.only(bottom: 16),
                decoration: BoxDecoration(
                  color: cs.onSurface.withAlpha(51),
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            // Avatar + Name
            Row(
              children: [
                CircleAvatar(
                  radius: 36,
                  backgroundColor: cs.primaryContainer,
                  child: Icon(
                    Icons.person,
                    size: 36,
                    color: cs.onPrimaryContainer,
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        docName,
                        style: theme.textTheme.titleLarge?.copyWith(
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        doctor['specialization']?.toString() ?? '',
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: cs.primary,
                        ),
                      ),
                      Text(
                        deptName,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: cs.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),

            // Quick stats
            Row(
              children: [
                if (exp != null)
                  _StatChip(
                    icon: Icons.work_outline,
                    label: '$exp yrs',
                    theme: theme,
                  ),
                if (fee != null)
                  _StatChip(
                    icon: Icons.currency_rupee,
                    label: '₹$fee',
                    theme: theme,
                  ),
                if (isAvailableToday)
                  _StatChip(
                    icon: Icons.check_circle,
                    label: 'Available Today',
                    theme: theme,
                    isGreen: true,
                  ),
              ],
            ),
            const SizedBox(height: 16),

            // Bio
            if (bio.isNotEmpty) ...[
              Text(
                'About',
                style: theme.textTheme.titleSmall?.copyWith(
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 6),
              Text(bio, style: theme.textTheme.bodyMedium),
              const SizedBox(height: 16),
            ],

            // Education
            if (education.isNotEmpty) ...[
              Text(
                'Education',
                style: theme.textTheme.titleSmall?.copyWith(
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 6),
              Text(education, style: theme.textTheme.bodyMedium),
              const SizedBox(height: 16),
            ],

            // Qualifications
            if (qualifications.isNotEmpty) ...[
              Text(
                'Qualifications',
                style: theme.textTheme.titleSmall?.copyWith(
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 6),
              Wrap(
                spacing: 6,
                runSpacing: 6,
                children: qualifications
                    .map(
                      (q) => Chip(
                        label: Text(
                          q.toString(),
                          style: const TextStyle(fontSize: 12),
                        ),
                        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        visualDensity: VisualDensity.compact,
                        backgroundColor: cs.secondaryContainer,
                        labelStyle: TextStyle(color: cs.onSecondaryContainer),
                      ),
                    )
                    .toList(),
              ),
              const SizedBox(height: 16),
            ],

            // Schedule
            if (availDays.isNotEmpty) ...[
              Text(
                'Schedule',
                style: theme.textTheme.titleSmall?.copyWith(
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 6),
              ...availDays.map((day) {
                final dayStr = day.toString();
                final h = availHours[dayStr] as Map<String, dynamic>?;
                final timeStr = h != null ? '${h['start']} – ${h['end']}' : '';
                final isToday = dayStr == _todayName;
                return Padding(
                  padding: const EdgeInsets.symmetric(vertical: 2),
                  child: Row(
                    children: [
                      SizedBox(
                        width: 90,
                        child: Text(
                          dayStr,
                          style: theme.textTheme.bodySmall?.copyWith(
                            fontWeight: isToday
                                ? FontWeight.bold
                                : FontWeight.normal,
                            color: isToday ? cs.primary : cs.onSurface,
                          ),
                        ),
                      ),
                      Text(
                        timeStr,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: isToday ? cs.primary : cs.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                );
              }),
              const SizedBox(height: 16),
            ],

            // Consultation fee
            if (fee != null)
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: cs.primaryContainer.withAlpha(51),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(
                      loc.departmentsConsultationFee,
                      style: theme.textTheme.bodyMedium,
                    ),
                    Text(
                      '₹$fee',
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.bold,
                        color: cs.primary,
                      ),
                    ),
                  ],
                ),
              ),
            const SizedBox(height: 20),

            // Book button
            SizedBox(
              width: double.infinity,
              child: ElevatedButton.icon(
                onPressed: onBook,
                icon: const Icon(Icons.calendar_today),
                label: Text(loc.departmentsBook),
                style: ElevatedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _StatChip extends StatelessWidget {
  final IconData icon;
  final String label;
  final ThemeData theme;
  final bool isGreen;

  const _StatChip({
    required this.icon,
    required this.label,
    required this.theme,
    this.isGreen = false,
  });

  @override
  Widget build(BuildContext context) {
    final color = isGreen ? Colors.green : theme.colorScheme.primary;
    return Container(
      margin: const EdgeInsets.only(right: 8),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: color.withAlpha(20),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14, color: color),
          const SizedBox(width: 4),
          Text(
            label,
            style: TextStyle(
              fontSize: 12,
              color: color,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}
