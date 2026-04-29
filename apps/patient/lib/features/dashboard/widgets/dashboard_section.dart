import 'package:flutter/material.dart';

/// A dashboard section is a label + a tinted card container around its
/// children. The tint subtly identifies the section ("today" is amber,
/// "wellness" is mint, "explore" is cyan, etc.) so the page reads as
/// distinct zones rather than a flat stack of widgets.
///
/// Pair with [DashboardSectionLabel] for the inline label above each
/// section's content; or use [DashboardSection] directly when the
/// label is rendered separately (e.g. when the section's children
/// supply their own headers).
class DashboardSection extends StatelessWidget {
  final String label;
  final Color accent;
  final Widget child;

  /// When true (default), wraps the [child] in a tinted glass card.
  /// Set to false for sections whose children render their own card
  /// chrome (e.g. the FeatureGrid which has per-card backgrounds).
  final bool tinted;

  /// Extra padding around the child inside the tinted container.
  final EdgeInsetsGeometry contentPadding;

  const DashboardSection({
    super.key,
    required this.label,
    required this.accent,
    required this.child,
    this.tinted = true,
    this.contentPadding = const EdgeInsets.fromLTRB(12, 12, 12, 12),
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
            child: Row(
              children: [
                Container(
                  width: 4,
                  height: 16,
                  decoration: BoxDecoration(
                    color: accent,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  label.toUpperCase(),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: cs.onSurface.withValues(alpha: 0.7),
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1.2,
                  ),
                ),
              ],
            ),
          ),
          if (tinted)
            Container(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [
                    // Light mode needs heavier fills (0.30 → 0.10);
                    // dark mode stays subtle (0.10 → 0.03).
                    accent.withValues(
                      alpha: theme.brightness == Brightness.light ? 0.30 : 0.10,
                    ),
                    accent.withValues(
                      alpha: theme.brightness == Brightness.light ? 0.10 : 0.03,
                    ),
                  ],
                ),
                border: Border.all(
                  color: accent.withValues(
                    alpha: theme.brightness == Brightness.light ? 0.50 : 0.25,
                  ),
                  width: 1.2,
                ),
                borderRadius: BorderRadius.circular(20),
                boxShadow: [
                  BoxShadow(
                    color: accent.withValues(
                      alpha: theme.brightness == Brightness.light ? 0.15 : 0.05,
                    ),
                    blurRadius: 14,
                    offset: const Offset(0, 4),
                  ),
                ],
              ),
              padding: contentPadding,
              child: child,
            )
          else
            child,
        ],
      ),
    );
  }
}

/// Per-section accent palette. Centralised so the dashboard sections
/// pick consistent tints rather than each call site choosing its own.
class DashboardAccents {
  static const Color today = Color(0xFFFFB74D); // amber
  static const Color wellness = Color(0xFF4DD0E1); // cyan/teal
  static const Color updates = Color(0xFFBA68C8); // soft purple
  static const Color quickActions = Color(0xFFA8E6CF); // mint
  static const Color explore = Color(0xFF81D4FA); // light blue
  static const Color appointments = Color(0xFFB39DDB); // lavender
}
