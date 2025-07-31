import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:provider/provider.dart';

import 'package:vhhealth/core/theme/app_theme.dart';

class ThemeProvider extends ChangeNotifier {
  ThemeMode _themeMode = ThemeMode.system;
  double _fontSize = 16.0;

  static const String _themeModeKey = 'theme_mode';
  static const String _fontSizeKey = 'font_size';

  ThemeProvider() {
    _loadPreferences();
  }

  // --- Getters ---
  ThemeMode get themeMode => _themeMode;
  double get fontSize => _fontSize;

  ThemeData get lightTheme => AppTheme.getLightTheme(_fontSize);
  ThemeData get darkTheme => AppTheme.getDarkTheme(_fontSize);

  bool get isDarkMode {
    if (_themeMode == ThemeMode.system) {
      final brightness = SchedulerBinding.instance.platformDispatcher.platformBrightness;
      return brightness == Brightness.dark;
    }
    return _themeMode == ThemeMode.dark;
  }

  // --- Load preferences on startup ---
  Future<void> _loadPreferences() async {
    final prefs = await SharedPreferences.getInstance();
    final themeString = prefs.getString(_themeModeKey) ?? 'system';
    final storedFontSize = prefs.getDouble(_fontSizeKey) ?? 16.0;

    _themeMode = _stringToThemeMode(themeString);
    _fontSize = storedFontSize;
    notifyListeners();
  }

  // --- Setters ---
  Future<void> setThemeMode(ThemeMode mode) async {
    if (_themeMode == mode) return;
    _themeMode = mode;
    notifyListeners();

    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_themeModeKey, _themeModeToString(mode));
  }

  Future<void> setFontSize(double size) async {
    if (_fontSize == size) return;
    _fontSize = size;
    notifyListeners();

    final prefs = await SharedPreferences.getInstance();
    await prefs.setDouble(_fontSizeKey, size);
  }

  // --- Toggles ---
  void toggleTheme() {
    final isCurrentlyDark = isDarkMode;
    setThemeMode(isCurrentlyDark ? ThemeMode.light : ThemeMode.dark);
  }

  void toggleFontSize() async {
    const List<double> sizes = [16.0, 18.0, 20.0];
    final currentIndex = sizes.indexOf(_fontSize);
    final nextIndex = (currentIndex != -1 ? currentIndex + 1 : 1) % sizes.length;
    await setFontSize(sizes[nextIndex]);
  }

  // --- Helpers ---
  ThemeMode _stringToThemeMode(String value) {
    switch (value.toLowerCase()) {
      case 'dark':
        return ThemeMode.dark;
      case 'light':
        return ThemeMode.light;
      default:
        return ThemeMode.system;
    }
  }

  String _themeModeToString(ThemeMode mode) {
    switch (mode) {
      case ThemeMode.dark:
        return 'dark';
      case ThemeMode.light:
        return 'light';
      default:
        return 'system';
    }
  }

  // --- Access from anywhere (used in SettingsController) ---
  static ThemeProvider of(BuildContext context) =>
      context.read<ThemeProvider>();
}
