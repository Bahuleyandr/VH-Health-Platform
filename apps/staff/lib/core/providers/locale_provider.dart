import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../l10n/app_strings.dart';

/// In-app language selection (roadmap E2) — the staff-side port of the
/// patient app's `LanguageProvider`. Persists to SharedPreferences and
/// feeds `MaterialApp.router(locale: ...)`.
///
/// Unlike the patient provider, `null` is a first-class value meaning
/// "follow the device locale" — the staff app historically followed the
/// system locale, so installs keep that behaviour until a user picks a
/// language explicitly in Settings.
class LocaleProvider extends ChangeNotifier {
  static const _key = 'staff_language_code';

  /// Display names per supported language code, in the script nurses will
  /// recognise. Keep in sync with [AppStrings.supportedLocales].
  static const languageNames = <String, String>{
    'en': 'English',
    'hi': 'हिन्दी',
    'ta': 'தமிழ்',
    'te': 'తెలుగు',
    'ml': 'മലയാളം',
  };

  Locale? _locale;

  LocaleProvider() {
    _loadFromPrefs();
  }

  /// Selected locale, or null to follow the device locale.
  Locale? get locale => _locale;

  Future<void> _loadFromPrefs() async {
    final prefs = await SharedPreferences.getInstance();
    final code = prefs.getString(_key);
    if (code != null && code.isNotEmpty && _isSupported(code)) {
      _locale = Locale(code);
      notifyListeners();
    }
  }

  /// Pass null (or 'system') to clear the override and follow the device.
  Future<void> setLanguage(String? languageCode) async {
    final code = (languageCode == null || languageCode == 'system')
        ? null
        : languageCode;
    if (code != null && !_isSupported(code)) return;
    if ((code == null && _locale == null) ||
        (code != null && _locale?.languageCode == code)) {
      return;
    }
    _locale = code == null ? null : Locale(code);
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    if (code == null) {
      await prefs.remove(_key);
    } else {
      await prefs.setString(_key, code);
    }
  }

  static bool _isSupported(String code) =>
      AppStrings.supportedLocales.any((l) => l.languageCode == code);
}
