import 'package:flutter/material.dart';

/// Lightweight i18n scaffolding for the staff app.
///
/// English (`en`) is the source of truth and the runtime default.
/// Hindi (`hi`), Tamil (`ta`), and Telugu (`te`) are supported as
/// India-deployment targets — placeholder translations live here
/// pending a proper translator pass. Anywhere a key is missing in a
/// non-English map, callers fall back to English so the UI never
/// blanks.
///
/// Why a manual map instead of `flutter gen-l10n` ARB codegen: the
/// build pipeline on Windows + Melos workspaces is finicky around the
/// generated files, and the staff app's text surface is small enough
/// (~50 strings on the high-traffic screens) that a hand-maintained
/// map is easier to evolve. Future migration to ARB is straightforward
/// — same key/value structure.
///
/// Usage:
/// ```
/// Text(AppStrings.of(context).dashboardGreeting('Arya'))
/// ```
class AppStrings {
  final Locale locale;
  const AppStrings._(this.locale);

  /// Pull the current locale's strings from the build tree. Falls back
  /// to English when the active locale isn't supported.
  static AppStrings of(BuildContext context) {
    return AppStrings._(Localizations.localeOf(context));
  }

  /// Locales the app ships translations for. Wire this list into
  /// `MaterialApp.supportedLocales`.
  static const supportedLocales = <Locale>[
    Locale('en'),
    Locale('hi'),
    Locale('ta'),
    Locale('te'),
  ];

  // ── Helper ──────────────────────────────────────────────────────────
  String _t(String key) {
    final lang = locale.languageCode;
    return _byLang[lang]?[key] ?? _byLang['en']![key] ?? key;
  }

  // ── Public string accessors ────────────────────────────────────────
  // Add keys here as screens are converted. Each accessor maps to a
  // string key in [_byLang]. Keep names descriptive — they survive
  // longer than the strings they hold.

  String get dashboardGreetingMorning => _t('dashboard.greeting.morning');
  String get dashboardGreetingAfternoon => _t('dashboard.greeting.afternoon');
  String get dashboardGreetingEvening => _t('dashboard.greeting.evening');
  String get bedBoardTitle => _t('bed_board.title');
  String get bedStatusAvailable => _t('bed.status.available');
  String get bedStatusOccupied => _t('bed.status.occupied');
  String get bedStatusMaintenance => _t('bed.status.maintenance');
  String get actionLogout => _t('action.logout');
  String get actionCancel => _t('action.cancel');
  String get actionSave => _t('action.save');

  String dashboardGreeting(String name) {
    final hour = DateTime.now().hour;
    final base = hour < 12
        ? dashboardGreetingMorning
        : hour < 17
            ? dashboardGreetingAfternoon
            : dashboardGreetingEvening;
    return name.isEmpty ? base : '$base, $name';
  }

  // ── Translation tables ─────────────────────────────────────────────
  // Populate the non-English maps as a translator becomes available.
  // The Hindi/Tamil/Telugu values below are intentionally illustrative
  // — they cover the most-visible user-facing strings to prove the
  // scaffolding works end-to-end, not a complete translation.
  static const Map<String, Map<String, String>> _byLang = {
    'en': {
      'dashboard.greeting.morning': 'Good morning',
      'dashboard.greeting.afternoon': 'Good afternoon',
      'dashboard.greeting.evening': 'Good evening',
      'bed_board.title': 'Bed Board',
      'bed.status.available': 'Available',
      'bed.status.occupied': 'Occupied',
      'bed.status.maintenance': 'Maintenance',
      'action.logout': 'Logout',
      'action.cancel': 'Cancel',
      'action.save': 'Save',
    },
    'hi': {
      'dashboard.greeting.morning': 'सुप्रभात',
      'dashboard.greeting.afternoon': 'नमस्ते',
      'dashboard.greeting.evening': 'शुभ संध्या',
      'bed_board.title': 'बेड बोर्ड',
      'bed.status.available': 'उपलब्ध',
      'bed.status.occupied': 'व्यस्त',
      'bed.status.maintenance': 'रखरखाव',
      'action.logout': 'लॉग आउट',
      'action.cancel': 'रद्द करें',
      'action.save': 'सहेजें',
    },
    'ta': {
      'dashboard.greeting.morning': 'காலை வணக்கம்',
      'dashboard.greeting.afternoon': 'மதிய வணக்கம்',
      'dashboard.greeting.evening': 'மாலை வணக்கம்',
      'bed_board.title': 'படுக்கை பலகை',
      'bed.status.available': 'கிடைக்கிறது',
      'bed.status.occupied': 'பிடிக்கப்பட்டது',
      'bed.status.maintenance': 'பராமரிப்பு',
      'action.logout': 'வெளியேறு',
      'action.cancel': 'ரத்து',
      'action.save': 'சேமி',
    },
    'te': {
      'dashboard.greeting.morning': 'శుభోదయం',
      'dashboard.greeting.afternoon': 'శుభ మధ్యాహ్నం',
      'dashboard.greeting.evening': 'శుభ సాయంత్రం',
      'bed_board.title': 'బెడ్ బోర్డ్',
      'bed.status.available': 'అందుబాటులో',
      'bed.status.occupied': 'ఆక్రమించిన',
      'bed.status.maintenance': 'నిర్వహణ',
      'action.logout': 'లాగౌట్',
      'action.cancel': 'రద్దు',
      'action.save': 'సేవ్',
    },
  };
}
