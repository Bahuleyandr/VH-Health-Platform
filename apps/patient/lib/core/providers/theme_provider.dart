import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:provider/provider.dart';

import 'package:vhhealth/core/theme/app_theme.dart';

class ThemeProvider extends ChangeNotifier {
  ThemeMode _themeMode = ThemeMode.system;
  double _fontSize = 16.0;
  Color? _dynamicAccentColor;
  bool _enableDynamicColors = true;

  static const String _themeModeKey = 'theme_mode';
  static const String _fontSizeKey = 'font_size';
  static const String _dynamicColorsKey = 'enable_dynamic_colors';
  static const String _accentColorKey = 'accent_color';

  /// Completes when preferences have been loaded from storage.
  /// All setters await this so they never race with the initial load.
  late final Future<void> _initFuture;

  ThemeProvider() {
    _initFuture = _loadPreferences();
  }

  // --- Getters ---
  ThemeMode get themeMode => _themeMode;
  double get fontSize => _fontSize;
  Color? get dynamicAccentColor => _dynamicAccentColor;
  bool get enableDynamicColors => _enableDynamicColors;

  ThemeData get lightTheme => _buildTheme(Brightness.light);
  ThemeData get darkTheme => _buildTheme(Brightness.dark);

  bool get isDarkMode {
    if (_themeMode == ThemeMode.system) {
      final brightness =
          SchedulerBinding.instance.platformDispatcher.platformBrightness;
      return brightness == Brightness.dark;
    }
    return _themeMode == ThemeMode.dark;
  }

  // --- Build theme with dynamic colors ---
  ThemeData _buildTheme(Brightness brightness) {
    final baseTheme = brightness == Brightness.light
        ? AppTheme.getLightTheme(_fontSize)
        : AppTheme.getDarkTheme(_fontSize);

    if (!_enableDynamicColors || _dynamicAccentColor == null) {
      return baseTheme;
    }

    // Apply dynamic accent color
    return baseTheme.copyWith(
      colorScheme: baseTheme.colorScheme.copyWith(
        primary: _dynamicAccentColor,
        secondary: _dynamicAccentColor,
      ),
      primaryColor: _dynamicAccentColor,
      // Update other color properties as needed
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: baseTheme.elevatedButtonTheme.style?.copyWith(
          backgroundColor: WidgetStateProperty.all(_dynamicAccentColor),
        ),
      ),
      floatingActionButtonTheme: baseTheme.floatingActionButtonTheme.copyWith(
        backgroundColor: _dynamicAccentColor,
      ),
      // Update app bar theme
      appBarTheme: baseTheme.appBarTheme.copyWith(
        backgroundColor: brightness == Brightness.light
            ? _dynamicAccentColor?.withValues(alpha: 0.1)
            : _dynamicAccentColor?.withValues(alpha: 0.05),
        iconTheme: IconThemeData(
          color: brightness == Brightness.light
              ? _dynamicAccentColor
              : _dynamicAccentColor?.withValues(alpha: 0.9),
        ),
      ),
    );
  }

  // --- Load preferences on startup ---
  Future<void> _loadPreferences() async {
    final prefs = await SharedPreferences.getInstance();
    final themeString = prefs.getString(_themeModeKey) ?? 'system';
    final storedFontSize = prefs.getDouble(_fontSizeKey) ?? 16.0;
    final enableDynamic = prefs.getBool(_dynamicColorsKey) ?? true;
    final accentColorValue = prefs.getInt(_accentColorKey);

    _themeMode = _stringToThemeMode(themeString);
    _fontSize = storedFontSize;
    _enableDynamicColors = enableDynamic;
    if (accentColorValue != null) {
      _dynamicAccentColor = Color(accentColorValue);
    }
    // Only notify if any value differs from the compiled-in defaults,
    // so widgets rebuilding on init are updated but test listener counts
    // reflect only explicit setter calls.
    if (_themeMode != ThemeMode.system ||
        _fontSize != 16.0 ||
        !_enableDynamicColors ||
        _dynamicAccentColor != null) {
      notifyListeners();
    }
  }

  // --- Setters ---
  Future<void> setThemeMode(ThemeMode mode) async {
    await _initFuture;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_themeModeKey, _themeModeToString(mode));
    if (_themeMode == mode) return;
    _themeMode = mode;
    notifyListeners();
  }

  Future<void> setFontSize(double size) async {
    await _initFuture;
    if (_fontSize == size) return;
    _fontSize = size;
    notifyListeners();

    final prefs = await SharedPreferences.getInstance();
    await prefs.setDouble(_fontSizeKey, size);
  }

  Future<void> setDynamicAccentColor(Color? color) async {
    await _initFuture;
    final prefs = await SharedPreferences.getInstance();
    if (color != null) {
      await prefs.setInt(_accentColorKey, color.toARGB32());
    } else {
      await prefs.remove(_accentColorKey);
    }
    if (_dynamicAccentColor == color) return;
    _dynamicAccentColor = color;
    notifyListeners();
  }

  Future<void> setEnableDynamicColors(bool enable) async {
    await _initFuture;
    if (_enableDynamicColors == enable) return;
    _enableDynamicColors = enable;
    notifyListeners();

    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_dynamicColorsKey, enable);
  }

  // --- Update from circular dial ---
  void updateAccentFromDial(Color color) {
    if (_enableDynamicColors) {
      setDynamicAccentColor(color);
    }
  }

  // --- Toggles ---
  void toggleTheme() {
    final isCurrentlyDark = isDarkMode;
    setThemeMode(isCurrentlyDark ? ThemeMode.light : ThemeMode.dark);
  }

  void toggleFontSize() async {
    const List<double> sizes = [16.0, 18.0, 20.0];
    final currentIndex = sizes.indexOf(_fontSize);
    final nextIndex =
        (currentIndex != -1 ? currentIndex + 1 : 1) % sizes.length;
    await setFontSize(sizes[nextIndex]);
  }

  void toggleDynamicColors() {
    setEnableDynamicColors(!_enableDynamicColors);
  }

  // --- Reset ---
  Future<void> resetToDefaults() async {
    await setThemeMode(ThemeMode.system);
    await setFontSize(16.0);
    await setDynamicAccentColor(null);
    await setEnableDynamicColors(true);
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

  // --- Access from anywhere ---
  static ThemeProvider of(BuildContext context) =>
      context.read<ThemeProvider>();
}
