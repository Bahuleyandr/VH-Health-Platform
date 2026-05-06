import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../providers/theme_provider.dart';

/// AppBar action that switches directly between light and dark mode.
class ThemeToggleAction extends StatelessWidget {
  const ThemeToggleAction({super.key});

  @override
  Widget build(BuildContext context) {
    return Consumer<ThemeProvider>(
      builder: (context, themeProvider, _) {
        final isDark = Theme.of(context).brightness == Brightness.dark;
        final nextMode = isDark ? ThemeMode.light : ThemeMode.dark;
        final tooltip = isDark ? 'Switch to light mode' : 'Switch to dark mode';

        return IconButton(
          icon: Icon(
            isDark ? Icons.light_mode_outlined : Icons.dark_mode_outlined,
          ),
          tooltip: tooltip,
          onPressed: () {
            unawaited(themeProvider.setThemeMode(nextMode));
          },
        );
      },
    );
  }
}
