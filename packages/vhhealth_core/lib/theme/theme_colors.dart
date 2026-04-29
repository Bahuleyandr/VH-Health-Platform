// lib/theme/theme_colors.dart
import 'package:flutter/material.dart';

class ThemeColors {
  static Color getSuccessColor(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return isDark ? Colors.green.shade400 : Colors.green.shade600;
  }

  static Color getInfoColor(BuildContext context) {
    return Theme.of(context).colorScheme.primary;
  }

  static Color getWarningColor(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return isDark ? Colors.orange.shade400 : Colors.orange.shade700;
  }

  static double getShadowOpacity(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return isDark ? 0.3 : 0.2;
  }

  static double getOverlayOpacity(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return isDark ? 0.05 : 0.1;
  }

  static double getContainerOpacity(
    BuildContext context, {
    bool isProminent = false,
  }) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    if (isProminent) {
      return isDark ? 0.15 : 0.25;
    }
    return isDark ? 0.08 : 0.12;
  }

  static Color getErrorColor(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return isDark ? Colors.red.shade400 : Colors.red.shade600;
  }

  static BoxShadow getCardShadow(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return BoxShadow(
      color: isDark
          ? Colors.black.withValues(alpha: 0.3)
          : Colors.grey.withValues(alpha: 0.2),
      blurRadius: isDark ? 8 : 10,
      offset: const Offset(0, 2),
    );
  }
}
