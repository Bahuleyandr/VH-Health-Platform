// test/core/providers/locale_provider_test.dart
//
// Locks the staff-side language-override behaviour (roadmap E2):
// default = follow device locale (null), explicit selection persists to
// SharedPreferences, 'system' clears the override, unsupported codes are
// rejected, and the picker's display-name map stays in sync with
// AppStrings.supportedLocales (so adding a locale in one place without
// the other fails fast).

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth_staff/core/providers/locale_provider.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('LocaleProvider', () {
    setUp(() {
      SharedPreferences.setMockInitialValues({});
    });

    test('defaults to null (follow device locale)', () async {
      final provider = LocaleProvider();
      await Future<void>.delayed(Duration.zero); // let _loadFromPrefs run
      expect(provider.locale, isNull);
    });

    test('restores a previously saved language', () async {
      SharedPreferences.setMockInitialValues({'staff_language_code': 'ml'});
      final provider = LocaleProvider();
      await Future<void>.delayed(Duration.zero);
      expect(provider.locale, const Locale('ml'));
    });

    test('setLanguage persists and notifies', () async {
      final provider = LocaleProvider();
      await Future<void>.delayed(Duration.zero);
      var notified = 0;
      provider.addListener(() => notified++);

      await provider.setLanguage('hi');
      expect(provider.locale, const Locale('hi'));
      expect(notified, 1);

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('staff_language_code'), 'hi');
    });

    test("'system' (or null) clears the override", () async {
      SharedPreferences.setMockInitialValues({'staff_language_code': 'ta'});
      final provider = LocaleProvider();
      await Future<void>.delayed(Duration.zero);
      expect(provider.locale, const Locale('ta'));

      await provider.setLanguage('system');
      expect(provider.locale, isNull);
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('staff_language_code'), isNull);
    });

    test('unsupported codes are rejected', () async {
      final provider = LocaleProvider();
      await Future<void>.delayed(Duration.zero);
      await provider.setLanguage('fr');
      expect(provider.locale, isNull);
    });

    test('ignores a stale saved code that is no longer supported', () async {
      SharedPreferences.setMockInitialValues({'staff_language_code': 'xx'});
      final provider = LocaleProvider();
      await Future<void>.delayed(Duration.zero);
      expect(provider.locale, isNull);
    });
  });

  group('locale wiring consistency', () {
    test('languageNames covers exactly AppStrings.supportedLocales', () {
      final supported = AppStrings.supportedLocales
          .map((l) => l.languageCode)
          .toSet();
      expect(LocaleProvider.languageNames.keys.toSet(), supported);
    });

    test('ml is a supported locale (roadmap E2)', () {
      expect(AppStrings.supportedLocales, contains(const Locale('ml')));
    });
  });
}
