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
/// with the four quick-actions (theme / accessibility / language / logout)
/// collapsed into a single overflow popup so the top of the screen feels
/// less cluttered. Optionally renders a [HeroSnapshotRow] underneath
/// with "about you right now" facts (next appointment, unread count,
/// last vitals).
class DashboardHeader extends StatelessWidget {
  final String name;
  final bool isGuest;
  final int? unreadNotifications;
  final String? nextAppointmentLabel;
  final String? lastVitalsLabel;

  const DashboardHeader({
    super.key,
    required this.name,
    required this.isGuest,
    this.unreadNotifications,
    this.nextAppointmentLabel,
    this.lastVitalsLabel,
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
    final greeting = _greetingFor(DateTime.now());
    final displayName = isGuest ? 'there' : name;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 8, 12),
          child: Row(
            children: [
              // Avatar bubble with a soft outer glow — gives the header
              // a focal point and makes it feel less institutional.
              Container(
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
                  ],
                ),
              ),
              // Language stays as its own button (it shows a sub-menu of
              // languages, which doesn't fit naturally inside the overflow).
              const LanguageMenuButton(),
              // Theme + accessibility + logout collapsed into one overflow.
              _DashboardOverflowMenu(),
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

class _DashboardOverflowMenu extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<String>(
      tooltip: 'More',
      icon: const Icon(Icons.more_vert),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      onSelected: (value) async {
        switch (value) {
          case 'theme':
            Provider.of<ThemeProvider>(context, listen: false).toggleTheme();
            break;
          case 'a11y':
            Provider.of<ThemeProvider>(context, listen: false).toggleFontSize();
            break;
          case 'logout':
            await LogoutButton.confirmAndLogout(context);
            break;
        }
      },
      itemBuilder: (ctx) => [
        PopupMenuItem<String>(
          value: 'theme',
          child: ListTile(
            dense: true,
            leading: const Icon(Icons.brightness_6),
            title: Text(AppLocalizations.of(ctx)!.dashboardToggleTheme),
          ),
        ),
        PopupMenuItem<String>(
          value: 'a11y',
          child: ListTile(
            dense: true,
            leading: const Icon(Icons.accessibility),
            title: Text(AppLocalizations.of(ctx)!.dashboardToggleFontSize),
          ),
        ),
        const PopupMenuDivider(),
        const PopupMenuItem<String>(
          value: 'logout',
          child: ListTile(
            dense: true,
            leading: Icon(Icons.logout, color: Colors.red),
            title: Text('Logout', style: TextStyle(color: Colors.red)),
          ),
        ),
      ],
    );
  }
}
