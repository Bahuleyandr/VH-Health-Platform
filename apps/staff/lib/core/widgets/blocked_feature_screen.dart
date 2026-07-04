import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../l10n/app_strings.dart';
import '../theme/app_theme.dart';
import 'navigation_back_action.dart';

class BlockedFeatureScreen extends StatelessWidget {
  const BlockedFeatureScreen({
    super.key,
    required this.icon,
    required this.title,
    required this.body,
  });

  factory BlockedFeatureScreen.attendance({Key? key}) {
    return BlockedFeatureScreen(
      key: key,
      icon: Icons.fingerprint,
      title: (strings) => strings.blockedFeatureAttendanceTitle,
      body: (strings) => strings.blockedFeatureAttendanceBody,
    );
  }

  final IconData icon;
  final String Function(AppStrings strings) title;
  final String Function(AppStrings strings) body;

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        title: Text(strings.blockedFeatureTitle),
        leading: const NavigationBackAction(closeOnFallback: true),
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 520),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 72,
                  height: 72,
                  decoration: BoxDecoration(
                    color: AppTheme.primaryBlue.withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(18),
                  ),
                  child: Icon(icon, color: AppTheme.primaryBlue, size: 36),
                ),
                const SizedBox(height: 18),
                Text(
                  title(strings),
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: AppTheme.textPrimary,
                    fontSize: 22,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 10),
                Text(
                  body(strings),
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: AppTheme.textSecondary,
                    fontSize: 14,
                    height: 1.4,
                  ),
                ),
                const SizedBox(height: 22),
                FilledButton.icon(
                  onPressed: () => context.go('/dashboard'),
                  icon: const Icon(Icons.dashboard_outlined),
                  label: Text(strings.blockedFeatureGoHome),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
