import 'package:flutter/material.dart';

/// i18n scaffolding for the staff app.
///
/// English (`en`) is the source of truth and the runtime fallback.
/// Hindi (`hi`), Tamil (`ta`), and Telugu (`te`) are first-pass
/// machine-translated and **need a professional translator review**
/// before production rollout — flagged inline with `// REVIEW:` where
/// the translation is high-stakes (clinical actions, error messages).
/// Anywhere a key is missing in a non-English map, callers fall back
/// to English so the UI never blanks.
///
/// Why a manual map instead of `flutter gen-l10n` ARB codegen: the
/// build pipeline on Windows + Melos workspaces is finicky around the
/// generated files, and the staff app's text surface is small enough
/// (~150 strings on the high-traffic screens) that a hand-maintained
/// map is easier to evolve. Future migration to ARB is straightforward
/// — same key/value structure, just dropped into `app_en.arb` etc.
///
/// **Contribution guide:**
///   1. When adding a new user-facing string, give it a dotted key
///      that follows `<screen>.<intent>` (e.g. `bed_board.empty`).
///   2. Always populate the English value. Leave the other locales
///      empty — the fallback handles it. A translator can fill them
///      later with proper context.
///   3. Read with `AppStrings.of(context).<accessor>` from the screen.
///      Add a typed getter for every key so refactors are safe.
///
/// Usage:
/// ```
/// final s = AppStrings.of(context);
/// Text(s.bedBoardTitle)
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

  // ────────────────────────────────────────────────────────────────────
  // Public string accessors. Group by screen; keep keys alphabetised
  // within a section so additions don't conflict.
  // ────────────────────────────────────────────────────────────────────

  // ── Common actions ─────────────────────────────────────────────────
  String get actionCancel => _t('action.cancel');
  String get actionClose => _t('action.close');
  String get actionConfirm => _t('action.confirm');
  String get actionDelete => _t('action.delete');
  String get actionEdit => _t('action.edit');
  String get actionLogout => _t('action.logout');
  String get actionRefresh => _t('action.refresh');
  String get actionRetry => _t('action.retry');
  String get actionSave => _t('action.save');
  String get actionSearch => _t('action.search');
  String get actionSubmit => _t('action.submit');

  // ── Common labels ──────────────────────────────────────────────────
  String get labelLoading => _t('label.loading');
  String get labelNoData => _t('label.no_data');
  String get labelOptional => _t('label.optional');
  String get labelRequired => _t('label.required');
  String noMatchesFor(String query) =>
      '${_t('label.no_matches_for')} "$query"';

  // ── Time-of-day greetings ──────────────────────────────────────────
  String get dashboardGreetingMorning => _t('dashboard.greeting.morning');
  String get dashboardGreetingAfternoon => _t('dashboard.greeting.afternoon');
  String get dashboardGreetingEvening => _t('dashboard.greeting.evening');
  String dashboardGreeting(String name) {
    final hour = DateTime.now().hour;
    final base = hour < 12
        ? dashboardGreetingMorning
        : hour < 17
            ? dashboardGreetingAfternoon
            : dashboardGreetingEvening;
    return name.isEmpty ? base : '$base, $name';
  }

  // ── Dashboard ──────────────────────────────────────────────────────
  String get dashboardCheckedIn => _t('dashboard.checked_in');
  String get dashboardCheckedOut => _t('dashboard.checked_out');
  String get dashboardNotCheckedIn => _t('dashboard.not_checked_in');
  String get dashboardQuickActionsHeader =>
      _t('dashboard.quick_actions_header');
  String get dashboardRecentPatientsHeader =>
      _t('dashboard.recent_patients_header');
  String get dashboardStatAlerts => _t('dashboard.stat.alerts');
  String get dashboardStatAppointments => _t('dashboard.stat.appointments');
  String get dashboardStatDueMeds => _t('dashboard.stat.due_meds');
  String get dashboardStatInpatients => _t('dashboard.stat.inpatients');
  String get dashboardStatReviewQueue => _t('dashboard.stat.review_queue');
  String get dashboardUpcomingAppointmentsHeader =>
      _t('dashboard.upcoming_appointments');

  // ── Login screen ───────────────────────────────────────────────────
  String get loginEmployeeIdLabel => _t('login.employee_id_label');
  String get loginPasswordLabel => _t('login.password_label');
  String get loginPinLabel => _t('login.pin_label');
  String get loginSignInButton => _t('login.sign_in_button');
  String get loginUseBiometric => _t('login.use_biometric');
  String get loginUsePassword => _t('login.use_password');
  String get loginUsePin => _t('login.use_pin');
  String get loginInvalidCredentials => _t('login.invalid_credentials');

  // ── Bed Board ──────────────────────────────────────────────────────
  String get bedBoardTitle => _t('bed_board.title');
  String get bedBoardSearchWardsHint => _t('bed_board.search_wards_hint');
  String get bedBoardSearchBedsHint => _t('bed_board.search_beds_hint');
  String get bedBoardSelectWardPrompt =>
      _t('bed_board.select_ward_prompt');
  String get bedBoardEmptyTitle => _t('bed_board.empty_title');
  String get bedBoardEmptyBody => _t('bed_board.empty_body');
  String get bedBoardLegendAvailable => _t('bed.status.available');
  String get bedBoardLegendOccupied => _t('bed.status.occupied');
  String get bedBoardLegendMaintenance => _t('bed.status.maintenance');
  String get bedBoardFilterAll => _t('bed_board.filter.all');

  String bedNumber(String num) => '${_t('bed.label')} $num';

  // ── Bed sheet ──────────────────────────────────────────────────────
  String get bedSheetActionOpenEmr => _t('bed_sheet.action.open_emr');
  String get bedSheetActionRecordVitals =>
      _t('bed_sheet.action.record_vitals');
  String get bedSheetActionAddNote => _t('bed_sheet.action.add_note');
  String get bedSheetActionHandover => _t('bed_sheet.action.handover');
  String get bedSheetSectionPatient => _t('bed_sheet.section.patient');
  String get bedSheetSectionAdmission => _t('bed_sheet.section.admission');
  String get bedSheetSectionNotes => _t('bed_sheet.section.notes');
  String get bedSheetNotesHint => _t('bed_sheet.notes_hint');
  String get bedSheetSaveNotes => _t('bed_sheet.save_notes');
  String get bedSheetNotesSaved => _t('bed_sheet.notes_saved');
  String get bedSheetAdmitPatient => _t('bed_sheet.admit_patient');
  String get bedSheetDischarge => _t('bed_sheet.discharge');
  String get bedSheetMarkMaintenance => _t('bed_sheet.mark_maintenance');
  String get bedSheetMarkAvailable => _t('bed_sheet.mark_available');
  String dischargeConfirmTitle(String name) =>
      '${_t('bed_sheet.discharge_confirm_prefix')} $name?';
  String get dischargeConfirmBody => _t('bed_sheet.discharge_confirm_body');

  // ── Attendance ─────────────────────────────────────────────────────
  String get attendanceTitle => _t('attendance.title');
  String get attendanceCheckIn => _t('attendance.check_in');
  String get attendanceCheckOut => _t('attendance.check_out');
  String get attendanceCheckedInAt => _t('attendance.checked_in_at');
  String get attendanceOutsideCampus => _t('attendance.outside_campus');

  // ── Leave ──────────────────────────────────────────────────────────
  String get leaveTitle => _t('leave.title');
  String get leaveTabApply => _t('leave.tab.apply');
  String get leaveTabMyLeaves => _t('leave.tab.my_leaves');
  String get leaveTabRequests => _t('leave.tab.requests');
  String get leaveBalanceHeader => _t('leave.balance_header');
  String get leaveSubmitButton => _t('leave.submit_button');
  String get leaveSubmitted => _t('leave.submitted');

  // ── Notifications / Messaging ──────────────────────────────────────
  String get notificationsTitle => _t('notifications.title');
  String get notificationsEmpty => _t('notifications.empty');
  String get notificationsSearchHint => _t('notifications.search_hint');
  String get messagingInboxTitle => _t('messaging.inbox_title');
  String get messagingEmpty => _t('messaging.empty');

  // ── Patient picker ─────────────────────────────────────────────────
  String get patientPickerTitle => _t('patient_picker.title');
  String get patientPickerHint => _t('patient_picker.hint');
  String get patientPickerEmpty => _t('patient_picker.empty');

  // ── Voice dictation ────────────────────────────────────────────────
  String get voiceDictateTooltip => _t('voice_dictate.tooltip');
  String get voiceDictateRecording => _t('voice_dictate.recording');
  String get voiceDictateStop => _t('voice_dictate.stop');
  String get voiceDictateTranscribing => _t('voice_dictate.transcribing');
  String get voiceDictateTranscriptAdded =>
      _t('voice_dictate.transcript_added');
  String get voiceDictateMicDenied => _t('voice_dictate.mic_denied');

  // ────────────────────────────────────────────────────────────────────
  // Translation tables.
  // ────────────────────────────────────────────────────────────────────
  // English (source of truth) — every key MUST live here.
  // Hindi/Tamil/Telugu — first-pass machine translations. A professional
  // translator MUST review before production deployment, especially for
  // clinical actions (admit, discharge, save) and error messages.
  // Where a translation is uncertain or context-sensitive, the English
  // string falls through automatically.
  // ────────────────────────────────────────────────────────────────────

  static const Map<String, Map<String, String>> _byLang = {
    // ── English ──────────────────────────────────────────────────────
    'en': {
      // Common actions
      'action.cancel': 'Cancel',
      'action.close': 'Close',
      'action.confirm': 'Confirm',
      'action.delete': 'Delete',
      'action.edit': 'Edit',
      'action.logout': 'Logout',
      'action.refresh': 'Refresh',
      'action.retry': 'Retry',
      'action.save': 'Save',
      'action.search': 'Search',
      'action.submit': 'Submit',
      // Common labels
      'label.loading': 'Loading…',
      'label.no_data': 'No data',
      'label.no_matches_for': 'No matches for',
      'label.optional': 'Optional',
      'label.required': 'Required',
      // Greetings
      'dashboard.greeting.morning': 'Good morning',
      'dashboard.greeting.afternoon': 'Good afternoon',
      'dashboard.greeting.evening': 'Good evening',
      // Dashboard
      'dashboard.checked_in': 'Checked in',
      'dashboard.checked_out': 'Checked out',
      'dashboard.not_checked_in': 'Not checked in',
      'dashboard.quick_actions_header': 'Quick Actions',
      'dashboard.recent_patients_header': 'Recent Patients',
      'dashboard.stat.alerts': 'Alerts',
      'dashboard.stat.appointments': 'Today\'s Appts',
      'dashboard.stat.due_meds': 'Due Meds',
      'dashboard.stat.inpatients': 'Inpatients',
      'dashboard.stat.review_queue': 'AI Review',
      'dashboard.upcoming_appointments': 'Upcoming Appointments',
      // Login
      'login.employee_id_label': 'Employee ID',
      'login.password_label': 'Password',
      'login.pin_label': 'PIN',
      'login.sign_in_button': 'Sign in',
      'login.use_biometric': 'Use biometric',
      'login.use_password': 'Use password',
      'login.use_pin': 'Use PIN',
      'login.invalid_credentials': 'Invalid credentials. Please try again.',
      // Bed
      'bed.label': 'Bed',
      'bed.status.available': 'Available',
      'bed.status.occupied': 'Occupied',
      'bed.status.maintenance': 'Maintenance',
      // Bed Board
      'bed_board.title': 'Bed Board',
      'bed_board.search_wards_hint': 'Search wards…',
      'bed_board.search_beds_hint': 'Search by bed # or patient name…',
      'bed_board.select_ward_prompt': 'Select a ward to view its beds',
      'bed_board.empty_title': 'No beds in this ward',
      'bed_board.empty_body': 'Add beds via the admin portal.',
      'bed_board.filter.all': 'All',
      // Bed sheet
      'bed_sheet.action.open_emr': 'Open EMR',
      'bed_sheet.action.record_vitals': 'Record Vitals',
      'bed_sheet.action.add_note': 'Add Note',
      'bed_sheet.action.handover': 'Handover',
      'bed_sheet.section.patient': 'Patient',
      'bed_sheet.section.admission': 'Admission',
      'bed_sheet.section.notes': 'Notes',
      'bed_sheet.notes_hint':
          'Type a note for this bed (handover, hazards, IV site, etc.)',
      'bed_sheet.save_notes': 'Save Notes',
      'bed_sheet.notes_saved': 'Bed notes saved',
      'bed_sheet.admit_patient': 'Admit Patient',
      'bed_sheet.discharge': 'Discharge',
      'bed_sheet.mark_maintenance': 'Mark Maintenance',
      'bed_sheet.mark_available': 'Mark Available',
      'bed_sheet.discharge_confirm_prefix': 'Discharge',
      'bed_sheet.discharge_confirm_body':
          'This frees the bed and ends the active admission. The patient\'s EMR records remain intact.',
      // Attendance
      'attendance.title': 'Attendance',
      'attendance.check_in': 'Check In',
      'attendance.check_out': 'Check Out',
      'attendance.checked_in_at': 'Checked in at',
      'attendance.outside_campus':
          'You are outside the hospital campus. Check-in disabled.',
      // Leave
      'leave.title': 'Leave',
      'leave.tab.apply': 'Apply',
      'leave.tab.my_leaves': 'My Leaves',
      'leave.tab.requests': 'Requests',
      'leave.balance_header': 'Leave Balance',
      'leave.submit_button': 'Submit Application',
      'leave.submitted': 'Leave application submitted',
      // Notifications / Messaging
      'notifications.title': 'Notifications',
      'notifications.empty': 'No notifications yet',
      'notifications.search_hint': 'Search notifications…',
      'messaging.inbox_title': 'Messages',
      'messaging.empty': 'No messages',
      // Patient picker
      'patient_picker.title': 'Find a patient',
      'patient_picker.hint': 'Find a patient by name, phone, or ABHA…',
      'patient_picker.empty': 'No patient matches yet — keep typing.',
      // Voice dictation
      'voice_dictate.tooltip': 'Dictate (voice → text)',
      'voice_dictate.recording': 'Dictating…',
      'voice_dictate.stop': 'Stop & Transcribe',
      'voice_dictate.transcribing': 'Transcribing…',
      'voice_dictate.transcript_added': 'Dictation added to notes',
      'voice_dictate.mic_denied':
          'Microphone permission denied. Enable it in your OS / app settings.',
    },
    // ── हिन्दी (Hindi) ────────────────────────────────────────────────
    // First-pass machine translation. REVIEW required before production.
    'hi': {
      'action.cancel': 'रद्द करें',
      'action.close': 'बंद करें',
      'action.confirm': 'पुष्टि करें',
      'action.delete': 'हटाएँ',
      'action.edit': 'संपादित करें',
      'action.logout': 'लॉग आउट',
      'action.refresh': 'ताज़ा करें',
      'action.retry': 'पुनः प्रयास करें',
      'action.save': 'सहेजें',
      'action.search': 'खोजें',
      'action.submit': 'जमा करें',
      'label.loading': 'लोड हो रहा है…',
      'label.no_data': 'कोई डेटा नहीं',
      'label.no_matches_for': 'इसके लिए कोई मेल नहीं',
      'label.optional': 'वैकल्पिक',
      'label.required': 'आवश्यक',
      'dashboard.greeting.morning': 'सुप्रभात',
      'dashboard.greeting.afternoon': 'नमस्ते',
      'dashboard.greeting.evening': 'शुभ संध्या',
      'dashboard.checked_in': 'चेक इन',
      'dashboard.checked_out': 'चेक आउट',
      'dashboard.not_checked_in': 'चेक इन नहीं',
      'dashboard.quick_actions_header': 'त्वरित क्रियाएँ',
      'dashboard.recent_patients_header': 'हाल के रोगी',
      'dashboard.stat.alerts': 'अलर्ट',
      'dashboard.stat.appointments': 'आज की मुलाक़ातें',
      'dashboard.stat.due_meds': 'देय दवाएँ',
      'dashboard.stat.inpatients': 'भर्ती मरीज़',
      'dashboard.stat.review_queue': 'AI समीक्षा',
      'dashboard.upcoming_appointments': 'आगामी अपॉइंटमेंट',
      'login.employee_id_label': 'कर्मचारी आईडी',
      'login.password_label': 'पासवर्ड',
      'login.pin_label': 'पिन',
      'login.sign_in_button': 'साइन इन',
      'login.use_biometric': 'बायोमेट्रिक का उपयोग करें',
      'login.use_password': 'पासवर्ड का उपयोग करें',
      'login.use_pin': 'पिन का उपयोग करें',
      // REVIEW: clinical-error tone
      'login.invalid_credentials':
          'अमान्य प्रमाण-पत्र। कृपया पुनः प्रयास करें।',
      'bed.label': 'बेड',
      'bed.status.available': 'उपलब्ध',
      'bed.status.occupied': 'व्यस्त',
      'bed.status.maintenance': 'रखरखाव',
      'bed_board.title': 'बेड बोर्ड',
      'bed_board.search_wards_hint': 'वार्ड खोजें…',
      'bed_board.search_beds_hint': 'बेड संख्या या रोगी नाम से खोजें…',
      'bed_board.select_ward_prompt': 'बेड देखने के लिए वार्ड चुनें',
      'bed_board.empty_title': 'इस वार्ड में कोई बेड नहीं',
      'bed_board.empty_body': 'व्यवस्थापक पोर्टल से बेड जोड़ें।',
      'bed_board.filter.all': 'सभी',
      'bed_sheet.action.open_emr': 'EMR खोलें',
      'bed_sheet.action.record_vitals': 'वाइटल्स दर्ज करें',
      'bed_sheet.action.add_note': 'नोट जोड़ें',
      'bed_sheet.action.handover': 'हैंडओवर',
      'bed_sheet.section.patient': 'मरीज़',
      'bed_sheet.section.admission': 'भर्ती',
      'bed_sheet.section.notes': 'नोट्स',
      'bed_sheet.notes_hint':
          'इस बेड के लिए नोट लिखें (हैंडओवर, ख़तरे, IV साइट आदि)',
      'bed_sheet.save_notes': 'नोट्स सहेजें',
      'bed_sheet.notes_saved': 'बेड नोट्स सहेजे गए',
      'bed_sheet.admit_patient': 'मरीज़ भर्ती करें',
      // REVIEW: clinical action — confirm with hospital terminology
      'bed_sheet.discharge': 'डिस्चार्ज',
      'bed_sheet.mark_maintenance': 'रखरखाव चिह्नित करें',
      'bed_sheet.mark_available': 'उपलब्ध चिह्नित करें',
      'bed_sheet.discharge_confirm_prefix': 'डिस्चार्ज करें',
      'bed_sheet.discharge_confirm_body':
          'यह बेड को मुक्त करता है और सक्रिय भर्ती समाप्त करता है। मरीज़ के EMR रिकॉर्ड बरकरार रहते हैं।',
      'attendance.title': 'उपस्थिति',
      'attendance.check_in': 'चेक इन',
      'attendance.check_out': 'चेक आउट',
      'attendance.checked_in_at': 'चेक इन समय',
      'attendance.outside_campus':
          'आप अस्पताल परिसर के बाहर हैं। चेक-इन निष्क्रिय है।',
      'leave.title': 'अवकाश',
      'leave.tab.apply': 'आवेदन करें',
      'leave.tab.my_leaves': 'मेरे अवकाश',
      'leave.tab.requests': 'अनुरोध',
      'leave.balance_header': 'अवकाश शेष',
      'leave.submit_button': 'आवेदन जमा करें',
      'leave.submitted': 'अवकाश आवेदन जमा किया गया',
      'notifications.title': 'सूचनाएँ',
      'notifications.empty': 'अभी कोई सूचना नहीं',
      'notifications.search_hint': 'सूचनाएँ खोजें…',
      'messaging.inbox_title': 'संदेश',
      'messaging.empty': 'कोई संदेश नहीं',
      'patient_picker.title': 'मरीज़ ढूँढें',
      'patient_picker.hint': 'नाम, फ़ोन या ABHA से मरीज़ ढूँढें…',
      'patient_picker.empty': 'अभी कोई मरीज़ नहीं मिला — टाइप करते रहें।',
      'voice_dictate.tooltip': 'बोलकर लिखें (आवाज़ → पाठ)',
      'voice_dictate.recording': 'रिकॉर्ड हो रहा है…',
      'voice_dictate.stop': 'रोकें और लिखें',
      'voice_dictate.transcribing': 'लिख रहा है…',
      'voice_dictate.transcript_added': 'नोट्स में जोड़ा गया',
      'voice_dictate.mic_denied':
          'माइक्रोफ़ोन अनुमति अस्वीकृत। OS / ऐप सेटिंग्स में सक्षम करें।',
    },
    // ── தமிழ் (Tamil) ─────────────────────────────────────────────────
    // First-pass machine translation. REVIEW required before production.
    'ta': {
      'action.cancel': 'ரத்து',
      'action.close': 'மூடு',
      'action.confirm': 'உறுதிப்படுத்து',
      'action.delete': 'நீக்கு',
      'action.edit': 'திருத்து',
      'action.logout': 'வெளியேறு',
      'action.refresh': 'புதுப்பி',
      'action.retry': 'மீண்டும் முயற்சி',
      'action.save': 'சேமி',
      'action.search': 'தேடு',
      'action.submit': 'சமர்ப்பி',
      'label.loading': 'ஏற்றுகிறது…',
      'label.no_data': 'தரவு இல்லை',
      'label.no_matches_for': 'பொருத்தம் இல்லை',
      'label.optional': 'விருப்பம்',
      'label.required': 'தேவை',
      'dashboard.greeting.morning': 'காலை வணக்கம்',
      'dashboard.greeting.afternoon': 'மதிய வணக்கம்',
      'dashboard.greeting.evening': 'மாலை வணக்கம்',
      'dashboard.checked_in': 'சரிபார்த்தது',
      'dashboard.checked_out': 'வெளியேறியது',
      'dashboard.not_checked_in': 'சரிபார்க்கவில்லை',
      'dashboard.quick_actions_header': 'விரைவு செயல்கள்',
      'dashboard.recent_patients_header': 'சமீபத்திய நோயாளிகள்',
      'dashboard.stat.alerts': 'எச்சரிக்கைகள்',
      'dashboard.stat.appointments': 'இன்றைய சந்திப்புகள்',
      'dashboard.stat.due_meds': 'தர வேண்டிய மருந்துகள்',
      'dashboard.stat.inpatients': 'உள்நோயாளிகள்',
      'dashboard.stat.review_queue': 'AI மறுபரிசீலனை',
      'dashboard.upcoming_appointments': 'வரவிருக்கும் சந்திப்புகள்',
      'login.employee_id_label': 'ஊழியர் ID',
      'login.password_label': 'கடவுச்சொல்',
      'login.pin_label': 'PIN',
      'login.sign_in_button': 'உள்நுழை',
      'login.use_biometric': 'பயோமெட்ரிக் பயன்படுத்து',
      'login.use_password': 'கடவுச்சொல் பயன்படுத்து',
      'login.use_pin': 'PIN பயன்படுத்து',
      'login.invalid_credentials':
          'தவறான விவரங்கள். மீண்டும் முயற்சிக்கவும்.',
      'bed.label': 'படுக்கை',
      'bed.status.available': 'கிடைக்கிறது',
      'bed.status.occupied': 'பிடிக்கப்பட்டது',
      'bed.status.maintenance': 'பராமரிப்பு',
      'bed_board.title': 'படுக்கை பலகை',
      'bed_board.search_wards_hint': 'வார்டுகளைத் தேடு…',
      'bed_board.search_beds_hint':
          'படுக்கை எண் அல்லது நோயாளி பெயரால் தேடு…',
      'bed_board.select_ward_prompt':
          'படுக்கைகளைப் பார்க்க வார்டைத் தேர்ந்தெடு',
      'bed_board.empty_title': 'இந்த வார்டில் படுக்கைகள் இல்லை',
      'bed_board.empty_body': 'நிர்வாகி போர்டல் வழியாக படுக்கைகளைச் சேர்.',
      'bed_board.filter.all': 'அனைத்தும்',
      'bed_sheet.action.open_emr': 'EMR திறக்க',
      'bed_sheet.action.record_vitals': 'உயிர் அளவீடுகள் பதிவு',
      'bed_sheet.action.add_note': 'குறிப்பு சேர்',
      'bed_sheet.action.handover': 'கையளிப்பு',
      'bed_sheet.section.patient': 'நோயாளி',
      'bed_sheet.section.admission': 'அனுமதி',
      'bed_sheet.section.notes': 'குறிப்புகள்',
      'bed_sheet.notes_hint':
          'இந்தப் படுக்கைக்கு குறிப்பு எழுது (கையளிப்பு, அபாயங்கள், IV தளம் போன்றவை)',
      'bed_sheet.save_notes': 'குறிப்புகளைச் சேமி',
      'bed_sheet.notes_saved': 'படுக்கை குறிப்புகள் சேமிக்கப்பட்டன',
      'bed_sheet.admit_patient': 'நோயாளியை அனுமதி',
      'bed_sheet.discharge': 'வெளியேற்று',
      'bed_sheet.mark_maintenance': 'பராமரிப்பு என குறி',
      'bed_sheet.mark_available': 'கிடைக்கிறது என குறி',
      'bed_sheet.discharge_confirm_prefix': 'வெளியேற்று',
      'bed_sheet.discharge_confirm_body':
          'இது படுக்கையை விடுவித்து செயலில் உள்ள அனுமதியை முடிக்கிறது. நோயாளியின் EMR பதிவுகள் அப்படியே இருக்கும்.',
      'attendance.title': 'வருகை',
      'attendance.check_in': 'உள்நுழை',
      'attendance.check_out': 'வெளியேறு',
      'attendance.checked_in_at': 'உள்நுழைவு நேரம்',
      'attendance.outside_campus':
          'நீங்கள் மருத்துவமனை வளாகத்திற்கு வெளியே உள்ளீர்கள். உள்நுழைவு முடக்கப்பட்டுள்ளது.',
      'leave.title': 'விடுப்பு',
      'leave.tab.apply': 'விண்ணப்பி',
      'leave.tab.my_leaves': 'என் விடுப்புகள்',
      'leave.tab.requests': 'கோரிக்கைகள்',
      'leave.balance_header': 'விடுப்பு மீதி',
      'leave.submit_button': 'விண்ணப்பத்தை சமர்ப்பி',
      'leave.submitted': 'விடுப்பு விண்ணப்பம் சமர்ப்பிக்கப்பட்டது',
      'notifications.title': 'அறிவிப்புகள்',
      'notifications.empty': 'இன்னும் அறிவிப்புகள் இல்லை',
      'notifications.search_hint': 'அறிவிப்புகளைத் தேடு…',
      'messaging.inbox_title': 'செய்திகள்',
      'messaging.empty': 'செய்திகள் இல்லை',
      'patient_picker.title': 'நோயாளியைக் கண்டறி',
      'patient_picker.hint':
          'பெயர், தொலைபேசி அல்லது ABHA மூலம் நோயாளியைக் கண்டறி…',
      'patient_picker.empty':
          'இன்னும் நோயாளி பொருத்தங்கள் இல்லை — தொடர்ந்து தட்டச்சு செய்.',
      'voice_dictate.tooltip': 'குரல் → உரை',
      'voice_dictate.recording': 'பதிவு செய்கிறது…',
      'voice_dictate.stop': 'நிறுத்து & எழுது',
      'voice_dictate.transcribing': 'உரையாக்குகிறது…',
      'voice_dictate.transcript_added': 'குறிப்புகளில் சேர்க்கப்பட்டது',
      'voice_dictate.mic_denied':
          'மைக்ரோஃபோன் அனுமதி மறுக்கப்பட்டது. OS / பயன்பாட்டு அமைப்புகளில் இயக்கவும்.',
    },
    // ── తెలుగు (Telugu) ──────────────────────────────────────────────
    // First-pass machine translation. REVIEW required before production.
    'te': {
      'action.cancel': 'రద్దు',
      'action.close': 'మూసివేయి',
      'action.confirm': 'నిర్ధారించు',
      'action.delete': 'తొలగించు',
      'action.edit': 'సవరించు',
      'action.logout': 'లాగౌట్',
      'action.refresh': 'రిఫ్రెష్',
      'action.retry': 'మళ్ళీ ప్రయత్నించు',
      'action.save': 'సేవ్',
      'action.search': 'వెతకండి',
      'action.submit': 'సమర్పించు',
      'label.loading': 'లోడ్ అవుతోంది…',
      'label.no_data': 'డేటా లేదు',
      'label.no_matches_for': 'సరిపోలికలు లేవు',
      'label.optional': 'ఐచ్ఛికం',
      'label.required': 'అవసరం',
      'dashboard.greeting.morning': 'శుభోదయం',
      'dashboard.greeting.afternoon': 'శుభ మధ్యాహ్నం',
      'dashboard.greeting.evening': 'శుభ సాయంత్రం',
      'dashboard.checked_in': 'చెక్ ఇన్',
      'dashboard.checked_out': 'చెక్ అవుట్',
      'dashboard.not_checked_in': 'చెక్ ఇన్ కాలేదు',
      'dashboard.quick_actions_header': 'త్వరిత చర్యలు',
      'dashboard.recent_patients_header': 'ఇటీవలి రోగులు',
      'dashboard.stat.alerts': 'హెచ్చరికలు',
      'dashboard.stat.appointments': 'నేటి అపాయింట్‌మెంట్‌లు',
      'dashboard.stat.due_meds': 'తీసుకోవలసిన మందులు',
      'dashboard.stat.inpatients': 'ఇన్‌పేషెంట్లు',
      'dashboard.stat.review_queue': 'AI సమీక్ష',
      'dashboard.upcoming_appointments': 'రాబోయే అపాయింట్‌మెంట్‌లు',
      'login.employee_id_label': 'ఉద్యోగి ID',
      'login.password_label': 'పాస్‌వర్డ్',
      'login.pin_label': 'PIN',
      'login.sign_in_button': 'సైన్ ఇన్',
      'login.use_biometric': 'బయోమెట్రిక్ వాడండి',
      'login.use_password': 'పాస్‌వర్డ్ వాడండి',
      'login.use_pin': 'PIN వాడండి',
      'login.invalid_credentials':
          'చెల్లని ఆధారాలు. దయచేసి మళ్ళీ ప్రయత్నించండి.',
      'bed.label': 'బెడ్',
      'bed.status.available': 'అందుబాటులో',
      'bed.status.occupied': 'ఆక్రమించిన',
      'bed.status.maintenance': 'నిర్వహణ',
      'bed_board.title': 'బెడ్ బోర్డ్',
      'bed_board.search_wards_hint': 'వార్డులను వెతకండి…',
      'bed_board.search_beds_hint': 'బెడ్ నం. లేదా రోగి పేరుతో వెతకండి…',
      'bed_board.select_ward_prompt': 'బెడ్‌లను చూడటానికి వార్డ్ ఎంచుకోండి',
      'bed_board.empty_title': 'ఈ వార్డులో బెడ్‌లు లేవు',
      'bed_board.empty_body': 'అడ్మిన్ పోర్టల్ ద్వారా బెడ్‌లు జోడించండి.',
      'bed_board.filter.all': 'అన్నీ',
      'bed_sheet.action.open_emr': 'EMR తెరువు',
      'bed_sheet.action.record_vitals': 'వైటల్స్ నమోదు',
      'bed_sheet.action.add_note': 'గమనిక జోడించు',
      'bed_sheet.action.handover': 'హ్యాండోవర్',
      'bed_sheet.section.patient': 'రోగి',
      'bed_sheet.section.admission': 'అడ్మిషన్',
      'bed_sheet.section.notes': 'గమనికలు',
      'bed_sheet.notes_hint':
          'ఈ బెడ్‌కి గమనిక టైప్ చేయండి (హ్యాండోవర్, ప్రమాదాలు, IV సైట్ మొదలైనవి)',
      'bed_sheet.save_notes': 'గమనికలు సేవ్ చేయి',
      'bed_sheet.notes_saved': 'బెడ్ గమనికలు సేవ్ చేయబడ్డాయి',
      'bed_sheet.admit_patient': 'రోగిని అడ్మిట్ చేయి',
      'bed_sheet.discharge': 'డిశ్చార్జి',
      'bed_sheet.mark_maintenance': 'నిర్వహణగా గుర్తించు',
      'bed_sheet.mark_available': 'అందుబాటులో గుర్తించు',
      'bed_sheet.discharge_confirm_prefix': 'డిశ్చార్జి చేయి',
      'bed_sheet.discharge_confirm_body':
          'ఇది బెడ్‌ను ఖాళీ చేస్తుంది మరియు చురుకైన అడ్మిషన్‌ను ముగిస్తుంది. రోగి EMR రికార్డులు అలాగే ఉంటాయి.',
      'attendance.title': 'హాజరు',
      'attendance.check_in': 'చెక్ ఇన్',
      'attendance.check_out': 'చెక్ అవుట్',
      'attendance.checked_in_at': 'చెక్ ఇన్ చేసిన సమయం',
      'attendance.outside_campus':
          'మీరు ఆసుపత్రి ప్రాంగణం వెలుపల ఉన్నారు. చెక్-ఇన్ నిలిపివేయబడింది.',
      'leave.title': 'సెలవు',
      'leave.tab.apply': 'దరఖాస్తు',
      'leave.tab.my_leaves': 'నా సెలవులు',
      'leave.tab.requests': 'అభ్యర్థనలు',
      'leave.balance_header': 'సెలవు బ్యాలెన్స్',
      'leave.submit_button': 'దరఖాస్తు సమర్పించు',
      'leave.submitted': 'సెలవు దరఖాస్తు సమర్పించబడింది',
      'notifications.title': 'నోటిఫికేషన్‌లు',
      'notifications.empty': 'ఇంకా నోటిఫికేషన్‌లు లేవు',
      'notifications.search_hint': 'నోటిఫికేషన్‌లను వెతకండి…',
      'messaging.inbox_title': 'సందేశాలు',
      'messaging.empty': 'సందేశాలు లేవు',
      'patient_picker.title': 'రోగిని కనుగొనండి',
      'patient_picker.hint':
          'పేరు, ఫోన్ లేదా ABHA ద్వారా రోగిని కనుగొనండి…',
      'patient_picker.empty':
          'ఇంకా రోగి సరిపోలికలు లేవు — టైప్ చేయడం కొనసాగించండి.',
      'voice_dictate.tooltip': 'వాయిస్ → టెక్స్ట్',
      'voice_dictate.recording': 'రికార్డ్ అవుతోంది…',
      'voice_dictate.stop': 'ఆపండి & ట్రాన్స్క్రైబ్',
      'voice_dictate.transcribing': 'ట్రాన్స్క్రైబ్ అవుతోంది…',
      'voice_dictate.transcript_added': 'గమనికలకు జోడించబడింది',
      'voice_dictate.mic_denied':
          'మైక్రోఫోన్ అనుమతి తిరస్కరించబడింది. OS / యాప్ సెట్టింగ్‌లలో ప్రారంభించండి.',
    },
  };
}
