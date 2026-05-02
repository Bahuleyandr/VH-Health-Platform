import 'dart:ui' show PlatformDispatcher;

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../theme/app_theme.dart';

/// Theme mode controller. Persists the chosen mode to SharedPreferences
/// and (critically) keeps the static `AppTheme.brightness` flag in sync
/// so the adaptive `AppTheme.backgroundGrey` / `cardSurface` /
/// `textPrimary` / `textSecondary` / `divider` getters resolve to the
/// right palette across the 273 call sites that hard-reference them.
class ThemeProvider extends ChangeNotifier {
  static const _key = 'theme_mode';

  ThemeMode _themeMode = ThemeMode.system;
  ThemeMode get themeMode => _themeMode;

  ThemeData get lightTheme => AppTheme.lightTheme;
  ThemeData get darkTheme => AppTheme.darkTheme;

  ThemeProvider() {
    _syncBrightness();
    _loadFromPrefs();
    // Listen for OS-level brightness changes when in system mode (e.g.
    // user toggles Windows / macOS / Android from light to dark while
    // the app is running).
    PlatformDispatcher.instance.onPlatformBrightnessChanged = () {
      if (_themeMode == ThemeMode.system) {
        _syncBrightness();
        notifyListeners();
      }
    };
  }

  Future<void> _loadFromPrefs() async {
    final prefs = await SharedPreferences.getInstance();
    final value = prefs.getString(_key);
    if (value != null) {
      _themeMode = _themeModeFromString(value);
      _syncBrightness();
      notifyListeners();
    }
  }

  Future<void> setThemeMode(ThemeMode mode) async {
    if (_themeMode == mode) return;
    _themeMode = mode;
    _syncBrightness();
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_key, _themeModeToString(mode));
  }

  void toggleTheme() {
    switch (_themeMode) {
      case ThemeMode.system:
        setThemeMode(ThemeMode.light);
      case ThemeMode.light:
        setThemeMode(ThemeMode.dark);
      case ThemeMode.dark:
        setThemeMode(ThemeMode.system);
    }
  }

  /// Resolve the effective brightness for the current ThemeMode + OS,
  /// and write it to the static `AppTheme.brightness` flag so the
  /// adaptive colour getters return the matching palette on the next
  /// `build()` pass.
  void _syncBrightness() {
    AppTheme.brightness = switch (_themeMode) {
      ThemeMode.light => Brightness.light,
      ThemeMode.dark => Brightness.dark,
      ThemeMode.system => PlatformDispatcher.instance.platformBrightness,
    };
  }

  static ThemeMode _themeModeFromString(String value) {
    switch (value) {
      case 'light':
        return ThemeMode.light;
      case 'dark':
        return ThemeMode.dark;
      default:
        return ThemeMode.system;
    }
  }

  static String _themeModeToString(ThemeMode mode) {
    switch (mode) {
      case ThemeMode.light:
        return 'light';
      case ThemeMode.dark:
        return 'dark';
      case ThemeMode.system:
        return 'system';
    }
  }
}
