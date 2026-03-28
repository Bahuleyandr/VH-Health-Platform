// test/core/providers/theme_provider_test.dart
//
// Unit tests for ThemeProvider — theme mode switching, font size persistence,
// accent color changes, and reset behavior.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth/core/providers/theme_provider.dart';

void main() {
  // Ensure Flutter bindings are initialized for SharedPreferences.
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    // Start each test with empty SharedPreferences.
    SharedPreferences.setMockInitialValues({});
  });

  group('ThemeProvider — default state', () {
    test('initial themeMode is system', () {
      final provider = ThemeProvider();
      expect(provider.themeMode, ThemeMode.system);
    });

    test('initial fontSize is 16.0', () {
      final provider = ThemeProvider();
      expect(provider.fontSize, 16.0);
    });

    test('initial dynamicAccentColor is null', () {
      final provider = ThemeProvider();
      expect(provider.dynamicAccentColor, isNull);
    });

    test('initial enableDynamicColors is true', () {
      final provider = ThemeProvider();
      expect(provider.enableDynamicColors, isTrue);
    });
  });

  group('ThemeProvider — theme mode switching', () {
    test('setThemeMode to dark updates themeMode', () async {
      final provider = ThemeProvider();

      await provider.setThemeMode(ThemeMode.dark);

      expect(provider.themeMode, ThemeMode.dark);
    });

    test('setThemeMode to light updates themeMode', () async {
      final provider = ThemeProvider();

      await provider.setThemeMode(ThemeMode.light);

      expect(provider.themeMode, ThemeMode.light);
    });

    test('setThemeMode to system updates themeMode', () async {
      final provider = ThemeProvider();

      await provider.setThemeMode(ThemeMode.dark);
      await provider.setThemeMode(ThemeMode.system);

      expect(provider.themeMode, ThemeMode.system);
    });

    test('setThemeMode persists to SharedPreferences', () async {
      final provider = ThemeProvider();
      await provider.setThemeMode(ThemeMode.dark);

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('theme_mode'), 'dark');
    });

    test('setThemeMode to light persists "light"', () async {
      final provider = ThemeProvider();
      await provider.setThemeMode(ThemeMode.light);

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('theme_mode'), 'light');
    });

    test('setThemeMode to system persists "system"', () async {
      final provider = ThemeProvider();
      await provider.setThemeMode(ThemeMode.system);

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('theme_mode'), 'system');
    });

    test('setting same themeMode does not notify', () async {
      final provider = ThemeProvider();
      // Default is system, setting system again should be a no-op.
      int notifyCount = 0;
      provider.addListener(() => notifyCount++);

      await provider.setThemeMode(ThemeMode.system);

      expect(notifyCount, 0);
    });
  });

  group('ThemeProvider — font size', () {
    test('setFontSize updates fontSize', () async {
      final provider = ThemeProvider();

      await provider.setFontSize(20.0);

      expect(provider.fontSize, 20.0);
    });

    test('setFontSize persists to SharedPreferences', () async {
      final provider = ThemeProvider();
      await provider.setFontSize(18.0);

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getDouble('font_size'), 18.0);
    });

    test('setting same fontSize does not notify', () async {
      final provider = ThemeProvider();
      int notifyCount = 0;
      provider.addListener(() => notifyCount++);

      await provider.setFontSize(16.0); // same as default

      expect(notifyCount, 0);
    });

    test('toggleFontSize cycles through 16 -> 18 -> 20 -> 16', () async {
      final provider = ThemeProvider();

      expect(provider.fontSize, 16.0);

      provider.toggleFontSize();
      await Future.delayed(Duration.zero); // let async complete
      expect(provider.fontSize, 18.0);

      provider.toggleFontSize();
      await Future.delayed(Duration.zero);
      expect(provider.fontSize, 20.0);

      provider.toggleFontSize();
      await Future.delayed(Duration.zero);
      expect(provider.fontSize, 16.0);
    });
  });

  group('ThemeProvider — accent color', () {
    test('setDynamicAccentColor updates the color', () async {
      final provider = ThemeProvider();
      const color = Color(0xFF42A5F5);

      await provider.setDynamicAccentColor(color);

      expect(provider.dynamicAccentColor, color);
    });

    test('setDynamicAccentColor to null clears the color', () async {
      final provider = ThemeProvider();
      await provider.setDynamicAccentColor(const Color(0xFF42A5F5));

      await provider.setDynamicAccentColor(null);

      expect(provider.dynamicAccentColor, isNull);
    });

    test('setDynamicAccentColor persists to SharedPreferences', () async {
      final provider = ThemeProvider();
      const color = Color(0xFF42A5F5);

      await provider.setDynamicAccentColor(color);

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getInt('accent_color'), color.value);
    });

    test('setDynamicAccentColor null removes from SharedPreferences', () async {
      final provider = ThemeProvider();
      await provider.setDynamicAccentColor(const Color(0xFF42A5F5));
      await provider.setDynamicAccentColor(null);

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getInt('accent_color'), isNull);
    });

    test('setting same color does not notify', () async {
      final provider = ThemeProvider();
      const color = Color(0xFF42A5F5);
      await provider.setDynamicAccentColor(color);

      int notifyCount = 0;
      provider.addListener(() => notifyCount++);

      await provider.setDynamicAccentColor(color);

      expect(notifyCount, 0);
    });
  });

  group('ThemeProvider — enableDynamicColors', () {
    test('setEnableDynamicColors updates the flag', () async {
      final provider = ThemeProvider();

      await provider.setEnableDynamicColors(false);

      expect(provider.enableDynamicColors, isFalse);
    });

    test('toggleDynamicColors flips the flag', () async {
      final provider = ThemeProvider();
      expect(provider.enableDynamicColors, isTrue);

      provider.toggleDynamicColors();
      await Future.delayed(Duration.zero);

      expect(provider.enableDynamicColors, isFalse);
    });

    test('setEnableDynamicColors persists to SharedPreferences', () async {
      final provider = ThemeProvider();
      await provider.setEnableDynamicColors(false);

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getBool('enable_dynamic_colors'), isFalse);
    });
  });

  group('ThemeProvider — updateAccentFromDial', () {
    test('updates accent when dynamic colors are enabled', () async {
      final provider = ThemeProvider();
      const color = Color(0xFFFF5722);

      provider.updateAccentFromDial(color);
      await Future.delayed(Duration.zero);

      expect(provider.dynamicAccentColor, color);
    });

    test('does not update accent when dynamic colors are disabled', () async {
      final provider = ThemeProvider();
      await provider.setEnableDynamicColors(false);

      provider.updateAccentFromDial(const Color(0xFFFF5722));
      await Future.delayed(Duration.zero);

      expect(provider.dynamicAccentColor, isNull);
    });
  });

  group('ThemeProvider — resetToDefaults', () {
    test('resets all settings to defaults', () async {
      final provider = ThemeProvider();

      // Change everything
      await provider.setThemeMode(ThemeMode.dark);
      await provider.setFontSize(20.0);
      await provider.setDynamicAccentColor(const Color(0xFFFF5722));
      await provider.setEnableDynamicColors(false);

      // Reset
      await provider.resetToDefaults();

      expect(provider.themeMode, ThemeMode.system);
      expect(provider.fontSize, 16.0);
      expect(provider.dynamicAccentColor, isNull);
      expect(provider.enableDynamicColors, isTrue);
    });
  });

  group('ThemeProvider — loads from SharedPreferences', () {
    test('loads persisted dark theme mode', () async {
      SharedPreferences.setMockInitialValues({
        'theme_mode': 'dark',
        'font_size': 20.0,
        'enable_dynamic_colors': false,
      });

      final provider = ThemeProvider();
      // Wait for _loadPreferences to complete.
      await Future.delayed(const Duration(milliseconds: 50));

      expect(provider.themeMode, ThemeMode.dark);
      expect(provider.fontSize, 20.0);
      expect(provider.enableDynamicColors, isFalse);
    });

    test('loads persisted light theme mode', () async {
      SharedPreferences.setMockInitialValues({
        'theme_mode': 'light',
      });

      final provider = ThemeProvider();
      await Future.delayed(const Duration(milliseconds: 50));

      expect(provider.themeMode, ThemeMode.light);
    });

    test('loads persisted accent color', () async {
      const color = Color(0xFF42A5F5);
      SharedPreferences.setMockInitialValues({
        'accent_color': color.value,
      });

      final provider = ThemeProvider();
      await Future.delayed(const Duration(milliseconds: 50));

      expect(provider.dynamicAccentColor, color);
    });

    test('defaults to system when no prefs stored', () async {
      SharedPreferences.setMockInitialValues({});

      final provider = ThemeProvider();
      await Future.delayed(const Duration(milliseconds: 50));

      expect(provider.themeMode, ThemeMode.system);
      expect(provider.fontSize, 16.0);
      expect(provider.enableDynamicColors, isTrue);
      expect(provider.dynamicAccentColor, isNull);
    });
  });

  group('ThemeProvider — theme data', () {
    test('lightTheme returns a ThemeData', () {
      final provider = ThemeProvider();
      expect(provider.lightTheme, isA<ThemeData>());
    });

    test('darkTheme returns a ThemeData', () {
      final provider = ThemeProvider();
      expect(provider.darkTheme, isA<ThemeData>());
    });
  });
}
