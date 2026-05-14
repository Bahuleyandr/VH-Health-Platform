// Shown when a department/doctor search yields no matches. Extracted from
// departments_screen.dart unchanged.
import 'package:flutter/material.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class DepartmentsEmptyState extends StatelessWidget {
  final AppLocalizations loc;
  final ColorScheme colorScheme;
  final ThemeData theme;

  const DepartmentsEmptyState({
    super.key,
    required this.loc,
    required this.colorScheme,
    required this.theme,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.list_alt_outlined,
              size: 60,
              color: colorScheme.onSurface.withAlpha(127),
            ),
            const SizedBox(height: 16),
            Text(
              loc.departmentsNoneFound,
              textAlign: TextAlign.center,
              style: theme.textTheme.titleMedium?.copyWith(
                color: colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
