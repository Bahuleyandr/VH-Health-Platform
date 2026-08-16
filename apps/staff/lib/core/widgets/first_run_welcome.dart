import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../l10n/app_strings.dart';
import '../theme/app_theme.dart';

/// One-time welcome card shown above the dashboard tile grid that
/// orients new staff to the four shortcuts they wouldn't otherwise
/// discover:
///
///   - tap a bed card → patient + admission details
///   - long-press a bed → quick edit notes
///   - magnifier in any AppBar → find any patient
///   - Ctrl+K (Cmd+K on macOS) → find any patient
///
/// Dismissed via the "Got it" button which writes a `welcome_dismissed`
/// flag to SharedPreferences. Subsequent runs render an empty SizedBox.
///
/// Per-version revival: bumping [_FLAG_VERSION] makes the welcome show
/// once again after a release that meaningfully changes the dashboard
/// — used sparingly so it doesn't become noise.
class FirstRunWelcome extends StatefulWidget {
  const FirstRunWelcome({super.key});

  @override
  State<FirstRunWelcome> createState() => _FirstRunWelcomeState();
}

class _FirstRunWelcomeState extends State<FirstRunWelcome> {
  static const _flagKey = 'welcome_dismissed_v1';
  bool _checked = false;
  bool _show = false;

  @override
  void initState() {
    super.initState();
    _check();
  }

  Future<void> _check() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final dismissed = prefs.getBool(_flagKey) ?? false;
      if (!mounted) return;
      setState(() {
        _show = !dismissed;
        _checked = true;
      });
    } catch (_) {
      if (mounted) setState(() => _checked = true);
    }
  }

  Future<void> _dismiss() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool(_flagKey, true);
    } catch (_) {}
    if (mounted) setState(() => _show = false);
  }

  @override
  Widget build(BuildContext context) {
    if (!_checked || !_show) return const SizedBox.shrink();
    final isMac = !kIsWeb && Platform.isMacOS;
    final modKey = isMac ? '⌘' : 'Ctrl';
    final s = AppStrings.of(context);

    return Card(
      margin: const EdgeInsets.only(bottom: 16),
      color: AppTheme.primaryBlue.withValues(alpha: 0.06),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: AppTheme.primaryBlue.withValues(alpha: 0.3)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(
                  Icons.tips_and_updates_outlined,
                  color: AppTheme.primaryBlue,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    s.firstRunWelcomeTitle,
                    style: const TextStyle(
                      fontWeight: FontWeight.bold,
                      color: AppTheme.primaryBlue,
                      fontSize: 15,
                    ),
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.close, size: 18),
                  tooltip: s.firstRunWelcomeDismiss,
                  onPressed: _dismiss,
                  visualDensity: VisualDensity.compact,
                ),
              ],
            ),
            const SizedBox(height: 6),
            _Tip(icon: Icons.touch_app_outlined, text: s.firstRunTipBedTap),
            _Tip(
              icon: Icons.edit_note_outlined,
              text: s.firstRunTipBedLongPress,
            ),
            _Tip(
              icon: Icons.person_search_outlined,
              text: s.firstRunTipMagnifier(modKey),
            ),
            _Tip(icon: Icons.dashboard_outlined, text: s.firstRunTipDashboard),
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton(
                onPressed: _dismiss,
                child: Text(s.firstRunWelcomeGotIt),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Tip extends StatelessWidget {
  final IconData icon;
  final String text;
  const _Tip({required this.icon, required this.text});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 18, color: AppTheme.primaryBlue),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              text,
              style: TextStyle(fontSize: 13, color: AppTheme.textPrimary),
            ),
          ),
        ],
      ),
    );
  }
}
