import 'package:flutter/material.dart';

/// i18n scaffolding for the staff app.
///
/// English (`en`) is the source of truth and the runtime fallback.
///
/// **Translation status (as of 2026-05-02 second-pass):**
/// - `hi` (Hindi) — second-pass reviewed for register and clinical
///   terminology. Most strings are production-ready; a handful are
///   flagged `// REVIEW:` where context-sensitivity matters (e.g.
///   discharge / consent / urgency wording — should be confirmed
///   against the deploying hospital's existing Hindi documentation).
/// - `ta` (Tamil) — first-pass machine translation with light
///   verification. Treat as placeholder; ALL clinical-action strings
///   need a Tamil-fluent clinician's review before production.
/// - `te` (Telugu) — same as Tamil. Placeholder. ALL clinical-action
///   strings need a Telugu-fluent clinician's review.
///
/// Why not just remove the lower-confidence locales? Because the
/// scaffolding works — the UI localises Material widgets (date
/// pickers, back labels) and the highest-traffic strings even on
/// first-pass quality. Removing them would silently fall back to
/// English for users with `hi`/`ta`/`te` system locales and hide
/// from us how much the translator pass needs to fix.
///
/// Anywhere a key is missing in a non-English map, callers fall back
/// to English so the UI never blanks. Empty-string values are NOT
/// supported — leave a key out of the map to fall through cleanly.
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
  String get loginAppTitle => _t('login.app_title');
  String get loginPortalSubtitle => _t('login.portal_subtitle');
  String get loginScreenTitle => _t('login.screen_title');
  String get loginScreenSubtitle => _t('login.screen_subtitle');
  String get loginEmployeeIdHint => _t('login.employee_id_hint');
  String get loginEmployeeIdRequired => _t('login.employee_id_required');
  String get loginEmployeeIdNumbersOnly => _t('login.employee_id_numbers_only');
  String get loginModePassword => _t('login.mode.password');
  String get loginModePin => _t('login.mode.pin');
  String get loginModeQuick => _t('login.mode.quick');
  String get loginPinFieldLabel => _t('login.pin_field_label');
  String get loginPinHint => _t('login.pin_hint');
  String get loginPinRequired => _t('login.pin_required');
  String get loginPinMinDigits => _t('login.pin_min_digits');
  String get loginQuickPinLabel => _t('login.quick_pin_label');
  String get loginQuickPinHint => _t('login.quick_pin_hint');
  String get loginRememberEmployeeId => _t('login.remember_employee_id');
  String get loginLockedTitle => _t('login.locked_title');
  // REVIEW: clinical / security messaging — confirm phrasing with hospital security policy
  String get loginLockedHint => _t('login.locked_hint');
  String get loginSignInWithPassword => _t('login.sign_in_with_password');
  String get loginSignInWithPin => _t('login.sign_in_with_pin');
  String get loginQuickSignIn => _t('login.quick_sign_in');
  String get loginFooter => _t('login.footer');

  // ── Dashboard (additional) ─────────────────────────────────────────
  String get dashboardWelcomeBack => _t('dashboard.welcome_back');
  String get dashboardSeeAll => _t('dashboard.see_all');
  String get dashboardAllFeatures => _t('dashboard.all_features');
  String get dashboardRecentActivity => _t('dashboard.recent_activity');
  String get dashboardCheckedInTitle => _t('dashboard.checked_in_title');
  String get dashboardNotCheckedInTitle => _t('dashboard.not_checked_in_title');
  String get dashboardSinceTimePrefix => _t('dashboard.since_time_prefix');
  String get dashboardTapToManage => _t('dashboard.tap_to_manage');
  String get dashboardNewLiveNotificationOne =>
      _t('dashboard.new_live_notification.one');
  String get dashboardNewLiveNotificationOther =>
      _t('dashboard.new_live_notification.other');
  String get dashboardSyncPendingOne => _t('dashboard.sync_pending.one');
  String get dashboardSyncPendingOther => _t('dashboard.sync_pending.other');
  String get dashboardActionCheckInOut => _t('dashboard.action.check_in_out');
  String get dashboardActionShiftSchedule =>
      _t('dashboard.action.shift_schedule');
  String get dashboardActionMessages => _t('dashboard.action.messages');
  String get dashboardActionPrescriptions =>
      _t('dashboard.action.prescriptions');
  String get dashboardActionInvestigations =>
      _t('dashboard.action.investigations');
  String get dashboardActionVitals => _t('dashboard.action.vitals');
  String get dashboardActionHandover => _t('dashboard.action.handover');
  String get dashboardActionPharmacy => _t('dashboard.action.pharmacy');
  String get dashboardActionUploadResults =>
      _t('dashboard.action.upload_results');

  String dashboardSyncPending(int count) {
    final base = count == 1
        ? dashboardSyncPendingOne
        : dashboardSyncPendingOther;
    return '$count $base';
  }

  String dashboardLiveNotifications(int count) {
    final base = count == 1
        ? dashboardNewLiveNotificationOne
        : dashboardNewLiveNotificationOther;
    return '$count $base';
  }

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
  String get bedBoardNoWardsYet => _t('bed_board.no_wards_yet');
  String get bedBoardWardStatTotal => _t('bed_board.ward_stat.total');
  String get bedBoardWardStatFree => _t('bed_board.ward_stat.free');
  String get bedBoardWardStatUsed => _t('bed_board.ward_stat.used');
  String bedBoardCountAvailable(int n) =>
      '$n ${_t('bed_board.count.available_suffix')}';
  String get bedBoardBackToWards => _t('bed_board.back_to_wards');
  String get bedBoardWardFallback => _t('bed_board.ward_fallback');
  String get bedBoardPrintTooltip => _t('bed_board.print_tooltip');
  String get bedBoardRefreshTooltip => _t('bed_board.refresh_tooltip');
  String bedBoardPrintFailed(String reason) =>
      '${_t('bed_board.print_failed_prefix')} $reason';
  String bedBoardNoStatusFiltered(String status) =>
      '${_t('bed_board.no_filtered_prefix')} $status ${_t('bed_board.no_filtered_suffix')}';
  String get bedBoardAdmitWhichPatient =>
      _t('bed_board.admit_which_patient');
  String get bedBoardAdmitSearchHint =>
      _t('bed_board.admit_search_hint');
  String get bedBoardTypeToFindPatient =>
      _t('bed_board.type_to_find_patient');
  String get bedBoardPatientUnnamed => _t('bed_board.patient_unnamed');

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
  String get attendanceTabToday => _t('attendance.tab.today');
  String get attendanceTabCalendar => _t('attendance.tab.calendar');
  String get attendanceTabHistory => _t('attendance.tab.history');
  String get attendanceCheckedInBadge => _t('attendance.checked_in_badge');
  String get attendanceNotCheckedInBadge =>
      _t('attendance.not_checked_in_badge');
  String get attendanceCheckedInSuccess =>
      _t('attendance.checked_in_success');
  String get attendanceCheckedOutSuccess =>
      _t('attendance.checked_out_success');
  String get attendanceGettingLocation => _t('attendance.getting_location');
  String get attendanceProcessing => _t('attendance.processing');
  String get attendanceLocationVerifyHint =>
      _t('attendance.location_verify_hint');
  String get attendanceReportIssue => _t('attendance.report_issue');
  String get attendanceLegendPresent => _t('attendance.legend.present');
  String get attendanceLegendAbsent => _t('attendance.legend.absent');
  String get attendanceLegendLeave => _t('attendance.legend.leave');
  String get attendanceLegendLate => _t('attendance.legend.late');
  String get attendanceCheckInLabel => _t('attendance.check_in_label');
  String get attendanceCheckOutLabel => _t('attendance.check_out_label');
  String get attendanceHoursLabel => _t('attendance.hours_label');
  String get attendanceLateArrival => _t('attendance.late_arrival');
  String get attendanceNoHistory => _t('attendance.no_history');
  String get attendanceHistoryAbsent => _t('attendance.history.absent');
  String get attendanceHistoryInPrefix =>
      _t('attendance.history.in_prefix');
  String get attendanceHistoryOutPrefix =>
      _t('attendance.history.out_prefix');
  // REVIEW: clinical-action / location-error message — confirm distance phrasing for non-English locales
  String get attendanceOutsideCampusDistancePrefix =>
      _t('attendance.outside_campus.distance_prefix');
  String get attendanceOutsideCampusDistanceSuffix =>
      _t('attendance.outside_campus.distance_suffix');
  String attendanceOutsideCampusDistance(int meters) =>
      '$attendanceOutsideCampusDistancePrefix (${meters}m) $attendanceOutsideCampusDistanceSuffix';

  // ── Settings ───────────────────────────────────────────────────────
  String get settingsTitle => _t('settings.title');
  String get settingsSectionAppearance => _t('settings.section.appearance');
  String get settingsSectionNotifications =>
      _t('settings.section.notifications');
  String get settingsSectionSecurity => _t('settings.section.security');
  String get settingsSectionQuickLinks => _t('settings.section.quick_links');
  String get settingsSectionAbout => _t('settings.section.about');
  String get settingsThemeTitle => _t('settings.theme.title');
  String get settingsThemeSystem => _t('settings.theme.system');
  String get settingsThemeLight => _t('settings.theme.light');
  String get settingsThemeDark => _t('settings.theme.dark');
  String get settingsThemeSubtitleSystem =>
      _t('settings.theme.subtitle_system');
  String get settingsThemeSubtitleLight =>
      _t('settings.theme.subtitle_light');
  String get settingsThemeSubtitleDark =>
      _t('settings.theme.subtitle_dark');
  String get settingsPushNotifications =>
      _t('settings.push_notifications');
  String get settingsPushNotificationsSubtitle =>
      _t('settings.push_notifications.subtitle');
  String get settingsShiftReminders => _t('settings.shift_reminders');
  String get settingsShiftRemindersSubtitle =>
      _t('settings.shift_reminders.subtitle');
  String get settingsSetupPin => _t('settings.setup_pin');
  String get settingsSetupPinSubtitle => _t('settings.setup_pin.subtitle');
  String get settingsSetupPinDialogTitle =>
      _t('settings.setup_pin.dialog_title');
  String get settingsSetupPinDialogLabel =>
      _t('settings.setup_pin.dialog_label');
  // REVIEW: clinical-action / security message — confirm phrasing
  String get settingsSetupPinSuccess => _t('settings.setup_pin.success');
  String get settingsBiometricTitle => _t('settings.biometric.title');
  String get settingsBiometricSubtitle =>
      _t('settings.biometric.subtitle');
  // REVIEW: clinical-action / security message
  String get settingsBiometricEnabled =>
      _t('settings.biometric.enabled');
  // REVIEW: clinical-action / security message
  String get settingsBiometricDisabled =>
      _t('settings.biometric.disabled');
  String get settingsManageDevices => _t('settings.manage_devices');
  String get settingsManageDevicesSubtitle =>
      _t('settings.manage_devices.subtitle');
  String get settingsRegisteredDevices =>
      _t('settings.registered_devices');
  String get settingsNoDevices => _t('settings.no_devices');
  String get settingsUnknownDevice => _t('settings.unknown_device');
  // REVIEW: clinical-action / security message
  String get settingsDeviceRemoved => _t('settings.device_removed');
  String get settingsQuickLinkProfile =>
      _t('settings.quick_link.profile');
  String get settingsQuickLinkProfileSubtitle =>
      _t('settings.quick_link.profile.subtitle');
  String get settingsQuickLinkAttendance =>
      _t('settings.quick_link.attendance');
  String get settingsQuickLinkAttendanceSubtitle =>
      _t('settings.quick_link.attendance.subtitle');
  String get settingsQuickLinkLeave => _t('settings.quick_link.leave');
  String get settingsQuickLinkLeaveSubtitle =>
      _t('settings.quick_link.leave.subtitle');
  String get settingsAboutTitle => _t('settings.about.title');
  String get settingsAboutSubtitle => _t('settings.about.subtitle');
  String get settingsLogoutDialogTitle =>
      _t('settings.logout.dialog_title');
  String get settingsLogoutDialogBody =>
      _t('settings.logout.dialog_body');

  // ── Profile ────────────────────────────────────────────────────────
  String get profileTitle => _t('profile.title');
  String get profileEditTooltip => _t('profile.edit_tooltip');
  String get profileCancelTooltip => _t('profile.cancel_tooltip');
  String get profileFallbackName => _t('profile.fallback_name');
  String get profileEmpIdPrefix => _t('profile.emp_id_prefix');
  String get profileInfoTitle => _t('profile.info_title');
  String get profileEditTitle => _t('profile.edit_title');
  String get profileFieldEmployeeId => _t('profile.field.employee_id');
  String get profileFieldRole => _t('profile.field.role');
  String get profileFieldDepartment => _t('profile.field.department');
  String get profileFieldPhone => _t('profile.field.phone');
  String get profileFieldEmail => _t('profile.field.email');
  String get profileFieldAddress => _t('profile.field.address');
  String get profileFieldShift => _t('profile.field.shift');
  String get profileFieldJoiningDate => _t('profile.field.joining_date');
  String get profileSavingButton => _t('profile.saving_button');
  String get profileSaveChanges => _t('profile.save_changes');
  // REVIEW: clinical-action confirmation — confirm phrasing
  String get profileUpdatedSuccess => _t('profile.updated_success');

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
  String get notificationsMarkAllRead => _t('notifications.mark_all_read');
  String get notificationsLiveUpdate => _t('notifications.live_update');
  String get messagingInboxTitle => _t('messaging.inbox_title');
  String get messagingEmpty => _t('messaging.empty');
  String get messagingEmptyBody => _t('messaging.empty_body');
  String get messagingNewMessage => _t('messaging.new_message');
  String get messagingTypeHint => _t('messaging.type_hint');
  String get messagingSend => _t('messaging.send');
  String get messagingSetPriority => _t('messaging.set_priority');
  String get messagingSendFailedPrefix => _t('messaging.send_failed_prefix');
  String get messagingThreadLoadFailed => _t('messaging.thread_load_failed');
  String get messagingThreadEmptyTitle => _t('messaging.thread_empty_title');
  String get messagingThreadEmptyBody => _t('messaging.thread_empty_body');

  // ── Time helpers ───────────────────────────────────────────────────
  String get timeJustNow => _t('time.just_now');
  String get timeYesterday => _t('time.yesterday');
  String get timeToday => _t('time.today');
  String get timeMinutesAgoSuffix => _t('time.minutes_ago_suffix');
  String get timeHoursAgoSuffix => _t('time.hours_ago_suffix');
  String get timeDaysAgoSuffix => _t('time.days_ago_suffix');

  // ── Priority / Urgency dropdowns (shared) ──────────────────────────
  String get priorityLow => _t('priority.low');
  String get priorityNormal => _t('priority.normal');
  String get priorityHigh => _t('priority.high');
  String get priorityUrgent => _t('priority.urgent');
  String get priorityCritical => _t('priority.critical');
  String get urgencyLow => _t('urgency.low');
  String get urgencyNormal => _t('urgency.normal');
  String get urgencyHigh => _t('urgency.high');
  String get urgencyCritical => _t('urgency.critical');

  // ── Departments (shared) ───────────────────────────────────────────
  String get departmentGeneral => _t('department.general');
  String get departmentEmergency => _t('department.emergency');
  String get departmentIcu => _t('department.icu');
  String get departmentPediatrics => _t('department.pediatrics');
  String get departmentSurgery => _t('department.surgery');
  String get departmentOutpatient => _t('department.outpatient');

  // ── About screen ───────────────────────────────────────────────────
  String get aboutTitle => _t('about.title');
  String get aboutHeader => _t('about.header');
  String get aboutAppName => _t('about.app_name');
  String get aboutVersion => _t('about.version');
  String get aboutDescription => _t('about.description');
  String get aboutFeaturesHeader => _t('about.features_header');
  String get aboutSupportHeader => _t('about.support_header');
  String get aboutSupportEmailLabel => _t('about.support_email_label');
  String get aboutWebsiteLabel => _t('about.website_label');
  String get aboutCopyright => _t('about.copyright');
  String get aboutFeatureAttendanceTitle => _t('about.feature.attendance.title');
  String get aboutFeatureAttendanceDescription =>
      _t('about.feature.attendance.description');
  String get aboutFeatureLeaveTitle => _t('about.feature.leave.title');
  String get aboutFeatureLeaveDescription =>
      _t('about.feature.leave.description');
  String get aboutFeatureAppointmentsTitle =>
      _t('about.feature.appointments.title');
  String get aboutFeatureAppointmentsDescription =>
      _t('about.feature.appointments.description');
  String get aboutFeatureInvestigationsTitle =>
      _t('about.feature.investigations.title');
  String get aboutFeatureInvestigationsDescription =>
      _t('about.feature.investigations.description');
  String get aboutFeaturePharmacyTitle => _t('about.feature.pharmacy.title');
  String get aboutFeaturePharmacyDescription =>
      _t('about.feature.pharmacy.description');
  String get aboutFeatureStaffDirectoryTitle =>
      _t('about.feature.staff_directory.title');
  String get aboutFeatureStaffDirectoryDescription =>
      _t('about.feature.staff_directory.description');
  String get aboutFeatureClinicalModulesTitle =>
      _t('about.feature.clinical_modules.title');
  String get aboutFeatureClinicalModulesDescription =>
      _t('about.feature.clinical_modules.description');

  // ── Leave (additional) ─────────────────────────────────────────────
  String get leaveTypeAnnual => _t('leave.type.annual');
  String get leaveTypeSick => _t('leave.type.sick');
  String get leaveTypeCasual => _t('leave.type.casual');
  String get leaveTypeEmergency => _t('leave.type.emergency');
  String get leaveTypeMaternity => _t('leave.type.maternity');
  String get leaveTypePaternity => _t('leave.type.paternity');
  String get leaveTypeUnpaid => _t('leave.type.unpaid');
  String get leaveBalanceUsed => _t('leave.balance.used');
  String get leaveLeaveTypeLabel => _t('leave.leave_type_label');
  String get leaveDatesLabel => _t('leave.dates_label');
  String get leaveStartDate => _t('leave.start_date');
  String get leaveEndDate => _t('leave.end_date');
  String get leaveReasonLabel => _t('leave.reason_label');
  String get leaveReasonHint => _t('leave.reason_hint');
  String get leaveReplacementStaffLabel => _t('leave.replacement_staff_label');
  String get leaveReplacementStaffHint => _t('leave.replacement_staff_hint');
  String get leaveReplacementStaffPick => _t('leave.replacement_staff_pick');
  String get leaveSelectReplacement => _t('leave.select_replacement');
  String get leaveNoStaffAvailable => _t('leave.no_staff_available');
  String get leaveSearchByTypeHint => _t('leave.search_by_type_hint');
  String get leaveNoApplications => _t('leave.no_applications');
  String get leaveNoReplacementRequests =>
      _t('leave.no_replacement_requests');
  String get leaveRequesterUnknown => _t('leave.requester_unknown');
  String get leaveRequestingCoverageFor => _t('leave.requesting_coverage_for');
  String get leaveSelectDatesError => _t('leave.error.select_dates');
  String get leaveProvideReasonError => _t('leave.error.provide_reason');
  String get leaveOvertimeTitle => _t('leave.overtime_title');
  String get leaveOvertimeSubtitle => _t('leave.overtime_subtitle');
  String get leaveDisputeTitle => _t('leave.dispute_title');
  String get leaveDisputeSubtitle => _t('leave.dispute_subtitle');
  String get leaveDeclineAction => _t('leave.action.decline');
  String get leaveAcceptAction => _t('leave.action.accept');
  // REVIEW: clinical-action confirmation — confirm phrasing
  String get leaveRequestAccepted => _t('leave.request_accepted');
  String get leaveRequestDeclined => _t('leave.request_declined');
  String leaveDayCount(int days) {
    final base = _t(days == 1 ? 'leave.day_count.one' : 'leave.day_count.other');
    return '$days $base';
  }

  // ── Bed sheet (additional) ─────────────────────────────────────────
  String get bedSheetFieldName => _t('bed_sheet.field.name');
  String get bedSheetFieldAge => _t('bed_sheet.field.age');
  String get bedSheetFieldGender => _t('bed_sheet.field.gender');
  String get bedSheetFieldPhone => _t('bed_sheet.field.phone');
  String get bedSheetFieldChiefComplaint => _t('bed_sheet.field.chief_complaint');
  String get bedSheetFieldDiagnosis => _t('bed_sheet.field.diagnosis');
  String get bedSheetFieldType => _t('bed_sheet.field.type');
  String get bedSheetFieldAttending => _t('bed_sheet.field.attending');
  String get bedSheetFieldAdmitted => _t('bed_sheet.field.admitted');
  String get bedSheetYearSuffix => _t('bed_sheet.year_suffix');
  String get bedSheetDoctorPrefix => _t('bed_sheet.doctor_prefix');
  String get bedSheetPatientDetailsUnavailable =>
      _t('bed_sheet.patient_details_unavailable');
  String get bedSheetNoPatientAssigned => _t('bed_sheet.no_patient_assigned');
  String get bedSheetSavingLabel => _t('bed_sheet.saving_label');
  String get bedSheetQuickNoteHint => _t('bed_sheet.quick_note_hint');
  String get bedSheetDictateQuickNote => _t('bed_sheet.dictate_quick_note');
  String get bedSheetThisPatient => _t('bed_sheet.this_patient');
  // REVIEW: clinical-action confirmation
  String get bedSheetPatientDischarged => _t('bed_sheet.patient_discharged');
  String get bedSheetPatientMissingName => _t('bed_sheet.patient_missing_name');
  String bedSheetPatientAdmitted(String name) =>
      '$name ${_t('bed_sheet.patient_admitted_suffix')}';
  String bedSheetMarkedAs(String status) =>
      '${_t('bed_sheet.marked_as_prefix')} $status';

  // ── Vitals ─────────────────────────────────────────────────────────
  String get vitalsTitle => _t('vitals.title');
  String get vitalsTabRecord => _t('vitals.tab.record');
  String get vitalsTabRecent => _t('vitals.tab.recent');
  String get vitalsHeaderTitle => _t('vitals.header_title');
  String get vitalsHeaderSubtitle => _t('vitals.header_subtitle');
  String get vitalsPatientIdLabel => _t('vitals.patient_id_label');
  String get vitalsPatientIdHint => _t('vitals.patient_id_hint');
  String get vitalsPatientIdRequired => _t('vitals.patient_id_required');
  String get vitalsPatientIdInvalid => _t('vitals.patient_id_invalid');
  String get vitalsBpHeader => _t('vitals.bp_header');
  String get vitalsBpSystolic => _t('vitals.bp_systolic');
  String get vitalsBpSystolicHint => _t('vitals.bp_systolic_hint');
  String get vitalsBpDiastolic => _t('vitals.bp_diastolic');
  String get vitalsBpDiastolicHint => _t('vitals.bp_diastolic_hint');
  String get vitalsTemperatureHeader => _t('vitals.temperature_header');
  String get vitalsTemperatureHint => _t('vitals.temperature_hint');
  String get vitalsPulseSpo2Header => _t('vitals.pulse_spo2_header');
  String get vitalsPulseLabel => _t('vitals.pulse_label');
  String get vitalsPulseHint => _t('vitals.pulse_hint');
  String get vitalsSpo2Label => _t('vitals.spo2_label');
  String get vitalsSpo2Hint => _t('vitals.spo2_hint');
  String get vitalsWeightHeader => _t('vitals.weight_header');
  String get vitalsWeightHint => _t('vitals.weight_hint');
  String get vitalsNurseNotesLabel => _t('vitals.nurse_notes_label');
  String get vitalsNurseNotesHint => _t('vitals.nurse_notes_hint');
  String get vitalsValidationInvalid => _t('vitals.validation.invalid');
  String get vitalsSaveButton => _t('vitals.save_button');
  String get vitalsFetchButton => _t('vitals.fetch_button');
  String get vitalsTrendsHint => _t('vitals.trends_hint');
  String get vitalsNoRecords => _t('vitals.no_records');
  // REVIEW: clinical-action confirmation
  String get vitalsRecordedSuccess => _t('vitals.recorded_success');
  // REVIEW: clinical / connectivity message
  String get vitalsOfflineQueued => _t('vitals.offline_queued');

  // ── Nursing Notes ──────────────────────────────────────────────────
  String get nursingNotesTitle => _t('nursing_notes.title');
  String get nursingNotesTabAdd => _t('nursing_notes.tab.add');
  String get nursingNotesTabRecent => _t('nursing_notes.tab.recent');
  String get nursingNotesBackendComingSoon =>
      _t('nursing_notes.backend_coming_soon');
  String get nursingNotesPatientPhoneLabel =>
      _t('nursing_notes.patient_phone_label');
  String get nursingNotesPatientPhoneHint =>
      _t('nursing_notes.patient_phone_hint');
  String get nursingNotesPhoneRequired => _t('nursing_notes.phone_required');
  String get nursingNotesPhoneInvalid => _t('nursing_notes.phone_invalid');
  String get nursingNotesTypeLabel => _t('nursing_notes.type_label');
  String get nursingNotesTypeRequired => _t('nursing_notes.type_required');
  String get nursingNotesPriorityLabel => _t('nursing_notes.priority_label');
  String get nursingNotesClinicalNoteLabel =>
      _t('nursing_notes.clinical_note_label');
  String get nursingNotesClinicalNoteHint =>
      _t('nursing_notes.clinical_note_hint');
  String get nursingNotesNoteRequired => _t('nursing_notes.note_required');
  String get nursingNotesNoteTooShort => _t('nursing_notes.note_too_short');
  String get nursingNotesSaveButton => _t('nursing_notes.save_button');
  // REVIEW: clinical-action confirmation
  String get nursingNotesSavedSuccess => _t('nursing_notes.saved_success');
  // REVIEW: clinical / connectivity message
  String get nursingNotesOfflineQueued => _t('nursing_notes.offline_queued');
  String get nursingNotesRecentEmpty => _t('nursing_notes.recent_empty');
  String get nursingNotesTypeObservation =>
      _t('nursing_notes.type.observation');
  String get nursingNotesTypeMedication => _t('nursing_notes.type.medication');
  String get nursingNotesTypePostProcedure =>
      _t('nursing_notes.type.post_procedure');
  String get nursingNotesTypeIntakeOutput =>
      _t('nursing_notes.type.intake_output');
  String get nursingNotesTypePatientComplaint =>
      _t('nursing_notes.type.patient_complaint');
  String get nursingNotesTypeWoundCare => _t('nursing_notes.type.wound_care');
  String get nursingNotesTypeShiftHandover =>
      _t('nursing_notes.type.shift_handover');
  String get nursingNotesTypeEmergencyNote =>
      _t('nursing_notes.type.emergency_note');
  String get nursingNotesTypeOther => _t('nursing_notes.type.other');

  // ── Handover ───────────────────────────────────────────────────────
  String get handoverTitle => _t('handover.title');
  String get handoverTabWrite => _t('handover.tab.write');
  String get handoverTabRecent => _t('handover.tab.recent');
  String get handoverDepartmentLabel => _t('handover.department_label');
  String get handoverUrgencyLabel => _t('handover.urgency_label');
  String get handoverNotesLabel => _t('handover.notes_label');
  String get handoverNotesHint => _t('handover.notes_hint');
  String get handoverNotesRequired => _t('handover.notes_required');
  String get handoverPatientRefLabel => _t('handover.patient_ref_label');
  String get handoverPatientRefHint => _t('handover.patient_ref_hint');
  String get handoverSubmitButton => _t('handover.submit_button');
  String get handoverSubmittingButton => _t('handover.submitting_button');
  // REVIEW: clinical-action confirmation
  String get handoverSubmitted => _t('handover.submitted');
  String get handoverRecentEmptyTitle => _t('handover.recent_empty_title');
  String get handoverRecentEmptyBody => _t('handover.recent_empty_body');
  String get handoverNoteFallbackTitle => _t('handover.note_fallback_title');

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

  // ── Doctor queue screen ────────────────────────────────────────────
  String get queueTitle => _t('queue.title');
  String get queueRefreshTooltip => _t('queue.refresh_tooltip');
  String get queueSectionInConsultation => _t('queue.section.in_consultation');
  String queueSectionWaiting(int count) =>
      '${_t('queue.section.waiting_prefix')} ($count)';
  String queueSectionCompleted(int count) =>
      '${_t('queue.section.completed_prefix')} ($count)';
  String get queueCallNextPatient => _t('queue.call_next_patient');
  // REVIEW: clinical-action confirmation — confirm phrasing
  String get queueCompleteConsultation => _t('queue.complete_consultation');
  String get queueCallTooltip => _t('queue.call_tooltip');
  String get queueNoPatientsWaiting => _t('queue.no_patients_waiting');
  String get queueNoCompletedConsultations =>
      _t('queue.no_completed_consultations');
  String get queueWaitingPrefix => _t('queue.waiting_prefix');
  String get queueInPrefix => _t('queue.in_prefix');
  String get queuePatientInfo => _t('queue.patient_info');
  String get queueRecentRecords => _t('queue.recent_records');
  String get queueNoHealthRecordsFound => _t('queue.no_health_records_found');
  // REVIEW: clinical / safety — allergies surfacing
  String queueAllergiesPrefix(String allergies) =>
      '${_t('queue.allergies_prefix')} $allergies';
  String get queueAgePrefix => _t('queue.age_prefix');
  String get queueWritePrescription => _t('queue.write_prescription');
  String get queueOrderInvestigation => _t('queue.order_investigation');
  String get queueAddNotes => _t('queue.add_notes');
  String get queueNoPhoneNumber => _t('queue.no_phone_number');
  String get queueRecordFallback => _t('queue.record_fallback');
  String get queueUnknownPatient => _t('queue.unknown_patient');

  // ── Prescriptions screen ───────────────────────────────────────────
  String get prescriptionsTitle => _t('prescriptions.title');
  String get prescriptionsTabNew => _t('prescriptions.tab.new');
  String get prescriptionsTabRecent => _t('prescriptions.tab.recent');
  String get prescriptionsErrorSelectPatientDoctor =>
      _t('prescriptions.error.select_patient_doctor');
  String get prescriptionsErrorFillMedicationNames =>
      _t('prescriptions.error.fill_medication_names');
  String get prescriptionsPhotoTitle => _t('prescriptions.photo.title');
  String get prescriptionsPhotoBody => _t('prescriptions.photo.body');
  String get prescriptionsPhotoCamera => _t('prescriptions.photo.camera');
  String get prescriptionsPhotoGallery => _t('prescriptions.photo.gallery');
  String get prescriptionsVitalsCollapse =>
      _t('prescriptions.vitals_collapse');
  String get prescriptionsDiagnosisLabel =>
      _t('prescriptions.diagnosis_label');
  String get prescriptionsDiagnosisRequired =>
      _t('prescriptions.diagnosis_required');
  String get prescriptionsMedicationsHeader =>
      _t('prescriptions.medications_header');
  String get prescriptionsAddButton => _t('prescriptions.add_button');
  String get prescriptionsSetFollowUp => _t('prescriptions.set_follow_up');
  String prescriptionsFollowUpPrefix(String date) =>
      '${_t('prescriptions.follow_up_prefix')} $date';
  String get prescriptionsClearFollowUp =>
      _t('prescriptions.clear_follow_up');
  String get prescriptionsFollowUpNotes =>
      _t('prescriptions.follow_up_notes');
  String get prescriptionsFollowUpNotesHint =>
      _t('prescriptions.follow_up_notes_hint');
  String get prescriptionsClinicalNotes =>
      _t('prescriptions.clinical_notes');
  String get prescriptionsClinicalNotesHint =>
      _t('prescriptions.clinical_notes_hint');
  String get prescriptionsPhotoAttached =>
      _t('prescriptions.photo_attached');
  String get prescriptionsAttachHandwritten =>
      _t('prescriptions.attach_handwritten');
  String get prescriptionsCreating => _t('prescriptions.creating');
  String get prescriptionsCreate => _t('prescriptions.create');
  String prescriptionsCreated(String rxNum) =>
      '${_t('prescriptions.created_prefix')} $rxNum ${_t('prescriptions.created_suffix')}';
  String get prescriptionsPatientLabel =>
      _t('prescriptions.patient_label');
  String get prescriptionsDoctorLabel =>
      _t('prescriptions.doctor_label');
  String get prescriptionsSearchPatient =>
      _t('prescriptions.search_patient');
  String get prescriptionsSearchDoctor =>
      _t('prescriptions.search_doctor');
  String get prescriptionsRemoveMedication =>
      _t('prescriptions.remove_medication');
  String get prescriptionsMedicineName =>
      _t('prescriptions.medicine_name');
  String get prescriptionsMedicineNameHint =>
      _t('prescriptions.medicine_name_hint');
  String get prescriptionsDosage => _t('prescriptions.dosage');
  String get prescriptionsDosageHint => _t('prescriptions.dosage_hint');
  String get prescriptionsFrequency => _t('prescriptions.frequency');
  String get prescriptionsDuration => _t('prescriptions.duration');
  String get prescriptionsDurationHint => _t('prescriptions.duration_hint');
  String get prescriptionsRoute => _t('prescriptions.route');
  String get prescriptionsInstructions => _t('prescriptions.instructions');
  String get prescriptionsInstructionsHint =>
      _t('prescriptions.instructions_hint');
  String get prescriptionsQty => _t('prescriptions.qty');
  String prescriptionsMedicineIndex(int n) =>
      '${_t('prescriptions.medicine_index_prefix')} $n';
  String get prescriptionsBpSystolic => _t('prescriptions.bp_systolic');
  String get prescriptionsBpDiastolic => _t('prescriptions.bp_diastolic');
  String get prescriptionsPulse => _t('prescriptions.pulse');
  String get prescriptionsTemp => _t('prescriptions.temp');
  String get prescriptionsSpo2 => _t('prescriptions.spo2');
  String get prescriptionsWeight => _t('prescriptions.weight');
  String get prescriptionsBloodSugar => _t('prescriptions.blood_sugar');
  String get prescriptionsNoneYet => _t('prescriptions.none_yet');
  String get prescriptionsOrderedChip => _t('prescriptions.ordered_chip');
  String get prescriptionsDetailDiagnosis =>
      _t('prescriptions.detail.diagnosis');
  String get prescriptionsDetailMedications =>
      _t('prescriptions.detail.medications');

  // ── Patient records (doctor) ───────────────────────────────────────
  String get patientRecordsTitle => _t('patient_records.title');
  String get patientRecordsSearchHint => _t('patient_records.search_hint');
  String get patientRecordsClearTooltip =>
      _t('patient_records.clear_tooltip');
  String get patientRecordsRetry => _t('patient_records.retry');
  String get patientRecordsNoFound => _t('patient_records.no_found');
  String get patientRecordsEmpty => _t('patient_records.empty');
  String get patientRecordsEmptyBody => _t('patient_records.empty_body');
  String get patientRecordsDetails => _t('patient_records.details');
  String get patientRecordsUnknownPatient =>
      _t('patient_records.unknown_patient');

  // ── Appointment queue ──────────────────────────────────────────────
  String get apptQueueTitle => _t('appt_queue.title');
  String get apptQueueWalkIn => _t('appt_queue.walk_in');
  String apptQueueTabToday(int count) =>
      '${_t('appt_queue.tab.today_prefix')} ($count)';
  String apptQueueTabPending(int count) =>
      '${_t('appt_queue.tab.pending_prefix')} ($count)';
  String get apptQueueNoToday => _t('appt_queue.no_today');
  String get apptQueueAllConfirmed => _t('appt_queue.all_confirmed');
  String get apptQueueConfirmTitle => _t('appt_queue.confirm_title');
  String get apptQueueChangeDate => _t('appt_queue.change_date');
  String get apptQueueChangeTime => _t('appt_queue.change_time');
  String get apptQueueNotesOptional => _t('appt_queue.notes_optional');
  String get apptQueueConfirmAppointment =>
      _t('appt_queue.confirm_appointment');
  // REVIEW: clinical-action confirmation
  String get apptQueueConfirmedToast => _t('appt_queue.confirmed_toast');
  String apptQueueFailedPrefix(String e) =>
      '${_t('appt_queue.failed_prefix')} $e';
  String get apptQueueNoShowTitle => _t('appt_queue.no_show_title');
  String apptQueueNoShowBody(String name) =>
      '$name ${_t('appt_queue.no_show_body_suffix')}';
  String get apptQueueMarkNoShow => _t('appt_queue.mark_no_show');
  // REVIEW: clinical-action confirmation
  String get apptQueueNoShowMarked => _t('appt_queue.no_show_marked');
  String get apptQueueCompleteTitle => _t('appt_queue.complete_title');
  String apptQueueCompleteBody(String name) =>
      '${_t('appt_queue.complete_body_prefix')} $name ${_t('appt_queue.complete_body_suffix')}';
  String get apptQueueCompleteAction => _t('appt_queue.complete_action');
  // REVIEW: clinical-action confirmation
  String get apptQueueCompletedToast => _t('appt_queue.completed_toast');
  String get apptQueueRxPromptTitle => _t('appt_queue.rx_prompt_title');
  String get apptQueueRxPromptBody => _t('appt_queue.rx_prompt_body');
  String get apptQueueSkip => _t('appt_queue.skip');
  String get apptQueueUploadDoc => _t('appt_queue.upload_doc');
  String get apptQueueEPrescription => _t('appt_queue.e_prescription');
  String get apptQueueUploadDocument => _t('appt_queue.upload_document');
  String get apptQueueDocType => _t('appt_queue.doc_type');
  String get apptQueueAttachFilePick => _t('appt_queue.attach_file_pick');
  String get apptQueueCamera => _t('appt_queue.camera');
  // REVIEW: clinical-action confirmation
  String get apptQueueDocUploaded => _t('appt_queue.doc_uploaded');
  String apptQueueUploadFailed(String e) =>
      '${_t('appt_queue.upload_failed_prefix')} $e';
  String get apptQueueRegisterWalkIn => _t('appt_queue.register_walk_in');
  String get apptQueuePatientPhone => _t('appt_queue.patient_phone');
  String get apptQueuePatientPhoneRequired =>
      _t('appt_queue.patient_phone_required');
  String get apptQueuePatientName => _t('appt_queue.patient_name');
  String get apptQueueDepartment => _t('appt_queue.department');
  String get apptQueueReason => _t('appt_queue.reason');
  String get apptQueueReasonHint => _t('appt_queue.reason_hint');
  String apptQueueWalkInRegistered(Object token) =>
      '${_t('appt_queue.walk_in_registered_prefix')} #$token';
  String get apptQueueRetry => _t('appt_queue.retry');
  String get apptQueueClose => _t('appt_queue.close');
  String get apptQueueActionConfirm => _t('appt_queue.action.confirm');
  String get apptQueueActionComplete => _t('appt_queue.action.complete');
  String get apptQueueActionNoShow => _t('appt_queue.action.no_show');
  String get apptQueueActionUploadDoc =>
      _t('appt_queue.action.upload_doc');
  String get apptQueueCallConfirm => _t('appt_queue.call_confirm');
  String get apptQueueSlaBreached => _t('appt_queue.sla_breached');
  String apptQueueBookedAgo(String ago) =>
      '${_t('appt_queue.booked_prefix')} $ago';
  String get apptQueuePatientFallback => _t('appt_queue.patient_fallback');

  // ── Admission screen ───────────────────────────────────────────────
  String get admissionTitle => _t('admission.title');
  String get admissionAdmit => _t('admission.admit');
  String get admissionAdmitPatient => _t('admission.admit_patient');
  String get admissionPatientLabel => _t('admission.patient_label');
  String get admissionRequired => _t('admission.required');
  String get admissionChiefComplaint => _t('admission.chief_complaint');
  String get admissionDiagnosis => _t('admission.diagnosis');
  String get admissionWard => _t('admission.ward');
  String get admissionBedNumber => _t('admission.bed_number');
  String get admissionPriorityLabel => _t('admission.priority_label');
  String get admissionPriorityRoutine => _t('admission.priority.routine');
  String get admissionPriorityUrgent => _t('admission.priority.urgent');
  String get admissionPriorityEmergency =>
      _t('admission.priority.emergency');
  String get admissionPriorityCritical =>
      _t('admission.priority.critical');
  String get admissionCodeStatus => _t('admission.code_status');
  String get admissionCodeFull => _t('admission.code.full');
  String get admissionCodeDnr => _t('admission.code.dnr');
  String get admissionCodeDnrDni => _t('admission.code.dnr_dni');
  String get admissionCodeComfort => _t('admission.code.comfort');
  // REVIEW: clinical-action confirmation
  String get admissionAdmittedSuccess =>
      _t('admission.admitted_success');
  String admissionFailed(String e) =>
      '${_t('admission.failed_prefix')} $e';
  String get admissionNoActive => _t('admission.no_active');
  String get admissionPatientInformation =>
      _t('admission.patient_information');
  String get admissionDetails => _t('admission.details');
  String get admissionQuickActions => _t('admission.quick_actions');
  String get admissionUid => _t('admission.uid');
  String get admissionAgeGender => _t('admission.age_gender');
  String get admissionBloodGroup => _t('admission.blood_group');
  String get admissionAllergies => _t('admission.allergies');
  String get admissionWardField => _t('admission.ward_field');
  String get admissionBedField => _t('admission.bed_field');
  String get admissionAdmittedOn => _t('admission.admitted_on');
  String get admissionDiagnosisField => _t('admission.diagnosis_field');
  String get admissionPriorityField => _t('admission.priority_field');
  String get admissionAttending => _t('admission.attending');
  String get admissionActionVitals => _t('admission.action.vitals');
  String get admissionActionNotes => _t('admission.action.notes');
  String get admissionActionOrders => _t('admission.action.orders');
  String get admissionActionTimeline => _t('admission.action.timeline');
  String get admissionRetry => _t('admission.retry');
  String admissionNumber(int id) =>
      '${_t('admission.number_prefix')} #$id';
  String get admissionPatientFallback => _t('admission.patient_fallback');

  // ── Patient timeline screen ────────────────────────────────────────
  String get timelineTitle => _t('timeline.title');
  String timelineTitleWithName(String name) =>
      '${_t('timeline.title_prefix')} - $name';
  String get timelineRetry => _t('timeline.retry');
  String get timelineNoEvents => _t('timeline.no_events');
  String get timelineFilterAll => _t('timeline.filter.all');
  String get timelineFilterAdmission => _t('timeline.filter.admission');
  String get timelineFilterVitals => _t('timeline.filter.vitals');
  String get timelineFilterNote => _t('timeline.filter.note');
  String get timelineFilterOrder => _t('timeline.filter.order');
  String get timelineFilterMedication =>
      _t('timeline.filter.medication');
  String get timelineFilterInvestigation =>
      _t('timeline.filter.investigation');
  String get timelineFilterDischarge => _t('timeline.filter.discharge');
  String get timelineEventFallback => _t('timeline.event_fallback');
  String timelineEventTitle(String type) =>
      '${type.toUpperCase()} ${_t('timeline.event_title_suffix')}';
  String get timelineByPrefix => _t('timeline.by_prefix');
  String get timelineDepartment => _t('timeline.department');
  String get timelineDetails => _t('timeline.details');

  // ── Orders screen ──────────────────────────────────────────────────
  String get ordersTitle => _t('orders.title');
  String ordersTitleWithName(String name) =>
      '${_t('orders.title_prefix')} - $name';
  String get ordersNewOrder => _t('orders.new_order');
  String get ordersTypeMedication => _t('orders.type.medication');
  String get ordersTypeInvestigation =>
      _t('orders.type.investigation');
  String get ordersTypeNursing => _t('orders.type.nursing');
  String get ordersMedicationName => _t('orders.medication_name');
  String get ordersDosage => _t('orders.dosage');
  String get ordersRoute => _t('orders.route');
  String get ordersRouteHint => _t('orders.route_hint');
  String get ordersFrequency => _t('orders.frequency');
  String get ordersFrequencyHint => _t('orders.frequency_hint');
  String get ordersDuration => _t('orders.duration');
  String get ordersDurationHint => _t('orders.duration_hint');
  String get ordersSpecialInstructions =>
      _t('orders.special_instructions');
  // REVIEW: clinical urgency wording
  String get ordersStatImmediate => _t('orders.stat_immediate');
  String get ordersInvestigation => _t('orders.investigation');
  String get ordersInvestigationHint => _t('orders.investigation_hint');
  String get ordersClinicalIndication =>
      _t('orders.clinical_indication');
  String get ordersPriority => _t('orders.priority');
  String get ordersPriorityRoutine => _t('orders.priority.routine');
  String get ordersPriorityUrgent => _t('orders.priority.urgent');
  String get ordersPriorityStat => _t('orders.priority.stat');
  String get ordersFastingRequired => _t('orders.fasting_required');
  String get ordersDescription => _t('orders.description');
  String get ordersDescriptionHint => _t('orders.description_hint');
  String get ordersFrequencyHintNursing =>
      _t('orders.frequency_hint_nursing');
  String get ordersPlaceOrder => _t('orders.place_order');
  // REVIEW: clinical-action confirmation
  String get ordersPlacedSuccess => _t('orders.placed_success');
  String ordersPlaceFailed(String e) =>
      '${_t('orders.place_failed_prefix')} $e';
  String get ordersClinicalAlerts => _t('orders.clinical_alerts');
  String get ordersProceedAnyway => _t('orders.proceed_anyway');
  String get ordersFilterAll => _t('orders.filter.all');
  String get ordersFilterOrdered => _t('orders.filter.ordered');
  String get ordersFilterVerified => _t('orders.filter.verified');
  String get ordersFilterCompleted => _t('orders.filter.completed');
  String get ordersFilterCancelled => _t('orders.filter.cancelled');
  String get ordersNoFound => _t('orders.no_found');
  String get ordersFallback => _t('orders.fallback');
  String get ordersVerify => _t('orders.verify');
  String get ordersComplete => _t('orders.complete');
  // REVIEW: clinical-action confirmation
  String get ordersVerifiedToast => _t('orders.verified_toast');
  String ordersVerifyFailed(String e) =>
      '${_t('orders.verify_failed_prefix')} $e';
  // REVIEW: clinical-action confirmation
  String get ordersCompletedToast => _t('orders.completed_toast');
  String ordersCompleteFailed(String e) =>
      '${_t('orders.complete_failed_prefix')} $e';
  String get ordersRetry => _t('orders.retry');

  // ── Vitals chart screen ────────────────────────────────────────────
  String get vitalsChartTitle => _t('vitals_chart.title');
  String vitalsChartTitleWithName(String name) =>
      '${_t('vitals_chart.title_prefix')} - $name';
  String get vitalsChartTabRecord => _t('vitals_chart.tab.record');
  String get vitalsChartTabLast24h => _t('vitals_chart.tab.last_24h');
  String get vitalsChartTabIoBalance =>
      _t('vitals_chart.tab.io_balance');
  String get vitalsChartRecordVitals =>
      _t('vitals_chart.record_vitals');
  String get vitalsChartHeartRate => _t('vitals_chart.heart_rate');
  String get vitalsChartBpSys => _t('vitals_chart.bp_sys');
  String get vitalsChartBpDia => _t('vitals_chart.bp_dia');
  String get vitalsChartTemp => _t('vitals_chart.temp');
  String get vitalsChartSpo2 => _t('vitals_chart.spo2');
  String get vitalsChartRespRate => _t('vitals_chart.resp_rate');
  String get vitalsChartGlucose => _t('vitals_chart.glucose');
  String get vitalsChartPain => _t('vitals_chart.pain');
  String get vitalsChartGcs => _t('vitals_chart.gcs');
  String get vitalsChartConsciousness =>
      _t('vitals_chart.consciousness');
  String get vitalsChartConsciousAlert =>
      _t('vitals_chart.conscious.alert');
  String get vitalsChartConsciousVerbal =>
      _t('vitals_chart.conscious.verbal');
  String get vitalsChartConsciousPain =>
      _t('vitals_chart.conscious.pain');
  String get vitalsChartConsciousUnresp =>
      _t('vitals_chart.conscious.unresp');
  String get vitalsChartSaveButton => _t('vitals_chart.save_button');
  String get vitalsChartAtLeastOne => _t('vitals_chart.at_least_one');
  // REVIEW: clinical-action confirmation
  String get vitalsChartRecordedSuccess =>
      _t('vitals_chart.recorded_success');
  String vitalsChartRecordFailed(String e) =>
      '${_t('vitals_chart.record_failed_prefix')} $e';
  String get vitalsChartRecordIo => _t('vitals_chart.record_io');
  String get vitalsChartIntake => _t('vitals_chart.intake');
  String get vitalsChartOutput => _t('vitals_chart.output');
  String get vitalsChartCategory => _t('vitals_chart.category');
  String get vitalsChartIntakeOral => _t('vitals_chart.intake.oral');
  String get vitalsChartIntakeIv => _t('vitals_chart.intake.iv');
  String get vitalsChartIntakeBlood => _t('vitals_chart.intake.blood');
  String get vitalsChartIntakeNg => _t('vitals_chart.intake.ng');
  String get vitalsChartCatOther => _t('vitals_chart.cat.other');
  String get vitalsChartOutputUrine => _t('vitals_chart.output.urine');
  String get vitalsChartOutputDrain => _t('vitals_chart.output.drain');
  String get vitalsChartOutputEmesis =>
      _t('vitals_chart.output.emesis');
  String get vitalsChartOutputStool => _t('vitals_chart.output.stool');
  String get vitalsChartOutputBloodLoss =>
      _t('vitals_chart.output.blood_loss');
  String get vitalsChartAmount => _t('vitals_chart.amount');
  String get vitalsChartIoDescription =>
      _t('vitals_chart.io_description');
  String get vitalsChartIoRecord => _t('vitals_chart.io_record');
  // REVIEW: clinical-action confirmation
  String get vitalsChartIoSuccess => _t('vitals_chart.io_success');
  String vitalsChartIoFailed(String e) =>
      '${_t('vitals_chart.io_failed_prefix')} $e';
  String get vitalsChartRetry => _t('vitals_chart.retry');
  String get vitalsChartNoVitals => _t('vitals_chart.no_vitals');
  String get vitalsChartColTime => _t('vitals_chart.col.time');
  String get vitalsChartColHr => _t('vitals_chart.col.hr');
  String get vitalsChartColBp => _t('vitals_chart.col.bp');
  String get vitalsChartColTemp => _t('vitals_chart.col.temp');
  String get vitalsChartColSpo2 => _t('vitals_chart.col.spo2');
  String get vitalsChartColRr => _t('vitals_chart.col.rr');
  String get vitalsChartColGlucose => _t('vitals_chart.col.glucose');
  String get vitalsChartColPain => _t('vitals_chart.col.pain');
  String get vitalsChartColGcs => _t('vitals_chart.col.gcs');
  String get vitalsChartColAvpu => _t('vitals_chart.col.avpu');
  String get vitalsChartIntakeLabel =>
      _t('vitals_chart.intake_label');
  String get vitalsChartOutputLabel =>
      _t('vitals_chart.output_label');
  String get vitalsChartBalanceLabel =>
      _t('vitals_chart.balance_label');
  String get vitalsChartRecordIoEntry =>
      _t('vitals_chart.record_io_entry');
  String get vitalsChartTodayEntries =>
      _t('vitals_chart.today_entries');
  String get vitalsChartNoIoToday => _t('vitals_chart.no_io_today');
  String vitalsChartRecordForName(String name) =>
      '${_t('vitals_chart.record_for_prefix')} $name';
  String get vitalsChartRecordPatient =>
      _t('vitals_chart.record_patient');
  String get vitalsChartRecordNow => _t('vitals_chart.record_now');

  // ── Clinical notes screen ──────────────────────────────────────────
  String get clinicalNotesTitle => _t('clinical_notes.title');
  String clinicalNotesTitleWithName(String name) =>
      '${_t('clinical_notes.title_prefix')} - $name';
  String get clinicalNotesTabSoap => _t('clinical_notes.tab.soap');
  String get clinicalNotesTabProgress =>
      _t('clinical_notes.tab.progress');
  String get clinicalNotesTabProcedure =>
      _t('clinical_notes.tab.procedure');
  String get clinicalNotesNewNote => _t('clinical_notes.new_note');
  String get clinicalNotesSigned => _t('clinical_notes.signed');
  String get clinicalNotesUnsigned => _t('clinical_notes.unsigned');
  String get clinicalNotesRetry => _t('clinical_notes.retry');
  String clinicalNotesNoFound(String type) =>
      '${_t('clinical_notes.no_found_prefix')} $type ${_t('clinical_notes.no_found_suffix')}';
  String get clinicalNotesSignNote => _t('clinical_notes.sign_note');
  // REVIEW: clinical-action confirmation
  String get clinicalNotesSignedSuccess =>
      _t('clinical_notes.signed_success');
  String clinicalNotesSignFailed(String e) =>
      '${_t('clinical_notes.sign_failed_prefix')} $e';
  String get clinicalNotesNoteFallback =>
      _t('clinical_notes.note_fallback');
  String get clinicalNotesUnknownAuthor =>
      _t('clinical_notes.unknown_author');
  String get clinicalNotesSubjective =>
      _t('clinical_notes.subjective');
  String get clinicalNotesObjective => _t('clinical_notes.objective');
  String get clinicalNotesAssessment =>
      _t('clinical_notes.assessment');
  String get clinicalNotesPlan => _t('clinical_notes.plan');
  String get clinicalNotesContent => _t('clinical_notes.content');
  String get clinicalNotesFindings => _t('clinical_notes.findings');
  String get clinicalNotesProcedureDetails =>
      _t('clinical_notes.procedure_details');
  String get clinicalNotesComplications =>
      _t('clinical_notes.complications');
  String get clinicalNotesNewSoap => _t('clinical_notes.new_soap');
  String get clinicalNotesNewProgress =>
      _t('clinical_notes.new_progress');
  String get clinicalNotesNewProcedure =>
      _t('clinical_notes.new_procedure');
  String get clinicalNotesSubjectiveHint =>
      _t('clinical_notes.subjective_hint');
  String get clinicalNotesObjectiveHint =>
      _t('clinical_notes.objective_hint');
  String get clinicalNotesAssessmentHint =>
      _t('clinical_notes.assessment_hint');
  String get clinicalNotesPlanHint => _t('clinical_notes.plan_hint');
  String get clinicalNotesTitleField =>
      _t('clinical_notes.title_field');
  String get clinicalNotesContentHint =>
      _t('clinical_notes.content_hint');
  String get clinicalNotesProcedureName =>
      _t('clinical_notes.procedure_name');
  String get clinicalNotesProcedureDetailsHint =>
      _t('clinical_notes.procedure_details_hint');
  String get clinicalNotesFindingsHint =>
      _t('clinical_notes.findings_hint');
  String get clinicalNotesComplicationsHint =>
      _t('clinical_notes.complications_hint');
  String get clinicalNotesRequired => _t('clinical_notes.required');
  String get clinicalNotesSaveNote => _t('clinical_notes.save_note');
  // REVIEW: clinical-action confirmation
  String get clinicalNotesCreatedSuccess =>
      _t('clinical_notes.created_success');
  String clinicalNotesCreateFailed(String e) =>
      '${_t('clinical_notes.create_failed_prefix')} $e';

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
      'login.app_title': 'VHHealth Staff',
      'login.portal_subtitle': 'Hospital Staff Portal',
      'login.screen_title': 'Sign In',
      'login.screen_subtitle':
          'Use your employee credentials to access the portal',
      'login.employee_id_hint': '1001',
      'login.employee_id_required': 'Employee number is required',
      'login.employee_id_numbers_only': 'Numbers only (1–6 digits)',
      'login.mode.password': 'Password',
      'login.mode.pin': 'PIN',
      'login.mode.quick': 'Quick',
      'login.pin_field_label': 'PIN',
      'login.pin_hint': '4–6 digits',
      'login.pin_required': 'PIN required',
      'login.pin_min_digits': 'Minimum 4 digits',
      'login.quick_pin_label': 'PIN (or use biometric)',
      'login.quick_pin_hint': 'Enter PIN for quick access',
      'login.remember_employee_id': 'Remember Employee ID',
      'login.locked_title': 'Account temporarily locked',
      'login.locked_hint':
          'Too many failed attempts. Try again in 15 minutes or contact your supervisor.',
      'login.sign_in_with_password': 'Sign In with Password',
      'login.sign_in_with_pin': 'Sign In with PIN',
      'login.quick_sign_in': 'Quick Sign In',
      'login.footer': 'VHHealth · Staff Access Only',
      // Dashboard (additional)
      'dashboard.welcome_back': 'Welcome back',
      'dashboard.see_all': 'See all',
      'dashboard.all_features': 'All Features',
      'dashboard.recent_activity': 'Recent Activity',
      'dashboard.checked_in_title': 'Checked In',
      'dashboard.not_checked_in_title': 'Not Checked In',
      'dashboard.since_time_prefix': 'Since',
      'dashboard.tap_to_manage': 'Tap to manage attendance',
      'dashboard.new_live_notification.one': 'new live notification',
      'dashboard.new_live_notification.other': 'new live notifications',
      'dashboard.sync_pending.one': 'item pending sync',
      'dashboard.sync_pending.other': 'items pending sync',
      'dashboard.action.check_in_out': 'Check In/Out',
      'dashboard.action.shift_schedule': 'Shift Schedule',
      'dashboard.action.messages': 'Messages',
      'dashboard.action.prescriptions': 'Prescriptions',
      'dashboard.action.investigations': 'Investigations',
      'dashboard.action.vitals': 'Vitals',
      'dashboard.action.handover': 'Handover',
      'dashboard.action.pharmacy': 'Pharmacy',
      'dashboard.action.upload_results': 'Upload Results',
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
      'attendance.tab.today': 'Today',
      'attendance.tab.calendar': 'Calendar',
      'attendance.tab.history': 'History',
      'attendance.checked_in_badge': '🟢 Checked In',
      'attendance.not_checked_in_badge': '⚪ Not Checked In',
      'attendance.checked_in_success': 'Checked in successfully',
      'attendance.checked_out_success': 'Checked out successfully',
      'attendance.getting_location': 'Getting location...',
      'attendance.processing': 'Processing...',
      'attendance.location_verify_hint':
          '📍 Location will be verified on check-in',
      'attendance.report_issue': 'Report Attendance Issue',
      'attendance.legend.present': 'Present',
      'attendance.legend.absent': 'Absent',
      'attendance.legend.leave': 'Leave',
      'attendance.legend.late': 'Late',
      'attendance.check_in_label': 'Check-in',
      'attendance.check_out_label': 'Check-out',
      'attendance.hours_label': 'Hours',
      'attendance.late_arrival': '⚠️ Late arrival',
      'attendance.no_history': 'No attendance history',
      'attendance.history.absent': 'Absent',
      'attendance.history.in_prefix': 'In:',
      'attendance.history.out_prefix': 'Out:',
      'attendance.outside_campus.distance_prefix': '❌ Outside campus',
      'attendance.outside_campus.distance_suffix':
          'away. Attendance can only be marked on campus.',
      // Settings
      'settings.title': 'Settings',
      'settings.section.appearance': 'Appearance',
      'settings.section.notifications': 'Notifications',
      'settings.section.security': 'Security',
      'settings.section.quick_links': 'Quick Links',
      'settings.section.about': 'About',
      'settings.theme.title': 'Theme',
      'settings.theme.system': 'System',
      'settings.theme.light': 'Light',
      'settings.theme.dark': 'Dark',
      'settings.theme.subtitle_system': 'Follow system setting',
      'settings.theme.subtitle_light': 'Always light',
      'settings.theme.subtitle_dark': 'Always dark',
      'settings.push_notifications': 'Push Notifications',
      'settings.push_notifications.subtitle':
          'Attendance reminders, appointment alerts',
      'settings.shift_reminders': 'Shift Reminders',
      'settings.shift_reminders.subtitle':
          'Get notified before shift starts',
      'settings.setup_pin': 'Set Up PIN',
      'settings.setup_pin.subtitle':
          'Set or update your 4–6 digit quick-access PIN',
      'settings.setup_pin.dialog_title': 'Set Up PIN',
      'settings.setup_pin.dialog_label': 'Enter 4–6 digit PIN',
      'settings.setup_pin.success': '✅ PIN set up successfully',
      'settings.biometric.title': 'Biometric Login',
      'settings.biometric.subtitle': 'Use fingerprint or face to sign in',
      'settings.biometric.enabled': '✅ Biometric enabled',
      'settings.biometric.disabled': 'Biometric disabled',
      'settings.manage_devices': 'Manage Devices',
      'settings.manage_devices.subtitle':
          'View and remove registered devices',
      'settings.registered_devices': 'Registered Devices',
      'settings.no_devices': 'No devices registered',
      'settings.unknown_device': 'Unknown Device',
      'settings.device_removed': '✅ Device removed',
      'settings.quick_link.profile': 'Profile',
      'settings.quick_link.profile.subtitle':
          'View and edit your staff profile',
      'settings.quick_link.attendance': 'Attendance',
      'settings.quick_link.attendance.subtitle':
          'Check in/out and view history',
      'settings.quick_link.leave': 'Leave',
      'settings.quick_link.leave.subtitle':
          'Apply for leave and check balance',
      'settings.about.title': 'About VHHealth Staff',
      'settings.about.subtitle': 'Version 1.0.0 · App info & features',
      'settings.logout.dialog_title': 'Logout',
      'settings.logout.dialog_body': 'Are you sure you want to logout?',
      // Profile
      'profile.title': 'My Profile',
      'profile.edit_tooltip': 'Edit',
      'profile.cancel_tooltip': 'Cancel',
      'profile.fallback_name': 'Staff Member',
      'profile.emp_id_prefix': 'EMP:',
      'profile.info_title': 'Staff Information',
      'profile.edit_title': 'Edit Profile',
      'profile.field.employee_id': 'Employee ID',
      'profile.field.role': 'Role',
      'profile.field.department': 'Department',
      'profile.field.phone': 'Phone',
      'profile.field.email': 'Email',
      'profile.field.address': 'Address',
      'profile.field.shift': 'Shift',
      'profile.field.joining_date': 'Joining Date',
      'profile.saving_button': 'Saving...',
      'profile.save_changes': 'Save Changes',
      'profile.updated_success': '✅ Profile updated successfully',
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
      'notifications.mark_all_read': 'Mark all read',
      'notifications.live_update': 'Live Update',
      'messaging.inbox_title': 'Messages',
      'messaging.empty': 'No messages',
      'messaging.empty_body': 'Start a thread from the staff directory.',
      'messaging.new_message': 'New Message',
      'messaging.type_hint': 'Type a message...',
      'messaging.send': 'Send',
      'messaging.set_priority': 'Set priority',
      'messaging.send_failed_prefix': 'Failed to send:',
      'messaging.thread_load_failed': 'Failed to load conversation',
      'messaging.thread_empty_title': 'No messages yet',
      'messaging.thread_empty_body': 'Start the conversation below',
      // Time helpers
      'time.just_now': 'Just now',
      'time.yesterday': 'Yesterday',
      'time.today': 'Today',
      'time.minutes_ago_suffix': 'm ago',
      'time.hours_ago_suffix': 'h ago',
      'time.days_ago_suffix': 'd ago',
      // Priority / Urgency
      'priority.low': 'Low',
      'priority.normal': 'Normal',
      'priority.high': 'High',
      'priority.urgent': 'Urgent',
      'priority.critical': 'Critical',
      'urgency.low': 'Low',
      'urgency.normal': 'Normal',
      'urgency.high': 'High',
      'urgency.critical': 'Critical',
      // Departments
      'department.general': 'General',
      'department.emergency': 'Emergency',
      'department.icu': 'ICU',
      'department.pediatrics': 'Pediatrics',
      'department.surgery': 'Surgery',
      'department.outpatient': 'Outpatient',
      // About
      'about.title': 'About',
      'about.header': 'About',
      'about.app_name': 'VHHealth Staff',
      'about.version': 'Version 1.0.0',
      'about.description':
          'A hospital staff management app by VH Health. Manage attendance, leave, appointments, and more — all from your mobile device.',
      'about.features_header': 'Features',
      'about.support_header': 'Support',
      'about.support_email_label': 'Email',
      'about.website_label': 'Website',
      'about.copyright': '© 2026 VH Health. All rights reserved.',
      'about.feature.attendance.title': 'Attendance',
      'about.feature.attendance.description':
          'Clock in/out with location tracking',
      'about.feature.leave.title': 'Leave Management',
      'about.feature.leave.description': 'Apply for leave and track balances',
      'about.feature.appointments.title': 'Appointments',
      'about.feature.appointments.description':
          'View and manage patient appointments',
      'about.feature.investigations.title': 'Investigations',
      'about.feature.investigations.description':
          'Lab tests and diagnostic reports',
      'about.feature.pharmacy.title': 'Pharmacy',
      'about.feature.pharmacy.description':
          'Prescription and dispensing workflow',
      'about.feature.staff_directory.title': 'Staff Directory',
      'about.feature.staff_directory.description': 'Find and contact colleagues',
      'about.feature.clinical_modules.title': 'Clinical Modules',
      'about.feature.clinical_modules.description':
          'Vitals, nursing notes, prescriptions',
      // Leave (additional)
      'leave.type.annual': 'Annual',
      'leave.type.sick': 'Sick',
      'leave.type.casual': 'Casual',
      'leave.type.emergency': 'Emergency',
      'leave.type.maternity': 'Maternity',
      'leave.type.paternity': 'Paternity',
      'leave.type.unpaid': 'Unpaid',
      'leave.balance.used': 'Used',
      'leave.leave_type_label': 'Leave Type',
      'leave.dates_label': 'Dates',
      'leave.start_date': 'Start Date',
      'leave.end_date': 'End Date',
      'leave.reason_label': 'Reason',
      'leave.reason_hint': 'Brief reason for leave',
      'leave.replacement_staff_label': 'Replacement Staff (Optional)',
      'leave.replacement_staff_hint': 'Select a colleague to cover for you',
      'leave.replacement_staff_pick': 'Tap to select replacement',
      'leave.select_replacement': 'Select Replacement Staff',
      'leave.no_staff_available': 'No staff available',
      'leave.search_by_type_hint': 'Search by leave type…',
      'leave.no_applications': 'No leave applications',
      'leave.no_replacement_requests': 'No pending replacement requests',
      'leave.requester_unknown': 'Unknown',
      'leave.requesting_coverage_for': 'Requesting coverage for:',
      'leave.error.select_dates': 'Please select dates',
      'leave.error.provide_reason': 'Please provide a reason',
      'leave.overtime_title': 'Overtime Request',
      'leave.overtime_subtitle': 'Log extra hours worked',
      'leave.dispute_title': 'Attendance Dispute',
      'leave.dispute_subtitle': 'Report a recording issue',
      'leave.action.decline': 'Decline',
      'leave.action.accept': 'Accept',
      'leave.request_accepted': '✅ Request accepted',
      'leave.request_declined': '❌ Request declined',
      'leave.day_count.one': 'day',
      'leave.day_count.other': 'days',
      // Bed sheet (additional)
      'bed_sheet.field.name': 'Name',
      'bed_sheet.field.age': 'Age',
      'bed_sheet.field.gender': 'Gender',
      'bed_sheet.field.phone': 'Phone',
      'bed_sheet.field.chief_complaint': 'Chief complaint',
      'bed_sheet.field.diagnosis': 'Diagnosis',
      'bed_sheet.field.type': 'Type',
      'bed_sheet.field.attending': 'Attending',
      'bed_sheet.field.admitted': 'Admitted',
      'bed_sheet.year_suffix': 'yr',
      'bed_sheet.doctor_prefix': 'Dr.',
      'bed_sheet.patient_details_unavailable':
          'Patient details unavailable for this bed.',
      'bed_sheet.no_patient_assigned': 'No patient currently assigned.',
      'bed_sheet.saving_label': 'Saving…',
      'bed_sheet.quick_note_hint': 'Quick note (handover, hazards, IV site…)',
      'bed_sheet.dictate_quick_note': 'Dictate quick note',
      'bed_sheet.this_patient': 'this patient',
      'bed_sheet.patient_discharged': 'Patient discharged',
      'bed_sheet.patient_missing_name': 'Patient missing name',
      'bed_sheet.patient_admitted_suffix': 'admitted to this bed',
      'bed_sheet.marked_as_prefix': 'Bed marked as',
      // Vitals
      'vitals.title': 'Vitals Entry',
      'vitals.tab.record': 'Record Vitals',
      'vitals.tab.recent': 'Recent Vitals',
      'vitals.header_title': 'Record Patient Vitals',
      'vitals.header_subtitle': 'Enter vitals by patient ID',
      'vitals.patient_id_label': 'Patient ID',
      'vitals.patient_id_hint': 'Enter patient ID',
      'vitals.patient_id_required': 'Patient ID is required',
      'vitals.patient_id_invalid': 'Enter a valid number',
      'vitals.bp_header': 'Blood Pressure',
      'vitals.bp_systolic': 'Systolic',
      'vitals.bp_systolic_hint': 'e.g. 120',
      'vitals.bp_diastolic': 'Diastolic',
      'vitals.bp_diastolic_hint': 'e.g. 80',
      'vitals.temperature_header': 'Temperature',
      'vitals.temperature_hint': 'e.g. 98.6',
      'vitals.pulse_spo2_header': 'Pulse & Oxygen Saturation',
      'vitals.pulse_label': 'Pulse',
      'vitals.pulse_hint': 'e.g. 72',
      'vitals.spo2_label': 'SpO₂',
      'vitals.spo2_hint': 'e.g. 98',
      'vitals.weight_header': 'Weight',
      'vitals.weight_hint': 'e.g. 70.5',
      'vitals.nurse_notes_label': 'Nurse Notes (optional)',
      'vitals.nurse_notes_hint': 'Any observations or concerns...',
      'vitals.validation.invalid': 'Invalid',
      'vitals.save_button': 'Save Vitals',
      'vitals.fetch_button': 'Fetch',
      'vitals.trends_hint': 'Enter a patient ID to view vital trends',
      'vitals.no_records': 'No vital records found for this patient',
      'vitals.recorded_success': 'Vitals recorded successfully',
      'vitals.offline_queued':
          'No connection — vitals saved and will sync when online',
      // Nursing Notes
      'nursing_notes.title': 'Nursing Notes',
      'nursing_notes.tab.add': 'Add Note',
      'nursing_notes.tab.recent': 'Recent Notes',
      'nursing_notes.backend_coming_soon':
          'Backend integration coming soon. Notes are previewed locally.',
      'nursing_notes.patient_phone_label': 'Patient Phone Number',
      'nursing_notes.patient_phone_hint': '+91 XXXXX XXXXX',
      'nursing_notes.phone_required': 'Phone is required',
      'nursing_notes.phone_invalid': 'Enter valid phone number',
      'nursing_notes.type_label': 'Note Type',
      'nursing_notes.type_required': 'Select note type',
      'nursing_notes.priority_label': 'Priority',
      'nursing_notes.clinical_note_label': 'Clinical Note',
      'nursing_notes.clinical_note_hint':
          'Describe observations, care provided, patient response...',
      'nursing_notes.note_required': 'Note is required',
      'nursing_notes.note_too_short': 'Note is too short',
      'nursing_notes.save_button': 'Save Note',
      'nursing_notes.saved_success': 'Nursing note saved successfully',
      'nursing_notes.offline_queued': 'Saved offline — will sync when connected',
      'nursing_notes.recent_empty':
          'Your recent nursing notes will appear here once the backend API is connected.',
      'nursing_notes.type.observation': 'Observation',
      'nursing_notes.type.medication': 'Medication Note',
      'nursing_notes.type.post_procedure': 'Post-Procedure',
      'nursing_notes.type.intake_output': 'Intake/Output',
      'nursing_notes.type.patient_complaint': 'Patient Complaint',
      'nursing_notes.type.wound_care': 'Wound Care',
      'nursing_notes.type.shift_handover': 'Shift Handover',
      'nursing_notes.type.emergency_note': 'Emergency Note',
      'nursing_notes.type.other': 'Other',
      // Handover
      'handover.title': 'Handover Notes',
      'handover.tab.write': 'Write',
      'handover.tab.recent': 'Recent',
      'handover.department_label': 'Department',
      'handover.urgency_label': 'Urgency',
      'handover.notes_label': 'Handover Notes',
      'handover.notes_hint':
          'Key observations, pending tasks, medication changes...',
      'handover.notes_required': 'Notes required',
      'handover.patient_ref_label': 'Patient References (optional)',
      'handover.patient_ref_hint':
          'Room 201 - Mr. Sharma, Room 305 - Mrs. Patel',
      'handover.submit_button': 'Submit Handover',
      'handover.submitting_button': 'Submitting...',
      'handover.submitted': 'Handover note submitted',
      'handover.recent_empty_title': 'No recent handover notes',
      'handover.recent_empty_body':
          'Notes from the last 24 hours will appear here',
      'handover.note_fallback_title': 'Handover Note',
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
      // Bed Board (additions)
      'bed_board.no_wards_yet': 'No wards yet',
      'bed_board.ward_stat.total': 'Total',
      'bed_board.ward_stat.free': 'Free',
      'bed_board.ward_stat.used': 'Used',
      'bed_board.count.available_suffix': 'available',
      'bed_board.back_to_wards': 'Back to wards list',
      'bed_board.ward_fallback': 'Ward',
      'bed_board.print_tooltip': 'Print bed board',
      'bed_board.refresh_tooltip': 'Refresh bed board',
      'bed_board.print_failed_prefix': 'Print failed:',
      'bed_board.no_filtered_prefix': 'No',
      'bed_board.no_filtered_suffix': 'beds in this ward',
      'bed_board.admit_which_patient': 'Admit which patient?',
      'bed_board.admit_search_hint': 'Search by name, phone, or ABHA…',
      'bed_board.type_to_find_patient': 'Type to find a patient.',
      'bed_board.patient_unnamed': 'Unnamed',
      // Doctor queue
      'queue.title': 'Patient Queue',
      'queue.refresh_tooltip': 'Refresh queue',
      'queue.section.in_consultation': 'In Consultation',
      'queue.section.waiting_prefix': 'Waiting',
      'queue.section.completed_prefix': 'Completed',
      'queue.call_next_patient': 'Call Next Patient',
      'queue.complete_consultation': 'Complete Consultation',
      'queue.call_tooltip': 'Call',
      'queue.no_patients_waiting': 'No patients waiting',
      'queue.no_completed_consultations': 'No completed consultations',
      'queue.waiting_prefix': 'Waiting',
      'queue.in_prefix': 'In',
      'queue.patient_info': 'Patient Info',
      'queue.recent_records': 'Recent Records',
      'queue.no_health_records_found': 'No health records found',
      'queue.allergies_prefix': 'Allergies:',
      'queue.age_prefix': '• Age:',
      'queue.write_prescription': 'Write Prescription',
      'queue.order_investigation': 'Order Investigation',
      'queue.add_notes': 'Add Notes',
      'queue.no_phone_number': 'No phone number available',
      'queue.record_fallback': 'Record',
      'queue.unknown_patient': 'Unknown',
      // Prescriptions
      'prescriptions.title': 'E-Prescriptions',
      'prescriptions.tab.new': 'New Prescription',
      'prescriptions.tab.recent': 'Recent',
      'prescriptions.error.select_patient_doctor':
          'Please select patient and doctor',
      'prescriptions.error.fill_medication_names':
          'Please fill in all medication names',
      'prescriptions.photo.title': 'Prescription Photo',
      'prescriptions.photo.body': 'Take photo or choose from gallery?',
      'prescriptions.photo.camera': 'Camera',
      'prescriptions.photo.gallery': 'Gallery',
      'prescriptions.vitals_collapse': 'Vitals (optional)',
      'prescriptions.diagnosis_label': 'Diagnosis / Chief Complaint *',
      'prescriptions.diagnosis_required': 'Diagnosis is required',
      'prescriptions.medications_header': 'Medications *',
      'prescriptions.add_button': 'Add',
      'prescriptions.set_follow_up': 'Set Follow-up Date',
      'prescriptions.follow_up_prefix': 'Follow-up:',
      'prescriptions.clear_follow_up': 'Clear follow-up date',
      'prescriptions.follow_up_notes': 'Follow-up Notes',
      'prescriptions.follow_up_notes_hint': 'e.g. Bring blood reports',
      'prescriptions.clinical_notes': 'Clinical Notes / Advice',
      'prescriptions.clinical_notes_hint':
          'Rest, diet, follow-up instructions...',
      'prescriptions.photo_attached': 'Photo attached ✓',
      'prescriptions.attach_handwritten':
          'Attach Handwritten Prescription (optional)',
      'prescriptions.creating': 'Creating...',
      'prescriptions.create': 'Create Prescription',
      'prescriptions.created_prefix': 'Prescription',
      'prescriptions.created_suffix': 'created',
      'prescriptions.patient_label': 'Patient',
      'prescriptions.doctor_label': 'Doctor',
      'prescriptions.search_patient': 'Search Patient (phone/name)',
      'prescriptions.search_doctor': 'Search Doctor',
      'prescriptions.remove_medication': 'Remove medication',
      'prescriptions.medicine_name': 'Medicine Name *',
      'prescriptions.medicine_name_hint': 'Type to search (e.g. Dolo, Pan)',
      'prescriptions.dosage': 'Dosage',
      'prescriptions.dosage_hint': '500mg',
      'prescriptions.frequency': 'Frequency',
      'prescriptions.duration': 'Duration',
      'prescriptions.duration_hint': '5 days',
      'prescriptions.route': 'Route',
      'prescriptions.instructions': 'Instructions',
      'prescriptions.instructions_hint': 'After food',
      'prescriptions.qty': 'Qty',
      'prescriptions.medicine_index_prefix': 'Medicine',
      'prescriptions.bp_systolic': 'BP Systolic',
      'prescriptions.bp_diastolic': 'BP Diastolic',
      'prescriptions.pulse': 'Pulse',
      'prescriptions.temp': 'Temp',
      'prescriptions.spo2': 'SpO2',
      'prescriptions.weight': 'Weight',
      'prescriptions.blood_sugar': 'Blood Sugar',
      'prescriptions.none_yet': 'No prescriptions yet',
      'prescriptions.ordered_chip': 'Ordered',
      'prescriptions.detail.diagnosis': 'Diagnosis',
      'prescriptions.detail.medications': 'Medications',
      // Patient records (doctor)
      'patient_records.title': 'Patient Records',
      'patient_records.search_hint':
          'Search by patient name or type...',
      'patient_records.clear_tooltip': 'Clear search',
      'patient_records.retry': 'Retry',
      'patient_records.no_found': 'No records found',
      'patient_records.empty': 'No patient records',
      'patient_records.empty_body': 'Patient records will appear here',
      'patient_records.details': 'Record Details',
      'patient_records.unknown_patient': 'Unknown Patient',
      // Appointment queue
      'appt_queue.title': 'Appointment Queue',
      'appt_queue.walk_in': 'Walk-in',
      'appt_queue.tab.today_prefix': "Today's Queue",
      'appt_queue.tab.pending_prefix': 'Pending',
      'appt_queue.no_today': 'No appointments today',
      'appt_queue.all_confirmed': 'All appointments confirmed!',
      'appt_queue.confirm_title': 'Confirm Appointment',
      'appt_queue.change_date': 'Change Date',
      'appt_queue.change_time': 'Change Time',
      'appt_queue.notes_optional': 'Notes (optional)',
      'appt_queue.confirm_appointment': 'Confirm Appointment',
      'appt_queue.confirmed_toast': 'Appointment confirmed ✓',
      'appt_queue.failed_prefix': 'Failed:',
      'appt_queue.no_show_title': 'Mark as No-Show?',
      'appt_queue.no_show_body_suffix': 'did not show up?',
      'appt_queue.mark_no_show': 'Mark No-Show',
      'appt_queue.no_show_marked': 'Marked as no-show',
      'appt_queue.complete_title': 'Complete Appointment',
      'appt_queue.complete_body_prefix': 'Mark',
      'appt_queue.complete_body_suffix': 'as completed?',
      'appt_queue.complete_action': 'Complete',
      'appt_queue.completed_toast': 'Appointment completed ✓',
      'appt_queue.rx_prompt_title': 'Create E-Prescription?',
      'appt_queue.rx_prompt_body':
          'Create a structured e-prescription for this visit? The patient can order medicines directly from it.',
      'appt_queue.skip': 'Skip',
      'appt_queue.upload_doc': 'Upload Doc',
      'appt_queue.e_prescription': 'E-Prescription',
      'appt_queue.upload_document': 'Upload Document',
      'appt_queue.doc_type': 'Document Type',
      'appt_queue.attach_file_pick': 'Pick File',
      'appt_queue.camera': 'Camera',
      'appt_queue.doc_uploaded': 'Document uploaded ✓',
      'appt_queue.upload_failed_prefix': 'Upload failed:',
      'appt_queue.register_walk_in': 'Register Walk-in',
      'appt_queue.patient_phone': 'Patient Phone *',
      'appt_queue.patient_phone_required': 'Patient phone is required',
      'appt_queue.patient_name': 'Patient Name',
      'appt_queue.department': 'Department',
      'appt_queue.reason': 'Reason',
      'appt_queue.reason_hint': 'Walk-in consultation',
      'appt_queue.walk_in_registered_prefix': 'Walk-in registered! Token',
      'appt_queue.retry': 'Retry',
      'appt_queue.close': 'Close',
      'appt_queue.action.confirm': 'Confirm',
      'appt_queue.action.complete': 'Complete',
      'appt_queue.action.no_show': 'No-Show',
      'appt_queue.action.upload_doc': 'Upload Doc',
      'appt_queue.call_confirm': 'Call & Confirm',
      'appt_queue.sla_breached': 'SLA BREACHED',
      'appt_queue.booked_prefix': 'Booked',
      'appt_queue.patient_fallback': 'Patient',
      // Admission
      'admission.title': 'Admissions',
      'admission.admit': 'Admit',
      'admission.admit_patient': 'Admit Patient',
      'admission.patient_label': 'Patient (name, UID, or phone)',
      'admission.required': 'Required',
      'admission.chief_complaint': 'Chief Complaint',
      'admission.diagnosis': 'Provisional Diagnosis',
      'admission.ward': 'Ward',
      'admission.bed_number': 'Bed Number',
      'admission.priority_label': 'Priority',
      'admission.priority.routine': 'Routine',
      'admission.priority.urgent': 'Urgent',
      'admission.priority.emergency': 'Emergency',
      'admission.priority.critical': 'Critical',
      'admission.code_status': 'Code Status',
      'admission.code.full': 'Full Code',
      'admission.code.dnr': 'DNR',
      'admission.code.dnr_dni': 'DNR/DNI',
      'admission.code.comfort': 'Comfort Care',
      'admission.admitted_success': 'Patient admitted successfully',
      'admission.failed_prefix': 'Admission failed:',
      'admission.no_active': 'No active admissions',
      'admission.patient_information': 'Patient Information',
      'admission.details': 'Admission Details',
      'admission.quick_actions': 'Quick Actions',
      'admission.uid': 'UID',
      'admission.age_gender': 'Age/Gender',
      'admission.blood_group': 'Blood Group',
      'admission.allergies': 'Allergies',
      'admission.ward_field': 'Ward',
      'admission.bed_field': 'Bed',
      'admission.admitted_on': 'Admitted On',
      'admission.diagnosis_field': 'Diagnosis',
      'admission.priority_field': 'Priority',
      'admission.attending': 'Attending',
      'admission.action.vitals': 'Vitals',
      'admission.action.notes': 'Notes',
      'admission.action.orders': 'Orders',
      'admission.action.timeline': 'Timeline',
      'admission.retry': 'Retry',
      'admission.number_prefix': 'Admission',
      'admission.patient_fallback': 'Patient',
      // Patient timeline
      'timeline.title': 'Patient Timeline',
      'timeline.title_prefix': 'Timeline',
      'timeline.retry': 'Retry',
      'timeline.no_events': 'No events found',
      'timeline.filter.all': 'All',
      'timeline.filter.admission': 'Admission',
      'timeline.filter.vitals': 'Vitals',
      'timeline.filter.note': 'Note',
      'timeline.filter.order': 'Order',
      'timeline.filter.medication': 'Medication',
      'timeline.filter.investigation': 'Investigation',
      'timeline.filter.discharge': 'Discharge',
      'timeline.event_fallback': 'Clinical Event',
      'timeline.event_title_suffix': 'Event',
      'timeline.by_prefix': 'By',
      'timeline.department': 'Department',
      'timeline.details': 'Details',
      // Orders
      'orders.title': 'Patient Orders',
      'orders.title_prefix': 'Orders',
      'orders.new_order': 'New Order',
      'orders.type.medication': 'Medication Order',
      'orders.type.investigation': 'Investigation Order',
      'orders.type.nursing': 'Nursing Order',
      'orders.medication_name': 'Medication Name',
      'orders.dosage': 'Dosage',
      'orders.route': 'Route',
      'orders.route_hint': 'PO, IV, IM...',
      'orders.frequency': 'Frequency',
      'orders.frequency_hint': 'OD, BD, TDS...',
      'orders.duration': 'Duration',
      'orders.duration_hint': '5 days',
      'orders.special_instructions': 'Special Instructions',
      'orders.stat_immediate': 'STAT (Immediate)',
      'orders.investigation': 'Investigation',
      'orders.investigation_hint': 'CBC, RFT, CT Scan...',
      'orders.clinical_indication': 'Clinical Indication',
      'orders.priority': 'Priority',
      'orders.priority.routine': 'Routine',
      'orders.priority.urgent': 'Urgent',
      'orders.priority.stat': 'STAT',
      'orders.fasting_required': 'Fasting Required',
      'orders.description': 'Order Description',
      'orders.description_hint': 'Wound care, positioning, monitoring...',
      'orders.frequency_hint_nursing': 'Every 4h, PRN, Once...',
      'orders.place_order': 'Place Order',
      'orders.placed_success': 'Order placed successfully',
      'orders.place_failed_prefix': 'Failed to place order:',
      'orders.clinical_alerts': 'Clinical Alerts',
      'orders.proceed_anyway': 'Proceed Anyway',
      'orders.filter.all': 'All',
      'orders.filter.ordered': 'Ordered',
      'orders.filter.verified': 'Verified',
      'orders.filter.completed': 'Completed',
      'orders.filter.cancelled': 'Cancelled',
      'orders.no_found': 'No orders found',
      'orders.fallback': 'Order',
      'orders.verify': 'Verify',
      'orders.complete': 'Complete',
      'orders.verified_toast': 'Order verified',
      'orders.verify_failed_prefix': 'Verification failed:',
      'orders.completed_toast': 'Order completed',
      'orders.complete_failed_prefix': 'Failed to complete order:',
      'orders.retry': 'Retry',
      // Vitals chart
      'vitals_chart.title': 'Vitals Charting',
      'vitals_chart.title_prefix': 'Vitals',
      'vitals_chart.tab.record': 'Record',
      'vitals_chart.tab.last_24h': 'Last 24h',
      'vitals_chart.tab.io_balance': 'I/O Balance',
      'vitals_chart.record_vitals': 'Record Vitals',
      'vitals_chart.heart_rate': 'Heart Rate (bpm)',
      'vitals_chart.bp_sys': 'BP Systolic',
      'vitals_chart.bp_dia': 'BP Diastolic',
      'vitals_chart.temp': 'Temp (°F)',
      'vitals_chart.spo2': 'SpO2 (%)',
      'vitals_chart.resp_rate': 'Resp. Rate',
      'vitals_chart.glucose': 'Glucose (mg/dL)',
      'vitals_chart.pain': 'Pain (0-10)',
      'vitals_chart.gcs': 'GCS (3-15)',
      'vitals_chart.consciousness': 'Consciousness',
      'vitals_chart.conscious.alert': 'Alert',
      'vitals_chart.conscious.verbal': 'Responds to Voice',
      'vitals_chart.conscious.pain': 'Responds to Pain',
      'vitals_chart.conscious.unresp': 'Unresponsive',
      'vitals_chart.save_button': 'Save Vitals',
      'vitals_chart.at_least_one': 'Please enter at least one vital sign',
      'vitals_chart.recorded_success': 'Vitals recorded successfully',
      'vitals_chart.record_failed_prefix': 'Failed to record vitals:',
      'vitals_chart.record_io': 'Record I/O',
      'vitals_chart.intake': 'Intake',
      'vitals_chart.output': 'Output',
      'vitals_chart.category': 'Category',
      'vitals_chart.intake.oral': 'Oral',
      'vitals_chart.intake.iv': 'IV Fluids',
      'vitals_chart.intake.blood': 'Blood Products',
      'vitals_chart.intake.ng': 'NG Tube',
      'vitals_chart.cat.other': 'Other',
      'vitals_chart.output.urine': 'Urine',
      'vitals_chart.output.drain': 'Drain',
      'vitals_chart.output.emesis': 'Emesis',
      'vitals_chart.output.stool': 'Stool',
      'vitals_chart.output.blood_loss': 'Blood Loss',
      'vitals_chart.amount': 'Amount (mL)',
      'vitals_chart.io_description': 'Description (optional)',
      'vitals_chart.io_record': 'Record',
      'vitals_chart.io_success': 'I/O recorded successfully',
      'vitals_chart.io_failed_prefix': 'Failed to record I/O:',
      'vitals_chart.retry': 'Retry',
      'vitals_chart.no_vitals': 'No vitals recorded in last 24h',
      'vitals_chart.col.time': 'Time',
      'vitals_chart.col.hr': 'HR',
      'vitals_chart.col.bp': 'BP',
      'vitals_chart.col.temp': 'Temp',
      'vitals_chart.col.spo2': 'SpO2',
      'vitals_chart.col.rr': 'RR',
      'vitals_chart.col.glucose': 'Glucose',
      'vitals_chart.col.pain': 'Pain',
      'vitals_chart.col.gcs': 'GCS',
      'vitals_chart.col.avpu': 'AVPU',
      'vitals_chart.intake_label': 'Intake',
      'vitals_chart.output_label': 'Output',
      'vitals_chart.balance_label': 'Balance',
      'vitals_chart.record_io_entry': 'Record I/O Entry',
      'vitals_chart.today_entries': "Today's Entries",
      'vitals_chart.no_io_today': 'No I/O entries recorded today',
      'vitals_chart.record_for_prefix': 'Record vitals for',
      'vitals_chart.record_patient': 'Record patient vitals',
      'vitals_chart.record_now': 'Record Vitals Now',
      // Clinical notes
      'clinical_notes.title': 'Clinical Notes',
      'clinical_notes.title_prefix': 'Notes',
      'clinical_notes.tab.soap': 'SOAP Notes',
      'clinical_notes.tab.progress': 'Progress Notes',
      'clinical_notes.tab.procedure': 'Procedure Notes',
      'clinical_notes.new_note': 'New Note',
      'clinical_notes.signed': 'SIGNED',
      'clinical_notes.unsigned': 'UNSIGNED',
      'clinical_notes.retry': 'Retry',
      'clinical_notes.no_found_prefix': 'No',
      'clinical_notes.no_found_suffix': 'notes found',
      'clinical_notes.sign_note': 'Sign Note',
      'clinical_notes.signed_success': 'Note signed successfully',
      'clinical_notes.sign_failed_prefix': 'Failed to sign note:',
      'clinical_notes.note_fallback': 'Clinical Note',
      'clinical_notes.unknown_author': 'Unknown',
      'clinical_notes.subjective': 'Subjective',
      'clinical_notes.objective': 'Objective',
      'clinical_notes.assessment': 'Assessment',
      'clinical_notes.plan': 'Plan',
      'clinical_notes.content': 'Content',
      'clinical_notes.findings': 'Findings',
      'clinical_notes.procedure_details': 'Procedure Details',
      'clinical_notes.complications': 'Complications',
      'clinical_notes.new_soap': 'New SOAP Note',
      'clinical_notes.new_progress': 'New Progress Note',
      'clinical_notes.new_procedure': 'New Procedure Note',
      'clinical_notes.subjective_hint':
          'Patient complaints, symptoms, history...',
      'clinical_notes.objective_hint':
          'Exam findings, vitals, lab results...',
      'clinical_notes.assessment_hint':
          'Diagnosis, clinical impression...',
      'clinical_notes.plan_hint':
          'Treatment plan, orders, follow-up...',
      'clinical_notes.title_field': 'Title',
      'clinical_notes.content_hint':
          'Clinical progress, observations, plan changes...',
      'clinical_notes.procedure_name': 'Procedure Name',
      'clinical_notes.procedure_details_hint':
          'Technique, approach, steps...',
      'clinical_notes.findings_hint': 'Intra-procedural findings...',
      'clinical_notes.complications_hint':
          'Any complications encountered...',
      'clinical_notes.required': 'Required',
      'clinical_notes.save_note': 'Save Note',
      'clinical_notes.created_success': 'Note created successfully',
      'clinical_notes.create_failed_prefix': 'Failed to create note:',
    },
    // ── हिन्दी (Hindi) ────────────────────────────────────────────────
    // Second-pass reviewed for register, common clinical-staff
    // terminology, and natural phrasing. Most strings should be
    // production-ready in Indian government / private hospital
    // contexts; a handful are flagged `// REVIEW:` where local
    // hospital convention may differ (e.g. discharge wording, urgency).
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
      // 'action.search' was 'खोजें' (verb); 'खोज' is also common as a
      // noun-as-button label. Verb form fits the action-button pattern.
      'action.search': 'खोजें',
      'action.submit': 'जमा करें',
      'label.loading': 'लोड हो रहा है…',
      'label.no_data': 'कोई डेटा नहीं',
      'label.no_matches_for': 'कोई मेल नहीं मिला:',
      'label.optional': 'वैकल्पिक',
      'label.required': 'आवश्यक',
      'dashboard.greeting.morning': 'सुप्रभात',
      // 'दोपहर' (afternoon) is more accurate than 'नमस्ते'
      // (which means "hello" generically and isn't time-specific).
      'dashboard.greeting.afternoon': 'शुभ दोपहर',
      'dashboard.greeting.evening': 'शुभ संध्या',
      'dashboard.checked_in': 'चेक इन हो गया',
      'dashboard.checked_out': 'चेक आउट हो गया',
      'dashboard.not_checked_in': 'चेक इन नहीं हुआ',
      'dashboard.quick_actions_header': 'त्वरित क्रियाएँ',
      'dashboard.recent_patients_header': 'हाल ही के मरीज़',
      'dashboard.stat.alerts': 'अलर्ट',
      // Slightly more natural than the literal 'आज की मुलाक़ातें';
      // hospitals colloquially use the loanword 'अपॉइंटमेंट' or the
      // formal 'भेंट'. Going with the loanword which staff already use.
      'dashboard.stat.appointments': 'आज के अपॉइंटमेंट',
      'dashboard.stat.due_meds': 'देय दवाएँ',
      'dashboard.stat.inpatients': 'भर्ती मरीज़',
      // 'AI समीक्षा' was direct-translated; clinically the queue is
      // for AI-generated drafts that need clinician sign-off, so
      // 'AI ड्राफ्ट समीक्षा' is more accurate.
      'dashboard.stat.review_queue': 'AI ड्राफ्ट',
      'dashboard.upcoming_appointments': 'आगामी अपॉइंटमेंट',
      'login.employee_id_label': 'कर्मचारी आईडी',
      'login.password_label': 'पासवर्ड',
      'login.pin_label': 'पिन',
      'login.sign_in_button': 'साइन इन',
      'login.use_biometric': 'बायोमेट्रिक का उपयोग करें',
      'login.use_password': 'पासवर्ड का उपयोग करें',
      'login.use_pin': 'पिन का उपयोग करें',
      'login.invalid_credentials':
          'गलत क्रेडेंशियल। कृपया दोबारा कोशिश करें।',
      'login.app_title': 'VHHealth स्टाफ',
      'login.portal_subtitle': 'अस्पताल स्टाफ पोर्टल',
      'login.screen_title': 'साइन इन करें',
      'login.screen_subtitle':
          'पोर्टल तक पहुँचने के लिए अपने कर्मचारी क्रेडेंशियल का उपयोग करें',
      'login.employee_id_hint': '1001',
      'login.employee_id_required': 'कर्मचारी संख्या आवश्यक है',
      'login.employee_id_numbers_only': 'केवल अंक (1–6 अंक)',
      'login.mode.password': 'पासवर्ड',
      'login.mode.pin': 'पिन',
      'login.mode.quick': 'त्वरित',
      'login.pin_field_label': 'पिन',
      'login.pin_hint': '4–6 अंक',
      'login.pin_required': 'पिन आवश्यक है',
      'login.pin_min_digits': 'न्यूनतम 4 अंक',
      'login.quick_pin_label': 'पिन (या बायोमेट्रिक का उपयोग करें)',
      'login.quick_pin_hint': 'त्वरित पहुँच के लिए पिन दर्ज करें',
      'login.remember_employee_id': 'कर्मचारी आईडी याद रखें',
      'login.locked_title': 'खाता अस्थायी रूप से लॉक है',
      'login.locked_hint':
          'बहुत सारे असफल प्रयास। 15 मिनट बाद पुनः प्रयास करें या अपने पर्यवेक्षक से संपर्क करें।',
      'login.sign_in_with_password': 'पासवर्ड से साइन इन करें',
      'login.sign_in_with_pin': 'पिन से साइन इन करें',
      'login.quick_sign_in': 'त्वरित साइन इन',
      'login.footer': 'VHHealth · केवल स्टाफ पहुँच',
      // Dashboard (additional)
      'dashboard.welcome_back': 'वापस स्वागत है',
      'dashboard.see_all': 'सभी देखें',
      'dashboard.all_features': 'सभी सुविधाएँ',
      'dashboard.recent_activity': 'हाल की गतिविधि',
      'dashboard.checked_in_title': 'चेक इन हो गया',
      'dashboard.not_checked_in_title': 'चेक इन नहीं हुआ',
      'dashboard.since_time_prefix': 'से',
      'dashboard.tap_to_manage': 'उपस्थिति प्रबंधित करने के लिए टैप करें',
      'dashboard.new_live_notification.one': 'नई लाइव सूचना',
      'dashboard.new_live_notification.other': 'नई लाइव सूचनाएँ',
      'dashboard.sync_pending.one': 'आइटम सिंक होना बाकी',
      'dashboard.sync_pending.other': 'आइटम सिंक होने बाकी',
      'dashboard.action.check_in_out': 'चेक इन/आउट',
      'dashboard.action.shift_schedule': 'शिफ्ट शेड्यूल',
      'dashboard.action.messages': 'संदेश',
      'dashboard.action.prescriptions': 'प्रिस्क्रिप्शन',
      'dashboard.action.investigations': 'जाँच',
      'dashboard.action.vitals': 'वाइटल्स',
      'dashboard.action.handover': 'हैंडओवर',
      'dashboard.action.pharmacy': 'फ़ार्मेसी',
      'dashboard.action.upload_results': 'परिणाम अपलोड करें',
      'bed.label': 'बेड',
      'bed.status.available': 'उपलब्ध',
      // 'व्यस्त' (busy) is technically correct but colloquial; in
      // hospital context 'अधिकृत' (occupied) reads more clinical.
      // Keeping 'व्यस्त' since it's what nursing staff actually say.
      'bed.status.occupied': 'व्यस्त',
      'bed.status.maintenance': 'रखरखाव',
      'bed_board.title': 'बेड बोर्ड',
      'bed_board.search_wards_hint': 'वार्ड खोजें…',
      'bed_board.search_beds_hint': 'बेड नंबर या मरीज़ का नाम खोजें…',
      'bed_board.select_ward_prompt': 'बेड देखने के लिए वार्ड चुनें',
      'bed_board.empty_title': 'इस वार्ड में कोई बेड नहीं',
      'bed_board.empty_body': 'एडमिन पोर्टल से बेड जोड़ें।',
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
      'bed_sheet.notes_saved': 'बेड नोट्स सहेज लिए गए',
      'bed_sheet.admit_patient': 'मरीज़ भर्ती करें',
      // 'डिस्चार्ज' is the universally-used loanword; 'अस्पताल से
      // छुट्टी' is grammatically correct but reads informal. Keeping
      // the loanword which matches what discharge papers say.
      'bed_sheet.discharge': 'डिस्चार्ज',
      'bed_sheet.mark_maintenance': 'रखरखाव में डालें',
      'bed_sheet.mark_available': 'उपलब्ध करें',
      'bed_sheet.discharge_confirm_prefix': 'डिस्चार्ज करें',
      'bed_sheet.discharge_confirm_body':
          'इससे बेड खाली हो जाएगा और सक्रिय भर्ती समाप्त हो जाएगी। मरीज़ के EMR रिकॉर्ड बने रहेंगे।',
      'attendance.title': 'उपस्थिति',
      'attendance.check_in': 'चेक इन',
      'attendance.check_out': 'चेक आउट',
      'attendance.checked_in_at': 'चेक इन का समय',
      'attendance.outside_campus':
          'आप अस्पताल परिसर के बाहर हैं। चेक-इन उपलब्ध नहीं है।',
      'attendance.tab.today': 'आज',
      'attendance.tab.calendar': 'कैलेंडर',
      'attendance.tab.history': 'इतिहास',
      'attendance.checked_in_badge': '🟢 चेक इन हो गया',
      'attendance.not_checked_in_badge': '⚪ चेक इन नहीं हुआ',
      'attendance.checked_in_success': 'सफलतापूर्वक चेक इन हुआ',
      'attendance.checked_out_success': 'सफलतापूर्वक चेक आउट हुआ',
      'attendance.getting_location': 'स्थान प्राप्त किया जा रहा है...',
      'attendance.processing': 'प्रसंस्करण...',
      'attendance.location_verify_hint':
          '📍 चेक-इन पर स्थान सत्यापित किया जाएगा',
      'attendance.report_issue': 'उपस्थिति समस्या रिपोर्ट करें',
      'attendance.legend.present': 'उपस्थित',
      'attendance.legend.absent': 'अनुपस्थित',
      'attendance.legend.leave': 'अवकाश',
      'attendance.legend.late': 'विलंब',
      'attendance.check_in_label': 'चेक-इन',
      'attendance.check_out_label': 'चेक-आउट',
      'attendance.hours_label': 'घंटे',
      'attendance.late_arrival': '⚠️ विलंब से आगमन',
      'attendance.no_history': 'कोई उपस्थिति इतिहास नहीं',
      'attendance.history.absent': 'अनुपस्थित',
      'attendance.history.in_prefix': 'इन:',
      'attendance.history.out_prefix': 'आउट:',
      'attendance.outside_campus.distance_prefix': '❌ परिसर के बाहर',
      'attendance.outside_campus.distance_suffix':
          'दूर। उपस्थिति केवल परिसर में दर्ज की जा सकती है।',
      // Settings
      'settings.title': 'सेटिंग्स',
      'settings.section.appearance': 'दिखावट',
      'settings.section.notifications': 'सूचनाएँ',
      'settings.section.security': 'सुरक्षा',
      'settings.section.quick_links': 'त्वरित लिंक',
      'settings.section.about': 'जानकारी',
      'settings.theme.title': 'थीम',
      'settings.theme.system': 'सिस्टम',
      'settings.theme.light': 'लाइट',
      'settings.theme.dark': 'डार्क',
      'settings.theme.subtitle_system': 'सिस्टम सेटिंग का पालन करें',
      'settings.theme.subtitle_light': 'हमेशा लाइट',
      'settings.theme.subtitle_dark': 'हमेशा डार्क',
      'settings.push_notifications': 'पुश सूचनाएँ',
      'settings.push_notifications.subtitle':
          'उपस्थिति रिमाइंडर, अपॉइंटमेंट अलर्ट',
      'settings.shift_reminders': 'शिफ्ट रिमाइंडर',
      'settings.shift_reminders.subtitle':
          'शिफ्ट शुरू होने से पहले सूचित किया जाए',
      'settings.setup_pin': 'पिन सेट करें',
      'settings.setup_pin.subtitle':
          'अपना 4–6 अंकों का त्वरित पहुँच पिन सेट या अपडेट करें',
      'settings.setup_pin.dialog_title': 'पिन सेट करें',
      'settings.setup_pin.dialog_label': '4–6 अंकों का पिन दर्ज करें',
      'settings.setup_pin.success': '✅ पिन सफलतापूर्वक सेट किया गया',
      'settings.biometric.title': 'बायोमेट्रिक लॉगिन',
      'settings.biometric.subtitle':
          'साइन इन करने के लिए फिंगरप्रिंट या चेहरे का उपयोग करें',
      'settings.biometric.enabled': '✅ बायोमेट्रिक सक्षम',
      'settings.biometric.disabled': 'बायोमेट्रिक अक्षम',
      'settings.manage_devices': 'डिवाइस प्रबंधित करें',
      'settings.manage_devices.subtitle':
          'पंजीकृत डिवाइस देखें और हटाएँ',
      'settings.registered_devices': 'पंजीकृत डिवाइस',
      'settings.no_devices': 'कोई डिवाइस पंजीकृत नहीं',
      'settings.unknown_device': 'अज्ञात डिवाइस',
      'settings.device_removed': '✅ डिवाइस हटा दिया गया',
      'settings.quick_link.profile': 'प्रोफ़ाइल',
      'settings.quick_link.profile.subtitle':
          'अपनी स्टाफ प्रोफ़ाइल देखें और संपादित करें',
      'settings.quick_link.attendance': 'उपस्थिति',
      'settings.quick_link.attendance.subtitle':
          'चेक इन/आउट करें और इतिहास देखें',
      'settings.quick_link.leave': 'अवकाश',
      'settings.quick_link.leave.subtitle':
          'अवकाश के लिए आवेदन करें और शेष देखें',
      'settings.about.title': 'VHHealth स्टाफ के बारे में',
      'settings.about.subtitle': 'संस्करण 1.0.0 · ऐप जानकारी और सुविधाएँ',
      'settings.logout.dialog_title': 'लॉग आउट',
      'settings.logout.dialog_body':
          'क्या आप वाकई लॉग आउट करना चाहते हैं?',
      // Profile
      'profile.title': 'मेरी प्रोफ़ाइल',
      'profile.edit_tooltip': 'संपादित करें',
      'profile.cancel_tooltip': 'रद्द करें',
      'profile.fallback_name': 'स्टाफ सदस्य',
      'profile.emp_id_prefix': 'EMP:',
      'profile.info_title': 'स्टाफ जानकारी',
      'profile.edit_title': 'प्रोफ़ाइल संपादित करें',
      'profile.field.employee_id': 'कर्मचारी आईडी',
      'profile.field.role': 'भूमिका',
      'profile.field.department': 'विभाग',
      'profile.field.phone': 'फ़ोन',
      'profile.field.email': 'ईमेल',
      'profile.field.address': 'पता',
      'profile.field.shift': 'शिफ्ट',
      'profile.field.joining_date': 'नियुक्ति तिथि',
      'profile.saving_button': 'सहेज रहा है...',
      'profile.save_changes': 'परिवर्तन सहेजें',
      'profile.updated_success': '✅ प्रोफ़ाइल सफलतापूर्वक अपडेट की गई',
      'leave.title': 'अवकाश',
      'leave.tab.apply': 'आवेदन करें',
      'leave.tab.my_leaves': 'मेरे अवकाश',
      'leave.tab.requests': 'अनुरोध',
      'leave.balance_header': 'अवकाश शेष',
      'leave.submit_button': 'आवेदन जमा करें',
      'leave.submitted': 'अवकाश आवेदन जमा हो गया',
      'notifications.title': 'सूचनाएँ',
      'notifications.empty': 'अभी कोई सूचना नहीं',
      'notifications.search_hint': 'सूचनाएँ खोजें…',
      'notifications.mark_all_read': 'सभी पढ़ा हुआ चिह्नित करें',
      'notifications.live_update': 'लाइव अपडेट',
      'messaging.inbox_title': 'संदेश',
      'messaging.empty': 'कोई संदेश नहीं',
      'messaging.empty_body': 'स्टाफ डायरेक्टरी से बातचीत शुरू करें।',
      'messaging.new_message': 'नया संदेश',
      'messaging.type_hint': 'संदेश लिखें...',
      'messaging.send': 'भेजें',
      'messaging.set_priority': 'प्राथमिकता तय करें',
      'messaging.send_failed_prefix': 'भेजने में विफल:',
      'messaging.thread_load_failed': 'बातचीत लोड नहीं हो सकी',
      'messaging.thread_empty_title': 'अभी कोई संदेश नहीं',
      'messaging.thread_empty_body': 'नीचे बातचीत शुरू करें',
      // Time helpers
      'time.just_now': 'अभी-अभी',
      'time.yesterday': 'कल',
      'time.today': 'आज',
      'time.minutes_ago_suffix': 'मिनट पहले',
      'time.hours_ago_suffix': 'घंटे पहले',
      'time.days_ago_suffix': 'दिन पहले',
      // Priority / Urgency
      'priority.low': 'कम',
      'priority.normal': 'सामान्य',
      'priority.high': 'उच्च',
      // REVIEW: clinical urgency wording — confirm with hospital escalation policy
      'priority.urgent': 'अति आवश्यक',
      // REVIEW: clinical urgency wording — confirm with hospital escalation policy
      'priority.critical': 'गंभीर',
      'urgency.low': 'कम',
      'urgency.normal': 'सामान्य',
      'urgency.high': 'उच्च',
      // REVIEW: clinical urgency wording
      'urgency.critical': 'गंभीर',
      // Departments
      'department.general': 'सामान्य',
      'department.emergency': 'आपातकालीन',
      'department.icu': 'ICU',
      'department.pediatrics': 'बाल चिकित्सा',
      'department.surgery': 'शल्य चिकित्सा',
      'department.outpatient': 'बाह्य रोगी',
      // About
      'about.title': 'जानकारी',
      'about.header': 'जानकारी',
      'about.app_name': 'VHHealth स्टाफ',
      'about.version': 'संस्करण 1.0.0',
      'about.description':
          'VH Health द्वारा अस्पताल स्टाफ प्रबंधन ऐप। उपस्थिति, अवकाश, अपॉइंटमेंट और बहुत कुछ — सब कुछ अपने मोबाइल डिवाइस से प्रबंधित करें।',
      'about.features_header': 'सुविधाएँ',
      'about.support_header': 'सहायता',
      'about.support_email_label': 'ईमेल',
      'about.website_label': 'वेबसाइट',
      'about.copyright': '© 2026 VH Health. सर्वाधिकार सुरक्षित।',
      'about.feature.attendance.title': 'उपस्थिति',
      'about.feature.attendance.description':
          'स्थान ट्रैकिंग के साथ चेक इन/आउट',
      'about.feature.leave.title': 'अवकाश प्रबंधन',
      'about.feature.leave.description': 'अवकाश के लिए आवेदन करें और शेष देखें',
      'about.feature.appointments.title': 'अपॉइंटमेंट',
      'about.feature.appointments.description':
          'मरीज़ के अपॉइंटमेंट देखें और प्रबंधित करें',
      'about.feature.investigations.title': 'जाँच',
      'about.feature.investigations.description':
          'लैब टेस्ट और निदान रिपोर्ट',
      'about.feature.pharmacy.title': 'फ़ार्मेसी',
      'about.feature.pharmacy.description':
          'प्रिस्क्रिप्शन और वितरण कार्यप्रवाह',
      'about.feature.staff_directory.title': 'स्टाफ डायरेक्टरी',
      'about.feature.staff_directory.description':
          'सहकर्मियों को खोजें और संपर्क करें',
      'about.feature.clinical_modules.title': 'क्लिनिकल मॉड्यूल',
      'about.feature.clinical_modules.description':
          'वाइटल्स, नर्सिंग नोट्स, प्रिस्क्रिप्शन',
      // Leave (additional)
      'leave.type.annual': 'वार्षिक',
      'leave.type.sick': 'बीमारी',
      'leave.type.casual': 'आकस्मिक',
      'leave.type.emergency': 'आपातकालीन',
      'leave.type.maternity': 'मातृत्व',
      'leave.type.paternity': 'पितृत्व',
      'leave.type.unpaid': 'अवैतनिक',
      'leave.balance.used': 'उपयोग किया',
      'leave.leave_type_label': 'अवकाश का प्रकार',
      'leave.dates_label': 'तिथियाँ',
      'leave.start_date': 'प्रारंभ तिथि',
      'leave.end_date': 'अंतिम तिथि',
      'leave.reason_label': 'कारण',
      'leave.reason_hint': 'अवकाश का संक्षिप्त कारण',
      'leave.replacement_staff_label': 'प्रतिस्थापन स्टाफ (वैकल्पिक)',
      'leave.replacement_staff_hint':
          'अपनी जगह काम करने के लिए सहकर्मी चुनें',
      'leave.replacement_staff_pick': 'प्रतिस्थापन चुनने के लिए टैप करें',
      'leave.select_replacement': 'प्रतिस्थापन स्टाफ चुनें',
      'leave.no_staff_available': 'कोई स्टाफ उपलब्ध नहीं',
      'leave.search_by_type_hint': 'अवकाश के प्रकार से खोजें…',
      'leave.no_applications': 'कोई अवकाश आवेदन नहीं',
      'leave.no_replacement_requests': 'कोई लंबित प्रतिस्थापन अनुरोध नहीं',
      'leave.requester_unknown': 'अज्ञात',
      'leave.requesting_coverage_for': 'के लिए कवरेज का अनुरोध:',
      'leave.error.select_dates': 'कृपया तिथियाँ चुनें',
      'leave.error.provide_reason': 'कृपया कारण बताएँ',
      'leave.overtime_title': 'अतिरिक्त समय अनुरोध',
      'leave.overtime_subtitle': 'अतिरिक्त काम के घंटे लॉग करें',
      'leave.dispute_title': 'उपस्थिति विवाद',
      'leave.dispute_subtitle': 'रिकॉर्डिंग समस्या रिपोर्ट करें',
      'leave.action.decline': 'अस्वीकार',
      'leave.action.accept': 'स्वीकार',
      'leave.request_accepted': '✅ अनुरोध स्वीकृत',
      'leave.request_declined': '❌ अनुरोध अस्वीकृत',
      'leave.day_count.one': 'दिन',
      'leave.day_count.other': 'दिन',
      // Bed sheet (additional)
      'bed_sheet.field.name': 'नाम',
      'bed_sheet.field.age': 'आयु',
      'bed_sheet.field.gender': 'लिंग',
      'bed_sheet.field.phone': 'फ़ोन',
      'bed_sheet.field.chief_complaint': 'मुख्य शिकायत',
      'bed_sheet.field.diagnosis': 'निदान',
      'bed_sheet.field.type': 'प्रकार',
      'bed_sheet.field.attending': 'उपस्थित डॉक्टर',
      'bed_sheet.field.admitted': 'भर्ती समय',
      'bed_sheet.year_suffix': 'वर्ष',
      'bed_sheet.doctor_prefix': 'डॉ.',
      'bed_sheet.patient_details_unavailable':
          'इस बेड के लिए मरीज़ का विवरण उपलब्ध नहीं है।',
      'bed_sheet.no_patient_assigned': 'फ़िलहाल कोई मरीज़ नहीं सौंपा गया।',
      'bed_sheet.saving_label': 'सहेज रहा है…',
      'bed_sheet.quick_note_hint': 'त्वरित नोट (हैंडओवर, ख़तरे, IV साइट…)',
      'bed_sheet.dictate_quick_note': 'त्वरित नोट बोलकर लिखें',
      'bed_sheet.this_patient': 'इस मरीज़',
      // REVIEW: clinical-action confirmation
      'bed_sheet.patient_discharged': 'मरीज़ डिस्चार्ज हो गया',
      'bed_sheet.patient_missing_name': 'मरीज़ का नाम गायब है',
      'bed_sheet.patient_admitted_suffix': 'इस बेड पर भर्ती हुए',
      'bed_sheet.marked_as_prefix': 'बेड चिह्नित:',
      // Vitals
      'vitals.title': 'वाइटल्स प्रविष्टि',
      'vitals.tab.record': 'वाइटल्स दर्ज करें',
      'vitals.tab.recent': 'हाल के वाइटल्स',
      'vitals.header_title': 'मरीज़ के वाइटल्स दर्ज करें',
      'vitals.header_subtitle': 'मरीज़ ID से वाइटल्स दर्ज करें',
      'vitals.patient_id_label': 'मरीज़ ID',
      'vitals.patient_id_hint': 'मरीज़ ID दर्ज करें',
      'vitals.patient_id_required': 'मरीज़ ID आवश्यक है',
      'vitals.patient_id_invalid': 'वैध संख्या दर्ज करें',
      'vitals.bp_header': 'रक्तचाप',
      'vitals.bp_systolic': 'सिस्टोलिक',
      'vitals.bp_systolic_hint': 'जैसे 120',
      'vitals.bp_diastolic': 'डायस्टोलिक',
      'vitals.bp_diastolic_hint': 'जैसे 80',
      'vitals.temperature_header': 'तापमान',
      'vitals.temperature_hint': 'जैसे 98.6',
      'vitals.pulse_spo2_header': 'पल्स और ऑक्सीजन संतृप्ति',
      'vitals.pulse_label': 'पल्स',
      'vitals.pulse_hint': 'जैसे 72',
      'vitals.spo2_label': 'SpO₂',
      'vitals.spo2_hint': 'जैसे 98',
      'vitals.weight_header': 'वजन',
      'vitals.weight_hint': 'जैसे 70.5',
      'vitals.nurse_notes_label': 'नर्स नोट्स (वैकल्पिक)',
      'vitals.nurse_notes_hint': 'कोई अवलोकन या चिंताएँ...',
      'vitals.validation.invalid': 'अमान्य',
      'vitals.save_button': 'वाइटल्स सहेजें',
      'vitals.fetch_button': 'लाएँ',
      'vitals.trends_hint': 'वाइटल ट्रेंड देखने के लिए मरीज़ ID दर्ज करें',
      'vitals.no_records': 'इस मरीज़ के लिए कोई वाइटल रिकॉर्ड नहीं मिला',
      // REVIEW: clinical-action confirmation
      'vitals.recorded_success': 'वाइटल्स सफलतापूर्वक दर्ज किए गए',
      // REVIEW: clinical / connectivity message
      'vitals.offline_queued':
          'कनेक्शन नहीं — वाइटल्स सहेजे गए और ऑनलाइन होने पर सिंक होंगे',
      // Nursing Notes
      'nursing_notes.title': 'नर्सिंग नोट्स',
      'nursing_notes.tab.add': 'नोट जोड़ें',
      'nursing_notes.tab.recent': 'हाल के नोट्स',
      'nursing_notes.backend_coming_soon':
          'बैकएंड एकीकरण जल्द आ रहा है। नोट्स स्थानीय रूप से दिखाए जा रहे हैं।',
      'nursing_notes.patient_phone_label': 'मरीज़ फ़ोन नंबर',
      'nursing_notes.patient_phone_hint': '+91 XXXXX XXXXX',
      'nursing_notes.phone_required': 'फ़ोन आवश्यक है',
      'nursing_notes.phone_invalid': 'वैध फ़ोन नंबर दर्ज करें',
      'nursing_notes.type_label': 'नोट का प्रकार',
      'nursing_notes.type_required': 'नोट का प्रकार चुनें',
      'nursing_notes.priority_label': 'प्राथमिकता',
      'nursing_notes.clinical_note_label': 'क्लिनिकल नोट',
      'nursing_notes.clinical_note_hint':
          'अवलोकन, दी गई देखभाल, मरीज़ की प्रतिक्रिया का वर्णन करें...',
      'nursing_notes.note_required': 'नोट आवश्यक है',
      'nursing_notes.note_too_short': 'नोट बहुत छोटा है',
      'nursing_notes.save_button': 'नोट सहेजें',
      // REVIEW: clinical-action confirmation
      'nursing_notes.saved_success': 'नर्सिंग नोट सफलतापूर्वक सहेजा गया',
      // REVIEW: clinical / connectivity message
      'nursing_notes.offline_queued':
          'ऑफ़लाइन सहेजा गया — कनेक्ट होने पर सिंक होगा',
      'nursing_notes.recent_empty':
          'बैकएंड API कनेक्ट होने पर आपके हाल के नर्सिंग नोट्स यहाँ दिखाई देंगे।',
      'nursing_notes.type.observation': 'अवलोकन',
      'nursing_notes.type.medication': 'दवा नोट',
      'nursing_notes.type.post_procedure': 'प्रक्रिया के बाद',
      'nursing_notes.type.intake_output': 'सेवन/उत्सर्जन',
      'nursing_notes.type.patient_complaint': 'मरीज़ की शिकायत',
      'nursing_notes.type.wound_care': 'घाव की देखभाल',
      'nursing_notes.type.shift_handover': 'शिफ्ट हैंडओवर',
      'nursing_notes.type.emergency_note': 'आपातकालीन नोट',
      'nursing_notes.type.other': 'अन्य',
      // Handover
      'handover.title': 'हैंडओवर नोट्स',
      'handover.tab.write': 'लिखें',
      'handover.tab.recent': 'हाल के',
      'handover.department_label': 'विभाग',
      'handover.urgency_label': 'अत्यावश्यकता',
      'handover.notes_label': 'हैंडओवर नोट्स',
      'handover.notes_hint':
          'मुख्य अवलोकन, लंबित कार्य, दवा परिवर्तन...',
      'handover.notes_required': 'नोट्स आवश्यक हैं',
      'handover.patient_ref_label': 'मरीज़ संदर्भ (वैकल्पिक)',
      'handover.patient_ref_hint':
          'कक्ष 201 - श्री शर्मा, कक्ष 305 - श्रीमती पटेल',
      'handover.submit_button': 'हैंडओवर जमा करें',
      'handover.submitting_button': 'जमा कर रहा है...',
      // REVIEW: clinical-action confirmation
      'handover.submitted': 'हैंडओवर नोट जमा किया गया',
      'handover.recent_empty_title': 'कोई हाल का हैंडओवर नोट नहीं',
      'handover.recent_empty_body':
          'पिछले 24 घंटों के नोट्स यहाँ दिखाई देंगे',
      'handover.note_fallback_title': 'हैंडओवर नोट',
      'patient_picker.title': 'मरीज़ खोजें',
      'patient_picker.hint': 'नाम, फ़ोन या ABHA से मरीज़ खोजें…',
      'patient_picker.empty':
          'अभी कोई मेल नहीं मिला — टाइप करना जारी रखें।',
      'voice_dictate.tooltip': 'बोलकर लिखें',
      'voice_dictate.recording': 'रिकॉर्ड हो रहा है…',
      'voice_dictate.stop': 'रोकें और लिखें',
      'voice_dictate.transcribing': 'टेक्स्ट में बदल रहा है…',
      'voice_dictate.transcript_added': 'नोट्स में जोड़ा गया',
      'voice_dictate.mic_denied':
          'माइक्रोफ़ोन की अनुमति नहीं है। OS / ऐप सेटिंग्स में अनुमति दें।',
      // Bed Board (additions)
      'bed_board.no_wards_yet': 'अभी कोई वार्ड नहीं',
      'bed_board.ward_stat.total': 'कुल',
      'bed_board.ward_stat.free': 'खाली',
      'bed_board.ward_stat.used': 'उपयोग में',
      'bed_board.count.available_suffix': 'उपलब्ध',
      'bed_board.back_to_wards': 'वार्ड सूची पर वापस जाएँ',
      'bed_board.ward_fallback': 'वार्ड',
      'bed_board.print_tooltip': 'बेड बोर्ड प्रिंट करें',
      'bed_board.refresh_tooltip': 'बेड बोर्ड ताज़ा करें',
      'bed_board.print_failed_prefix': 'प्रिंट विफल:',
      'bed_board.no_filtered_prefix': 'इस वार्ड में कोई',
      'bed_board.no_filtered_suffix': 'बेड नहीं',
      'bed_board.admit_which_patient': 'किस मरीज़ को भर्ती करें?',
      'bed_board.admit_search_hint':
          'नाम, फ़ोन या ABHA से खोजें…',
      'bed_board.type_to_find_patient': 'मरीज़ खोजने के लिए टाइप करें।',
      'bed_board.patient_unnamed': 'बिना नाम',
      // Doctor queue
      'queue.title': 'मरीज़ कतार',
      'queue.refresh_tooltip': 'कतार ताज़ा करें',
      'queue.section.in_consultation': 'परामर्श में',
      'queue.section.waiting_prefix': 'प्रतीक्षारत',
      'queue.section.completed_prefix': 'पूर्ण',
      'queue.call_next_patient': 'अगले मरीज़ को बुलाएँ',
      // REVIEW: clinical-action confirmation
      'queue.complete_consultation': 'परामर्श पूर्ण करें',
      'queue.call_tooltip': 'बुलाएँ',
      'queue.no_patients_waiting': 'कोई मरीज़ प्रतीक्षारत नहीं',
      'queue.no_completed_consultations': 'कोई पूर्ण परामर्श नहीं',
      'queue.waiting_prefix': 'प्रतीक्षा',
      'queue.in_prefix': 'में',
      'queue.patient_info': 'मरीज़ की जानकारी',
      'queue.recent_records': 'हाल के रिकॉर्ड',
      'queue.no_health_records_found': 'कोई स्वास्थ्य रिकॉर्ड नहीं मिला',
      // REVIEW: clinical / safety — allergies surfacing
      'queue.allergies_prefix': 'एलर्जी:',
      'queue.age_prefix': '• आयु:',
      'queue.write_prescription': 'प्रिस्क्रिप्शन लिखें',
      'queue.order_investigation': 'जाँच का आदेश दें',
      'queue.add_notes': 'नोट्स जोड़ें',
      'queue.no_phone_number': 'कोई फ़ोन नंबर उपलब्ध नहीं',
      'queue.record_fallback': 'रिकॉर्ड',
      'queue.unknown_patient': 'अज्ञात',
      // Prescriptions
      'prescriptions.title': 'ई-प्रिस्क्रिप्शन',
      'prescriptions.tab.new': 'नया प्रिस्क्रिप्शन',
      'prescriptions.tab.recent': 'हाल के',
      'prescriptions.error.select_patient_doctor':
          'कृपया मरीज़ और डॉक्टर चुनें',
      'prescriptions.error.fill_medication_names':
          'कृपया सभी दवाओं के नाम भरें',
      'prescriptions.photo.title': 'प्रिस्क्रिप्शन फ़ोटो',
      'prescriptions.photo.body':
          'फ़ोटो लें या गैलरी से चुनें?',
      'prescriptions.photo.camera': 'कैमरा',
      'prescriptions.photo.gallery': 'गैलरी',
      'prescriptions.vitals_collapse': 'वाइटल्स (वैकल्पिक)',
      'prescriptions.diagnosis_label': 'निदान / मुख्य शिकायत *',
      'prescriptions.diagnosis_required': 'निदान आवश्यक है',
      'prescriptions.medications_header': 'दवाएँ *',
      'prescriptions.add_button': 'जोड़ें',
      'prescriptions.set_follow_up': 'फ़ॉलो-अप तिथि सेट करें',
      'prescriptions.follow_up_prefix': 'फ़ॉलो-अप:',
      'prescriptions.clear_follow_up': 'फ़ॉलो-अप तिथि साफ़ करें',
      'prescriptions.follow_up_notes': 'फ़ॉलो-अप नोट्स',
      'prescriptions.follow_up_notes_hint':
          'जैसे ब्लड रिपोर्ट लाएँ',
      'prescriptions.clinical_notes': 'क्लिनिकल नोट्स / सलाह',
      'prescriptions.clinical_notes_hint':
          'आराम, आहार, फ़ॉलो-अप निर्देश...',
      'prescriptions.photo_attached': 'फ़ोटो संलग्न ✓',
      'prescriptions.attach_handwritten':
          'हस्तलिखित प्रिस्क्रिप्शन संलग्न करें (वैकल्पिक)',
      'prescriptions.creating': 'बना रहा है...',
      'prescriptions.create': 'प्रिस्क्रिप्शन बनाएँ',
      'prescriptions.created_prefix': 'प्रिस्क्रिप्शन',
      'prescriptions.created_suffix': 'बनाया गया',
      'prescriptions.patient_label': 'मरीज़',
      'prescriptions.doctor_label': 'डॉक्टर',
      'prescriptions.search_patient':
          'मरीज़ खोजें (फ़ोन/नाम)',
      'prescriptions.search_doctor': 'डॉक्टर खोजें',
      'prescriptions.remove_medication': 'दवा हटाएँ',
      'prescriptions.medicine_name': 'दवा का नाम *',
      'prescriptions.medicine_name_hint':
          'खोजने के लिए टाइप करें (जैसे डोलो, पैन)',
      'prescriptions.dosage': 'खुराक',
      'prescriptions.dosage_hint': '500mg',
      'prescriptions.frequency': 'आवृत्ति',
      'prescriptions.duration': 'अवधि',
      'prescriptions.duration_hint': '5 दिन',
      'prescriptions.route': 'मार्ग',
      'prescriptions.instructions': 'निर्देश',
      'prescriptions.instructions_hint': 'भोजन के बाद',
      'prescriptions.qty': 'मात्रा',
      'prescriptions.medicine_index_prefix': 'दवा',
      'prescriptions.bp_systolic': 'BP सिस्टोलिक',
      'prescriptions.bp_diastolic': 'BP डायस्टोलिक',
      'prescriptions.pulse': 'पल्स',
      'prescriptions.temp': 'तापमान',
      'prescriptions.spo2': 'SpO2',
      'prescriptions.weight': 'वजन',
      'prescriptions.blood_sugar': 'रक्त शर्करा',
      'prescriptions.none_yet': 'अभी कोई प्रिस्क्रिप्शन नहीं',
      'prescriptions.ordered_chip': 'आदेश दिया गया',
      'prescriptions.detail.diagnosis': 'निदान',
      'prescriptions.detail.medications': 'दवाएँ',
      // Patient records (doctor)
      'patient_records.title': 'मरीज़ रिकॉर्ड',
      'patient_records.search_hint':
          'मरीज़ का नाम या प्रकार से खोजें...',
      'patient_records.clear_tooltip': 'खोज साफ़ करें',
      'patient_records.retry': 'पुनः प्रयास',
      'patient_records.no_found': 'कोई रिकॉर्ड नहीं मिला',
      'patient_records.empty': 'कोई मरीज़ रिकॉर्ड नहीं',
      'patient_records.empty_body':
          'मरीज़ रिकॉर्ड यहाँ दिखाई देंगे',
      'patient_records.details': 'रिकॉर्ड विवरण',
      'patient_records.unknown_patient': 'अज्ञात मरीज़',
      // Appointment queue
      'appt_queue.title': 'अपॉइंटमेंट कतार',
      'appt_queue.walk_in': 'वॉक-इन',
      'appt_queue.tab.today_prefix': 'आज की कतार',
      'appt_queue.tab.pending_prefix': 'लंबित',
      'appt_queue.no_today': 'आज कोई अपॉइंटमेंट नहीं',
      'appt_queue.all_confirmed':
          'सभी अपॉइंटमेंट पुष्टि किए गए!',
      'appt_queue.confirm_title': 'अपॉइंटमेंट की पुष्टि करें',
      'appt_queue.change_date': 'तिथि बदलें',
      'appt_queue.change_time': 'समय बदलें',
      'appt_queue.notes_optional': 'नोट्स (वैकल्पिक)',
      'appt_queue.confirm_appointment':
          'अपॉइंटमेंट की पुष्टि करें',
      // REVIEW: clinical-action confirmation
      'appt_queue.confirmed_toast':
          'अपॉइंटमेंट की पुष्टि हुई ✓',
      'appt_queue.failed_prefix': 'विफल:',
      'appt_queue.no_show_title': 'नो-शो के रूप में चिह्नित करें?',
      'appt_queue.no_show_body_suffix': 'नहीं आए?',
      'appt_queue.mark_no_show': 'नो-शो चिह्नित करें',
      // REVIEW: clinical-action confirmation
      'appt_queue.no_show_marked': 'नो-शो के रूप में चिह्नित',
      'appt_queue.complete_title': 'अपॉइंटमेंट पूरा करें',
      'appt_queue.complete_body_prefix': 'चिह्नित करें',
      'appt_queue.complete_body_suffix': 'पूर्ण के रूप में?',
      'appt_queue.complete_action': 'पूर्ण',
      // REVIEW: clinical-action confirmation
      'appt_queue.completed_toast': 'अपॉइंटमेंट पूर्ण ✓',
      'appt_queue.rx_prompt_title':
          'ई-प्रिस्क्रिप्शन बनाएँ?',
      'appt_queue.rx_prompt_body':
          'इस विज़िट के लिए संरचित ई-प्रिस्क्रिप्शन बनाएँ? मरीज़ इससे सीधे दवाओं का ऑर्डर कर सकता है।',
      'appt_queue.skip': 'छोड़ें',
      'appt_queue.upload_doc': 'दस्तावेज़ अपलोड',
      'appt_queue.e_prescription': 'ई-प्रिस्क्रिप्शन',
      'appt_queue.upload_document': 'दस्तावेज़ अपलोड करें',
      'appt_queue.doc_type': 'दस्तावेज़ का प्रकार',
      'appt_queue.attach_file_pick': 'फ़ाइल चुनें',
      'appt_queue.camera': 'कैमरा',
      // REVIEW: clinical-action confirmation
      'appt_queue.doc_uploaded': 'दस्तावेज़ अपलोड हुआ ✓',
      'appt_queue.upload_failed_prefix': 'अपलोड विफल:',
      'appt_queue.register_walk_in':
          'वॉक-इन पंजीकृत करें',
      'appt_queue.patient_phone': 'मरीज़ फ़ोन *',
      'appt_queue.patient_phone_required':
          'मरीज़ का फ़ोन आवश्यक है',
      'appt_queue.patient_name': 'मरीज़ का नाम',
      'appt_queue.department': 'विभाग',
      'appt_queue.reason': 'कारण',
      'appt_queue.reason_hint': 'वॉक-इन परामर्श',
      'appt_queue.walk_in_registered_prefix':
          'वॉक-इन पंजीकृत! टोकन',
      'appt_queue.retry': 'पुनः प्रयास',
      'appt_queue.close': 'बंद करें',
      'appt_queue.action.confirm': 'पुष्टि',
      'appt_queue.action.complete': 'पूर्ण',
      'appt_queue.action.no_show': 'नो-शो',
      'appt_queue.action.upload_doc': 'दस्तावेज़ अपलोड',
      'appt_queue.call_confirm': 'कॉल & पुष्टि',
      'appt_queue.sla_breached': 'SLA उल्लंघन',
      'appt_queue.booked_prefix': 'बुक किया',
      'appt_queue.patient_fallback': 'मरीज़',
      // Admission
      'admission.title': 'भर्ती',
      'admission.admit': 'भर्ती',
      'admission.admit_patient': 'मरीज़ भर्ती करें',
      'admission.patient_label': 'मरीज़ (नाम, UID, या फ़ोन)',
      'admission.required': 'आवश्यक',
      'admission.chief_complaint': 'मुख्य शिकायत',
      'admission.diagnosis': 'अस्थायी निदान',
      'admission.ward': 'वार्ड',
      'admission.bed_number': 'बेड संख्या',
      'admission.priority_label': 'प्राथमिकता',
      'admission.priority.routine': 'नियमित',
      // REVIEW: clinical urgency wording
      'admission.priority.urgent': 'अति आवश्यक',
      // REVIEW: clinical urgency wording
      'admission.priority.emergency': 'आपातकालीन',
      // REVIEW: clinical urgency wording
      'admission.priority.critical': 'गंभीर',
      'admission.code_status': 'कोड स्थिति',
      // REVIEW: clinical action — keep DNR/DNI as standard medical abbrev
      'admission.code.full': 'फुल कोड',
      'admission.code.dnr': 'DNR',
      'admission.code.dnr_dni': 'DNR/DNI',
      'admission.code.comfort': 'आरामदायक देखभाल',
      // REVIEW: clinical-action confirmation
      'admission.admitted_success':
          'मरीज़ सफलतापूर्वक भर्ती किया गया',
      'admission.failed_prefix': 'भर्ती विफल:',
      'admission.no_active': 'कोई सक्रिय भर्ती नहीं',
      'admission.patient_information': 'मरीज़ की जानकारी',
      'admission.details': 'भर्ती विवरण',
      'admission.quick_actions': 'त्वरित क्रियाएँ',
      'admission.uid': 'UID',
      'admission.age_gender': 'आयु/लिंग',
      'admission.blood_group': 'रक्त समूह',
      'admission.allergies': 'एलर्जी',
      'admission.ward_field': 'वार्ड',
      'admission.bed_field': 'बेड',
      'admission.admitted_on': 'भर्ती तिथि',
      'admission.diagnosis_field': 'निदान',
      'admission.priority_field': 'प्राथमिकता',
      'admission.attending': 'उपस्थित',
      'admission.action.vitals': 'वाइटल्स',
      'admission.action.notes': 'नोट्स',
      'admission.action.orders': 'आदेश',
      'admission.action.timeline': 'टाइमलाइन',
      'admission.retry': 'पुनः प्रयास',
      'admission.number_prefix': 'भर्ती',
      'admission.patient_fallback': 'मरीज़',
      // Patient timeline
      'timeline.title': 'मरीज़ टाइमलाइन',
      'timeline.title_prefix': 'टाइमलाइन',
      'timeline.retry': 'पुनः प्रयास',
      'timeline.no_events': 'कोई घटना नहीं मिली',
      'timeline.filter.all': 'सभी',
      'timeline.filter.admission': 'भर्ती',
      'timeline.filter.vitals': 'वाइटल्स',
      'timeline.filter.note': 'नोट',
      'timeline.filter.order': 'आदेश',
      'timeline.filter.medication': 'दवा',
      'timeline.filter.investigation': 'जाँच',
      'timeline.filter.discharge': 'डिस्चार्ज',
      'timeline.event_fallback': 'क्लिनिकल घटना',
      'timeline.event_title_suffix': 'घटना',
      'timeline.by_prefix': 'द्वारा',
      'timeline.department': 'विभाग',
      'timeline.details': 'विवरण',
      // Orders
      'orders.title': 'मरीज़ आदेश',
      'orders.title_prefix': 'आदेश',
      'orders.new_order': 'नया आदेश',
      'orders.type.medication': 'दवा आदेश',
      'orders.type.investigation': 'जाँच आदेश',
      'orders.type.nursing': 'नर्सिंग आदेश',
      'orders.medication_name': 'दवा का नाम',
      'orders.dosage': 'खुराक',
      'orders.route': 'मार्ग',
      'orders.route_hint': 'PO, IV, IM...',
      'orders.frequency': 'आवृत्ति',
      'orders.frequency_hint': 'OD, BD, TDS...',
      'orders.duration': 'अवधि',
      'orders.duration_hint': '5 दिन',
      'orders.special_instructions': 'विशेष निर्देश',
      // REVIEW: clinical urgency wording
      'orders.stat_immediate': 'STAT (तत्काल)',
      'orders.investigation': 'जाँच',
      'orders.investigation_hint': 'CBC, RFT, CT स्कैन...',
      'orders.clinical_indication': 'क्लिनिकल संकेत',
      'orders.priority': 'प्राथमिकता',
      'orders.priority.routine': 'नियमित',
      // REVIEW: clinical urgency wording
      'orders.priority.urgent': 'अति आवश्यक',
      'orders.priority.stat': 'STAT',
      'orders.fasting_required': 'उपवास आवश्यक',
      'orders.description': 'आदेश विवरण',
      'orders.description_hint':
          'घाव की देखभाल, स्थिति बदलना, निगरानी...',
      'orders.frequency_hint_nursing':
          'हर 4 घंटे, PRN, एक बार...',
      'orders.place_order': 'आदेश दें',
      // REVIEW: clinical-action confirmation
      'orders.placed_success': 'आदेश सफलतापूर्वक दिया गया',
      'orders.place_failed_prefix': 'आदेश देने में विफल:',
      // REVIEW: clinical-safety messaging
      'orders.clinical_alerts': 'क्लिनिकल अलर्ट',
      'orders.proceed_anyway': 'फिर भी जारी रखें',
      'orders.filter.all': 'सभी',
      'orders.filter.ordered': 'आदेशित',
      'orders.filter.verified': 'सत्यापित',
      'orders.filter.completed': 'पूर्ण',
      'orders.filter.cancelled': 'रद्द',
      'orders.no_found': 'कोई आदेश नहीं मिला',
      'orders.fallback': 'आदेश',
      'orders.verify': 'सत्यापित करें',
      'orders.complete': 'पूर्ण',
      // REVIEW: clinical-action confirmation
      'orders.verified_toast': 'आदेश सत्यापित',
      'orders.verify_failed_prefix': 'सत्यापन विफल:',
      // REVIEW: clinical-action confirmation
      'orders.completed_toast': 'आदेश पूर्ण',
      'orders.complete_failed_prefix':
          'आदेश पूर्ण करने में विफल:',
      'orders.retry': 'पुनः प्रयास',
      // Vitals chart
      'vitals_chart.title': 'वाइटल्स चार्टिंग',
      'vitals_chart.title_prefix': 'वाइटल्स',
      'vitals_chart.tab.record': 'दर्ज करें',
      'vitals_chart.tab.last_24h': 'पिछले 24 घंटे',
      'vitals_chart.tab.io_balance': 'I/O संतुलन',
      'vitals_chart.record_vitals': 'वाइटल्स दर्ज करें',
      'vitals_chart.heart_rate': 'हृदय गति (bpm)',
      'vitals_chart.bp_sys': 'BP सिस्टोलिक',
      'vitals_chart.bp_dia': 'BP डायस्टोलिक',
      'vitals_chart.temp': 'तापमान (°F)',
      'vitals_chart.spo2': 'SpO2 (%)',
      'vitals_chart.resp_rate': 'श्वसन दर',
      'vitals_chart.glucose': 'ग्लूकोज़ (mg/dL)',
      'vitals_chart.pain': 'दर्द (0-10)',
      'vitals_chart.gcs': 'GCS (3-15)',
      'vitals_chart.consciousness': 'चेतना',
      'vitals_chart.conscious.alert': 'सतर्क',
      'vitals_chart.conscious.verbal': 'आवाज़ पर प्रतिक्रिया',
      'vitals_chart.conscious.pain': 'दर्द पर प्रतिक्रिया',
      'vitals_chart.conscious.unresp': 'अनुत्तरदायी',
      'vitals_chart.save_button': 'वाइटल्स सहेजें',
      'vitals_chart.at_least_one':
          'कृपया कम से कम एक वाइटल साइन दर्ज करें',
      // REVIEW: clinical-action confirmation
      'vitals_chart.recorded_success':
          'वाइटल्स सफलतापूर्वक दर्ज किए गए',
      'vitals_chart.record_failed_prefix':
          'वाइटल्स दर्ज करने में विफल:',
      'vitals_chart.record_io': 'I/O दर्ज करें',
      'vitals_chart.intake': 'सेवन',
      'vitals_chart.output': 'उत्सर्जन',
      'vitals_chart.category': 'श्रेणी',
      'vitals_chart.intake.oral': 'मौखिक',
      'vitals_chart.intake.iv': 'IV द्रव',
      'vitals_chart.intake.blood': 'रक्त उत्पाद',
      'vitals_chart.intake.ng': 'NG ट्यूब',
      'vitals_chart.cat.other': 'अन्य',
      'vitals_chart.output.urine': 'मूत्र',
      'vitals_chart.output.drain': 'ड्रेन',
      'vitals_chart.output.emesis': 'उल्टी',
      'vitals_chart.output.stool': 'मल',
      'vitals_chart.output.blood_loss': 'रक्त हानि',
      'vitals_chart.amount': 'मात्रा (mL)',
      'vitals_chart.io_description': 'विवरण (वैकल्पिक)',
      'vitals_chart.io_record': 'दर्ज करें',
      // REVIEW: clinical-action confirmation
      'vitals_chart.io_success': 'I/O सफलतापूर्वक दर्ज',
      'vitals_chart.io_failed_prefix': 'I/O दर्ज करने में विफल:',
      'vitals_chart.retry': 'पुनः प्रयास',
      'vitals_chart.no_vitals':
          'पिछले 24 घंटों में कोई वाइटल्स दर्ज नहीं',
      'vitals_chart.col.time': 'समय',
      'vitals_chart.col.hr': 'HR',
      'vitals_chart.col.bp': 'BP',
      'vitals_chart.col.temp': 'तापमान',
      'vitals_chart.col.spo2': 'SpO2',
      'vitals_chart.col.rr': 'RR',
      'vitals_chart.col.glucose': 'ग्लूकोज़',
      'vitals_chart.col.pain': 'दर्द',
      'vitals_chart.col.gcs': 'GCS',
      'vitals_chart.col.avpu': 'AVPU',
      'vitals_chart.intake_label': 'सेवन',
      'vitals_chart.output_label': 'उत्सर्जन',
      'vitals_chart.balance_label': 'संतुलन',
      'vitals_chart.record_io_entry': 'I/O प्रविष्टि दर्ज करें',
      'vitals_chart.today_entries': 'आज की प्रविष्टियाँ',
      'vitals_chart.no_io_today':
          'आज कोई I/O प्रविष्टि दर्ज नहीं',
      'vitals_chart.record_for_prefix': 'इनके लिए वाइटल्स दर्ज करें',
      'vitals_chart.record_patient': 'मरीज़ के वाइटल्स दर्ज करें',
      'vitals_chart.record_now': 'अभी वाइटल्स दर्ज करें',
      // Clinical notes
      'clinical_notes.title': 'क्लिनिकल नोट्स',
      'clinical_notes.title_prefix': 'नोट्स',
      'clinical_notes.tab.soap': 'SOAP नोट्स',
      'clinical_notes.tab.progress': 'प्रगति नोट्स',
      'clinical_notes.tab.procedure': 'प्रक्रिया नोट्स',
      'clinical_notes.new_note': 'नया नोट',
      // REVIEW: clinical-action — signed/unsigned status
      'clinical_notes.signed': 'हस्ताक्षरित',
      'clinical_notes.unsigned': 'बिना हस्ताक्षर',
      'clinical_notes.retry': 'पुनः प्रयास',
      'clinical_notes.no_found_prefix': 'कोई',
      'clinical_notes.no_found_suffix': 'नोट नहीं मिले',
      // REVIEW: clinical-action confirmation
      'clinical_notes.sign_note': 'नोट पर हस्ताक्षर',
      // REVIEW: clinical-action confirmation
      'clinical_notes.signed_success':
          'नोट सफलतापूर्वक हस्ताक्षरित',
      'clinical_notes.sign_failed_prefix':
          'नोट हस्ताक्षरित करने में विफल:',
      'clinical_notes.note_fallback': 'क्लिनिकल नोट',
      'clinical_notes.unknown_author': 'अज्ञात',
      'clinical_notes.subjective': 'व्यक्तिपरक',
      'clinical_notes.objective': 'वस्तुनिष्ठ',
      'clinical_notes.assessment': 'मूल्यांकन',
      'clinical_notes.plan': 'योजना',
      'clinical_notes.content': 'सामग्री',
      'clinical_notes.findings': 'निष्कर्ष',
      'clinical_notes.procedure_details': 'प्रक्रिया विवरण',
      'clinical_notes.complications': 'जटिलताएँ',
      'clinical_notes.new_soap': 'नया SOAP नोट',
      'clinical_notes.new_progress': 'नया प्रगति नोट',
      'clinical_notes.new_procedure': 'नया प्रक्रिया नोट',
      'clinical_notes.subjective_hint':
          'मरीज़ की शिकायतें, लक्षण, इतिहास...',
      'clinical_notes.objective_hint':
          'जाँच परिणाम, वाइटल्स, लैब परिणाम...',
      'clinical_notes.assessment_hint':
          'निदान, क्लिनिकल छाप...',
      'clinical_notes.plan_hint':
          'उपचार योजना, आदेश, फ़ॉलो-अप...',
      'clinical_notes.title_field': 'शीर्षक',
      'clinical_notes.content_hint':
          'क्लिनिकल प्रगति, अवलोकन, योजना परिवर्तन...',
      'clinical_notes.procedure_name': 'प्रक्रिया का नाम',
      'clinical_notes.procedure_details_hint':
          'तकनीक, दृष्टिकोण, चरण...',
      'clinical_notes.findings_hint':
          'अंतर-प्रक्रियात्मक निष्कर्ष...',
      'clinical_notes.complications_hint':
          'सामना की गई कोई भी जटिलताएँ...',
      'clinical_notes.required': 'आवश्यक',
      'clinical_notes.save_note': 'नोट सहेजें',
      // REVIEW: clinical-action confirmation
      'clinical_notes.created_success':
          'नोट सफलतापूर्वक बनाया गया',
      'clinical_notes.create_failed_prefix':
          'नोट बनाने में विफल:',
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
      // REVIEW: app branding — keep VHHealth as proper noun
      'login.app_title': 'VHHealth பணியாளர்',
      'login.portal_subtitle': 'மருத்துவமனை பணியாளர் வாயில்',
      'login.screen_title': 'உள்நுழை',
      'login.screen_subtitle':
          'வாயிலை அணுக உங்கள் ஊழியர் சான்றுகளைப் பயன்படுத்தவும்',
      'login.employee_id_hint': '1001',
      'login.employee_id_required': 'ஊழியர் எண் தேவை',
      'login.employee_id_numbers_only': 'எண்கள் மட்டும் (1–6 இலக்கங்கள்)',
      'login.mode.password': 'கடவுச்சொல்',
      'login.mode.pin': 'PIN',
      'login.mode.quick': 'விரைவு',
      'login.pin_field_label': 'PIN',
      'login.pin_hint': '4–6 இலக்கங்கள்',
      'login.pin_required': 'PIN தேவை',
      'login.pin_min_digits': 'குறைந்தபட்சம் 4 இலக்கங்கள்',
      'login.quick_pin_label': 'PIN (அல்லது பயோமெட்ரிக் பயன்படுத்தவும்)',
      'login.quick_pin_hint': 'விரைவு அணுகலுக்கு PIN உள்ளிடவும்',
      'login.remember_employee_id': 'ஊழியர் ID-ஐ நினைவில் கொள்',
      // REVIEW: security message wording
      'login.locked_title': 'கணக்கு தற்காலிகமாக பூட்டப்பட்டது',
      // REVIEW: security message wording — confirm 15-min phrasing
      'login.locked_hint':
          'பல தோல்வியுற்ற முயற்சிகள். 15 நிமிடங்களில் மீண்டும் முயற்சிக்கவும் அல்லது உங்கள் மேற்பார்வையாளரைத் தொடர்புகொள்ளவும்.',
      'login.sign_in_with_password': 'கடவுச்சொல்லுடன் உள்நுழை',
      'login.sign_in_with_pin': 'PIN-உடன் உள்நுழை',
      'login.quick_sign_in': 'விரைவு உள்நுழைவு',
      'login.footer': 'VHHealth · பணியாளர் அணுகல் மட்டும்',
      // Dashboard (additional)
      'dashboard.welcome_back': 'மீண்டும் வரவேற்கிறோம்',
      'dashboard.see_all': 'அனைத்தும் பார்',
      'dashboard.all_features': 'அனைத்து அம்சங்கள்',
      'dashboard.recent_activity': 'சமீபத்திய செயல்பாடு',
      'dashboard.checked_in_title': 'சரிபார்க்கப்பட்டது',
      'dashboard.not_checked_in_title': 'சரிபார்க்கப்படவில்லை',
      'dashboard.since_time_prefix': 'முதல்',
      'dashboard.tap_to_manage': 'வருகையை நிர்வகிக்க தட்டவும்',
      'dashboard.new_live_notification.one': 'புதிய நேரடி அறிவிப்பு',
      'dashboard.new_live_notification.other': 'புதிய நேரடி அறிவிப்புகள்',
      'dashboard.sync_pending.one': 'உருப்படி ஒத்திசைவு நிலுவையில்',
      'dashboard.sync_pending.other': 'உருப்படிகள் ஒத்திசைவு நிலுவையில்',
      'dashboard.action.check_in_out': 'உள்/வெளியேறு',
      'dashboard.action.shift_schedule': 'பணி அட்டவணை',
      'dashboard.action.messages': 'செய்திகள்',
      'dashboard.action.prescriptions': 'மருந்துச்சீட்டுகள்',
      'dashboard.action.investigations': 'விசாரணைகள்',
      'dashboard.action.vitals': 'உயிர் அளவீடுகள்',
      'dashboard.action.handover': 'கையளிப்பு',
      'dashboard.action.pharmacy': 'மருந்தகம்',
      'dashboard.action.upload_results': 'முடிவுகளை பதிவேற்று',
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
      'attendance.tab.today': 'இன்று',
      'attendance.tab.calendar': 'நாட்காட்டி',
      'attendance.tab.history': 'வரலாறு',
      'attendance.checked_in_badge': '🟢 உள்நுழைந்தது',
      'attendance.not_checked_in_badge': '⚪ உள்நுழையவில்லை',
      // REVIEW: success-toast wording
      'attendance.checked_in_success': 'வெற்றிகரமாக உள்நுழைந்தது',
      // REVIEW: success-toast wording
      'attendance.checked_out_success': 'வெற்றிகரமாக வெளியேறியது',
      'attendance.getting_location': 'இடம் பெறப்படுகிறது...',
      'attendance.processing': 'செயலாக்கப்படுகிறது...',
      'attendance.location_verify_hint':
          '📍 உள்நுழைவின் போது இடம் சரிபார்க்கப்படும்',
      'attendance.report_issue': 'வருகை சிக்கலைப் புகாரளி',
      'attendance.legend.present': 'வருகை',
      'attendance.legend.absent': 'வரவில்லை',
      'attendance.legend.leave': 'விடுப்பு',
      'attendance.legend.late': 'தாமதம்',
      'attendance.check_in_label': 'உள்நுழைவு',
      'attendance.check_out_label': 'வெளியேறுதல்',
      'attendance.hours_label': 'மணிநேரம்',
      'attendance.late_arrival': '⚠️ தாமதமாக வருகை',
      'attendance.no_history': 'வருகை வரலாறு இல்லை',
      'attendance.history.absent': 'வரவில்லை',
      'attendance.history.in_prefix': 'உள்:',
      'attendance.history.out_prefix': 'வெளி:',
      // REVIEW: clinical-action / location error wording
      'attendance.outside_campus.distance_prefix': '❌ வளாகத்திற்கு வெளியே',
      'attendance.outside_campus.distance_suffix':
          'தூரம். வருகையை வளாகத்தில் மட்டுமே குறிக்க முடியும்.',
      // Settings
      'settings.title': 'அமைப்புகள்',
      'settings.section.appearance': 'தோற்றம்',
      'settings.section.notifications': 'அறிவிப்புகள்',
      'settings.section.security': 'பாதுகாப்பு',
      'settings.section.quick_links': 'விரைவு இணைப்புகள்',
      'settings.section.about': 'பற்றி',
      'settings.theme.title': 'தீம்',
      'settings.theme.system': 'சிஸ்டம்',
      'settings.theme.light': 'லைட்',
      'settings.theme.dark': 'டார்க்',
      'settings.theme.subtitle_system': 'சிஸ்டம் அமைப்பைப் பின்பற்று',
      'settings.theme.subtitle_light': 'எப்போதும் லைட்',
      'settings.theme.subtitle_dark': 'எப்போதும் டார்க்',
      'settings.push_notifications': 'புஷ் அறிவிப்புகள்',
      'settings.push_notifications.subtitle':
          'வருகை நினைவூட்டல்கள், சந்திப்பு எச்சரிக்கைகள்',
      'settings.shift_reminders': 'பணி நினைவூட்டல்கள்',
      'settings.shift_reminders.subtitle':
          'பணி தொடங்குவதற்கு முன் அறிவிக்கப்படும்',
      'settings.setup_pin': 'PIN அமை',
      'settings.setup_pin.subtitle':
          'உங்கள் 4–6 இலக்க விரைவு அணுகல் PIN-ஐ அமைக்கவும் அல்லது புதுப்பிக்கவும்',
      'settings.setup_pin.dialog_title': 'PIN அமை',
      'settings.setup_pin.dialog_label': '4–6 இலக்க PIN உள்ளிடவும்',
      // REVIEW: security action confirmation
      'settings.setup_pin.success': '✅ PIN வெற்றிகரமாக அமைக்கப்பட்டது',
      'settings.biometric.title': 'பயோமெட்ரிக் உள்நுழைவு',
      'settings.biometric.subtitle':
          'உள்நுழைய கைரேகை அல்லது முகத்தைப் பயன்படுத்தவும்',
      // REVIEW: security action confirmation
      'settings.biometric.enabled': '✅ பயோமெட்ரிக் இயக்கப்பட்டது',
      // REVIEW: security action confirmation
      'settings.biometric.disabled': 'பயோமெட்ரிக் முடக்கப்பட்டது',
      'settings.manage_devices': 'சாதனங்களை நிர்வகி',
      'settings.manage_devices.subtitle':
          'பதிவு செய்யப்பட்ட சாதனங்களைப் பார்த்து அகற்று',
      'settings.registered_devices': 'பதிவு செய்யப்பட்ட சாதனங்கள்',
      'settings.no_devices': 'சாதனங்கள் பதிவு செய்யப்படவில்லை',
      'settings.unknown_device': 'தெரியாத சாதனம்',
      // REVIEW: security action confirmation
      'settings.device_removed': '✅ சாதனம் அகற்றப்பட்டது',
      'settings.quick_link.profile': 'சுயவிவரம்',
      'settings.quick_link.profile.subtitle':
          'உங்கள் ஊழியர் சுயவிவரத்தைப் பார்த்து திருத்தவும்',
      'settings.quick_link.attendance': 'வருகை',
      'settings.quick_link.attendance.subtitle':
          'உள்/வெளியேறு செய்து வரலாற்றைப் பார்க்கவும்',
      'settings.quick_link.leave': 'விடுப்பு',
      'settings.quick_link.leave.subtitle':
          'விடுப்புக்கு விண்ணப்பித்து மீதியைச் சரிபார்க்கவும்',
      'settings.about.title': 'VHHealth பணியாளர் பற்றி',
      'settings.about.subtitle':
          'பதிப்பு 1.0.0 · ஆப் தகவல் & அம்சங்கள்',
      'settings.logout.dialog_title': 'வெளியேறு',
      'settings.logout.dialog_body':
          'நீங்கள் கண்டிப்பாக வெளியேற விரும்புகிறீர்களா?',
      // Profile
      'profile.title': 'என் சுயவிவரம்',
      'profile.edit_tooltip': 'திருத்து',
      'profile.cancel_tooltip': 'ரத்து',
      'profile.fallback_name': 'பணியாளர்',
      'profile.emp_id_prefix': 'EMP:',
      'profile.info_title': 'பணியாளர் தகவல்',
      'profile.edit_title': 'சுயவிவரத்தைத் திருத்து',
      'profile.field.employee_id': 'ஊழியர் ID',
      'profile.field.role': 'பங்கு',
      'profile.field.department': 'துறை',
      'profile.field.phone': 'தொலைபேசி',
      'profile.field.email': 'மின்னஞ்சல்',
      'profile.field.address': 'முகவரி',
      'profile.field.shift': 'பணி',
      'profile.field.joining_date': 'சேர்ந்த தேதி',
      'profile.saving_button': 'சேமிக்கிறது...',
      'profile.save_changes': 'மாற்றங்களைச் சேமி',
      // REVIEW: clinical-action confirmation
      'profile.updated_success':
          '✅ சுயவிவரம் வெற்றிகரமாக புதுப்பிக்கப்பட்டது',
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
      // REVIEW
      'notifications.mark_all_read': 'அனைத்தையும் படித்ததாகக் குறி',
      // REVIEW
      'notifications.live_update': 'நேரடி புதுப்பிப்பு',
      'messaging.inbox_title': 'செய்திகள்',
      'messaging.empty': 'செய்திகள் இல்லை',
      // REVIEW
      'messaging.empty_body':
          'பணியாளர் அடைவில் இருந்து உரையாடலைத் தொடங்கவும்.',
      // REVIEW
      'messaging.new_message': 'புதிய செய்தி',
      // REVIEW
      'messaging.type_hint': 'செய்தியை உள்ளிடவும்...',
      // REVIEW
      'messaging.send': 'அனுப்பு',
      // REVIEW
      'messaging.set_priority': 'முன்னுரிமை அமை',
      // REVIEW
      'messaging.send_failed_prefix': 'அனுப்ப முடியவில்லை:',
      // REVIEW
      'messaging.thread_load_failed': 'உரையாடலை ஏற்ற முடியவில்லை',
      // REVIEW
      'messaging.thread_empty_title': 'இன்னும் செய்திகள் இல்லை',
      // REVIEW
      'messaging.thread_empty_body': 'கீழே உரையாடலைத் தொடங்கவும்',
      // Time helpers — REVIEW
      'time.just_now': 'இப்பொழுதே',
      'time.yesterday': 'நேற்று',
      'time.today': 'இன்று',
      'time.minutes_ago_suffix': ' நிமிடங்களுக்கு முன்',
      'time.hours_ago_suffix': ' மணி நேரத்திற்கு முன்',
      'time.days_ago_suffix': ' நாட்களுக்கு முன்',
      // Priority / Urgency — REVIEW (clinical wording)
      'priority.low': 'குறைந்த',
      'priority.normal': 'சாதாரண',
      'priority.high': 'உயர்',
      'priority.urgent': 'அவசர',
      'priority.critical': 'அபாயகர',
      'urgency.low': 'குறைந்த',
      'urgency.normal': 'சாதாரண',
      'urgency.high': 'உயர்',
      'urgency.critical': 'அபாயகர',
      // Departments — REVIEW
      'department.general': 'பொது',
      'department.emergency': 'அவசர',
      'department.icu': 'ICU',
      'department.pediatrics': 'குழந்தை மருத்துவம்',
      'department.surgery': 'அறுவை சிகிச்சை',
      'department.outpatient': 'வெளி நோயாளி',
      // About — REVIEW
      'about.title': 'பற்றி',
      'about.header': 'பற்றி',
      'about.app_name': 'VHHealth பணியாளர்',
      'about.version': 'பதிப்பு 1.0.0',
      'about.description':
          'VH Health-ன் மருத்துவமனை பணியாளர் மேலாண்மை ஆப். வருகை, விடுப்பு, சந்திப்புகள் மற்றும் பலவற்றை — அனைத்தையும் உங்கள் மொபைல் சாதனத்தில் இருந்து நிர்வகிக்கவும்.',
      'about.features_header': 'அம்சங்கள்',
      'about.support_header': 'ஆதரவு',
      'about.support_email_label': 'மின்னஞ்சல்',
      'about.website_label': 'வலைத்தளம்',
      'about.copyright':
          '© 2026 VH Health. அனைத்து உரிமைகளும் பாதுகாக்கப்பட்டவை.',
      'about.feature.attendance.title': 'வருகை',
      'about.feature.attendance.description':
          'இடம் கண்காணிப்புடன் உள்/வெளியேறு',
      'about.feature.leave.title': 'விடுப்பு மேலாண்மை',
      'about.feature.leave.description':
          'விடுப்புக்கு விண்ணப்பித்து மீதியைக் கண்காணிக்கவும்',
      'about.feature.appointments.title': 'சந்திப்புகள்',
      'about.feature.appointments.description':
          'நோயாளி சந்திப்புகளைப் பார்த்து நிர்வகிக்கவும்',
      'about.feature.investigations.title': 'விசாரணைகள்',
      'about.feature.investigations.description':
          'ஆய்வக சோதனைகள் மற்றும் நோயறிதல் அறிக்கைகள்',
      'about.feature.pharmacy.title': 'மருந்தகம்',
      'about.feature.pharmacy.description':
          'மருந்துச்சீட்டு மற்றும் வழங்கும் பணிப்பாய்வு',
      'about.feature.staff_directory.title': 'பணியாளர் அடைவு',
      'about.feature.staff_directory.description':
          'சக ஊழியர்களைக் கண்டறிந்து தொடர்பு கொள்ளவும்',
      'about.feature.clinical_modules.title': 'மருத்துவ தொகுதிகள்',
      'about.feature.clinical_modules.description':
          'வைட்டல்ஸ், செவிலியர் குறிப்புகள், மருந்துச்சீட்டுகள்',
      // Leave (additional) — REVIEW
      'leave.type.annual': 'வருடாந்திர',
      'leave.type.sick': 'நோய்வாய்ப்பட்ட',
      'leave.type.casual': 'சாதாரண',
      'leave.type.emergency': 'அவசரம்',
      'leave.type.maternity': 'மகப்பேறு',
      'leave.type.paternity': 'தந்தைமை',
      'leave.type.unpaid': 'ஊதியம் இல்லாத',
      'leave.balance.used': 'பயன்படுத்தியது',
      'leave.leave_type_label': 'விடுப்பு வகை',
      'leave.dates_label': 'தேதிகள்',
      'leave.start_date': 'தொடக்க தேதி',
      'leave.end_date': 'முடிவு தேதி',
      'leave.reason_label': 'காரணம்',
      'leave.reason_hint': 'விடுப்பின் சுருக்கமான காரணம்',
      'leave.replacement_staff_label':
          'மாற்று பணியாளர் (விருப்பம்)',
      'leave.replacement_staff_hint':
          'உங்களுக்காக கவனிக்க ஒரு சகாவைத் தேர்ந்தெடுக்கவும்',
      'leave.replacement_staff_pick':
          'மாற்றைத் தேர்ந்தெடுக்க தட்டவும்',
      'leave.select_replacement': 'மாற்று பணியாளரைத் தேர்ந்தெடு',
      'leave.no_staff_available': 'பணியாளர்கள் இல்லை',
      'leave.search_by_type_hint': 'விடுப்பு வகையால் தேடு…',
      'leave.no_applications': 'விடுப்பு விண்ணப்பங்கள் இல்லை',
      'leave.no_replacement_requests':
          'நிலுவையில் மாற்று கோரிக்கைகள் இல்லை',
      'leave.requester_unknown': 'தெரியாதது',
      'leave.requesting_coverage_for': 'கவரேஜ் கோருவது:',
      'leave.error.select_dates': 'தயவுசெய்து தேதிகளைத் தேர்ந்தெடுக்கவும்',
      'leave.error.provide_reason': 'தயவுசெய்து காரணத்தைக் குறிப்பிடவும்',
      'leave.overtime_title': 'கூடுதல் நேர கோரிக்கை',
      'leave.overtime_subtitle': 'கூடுதல் வேலை நேரத்தை பதிவு செய்',
      'leave.dispute_title': 'வருகை சர்ச்சை',
      'leave.dispute_subtitle': 'பதிவு பிரச்சினையைப் புகாரளி',
      'leave.action.decline': 'நிராகரி',
      'leave.action.accept': 'ஏற்றுக்கொள்',
      // REVIEW: clinical-action confirmation
      'leave.request_accepted': '✅ கோரிக்கை ஏற்கப்பட்டது',
      'leave.request_declined': '❌ கோரிக்கை நிராகரிக்கப்பட்டது',
      'leave.day_count.one': 'நாள்',
      'leave.day_count.other': 'நாட்கள்',
      // Bed sheet (additional) — REVIEW
      'bed_sheet.field.name': 'பெயர்',
      'bed_sheet.field.age': 'வயது',
      'bed_sheet.field.gender': 'பாலினம்',
      'bed_sheet.field.phone': 'தொலைபேசி',
      'bed_sheet.field.chief_complaint': 'முக்கிய புகார்',
      'bed_sheet.field.diagnosis': 'நோயறிதல்',
      'bed_sheet.field.type': 'வகை',
      'bed_sheet.field.attending': 'கவனிக்கும் மருத்துவர்',
      'bed_sheet.field.admitted': 'அனுமதி நேரம்',
      'bed_sheet.year_suffix': 'வயது',
      'bed_sheet.doctor_prefix': 'டாக்டர்.',
      'bed_sheet.patient_details_unavailable':
          'இந்தப் படுக்கைக்கு நோயாளி விவரங்கள் கிடைக்கவில்லை.',
      'bed_sheet.no_patient_assigned': 'தற்போது நோயாளி ஒதுக்கப்படவில்லை.',
      'bed_sheet.saving_label': 'சேமிக்கிறது…',
      'bed_sheet.quick_note_hint':
          'விரைவு குறிப்பு (கையளிப்பு, அபாயங்கள், IV தளம்…)',
      'bed_sheet.dictate_quick_note': 'விரைவு குறிப்பை வாயளந்தெழுது',
      'bed_sheet.this_patient': 'இந்த நோயாளி',
      // REVIEW: clinical-action confirmation
      'bed_sheet.patient_discharged': 'நோயாளி வெளியேற்றப்பட்டார்',
      'bed_sheet.patient_missing_name': 'நோயாளியின் பெயர் இல்லை',
      'bed_sheet.patient_admitted_suffix': 'இந்தப் படுக்கைக்கு அனுமதிக்கப்பட்டார்',
      'bed_sheet.marked_as_prefix': 'படுக்கை குறிக்கப்பட்டது:',
      // Vitals — REVIEW
      'vitals.title': 'வைட்டல்ஸ் உள்ளீடு',
      'vitals.tab.record': 'வைட்டல்ஸ் பதிவு',
      'vitals.tab.recent': 'சமீபத்திய வைட்டல்ஸ்',
      'vitals.header_title': 'நோயாளி வைட்டல்ஸ் பதிவு செய்',
      'vitals.header_subtitle': 'நோயாளி ID மூலம் வைட்டல்ஸ் உள்ளிடவும்',
      'vitals.patient_id_label': 'நோயாளி ID',
      'vitals.patient_id_hint': 'நோயாளி ID உள்ளிடவும்',
      'vitals.patient_id_required': 'நோயாளி ID தேவை',
      'vitals.patient_id_invalid': 'சரியான எண்ணை உள்ளிடவும்',
      'vitals.bp_header': 'இரத்த அழுத்தம்',
      'vitals.bp_systolic': 'சிஸ்டாலிக்',
      'vitals.bp_systolic_hint': 'எ.கா. 120',
      'vitals.bp_diastolic': 'டயஸ்டாலிக்',
      'vitals.bp_diastolic_hint': 'எ.கா. 80',
      'vitals.temperature_header': 'வெப்பநிலை',
      'vitals.temperature_hint': 'எ.கா. 98.6',
      'vitals.pulse_spo2_header': 'நாடித்துடிப்பு & ஆக்ஸிஜன் செறிவு',
      'vitals.pulse_label': 'நாடித்துடிப்பு',
      'vitals.pulse_hint': 'எ.கா. 72',
      'vitals.spo2_label': 'SpO₂',
      'vitals.spo2_hint': 'எ.கா. 98',
      'vitals.weight_header': 'எடை',
      'vitals.weight_hint': 'எ.கா. 70.5',
      'vitals.nurse_notes_label': 'செவிலியர் குறிப்புகள் (விருப்பம்)',
      'vitals.nurse_notes_hint': 'ஏதேனும் கவனிப்புகள் அல்லது கவலைகள்...',
      'vitals.validation.invalid': 'தவறான',
      'vitals.save_button': 'வைட்டல்ஸ் சேமி',
      'vitals.fetch_button': 'பெறு',
      'vitals.trends_hint':
          'வைட்டல் போக்குகளைக் காண நோயாளி ID உள்ளிடவும்',
      'vitals.no_records':
          'இந்த நோயாளிக்கு வைட்டல் பதிவுகள் எதுவும் இல்லை',
      // REVIEW: clinical-action confirmation
      'vitals.recorded_success': 'வைட்டல்ஸ் வெற்றிகரமாக பதிவு செய்யப்பட்டது',
      // REVIEW: clinical / connectivity message
      'vitals.offline_queued':
          'இணைப்பு இல்லை — வைட்டல்ஸ் சேமிக்கப்பட்டு ஆன்லைனில் சிங்க் ஆகும்',
      // Nursing Notes — REVIEW
      'nursing_notes.title': 'செவிலியர் குறிப்புகள்',
      'nursing_notes.tab.add': 'குறிப்பு சேர்',
      'nursing_notes.tab.recent': 'சமீபத்திய குறிப்புகள்',
      'nursing_notes.backend_coming_soon':
          'பின்தள ஒருங்கிணைப்பு விரைவில் வரும். குறிப்புகள் உள்ளூரில் காட்டப்படுகின்றன.',
      'nursing_notes.patient_phone_label': 'நோயாளி தொலைபேசி எண்',
      'nursing_notes.patient_phone_hint': '+91 XXXXX XXXXX',
      'nursing_notes.phone_required': 'தொலைபேசி தேவை',
      'nursing_notes.phone_invalid': 'சரியான தொலைபேசி எண்ணை உள்ளிடவும்',
      'nursing_notes.type_label': 'குறிப்பு வகை',
      'nursing_notes.type_required': 'குறிப்பு வகையைத் தேர்ந்தெடு',
      'nursing_notes.priority_label': 'முன்னுரிமை',
      'nursing_notes.clinical_note_label': 'மருத்துவ குறிப்பு',
      'nursing_notes.clinical_note_hint':
          'கவனிப்புகள், வழங்கப்பட்ட சேவை, நோயாளியின் பதில் ஆகியவற்றை விவரிக்கவும்...',
      'nursing_notes.note_required': 'குறிப்பு தேவை',
      'nursing_notes.note_too_short': 'குறிப்பு மிகவும் சிறியது',
      'nursing_notes.save_button': 'குறிப்பை சேமி',
      // REVIEW: clinical-action confirmation
      'nursing_notes.saved_success':
          'செவிலியர் குறிப்பு வெற்றிகரமாக சேமிக்கப்பட்டது',
      // REVIEW: clinical / connectivity message
      'nursing_notes.offline_queued':
          'ஆஃப்லைன் சேமிக்கப்பட்டது — இணைக்கப்படும்போது சிங்க் ஆகும்',
      'nursing_notes.recent_empty':
          'பின்தள API இணைக்கப்பட்டவுடன் உங்கள் சமீபத்திய செவிலியர் குறிப்புகள் இங்கே தோன்றும்.',
      'nursing_notes.type.observation': 'கவனிப்பு',
      'nursing_notes.type.medication': 'மருந்து குறிப்பு',
      'nursing_notes.type.post_procedure': 'பின் செயல்முறை',
      'nursing_notes.type.intake_output': 'உள்ளீடு/வெளியீடு',
      'nursing_notes.type.patient_complaint': 'நோயாளியின் புகார்',
      'nursing_notes.type.wound_care': 'காயம் பராமரிப்பு',
      'nursing_notes.type.shift_handover': 'பணி கையளிப்பு',
      'nursing_notes.type.emergency_note': 'அவசர குறிப்பு',
      'nursing_notes.type.other': 'மற்றவை',
      // Handover — REVIEW
      'handover.title': 'கையளிப்பு குறிப்புகள்',
      'handover.tab.write': 'எழுது',
      'handover.tab.recent': 'சமீபத்திய',
      'handover.department_label': 'துறை',
      'handover.urgency_label': 'அவசரம்',
      'handover.notes_label': 'கையளிப்பு குறிப்புகள்',
      'handover.notes_hint':
          'முக்கிய கவனிப்புகள், நிலுவையில் உள்ள பணிகள், மருந்து மாற்றங்கள்...',
      'handover.notes_required': 'குறிப்புகள் தேவை',
      'handover.patient_ref_label': 'நோயாளி குறிப்புகள் (விருப்பம்)',
      'handover.patient_ref_hint':
          'அறை 201 - திரு. சர்மா, அறை 305 - திருமதி பட்டேல்',
      'handover.submit_button': 'கையளிப்பை சமர்ப்பி',
      'handover.submitting_button': 'சமர்ப்பிக்கிறது...',
      // REVIEW: clinical-action confirmation
      'handover.submitted': 'கையளிப்பு குறிப்பு சமர்ப்பிக்கப்பட்டது',
      'handover.recent_empty_title': 'சமீபத்திய கையளிப்பு குறிப்புகள் இல்லை',
      'handover.recent_empty_body':
          'கடந்த 24 மணி நேர குறிப்புகள் இங்கே தோன்றும்',
      'handover.note_fallback_title': 'கையளிப்பு குறிப்பு',
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
      // Bed Board (additions) — REVIEW
      'bed_board.no_wards_yet': 'வார்டுகள் இல்லை',
      'bed_board.ward_stat.total': 'மொத்தம்',
      'bed_board.ward_stat.free': 'காலி',
      'bed_board.ward_stat.used': 'பயன்பாட்டில்',
      'bed_board.count.available_suffix': 'கிடைக்கும்',
      'bed_board.back_to_wards': 'வார்டு பட்டியலுக்கு திரும்பு',
      'bed_board.ward_fallback': 'வார்டு',
      'bed_board.print_tooltip': 'படுக்கை பலகை அச்சிடு',
      'bed_board.refresh_tooltip': 'படுக்கை பலகை புதுப்பி',
      'bed_board.print_failed_prefix': 'அச்சிடல் தோல்வி:',
      'bed_board.no_filtered_prefix': 'இந்த வார்டில்',
      'bed_board.no_filtered_suffix': 'படுக்கைகள் இல்லை',
      'bed_board.admit_which_patient':
          'எந்த நோயாளியை அனுமதி?',
      'bed_board.admit_search_hint':
          'பெயர், தொலைபேசி அல்லது ABHA மூலம் தேடு…',
      'bed_board.type_to_find_patient':
          'நோயாளியை தேட தட்டச்சு செய்யவும்.',
      'bed_board.patient_unnamed': 'பெயரில்லை',
      // Doctor queue — REVIEW
      'queue.title': 'நோயாளி வரிசை',
      'queue.refresh_tooltip': 'வரிசையை புதுப்பி',
      'queue.section.in_consultation': 'ஆலோசனையில்',
      'queue.section.waiting_prefix': 'காத்திருக்கும்',
      'queue.section.completed_prefix': 'முடிந்தது',
      'queue.call_next_patient': 'அடுத்த நோயாளியை அழைக்கவும்',
      // REVIEW: clinical-action confirmation
      'queue.complete_consultation': 'ஆலோசனையை முடிக்கவும்',
      'queue.call_tooltip': 'அழைக்கவும்',
      'queue.no_patients_waiting': 'காத்திருக்கும் நோயாளிகள் இல்லை',
      'queue.no_completed_consultations': 'முடிந்த ஆலோசனைகள் இல்லை',
      'queue.waiting_prefix': 'காத்திருக்கிறது',
      'queue.in_prefix': 'வரும்',
      'queue.patient_info': 'நோயாளி தகவல்',
      'queue.recent_records': 'சமீபத்திய பதிவுகள்',
      'queue.no_health_records_found':
          'சுகாதார பதிவுகள் காணப்படவில்லை',
      // REVIEW: clinical / safety — allergies surfacing
      'queue.allergies_prefix': 'ஒவ்வாமைகள்:',
      'queue.age_prefix': '• வயது:',
      'queue.write_prescription': 'மருந்துச்சீட்டு எழுது',
      'queue.order_investigation': 'விசாரணை ஆணை',
      'queue.add_notes': 'குறிப்புகள் சேர்',
      'queue.no_phone_number': 'தொலைபேசி எண் இல்லை',
      'queue.record_fallback': 'பதிவு',
      'queue.unknown_patient': 'தெரியாதது',
      // Prescriptions — REVIEW
      'prescriptions.title': 'ஈ-மருந்துச்சீட்டுகள்',
      'prescriptions.tab.new': 'புதிய மருந்துச்சீட்டு',
      'prescriptions.tab.recent': 'சமீபத்திய',
      'prescriptions.error.select_patient_doctor':
          'தயவுசெய்து நோயாளி மற்றும் மருத்துவரை தேர்ந்தெடுக்கவும்',
      'prescriptions.error.fill_medication_names':
          'எல்லா மருந்துகளின் பெயர்களையும் நிரப்பவும்',
      'prescriptions.photo.title': 'மருந்துச்சீட்டு புகைப்படம்',
      'prescriptions.photo.body':
          'புகைப்படம் எடு அல்லது கேலரியில் இருந்து தேர்ந்தெடு?',
      'prescriptions.photo.camera': 'கேமரா',
      'prescriptions.photo.gallery': 'கேலரி',
      'prescriptions.vitals_collapse': 'வைட்டல்ஸ் (விருப்பம்)',
      'prescriptions.diagnosis_label': 'நோயறிதல் / முக்கிய புகார் *',
      'prescriptions.diagnosis_required': 'நோயறிதல் தேவை',
      'prescriptions.medications_header': 'மருந்துகள் *',
      'prescriptions.add_button': 'சேர்',
      'prescriptions.set_follow_up': 'பின்தொடர்தல் தேதியை அமை',
      'prescriptions.follow_up_prefix': 'பின்தொடர்தல்:',
      'prescriptions.clear_follow_up':
          'பின்தொடர்தல் தேதியை அழி',
      'prescriptions.follow_up_notes': 'பின்தொடர்தல் குறிப்புகள்',
      'prescriptions.follow_up_notes_hint':
          'எ.கா. இரத்த அறிக்கைகளை கொண்டுவாரும்',
      'prescriptions.clinical_notes':
          'மருத்துவ குறிப்புகள் / ஆலோசனை',
      'prescriptions.clinical_notes_hint':
          'ஓய்வு, உணவு, பின்தொடர்தல் வழிமுறைகள்...',
      'prescriptions.photo_attached': 'புகைப்படம் இணைக்கப்பட்டது ✓',
      'prescriptions.attach_handwritten':
          'கையெழுத்து மருந்துச்சீட்டு இணை (விருப்பம்)',
      'prescriptions.creating': 'உருவாக்குகிறது...',
      'prescriptions.create': 'மருந்துச்சீட்டு உருவாக்கு',
      'prescriptions.created_prefix': 'மருந்துச்சீட்டு',
      'prescriptions.created_suffix': 'உருவாக்கப்பட்டது',
      'prescriptions.patient_label': 'நோயாளி',
      'prescriptions.doctor_label': 'மருத்துவர்',
      'prescriptions.search_patient':
          'நோயாளியை தேடு (தொலைபேசி/பெயர்)',
      'prescriptions.search_doctor': 'மருத்துவரை தேடு',
      'prescriptions.remove_medication': 'மருந்தை அகற்று',
      'prescriptions.medicine_name': 'மருந்து பெயர் *',
      'prescriptions.medicine_name_hint':
          'தேட தட்டச்சு செய் (எ.கா. டோலோ, பான்)',
      'prescriptions.dosage': 'அளவு',
      'prescriptions.dosage_hint': '500mg',
      'prescriptions.frequency': 'அதிர்வெண்',
      'prescriptions.duration': 'காலம்',
      'prescriptions.duration_hint': '5 நாட்கள்',
      'prescriptions.route': 'வழி',
      'prescriptions.instructions': 'வழிமுறைகள்',
      'prescriptions.instructions_hint': 'உணவுக்குப் பிறகு',
      'prescriptions.qty': 'அளவு',
      'prescriptions.medicine_index_prefix': 'மருந்து',
      'prescriptions.bp_systolic': 'BP சிஸ்டாலிக்',
      'prescriptions.bp_diastolic': 'BP டயஸ்டாலிக்',
      'prescriptions.pulse': 'நாடித்துடிப்பு',
      'prescriptions.temp': 'வெப்பநிலை',
      'prescriptions.spo2': 'SpO2',
      'prescriptions.weight': 'எடை',
      'prescriptions.blood_sugar': 'இரத்த சர்க்கரை',
      'prescriptions.none_yet': 'இன்னும் மருந்துச்சீட்டுகள் இல்லை',
      'prescriptions.ordered_chip': 'ஆணையிடப்பட்டது',
      'prescriptions.detail.diagnosis': 'நோயறிதல்',
      'prescriptions.detail.medications': 'மருந்துகள்',
      // Patient records (doctor) — REVIEW
      'patient_records.title': 'நோயாளி பதிவுகள்',
      'patient_records.search_hint':
          'நோயாளி பெயர் அல்லது வகை மூலம் தேடு...',
      'patient_records.clear_tooltip': 'தேடலை அழி',
      'patient_records.retry': 'மீண்டும் முயற்சி',
      'patient_records.no_found': 'பதிவுகள் காணப்படவில்லை',
      'patient_records.empty': 'நோயாளி பதிவுகள் இல்லை',
      'patient_records.empty_body':
          'நோயாளி பதிவுகள் இங்கே தோன்றும்',
      'patient_records.details': 'பதிவு விவரங்கள்',
      'patient_records.unknown_patient': 'தெரியாத நோயாளி',
      // Appointment queue — REVIEW
      'appt_queue.title': 'சந்திப்பு வரிசை',
      'appt_queue.walk_in': 'வாக்-இன்',
      'appt_queue.tab.today_prefix': 'இன்றைய வரிசை',
      'appt_queue.tab.pending_prefix': 'நிலுவையில்',
      'appt_queue.no_today': 'இன்று சந்திப்புகள் இல்லை',
      'appt_queue.all_confirmed':
          'அனைத்து சந்திப்புகளும் உறுதிப்படுத்தப்பட்டன!',
      'appt_queue.confirm_title': 'சந்திப்பை உறுதிப்படுத்து',
      'appt_queue.change_date': 'தேதியை மாற்று',
      'appt_queue.change_time': 'நேரத்தை மாற்று',
      'appt_queue.notes_optional': 'குறிப்புகள் (விருப்பம்)',
      'appt_queue.confirm_appointment':
          'சந்திப்பை உறுதிப்படுத்து',
      // REVIEW: clinical-action confirmation
      'appt_queue.confirmed_toast':
          'சந்திப்பு உறுதிப்படுத்தப்பட்டது ✓',
      'appt_queue.failed_prefix': 'தோல்வி:',
      'appt_queue.no_show_title':
          'வராதவர் என குறிக்கவா?',
      'appt_queue.no_show_body_suffix':
          'வரவில்லையா?',
      'appt_queue.mark_no_show': 'வராதவர் என குறி',
      // REVIEW: clinical-action confirmation
      'appt_queue.no_show_marked': 'வராதவர் என குறிக்கப்பட்டது',
      'appt_queue.complete_title': 'சந்திப்பை முடிக்கவும்',
      'appt_queue.complete_body_prefix': 'குறிக்கவா',
      'appt_queue.complete_body_suffix': 'முடிந்ததாக?',
      'appt_queue.complete_action': 'முடிக்கவும்',
      // REVIEW: clinical-action confirmation
      'appt_queue.completed_toast': 'சந்திப்பு முடிந்தது ✓',
      'appt_queue.rx_prompt_title':
          'ஈ-மருந்துச்சீட்டு உருவாக்கவா?',
      'appt_queue.rx_prompt_body':
          'இந்த வருகைக்கு கட்டமைக்கப்பட்ட ஈ-மருந்துச்சீட்டு உருவாக்கவா? நோயாளி அதிலிருந்து நேரடியாக மருந்துகளை ஆர்டர் செய்யலாம்.',
      'appt_queue.skip': 'தவிர்',
      'appt_queue.upload_doc': 'ஆவணம் பதிவேற்று',
      'appt_queue.e_prescription': 'ஈ-மருந்துச்சீட்டு',
      'appt_queue.upload_document': 'ஆவணம் பதிவேற்று',
      'appt_queue.doc_type': 'ஆவண வகை',
      'appt_queue.attach_file_pick': 'கோப்பு தேர்ந்தெடு',
      'appt_queue.camera': 'கேமரா',
      // REVIEW: clinical-action confirmation
      'appt_queue.doc_uploaded': 'ஆவணம் பதிவேற்றப்பட்டது ✓',
      'appt_queue.upload_failed_prefix': 'பதிவேற்றம் தோல்வி:',
      'appt_queue.register_walk_in': 'வாக்-இன் பதிவு செய்',
      'appt_queue.patient_phone': 'நோயாளி தொலைபேசி *',
      'appt_queue.patient_phone_required':
          'நோயாளி தொலைபேசி தேவை',
      'appt_queue.patient_name': 'நோயாளி பெயர்',
      'appt_queue.department': 'துறை',
      'appt_queue.reason': 'காரணம்',
      'appt_queue.reason_hint': 'வாக்-இன் ஆலோசனை',
      'appt_queue.walk_in_registered_prefix':
          'வாக்-இன் பதிவு செய்யப்பட்டது! டோக்கன்',
      'appt_queue.retry': 'மீண்டும் முயற்சி',
      'appt_queue.close': 'மூடு',
      'appt_queue.action.confirm': 'உறுதிப்படுத்து',
      'appt_queue.action.complete': 'முடி',
      'appt_queue.action.no_show': 'வராதவர்',
      'appt_queue.action.upload_doc': 'ஆவணம் பதிவேற்று',
      'appt_queue.call_confirm': 'அழைப்பு & உறுதிப்படுத்து',
      'appt_queue.sla_breached': 'SLA மீறப்பட்டது',
      'appt_queue.booked_prefix': 'புக் செய்யப்பட்டது',
      'appt_queue.patient_fallback': 'நோயாளி',
      // Admission — REVIEW
      'admission.title': 'அனுமதிகள்',
      'admission.admit': 'அனுமதி',
      'admission.admit_patient': 'நோயாளியை அனுமதி',
      'admission.patient_label':
          'நோயாளி (பெயர், UID, அல்லது தொலைபேசி)',
      'admission.required': 'தேவை',
      'admission.chief_complaint': 'முக்கிய புகார்',
      'admission.diagnosis': 'அதிமீக நோயறிதல்',
      'admission.ward': 'வார்டு',
      'admission.bed_number': 'படுக்கை எண்',
      'admission.priority_label': 'முன்னுரிமை',
      'admission.priority.routine': 'வழக்கமான',
      // REVIEW: clinical urgency wording
      'admission.priority.urgent': 'அவசர',
      'admission.priority.emergency': 'அவசர நிலை',
      'admission.priority.critical': 'அபாயகர',
      'admission.code_status': 'குறியீட்டு நிலை',
      // REVIEW: clinical-action — DNR/DNI standard medical
      'admission.code.full': 'முழு குறியீடு',
      'admission.code.dnr': 'DNR',
      'admission.code.dnr_dni': 'DNR/DNI',
      'admission.code.comfort': 'ஆறுதல் பராமரிப்பு',
      // REVIEW: clinical-action confirmation
      'admission.admitted_success':
          'நோயாளி வெற்றிகரமாக அனுமதிக்கப்பட்டார்',
      'admission.failed_prefix': 'அனுமதி தோல்வி:',
      'admission.no_active': 'செயலில் அனுமதிகள் இல்லை',
      'admission.patient_information': 'நோயாளி தகவல்',
      'admission.details': 'அனுமதி விவரங்கள்',
      'admission.quick_actions': 'விரைவு செயல்கள்',
      'admission.uid': 'UID',
      'admission.age_gender': 'வயது/பாலினம்',
      'admission.blood_group': 'இரத்த வகை',
      'admission.allergies': 'ஒவ்வாமைகள்',
      'admission.ward_field': 'வார்டு',
      'admission.bed_field': 'படுக்கை',
      'admission.admitted_on': 'அனுமதிக்கப்பட்ட நாள்',
      'admission.diagnosis_field': 'நோயறிதல்',
      'admission.priority_field': 'முன்னுரிமை',
      'admission.attending': 'கவனிக்கும்',
      'admission.action.vitals': 'வைட்டல்ஸ்',
      'admission.action.notes': 'குறிப்புகள்',
      'admission.action.orders': 'ஆணைகள்',
      'admission.action.timeline': 'காலவரிசை',
      'admission.retry': 'மீண்டும் முயற்சி',
      'admission.number_prefix': 'அனுமதி',
      'admission.patient_fallback': 'நோயாளி',
      // Patient timeline — REVIEW
      'timeline.title': 'நோயாளி காலவரிசை',
      'timeline.title_prefix': 'காலவரிசை',
      'timeline.retry': 'மீண்டும் முயற்சி',
      'timeline.no_events': 'நிகழ்வுகள் இல்லை',
      'timeline.filter.all': 'அனைத்தும்',
      'timeline.filter.admission': 'அனுமதி',
      'timeline.filter.vitals': 'வைட்டல்ஸ்',
      'timeline.filter.note': 'குறிப்பு',
      'timeline.filter.order': 'ஆணை',
      'timeline.filter.medication': 'மருந்து',
      'timeline.filter.investigation': 'விசாரணை',
      'timeline.filter.discharge': 'வெளியேற்றம்',
      'timeline.event_fallback': 'மருத்துவ நிகழ்வு',
      'timeline.event_title_suffix': 'நிகழ்வு',
      'timeline.by_prefix': 'மூலம்',
      'timeline.department': 'துறை',
      'timeline.details': 'விவரங்கள்',
      // Orders — REVIEW
      'orders.title': 'நோயாளி ஆணைகள்',
      'orders.title_prefix': 'ஆணைகள்',
      'orders.new_order': 'புதிய ஆணை',
      'orders.type.medication': 'மருந்து ஆணை',
      'orders.type.investigation': 'விசாரணை ஆணை',
      'orders.type.nursing': 'செவிலியர் ஆணை',
      'orders.medication_name': 'மருந்து பெயர்',
      'orders.dosage': 'அளவு',
      'orders.route': 'வழி',
      'orders.route_hint': 'PO, IV, IM...',
      'orders.frequency': 'அதிர்வெண்',
      'orders.frequency_hint': 'OD, BD, TDS...',
      'orders.duration': 'காலம்',
      'orders.duration_hint': '5 நாட்கள்',
      'orders.special_instructions': 'சிறப்பு வழிமுறைகள்',
      // REVIEW: clinical urgency wording
      'orders.stat_immediate': 'STAT (உடனடி)',
      'orders.investigation': 'விசாரணை',
      'orders.investigation_hint': 'CBC, RFT, CT ஸ்கேன்...',
      'orders.clinical_indication': 'மருத்துவ அறிகுறி',
      'orders.priority': 'முன்னுரிமை',
      'orders.priority.routine': 'வழக்கமான',
      'orders.priority.urgent': 'அவசர',
      'orders.priority.stat': 'STAT',
      'orders.fasting_required': 'உண்ணாவிரதம் தேவை',
      'orders.description': 'ஆணை விளக்கம்',
      'orders.description_hint':
          'காய பராமரிப்பு, நிலை, கண்காணிப்பு...',
      'orders.frequency_hint_nursing':
          'ஒவ்வொரு 4 மணிநேரத்திற்கும், PRN, ஒருமுறை...',
      'orders.place_order': 'ஆணை வை',
      // REVIEW: clinical-action confirmation
      'orders.placed_success': 'ஆணை வெற்றிகரமாக வைக்கப்பட்டது',
      'orders.place_failed_prefix': 'ஆணை வைக்க முடியவில்லை:',
      // REVIEW: clinical-safety messaging
      'orders.clinical_alerts': 'மருத்துவ எச்சரிக்கைகள்',
      'orders.proceed_anyway': 'எப்படியும் தொடரவும்',
      'orders.filter.all': 'அனைத்தும்',
      'orders.filter.ordered': 'ஆணையிட்டது',
      'orders.filter.verified': 'சரிபார்க்கப்பட்டது',
      'orders.filter.completed': 'முடிந்தது',
      'orders.filter.cancelled': 'ரத்து செய்யப்பட்டது',
      'orders.no_found': 'ஆணைகள் இல்லை',
      'orders.fallback': 'ஆணை',
      'orders.verify': 'சரிபார்',
      'orders.complete': 'முடி',
      // REVIEW: clinical-action confirmation
      'orders.verified_toast': 'ஆணை சரிபார்க்கப்பட்டது',
      'orders.verify_failed_prefix': 'சரிபார்ப்பு தோல்வி:',
      // REVIEW: clinical-action confirmation
      'orders.completed_toast': 'ஆணை முடிந்தது',
      'orders.complete_failed_prefix':
          'ஆணை முடிக்க முடியவில்லை:',
      'orders.retry': 'மீண்டும் முயற்சி',
      // Vitals chart — REVIEW
      'vitals_chart.title': 'வைட்டல்ஸ் சார்ட்டிங்',
      'vitals_chart.title_prefix': 'வைட்டல்ஸ்',
      'vitals_chart.tab.record': 'பதிவு',
      'vitals_chart.tab.last_24h': 'கடைசி 24 மணிநேரம்',
      'vitals_chart.tab.io_balance': 'I/O இருப்பு',
      'vitals_chart.record_vitals': 'வைட்டல்ஸ் பதிவு',
      'vitals_chart.heart_rate': 'இதய துடிப்பு (bpm)',
      'vitals_chart.bp_sys': 'BP சிஸ்டாலிக்',
      'vitals_chart.bp_dia': 'BP டயஸ்டாலிக்',
      'vitals_chart.temp': 'வெப்பநிலை (°F)',
      'vitals_chart.spo2': 'SpO2 (%)',
      'vitals_chart.resp_rate': 'சுவாச வீதம்',
      'vitals_chart.glucose': 'குளுக்கோஸ் (mg/dL)',
      'vitals_chart.pain': 'வலி (0-10)',
      'vitals_chart.gcs': 'GCS (3-15)',
      'vitals_chart.consciousness': 'உணர்வு',
      'vitals_chart.conscious.alert': 'விழிப்பாக',
      'vitals_chart.conscious.verbal':
          'குரலுக்கு பதிலளிக்கிறது',
      'vitals_chart.conscious.pain': 'வலிக்கு பதிலளிக்கிறது',
      'vitals_chart.conscious.unresp': 'பதிலளிக்காத',
      'vitals_chart.save_button': 'வைட்டல்ஸ் சேமி',
      'vitals_chart.at_least_one':
          'குறைந்தது ஒரு உயிர் அளவீட்டை உள்ளிடவும்',
      // REVIEW: clinical-action confirmation
      'vitals_chart.recorded_success':
          'வைட்டல்ஸ் வெற்றிகரமாக பதிவு செய்யப்பட்டது',
      'vitals_chart.record_failed_prefix':
          'வைட்டல்ஸ் பதிவு செய்ய முடியவில்லை:',
      'vitals_chart.record_io': 'I/O பதிவு',
      'vitals_chart.intake': 'உள்ளீடு',
      'vitals_chart.output': 'வெளியீடு',
      'vitals_chart.category': 'வகை',
      'vitals_chart.intake.oral': 'வாய்வழி',
      'vitals_chart.intake.iv': 'IV திரவங்கள்',
      'vitals_chart.intake.blood': 'இரத்த தயாரிப்புகள்',
      'vitals_chart.intake.ng': 'NG குழாய்',
      'vitals_chart.cat.other': 'மற்றவை',
      'vitals_chart.output.urine': 'சிறுநீர்',
      'vitals_chart.output.drain': 'வடிகுழாய்',
      'vitals_chart.output.emesis': 'வாந்தி',
      'vitals_chart.output.stool': 'மலம்',
      'vitals_chart.output.blood_loss': 'இரத்த இழப்பு',
      'vitals_chart.amount': 'அளவு (mL)',
      'vitals_chart.io_description': 'விளக்கம் (விருப்பம்)',
      'vitals_chart.io_record': 'பதிவு',
      // REVIEW: clinical-action confirmation
      'vitals_chart.io_success': 'I/O வெற்றிகரமாக பதிவு செய்யப்பட்டது',
      'vitals_chart.io_failed_prefix':
          'I/O பதிவு செய்ய முடியவில்லை:',
      'vitals_chart.retry': 'மீண்டும் முயற்சி',
      'vitals_chart.no_vitals':
          'கடந்த 24 மணிநேரத்தில் வைட்டல்ஸ் இல்லை',
      'vitals_chart.col.time': 'நேரம்',
      'vitals_chart.col.hr': 'HR',
      'vitals_chart.col.bp': 'BP',
      'vitals_chart.col.temp': 'வெப்பநிலை',
      'vitals_chart.col.spo2': 'SpO2',
      'vitals_chart.col.rr': 'RR',
      'vitals_chart.col.glucose': 'குளுக்கோஸ்',
      'vitals_chart.col.pain': 'வலி',
      'vitals_chart.col.gcs': 'GCS',
      'vitals_chart.col.avpu': 'AVPU',
      'vitals_chart.intake_label': 'உள்ளீடு',
      'vitals_chart.output_label': 'வெளியீடு',
      'vitals_chart.balance_label': 'இருப்பு',
      'vitals_chart.record_io_entry': 'I/O உள்ளீடு பதிவு',
      'vitals_chart.today_entries': 'இன்றைய உள்ளீடுகள்',
      'vitals_chart.no_io_today':
          'இன்று I/O உள்ளீடுகள் பதிவு செய்யப்படவில்லை',
      'vitals_chart.record_for_prefix': 'இவருக்கு வைட்டல்ஸ் பதிவு:',
      'vitals_chart.record_patient':
          'நோயாளி வைட்டல்ஸ் பதிவு',
      'vitals_chart.record_now': 'இப்போது வைட்டல்ஸ் பதிவு',
      // Clinical notes — REVIEW
      'clinical_notes.title': 'மருத்துவ குறிப்புகள்',
      'clinical_notes.title_prefix': 'குறிப்புகள்',
      'clinical_notes.tab.soap': 'SOAP குறிப்புகள்',
      'clinical_notes.tab.progress': 'முன்னேற்ற குறிப்புகள்',
      'clinical_notes.tab.procedure': 'செயல்முறை குறிப்புகள்',
      'clinical_notes.new_note': 'புதிய குறிப்பு',
      // REVIEW: clinical-action — signed/unsigned status
      'clinical_notes.signed': 'கையெழுத்திட்டது',
      'clinical_notes.unsigned': 'கையெழுத்தில்லை',
      'clinical_notes.retry': 'மீண்டும் முயற்சி',
      'clinical_notes.no_found_prefix':
          'எந்த',
      'clinical_notes.no_found_suffix': 'குறிப்புகள் காணப்படவில்லை',
      // REVIEW: clinical-action confirmation
      'clinical_notes.sign_note': 'குறிப்பில் கையெழுத்து',
      // REVIEW: clinical-action confirmation
      'clinical_notes.signed_success':
          'குறிப்பு வெற்றிகரமாக கையெழுத்திடப்பட்டது',
      'clinical_notes.sign_failed_prefix':
          'குறிப்பில் கையெழுத்திட முடியவில்லை:',
      'clinical_notes.note_fallback': 'மருத்துவ குறிப்பு',
      'clinical_notes.unknown_author': 'தெரியாதது',
      'clinical_notes.subjective': 'அகநிலை',
      'clinical_notes.objective': 'புறநிலை',
      'clinical_notes.assessment': 'மதிப்பீடு',
      'clinical_notes.plan': 'திட்டம்',
      'clinical_notes.content': 'உள்ளடக்கம்',
      'clinical_notes.findings': 'கண்டுபிடிப்புகள்',
      'clinical_notes.procedure_details': 'செயல்முறை விவரங்கள்',
      'clinical_notes.complications': 'சிக்கல்கள்',
      'clinical_notes.new_soap': 'புதிய SOAP குறிப்பு',
      'clinical_notes.new_progress': 'புதிய முன்னேற்ற குறிப்பு',
      'clinical_notes.new_procedure': 'புதிய செயல்முறை குறிப்பு',
      'clinical_notes.subjective_hint':
          'நோயாளி புகார்கள், அறிகுறிகள், வரலாறு...',
      'clinical_notes.objective_hint':
          'பரிசோதனை கண்டுபிடிப்புகள், வைட்டல்ஸ், ஆய்வக முடிவுகள்...',
      'clinical_notes.assessment_hint':
          'நோயறிதல், மருத்துவ எண்ணம்...',
      'clinical_notes.plan_hint':
          'சிகிச்சை திட்டம், ஆணைகள், பின்தொடர்தல்...',
      'clinical_notes.title_field': 'தலைப்பு',
      'clinical_notes.content_hint':
          'மருத்துவ முன்னேற்றம், கவனிப்புகள், திட்ட மாற்றங்கள்...',
      'clinical_notes.procedure_name': 'செயல்முறை பெயர்',
      'clinical_notes.procedure_details_hint':
          'நுட்பம், அணுகுமுறை, படிகள்...',
      'clinical_notes.findings_hint':
          'செயல்முறையின் போதான கண்டுபிடிப்புகள்...',
      'clinical_notes.complications_hint':
          'சந்தித்த எந்த சிக்கல்களும்...',
      'clinical_notes.required': 'தேவை',
      'clinical_notes.save_note': 'குறிப்பை சேமி',
      // REVIEW: clinical-action confirmation
      'clinical_notes.created_success':
          'குறிப்பு வெற்றிகரமாக உருவாக்கப்பட்டது',
      'clinical_notes.create_failed_prefix':
          'குறிப்பை உருவாக்க முடியவில்லை:',
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
      // REVIEW: app branding — keep VHHealth as proper noun
      'login.app_title': 'VHHealth సిబ్బంది',
      'login.portal_subtitle': 'ఆసుపత్రి సిబ్బంది పోర్టల్',
      'login.screen_title': 'సైన్ ఇన్',
      'login.screen_subtitle':
          'పోర్టల్‌ని యాక్సెస్ చేయడానికి మీ ఉద్యోగి ఆధారాలను ఉపయోగించండి',
      'login.employee_id_hint': '1001',
      'login.employee_id_required': 'ఉద్యోగి సంఖ్య అవసరం',
      'login.employee_id_numbers_only': 'సంఖ్యలు మాత్రమే (1–6 అంకెలు)',
      'login.mode.password': 'పాస్‌వర్డ్',
      'login.mode.pin': 'PIN',
      'login.mode.quick': 'త్వరిత',
      'login.pin_field_label': 'PIN',
      'login.pin_hint': '4–6 అంకెలు',
      'login.pin_required': 'PIN అవసరం',
      'login.pin_min_digits': 'కనీసం 4 అంకెలు',
      'login.quick_pin_label': 'PIN (లేదా బయోమెట్రిక్ ఉపయోగించండి)',
      'login.quick_pin_hint': 'త్వరిత యాక్సెస్ కోసం PIN నమోదు చేయండి',
      'login.remember_employee_id': 'ఉద్యోగి IDని గుర్తుంచుకో',
      // REVIEW: security message wording
      'login.locked_title': 'ఖాతా తాత్కాలికంగా లాక్ చేయబడింది',
      // REVIEW: security message wording — confirm 15-min phrasing
      'login.locked_hint':
          'చాలా విఫల ప్రయత్నాలు. 15 నిమిషాల్లో మళ్ళీ ప్రయత్నించండి లేదా మీ సూపర్‌వైజర్‌ను సంప్రదించండి.',
      'login.sign_in_with_password': 'పాస్‌వర్డ్‌తో సైన్ ఇన్',
      'login.sign_in_with_pin': 'PIN-తో సైన్ ఇన్',
      'login.quick_sign_in': 'త్వరిత సైన్ ఇన్',
      'login.footer': 'VHHealth · సిబ్బంది యాక్సెస్ మాత్రమే',
      // Dashboard (additional)
      'dashboard.welcome_back': 'తిరిగి స్వాగతం',
      'dashboard.see_all': 'అన్నీ చూడండి',
      'dashboard.all_features': 'అన్ని ఫీచర్లు',
      'dashboard.recent_activity': 'ఇటీవలి కార్యకలాపం',
      'dashboard.checked_in_title': 'చెక్ ఇన్',
      'dashboard.not_checked_in_title': 'చెక్ ఇన్ కాలేదు',
      'dashboard.since_time_prefix': 'నుండి',
      'dashboard.tap_to_manage': 'హాజరును నిర్వహించడానికి ట్యాప్ చేయండి',
      'dashboard.new_live_notification.one': 'కొత్త లైవ్ నోటిఫికేషన్',
      'dashboard.new_live_notification.other':
          'కొత్త లైవ్ నోటిఫికేషన్‌లు',
      'dashboard.sync_pending.one': 'అంశం సింక్ పెండింగ్‌లో',
      'dashboard.sync_pending.other': 'అంశాలు సింక్ పెండింగ్‌లో',
      'dashboard.action.check_in_out': 'చెక్ ఇన్/అవుట్',
      'dashboard.action.shift_schedule': 'షిఫ్ట్ షెడ్యూల్',
      'dashboard.action.messages': 'సందేశాలు',
      'dashboard.action.prescriptions': 'ప్రిస్క్రిప్షన్‌లు',
      'dashboard.action.investigations': 'పరిశోధనలు',
      'dashboard.action.vitals': 'వైటల్స్',
      'dashboard.action.handover': 'హ్యాండోవర్',
      'dashboard.action.pharmacy': 'ఫార్మసీ',
      'dashboard.action.upload_results': 'ఫలితాలను అప్‌లోడ్ చేయండి',
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
      'attendance.tab.today': 'ఈరోజు',
      'attendance.tab.calendar': 'క్యాలెండర్',
      'attendance.tab.history': 'చరిత్ర',
      'attendance.checked_in_badge': '🟢 చెక్ ఇన్ చేయబడింది',
      'attendance.not_checked_in_badge': '⚪ చెక్ ఇన్ కాలేదు',
      // REVIEW: success-toast wording
      'attendance.checked_in_success': 'విజయవంతంగా చెక్ ఇన్ అయింది',
      // REVIEW: success-toast wording
      'attendance.checked_out_success': 'విజయవంతంగా చెక్ అవుట్ అయింది',
      'attendance.getting_location': 'స్థానం పొందుతోంది...',
      'attendance.processing': 'ప్రాసెస్ అవుతోంది...',
      'attendance.location_verify_hint':
          '📍 చెక్-ఇన్ సమయంలో స్థానం ధృవీకరించబడుతుంది',
      'attendance.report_issue': 'హాజరు సమస్యను నివేదించండి',
      'attendance.legend.present': 'హాజరు',
      'attendance.legend.absent': 'గైర్హాజరు',
      'attendance.legend.leave': 'సెలవు',
      'attendance.legend.late': 'ఆలస్యం',
      'attendance.check_in_label': 'చెక్-ఇన్',
      'attendance.check_out_label': 'చెక్-అవుట్',
      'attendance.hours_label': 'గంటలు',
      'attendance.late_arrival': '⚠️ ఆలస్యంగా రాక',
      'attendance.no_history': 'హాజరు చరిత్ర లేదు',
      'attendance.history.absent': 'గైర్హాజరు',
      'attendance.history.in_prefix': 'ఇన్:',
      'attendance.history.out_prefix': 'అవుట్:',
      // REVIEW: clinical-action / location error wording
      'attendance.outside_campus.distance_prefix': '❌ ప్రాంగణం వెలుపల',
      'attendance.outside_campus.distance_suffix':
          'దూరంలో. హాజరును ప్రాంగణంలో మాత్రమే గుర్తించవచ్చు.',
      // Settings
      'settings.title': 'సెట్టింగ్‌లు',
      'settings.section.appearance': 'రూపం',
      'settings.section.notifications': 'నోటిఫికేషన్‌లు',
      'settings.section.security': 'భద్రత',
      'settings.section.quick_links': 'త్వరిత లింకులు',
      'settings.section.about': 'గురించి',
      'settings.theme.title': 'థీమ్',
      'settings.theme.system': 'సిస్టమ్',
      'settings.theme.light': 'లైట్',
      'settings.theme.dark': 'డార్క్',
      'settings.theme.subtitle_system': 'సిస్టమ్ సెట్టింగ్‌ను అనుసరించండి',
      'settings.theme.subtitle_light': 'ఎల్లప్పుడూ లైట్',
      'settings.theme.subtitle_dark': 'ఎల్లప్పుడూ డార్క్',
      'settings.push_notifications': 'పుష్ నోటిఫికేషన్‌లు',
      'settings.push_notifications.subtitle':
          'హాజరు రిమైండర్‌లు, అపాయింట్‌మెంట్ హెచ్చరికలు',
      'settings.shift_reminders': 'షిఫ్ట్ రిమైండర్‌లు',
      'settings.shift_reminders.subtitle':
          'షిఫ్ట్ ప్రారంభమయ్యే ముందు తెలియజేయండి',
      'settings.setup_pin': 'PIN సెటప్ చేయండి',
      'settings.setup_pin.subtitle':
          'మీ 4–6 అంకెల త్వరిత యాక్సెస్ PINను సెట్ లేదా అప్‌డేట్ చేయండి',
      'settings.setup_pin.dialog_title': 'PIN సెటప్ చేయండి',
      'settings.setup_pin.dialog_label': '4–6 అంకెల PIN నమోదు చేయండి',
      // REVIEW: security action confirmation
      'settings.setup_pin.success': '✅ PIN విజయవంతంగా సెటప్ చేయబడింది',
      'settings.biometric.title': 'బయోమెట్రిక్ లాగిన్',
      'settings.biometric.subtitle':
          'సైన్ ఇన్ చేయడానికి వేలిముద్ర లేదా ముఖాన్ని ఉపయోగించండి',
      // REVIEW: security action confirmation
      'settings.biometric.enabled': '✅ బయోమెట్రిక్ ప్రారంభించబడింది',
      // REVIEW: security action confirmation
      'settings.biometric.disabled': 'బయోమెట్రిక్ నిలిపివేయబడింది',
      'settings.manage_devices': 'పరికరాలను నిర్వహించండి',
      'settings.manage_devices.subtitle':
          'నమోదిత పరికరాలను చూడండి మరియు తీసివేయండి',
      'settings.registered_devices': 'నమోదిత పరికరాలు',
      'settings.no_devices': 'పరికరాలు నమోదు కాలేదు',
      'settings.unknown_device': 'తెలియని పరికరం',
      // REVIEW: security action confirmation
      'settings.device_removed': '✅ పరికరం తీసివేయబడింది',
      'settings.quick_link.profile': 'ప్రొఫైల్',
      'settings.quick_link.profile.subtitle':
          'మీ సిబ్బంది ప్రొఫైల్‌ను చూడండి మరియు సవరించండి',
      'settings.quick_link.attendance': 'హాజరు',
      'settings.quick_link.attendance.subtitle':
          'చెక్ ఇన్/అవుట్ చేయండి మరియు చరిత్రను చూడండి',
      'settings.quick_link.leave': 'సెలవు',
      'settings.quick_link.leave.subtitle':
          'సెలవుకు దరఖాస్తు చేయండి మరియు బ్యాలెన్స్ తనిఖీ చేయండి',
      'settings.about.title': 'VHHealth సిబ్బంది గురించి',
      'settings.about.subtitle':
          'వెర్షన్ 1.0.0 · యాప్ సమాచారం & ఫీచర్లు',
      'settings.logout.dialog_title': 'లాగౌట్',
      'settings.logout.dialog_body':
          'మీరు ఖచ్చితంగా లాగౌట్ చేయాలనుకుంటున్నారా?',
      // Profile
      'profile.title': 'నా ప్రొఫైల్',
      'profile.edit_tooltip': 'సవరించు',
      'profile.cancel_tooltip': 'రద్దు',
      'profile.fallback_name': 'సిబ్బంది సభ్యుడు',
      'profile.emp_id_prefix': 'EMP:',
      'profile.info_title': 'సిబ్బంది సమాచారం',
      'profile.edit_title': 'ప్రొఫైల్ సవరించు',
      'profile.field.employee_id': 'ఉద్యోగి ID',
      'profile.field.role': 'పాత్ర',
      'profile.field.department': 'విభాగం',
      'profile.field.phone': 'ఫోన్',
      'profile.field.email': 'ఇమెయిల్',
      'profile.field.address': 'చిరునామా',
      'profile.field.shift': 'షిఫ్ట్',
      'profile.field.joining_date': 'చేరిన తేదీ',
      'profile.saving_button': 'సేవ్ అవుతోంది...',
      'profile.save_changes': 'మార్పులను సేవ్ చేయండి',
      // REVIEW: clinical-action confirmation
      'profile.updated_success':
          '✅ ప్రొఫైల్ విజయవంతంగా అప్‌డేట్ చేయబడింది',
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
      // REVIEW
      'notifications.mark_all_read': 'అన్నీ చదివినట్లు గుర్తించండి',
      // REVIEW
      'notifications.live_update': 'లైవ్ నవీకరణ',
      'messaging.inbox_title': 'సందేశాలు',
      'messaging.empty': 'సందేశాలు లేవు',
      // REVIEW
      'messaging.empty_body':
          'సిబ్బంది డైరెక్టరీ నుండి సంభాషణను ప్రారంభించండి.',
      // REVIEW
      'messaging.new_message': 'కొత్త సందేశం',
      // REVIEW
      'messaging.type_hint': 'సందేశాన్ని టైప్ చేయండి...',
      // REVIEW
      'messaging.send': 'పంపించు',
      // REVIEW
      'messaging.set_priority': 'ప్రాధాన్యత సెట్ చేయండి',
      // REVIEW
      'messaging.send_failed_prefix': 'పంపడం విఫలమైంది:',
      // REVIEW
      'messaging.thread_load_failed': 'సంభాషణను లోడ్ చేయడంలో విఫలమైంది',
      // REVIEW
      'messaging.thread_empty_title': 'ఇంకా సందేశాలు లేవు',
      // REVIEW
      'messaging.thread_empty_body': 'క్రింద సంభాషణను ప్రారంభించండి',
      // Time helpers — REVIEW
      'time.just_now': 'ఇప్పుడే',
      'time.yesterday': 'నిన్న',
      'time.today': 'ఈరోజు',
      'time.minutes_ago_suffix': ' నిమిషాల క్రితం',
      'time.hours_ago_suffix': ' గంటల క్రితం',
      'time.days_ago_suffix': ' రోజుల క్రితం',
      // Priority / Urgency — REVIEW
      'priority.low': 'తక్కువ',
      'priority.normal': 'సాధారణ',
      'priority.high': 'అధిక',
      'priority.urgent': 'తక్షణ',
      'priority.critical': 'క్లిష్టమైన',
      'urgency.low': 'తక్కువ',
      'urgency.normal': 'సాధారణ',
      'urgency.high': 'అధిక',
      'urgency.critical': 'క్లిష్టమైన',
      // Departments — REVIEW
      'department.general': 'సాధారణ',
      'department.emergency': 'అత్యవసరం',
      'department.icu': 'ICU',
      'department.pediatrics': 'శిశు వైద్యశాస్త్రం',
      'department.surgery': 'శస్త్రచికిత్స',
      'department.outpatient': 'బాహ్య రోగి',
      // About — REVIEW
      'about.title': 'గురించి',
      'about.header': 'గురించి',
      'about.app_name': 'VHHealth సిబ్బంది',
      'about.version': 'వెర్షన్ 1.0.0',
      'about.description':
          'VH Health ద్వారా ఆసుపత్రి సిబ్బంది నిర్వహణ యాప్. హాజరు, సెలవు, అపాయింట్‌మెంట్‌లు మరియు మరిన్ని — అన్నింటినీ మీ మొబైల్ పరికరం నుండి నిర్వహించండి.',
      'about.features_header': 'ఫీచర్లు',
      'about.support_header': 'మద్దతు',
      'about.support_email_label': 'ఇమెయిల్',
      'about.website_label': 'వెబ్‌సైట్',
      'about.copyright':
          '© 2026 VH Health. అన్ని హక్కులు రిజర్వ్ చేయబడ్డాయి.',
      'about.feature.attendance.title': 'హాజరు',
      'about.feature.attendance.description':
          'స్థాన ట్రాకింగ్‌తో చెక్ ఇన్/అవుట్',
      'about.feature.leave.title': 'సెలవు నిర్వహణ',
      'about.feature.leave.description':
          'సెలవుకు దరఖాస్తు చేయండి మరియు బ్యాలెన్స్‌లను ట్రాక్ చేయండి',
      'about.feature.appointments.title': 'అపాయింట్‌మెంట్‌లు',
      'about.feature.appointments.description':
          'రోగి అపాయింట్‌మెంట్‌లను చూడండి మరియు నిర్వహించండి',
      'about.feature.investigations.title': 'పరిశోధనలు',
      'about.feature.investigations.description':
          'ల్యాబ్ పరీక్షలు మరియు రోగనిర్ధారణ నివేదికలు',
      'about.feature.pharmacy.title': 'ఫార్మసీ',
      'about.feature.pharmacy.description':
          'ప్రిస్క్రిప్షన్ మరియు పంపిణీ వర్క్‌ఫ్లో',
      'about.feature.staff_directory.title': 'సిబ్బంది డైరెక్టరీ',
      'about.feature.staff_directory.description':
          'సహోద్యోగులను కనుగొని సంప్రదించండి',
      'about.feature.clinical_modules.title': 'క్లినికల్ మాడ్యూల్స్',
      'about.feature.clinical_modules.description':
          'వైటల్స్, నర్సింగ్ నోట్స్, ప్రిస్క్రిప్షన్‌లు',
      // Leave (additional) — REVIEW
      'leave.type.annual': 'వార్షిక',
      'leave.type.sick': 'జబ్బు',
      'leave.type.casual': 'క్యాజువల్',
      'leave.type.emergency': 'అత్యవసర',
      'leave.type.maternity': 'ప్రసూతి',
      'leave.type.paternity': 'పితృత్వ',
      'leave.type.unpaid': 'వేతనం లేని',
      'leave.balance.used': 'ఉపయోగించబడింది',
      'leave.leave_type_label': 'సెలవు రకం',
      'leave.dates_label': 'తేదీలు',
      'leave.start_date': 'ప్రారంభ తేదీ',
      'leave.end_date': 'ముగింపు తేదీ',
      'leave.reason_label': 'కారణం',
      'leave.reason_hint': 'సెలవుకు సంక్షిప్త కారణం',
      'leave.replacement_staff_label':
          'ప్రత్యామ్నాయ సిబ్బంది (ఐచ్ఛికం)',
      'leave.replacement_staff_hint':
          'మీ స్థానంలో పనిచేయడానికి సహోద్యోగిని ఎంచుకోండి',
      'leave.replacement_staff_pick':
          'ప్రత్యామ్నాయాన్ని ఎంచుకోవడానికి ట్యాప్ చేయండి',
      'leave.select_replacement': 'ప్రత్యామ్నాయ సిబ్బందిని ఎంచుకోండి',
      'leave.no_staff_available': 'సిబ్బంది అందుబాటులో లేరు',
      'leave.search_by_type_hint': 'సెలవు రకం ద్వారా వెతకండి…',
      'leave.no_applications': 'సెలవు దరఖాస్తులు లేవు',
      'leave.no_replacement_requests':
          'పెండింగ్ ప్రత్యామ్నాయ అభ్యర్థనలు లేవు',
      'leave.requester_unknown': 'తెలియదు',
      'leave.requesting_coverage_for': 'కవరేజ్ కోరుతున్నది:',
      'leave.error.select_dates': 'దయచేసి తేదీలను ఎంచుకోండి',
      'leave.error.provide_reason': 'దయచేసి కారణాన్ని తెలియజేయండి',
      'leave.overtime_title': 'ఓవర్‌టైమ్ అభ్యర్థన',
      'leave.overtime_subtitle': 'అదనపు పని గంటలను లాగ్ చేయండి',
      'leave.dispute_title': 'హాజరు వివాదం',
      'leave.dispute_subtitle': 'రికార్డింగ్ సమస్యను నివేదించండి',
      'leave.action.decline': 'తిరస్కరించు',
      'leave.action.accept': 'అంగీకరించు',
      // REVIEW: clinical-action confirmation
      'leave.request_accepted': '✅ అభ్యర్థన అంగీకరించబడింది',
      'leave.request_declined': '❌ అభ్యర్థన తిరస్కరించబడింది',
      'leave.day_count.one': 'రోజు',
      'leave.day_count.other': 'రోజులు',
      // Bed sheet (additional) — REVIEW
      'bed_sheet.field.name': 'పేరు',
      'bed_sheet.field.age': 'వయస్సు',
      'bed_sheet.field.gender': 'లింగం',
      'bed_sheet.field.phone': 'ఫోన్',
      'bed_sheet.field.chief_complaint': 'ముఖ్య ఫిర్యాదు',
      'bed_sheet.field.diagnosis': 'రోగనిర్ధారణ',
      'bed_sheet.field.type': 'రకం',
      'bed_sheet.field.attending': 'హాజరయ్యే వైద్యుడు',
      'bed_sheet.field.admitted': 'అడ్మిట్ అయిన సమయం',
      'bed_sheet.year_suffix': 'సంవ',
      'bed_sheet.doctor_prefix': 'డా.',
      'bed_sheet.patient_details_unavailable':
          'ఈ బెడ్ కోసం రోగి వివరాలు అందుబాటులో లేవు.',
      'bed_sheet.no_patient_assigned':
          'ప్రస్తుతం రోగి అసైన్ చేయబడలేదు.',
      'bed_sheet.saving_label': 'సేవ్ అవుతోంది…',
      'bed_sheet.quick_note_hint':
          'త్వరిత గమనిక (హ్యాండోవర్, ప్రమాదాలు, IV సైట్…)',
      'bed_sheet.dictate_quick_note': 'త్వరిత గమనికను చెప్పండి',
      'bed_sheet.this_patient': 'ఈ రోగి',
      // REVIEW: clinical-action confirmation
      'bed_sheet.patient_discharged': 'రోగి డిశ్చార్జ్ అయ్యారు',
      'bed_sheet.patient_missing_name': 'రోగి పేరు లేదు',
      'bed_sheet.patient_admitted_suffix': 'ఈ బెడ్‌కి అడ్మిట్ చేయబడ్డారు',
      'bed_sheet.marked_as_prefix': 'బెడ్ గుర్తించబడింది:',
      // Vitals — REVIEW
      'vitals.title': 'వైటల్స్ ఎంట్రీ',
      'vitals.tab.record': 'వైటల్స్ రికార్డ్',
      'vitals.tab.recent': 'ఇటీవలి వైటల్స్',
      'vitals.header_title': 'రోగి వైటల్స్‌ని రికార్డ్ చేయండి',
      'vitals.header_subtitle': 'రోగి ID ద్వారా వైటల్స్ నమోదు చేయండి',
      'vitals.patient_id_label': 'రోగి ID',
      'vitals.patient_id_hint': 'రోగి ID నమోదు చేయండి',
      'vitals.patient_id_required': 'రోగి ID అవసరం',
      'vitals.patient_id_invalid': 'చెల్లుబాటు అయ్యే సంఖ్యను నమోదు చేయండి',
      'vitals.bp_header': 'రక్తపోటు',
      'vitals.bp_systolic': 'సిస్టోలిక్',
      'vitals.bp_systolic_hint': 'ఉదా. 120',
      'vitals.bp_diastolic': 'డయాస్టోలిక్',
      'vitals.bp_diastolic_hint': 'ఉదా. 80',
      'vitals.temperature_header': 'ఉష్ణోగ్రత',
      'vitals.temperature_hint': 'ఉదా. 98.6',
      'vitals.pulse_spo2_header': 'పల్స్ & ఆక్సిజన్ సంతృప్తి',
      'vitals.pulse_label': 'పల్స్',
      'vitals.pulse_hint': 'ఉదా. 72',
      'vitals.spo2_label': 'SpO₂',
      'vitals.spo2_hint': 'ఉదా. 98',
      'vitals.weight_header': 'బరువు',
      'vitals.weight_hint': 'ఉదా. 70.5',
      'vitals.nurse_notes_label': 'నర్స్ గమనికలు (ఐచ్ఛికం)',
      'vitals.nurse_notes_hint': 'ఏదైనా పరిశీలనలు లేదా ఆందోళనలు...',
      'vitals.validation.invalid': 'చెల్లదు',
      'vitals.save_button': 'వైటల్స్ సేవ్ చేయి',
      'vitals.fetch_button': 'తెచ్చు',
      'vitals.trends_hint':
          'వైటల్ ట్రెండ్‌లను చూడటానికి రోగి ID నమోదు చేయండి',
      'vitals.no_records':
          'ఈ రోగికి వైటల్ రికార్డులు ఏవీ కనుగొనబడలేదు',
      // REVIEW: clinical-action confirmation
      'vitals.recorded_success': 'వైటల్స్ విజయవంతంగా రికార్డ్ చేయబడ్డాయి',
      // REVIEW: clinical / connectivity message
      'vitals.offline_queued':
          'కనెక్షన్ లేదు — వైటల్స్ సేవ్ చేయబడ్డాయి, ఆన్‌లైన్‌కి వచ్చినప్పుడు సింక్ అవుతాయి',
      // Nursing Notes — REVIEW
      'nursing_notes.title': 'నర్సింగ్ నోట్స్',
      'nursing_notes.tab.add': 'గమనిక జోడించు',
      'nursing_notes.tab.recent': 'ఇటీవలి గమనికలు',
      'nursing_notes.backend_coming_soon':
          'బ్యాకెండ్ ఇంటిగ్రేషన్ త్వరలో వస్తుంది. గమనికలు స్థానికంగా చూపబడుతున్నాయి.',
      'nursing_notes.patient_phone_label': 'రోగి ఫోన్ నంబర్',
      'nursing_notes.patient_phone_hint': '+91 XXXXX XXXXX',
      'nursing_notes.phone_required': 'ఫోన్ అవసరం',
      'nursing_notes.phone_invalid':
          'చెల్లుబాటు అయ్యే ఫోన్ నంబర్ నమోదు చేయండి',
      'nursing_notes.type_label': 'గమనిక రకం',
      'nursing_notes.type_required': 'గమనిక రకాన్ని ఎంచుకోండి',
      'nursing_notes.priority_label': 'ప్రాధాన్యత',
      'nursing_notes.clinical_note_label': 'క్లినికల్ గమనిక',
      'nursing_notes.clinical_note_hint':
          'పరిశీలనలు, అందించిన సంరక్షణ, రోగి ప్రతిస్పందనను వివరించండి...',
      'nursing_notes.note_required': 'గమనిక అవసరం',
      'nursing_notes.note_too_short': 'గమనిక చాలా చిన్నది',
      'nursing_notes.save_button': 'గమనికను సేవ్ చేయి',
      // REVIEW: clinical-action confirmation
      'nursing_notes.saved_success':
          'నర్సింగ్ గమనిక విజయవంతంగా సేవ్ చేయబడింది',
      // REVIEW: clinical / connectivity message
      'nursing_notes.offline_queued':
          'ఆఫ్‌లైన్‌లో సేవ్ చేయబడింది — కనెక్ట్ అయినప్పుడు సింక్ అవుతుంది',
      'nursing_notes.recent_empty':
          'బ్యాకెండ్ API కనెక్ట్ అయిన తర్వాత మీ ఇటీవలి నర్సింగ్ గమనికలు ఇక్కడ కనిపిస్తాయి.',
      'nursing_notes.type.observation': 'పరిశీలన',
      'nursing_notes.type.medication': 'ఔషధ గమనిక',
      'nursing_notes.type.post_procedure': 'ప్రక్రియ తర్వాత',
      'nursing_notes.type.intake_output': 'తీసుకోవడం/విడుదల',
      'nursing_notes.type.patient_complaint': 'రోగి ఫిర్యాదు',
      'nursing_notes.type.wound_care': 'గాయం సంరక్షణ',
      'nursing_notes.type.shift_handover': 'షిఫ్ట్ హ్యాండోవర్',
      'nursing_notes.type.emergency_note': 'అత్యవసర గమనిక',
      'nursing_notes.type.other': 'ఇతర',
      // Handover — REVIEW
      'handover.title': 'హ్యాండోవర్ గమనికలు',
      'handover.tab.write': 'రాయి',
      'handover.tab.recent': 'ఇటీవలి',
      'handover.department_label': 'విభాగం',
      'handover.urgency_label': 'తక్షణత',
      'handover.notes_label': 'హ్యాండోవర్ గమనికలు',
      'handover.notes_hint':
          'ముఖ్య పరిశీలనలు, పెండింగ్ పనులు, ఔషధ మార్పులు...',
      'handover.notes_required': 'గమనికలు అవసరం',
      'handover.patient_ref_label': 'రోగి సూచనలు (ఐచ్ఛికం)',
      'handover.patient_ref_hint':
          'గది 201 - శ్రీ. శర్మ, గది 305 - శ్రీమతి పటేల్',
      'handover.submit_button': 'హ్యాండోవర్ సమర్పించు',
      'handover.submitting_button': 'సమర్పిస్తోంది...',
      // REVIEW: clinical-action confirmation
      'handover.submitted': 'హ్యాండోవర్ గమనిక సమర్పించబడింది',
      'handover.recent_empty_title': 'ఇటీవలి హ్యాండోవర్ గమనికలు లేవు',
      'handover.recent_empty_body':
          'గత 24 గంటల గమనికలు ఇక్కడ కనిపిస్తాయి',
      'handover.note_fallback_title': 'హ్యాండోవర్ గమనిక',
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
      // Bed Board (additions) — REVIEW
      'bed_board.no_wards_yet': 'వార్డులు లేవు',
      'bed_board.ward_stat.total': 'మొత్తం',
      'bed_board.ward_stat.free': 'ఖాళీ',
      'bed_board.ward_stat.used': 'ఉపయోగంలో',
      'bed_board.count.available_suffix': 'అందుబాటులో',
      'bed_board.back_to_wards': 'వార్డుల జాబితాకు తిరిగి',
      'bed_board.ward_fallback': 'వార్డు',
      'bed_board.print_tooltip': 'బెడ్ బోర్డు ప్రింట్',
      'bed_board.refresh_tooltip': 'బెడ్ బోర్డు రిఫ్రెష్',
      'bed_board.print_failed_prefix': 'ప్రింట్ విఫలమైంది:',
      'bed_board.no_filtered_prefix': 'ఈ వార్డులో',
      'bed_board.no_filtered_suffix': 'బెడ్‌లు లేవు',
      'bed_board.admit_which_patient':
          'ఏ రోగిని అడ్మిట్ చేయాలి?',
      'bed_board.admit_search_hint':
          'పేరు, ఫోన్ లేదా ABHA ద్వారా వెతకండి…',
      'bed_board.type_to_find_patient':
          'రోగిని కనుగొనడానికి టైప్ చేయండి.',
      'bed_board.patient_unnamed': 'పేరు లేని',
      // Doctor queue — REVIEW
      'queue.title': 'రోగి క్యూ',
      'queue.refresh_tooltip': 'క్యూ రిఫ్రెష్',
      'queue.section.in_consultation': 'సంప్రదింపులో',
      'queue.section.waiting_prefix': 'వేచి ఉన్నవారు',
      'queue.section.completed_prefix': 'పూర్తయింది',
      'queue.call_next_patient':
          'తదుపరి రోగిని పిలవండి',
      // REVIEW: clinical-action confirmation
      'queue.complete_consultation': 'సంప్రదింపును పూర్తి చేయండి',
      'queue.call_tooltip': 'పిలవండి',
      'queue.no_patients_waiting':
          'వేచి ఉన్న రోగులు లేరు',
      'queue.no_completed_consultations':
          'పూర్తయిన సంప్రదింపులు లేవు',
      'queue.waiting_prefix': 'వేచి ఉన్నది',
      'queue.in_prefix': 'లో',
      'queue.patient_info': 'రోగి సమాచారం',
      'queue.recent_records': 'ఇటీవలి రికార్డులు',
      'queue.no_health_records_found':
          'ఆరోగ్య రికార్డులు కనుగొనబడలేదు',
      // REVIEW: clinical / safety — allergies surfacing
      'queue.allergies_prefix': 'అలెర్జీలు:',
      'queue.age_prefix': '• వయస్సు:',
      'queue.write_prescription': 'ప్రిస్క్రిప్షన్ రాయండి',
      'queue.order_investigation': 'పరిశోధన ఆర్డర్',
      'queue.add_notes': 'గమనికలు జోడించు',
      'queue.no_phone_number': 'ఫోన్ నంబర్ అందుబాటులో లేదు',
      'queue.record_fallback': 'రికార్డు',
      'queue.unknown_patient': 'తెలియదు',
      // Prescriptions — REVIEW
      'prescriptions.title': 'ఈ-ప్రిస్క్రిప్షన్‌లు',
      'prescriptions.tab.new': 'కొత్త ప్రిస్క్రిప్షన్',
      'prescriptions.tab.recent': 'ఇటీవలి',
      'prescriptions.error.select_patient_doctor':
          'దయచేసి రోగి మరియు డాక్టర్‌ను ఎంచుకోండి',
      'prescriptions.error.fill_medication_names':
          'దయచేసి అన్ని మందుల పేర్లను నింపండి',
      'prescriptions.photo.title': 'ప్రిస్క్రిప్షన్ ఫోటో',
      'prescriptions.photo.body':
          'ఫోటో తీయండి లేదా గ్యాలరీ నుండి ఎంచుకోండి?',
      'prescriptions.photo.camera': 'కెమెరా',
      'prescriptions.photo.gallery': 'గ్యాలరీ',
      'prescriptions.vitals_collapse': 'వైటల్స్ (ఐచ్ఛికం)',
      'prescriptions.diagnosis_label':
          'రోగనిర్ధారణ / ముఖ్య ఫిర్యాదు *',
      'prescriptions.diagnosis_required': 'రోగనిర్ధారణ అవసరం',
      'prescriptions.medications_header': 'మందులు *',
      'prescriptions.add_button': 'జోడించు',
      'prescriptions.set_follow_up':
          'ఫాలో-అప్ తేదీని సెట్ చేయండి',
      'prescriptions.follow_up_prefix': 'ఫాలో-అప్:',
      'prescriptions.clear_follow_up': 'ఫాలో-అప్ తేదీని క్లియర్',
      'prescriptions.follow_up_notes': 'ఫాలో-అప్ గమనికలు',
      'prescriptions.follow_up_notes_hint':
          'ఉదా. రక్త నివేదికలు తీసుకురండి',
      'prescriptions.clinical_notes':
          'క్లినికల్ గమనికలు / సలహా',
      'prescriptions.clinical_notes_hint':
          'విశ్రాంతి, ఆహారం, ఫాలో-అప్ సూచనలు...',
      'prescriptions.photo_attached': 'ఫోటో జోడించబడింది ✓',
      'prescriptions.attach_handwritten':
          'చేతితో రాసిన ప్రిస్క్రిప్షన్ జోడించండి (ఐచ్ఛికం)',
      'prescriptions.creating': 'సృష్టిస్తోంది...',
      'prescriptions.create': 'ప్రిస్క్రిప్షన్ సృష్టించండి',
      'prescriptions.created_prefix': 'ప్రిస్క్రిప్షన్',
      'prescriptions.created_suffix': 'సృష్టించబడింది',
      'prescriptions.patient_label': 'రోగి',
      'prescriptions.doctor_label': 'డాక్టర్',
      'prescriptions.search_patient':
          'రోగిని వెతకండి (ఫోన్/పేరు)',
      'prescriptions.search_doctor': 'డాక్టర్‌ను వెతకండి',
      'prescriptions.remove_medication': 'మందును తీసివేయండి',
      'prescriptions.medicine_name': 'మందు పేరు *',
      'prescriptions.medicine_name_hint':
          'వెతకడానికి టైప్ చేయండి (ఉదా. డోలో, పాన్)',
      'prescriptions.dosage': 'మోతాదు',
      'prescriptions.dosage_hint': '500mg',
      'prescriptions.frequency': 'ఫ్రీక్వెన్సీ',
      'prescriptions.duration': 'వ్యవధి',
      'prescriptions.duration_hint': '5 రోజులు',
      'prescriptions.route': 'మార్గం',
      'prescriptions.instructions': 'సూచనలు',
      'prescriptions.instructions_hint': 'ఆహారం తర్వాత',
      'prescriptions.qty': 'పరిమాణం',
      'prescriptions.medicine_index_prefix': 'మందు',
      'prescriptions.bp_systolic': 'BP సిస్టోలిక్',
      'prescriptions.bp_diastolic': 'BP డయాస్టోలిక్',
      'prescriptions.pulse': 'పల్స్',
      'prescriptions.temp': 'ఉష్ణోగ్రత',
      'prescriptions.spo2': 'SpO2',
      'prescriptions.weight': 'బరువు',
      'prescriptions.blood_sugar': 'రక్త చక్కెర',
      'prescriptions.none_yet': 'ఇంకా ప్రిస్క్రిప్షన్‌లు లేవు',
      'prescriptions.ordered_chip': 'ఆర్డర్ చేయబడింది',
      'prescriptions.detail.diagnosis': 'రోగనిర్ధారణ',
      'prescriptions.detail.medications': 'మందులు',
      // Patient records — REVIEW
      'patient_records.title': 'రోగి రికార్డులు',
      'patient_records.search_hint':
          'రోగి పేరు లేదా రకం ద్వారా వెతకండి...',
      'patient_records.clear_tooltip': 'శోధన క్లియర్',
      'patient_records.retry': 'మళ్ళీ ప్రయత్నించు',
      'patient_records.no_found': 'రికార్డులు కనుగొనబడలేదు',
      'patient_records.empty': 'రోగి రికార్డులు లేవు',
      'patient_records.empty_body':
          'రోగి రికార్డులు ఇక్కడ కనిపిస్తాయి',
      'patient_records.details': 'రికార్డు వివరాలు',
      'patient_records.unknown_patient': 'తెలియని రోగి',
      // Appointment queue — REVIEW
      'appt_queue.title': 'అపాయింట్‌మెంట్ క్యూ',
      'appt_queue.walk_in': 'వాక్-ఇన్',
      'appt_queue.tab.today_prefix': 'నేటి క్యూ',
      'appt_queue.tab.pending_prefix': 'పెండింగ్',
      'appt_queue.no_today': 'నేడు అపాయింట్‌మెంట్‌లు లేవు',
      'appt_queue.all_confirmed':
          'అన్ని అపాయింట్‌మెంట్‌లు నిర్ధారించబడ్డాయి!',
      'appt_queue.confirm_title':
          'అపాయింట్‌మెంట్‌ను నిర్ధారించండి',
      'appt_queue.change_date': 'తేదీని మార్చండి',
      'appt_queue.change_time': 'సమయాన్ని మార్చండి',
      'appt_queue.notes_optional': 'గమనికలు (ఐచ్ఛికం)',
      'appt_queue.confirm_appointment':
          'అపాయింట్‌మెంట్‌ను నిర్ధారించండి',
      // REVIEW: clinical-action confirmation
      'appt_queue.confirmed_toast':
          'అపాయింట్‌మెంట్ నిర్ధారించబడింది ✓',
      'appt_queue.failed_prefix': 'విఫలమైంది:',
      'appt_queue.no_show_title': 'నో-షోగా గుర్తించాలా?',
      'appt_queue.no_show_body_suffix': 'రాలేదా?',
      'appt_queue.mark_no_show': 'నో-షోగా గుర్తించు',
      // REVIEW: clinical-action confirmation
      'appt_queue.no_show_marked': 'నో-షోగా గుర్తించబడింది',
      'appt_queue.complete_title':
          'అపాయింట్‌మెంట్‌ను పూర్తి చేయండి',
      'appt_queue.complete_body_prefix': 'గుర్తించాలా',
      'appt_queue.complete_body_suffix': 'పూర్తయినదిగా?',
      'appt_queue.complete_action': 'పూర్తి',
      // REVIEW: clinical-action confirmation
      'appt_queue.completed_toast': 'అపాయింట్‌మెంట్ పూర్తయింది ✓',
      'appt_queue.rx_prompt_title':
          'ఈ-ప్రిస్క్రిప్షన్ సృష్టించాలా?',
      'appt_queue.rx_prompt_body':
          'ఈ సందర్శనకు నిర్మాణాత్మక ఈ-ప్రిస్క్రిప్షన్ సృష్టించాలా? రోగి దాని నుండి నేరుగా మందులను ఆర్డర్ చేయవచ్చు.',
      'appt_queue.skip': 'దాటవేయి',
      'appt_queue.upload_doc': 'డాక్యుమెంట్ అప్‌లోడ్',
      'appt_queue.e_prescription': 'ఈ-ప్రిస్క్రిప్షన్',
      'appt_queue.upload_document': 'డాక్యుమెంట్ అప్‌లోడ్ చేయండి',
      'appt_queue.doc_type': 'డాక్యుమెంట్ రకం',
      'appt_queue.attach_file_pick': 'ఫైల్‌ను ఎంచుకోండి',
      'appt_queue.camera': 'కెమెరా',
      // REVIEW: clinical-action confirmation
      'appt_queue.doc_uploaded':
          'డాక్యుమెంట్ అప్‌లోడ్ చేయబడింది ✓',
      'appt_queue.upload_failed_prefix': 'అప్‌లోడ్ విఫలమైంది:',
      'appt_queue.register_walk_in':
          'వాక్-ఇన్ నమోదు చేయండి',
      'appt_queue.patient_phone': 'రోగి ఫోన్ *',
      'appt_queue.patient_phone_required':
          'రోగి ఫోన్ అవసరం',
      'appt_queue.patient_name': 'రోగి పేరు',
      'appt_queue.department': 'విభాగం',
      'appt_queue.reason': 'కారణం',
      'appt_queue.reason_hint': 'వాక్-ఇన్ సంప్రదింపు',
      'appt_queue.walk_in_registered_prefix':
          'వాక్-ఇన్ నమోదు చేయబడింది! టోకెన్',
      'appt_queue.retry': 'మళ్ళీ ప్రయత్నించు',
      'appt_queue.close': 'మూసివేయి',
      'appt_queue.action.confirm': 'నిర్ధారించు',
      'appt_queue.action.complete': 'పూర్తి',
      'appt_queue.action.no_show': 'నో-షో',
      'appt_queue.action.upload_doc': 'డాక్యుమెంట్ అప్‌లోడ్',
      'appt_queue.call_confirm': 'కాల్ & నిర్ధారించు',
      'appt_queue.sla_breached': 'SLA ఉల్లంఘన',
      'appt_queue.booked_prefix': 'బుక్ చేయబడింది',
      'appt_queue.patient_fallback': 'రోగి',
      // Admission — REVIEW
      'admission.title': 'అడ్మిషన్‌లు',
      'admission.admit': 'అడ్మిట్',
      'admission.admit_patient': 'రోగిని అడ్మిట్ చేయండి',
      'admission.patient_label':
          'రోగి (పేరు, UID, లేదా ఫోన్)',
      'admission.required': 'అవసరం',
      'admission.chief_complaint': 'ముఖ్య ఫిర్యాదు',
      'admission.diagnosis': 'తాత్కాలిక రోగనిర్ధారణ',
      'admission.ward': 'వార్డు',
      'admission.bed_number': 'బెడ్ నంబర్',
      'admission.priority_label': 'ప్రాధాన్యత',
      'admission.priority.routine': 'రొటీన్',
      // REVIEW: clinical urgency wording
      'admission.priority.urgent': 'తక్షణ',
      'admission.priority.emergency': 'అత్యవసర',
      'admission.priority.critical': 'క్లిష్టమైన',
      'admission.code_status': 'కోడ్ స్థితి',
      // REVIEW: clinical-action — DNR/DNI standard medical
      'admission.code.full': 'ఫుల్ కోడ్',
      'admission.code.dnr': 'DNR',
      'admission.code.dnr_dni': 'DNR/DNI',
      'admission.code.comfort': 'కంఫర్ట్ కేర్',
      // REVIEW: clinical-action confirmation
      'admission.admitted_success':
          'రోగి విజయవంతంగా అడ్మిట్ చేయబడ్డారు',
      'admission.failed_prefix': 'అడ్మిషన్ విఫలమైంది:',
      'admission.no_active': 'క్రియాశీల అడ్మిషన్‌లు లేవు',
      'admission.patient_information': 'రోగి సమాచారం',
      'admission.details': 'అడ్మిషన్ వివరాలు',
      'admission.quick_actions': 'త్వరిత చర్యలు',
      'admission.uid': 'UID',
      'admission.age_gender': 'వయస్సు/లింగం',
      'admission.blood_group': 'రక్తం వర్గం',
      'admission.allergies': 'అలెర్జీలు',
      'admission.ward_field': 'వార్డు',
      'admission.bed_field': 'బెడ్',
      'admission.admitted_on': 'అడ్మిట్ చేయబడిన తేదీ',
      'admission.diagnosis_field': 'రోగనిర్ధారణ',
      'admission.priority_field': 'ప్రాధాన్యత',
      'admission.attending': 'హాజరయ్యే',
      'admission.action.vitals': 'వైటల్స్',
      'admission.action.notes': 'గమనికలు',
      'admission.action.orders': 'ఆర్డర్‌లు',
      'admission.action.timeline': 'టైమ్‌లైన్',
      'admission.retry': 'మళ్ళీ ప్రయత్నించు',
      'admission.number_prefix': 'అడ్మిషన్',
      'admission.patient_fallback': 'రోగి',
      // Patient timeline — REVIEW
      'timeline.title': 'రోగి టైమ్‌లైన్',
      'timeline.title_prefix': 'టైమ్‌లైన్',
      'timeline.retry': 'మళ్ళీ ప్రయత్నించు',
      'timeline.no_events': 'ఈవెంట్‌లు కనుగొనబడలేదు',
      'timeline.filter.all': 'అన్నీ',
      'timeline.filter.admission': 'అడ్మిషన్',
      'timeline.filter.vitals': 'వైటల్స్',
      'timeline.filter.note': 'గమనిక',
      'timeline.filter.order': 'ఆర్డర్',
      'timeline.filter.medication': 'మందు',
      'timeline.filter.investigation': 'పరిశోధన',
      'timeline.filter.discharge': 'డిశ్చార్జ్',
      'timeline.event_fallback': 'క్లినికల్ ఈవెంట్',
      'timeline.event_title_suffix': 'ఈవెంట్',
      'timeline.by_prefix': 'ద్వారా',
      'timeline.department': 'విభాగం',
      'timeline.details': 'వివరాలు',
      // Orders — REVIEW
      'orders.title': 'రోగి ఆర్డర్‌లు',
      'orders.title_prefix': 'ఆర్డర్‌లు',
      'orders.new_order': 'కొత్త ఆర్డర్',
      'orders.type.medication': 'మందు ఆర్డర్',
      'orders.type.investigation': 'పరిశోధన ఆర్డర్',
      'orders.type.nursing': 'నర్సింగ్ ఆర్డర్',
      'orders.medication_name': 'మందు పేరు',
      'orders.dosage': 'మోతాదు',
      'orders.route': 'మార్గం',
      'orders.route_hint': 'PO, IV, IM...',
      'orders.frequency': 'ఫ్రీక్వెన్సీ',
      'orders.frequency_hint': 'OD, BD, TDS...',
      'orders.duration': 'వ్యవధి',
      'orders.duration_hint': '5 రోజులు',
      'orders.special_instructions': 'ప్రత్యేక సూచనలు',
      // REVIEW: clinical urgency wording
      'orders.stat_immediate': 'STAT (తక్షణ)',
      'orders.investigation': 'పరిశోధన',
      'orders.investigation_hint': 'CBC, RFT, CT స్కాన్...',
      'orders.clinical_indication': 'క్లినికల్ సూచిక',
      'orders.priority': 'ప్రాధాన్యత',
      'orders.priority.routine': 'రొటీన్',
      'orders.priority.urgent': 'తక్షణ',
      'orders.priority.stat': 'STAT',
      'orders.fasting_required': 'ఉపవాసం అవసరం',
      'orders.description': 'ఆర్డర్ వివరణ',
      'orders.description_hint':
          'గాయం సంరక్షణ, స్థానీకరణ, పర్యవేక్షణ...',
      'orders.frequency_hint_nursing':
          'ప్రతి 4 గం., PRN, ఒకసారి...',
      'orders.place_order': 'ఆర్డర్ ఇవ్వండి',
      // REVIEW: clinical-action confirmation
      'orders.placed_success': 'ఆర్డర్ విజయవంతంగా ఇవ్వబడింది',
      'orders.place_failed_prefix': 'ఆర్డర్ ఇవ్వడంలో విఫలమైంది:',
      // REVIEW: clinical-safety messaging
      'orders.clinical_alerts': 'క్లినికల్ హెచ్చరికలు',
      'orders.proceed_anyway': 'ఏదైనా కొనసాగించండి',
      'orders.filter.all': 'అన్నీ',
      'orders.filter.ordered': 'ఆర్డర్ చేయబడింది',
      'orders.filter.verified': 'ధృవీకరించబడింది',
      'orders.filter.completed': 'పూర్తయింది',
      'orders.filter.cancelled': 'రద్దు చేయబడింది',
      'orders.no_found': 'ఆర్డర్‌లు కనుగొనబడలేదు',
      'orders.fallback': 'ఆర్డర్',
      'orders.verify': 'ధృవీకరించు',
      'orders.complete': 'పూర్తి',
      // REVIEW: clinical-action confirmation
      'orders.verified_toast': 'ఆర్డర్ ధృవీకరించబడింది',
      'orders.verify_failed_prefix': 'ధృవీకరణ విఫలమైంది:',
      // REVIEW: clinical-action confirmation
      'orders.completed_toast': 'ఆర్డర్ పూర్తయింది',
      'orders.complete_failed_prefix':
          'ఆర్డర్ పూర్తి చేయడంలో విఫలమైంది:',
      'orders.retry': 'మళ్ళీ ప్రయత్నించు',
      // Vitals chart — REVIEW
      'vitals_chart.title': 'వైటల్స్ చార్టింగ్',
      'vitals_chart.title_prefix': 'వైటల్స్',
      'vitals_chart.tab.record': 'రికార్డు',
      'vitals_chart.tab.last_24h': 'చివరి 24 గం.',
      'vitals_chart.tab.io_balance': 'I/O బ్యాలెన్స్',
      'vitals_chart.record_vitals': 'వైటల్స్ రికార్డు',
      'vitals_chart.heart_rate': 'హృదయ స్పందన (bpm)',
      'vitals_chart.bp_sys': 'BP సిస్టోలిక్',
      'vitals_chart.bp_dia': 'BP డయాస్టోలిక్',
      'vitals_chart.temp': 'ఉష్ణోగ్రత (°F)',
      'vitals_chart.spo2': 'SpO2 (%)',
      'vitals_chart.resp_rate': 'శ్వాస రేటు',
      'vitals_chart.glucose': 'గ్లూకోజ్ (mg/dL)',
      'vitals_chart.pain': 'నొప్పి (0-10)',
      'vitals_chart.gcs': 'GCS (3-15)',
      'vitals_chart.consciousness': 'చైతన్యం',
      'vitals_chart.conscious.alert': 'అప్రమత్తత',
      'vitals_chart.conscious.verbal':
          'వాయిస్‌కు ప్రతిస్పందిస్తుంది',
      'vitals_chart.conscious.pain':
          'నొప్పికి ప్రతిస్పందిస్తుంది',
      'vitals_chart.conscious.unresp': 'ప్రతిస్పందించదు',
      'vitals_chart.save_button': 'వైటల్స్ సేవ్',
      'vitals_chart.at_least_one':
          'దయచేసి కనీసం ఒక వైటల్ సైన్‌ను నమోదు చేయండి',
      // REVIEW: clinical-action confirmation
      'vitals_chart.recorded_success':
          'వైటల్స్ విజయవంతంగా రికార్డ్ చేయబడ్డాయి',
      'vitals_chart.record_failed_prefix':
          'వైటల్స్ రికార్డ్ చేయడంలో విఫలమైంది:',
      'vitals_chart.record_io': 'I/O రికార్డు',
      'vitals_chart.intake': 'తీసుకోవడం',
      'vitals_chart.output': 'విడుదల',
      'vitals_chart.category': 'వర్గం',
      'vitals_chart.intake.oral': 'మౌఖిక',
      'vitals_chart.intake.iv': 'IV ద్రవాలు',
      'vitals_chart.intake.blood': 'రక్త ఉత్పత్తులు',
      'vitals_chart.intake.ng': 'NG ట్యూబ్',
      'vitals_chart.cat.other': 'ఇతర',
      'vitals_chart.output.urine': 'మూత్రం',
      'vitals_chart.output.drain': 'డ్రెయిన్',
      'vitals_chart.output.emesis': 'వాంతి',
      'vitals_chart.output.stool': 'మలం',
      'vitals_chart.output.blood_loss': 'రక్త నష్టం',
      'vitals_chart.amount': 'మొత్తం (mL)',
      'vitals_chart.io_description': 'వివరణ (ఐచ్ఛికం)',
      'vitals_chart.io_record': 'రికార్డు',
      // REVIEW: clinical-action confirmation
      'vitals_chart.io_success': 'I/O విజయవంతంగా రికార్డ్',
      'vitals_chart.io_failed_prefix':
          'I/O రికార్డ్ చేయడంలో విఫలమైంది:',
      'vitals_chart.retry': 'మళ్ళీ ప్రయత్నించు',
      'vitals_chart.no_vitals':
          'గత 24 గంటల్లో వైటల్స్ రికార్డ్ చేయబడలేదు',
      'vitals_chart.col.time': 'సమయం',
      'vitals_chart.col.hr': 'HR',
      'vitals_chart.col.bp': 'BP',
      'vitals_chart.col.temp': 'ఉష్ణోగ్రత',
      'vitals_chart.col.spo2': 'SpO2',
      'vitals_chart.col.rr': 'RR',
      'vitals_chart.col.glucose': 'గ్లూకోజ్',
      'vitals_chart.col.pain': 'నొప్పి',
      'vitals_chart.col.gcs': 'GCS',
      'vitals_chart.col.avpu': 'AVPU',
      'vitals_chart.intake_label': 'తీసుకోవడం',
      'vitals_chart.output_label': 'విడుదల',
      'vitals_chart.balance_label': 'బ్యాలెన్స్',
      'vitals_chart.record_io_entry': 'I/O ఎంట్రీ రికార్డు',
      'vitals_chart.today_entries': 'నేటి ఎంట్రీలు',
      'vitals_chart.no_io_today':
          'నేడు I/O ఎంట్రీలు రికార్డు కాలేదు',
      'vitals_chart.record_for_prefix':
          'వీరి కోసం వైటల్స్ రికార్డ్:',
      'vitals_chart.record_patient':
          'రోగి వైటల్స్ రికార్డ్',
      'vitals_chart.record_now': 'ఇప్పుడు వైటల్స్ రికార్డ్',
      // Clinical notes — REVIEW
      'clinical_notes.title': 'క్లినికల్ నోట్స్',
      'clinical_notes.title_prefix': 'నోట్స్',
      'clinical_notes.tab.soap': 'SOAP నోట్స్',
      'clinical_notes.tab.progress': 'ప్రోగ్రెస్ నోట్స్',
      'clinical_notes.tab.procedure': 'ప్రొసీజర్ నోట్స్',
      'clinical_notes.new_note': 'కొత్త నోట్',
      // REVIEW: clinical-action — signed/unsigned status
      'clinical_notes.signed': 'సంతకం చేయబడింది',
      'clinical_notes.unsigned': 'సంతకం లేదు',
      'clinical_notes.retry': 'మళ్ళీ ప్రయత్నించు',
      'clinical_notes.no_found_prefix': 'ఏ',
      'clinical_notes.no_found_suffix': 'నోట్‌లు కనుగొనబడలేదు',
      // REVIEW: clinical-action confirmation
      'clinical_notes.sign_note': 'నోట్‌పై సంతకం చేయండి',
      // REVIEW: clinical-action confirmation
      'clinical_notes.signed_success':
          'నోట్ విజయవంతంగా సంతకం చేయబడింది',
      'clinical_notes.sign_failed_prefix':
          'నోట్‌పై సంతకం చేయడంలో విఫలమైంది:',
      'clinical_notes.note_fallback': 'క్లినికల్ నోట్',
      'clinical_notes.unknown_author': 'తెలియదు',
      'clinical_notes.subjective': 'సబ్జెక్టివ్',
      'clinical_notes.objective': 'ఆబ్జెక్టివ్',
      'clinical_notes.assessment': 'అంచనా',
      'clinical_notes.plan': 'ప్రణాళిక',
      'clinical_notes.content': 'కంటెంట్',
      'clinical_notes.findings': 'కనుగొన్నవి',
      'clinical_notes.procedure_details': 'ప్రొసీజర్ వివరాలు',
      'clinical_notes.complications': 'సంక్లిష్టతలు',
      'clinical_notes.new_soap': 'కొత్త SOAP నోట్',
      'clinical_notes.new_progress': 'కొత్త ప్రోగ్రెస్ నోట్',
      'clinical_notes.new_procedure': 'కొత్త ప్రొసీజర్ నోట్',
      'clinical_notes.subjective_hint':
          'రోగి ఫిర్యాదులు, లక్షణాలు, చరిత్ర...',
      'clinical_notes.objective_hint':
          'పరీక్ష ఫలితాలు, వైటల్స్, ల్యాబ్ ఫలితాలు...',
      'clinical_notes.assessment_hint':
          'రోగనిర్ధారణ, క్లినికల్ ఇంప్రెషన్...',
      'clinical_notes.plan_hint':
          'చికిత్స ప్రణాళిక, ఆర్డర్‌లు, ఫాలో-అప్...',
      'clinical_notes.title_field': 'శీర్షిక',
      'clinical_notes.content_hint':
          'క్లినికల్ ప్రోగ్రెస్, పరిశీలనలు, ప్రణాళిక మార్పులు...',
      'clinical_notes.procedure_name': 'ప్రొసీజర్ పేరు',
      'clinical_notes.procedure_details_hint':
          'టెక్నిక్, విధానం, దశలు...',
      'clinical_notes.findings_hint':
          'ప్రొసీజర్ సమయంలో కనుగొన్నవి...',
      'clinical_notes.complications_hint':
          'ఎదుర్కొన్న ఏదైనా సంక్లిష్టతలు...',
      'clinical_notes.required': 'అవసరం',
      'clinical_notes.save_note': 'నోట్ సేవ్',
      // REVIEW: clinical-action confirmation
      'clinical_notes.created_success':
          'నోట్ విజయవంతంగా సృష్టించబడింది',
      'clinical_notes.create_failed_prefix':
          'నోట్ సృష్టించడంలో విఫలమైంది:',
    },
  };
}
