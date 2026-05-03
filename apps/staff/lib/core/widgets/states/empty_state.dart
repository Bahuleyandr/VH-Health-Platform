import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';

/// Centered "nothing here yet" placeholder used by every list screen.
///
/// Drop-in replacement for the half-dozen ad-hoc `Center(child: Text(...))`
/// empty states scattered across the staff app. Pass an [icon] for the
/// big illustration glyph, a short [title], an optional [body] line, and
/// an optional [action] button (e.g. "Create your first…", "Refresh").
///
/// Example:
/// ```
/// const EmptyState(
///   icon: Icons.notifications_off_outlined,
///   title: 'No notifications yet',
///   body: 'You\'ll see system + workflow alerts here.',
/// )
/// ```
class EmptyState extends StatelessWidget {
  final IconData icon;
  final String title;
  final String? body;
  final Widget? action;
  const EmptyState({
    super.key,
    required this.icon,
    required this.title,
    this.body,
    this.action,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 72,
              height: 72,
              decoration: BoxDecoration(
                color: AppTheme.primaryBlue.withValues(alpha: 0.08),
                shape: BoxShape.circle,
              ),
              child: Icon(icon, size: 36, color: AppTheme.primaryBlue),
            ),
            const SizedBox(height: 16),
            Text(
              title,
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w600,
                color: AppTheme.textPrimary,
              ),
            ),
            if ((body ?? '').isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(
                body!,
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 13,
                  color: AppTheme.textSecondary,
                  height: 1.4,
                ),
              ),
            ],
            if (action != null) ...[const SizedBox(height: 16), action!],
          ],
        ),
      ),
    );
  }
}
