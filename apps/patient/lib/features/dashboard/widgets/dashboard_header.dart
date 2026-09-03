import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth/core/providers/theme_provider.dart';
import 'package:vhhealth/core/widgets/logout_button.dart';
import 'package:vhhealth/features/dashboard/widgets/hero_snapshot_row.dart';
import 'package:vhhealth/features/dashboard/widgets/language_menu_button.dart';
import 'package:vhhealth/generated/app_localizations.dart';

/// Greeting header that replaces the default AppBar on the dashboard.
///
/// Shows a time-of-day greeting + user name + avatar bubble on one row,
/// with language, theme, accessibility, and logout actions grouped on
/// the right. Optionally renders a [HeroSnapshotRow] underneath
/// with "about you right now" facts (next appointment, unread count,
/// last vitals).
class DashboardHeader extends StatelessWidget {
  final String name;
  final bool isGuest;
  final int? unreadNotifications;
  final String? nextAppointmentLabel;
  final String? lastVitalsLabel;
  final String? hospitalNumber;
  final VoidCallback? onProfileTap;

  const DashboardHeader({
    super.key,
    required this.name,
    required this.isGuest,
    this.unreadNotifications,
    this.nextAppointmentLabel,
    this.lastVitalsLabel,
    this.hospitalNumber,
    this.onProfileTap,
  });

  String _greetingFor(DateTime now) {
    final h = now.hour;
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  }

  String _initialFor(String n) {
    final trimmed = n.trim();
    if (trimmed.isEmpty) return '?';
    return trimmed.characters.first.toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final l10n = AppLocalizations.of(context)!;
    final themeProvider = context.watch<ThemeProvider>();
    final greeting = _greetingFor(DateTime.now());
    final displayName = isGuest ? 'Guest' : name;
    final hospitalId = (hospitalNumber ?? '').trim();
    final isDark = themeProvider.isDarkMode;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 8, 12),
          child: Row(
            children: [
              // Avatar bubble with a soft outer glow — gives the header
              // a focal point and doubles as the profile entry point.
              Tooltip(
                message: isGuest ? 'Sign in to edit profile' : 'Edit profile',
                child: Material(
                  color: Colors.transparent,
                  shape: const CircleBorder(),
                  child: InkWell(
                    customBorder: const CircleBorder(),
                    onTap: onProfileTap,
                    child: Container(
                      width: 48,
                      height: 48,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        gradient: LinearGradient(
                          begin: Alignment.topLeft,
                          end: Alignment.bottomRight,
                          colors: [
                            cs.primary.withValues(alpha: 0.30),
                            cs.primary.withValues(alpha: 0.10),
                          ],
                        ),
                        border: Border.all(
                          color: cs.primary.withValues(alpha: 0.45),
                          width: 1.2,
                        ),
                        boxShadow: [
                          BoxShadow(
                            color: cs.primary.withValues(alpha: 0.18),
                            blurRadius: 12,
                            spreadRadius: 1,
                          ),
                        ],
                      ),
                      alignment: Alignment.center,
                      child: Text(
                        _initialFor(displayName),
                        style: theme.textTheme.titleMedium?.copyWith(
                          color: cs.primary,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              // Greeting + name stacked.
              Expanded(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '$greeting,',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: cs.onSurface.withValues(alpha: 0.65),
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      displayName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.titleLarge?.copyWith(
                        fontWeight: FontWeight.w700,
                        height: 1.1,
                      ),
                    ),
                    if (!isGuest && hospitalId.isNotEmpty) ...[
                      const SizedBox(height: 3),
                      Text(
                        l10n.dashboardHospitalId(hospitalId),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: cs.onSurface.withValues(alpha: 0.70),
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              const LanguageMenuButton(),
              _HeaderIconButton(
                tooltip: l10n.dashboardToggleTheme,
                icon: isDark
                    ? Icons.light_mode_outlined
                    : Icons.dark_mode_outlined,
                onPressed: () => themeProvider.toggleTheme(),
              ),
              _HeaderIconButton(
                tooltip: l10n.dashboardToggleFontSize,
                icon: Icons.format_size,
                onPressed: () => themeProvider.toggleFontSize(),
              ),
              _HeaderIconButton(
                tooltip: isGuest ? 'Exit guest' : 'Logout',
                icon: Icons.logout,
                foregroundColor: colorsForLogout(cs),
                onPressed: () => LogoutButton.confirmAndLogout(context),
              ),
            ],
          ),
        ),
        // Optional snapshot row under the greeting. Self-hides if all
        // entries are null/empty (so the header collapses cleanly when
        // there's nothing to surface yet).
        if (!isGuest)
          HeroSnapshotRow(
            unreadNotifications: unreadNotifications,
            nextAppointmentLabel: nextAppointmentLabel,
            lastVitalsLabel: lastVitalsLabel,
          ),
      ],
    );
  }
}

Color colorsForLogout(ColorScheme colors) => colors.error;

class _HeaderIconButton extends StatelessWidget {
  final String tooltip;
  final IconData icon;
  final VoidCallback onPressed;
  final Color? foregroundColor;

  const _HeaderIconButton({
    required this.tooltip,
    required this.icon,
    required this.onPressed,
    this.foregroundColor,
  });

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final iconScale = context.watch<ThemeProvider>().iconScale;
    final buttonSize = 40.0 * iconScale;
    final iconSize = 20.0 * iconScale;
    return Tooltip(
      message: tooltip,
      child: IconButton(
        constraints: BoxConstraints.tightFor(
          width: buttonSize,
          height: buttonSize,
        ),
        visualDensity: VisualDensity.compact,
        style: IconButton.styleFrom(
          backgroundColor: colors.surfaceContainerHighest.withValues(
            alpha: 0.55,
          ),
          foregroundColor: foregroundColor ?? colors.onSurfaceVariant,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        ),
        onPressed: onPressed,
        icon: Icon(icon, size: iconSize),
      ),
    );
  }
}
