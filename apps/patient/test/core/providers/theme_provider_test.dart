// test/core/providers/theme_provider_test.dart
//
// Unit tests for ThemeProvider — theme mode switching, font size persistence,
// accent color changes, and reset behavior.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth/core/providers/theme_provider.dart';

void main() {
  // Ensure Flutter binding is initialized for SharedPreferences.
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    // Start each test with empty preferences so _loadPreferences finds nothing.
    SharedPreferences.setMockInitialValues({});
  });

  group('ThemeProvider — initial defaults', () {
    test('default themeMode is system', () {
      final provider = ThemeProvider();
      expect(provider.themeMode, ThemeMode.system);
    });

    test('default fontSize is 16.0', () {
      final provider = ThemeProvider();
      expect(provider.fontSize, 16.0);
    });

    test('default dynamicAccentColor is null', () {
      final provider = ThemeProvider();
      expect(provider.dynamicAccentColor, isNull);
    });

    test('default enableDynamicColors is true', () {
      final provider = ThemeProvider();
      expect(provider.enableDynamicColors, isTrue);
    });
  });

  group('ThemeProvider — theme mode switching', () {
    test('setThemeMode changes to dark', () async {
      final provider = ThemeProvider();

      await provider.setThemeMode(ThemeMode.dark);

      expect(provider.themeMode, ThemeMode.dark);
    });

    test('setThemeMode changes to light', () async {
      final provider = ThemeProvider();

      await provider.setThemeMode(ThemeMode.light);

      expect(provider.themeMode, ThemeMode.light);
    });

    test('setThemeMode changes to system', () async {
      final provider = ThemeProvider();

      await provider.setThemeMode(ThemeMode.dark);
      await provider.setThemeMode(ThemeMode.system);

      expect(provider.themeMode, ThemeMode.system);
    });

    test('setThemeMode does not notify when value is the same', () async {
      final provider = ThemeProvider();
      await provider.setThemeMode(ThemeMode.dark);

      int notifyCount = 0;
      provider.addListener(() => notifyCount++);

      await provider.setThemeMode(ThemeMode.dark);
      expect(notifyCount, 0);
    });

    test('setThemeMode notifies listeners on change', () async {
      final provider = ThemeProvider();

      int notifyCount = 0;
      provider.addListener(() => notifyCount++);

      await provider.setThemeMode(ThemeMode.dark);
      expect(notifyCount, 1);
    });

    test('setThemeMode persists to SharedPreferences', () async {
      final provider = ThemeProvider();

      await provider.setThemeMode(ThemeMode.dark);

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('theme_mode'), 'dark');
    });

    test('setThemeMode persists light to SharedPreferences', () async {
      final provider = ThemeProvider();

      await provider.setThemeMode(ThemeMode.light);

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('theme_mode'), 'light');
    });

    test('setThemeMode persists system to SharedPreferences', () async {
      final provider = ThemeProvider();

      await provider.setThemeMode(ThemeMode.system);

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('theme_mode'), 'system');
    });
  });

  group('ThemeProvider — font size (scale) persistence', () {
    test('setFontSize changes value', () async {
      final provider = ThemeProvider();

      await provider.setFontSize(20.0);

      expect(provider.fontSize, 20.0);
    });

    test('setFontSize does not notify when value is the same', () async {
      final provider = ThemeProvider();

      int notifyCount = 0;
      provider.addListener(() => notifyCount++);

      // Default is 16.0 — setting the same should not notify.
      await provider.setFontSize(16.0);
      expect(notifyCount, 0);
    });

    test('setFontSize persists to SharedPreferences', () async {
      final provider = ThemeProvider();

      await provider.setFontSize(18.0);

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getDouble('font_size'), 18.0);
    });

    test('toggleFontSize cycles through 16, 18, 20', () async {
      final provider = ThemeProvider();
      expect(provider.fontSize, 16.0);

      provider.toggleFontSize();
      // Allow async persistence to complete.
      await Future<void>.delayed(Duration.zero);
      expect(provider.fontSize, 18.0);

      provider.toggleFontSize();
      await Future<void>.delayed(Duration.zero);
      expect(provider.fontSize, 20.0);

      provider.toggleFontSize();
      await Future<void>.delayed(Duration.zero);
      expect(provider.fontSize, 16.0);
    });
  });

  group('ThemeProvider — accent color changes', () {
    test('setDynamicAccentColor stores a color', () async {
      final provider = ThemeProvider();

      await provider.setDynamicAccentColor(Colors.red);

      expect(provider.dynamicAccentColor, Colors.red);
    });

    test('setDynamicAccentColor with null clears the color', () async {
      final provider = ThemeProvider();

      await provider.setDynamicAccentColor(Colors.red);
      await provider.setDynamicAccentColor(null);

      expect(provider.dynamicAccentColor, isNull);
    });

    test('setDynamicAccentColor does not notify for same value', () async {
      final provider = ThemeProvider();

      await provider.setDynamicAccentColor(Colors.blue);

      int notifyCount = 0;
      provider.addListener(() => notifyCount++);

      await provider.setDynamicAccentColor(Colors.blue);
      expect(notifyCount, 0);
    });

    test('setDynamicAccentColor persists to SharedPreferences', () async {
      final provider = ThemeProvider();

      await provider.setDynamicAccentColor(Colors.blue);

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getInt('accent_color'), Colors.blue.toARGB32());
    });

    test(
      'setDynamicAccentColor(null) removes from SharedPreferences',
      () async {
        final provider = ThemeProvider();

        await provider.setDynamicAccentColor(Colors.blue);
        await provider.setDynamicAccentColor(null);

        final prefs = await SharedPreferences.getInstance();
        expect(prefs.getInt('accent_color'), isNull);
      },
    );

    test(
      'updateAccentFromDial sets color when dynamic colors enabled',
      () async {
        final provider = ThemeProvider();

        provider.updateAccentFromDial(Colors.green);
        await Future<void>.delayed(Duration.zero);

        expect(provider.dynamicAccentColor, Colors.green);
      },
    );

    test(
      'updateAccentFromDial does nothing when dynamic colors disabled',
      () async {
        final provider = ThemeProvider();

        await provider.setEnableDynamicColors(false);
        provider.updateAccentFromDial(Colors.green);
        await Future<void>.delayed(Duration.zero);

        expect(provider.dynamicAccentColor, isNull);
      },
    );
  });

  group('ThemeProvider — enableDynamicColors', () {
    test('setEnableDynamicColors toggles the flag', () async {
      final provider = ThemeProvider();

      await provider.setEnableDynamicColors(false);
      expect(provider.enableDynamicColors, isFalse);

      await provider.setEnableDynamicColors(true);
      expect(provider.enableDynamicColors, isTrue);
    });

    test('toggleDynamicColors flips the flag', () async {
      final provider = ThemeProvider();
      expect(provider.enableDynamicColors, isTrue);

      provider.toggleDynamicColors();
      await Future<void>.delayed(Duration.zero);
      expect(provider.enableDynamicColors, isFalse);

      provider.toggleDynamicColors();
      await Future<void>.delayed(Duration.zero);
      expect(provider.enableDynamicColors, isTrue);
    });
  });

  group('ThemeProvider — resetToDefaults', () {
    test('resets all values to defaults', () async {
      final provider = ThemeProvider();

      // Change everything away from defaults.
      await provider.setThemeMode(ThemeMode.dark);
      await provider.setFontSize(20.0);
      await provider.setDynamicAccentColor(Colors.purple);
      await provider.setEnableDynamicColors(false);

      // Reset.
      await provider.resetToDefaults();

      expect(provider.themeMode, ThemeMode.system);
      expect(provider.fontSize, 16.0);
      expect(provider.dynamicAccentColor, isNull);
      expect(provider.enableDynamicColors, isTrue);
    });
  });

  group('ThemeProvider — theme getters', () {
    test('lightTheme returns a ThemeData', () {
      final provider = ThemeProvider();
      expect(provider.lightTheme, isA<ThemeData>());
    });

    test('darkTheme returns a ThemeData', () {
      final provider = ThemeProvider();
      expect(provider.darkTheme, isA<ThemeData>());
    });
  });

  group('ThemeProvider — loads preferences on creation', () {
    test('loads persisted theme mode on startup', () async {
      SharedPreferences.setMockInitialValues({
        'theme_mode': 'dark',
        'font_size': 20.0,
        'enable_dynamic_colors': false,
      });

      final provider = ThemeProvider();

      // _loadPreferences is async — wait for the microtask to complete.
      await Future<void>.delayed(Duration.zero);

      expect(provider.themeMode, ThemeMode.dark);
      expect(provider.fontSize, 20.0);
      expect(provider.enableDynamicColors, isFalse);
    });

    test('loads persisted accent color on startup', () async {
      SharedPreferences.setMockInitialValues({
        'accent_color': Colors.orange.toARGB32(),
      });

      final provider = ThemeProvider();
      await Future<void>.delayed(Duration.zero);

      expect(provider.dynamicAccentColor, Color(Colors.orange.toARGB32()));
    });
  });
}
