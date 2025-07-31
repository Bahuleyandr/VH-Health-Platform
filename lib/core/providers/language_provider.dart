import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:provider/provider.dart';

class LanguageProvider extends ChangeNotifier {
  Locale _locale = const Locale('en');

  static const String _languageKey = 'language_code';

  final Map<String, String> languageNames = {
    'en': 'English',
    'ta': 'தமிழ்',
    'hi': 'हिन्दी',
    'te': 'తెలుగు',
    'ml': 'മലയാളം',
  };

  LanguageProvider() {
    _loadSavedLocale();
  }

  Locale get locale => _locale;

  Future<void> _loadSavedLocale() async {
    final prefs = await SharedPreferences.getInstance();
    final code = prefs.getString(_languageKey) ?? 'en';
    _locale = Locale(code);
    notifyListeners();
  }

  Future<void> setLocale(String languageCode) async {
    if (languageCode == _locale.languageCode) return;
    _locale = Locale(languageCode);
    notifyListeners();

    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_languageKey, languageCode);
  }

  void resetToSystemLocale() {
    _locale = const Locale('en');
    notifyListeners();
  }

  // 👇 Used by SettingsController
  static LanguageProvider of(BuildContext context) =>
      context.read<LanguageProvider>();
}
