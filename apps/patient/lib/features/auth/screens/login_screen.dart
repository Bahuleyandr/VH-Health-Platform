import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth/core/widgets/logo_background.dart';
import 'package:vhhealth/features/auth/widgets/login_form.dart';
import 'package:vhhealth/core/widgets/language_dropdown.dart';
import 'package:vhhealth/core/providers/theme_provider.dart';

class LoginScreen extends StatefulWidget {
  final String? returnTo;

  const LoginScreen({super.key, this.returnTo});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: LogoBackground(
        child: SafeArea(
          child: Stack(
            children: [
              LoginForm(returnTo: widget.returnTo),
              // ── Top-right theme + language controls ──
              Positioned(top: 8, right: 8, child: const _LoginToolbar()),
            ],
          ),
        ),
      ),
    );
  }
}

class _LoginToolbar extends StatelessWidget {
  const _LoginToolbar();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final themeProvider = context.watch<ThemeProvider>();
    final isDark = themeProvider.isDarkMode;

    Widget themeButton({
      required IconData icon,
      required String tooltip,
      required bool selected,
      required VoidCallback onPressed,
    }) {
      return Tooltip(
        message: tooltip,
        child: IconButton(
          constraints: const BoxConstraints.tightFor(width: 40, height: 40),
          visualDensity: VisualDensity.compact,
          style: IconButton.styleFrom(
            backgroundColor: selected
                ? colors.primaryContainer
                : Colors.transparent,
            foregroundColor: selected
                ? colors.onPrimaryContainer
                : colors.onSurfaceVariant,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(8),
            ),
          ),
          onPressed: onPressed,
          icon: Icon(icon, size: 20),
        ),
      );
    }

    return Material(
      color: colors.surface.withValues(alpha: 0.92),
      elevation: 3,
      shadowColor: colors.shadow.withValues(alpha: 0.15),
      borderRadius: BorderRadius.circular(8),
      child: Padding(
        padding: const EdgeInsets.all(4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            themeButton(
              icon: Icons.light_mode_outlined,
              tooltip: 'Light mode',
              selected: !isDark,
              onPressed: () =>
                  context.read<ThemeProvider>().setThemeMode(ThemeMode.light),
            ),
            themeButton(
              icon: Icons.dark_mode_outlined,
              tooltip: 'Dark mode',
              selected: isDark,
              onPressed: () =>
                  context.read<ThemeProvider>().setThemeMode(ThemeMode.dark),
            ),
            const SizedBox(width: 2),
            PopupMenuButton<int>(
              icon: Icon(Icons.language, color: colors.onSurfaceVariant),
              tooltip: 'Change Language',
              offset: const Offset(0, 40),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(8),
              ),
              itemBuilder: (_) => [
                const PopupMenuItem<int>(
                  value: 0,
                  enabled: false,
                  child: SizedBox(width: 160, child: LanguageDropdown()),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
