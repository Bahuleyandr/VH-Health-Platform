// A single doctor row inside a department's ExpansionTile. Extracted from
// departments_screen.dart unchanged.
import 'package:flutter/material.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class DoctorCard extends StatelessWidget {
  final Map<String, dynamic> doctor;
  final String deptName;
  final ThemeData theme;
  final AppLocalizations loc;
  final bool isAvailableToday;
  final VoidCallback onTap;
  final VoidCallback onBook;

  const DoctorCard({
    super.key,
    required this.doctor,
    required this.deptName,
    required this.theme,
    required this.loc,
    required this.isAvailableToday,
    required this.onTap,
    required this.onBook,
  });

  @override
  Widget build(BuildContext context) {
    final cs = theme.colorScheme;
    final docName = (doctor['name'] ?? loc.departmentsDoctor).toString();
    final specialization = (doctor['specialization'] ?? '').toString();
    final exp = doctor['experience_years'];
    final fee = doctor['consultation_fee'];
    final qualifications = doctor['qualifications'] as List<dynamic>? ?? [];

    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Avatar
            CircleAvatar(
              radius: 24,
              backgroundColor: cs.secondaryContainer,
              foregroundColor: cs.onSecondaryContainer,
              child: const Icon(Icons.person_outline, size: 24),
            ),
            const SizedBox(width: 12),
            // Info
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Name + availability badge
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          docName,
                          style: theme.textTheme.titleSmall?.copyWith(
                            fontWeight: FontWeight.w600,
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      if (isAvailableToday) ...[
                        const SizedBox(width: 6),
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 6,
                            vertical: 2,
                          ),
                          decoration: BoxDecoration(
                            color: Colors.green.withAlpha(25),
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(
                              color: Colors.green.withAlpha(100),
                            ),
                          ),
                          child: const Text(
                            'Available',
                            style: TextStyle(
                              fontSize: 10,
                              color: Colors.green,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 2),
                  // Specialization
                  if (specialization.isNotEmpty)
                    Text(
                      specialization,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: cs.primary,
                      ),
                    ),
                  const SizedBox(height: 4),
                  // Experience + fee
                  Row(
                    children: [
                      if (exp != null) ...[
                        Icon(
                          Icons.work_outline,
                          size: 12,
                          color: cs.onSurfaceVariant,
                        ),
                        const SizedBox(width: 3),
                        Text(
                          '$exp yrs',
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: cs.onSurfaceVariant,
                            fontSize: 11,
                          ),
                        ),
                        const SizedBox(width: 12),
                      ],
                      if (fee != null) ...[
                        Icon(
                          Icons.currency_rupee,
                          size: 12,
                          color: cs.onSurfaceVariant,
                        ),
                        const SizedBox(width: 2),
                        Text(
                          '₹$fee',
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: cs.onSurfaceVariant,
                            fontSize: 11,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ],
                    ],
                  ),
                  // Qualification chips
                  if (qualifications.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Wrap(
                        spacing: 4,
                        runSpacing: 4,
                        children: qualifications
                            .take(4)
                            .map(
                              (q) => Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 6,
                                  vertical: 2,
                                ),
                                decoration: BoxDecoration(
                                  color: cs.surfaceContainerHighest,
                                  borderRadius: BorderRadius.circular(6),
                                ),
                                child: Text(
                                  q.toString(),
                                  style: TextStyle(
                                    fontSize: 10,
                                    color: cs.onSurfaceVariant,
                                  ),
                                ),
                              ),
                            )
                            .toList(),
                      ),
                    ),
                ],
              ),
            ),
            // Book button
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: SizedBox(
                height: 32,
                child: ElevatedButton(
                  onPressed: onBook,
                  style: ElevatedButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    textStyle: const TextStyle(fontSize: 12),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(8),
                    ),
                  ),
                  child: Text(loc.departmentsBook),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
