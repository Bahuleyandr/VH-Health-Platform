import 'package:flutter/material.dart';

/// i18n scaffolding for the staff app.
///
/// English (`en`) is the source of truth and the runtime fallback.
///
/// **Translation status (as of 2026-05-02 second-pass):**
/// - `hi` (Hindi) - second-pass reviewed for register and clinical
///   terminology. Most strings are production-ready; a handful are
///   flagged `// REVIEW:` where context-sensitivity matters (e.g.
///   discharge / consent / urgency wording - should be confirmed
///   against the deploying hospital's existing Hindi documentation).
/// - `ta` (Tamil) - first-pass machine translation with light
///   verification. Treat as placeholder; ALL clinical-action strings
///   need a Tamil-fluent clinician's review before production.
/// - `te` (Telugu) - same as Tamil. Placeholder. ALL clinical-action
///   strings need a Telugu-fluent clinician's review.
///
/// Why not just remove the lower-confidence locales? Because the
/// scaffolding works - the UI localises Material widgets (date
/// pickers, back labels) and the highest-traffic strings even on
/// first-pass quality. Removing them would silently fall back to
/// English for users with `hi`/`ta`/`te` system locales and hide
/// from us how much the translator pass needs to fix.
///
/// Anywhere a key is missing in a non-English map, callers fall back
/// to English so the UI never blanks. Empty-string values are NOT
/// supported - leave a key out of the map to fall through cleanly.
///
/// Why a manual map instead of `flutter gen-l10n` ARB codegen: the
/// build pipeline on Windows + Melos workspaces is finicky around the
/// generated files, and the staff app's text surface is small enough
/// (~150 strings on the high-traffic screens) that a hand-maintained
/// map is easier to evolve. Future migration to ARB is straightforward
/// - same key/value structure, just dropped into `app_en.arb` etc.
///
/// **Contribution guide:**
///   1. When adding a new user-facing string, give it a dotted key
///      that follows `<screen>.<intent>` (e.g. `bed_board.empty`).
///   2. Always populate the English value. Leave the other locales
///      empty - the fallback handles it. A translator can fill them
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
  String noMatchesFor(String query) => '${_t('label.no_matches_for')} "$query"';

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
  // REVIEW: clinical / security messaging - confirm phrasing with hospital security policy
  String get loginLockedHint => _t('login.locked_hint');
  String get loginSignInWithPassword => _t('login.sign_in_with_password');
  String get loginSignInWithPin => _t('login.sign_in_with_pin');
  String get loginQuickSignIn => _t('login.quick_sign_in');
  String get loginFooter => _t('login.footer');

  // ── Dashboard (additional) ─────────────────────────────────────────
  String get dashboardWelcomeBack => _t('dashboard.welcome_back');
  String get dashboardSeeAll => _t('dashboard.see_all');
  String get dashboardAllFeatures => _t('dashboard.all_features');
  String get dashboardDailyWork => _t('dashboard.daily_work');
  String get dashboardOpServices => _t('dashboard.op_services');
  String get dashboardIpServices => _t('dashboard.ip_services');
  String get dashboardNoOpServices => _t('dashboard.no_op_services');
  String get dashboardNoIpServices => _t('dashboard.no_ip_services');
  String get dashboardOpLabBookings => _t('dashboard.op_lab_bookings');
  String get dashboardIpLabBookings => _t('dashboard.ip_lab_bookings');
  String get dashboardOpNursingNotes => _t('dashboard.op_nursing_notes');
  String get dashboardIpNursingNotes => _t('dashboard.ip_nursing_notes');
  String get dashboardOpPharmacy => _t('dashboard.op_pharmacy');
  String get dashboardIpPharmacy => _t('dashboard.ip_pharmacy');
  String get dashboardOpLabResults => _t('dashboard.op_lab_results');
  String get dashboardIpLabResults => _t('dashboard.ip_lab_results');
  String get dashboardOpPatientRecords => _t('dashboard.op_patient_records');
  String get dashboardIpPatientRecords => _t('dashboard.ip_patient_records');
  String get dashboardMoreTools => _t('dashboard.more_tools');
  String get dashboardMoreToolsHint => _t('dashboard.more_tools_hint');
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
  String get bedBoardSelectWardPrompt => _t('bed_board.select_ward_prompt');
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
  String get bedBoardAdmitWhichPatient => _t('bed_board.admit_which_patient');
  String get bedBoardAdmitSearchHint => _t('bed_board.admit_search_hint');
  String get bedBoardTypeToFindPatient => _t('bed_board.type_to_find_patient');
  String get bedBoardPatientUnnamed => _t('bed_board.patient_unnamed');

  String bedNumber(String num) => '${_t('bed.label')} $num';

  // ── Bed sheet ──────────────────────────────────────────────────────
  String get bedSheetActionOpenEmr => _t('bed_sheet.action.open_emr');
  String get bedSheetActionRecordVitals => _t('bed_sheet.action.record_vitals');
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
  String get attendanceCheckedInSuccess => _t('attendance.checked_in_success');
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
  String get attendanceHistoryInPrefix => _t('attendance.history.in_prefix');
  String get attendanceHistoryOutPrefix => _t('attendance.history.out_prefix');
  // REVIEW: clinical-action / location-error message - confirm distance phrasing for non-English locales
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
  String get settingsThemeSubtitleLight => _t('settings.theme.subtitle_light');
  String get settingsThemeSubtitleDark => _t('settings.theme.subtitle_dark');
  String get settingsPushNotifications => _t('settings.push_notifications');
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
  // REVIEW: clinical-action / security message - confirm phrasing
  String get settingsSetupPinSuccess => _t('settings.setup_pin.success');
  String get settingsBiometricTitle => _t('settings.biometric.title');
  String get settingsBiometricSubtitle => _t('settings.biometric.subtitle');
  // REVIEW: clinical-action / security message
  String get settingsBiometricEnabled => _t('settings.biometric.enabled');
  // REVIEW: clinical-action / security message
  String get settingsBiometricDisabled => _t('settings.biometric.disabled');
  String get settingsManageDevices => _t('settings.manage_devices');
  String get settingsManageDevicesSubtitle =>
      _t('settings.manage_devices.subtitle');
  String get settingsRegisteredDevices => _t('settings.registered_devices');
  String get settingsNoDevices => _t('settings.no_devices');
  String get settingsUnknownDevice => _t('settings.unknown_device');
  // REVIEW: clinical-action / security message
  String get settingsDeviceRemoved => _t('settings.device_removed');
  String get settingsQuickLinkProfile => _t('settings.quick_link.profile');
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
  String get settingsLogoutDialogTitle => _t('settings.logout.dialog_title');
  String get settingsLogoutDialogBody => _t('settings.logout.dialog_body');

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
  // REVIEW: clinical-action confirmation - confirm phrasing
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
  String get aboutFeatureAttendanceTitle =>
      _t('about.feature.attendance.title');
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
  String get leaveNoReplacementRequests => _t('leave.no_replacement_requests');
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
  // REVIEW: clinical-action confirmation - confirm phrasing
  String get leaveRequestAccepted => _t('leave.request_accepted');
  String get leaveRequestDeclined => _t('leave.request_declined');
  String leaveDayCount(int days) {
    final base = _t(
      days == 1 ? 'leave.day_count.one' : 'leave.day_count.other',
    );
    return '$days $base';
  }

  // ── Bed sheet (additional) ─────────────────────────────────────────
  String get bedSheetFieldName => _t('bed_sheet.field.name');
  String get bedSheetFieldAge => _t('bed_sheet.field.age');
  String get bedSheetFieldGender => _t('bed_sheet.field.gender');
  String get bedSheetFieldPhone => _t('bed_sheet.field.phone');
  String get bedSheetFieldChiefComplaint =>
      _t('bed_sheet.field.chief_complaint');
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
  String get voiceDictateHint => _t('voice_dictate.hint');
  String get voiceDictateAddedToast => _t('voice_dictate.added_toast');
  String get voiceDictateRecordingStarted =>
      _t('voice_dictate.recording_started');
  String get voiceDictateRecordingStopped =>
      _t('voice_dictate.recording_stopped');

  // ── Doctor queue screen ────────────────────────────────────────────
  String get queueTitle => _t('queue.title');
  String get queueRefreshTooltip => _t('queue.refresh_tooltip');
  String get queueSectionInConsultation => _t('queue.section.in_consultation');
  String queueSectionWaiting(int count) =>
      '${_t('queue.section.waiting_prefix')} ($count)';
  String queueSectionCompleted(int count) =>
      '${_t('queue.section.completed_prefix')} ($count)';
  String get queueCallNextPatient => _t('queue.call_next_patient');
  // REVIEW: clinical-action confirmation - confirm phrasing
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
  // REVIEW: clinical / safety - allergies surfacing
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
  String get prescriptionsVitalsCollapse => _t('prescriptions.vitals_collapse');
  String get prescriptionsDiagnosisLabel => _t('prescriptions.diagnosis_label');
  String get prescriptionsDiagnosisRequired =>
      _t('prescriptions.diagnosis_required');
  String get prescriptionsMedicationsHeader =>
      _t('prescriptions.medications_header');
  String get prescriptionsAddButton => _t('prescriptions.add_button');
  String get prescriptionsSetFollowUp => _t('prescriptions.set_follow_up');
  String prescriptionsFollowUpPrefix(String date) =>
      '${_t('prescriptions.follow_up_prefix')} $date';
  String get prescriptionsClearFollowUp => _t('prescriptions.clear_follow_up');
  String get prescriptionsFollowUpNotes => _t('prescriptions.follow_up_notes');
  String get prescriptionsFollowUpNotesHint =>
      _t('prescriptions.follow_up_notes_hint');
  String get prescriptionsClinicalNotes => _t('prescriptions.clinical_notes');
  String get prescriptionsClinicalNotesHint =>
      _t('prescriptions.clinical_notes_hint');
  String get prescriptionsPhotoAttached => _t('prescriptions.photo_attached');
  String get prescriptionsAttachHandwritten =>
      _t('prescriptions.attach_handwritten');
  String get prescriptionsCreating => _t('prescriptions.creating');
  String get prescriptionsCreate => _t('prescriptions.create');
  String prescriptionsCreated(String rxNum) =>
      '${_t('prescriptions.created_prefix')} $rxNum ${_t('prescriptions.created_suffix')}';
  String get prescriptionsPatientLabel => _t('prescriptions.patient_label');
  String get prescriptionsDoctorLabel => _t('prescriptions.doctor_label');
  String get prescriptionsSearchPatient => _t('prescriptions.search_patient');
  String get prescriptionsSearchDoctor => _t('prescriptions.search_doctor');
  String get prescriptionsRemoveMedication =>
      _t('prescriptions.remove_medication');
  String get prescriptionsMedicineName => _t('prescriptions.medicine_name');
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
  String get patientRecordsClearTooltip => _t('patient_records.clear_tooltip');
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
  String get apptQueueActionUploadDoc => _t('appt_queue.action.upload_doc');
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
  String get admissionPriorityEmergency => _t('admission.priority.emergency');
  String get admissionPriorityCritical => _t('admission.priority.critical');
  String get admissionCodeStatus => _t('admission.code_status');
  String get admissionCodeFull => _t('admission.code.full');
  String get admissionCodeDnr => _t('admission.code.dnr');
  String get admissionCodeDnrDni => _t('admission.code.dnr_dni');
  String get admissionCodeComfort => _t('admission.code.comfort');
  // REVIEW: clinical-action confirmation
  String get admissionAdmittedSuccess => _t('admission.admitted_success');
  String admissionFailed(String e) => '${_t('admission.failed_prefix')} $e';
  String get admissionNoActive => _t('admission.no_active');
  String get admissionPatientInformation => _t('admission.patient_information');
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
  String admissionNumber(int id) => '${_t('admission.number_prefix')} #$id';
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
  String get timelineFilterMedication => _t('timeline.filter.medication');
  String get timelineFilterInvestigation => _t('timeline.filter.investigation');
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
  String get ordersTypeInvestigation => _t('orders.type.investigation');
  String get ordersTypeNursing => _t('orders.type.nursing');
  String get ordersMedicationName => _t('orders.medication_name');
  String get ordersDosage => _t('orders.dosage');
  String get ordersRoute => _t('orders.route');
  String get ordersRouteHint => _t('orders.route_hint');
  String get ordersFrequency => _t('orders.frequency');
  String get ordersFrequencyHint => _t('orders.frequency_hint');
  String get ordersDuration => _t('orders.duration');
  String get ordersDurationHint => _t('orders.duration_hint');
  String get ordersSpecialInstructions => _t('orders.special_instructions');
  // REVIEW: clinical urgency wording
  String get ordersStatImmediate => _t('orders.stat_immediate');
  String get ordersInvestigation => _t('orders.investigation');
  String get ordersInvestigationHint => _t('orders.investigation_hint');
  String get ordersClinicalIndication => _t('orders.clinical_indication');
  String get ordersPriority => _t('orders.priority');
  String get ordersPriorityRoutine => _t('orders.priority.routine');
  String get ordersPriorityUrgent => _t('orders.priority.urgent');
  String get ordersPriorityStat => _t('orders.priority.stat');
  String get ordersFastingRequired => _t('orders.fasting_required');
  String get ordersDescription => _t('orders.description');
  String get ordersDescriptionHint => _t('orders.description_hint');
  String get ordersFrequencyHintNursing => _t('orders.frequency_hint_nursing');
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
  String get vitalsChartTabIoBalance => _t('vitals_chart.tab.io_balance');
  String get vitalsChartRecordVitals => _t('vitals_chart.record_vitals');
  String get vitalsChartHeartRate => _t('vitals_chart.heart_rate');
  String get vitalsChartBpSys => _t('vitals_chart.bp_sys');
  String get vitalsChartBpDia => _t('vitals_chart.bp_dia');
  String get vitalsChartTemp => _t('vitals_chart.temp');
  String get vitalsChartSpo2 => _t('vitals_chart.spo2');
  String get vitalsChartRespRate => _t('vitals_chart.resp_rate');
  String get vitalsChartGlucose => _t('vitals_chart.glucose');
  String get vitalsChartPain => _t('vitals_chart.pain');
  String get vitalsChartGcs => _t('vitals_chart.gcs');
  String get vitalsChartConsciousness => _t('vitals_chart.consciousness');
  String get vitalsChartConsciousAlert => _t('vitals_chart.conscious.alert');
  String get vitalsChartConsciousVerbal => _t('vitals_chart.conscious.verbal');
  String get vitalsChartConsciousPain => _t('vitals_chart.conscious.pain');
  String get vitalsChartConsciousUnresp => _t('vitals_chart.conscious.unresp');
  String get vitalsChartSaveButton => _t('vitals_chart.save_button');
  String get vitalsChartAtLeastOne => _t('vitals_chart.at_least_one');
  // REVIEW: clinical-action confirmation
  String get vitalsChartRecordedSuccess => _t('vitals_chart.recorded_success');
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
  String get vitalsChartOutputEmesis => _t('vitals_chart.output.emesis');
  String get vitalsChartOutputStool => _t('vitals_chart.output.stool');
  String get vitalsChartOutputBloodLoss => _t('vitals_chart.output.blood_loss');
  String get vitalsChartAmount => _t('vitals_chart.amount');
  String get vitalsChartIoDescription => _t('vitals_chart.io_description');
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
  String get vitalsChartIntakeLabel => _t('vitals_chart.intake_label');
  String get vitalsChartOutputLabel => _t('vitals_chart.output_label');
  String get vitalsChartBalanceLabel => _t('vitals_chart.balance_label');
  String get vitalsChartRecordIoEntry => _t('vitals_chart.record_io_entry');
  String get vitalsChartTodayEntries => _t('vitals_chart.today_entries');
  String get vitalsChartNoIoToday => _t('vitals_chart.no_io_today');
  String vitalsChartRecordForName(String name) =>
      '${_t('vitals_chart.record_for_prefix')} $name';
  String get vitalsChartRecordPatient => _t('vitals_chart.record_patient');
  String get vitalsChartRecordNow => _t('vitals_chart.record_now');

  // ── Payroll ────────────────────────────────────────────────────────
  String get payrollPayslipTitle => _t('payroll.payslip.title');
  String get payrollPayslipBannerTax => _t('payroll.payslip.banner_tax');
  String get payrollPayslipBannerDeclaration =>
      _t('payroll.payslip.banner_declaration');
  String get payrollPayslipBannerQueries =>
      _t('payroll.payslip.banner_queries');
  String get payrollPayslipEmptyTitle => _t('payroll.payslip.empty_title');
  String get payrollPayslipEmptyBody => _t('payroll.payslip.empty_body');
  String get payrollPayslipNewBadge => _t('payroll.payslip.new_badge');
  String get payrollPayslipNetPay => _t('payroll.payslip.net_pay');
  String get payrollPayslipGross => _t('payroll.payslip.gross');
  String get payrollPayslipDeductions => _t('payroll.payslip.deductions');
  String get payrollDetailTitlePrefix => _t('payroll.detail.title_prefix');
  String get payrollDetailDownloadPdf => _t('payroll.detail.download_pdf');
  String get payrollDetailPdfNotAvailable =>
      _t('payroll.detail.pdf_not_available');
  String get payrollDetailPdfFailedPrefix =>
      _t('payroll.detail.pdf_failed_prefix');
  String get payrollDetailPdfBeingGenerated =>
      _t('payroll.detail.pdf_being_generated');
  String get payrollDetailPdfDownloadButton =>
      _t('payroll.detail.pdf_download_button');
  String get payrollDetailOpening => _t('payroll.detail.opening');
  String get payrollDetailNotFound => _t('payroll.detail.not_found');
  String get payrollDetailAttendanceHeader =>
      _t('payroll.detail.attendance_header');
  String get payrollDetailEarningsHeader =>
      _t('payroll.detail.earnings_header');
  String get payrollDetailDeductionsHeader =>
      _t('payroll.detail.deductions_header');
  String get payrollDetailWorkingDays => _t('payroll.detail.working_days');
  String get payrollDetailDaysPresent => _t('payroll.detail.days_present');
  String get payrollDetailDaysAbsent => _t('payroll.detail.days_absent');
  String get payrollDetailLopDays => _t('payroll.detail.lop_days');
  String get payrollDetailLeaveDays => _t('payroll.detail.leave_days');
  String get payrollDetailOvertimeHours => _t('payroll.detail.overtime_hours');
  String get payrollDetailBasic => _t('payroll.detail.basic');
  String get payrollDetailHra => _t('payroll.detail.hra');
  String get payrollDetailDa => _t('payroll.detail.da');
  String get payrollDetailSpecialAllowance =>
      _t('payroll.detail.special_allowance');
  String get payrollDetailTransportAllowance =>
      _t('payroll.detail.transport_allowance');
  String get payrollDetailMedicalAllowance =>
      _t('payroll.detail.medical_allowance');
  String get payrollDetailOvertimePay => _t('payroll.detail.overtime_pay');
  String get payrollDetailBonus => _t('payroll.detail.bonus');
  String get payrollDetailArrears => _t('payroll.detail.arrears');
  String get payrollDetailGrossSalary => _t('payroll.detail.gross_salary');
  String get payrollDetailLopDeduction => _t('payroll.detail.lop_deduction');
  String get payrollDetailPfEmployee => _t('payroll.detail.pf_employee');
  String get payrollDetailEsi => _t('payroll.detail.esi');
  String get payrollDetailProfessionalTax =>
      _t('payroll.detail.professional_tax');
  String get payrollDetailTds => _t('payroll.detail.tds');
  String get payrollDetailAdvanceDeduction =>
      _t('payroll.detail.advance_deduction');
  String get payrollDetailTotalDeductions =>
      _t('payroll.detail.total_deductions');
  String get payrollQueryTitle => _t('payroll.query.title');
  String get payrollQueryTabMy => _t('payroll.query.tab_my');
  String get payrollQueryTabRaise => _t('payroll.query.tab_raise');
  String get payrollQueryEmpty => _t('payroll.query.empty');
  String get payrollQueryRepliesHeader => _t('payroll.query.replies_header');
  String get payrollQueryRaiseHeader => _t('payroll.query.raise_header');
  String get payrollQuerySelectPayslip => _t('payroll.query.select_payslip');
  String get payrollQueryChoosePayslipHint =>
      _t('payroll.query.choose_payslip_hint');
  String get payrollQueryCategoryLabel => _t('payroll.query.category_label');
  String get payrollQuerySubjectLabel => _t('payroll.query.subject_label');
  String get payrollQuerySubjectRequired =>
      _t('payroll.query.subject_required');
  String get payrollQueryDescriptionLabel =>
      _t('payroll.query.description_label');
  String get payrollQueryDescriptionRequired =>
      _t('payroll.query.description_required');
  String get payrollQueryPickPayslip => _t('payroll.query.pick_payslip');
  String get payrollQuerySubmitButton => _t('payroll.query.submit_button');
  // REVIEW: clinical / financial confirmation
  String get payrollQuerySubmittedSuccess =>
      _t('payroll.query.submitted_success');
  String get payrollTaxSummaryTitle => _t('payroll.tax_summary.title');
  String get payrollTaxSummaryFyLabel => _t('payroll.tax_summary.fy_label');
  String get payrollTaxSummaryTotalGross =>
      _t('payroll.tax_summary.total_gross');
  String get payrollTaxSummaryTotalNet => _t('payroll.tax_summary.total_net');
  String get payrollTaxSummaryTaxableIncome =>
      _t('payroll.tax_summary.taxable_income');
  String get payrollTaxSummaryTaxPayable =>
      _t('payroll.tax_summary.tax_payable');
  String get payrollTaxSummaryEarningsBreakdown =>
      _t('payroll.tax_summary.earnings_breakdown');
  String get payrollTaxSummaryDeductionsBreakdown =>
      _t('payroll.tax_summary.deductions_breakdown');
  String get payrollTaxSummaryTaxComputation =>
      _t('payroll.tax_summary.tax_computation');
  String get payrollTaxSummaryStandardDeduction =>
      _t('payroll.tax_summary.standard_deduction');
  String get payrollTaxSummaryDisclaimer =>
      _t('payroll.tax_summary.disclaimer');
  String get payrollTaxSummaryDownloadPdf =>
      _t('payroll.tax_summary.download_pdf');
  String get payrollTaxSummaryDownloadForm16 =>
      _t('payroll.tax_summary.download_form16');
  String get payrollDeclarationTitle => _t('payroll.declaration.title');
  String get payrollDeclarationEstimatedDeductions =>
      _t('payroll.declaration.estimated_deductions');
  String get payrollDeclarationTotalDeductions =>
      _t('payroll.declaration.total_deductions');
  String get payrollDeclarationSection80c =>
      _t('payroll.declaration.section_80c');
  String get payrollDeclarationSection80d =>
      _t('payroll.declaration.section_80d');
  String get payrollDeclarationSectionOther =>
      _t('payroll.declaration.section_other');
  String get payrollDeclarationSectionRent =>
      _t('payroll.declaration.section_rent');
  String get payrollDeclarationFieldPpf => _t('payroll.declaration.field_ppf');
  String get payrollDeclarationFieldEpf => _t('payroll.declaration.field_epf');
  String get payrollDeclarationFieldElss =>
      _t('payroll.declaration.field_elss');
  String get payrollDeclarationFieldLic => _t('payroll.declaration.field_lic');
  String get payrollDeclarationFieldNsc => _t('payroll.declaration.field_nsc');
  String get payrollDeclarationFieldHomeLoanPrincipal =>
      _t('payroll.declaration.field_home_loan_principal');
  String get payrollDeclarationFieldTuition =>
      _t('payroll.declaration.field_tuition');
  String get payrollDeclarationFieldOther80c =>
      _t('payroll.declaration.field_other_80c');
  String get payrollDeclarationFieldHiSelf =>
      _t('payroll.declaration.field_hi_self');
  String get payrollDeclarationFieldHiParents =>
      _t('payroll.declaration.field_hi_parents');
  String get payrollDeclarationFieldNps => _t('payroll.declaration.field_nps');
  String get payrollDeclarationFieldHomeLoanInterest =>
      _t('payroll.declaration.field_home_loan_interest');
  String get payrollDeclarationFieldEduLoan =>
      _t('payroll.declaration.field_edu_loan');
  String get payrollDeclarationFieldRentMonthly =>
      _t('payroll.declaration.field_rent_monthly');
  String get payrollDeclarationRentReceipts =>
      _t('payroll.declaration.rent_receipts');
  String get payrollDeclarationSubmitButton =>
      _t('payroll.declaration.submit_button');
  // REVIEW: financial confirmation
  String get payrollDeclarationSubmittedSuccess =>
      _t('payroll.declaration.submitted_success');
  String get payrollDeclarationPastTitle =>
      _t('payroll.declaration.past_title');
  String get payrollDeclarationFySubmitted =>
      _t('payroll.declaration.fy_submitted');

  // ── HR ─────────────────────────────────────────────────────────────
  String get hrDashboardTitle => _t('hr.dashboard.title');
  String get hrTimeframeThisMonth => _t('hr.timeframe.this_month');
  String get hrTimeframeLastMonth => _t('hr.timeframe.last_month');
  String get hrTimeframeThisQuarter => _t('hr.timeframe.this_quarter');
  String get hrTimeframeThisYear => _t('hr.timeframe.this_year');
  String get hrSectionAttendanceOverview =>
      _t('hr.section.attendance_overview');
  String get hrSectionLeaveSummary => _t('hr.section.leave_summary');
  String get hrSectionQuickActions => _t('hr.section.quick_actions');
  String get hrStatTotalStaff => _t('hr.stat.total_staff');
  String get hrStatPresentToday => _t('hr.stat.present_today');
  String get hrStatOnLeave => _t('hr.stat.on_leave');
  String get hrStatPendingLeaves => _t('hr.stat.pending_leaves');
  String get hrAvgAttendanceRate => _t('hr.avg_attendance_rate');
  String get hrLateArrivals => _t('hr.late_arrivals');
  String get hrAbsentees => _t('hr.absentees');
  String get hrTotalApplications => _t('hr.total_applications');
  String get hrApproved => _t('hr.approved');
  String get hrRejected => _t('hr.rejected');
  String get hrPendingApproval => _t('hr.pending_approval');
  String get hrActionStaffManagement => _t('hr.action.staff_management');
  String get hrActionStaffManagementSubtitle =>
      _t('hr.action.staff_management.subtitle');
  String get hrActionPerformance => _t('hr.action.performance');
  String get hrActionPerformanceSubtitle =>
      _t('hr.action.performance.subtitle');
  String get hrActionStaffDirectory => _t('hr.action.staff_directory');
  String get hrActionStaffDirectorySubtitle =>
      _t('hr.action.staff_directory.subtitle');
  String get hrActionReports => _t('hr.action.reports');
  String get hrActionReportsSubtitle => _t('hr.action.reports.subtitle');
  String get hrActionPayslips => _t('hr.action.payslips');
  String get hrActionPayslipsSubtitle => _t('hr.action.payslips.subtitle');
  String get staffMgmtTitle => _t('staff_mgmt.title');
  String get staffMgmtSearchHint => _t('staff_mgmt.search_hint');
  String get staffMgmtAddStaff => _t('staff_mgmt.add_staff');
  String get staffMgmtEditStaff => _t('staff_mgmt.edit_staff');
  String get staffMgmtFullName => _t('staff_mgmt.full_name');
  String get staffMgmtNameRequired => _t('staff_mgmt.name_required');
  String get staffMgmtDepartment => _t('staff_mgmt.department');
  String get staffMgmtClearFilter => _t('staff_mgmt.clear_filter');
  String get staffMgmtActive => _t('staff_mgmt.active');
  String get staffMgmtInactive => _t('staff_mgmt.inactive');
  String get staffMgmtNoStaffFound => _t('staff_mgmt.no_staff_found');
  String get staffMgmtNoStaffMembers => _t('staff_mgmt.no_staff_members');
  String get staffMgmtSearchEmpty => _t('staff_mgmt.search_empty');
  String get staffMgmtApiPending => _t('staff_mgmt.api_pending');
  // REVIEW: HR confirmation
  String get staffMgmtUpdatedSuccess => _t('staff_mgmt.updated_success');
  String get staffMgmtAddedPending => _t('staff_mgmt.added_pending');
  String get staffMgmtListApiUnavailable =>
      _t('staff_mgmt.list_api_unavailable');
  String get performanceTitle => _t('performance.title');
  String get performanceTabAdd => _t('performance.tab.add');
  String get performanceTabReviews => _t('performance.tab.reviews');
  String get performanceEmployeeIdLabel => _t('performance.employee_id_label');
  String get performanceEmployeeIdHint => _t('performance.employee_id_hint');
  String get performanceEmployeeIdRequired =>
      _t('performance.employee_id_required');
  String get performanceReviewPeriodLabel =>
      _t('performance.review_period_label');
  String get performanceOverallRating => _t('performance.overall_rating');
  String get performanceCommentsLabel => _t('performance.comments_label');
  String get performanceCommentsHint => _t('performance.comments_hint');
  String get performanceCommentsRequired => _t('performance.comments_required');
  String get performanceGoalsLabel => _t('performance.goals_label');
  String get performanceGoalsHint => _t('performance.goals_hint');
  String get performanceSavingButton => _t('performance.saving_button');
  String get performanceSaveReview => _t('performance.save_review');
  // REVIEW: HR confirmation
  String get performanceSavedSuccess => _t('performance.saved_success');
  String get performanceRatingExceptional =>
      _t('performance.rating.exceptional');
  String get performanceRatingExceeds => _t('performance.rating.exceeds');
  String get performanceRatingMeets => _t('performance.rating.meets');
  String get performanceRatingNeedsImprovement =>
      _t('performance.rating.needs_improvement');
  String get performanceRatingUnsatisfactory =>
      _t('performance.rating.unsatisfactory');
  String get performanceNoReviews => _t('performance.no_reviews');
  String get directoryTitle => _t('directory.title');
  String get directorySearchHint => _t('directory.search_hint');
  String get directoryEmpty => _t('directory.empty');
  String get directorySearchEmpty => _t('directory.search_empty');
  String get directoryApiPending => _t('directory.api_pending');
  String get directoryApiUnavailable => _t('directory.api_unavailable');
  String get directoryStaffEmptyBody => _t('directory.staff_empty_body');

  // ── Reports & Grievances ───────────────────────────────────────────
  String get reportsHubTitle => _t('reports.hub.title');
  String get reportsHubConfidentialityNote =>
      _t('reports.hub.confidentiality_note');
  String get reportsHubPrompt => _t('reports.hub.prompt');
  String get reportsHubIncidentTitle => _t('reports.hub.incident_title');
  String get reportsHubIncidentSubtitle => _t('reports.hub.incident_subtitle');
  String get reportsHubIncidentNote => _t('reports.hub.incident_note');
  String get reportsHubGrievanceTitle => _t('reports.hub.grievance_title');
  String get reportsHubGrievanceSubtitle =>
      _t('reports.hub.grievance_subtitle');
  String get reportsHubGrievanceNote => _t('reports.hub.grievance_note');
  String get reportsHubMyReports => _t('reports.hub.my_reports');
  String get myReportsTitle => _t('my_reports.title');
  String get myReportsTabIncidents => _t('my_reports.tab.incidents');
  String get myReportsTabGrievances => _t('my_reports.tab.grievances');
  String get myReportsEmptyIncidents => _t('my_reports.empty_incidents');
  String get myReportsEmptyGrievances => _t('my_reports.empty_grievances');
  String get myReportsLabelStatus => _t('my_reports.label.status');
  String get myReportsLabelSeverity => _t('my_reports.label.severity');
  String get myReportsLabelType => _t('my_reports.label.type');
  String get myReportsLabelLocation => _t('my_reports.label.location');
  String get myReportsLabelDescription => _t('my_reports.label.description');
  String get incidentReportTitle => _t('incident_report.title');
  String get incidentReportSeverityLabel =>
      _t('incident_report.severity_label');
  // REVIEW: clinical / safety severity wording
  String get incidentReportSeverityLow => _t('incident_report.severity.low');
  String get incidentReportSeverityLowDesc =>
      _t('incident_report.severity.low_desc');
  String get incidentReportSeverityModerate =>
      _t('incident_report.severity.moderate');
  String get incidentReportSeverityModerateDesc =>
      _t('incident_report.severity.moderate_desc');
  String get incidentReportSeveritySevere =>
      _t('incident_report.severity.severe');
  String get incidentReportSeveritySevereDesc =>
      _t('incident_report.severity.severe_desc');
  String get incidentReportSeveritySentinel =>
      _t('incident_report.severity.sentinel');
  String get incidentReportSeveritySentinelDesc =>
      _t('incident_report.severity.sentinel_desc');
  String get incidentReportTypeLabel => _t('incident_report.type_label');
  String get incidentReportTypeNearMiss => _t('incident_report.type.near_miss');
  String get incidentReportTypePatientFall =>
      _t('incident_report.type.patient_fall');
  String get incidentReportTypeMedicationError =>
      _t('incident_report.type.medication_error');
  String get incidentReportTypeNeedleStick =>
      _t('incident_report.type.needle_stick');
  String get incidentReportTypeEquipmentFailure =>
      _t('incident_report.type.equipment_failure');
  String get incidentReportTypeInfection =>
      _t('incident_report.type.infection');
  String get incidentReportTypeFireSafety =>
      _t('incident_report.type.fire_safety');
  String get incidentReportTypePatientAggression =>
      _t('incident_report.type.patient_aggression');
  String get incidentReportTypeSecurityBreach =>
      _t('incident_report.type.security_breach');
  String get incidentReportTypeOther => _t('incident_report.type.other');
  String get incidentReportTitleLabel => _t('incident_report.title_label');
  String get incidentReportTitleHint => _t('incident_report.title_hint');
  String get incidentReportTitleRequired =>
      _t('incident_report.title_required');
  String get incidentReportWhatHappened => _t('incident_report.what_happened');
  String get incidentReportWhatHappenedHint =>
      _t('incident_report.what_happened_hint');
  String get incidentReportDescriptionRequired =>
      _t('incident_report.description_required');
  String get incidentReportDateLabel => _t('incident_report.date_label');
  String get incidentReportTimeLabel => _t('incident_report.time_label');
  String get incidentReportLocationLabel =>
      _t('incident_report.location_label');
  String get incidentReportLocationHint => _t('incident_report.location_hint');
  String get incidentReportPatientInvolved =>
      _t('incident_report.patient_involved');
  String get incidentReportPatientNameLabel =>
      _t('incident_report.patient_name_label');
  String get incidentReportWitnessesLabel =>
      _t('incident_report.witnesses_label');
  String get incidentReportWitnessesHint =>
      _t('incident_report.witnesses_hint');
  String get incidentReportImmediateAction =>
      _t('incident_report.immediate_action');
  String get incidentReportImmediateActionHint =>
      _t('incident_report.immediate_action_hint');
  String get incidentReportAnonymous => _t('incident_report.anonymous');
  String get incidentReportAnonymousNote =>
      _t('incident_report.anonymous_note');
  String get incidentReportSubmitButton => _t('incident_report.submit_button');
  // REVIEW: clinical / safety confirmation
  String get incidentReportSubmittedTitle =>
      _t('incident_report.submitted_title');
  String get incidentReportEscalationNote =>
      _t('incident_report.escalation_note');
  String get incidentReportRoutineNote => _t('incident_report.routine_note');
  String get incidentReportDoneButton => _t('incident_report.done_button');
  String get grievanceTitle => _t('grievance.title');
  String get grievancePrivacyNote => _t('grievance.privacy_note');
  String get grievanceTypeLabel => _t('grievance.type_label');
  String get grievanceTypeHarassment => _t('grievance.type.harassment');
  String get grievanceTypeDiscrimination => _t('grievance.type.discrimination');
  String get grievanceTypeUnfairTreatment =>
      _t('grievance.type.unfair_treatment');
  String get grievanceTypeUnsafeConditions =>
      _t('grievance.type.unsafe_conditions');
  String get grievanceTypeWorkload => _t('grievance.type.workload');
  String get grievanceTypePayDispute => _t('grievance.type.pay_dispute');
  String get grievanceTypeScheduleConflict =>
      _t('grievance.type.schedule_conflict');
  String get grievanceTypePolicyViolation =>
      _t('grievance.type.policy_violation');
  String get grievanceTypeOther => _t('grievance.type.other');
  String get grievanceSubjectLabel => _t('grievance.subject_label');
  String get grievanceSubjectHint => _t('grievance.subject_hint');
  String get grievanceSubjectRequired => _t('grievance.subject_required');
  String get grievanceDescribeLabel => _t('grievance.describe_label');
  String get grievanceDescribeHint => _t('grievance.describe_hint');
  String get grievanceDescriptionRequired =>
      _t('grievance.description_required');
  String get grievanceAgainstWhomLabel => _t('grievance.against_whom_label');
  String get grievanceAgainstWhomHint => _t('grievance.against_whom_hint');
  String get grievanceDeptLabel => _t('grievance.dept_label');
  String get grievanceDateOptional => _t('grievance.date_optional');
  String get grievanceDatePrefix => _t('grievance.date_prefix');
  String get grievanceAnonymous => _t('grievance.anonymous');
  String get grievanceAnonymousNote => _t('grievance.anonymous_note');
  String get grievanceSubmitButton => _t('grievance.submit_button');
  // REVIEW: HR confirmation
  String get grievanceSubmittedTitle => _t('grievance.submitted_title');
  String get grievanceAcknowledgementNote =>
      _t('grievance.acknowledgement_note');
  String get grievanceAcknowledgementAnonymous =>
      _t('grievance.acknowledgement_anonymous');

  // ── Housekeeping ───────────────────────────────────────────────────
  String get housekeepingHubTitle => _t('housekeeping.hub.title');
  String get housekeepingHubLogTitle => _t('housekeeping.hub.log_title');
  String get housekeepingHubLogSubtitle => _t('housekeeping.hub.log_subtitle');
  String get housekeepingHubRaiseTitle => _t('housekeeping.hub.raise_title');
  String get housekeepingHubRaiseSubtitle =>
      _t('housekeeping.hub.raise_subtitle');
  String get housekeepingHubMyTitle => _t('housekeeping.hub.my_title');
  String get housekeepingHubMySubtitle => _t('housekeeping.hub.my_subtitle');
  String get housekeepingLogTitle => _t('housekeeping.log.title');
  String get housekeepingLogTypeLabel => _t('housekeeping.log.type_label');
  String get housekeepingTypeRoutine => _t('housekeeping.type.routine');
  String get housekeepingTypeDeep => _t('housekeeping.type.deep');
  String get housekeepingTypeDisinfection =>
      _t('housekeeping.type.disinfection');
  String get housekeepingTypeSpillage => _t('housekeeping.type.spillage');
  String get housekeepingTypePostProcedure =>
      _t('housekeeping.type.post_procedure');
  String get housekeepingZoneLocationLabel =>
      _t('housekeeping.zone_location_label');
  String get housekeepingSelectZoneLabel =>
      _t('housekeeping.select_zone_label');
  String get housekeepingSelectZoneOrType =>
      _t('housekeeping.select_zone_or_type');
  String get housekeepingDescribeLocation =>
      _t('housekeeping.describe_location');
  String get housekeepingLocationHint => _t('housekeeping.location_hint');
  String get housekeepingPhotoEvidence => _t('housekeeping.photo_evidence');
  String get housekeepingTakePhoto => _t('housekeeping.take_photo');
  String get housekeepingNotesLabel => _t('housekeeping.notes_label');
  String get housekeepingSubmitLog => _t('housekeeping.submit_log');
  String get housekeepingSubmittingLog => _t('housekeeping.submitting_log');
  String get housekeepingSelectZoneError =>
      _t('housekeeping.select_zone_error');
  // REVIEW: confirmation
  String get housekeepingLoggedTitle => _t('housekeeping.logged_title');
  String get housekeepingLoggedBody => _t('housekeeping.logged_body');
  String get housekeepingDoneButton => _t('housekeeping.done_button');
  String get housekeepingRaiseTitle => _t('housekeeping.raise.title');
  String get housekeepingRaiseTypeLabel => _t('housekeeping.raise.type_label');
  String get housekeepingRaiseUrgencyLabel =>
      _t('housekeeping.raise.urgency_label');
  String get housekeepingRequestTypeCleaning =>
      _t('housekeeping.request_type.cleaning');
  String get housekeepingRequestTypeSpillage =>
      _t('housekeeping.request_type.spillage');
  String get housekeepingRequestTypeWaste =>
      _t('housekeeping.request_type.waste');
  String get housekeepingRequestTypeLinen =>
      _t('housekeeping.request_type.linen');
  String get housekeepingRequestTypeDisinfection =>
      _t('housekeeping.request_type.disinfection');
  String get housekeepingRequestTypeOther =>
      _t('housekeeping.request_type.other');
  String get housekeepingDescriptionLabel =>
      _t('housekeeping.description_label');
  String get housekeepingDescriptionHint => _t('housekeeping.description_hint');
  String get housekeepingProblemPhoto => _t('housekeeping.problem_photo');
  String get housekeepingPhotographProblem =>
      _t('housekeeping.photograph_problem');
  String get housekeepingRaiseRequestButton =>
      _t('housekeeping.raise_request_button');
  String get housekeepingRaisingButton => _t('housekeeping.raising_button');
  // REVIEW: confirmation
  String get housekeepingRaisedTitle => _t('housekeeping.raised_title');
  String get housekeepingNotifiedNote => _t('housekeeping.notified_note');
  String get housekeepingMyTitle => _t('housekeeping.my.title');
  String get housekeepingMyTabLogs => _t('housekeeping.my.tab_logs');
  String get housekeepingMyTabRequests => _t('housekeeping.my.tab_requests');
  String get housekeepingMyTabRaised => _t('housekeeping.my.tab_raised');
  String get housekeepingMyTabAssigned => _t('housekeeping.my.tab_assigned');
  String get housekeepingNoLogs => _t('housekeeping.no_logs');
  String get housekeepingNoRequests => _t('housekeeping.no_requests');
  String get housekeepingUnknownLocation => _t('housekeeping.unknown_location');
  String get housekeepingMarkComplete => _t('housekeeping.mark_complete');
  String get housekeepingCompleteDialogTitle =>
      _t('housekeeping.complete_dialog_title');
  String get housekeepingCompletionNotes => _t('housekeeping.completion_notes');
  String get housekeepingAddCompletionPhoto =>
      _t('housekeeping.add_completion_photo');
  // REVIEW: confirmation
  String get housekeepingMarkedComplete => _t('housekeeping.marked_complete');
  String get housekeepingStatusVerified => _t('housekeeping.status.verified');
  String get housekeepingStatusFlagged => _t('housekeeping.status.flagged');
  String get housekeepingStatusSubmitted => _t('housekeeping.status.submitted');

  // ── Hospital departments ──────────────────────────────────────────
  String get bloodBankTitle => _t('blood_bank.title');
  String get bloodBankTabInventory => _t('blood_bank.tab.inventory');
  String get bloodBankTabRequests => _t('blood_bank.tab.requests');
  String get bloodBankTabDonations => _t('blood_bank.tab.donations');
  String get bloodBankRefreshTooltip => _t('blood_bank.refresh_tooltip');
  String get bloodBankLegendAdequate => _t('blood_bank.legend.adequate');
  String get bloodBankLegendLow => _t('blood_bank.legend.low');
  String get bloodBankLegendCritical => _t('blood_bank.legend.critical');
  String get bloodBankUnitsSuffix => _t('blood_bank.units_suffix');
  String get bloodBankStockCriticalLow => _t('blood_bank.stock.critical_low');
  String get bloodBankStockLow => _t('blood_bank.stock.low');
  String get bloodBankStockAdequate => _t('blood_bank.stock.adequate');
  String get bloodBankRequestHeader => _t('blood_bank.request_header');
  String get bloodBankPatientNameLabel => _t('blood_bank.patient_name_label');
  String get bloodBankPatientNameRequired =>
      _t('blood_bank.patient_name_required');
  String get bloodBankBloodTypeLabel => _t('blood_bank.blood_type_label');
  String get bloodBankBloodTypeRequired => _t('blood_bank.blood_type_required');
  String get bloodBankUnitsLabel => _t('blood_bank.units_label');
  String get bloodBankUnitsRequired => _t('blood_bank.units_required');
  String get bloodBankUnitsInvalid => _t('blood_bank.units_invalid');
  String get bloodBankReasonLabel => _t('blood_bank.reason_label');
  String get bloodBankSubmitRequest => _t('blood_bank.submit_request');
  String get bloodBankSubmittingButton => _t('blood_bank.submitting_button');
  // REVIEW: clinical confirmation
  String get bloodBankRequestSuccess => _t('blood_bank.request_success');
  String get bloodBankDonationsTitle => _t('blood_bank.donations.title');
  String get bloodBankDonationsBody => _t('blood_bank.donations.body');
  String get dietaryTitle => _t('dietary.title');
  String get dietaryRefreshTooltip => _t('dietary.refresh_tooltip');
  String get dietaryNewOrderButton => _t('dietary.new_order_button');
  String get dietaryNewOrderDialog => _t('dietary.new_order_dialog');
  String get dietaryPatientUidLabel => _t('dietary.patient_uid_label');
  String get dietaryPatientUidRequired => _t('dietary.patient_uid_required');
  String get dietaryDietTypeLabel => _t('dietary.diet_type_label');
  String get dietaryDietTypeRequired => _t('dietary.diet_type_required');
  String get dietaryMealTimeLabel => _t('dietary.meal_time_label');
  String get dietaryMealTimeRequired => _t('dietary.meal_time_required');
  String get dietaryRestrictionsLabel => _t('dietary.restrictions_label');
  String get dietaryNotesLabel => _t('dietary.notes_label');
  String get dietaryCreateButton => _t('dietary.create_button');
  // REVIEW: clinical confirmation
  String get dietaryCreatedSuccess => _t('dietary.created_success');
  String get dietaryDiscontinuedSuccess => _t('dietary.discontinued_success');
  String get dietaryDiscontinue => _t('dietary.discontinue');
  String get dietaryDietRegular => _t('dietary.diet.regular');
  String get dietaryDietDiabetic => _t('dietary.diet.diabetic');
  String get dietaryDietCardiac => _t('dietary.diet.cardiac');
  String get dietaryDietRenal => _t('dietary.diet.renal');
  String get dietaryDietSoft => _t('dietary.diet.soft');
  String get dietaryDietLiquid => _t('dietary.diet.liquid');
  String get dietaryDietNpo => _t('dietary.diet.npo');
  String get dietaryDietEnteral => _t('dietary.diet.enteral');
  String get dietaryMealBreakfast => _t('dietary.meal.breakfast');
  String get dietaryMealLunch => _t('dietary.meal.lunch');
  String get dietaryMealDinner => _t('dietary.meal.dinner');
  String get dietaryMealSnack => _t('dietary.meal.snack');
  String get dietaryEmptyTitle => _t('dietary.empty_title');
  String get dietaryEmptyBody => _t('dietary.empty_body');
  String get theatreTitle => _t('theatre.title');
  String get theatrePickDate => _t('theatre.pick_date');
  String get theatreTabSchedule => _t('theatre.tab.schedule');
  String get theatreTabAvailability => _t('theatre.tab.availability');
  String get theatreNoSurgeries => _t('theatre.no_surgeries');
  String get theatreNoRoomData => _t('theatre.no_room_data');
  String get theatreStatusScheduled => _t('theatre.status.scheduled');
  String get theatreStatusInProgress => _t('theatre.status.in_progress');
  String get theatreStatusCompleted => _t('theatre.status.completed');
  String get theatreStatusCancelled => _t('theatre.status.cancelled');
  String get theatreSurgeonPrefix => _t('theatre.surgeon_prefix');
  String get theatreLabelPatientUid => _t('theatre.label.patient_uid');
  String get theatreLabelProcedureCode => _t('theatre.label.procedure_code');
  String get theatreLabelOtRoom => _t('theatre.label.ot_room');
  String get theatreLabelDate => _t('theatre.label.date');
  String get theatreLabelTime => _t('theatre.label.time');
  String get theatreLabelDuration => _t('theatre.label.duration');
  String get theatreLabelSurgeon => _t('theatre.label.surgeon');
  String get theatreLabelAnesthetist => _t('theatre.label.anesthetist');
  String get theatreLabelStatus => _t('theatre.label.status');
  String get theatreLabelBloodArranged => _t('theatre.label.blood_arranged');
  String get theatreLabelConsent => _t('theatre.label.consent');
  String get theatreLabelEquipment => _t('theatre.label.equipment');
  // REVIEW: clinical-action - surgery start/complete
  String get theatreStartSurgery => _t('theatre.start_surgery');
  String get theatreMarkComplete => _t('theatre.mark_complete');
  String get theatreCancelButton => _t('theatre.cancel_button');
  String get theatrePreOpChecklist => _t('theatre.preop_checklist');
  String get theatreChecklistConsent => _t('theatre.checklist.consent');
  String get theatreChecklistBlood => _t('theatre.checklist.blood');
  String get theatreChecklistEquipment => _t('theatre.checklist.equipment');
  String get theatreChecklistPatientId => _t('theatre.checklist.patient_id');
  String get theatreSubmitChecklist => _t('theatre.submit_checklist');
  String get theatreChecklistUpdated => _t('theatre.checklist_updated');
  String get theatreStatusUpdatedTo => _t('theatre.status_updated_to');
  String get theatreYes => _t('theatre.yes');
  String get theatreNo => _t('theatre.no');
  String get theatreAvailable => _t('theatre.available');
  String get theatreOccupied => _t('theatre.occupied');
  String get radiologyTitle => _t('radiology.title');
  String get radiologyFiltersTooltip => _t('radiology.filters_tooltip');
  String get radiologyFiltersHeader => _t('radiology.filters_header');
  String get radiologyStatusLabel => _t('radiology.status_label');
  String get radiologyModalityLabel => _t('radiology.modality_label');
  String get radiologyStatusAll => _t('radiology.status.all');
  String get radiologyStatusPending => _t('radiology.status.pending');
  String get radiologyStatusInProgress => _t('radiology.status.in_progress');
  String get radiologyStatusCompleted => _t('radiology.status.completed');
  String get radiologyStatusCancelled => _t('radiology.status.cancelled');
  String get radiologyNoOrders => _t('radiology.no_orders');
  String get radiologyLabelStudyType => _t('radiology.label.study_type');
  String get radiologyLabelModality => _t('radiology.label.modality');
  String get radiologyLabelBodyPart => _t('radiology.label.body_part');
  String get radiologyLabelPriority => _t('radiology.label.priority');
  String get radiologyLabelClinicalIndication =>
      _t('radiology.label.clinical_indication');
  String get radiologyLabelNotes => _t('radiology.label.notes');
  String get radiologyLabelReport => _t('radiology.label.report');
  String get radiologyLabelFindings => _t('radiology.label.findings');
  String get radiologyLabelImpression => _t('radiology.label.impression');
  String get radiologySubmitReport => _t('radiology.submit_report');
  String get radiologyCancelOrder => _t('radiology.cancel_order');
  String get radiologyFindingsRequired => _t('radiology.findings_required');
  // REVIEW: clinical confirmation
  String get radiologyReportSubmitted => _t('radiology.report_submitted');
  String get radiologyOrderCancelled => _t('radiology.order_cancelled');
  String get scheduleTitle => _t('schedule.title');
  String get schedulePrevWeek => _t('schedule.prev_week');
  String get scheduleNextWeek => _t('schedule.next_week');
  String get scheduleWeekThis => _t('schedule.week_this');
  String get scheduleWeekNext => _t('schedule.week_next');
  String get scheduleWeekLast => _t('schedule.week_last');
  String get scheduleTotalLabel => _t('schedule.total_label');
  String get scheduleDaysLogged => _t('schedule.days_logged');
  String get scheduleHoursWorkedSuffix => _t('schedule.hours_worked_suffix');
  String get scheduleUpcoming => _t('schedule.upcoming');
  String get scheduleNoRecord => _t('schedule.no_record');
  String get scheduleLoadFailedPrefix => _t('schedule.load_failed_prefix');

  // ── Lab / Pharmacy / Investigations ───────────────────────────────
  String get investigationsTitle => _t('investigations.title');
  String get investigationsTabUpload => _t('investigations.tab.upload');
  String get investigationsTabPending => _t('investigations.tab.pending');
  String get investigationsTabRecent => _t('investigations.tab.recent');
  String get investigationsUploadIntro => _t('investigations.upload_intro');
  String get investigationsPhoneLabel => _t('investigations.phone_label');
  String get investigationsPhoneHint => _t('investigations.phone_hint');
  String get investigationsPhoneRequired => _t('investigations.phone_required');
  String get investigationsPhoneInvalid => _t('investigations.phone_invalid');
  String get investigationsTestTypeLabel =>
      _t('investigations.test_type_label');
  String get investigationsTestTypeRequired =>
      _t('investigations.test_type_required');
  String get investigationsResultLabel => _t('investigations.result_label');
  String get investigationsResultHint => _t('investigations.result_hint');
  String get investigationsClinicalNotesLabel =>
      _t('investigations.clinical_notes_label');
  String get investigationsClinicalNotesHint =>
      _t('investigations.clinical_notes_hint');
  String get investigationsAttachReport => _t('investigations.attach_report');
  String get investigationsClearFile => _t('investigations.clear_file');
  String get investigationsFileTooLarge => _t('investigations.file_too_large');
  String get investigationsFilePickFailed =>
      _t('investigations.file_pick_failed');
  String get investigationsUploading => _t('investigations.uploading');
  String get investigationsUploadButton => _t('investigations.upload_button');
  // REVIEW: clinical confirmation
  String get investigationsUploadSuccess => _t('investigations.upload_success');
  String get investigationsPendingEmpty => _t('investigations.pending_empty');
  String get investigationsPendingEmptyBody =>
      _t('investigations.pending_empty_body');
  String get investigationsRecentEmpty => _t('investigations.recent_empty');
  String get investigationsRecentEmptyBody =>
      _t('investigations.recent_empty_body');
  String get investigationsStartButton => _t('investigations.start_button');
  String get investigationsCompleteButton =>
      _t('investigations.complete_button');
  String get investigationsMarkedAsPrefix =>
      _t('investigations.marked_as_prefix');
  String get labBookingsTitle => _t('lab_bookings.title');
  String get labBookingsTabNew => _t('lab_bookings.tab.new');
  String get labBookingsTabActive => _t('lab_bookings.tab.active');
  String get labBookingsTabDone => _t('lab_bookings.tab.done');
  String get labBookingsEmptyPrefix => _t('lab_bookings.empty_prefix');
  String get labBookingsViewSlip => _t('lab_bookings.view_slip');
  String get labBookingsHomeCollection => _t('lab_bookings.home_collection');
  String get labBookingsWalkIn => _t('lab_bookings.walk_in');
  String get labBookingsConfirmDialog => _t('lab_bookings.confirm_dialog');
  String get labBookingsActualTestsLabel =>
      _t('lab_bookings.actual_tests_label');
  String get labBookingsActualTestsHint => _t('lab_bookings.actual_tests_hint');
  String get labBookingsFinalCostLabel => _t('lab_bookings.final_cost_label');
  String get labBookingsConfirmButton => _t('lab_bookings.confirm_button');
  // REVIEW: clinical confirmation
  String get labBookingsConfirmedToast => _t('lab_bookings.confirmed_toast');
  String get labBookingsDispatchDialog => _t('lab_bookings.dispatch_dialog');
  String get labBookingsCollectorPhone => _t('lab_bookings.collector_phone');
  String get labBookingsDispatchButton => _t('lab_bookings.dispatch_button');
  String get labBookingsDispatchedToast => _t('lab_bookings.dispatched_toast');
  String get labBookingsSharingLocation => _t('lab_bookings.sharing_location');
  String get labBookingsMarkCollected => _t('lab_bookings.mark_collected');
  String get labBookingsSamplesCollectedToast =>
      _t('lab_bookings.samples_collected_toast');
  String get labBookingsStartProcessing => _t('lab_bookings.start_processing');
  String get labBookingsProcessingStartedToast =>
      _t('lab_bookings.processing_started_toast');
  String get labBookingsUploadResult => _t('lab_bookings.upload_result');
  String get labBookingsSelectFile => _t('lab_bookings.select_file');
  String get labBookingsResultUploadedToast =>
      _t('lab_bookings.result_uploaded_toast');
  String get labBookingsViewResult => _t('lab_bookings.view_result');
  String get pharmacyTitle => _t('pharmacy.title');
  String get pharmacyQueueTitle => _t('pharmacy.queue_title');
  String get pharmacyQueueSubtitle => _t('pharmacy.queue_subtitle');
  String get pharmacyTabNew => _t('pharmacy.tab.new');
  String get pharmacyTabActive => _t('pharmacy.tab.active');
  String get pharmacyTabDone => _t('pharmacy.tab.done');
  String get pharmacyEmptyNew => _t('pharmacy.empty.new');
  String get pharmacyEmptyActive => _t('pharmacy.empty.active');
  String get pharmacyEmptyDone => _t('pharmacy.empty.done');
  String get pharmacyConfirmDialog => _t('pharmacy.confirm_dialog');
  String get pharmacyPatientNotePrefix => _t('pharmacy.patient_note_prefix');
  String get pharmacyItemsLabel => _t('pharmacy.items_label');
  String get pharmacyItemsHint => _t('pharmacy.items_hint');
  String get pharmacyTotalCostLabel => _t('pharmacy.total_cost_label');
  String get pharmacyConfirmOrder => _t('pharmacy.confirm_order');
  String get pharmacyViewConfirm => _t('pharmacy.view_confirm');
  String get pharmacyStartPreparing => _t('pharmacy.start_preparing');
  String get pharmacyDispatch => _t('pharmacy.dispatch');
  String get pharmacyMarkDelivered => _t('pharmacy.mark_delivered');
  String get pharmacyDispatchDialog => _t('pharmacy.dispatch_dialog');
  String get pharmacyDeliveryPersonName => _t('pharmacy.delivery_person_name');
  String get pharmacyDeliveryPersonPhone =>
      _t('pharmacy.delivery_person_phone');
  String get pharmacyMarkDeliveredDialog =>
      _t('pharmacy.mark_delivered_dialog');
  String get pharmacyMarkDeliveredYes => _t('pharmacy.mark_delivered_yes');
  String get pharmacyCancelDialog => _t('pharmacy.cancel_dialog');
  String get pharmacyCancellationReason => _t('pharmacy.cancellation_reason');
  String get pharmacyDeliveryTypePickup => _t('pharmacy.delivery_type.pickup');
  String get pharmacyDeliveryTypeDelivery =>
      _t('pharmacy.delivery_type.delivery');
  // REVIEW: clinical confirmation
  String get pharmacyOrderConfirmedToast =>
      _t('pharmacy.order_confirmed_toast');
  String get pharmacyMarkPreparingToast => _t('pharmacy.mark_preparing_toast');
  String get pharmacyOrderDispatchedToast =>
      _t('pharmacy.order_dispatched_toast');
  String get pharmacyOrderDeliveredToast =>
      _t('pharmacy.order_delivered_toast');
  String get pharmacyOrderCancelledToast =>
      _t('pharmacy.order_cancelled_toast');
  String get pharmacyStatusPlaced => _t('pharmacy.status.placed');
  String get pharmacyStatusConfirmed => _t('pharmacy.status.confirmed');
  String get pharmacyStatusPreparing => _t('pharmacy.status.preparing');
  String get pharmacyStatusDispatched => _t('pharmacy.status.dispatched');
  String get pharmacyStatusDelivered => _t('pharmacy.status.delivered');
  String get pharmacyStatusCancelled => _t('pharmacy.status.cancelled');

  // ── Nursing (due meds + MAR scan) ─────────────────────────────────
  String get dueMedsTitle => _t('due_meds.title');
  String get dueMedsSearchHint => _t('due_meds.search_hint');
  String get dueMedsEmptyTitle => _t('due_meds.empty_title');
  String get dueMedsEmptyBody => _t('due_meds.empty_body');
  String get dueMedsHeldBadge => _t('due_meds.held_badge');
  String get dueMedsUnknownPatient => _t('due_meds.unknown_patient');
  String get dueMedsUnnamedMedication => _t('due_meds.unnamed_medication');
  String get marScanTitle => _t('mar_scan.title');
  // REVIEW: clinical-action / safety wording for medication 5-rights
  String get marScanStep1Prompt => _t('mar_scan.step1_prompt');
  String get marScanStep1Subtitle => _t('mar_scan.step1_subtitle');
  String get marScanStep2Prompt => _t('mar_scan.step2_prompt');
  String get marScanStep2Subtitle => _t('mar_scan.step2_subtitle');
  String get marScanStep3Header => _t('mar_scan.step3_header');
  String get marScanRightPatient => _t('mar_scan.right_patient');
  String get marScanRightDrug => _t('mar_scan.right_drug');
  String get marScanRightDose => _t('mar_scan.right_dose');
  String get marScanRightRoute => _t('mar_scan.right_route');
  String get marScanRightTime => _t('mar_scan.right_time');
  String get marScanRecording => _t('mar_scan.recording');
  String get marScanAdminister => _t('mar_scan.administer');
  String get marScanCheckFailed => _t('mar_scan.check_failed');
  String get marScanOverrideHint => _t('mar_scan.override_hint');
  String get marScanOverrideReasonLabel => _t('mar_scan.override_reason_label');
  String get marScanOverrideButton => _t('mar_scan.override_button');
  String get marScanRecorded => _t('mar_scan.recorded');
  String get marScanScanNext => _t('mar_scan.scan_next');
  String get marScanScanAgain => _t('mar_scan.scan_again');
  String get marScanTryAgain => _t('mar_scan.try_again');
  String get marScanUnknownMedication => _t('mar_scan.unknown_medication');

  // ── EMR / Discharge Summary ───────────────────────────────────────
  String get dischargeTitlePrefix => _t('discharge.title_prefix');
  String get dischargeSaveDraft => _t('discharge.save_draft');
  String get dischargeDraftSaved => _t('discharge.draft_saved');
  String get dischargeSignSummary => _t('discharge.sign_summary');
  String get dischargeSignDialogTitle => _t('discharge.sign_dialog_title');
  String get dischargeSignDialogBody => _t('discharge.sign_dialog_body');
  String get dischargeSignButton => _t('discharge.sign_button');
  // REVIEW: clinical-action confirmation
  String get dischargeSignedSuccess => _t('discharge.signed_success');
  String get dischargeSignedBadge => _t('discharge.signed_badge');
  String get dischargeProceedTitle => _t('discharge.proceed_title');
  String get dischargeProceedBodyPrefix => _t('discharge.proceed_body_prefix');
  String get dischargeProceedButton => _t('discharge.proceed_button');
  String get dischargeMustSignFirst => _t('discharge.must_sign_first');
  String get dischargePatientDischarged => _t('discharge.patient_discharged');
  String get dischargePatientButton => _t('discharge.patient_button');
  String get dischargeGenerateTitle => _t('discharge.generate_title');
  String get dischargeGenerateBody => _t('discharge.generate_body');
  String get dischargeGenerateButton => _t('discharge.generate_button');
  String get dischargeGenerating => _t('discharge.generating');
  String get dischargeRegenerate => _t('discharge.regenerate');
  String get dischargeSectionHospitalCourse =>
      _t('discharge.section.hospital_course');
  String get dischargeSectionDiagnosis => _t('discharge.section.diagnosis');
  String get dischargeSectionCondition => _t('discharge.section.condition');
  String get dischargeSectionFollowUp => _t('discharge.section.follow_up');
  String get dischargeSectionActivity => _t('discharge.section.activity');
  String get dischargeSectionDiet => _t('discharge.section.diet');
  String get dischargeSectionWarningSigns =>
      _t('discharge.section.warning_signs');
  String get dischargeSectionMedications => _t('discharge.section.medications');
  String get dischargeSectionInvestigations =>
      _t('discharge.section.investigations');
  String get dischargeSectionProcedures => _t('discharge.section.procedures');

  // ── Attendance dispute / overtime ─────────────────────────────────
  String get disputeTitle => _t('dispute.title');
  String get disputeTabSubmit => _t('dispute.tab.submit');
  String get disputeTabMy => _t('dispute.tab.my');
  String get disputeIntro => _t('dispute.intro');
  String get disputeDateLabel => _t('dispute.date_label');
  String get disputeSelectDate => _t('dispute.select_date');
  String get disputeIssueTypeLabel => _t('dispute.issue_type_label');
  String get disputeTypeMissedCheckin => _t('dispute.type.missed_checkin');
  String get disputeTypeMissedCheckout => _t('dispute.type.missed_checkout');
  String get disputeTypeWrongTime => _t('dispute.type.wrong_time');
  String get disputeTypeAppFailure => _t('dispute.type.app_failure');
  String get disputeTypeOther => _t('dispute.type.other');
  String get disputeDescriptionLabel => _t('dispute.description_label');
  String get disputeDescriptionHint => _t('dispute.description_hint');
  String get disputeCorrectTimes => _t('dispute.correct_times');
  String get disputeCorrectTimesHint => _t('dispute.correct_times_hint');
  String get disputeCheckIn => _t('dispute.check_in');
  String get disputeCheckOut => _t('dispute.check_out');
  String get disputeRequiredError => _t('dispute.required_error');
  String get disputeSubmitButton => _t('dispute.submit_button');
  // REVIEW: HR confirmation
  String get disputeSubmittedSuccess => _t('dispute.submitted_success');
  String get disputeEmpty => _t('dispute.empty');
  String get disputeHrCommentPrefix => _t('dispute.hr_comment_prefix');
  String get overtimeTitle => _t('overtime.title');
  String get overtimeTabRequest => _t('overtime.tab.request');
  String get overtimeTabMy => _t('overtime.tab.my');
  String get overtimeExtraHoursLabel => _t('overtime.extra_hours_label');
  String get overtimeHoursSuffix => _t('overtime.hours_suffix');
  String get overtimeTypeLabel => _t('overtime.type_label');
  String get overtimeTypeCompTime => _t('overtime.type.comp_time');
  String get overtimeTypePayment => _t('overtime.type.payment');
  String get overtimeReasonLabel => _t('overtime.reason_label');
  String get overtimeReasonHint => _t('overtime.reason_hint');
  String get overtimeRequiredError => _t('overtime.required_error');
  String get overtimeSubmitButton => _t('overtime.submit_button');
  // REVIEW: HR confirmation
  String get overtimeSubmittedSuccess => _t('overtime.submitted_success');
  String get overtimeEmpty => _t('overtime.empty');
  String get overtimeRejectedPrefix => _t('overtime.rejected_prefix');

  // ── Telemedicine ──────────────────────────────────────────────────
  String get telemedicineTitlePrefix => _t('telemedicine.title_prefix');
  String get telemedicineSdkMissingTitle =>
      _t('telemedicine.sdk_missing_title');
  String get telemedicineSdkMissingBody => _t('telemedicine.sdk_missing_body');
  String get telemedicineMute => _t('telemedicine.mute');
  String get telemedicineUnmute => _t('telemedicine.unmute');
  String get telemedicineCameraOff => _t('telemedicine.camera_off');
  String get telemedicineCameraOn => _t('telemedicine.camera_on');
  String get telemedicineEndCall => _t('telemedicine.end_call');

  // ── Clinical AI ───────────────────────────────────────────────────
  String get clinicalAiQueueTitle => _t('clinical_ai.queue.title');
  String get clinicalAiQueueComposeButton =>
      _t('clinical_ai.queue.compose_button');
  String get clinicalAiQueueVoiceNotesButton =>
      _t('clinical_ai.queue.voice_notes_button');
  String get clinicalAiQueueFilterPending =>
      _t('clinical_ai.queue.filter.pending');
  String get clinicalAiQueueFilterAccepted =>
      _t('clinical_ai.queue.filter.accepted');
  String get clinicalAiQueueFilterEdited =>
      _t('clinical_ai.queue.filter.edited');
  String get clinicalAiQueueFilterRejected =>
      _t('clinical_ai.queue.filter.rejected');
  String get clinicalAiQueueFilterAll => _t('clinical_ai.queue.filter.all');
  String get clinicalAiQueueEmptyTitle => _t('clinical_ai.queue.empty_title');
  String get clinicalAiQueueEmptyBody => _t('clinical_ai.queue.empty_body');
  String get clinicalAiQueueLoadFailed => _t('clinical_ai.queue.load_failed');
  String get clinicalAiQueuePatientFallback =>
      _t('clinical_ai.queue.patient_fallback');
  String get clinicalAiDraftRejectTitle => _t('clinical_ai.draft.reject_title');
  String get clinicalAiDraftRejectReasonLabel =>
      _t('clinical_ai.draft.reject_reason_label');
  String get clinicalAiDraftRejectReasonHint =>
      _t('clinical_ai.draft.reject_reason_hint');
  String get clinicalAiDraftRejectButton =>
      _t('clinical_ai.draft.reject_button');
  String get clinicalAiDraftReviewerNoteTitle =>
      _t('clinical_ai.draft.reviewer_note_title');
  String get clinicalAiDraftReviewerNoteLabel =>
      _t('clinical_ai.draft.reviewer_note_label');
  String get clinicalAiDraftReviewerNoteHint =>
      _t('clinical_ai.draft.reviewer_note_hint');
  String get clinicalAiDraftReviewerNoteButton =>
      _t('clinical_ai.draft.reviewer_note_button');
  String get clinicalAiDraftReviewerNoteMinChars =>
      _t('clinical_ai.draft.reviewer_note_min_chars');
  String get clinicalAiDraftReviewNotFound =>
      _t('clinical_ai.draft.review_not_found');
  String get clinicalAiDraftInvalidJson => _t('clinical_ai.draft.invalid_json');
  String get clinicalAiDraftAccept => _t('clinical_ai.draft.accept');
  String get clinicalAiDraftAcceptEdits => _t('clinical_ai.draft.accept_edits');
  String get clinicalAiDraftNeedsRevision =>
      _t('clinical_ai.draft.needs_revision');
  String get clinicalAiDraftDecisionRecorded =>
      _t('clinical_ai.draft.decision_recorded');
  String get clinicalAiDraftNoSafetyFlags =>
      _t('clinical_ai.draft.no_safety_flags');
  String get clinicalAiDraftScreenTitle => _t('clinical_ai.draft.screen_title');
  // REVIEW: clinical-action / safety wording - drafts surfaced here have a CRITICAL severity flag
  String get clinicalAiDraftCriticalTitle =>
      _t('clinical_ai.draft.critical_title');
  String get clinicalAiDraftSafetyHeader =>
      _t('clinical_ai.draft.safety_header');
  String get clinicalAiDraftBodyHeader => _t('clinical_ai.draft.body_header');
  String get clinicalAiDraftEditHeader => _t('clinical_ai.draft.edit_header');
  String get clinicalAiDraftEditButton => _t('clinical_ai.draft.edit_button');
  String get clinicalAiDraftCancelEditButton =>
      _t('clinical_ai.draft.cancel_edit_button');
  String get clinicalAiDraftFailedLoad => _t('clinical_ai.draft.failed_load');
  String get clinicalAiDraftPatientPrefix =>
      _t('clinical_ai.draft.patient_prefix');
  String get clinicalAiDraftAdmissionPrefix =>
      _t('clinical_ai.draft.admission_prefix');
  String get clinicalAiDraftStatusPrefix =>
      _t('clinical_ai.draft.status_prefix');
  String get clinicalAiDraftProviderPrefix =>
      _t('clinical_ai.draft.provider_prefix');
  String clinicalAiDraftDecidedToast(String decision) =>
      '${_t('clinical_ai.draft.decided_prefix')} $decision';
  String clinicalAiDraftDecisionFailed(String err) =>
      '${_t('clinical_ai.draft.decision_failed_prefix')} $err';
  String get clinicalAiComposeRunsTitle => _t('clinical_ai.compose_runs.title');
  String get clinicalAiComposeRunsEmpty => _t('clinical_ai.compose_runs.empty');
  String get clinicalAiComposeFilterActive =>
      _t('clinical_ai.compose_runs.filter.active');
  String get clinicalAiComposeFilterPaused =>
      _t('clinical_ai.compose_runs.filter.paused');
  String get clinicalAiComposeFilterCompleted =>
      _t('clinical_ai.compose_runs.filter.completed');
  String get clinicalAiComposeFilterFailed =>
      _t('clinical_ai.compose_runs.filter.failed');
  String get clinicalAiComposeFilterAll =>
      _t('clinical_ai.compose_runs.filter.all');
  String get clinicalAiComposeReviewPrefix =>
      _t('clinical_ai.compose_runs.review_prefix');
  String get clinicalAiComposeStartedPrefix =>
      _t('clinical_ai.compose_runs.started_prefix');
  String clinicalAiComposeRunHeader(String id, String admissionId) =>
      '${_t('clinical_ai.compose_runs.run_prefix')} #$id · ${_t('clinical_ai.compose_runs.admission_word')} $admissionId';
  String get clinicalAiComposeRunDetailNotFound =>
      _t('clinical_ai.compose_run.not_found');
  String get clinicalAiComposeRunResumed =>
      _t('clinical_ai.compose_run.resumed');
  String get clinicalAiComposeOpenInQueue =>
      _t('clinical_ai.compose_run.open_in_queue');
  String clinicalAiComposeRunDetailTitle(int id) =>
      '${_t('clinical_ai.compose_run.detail_title_prefix')} #$id';
  String clinicalAiComposeAdmissionHeader(String admissionId) =>
      '${_t('clinical_ai.compose_run.admission_header_prefix')} $admissionId';
  String get clinicalAiComposeSubgraphsHeader =>
      _t('clinical_ai.compose_run.subgraphs');
  String get clinicalAiComposeNoSubgraphs =>
      _t('clinical_ai.compose_run.no_subgraphs');
  String clinicalAiComposePausedPrefix(String reason) =>
      '${_t('clinical_ai.compose_run.paused_prefix')} $reason';
  String get clinicalAiComposeReviewStatusKey =>
      _t('clinical_ai.compose_run.review_status_key');
  String get clinicalAiComposeStartedKey =>
      _t('clinical_ai.compose_run.started_key');
  String get clinicalAiComposeFinishedKey =>
      _t('clinical_ai.compose_run.finished_key');
  String get clinicalAiComposeResumeButton =>
      _t('clinical_ai.compose_run.resume_button');
  String get clinicalAiComposeResumingButton =>
      _t('clinical_ai.compose_run.resuming_button');
  String clinicalAiComposeResumeFailed(String err) =>
      '${_t('clinical_ai.compose_run.resume_failed_prefix')} $err';
  String clinicalAiComposeCriticalCount(int count) =>
      '$count ${_t('clinical_ai.compose_run.critical_word')}';
  String clinicalAiComposeHighCount(int count) =>
      '$count ${_t('clinical_ai.compose_run.high_word')}';
  String get clinicalAiVoiceNotesEmpty => _t('clinical_ai.voice_notes.empty');
  String get clinicalAiVoiceSoapGenerated =>
      _t('clinical_ai.voice_notes.soap_generated');
  String get clinicalAiVoiceNotesTitle => _t('clinical_ai.voice_notes.title');
  String get clinicalAiVoiceNotesEmptySubtitle =>
      _t('clinical_ai.voice_notes.empty_subtitle');
  String clinicalAiVoiceNoteHeader(String id) =>
      '${_t('clinical_ai.voice_notes.note_prefix')} #$id';
  String clinicalAiVoicePatientPrefix(String uid) =>
      '${_t('clinical_ai.voice_notes.patient_prefix')} $uid';
  String get clinicalAiVoiceDraftAlreadyGenerated =>
      _t('clinical_ai.voice_notes.draft_exists');
  String get clinicalAiVoiceGenerateSoap =>
      _t('clinical_ai.voice_notes.generate_soap');
  String get clinicalAiVoiceDraftingButton =>
      _t('clinical_ai.voice_notes.drafting');
  String clinicalAiVoiceGenerationFailed(String err) =>
      '${_t('clinical_ai.voice_notes.generation_failed_prefix')} $err';

  // ── Clinical notes screen ──────────────────────────────────────────
  String get clinicalNotesTitle => _t('clinical_notes.title');
  String clinicalNotesTitleWithName(String name) =>
      '${_t('clinical_notes.title_prefix')} - $name';
  String get clinicalNotesTabSoap => _t('clinical_notes.tab.soap');
  String get clinicalNotesTabProgress => _t('clinical_notes.tab.progress');
  String get clinicalNotesTabProcedure => _t('clinical_notes.tab.procedure');
  String get clinicalNotesNewNote => _t('clinical_notes.new_note');
  String get clinicalNotesSigned => _t('clinical_notes.signed');
  String get clinicalNotesUnsigned => _t('clinical_notes.unsigned');
  String get clinicalNotesRetry => _t('clinical_notes.retry');
  String clinicalNotesNoFound(String type) =>
      '${_t('clinical_notes.no_found_prefix')} $type ${_t('clinical_notes.no_found_suffix')}';
  String get clinicalNotesSignNote => _t('clinical_notes.sign_note');
  // REVIEW: clinical-action confirmation
  String get clinicalNotesSignedSuccess => _t('clinical_notes.signed_success');
  String clinicalNotesSignFailed(String e) =>
      '${_t('clinical_notes.sign_failed_prefix')} $e';
  String get clinicalNotesNoteFallback => _t('clinical_notes.note_fallback');
  String get clinicalNotesUnknownAuthor => _t('clinical_notes.unknown_author');
  String get clinicalNotesSubjective => _t('clinical_notes.subjective');
  String get clinicalNotesObjective => _t('clinical_notes.objective');
  String get clinicalNotesAssessment => _t('clinical_notes.assessment');
  String get clinicalNotesPlan => _t('clinical_notes.plan');
  String get clinicalNotesContent => _t('clinical_notes.content');
  String get clinicalNotesFindings => _t('clinical_notes.findings');
  String get clinicalNotesProcedureDetails =>
      _t('clinical_notes.procedure_details');
  String get clinicalNotesComplications => _t('clinical_notes.complications');
  String get clinicalNotesNewSoap => _t('clinical_notes.new_soap');
  String get clinicalNotesNewProgress => _t('clinical_notes.new_progress');
  String get clinicalNotesNewProcedure => _t('clinical_notes.new_procedure');
  String get clinicalNotesSubjectiveHint =>
      _t('clinical_notes.subjective_hint');
  String get clinicalNotesObjectiveHint => _t('clinical_notes.objective_hint');
  String get clinicalNotesAssessmentHint =>
      _t('clinical_notes.assessment_hint');
  String get clinicalNotesPlanHint => _t('clinical_notes.plan_hint');
  String get clinicalNotesTitleField => _t('clinical_notes.title_field');
  String get clinicalNotesContentHint => _t('clinical_notes.content_hint');
  String get clinicalNotesProcedureName => _t('clinical_notes.procedure_name');
  String get clinicalNotesProcedureDetailsHint =>
      _t('clinical_notes.procedure_details_hint');
  String get clinicalNotesFindingsHint => _t('clinical_notes.findings_hint');
  String get clinicalNotesComplicationsHint =>
      _t('clinical_notes.complications_hint');
  String get clinicalNotesRequired => _t('clinical_notes.required');
  String get clinicalNotesSaveNote => _t('clinical_notes.save_note');
  // REVIEW: clinical-action confirmation
  String get clinicalNotesCreatedSuccess =>
      _t('clinical_notes.created_success');
  String clinicalNotesCreateFailed(String e) =>
      '${_t('clinical_notes.create_failed_prefix')} $e';

  // ── AI Assist (clinical notes - patient explainer) ─────────────────
  String get aiAssistTitle => _t('ai_assist.title');
  String get aiAssistGenerateBlurb => _t('ai_assist.generate_blurb');
  String get aiAssistGenerateButton => _t('ai_assist.generate_button');
  String get aiAssistNoteTooShort => _t('ai_assist.note_too_short');
  String get aiAssistGenerating => _t('ai_assist.generating');
  String aiAssistFailed(String err) => '${_t('ai_assist.failed_prefix')} $err';
  String get aiAssistCannotSign => _t('ai_assist.cannot_sign');
  String get aiAssistRejectTitle => _t('ai_assist.reject_title');
  String get aiAssistRejectPrompt => _t('ai_assist.reject_prompt');
  String get aiAssistRejectMinChars => _t('ai_assist.reject_min_chars');
  String get aiAssistRejectHint => _t('ai_assist.reject_hint');
  String get aiAssistDrawerTitle => _t('ai_assist.drawer_title');
  String get aiAssistFallbackBanner => _t('ai_assist.fallback_banner');
  String get aiAssistKeyPoints => _t('ai_assist.key_points');
  String get aiAssistNextSteps => _t('ai_assist.next_steps');
  String get aiAssistWhenToSeekHelp => _t('ai_assist.when_to_seek_help');
  String get aiAssistNeedsEdits => _t('ai_assist.needs_edits');
  // REVIEW: clinical-action confirmation - sign-off binds patient explainer
  String get aiAssistAcceptSign => _t('ai_assist.accept_sign');
  String get aiAssistSummary => _t('ai_assist.summary');
  String get aiAssistEmpty => _t('ai_assist.empty');
  String aiAssistDecisionToast(String decision) =>
      '${_t('ai_assist.decision_prefix')} $decision';
  String aiAssistSignFailed(String err) =>
      '${_t('ai_assist.sign_failed_prefix')} $err';

  // ── CDS blocker modal (clinical-safety hard block) ─────────────────
  // REVIEW: clinical-safety - confirm with attending. CRITICAL hard-block
  // wording shown when the prescription engine flags a dangerous order
  // (severe allergy, lethal interaction). Translators MUST review.
  String get cdsBlockerTitle => _t('cds.blocker_title');
  String get cdsBlockerBody => _t('cds.blocker_body');
  String get cdsBlockerWarningsHeader => _t('cds.warnings_header');
  String get cdsBlockerAllergyHint => _t('cds.allergy_hint');
  String get cdsBlockerOverrideReasonLabel => _t('cds.override_reason_label');
  String get cdsBlockerOverrideButton => _t('cds.override_button');
  String get cdsBlockerOverrideSave => _t('cds.override_save');

  // ── Code Blue (real-time emergency overlay) ────────────────────────
  // REVIEW: clinical-safety - confirm with attending. The highest-stakes
  // string in the app: shown the instant a Code Blue fires, blocking the
  // UI. Mistranslation could delay response. Translators MUST review.
  String get codeBlueTitle => _t('code_blue.title');
  String get codeBlueRespond => _t('code_blue.respond');
  String get codeBlueWardPrefix => _t('code_blue.ward_prefix');
  String get codeBlueBedPrefix => _t('code_blue.bed_prefix');
  String get codeBluePatientPrefix => _t('code_blue.patient_prefix');
  String get codeBlueAcknowledge => _t('code_blue.acknowledge');

  // ── First-run welcome card ─────────────────────────────────────────
  String get firstRunWelcomeTitle => _t('first_run.welcome_title');
  String get firstRunWelcomeDismiss => _t('first_run.welcome_dismiss');
  String get firstRunWelcomeGotIt => _t('first_run.welcome_got_it');
  String get firstRunTipBedTap => _t('first_run.tip_bed_tap');
  String get firstRunTipBedLongPress => _t('first_run.tip_bed_long_press');
  String firstRunTipMagnifier(String modKey) =>
      '${_t('first_run.tip_magnifier_prefix')} $modKey${_t('first_run.tip_magnifier_suffix')}';
  String get firstRunTipDashboard => _t('first_run.tip_dashboard');

  // ── Splash screen / device integrity ───────────────────────────────
  // REVIEW: device-integrity blocker - wording must clearly tell the
  // user the device is rejected for safety, and direct to a hospital-
  // issued device.
  String get splashAppTitle => _t('splash.app_title');
  String get splashDeviceUnsupportedTitle =>
      _t('splash.device_unsupported_title');
  String splashDeviceUnsupportedBody(String reasons) =>
      '${_t('splash.device_unsupported_body')} $reasons. ${_t('splash.device_unsupported_use_hospital_device')}';

  // ── Housekeeping tasks (placeholder screen) ────────────────────────
  String get housekeepingTasksTitle => _t('housekeeping.tasks_title');
  String get housekeepingSampleNotice => _t('housekeeping.sample_notice');
  String get housekeepingTaskCompleted => _t('housekeeping.task_completed');
  String get housekeepingTaskStarted => _t('housekeeping.task_started');
  String get housekeepingNoTasks => _t('housekeeping.no_tasks');
  String get housekeepingTabAll => _t('housekeeping.tab_all');
  String get housekeepingTabPending => _t('housekeeping.tab_pending');
  String get housekeepingTabDone => _t('housekeeping.tab_done');
  String get housekeepingActionStart => _t('housekeeping.action_start');
  String get housekeepingActionDone => _t('housekeeping.action_done');

  // ── Logout dialog ──────────────────────────────────────────────────
  String get logoutDialogTitle => _t('logout.dialog_title');
  String get logoutDialogBody => _t('logout.dialog_body');
  String get logoutTooltip => _t('logout.tooltip');

  // ── Misc shared widgets ────────────────────────────────────────────
  String get shiftCardNoShift => _t('shift_card.no_shift');
  String get pharmacyNoPreview => _t('pharmacy.no_preview');
  String get printGeneratedBy => _t('print.generated_by');
  String get errorSomethingWentWrong => _t('error.something_went_wrong');
  String get errorRestartOrContact => _t('error.restart_or_contact');
  String get appointmentsNoToday => _t('appointments.no_today');

  // ────────────────────────────────────────────────────────────────────
  // Translation tables.
  // ────────────────────────────────────────────────────────────────────
  // English (source of truth) - every key MUST live here.
  // Hindi/Tamil/Telugu - first-pass machine translations. A professional
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
      'dashboard.daily_work': 'Daily Work',
      'dashboard.op_services': 'OP Services',
      'dashboard.ip_services': 'IP Services',
      'dashboard.no_op_services': 'No OP services available for this role',
      'dashboard.no_ip_services': 'No IP services available for this role',
      'dashboard.op_lab_bookings': 'Lab Bookings (OP)',
      'dashboard.ip_lab_bookings': 'Lab Bookings (IP)',
      'dashboard.op_nursing_notes': 'Nursing Notes (OP)',
      'dashboard.ip_nursing_notes': 'Nursing Notes (IP)',
      'dashboard.op_pharmacy': 'Pharmacy (OP)',
      'dashboard.ip_pharmacy': 'Pharmacy (IP)',
      'dashboard.op_lab_results': 'Lab Results (OP)',
      'dashboard.ip_lab_results': 'Lab Results (IP)',
      'dashboard.op_patient_records': 'OP Patient Records',
      'dashboard.ip_patient_records': 'IP Patient Records',
      'dashboard.more_tools': 'More tools',
      'dashboard.more_tools_hint':
          'Leave, profile, settings, and occasional workflows',
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
      'settings.shift_reminders.subtitle': 'Get notified before shift starts',
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
      'settings.manage_devices.subtitle': 'View and remove registered devices',
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
      'settings.quick_link.leave.subtitle': 'Apply for leave and check balance',
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
          'A hospital staff management app by VH Health. Manage attendance, leave, appointments, and more - all from your mobile device.',
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
      'about.feature.staff_directory.description':
          'Find and contact colleagues',
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
          'No connection - vitals saved and will sync when online',
      // Nursing Notes
      'nursing_notes.title': 'Nursing Notes',
      'nursing_notes.tab.add': 'Add Note',
      'nursing_notes.tab.recent': 'Recent Notes',
      'nursing_notes.backend_coming_soon':
          'Saved notes are append-only EMR entries. Corrections must be added as addenda.',
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
      'nursing_notes.offline_queued':
          'Saved offline - will sync when connected',
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
      'patient_picker.empty': 'No patient matches yet - keep typing.',
      // Voice dictation
      'voice_dictate.tooltip': 'Dictate (voice → text)',
      'voice_dictate.recording': 'Dictating…',
      'voice_dictate.stop': 'Stop & Transcribe',
      'voice_dictate.transcribing': 'Transcribing…',
      'voice_dictate.transcript_added': 'Dictation added to notes',
      'voice_dictate.hint': 'Speak naturally. Tap Stop when done.',
      'voice_dictate.added_toast': 'Dictation added to notes',
      'voice_dictate.recording_started': 'Recording started',
      'voice_dictate.recording_stopped': 'Recording stopped, transcribing',
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
      'patient_records.search_hint': 'Search by patient name or type...',
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
      'clinical_notes.objective_hint': 'Exam findings, vitals, lab results...',
      'clinical_notes.assessment_hint': 'Diagnosis, clinical impression...',
      'clinical_notes.plan_hint': 'Treatment plan, orders, follow-up...',
      'clinical_notes.title_field': 'Title',
      'clinical_notes.content_hint':
          'Clinical progress, observations, plan changes...',
      'clinical_notes.procedure_name': 'Procedure Name',
      'clinical_notes.procedure_details_hint': 'Technique, approach, steps...',
      'clinical_notes.findings_hint': 'Intra-procedural findings...',
      'clinical_notes.complications_hint': 'Any complications encountered...',
      'clinical_notes.required': 'Required',
      'clinical_notes.save_note': 'Save Note',
      'clinical_notes.created_success': 'Note created successfully',
      'clinical_notes.create_failed_prefix': 'Failed to create note:',
      // ── Payroll ───────────────────────────────────────────────────
      'payroll.payslip.title': 'My Payslips',
      'payroll.payslip.banner_tax': 'Annual Tax Summary (Form 16)',
      'payroll.payslip.banner_declaration': 'Tax Declaration (80C/80D)',
      'payroll.payslip.banner_queries': 'Payslip Queries',
      'payroll.payslip.empty_title': 'No payslips available yet',
      'payroll.payslip.empty_body':
          'Payslips are issued on the 5th of each month',
      'payroll.payslip.new_badge': 'NEW',
      'payroll.payslip.net_pay': 'Net Pay',
      'payroll.payslip.gross': 'Gross',
      'payroll.payslip.deductions': 'Deductions',
      'payroll.detail.title_prefix': 'Payslip',
      'payroll.detail.download_pdf': 'Download PDF',
      'payroll.detail.pdf_not_available':
          'PDF not available yet - check back later',
      'payroll.detail.pdf_failed_prefix': 'Failed to open PDF:',
      'payroll.detail.pdf_being_generated':
          'PDF payslip is being generated. It will appear here shortly.',
      'payroll.detail.pdf_download_button': 'Download PDF Payslip',
      'payroll.detail.opening': 'Opening...',
      'payroll.detail.not_found': 'Payslip not found',
      'payroll.detail.attendance_header': '📅 Attendance',
      'payroll.detail.earnings_header': '💰 Earnings',
      'payroll.detail.deductions_header': '📉 Deductions',
      'payroll.detail.working_days': 'Working Days',
      'payroll.detail.days_present': 'Days Present',
      'payroll.detail.days_absent': 'Days Absent',
      'payroll.detail.lop_days': 'Loss of Pay Days',
      'payroll.detail.leave_days': 'Leave Days',
      'payroll.detail.overtime_hours': 'Overtime Hours',
      'payroll.detail.basic': 'Basic Salary',
      'payroll.detail.hra': 'HRA',
      'payroll.detail.da': 'DA',
      'payroll.detail.special_allowance': 'Special Allowance',
      'payroll.detail.transport_allowance': 'Transport Allowance',
      'payroll.detail.medical_allowance': 'Medical Allowance',
      'payroll.detail.overtime_pay': 'Overtime Pay',
      'payroll.detail.bonus': 'Bonus',
      'payroll.detail.arrears': 'Arrears Paid',
      'payroll.detail.gross_salary': 'Gross Salary',
      'payroll.detail.lop_deduction': 'Loss of Pay',
      'payroll.detail.pf_employee': 'PF (Employee 12%)',
      'payroll.detail.esi': 'ESI (0.75%)',
      'payroll.detail.professional_tax': 'Professional Tax',
      'payroll.detail.tds': 'TDS',
      'payroll.detail.advance_deduction': 'Salary Advance Deduction',
      'payroll.detail.total_deductions': 'Total Deductions',
      'payroll.query.title': 'Payslip Queries',
      'payroll.query.tab_my': 'My Queries',
      'payroll.query.tab_raise': 'Raise Query',
      'payroll.query.empty': 'No queries raised yet',
      'payroll.query.replies_header': 'Replies',
      'payroll.query.raise_header': 'Raise a Payslip Query',
      'payroll.query.select_payslip': 'Select Payslip *',
      'payroll.query.choose_payslip_hint': 'Choose payslip',
      'payroll.query.category_label': 'Category *',
      'payroll.query.subject_label': 'Subject *',
      'payroll.query.subject_required': 'Subject is required',
      'payroll.query.description_label': 'Description *',
      'payroll.query.description_required': 'Description is required',
      'payroll.query.pick_payslip': 'Please select a payslip',
      'payroll.query.submit_button': 'Submit Query',
      'payroll.query.submitted_success': 'Query raised successfully!',
      'payroll.tax_summary.title': 'Annual Tax Summary',
      'payroll.tax_summary.fy_label': 'Financial Year:',
      'payroll.tax_summary.total_gross': 'Total Gross',
      'payroll.tax_summary.total_net': 'Total Net',
      'payroll.tax_summary.taxable_income': 'Taxable Income',
      'payroll.tax_summary.tax_payable': 'Tax Payable',
      'payroll.tax_summary.earnings_breakdown': '💰 Earnings Breakdown',
      'payroll.tax_summary.deductions_breakdown': '📉 Deductions Breakdown',
      'payroll.tax_summary.tax_computation': '🧾 Tax Computation (New Regime)',
      'payroll.tax_summary.standard_deduction': 'Less: Standard Deduction',
      'payroll.tax_summary.disclaimer':
          'This is indicative only, calculated under the New Tax Regime. Actual Form 16 will be issued by your employer at the end of the financial year.',
      'payroll.tax_summary.download_pdf': 'Download PDF',
      'payroll.tax_summary.download_form16': 'Download Form 16 PDF',
      'payroll.declaration.title': 'Tax Declaration (80C/80D)',
      'payroll.declaration.estimated_deductions': 'Estimated Tax Deductions',
      'payroll.declaration.total_deductions': 'Total Deductions',
      'payroll.declaration.section_80c': '80C Investments (Max ₹1,50,000)',
      'payroll.declaration.section_80d': '80D Health Insurance',
      'payroll.declaration.section_other': 'Other Deductions',
      'payroll.declaration.section_rent': 'HRA / Rent',
      'payroll.declaration.field_ppf': 'PPF',
      'payroll.declaration.field_epf': 'EPF Voluntary',
      'payroll.declaration.field_elss': 'ELSS (Mutual Funds)',
      'payroll.declaration.field_lic': 'LIC Premium',
      'payroll.declaration.field_nsc': 'NSC',
      'payroll.declaration.field_home_loan_principal': 'Home Loan Principal',
      'payroll.declaration.field_tuition': 'Tuition Fees (children)',
      'payroll.declaration.field_other_80c': 'Other 80C',
      'payroll.declaration.field_hi_self': 'Health Insurance - Self',
      'payroll.declaration.field_hi_parents': 'Health Insurance - Parents',
      'payroll.declaration.field_nps': 'NPS Contribution (80CCD)',
      'payroll.declaration.field_home_loan_interest':
          'Home Loan Interest (24b)',
      'payroll.declaration.field_edu_loan': 'Education Loan Interest (80E)',
      'payroll.declaration.field_rent_monthly': 'Monthly Rent Paid',
      'payroll.declaration.rent_receipts': 'Rent Receipts Provided',
      'payroll.declaration.submit_button': 'Submit Declaration',
      'payroll.declaration.submitted_success':
          'Declaration submitted successfully!',
      'payroll.declaration.past_title': 'Past Declarations',
      'payroll.declaration.fy_submitted': 'Submitted',
      // HR
      'hr.dashboard.title': 'HR Dashboard',
      'hr.timeframe.this_month': 'This Month',
      'hr.timeframe.last_month': 'Last Month',
      'hr.timeframe.this_quarter': 'This Quarter',
      'hr.timeframe.this_year': 'This Year',
      'hr.section.attendance_overview': 'Attendance Overview',
      'hr.section.leave_summary': 'Leave Summary',
      'hr.section.quick_actions': 'Quick Actions',
      'hr.stat.total_staff': 'Total Staff',
      'hr.stat.present_today': 'Present Today',
      'hr.stat.on_leave': 'On Leave',
      'hr.stat.pending_leaves': 'Pending Leaves',
      'hr.avg_attendance_rate': 'Avg. Attendance Rate',
      'hr.late_arrivals': 'Late Arrivals',
      'hr.absentees': 'Absentees',
      'hr.total_applications': 'Total Applications',
      'hr.approved': 'Approved',
      'hr.rejected': 'Rejected',
      'hr.pending_approval': 'Pending Approval',
      'hr.action.staff_management': 'Staff Management',
      'hr.action.staff_management.subtitle': 'View, add & edit staff',
      'hr.action.performance': 'Performance Reviews',
      'hr.action.performance.subtitle': 'Manage performance records',
      'hr.action.staff_directory': 'Staff Directory',
      'hr.action.staff_directory.subtitle': 'Browse all staff members',
      'hr.action.reports': 'Reports & Grievances',
      'hr.action.reports.subtitle': 'Incident reports, staff grievances',
      'hr.action.payslips': 'My Payslips',
      'hr.action.payslips.subtitle': 'View & download last 3 months',
      'staff_mgmt.title': 'Staff Management',
      'staff_mgmt.search_hint': 'Search by name, department, role...',
      'staff_mgmt.add_staff': 'Add Staff',
      'staff_mgmt.edit_staff': 'Edit Staff',
      'staff_mgmt.full_name': 'Full Name',
      'staff_mgmt.name_required': 'Name is required',
      'staff_mgmt.department': 'Department',
      'staff_mgmt.clear_filter': 'Remove filter',
      'staff_mgmt.active': 'Active',
      'staff_mgmt.inactive': 'Inactive',
      'staff_mgmt.no_staff_found': 'No staff found',
      'staff_mgmt.no_staff_members': 'No staff members',
      'staff_mgmt.search_empty': 'Try a different search term',
      'staff_mgmt.api_pending':
          'Staff data will appear here once the API is connected',
      'staff_mgmt.updated_success': '✅ Staff updated successfully',
      'staff_mgmt.added_pending': '✅ Staff added (backend API pending)',
      'staff_mgmt.list_api_unavailable':
          'Staff list API may not be available yet.',
      'performance.title': 'Performance Reviews',
      'performance.tab.add': 'Add Review',
      'performance.tab.reviews': 'Reviews',
      'performance.employee_id_label': 'Employee ID',
      'performance.employee_id_hint': 'e.g. EMP-001',
      'performance.employee_id_required': 'Employee ID is required',
      'performance.review_period_label': 'Review Period',
      'performance.overall_rating': 'Overall Rating',
      'performance.comments_label': 'Performance Comments',
      'performance.comments_hint':
          'Describe performance, achievements, areas of improvement...',
      'performance.comments_required': 'Comments are required',
      'performance.goals_label': 'Goals for Next Period (optional)',
      'performance.goals_hint': 'Set goals and expectations...',
      'performance.saving_button': 'Saving...',
      'performance.save_review': 'Save Review',
      'performance.saved_success': '✅ Performance review saved',
      'performance.rating.exceptional': 'Exceptional',
      'performance.rating.exceeds': 'Exceeds Expectations',
      'performance.rating.meets': 'Meets Expectations',
      'performance.rating.needs_improvement': 'Needs Improvement',
      'performance.rating.unsatisfactory': 'Unsatisfactory',
      'performance.no_reviews': 'No reviews yet',
      'directory.title': 'Staff Directory',
      'directory.search_hint': 'Search by name, dept, role...',
      'directory.empty': 'Directory is empty',
      'directory.search_empty': 'Try a different search term',
      'directory.api_pending':
          'Staff members will appear here once the API is connected',
      'directory.api_unavailable':
          'Staff directory API may not be available yet.',
      'directory.staff_empty_body': 'No staff found',
      // Reports & Grievances
      'reports.hub.title': 'Reports & Grievances',
      'reports.hub.confidentiality_note':
          'All reports are handled confidentially. Retaliation against reporters is strictly prohibited.',
      'reports.hub.prompt': 'What would you like to report?',
      'reports.hub.incident_title': 'Incident Report',
      'reports.hub.incident_subtitle':
          'Patient fall, medication error, near-miss, equipment failure, or any adverse event',
      'reports.hub.incident_note':
          'Sentinel/Severe events are escalated immediately',
      'reports.hub.grievance_title': 'Staff Grievance',
      'reports.hub.grievance_subtitle':
          'Harassment, unfair treatment, unsafe working conditions, or policy violations',
      'reports.hub.grievance_note': 'Can be submitted anonymously. HR only.',
      'reports.hub.my_reports': 'My Reports & Status',
      'my_reports.title': 'My Reports',
      'my_reports.tab.incidents': 'Incidents',
      'my_reports.tab.grievances': 'Grievances',
      'my_reports.empty_incidents': 'No incident reports',
      'my_reports.empty_grievances': 'No grievances filed',
      'my_reports.label.status': 'Status',
      'my_reports.label.severity': 'Severity',
      'my_reports.label.type': 'Type',
      'my_reports.label.location': 'Location',
      'my_reports.label.description': 'Description',
      'incident_report.title': 'Incident Report',
      'incident_report.severity_label': 'Severity *',
      'incident_report.severity.low': 'Low',
      'incident_report.severity.low_desc': 'Minor, no harm caused',
      'incident_report.severity.moderate': 'Moderate',
      'incident_report.severity.moderate_desc': 'Some impact, managed locally',
      'incident_report.severity.severe': 'Severe',
      'incident_report.severity.severe_desc':
          'Significant harm, requires investigation',
      'incident_report.severity.sentinel': 'Sentinel',
      'incident_report.severity.sentinel_desc':
          'Unexpected death or serious harm',
      'incident_report.type_label': 'Incident Type *',
      'incident_report.type.near_miss': 'Near Miss',
      'incident_report.type.patient_fall': 'Patient Fall',
      'incident_report.type.medication_error': 'Medication Error',
      'incident_report.type.needle_stick': 'Needle Stick / Sharps Injury',
      'incident_report.type.equipment_failure': 'Equipment Failure',
      'incident_report.type.infection': 'Infection / Exposure',
      'incident_report.type.fire_safety': 'Fire / Safety Hazard',
      'incident_report.type.patient_aggression': 'Patient Aggression',
      'incident_report.type.security_breach': 'Security Breach',
      'incident_report.type.other': 'Other',
      'incident_report.title_label': 'Brief Title *',
      'incident_report.title_hint': 'e.g. Patient fell near bed 12B',
      'incident_report.title_required': 'Title is required',
      'incident_report.what_happened': 'What happened? *',
      'incident_report.what_happened_hint':
          'Describe the incident in detail - what happened, who was involved, what the conditions were...',
      'incident_report.description_required': 'Description is required',
      'incident_report.date_label': 'Date *',
      'incident_report.time_label': 'Time *',
      'incident_report.location_label': 'Location (optional)',
      'incident_report.location_hint': 'Ward, room, or area',
      'incident_report.patient_involved': 'Patient Involved',
      'incident_report.patient_name_label': 'Patient Name / ID (optional)',
      'incident_report.witnesses_label': 'Witnesses (optional)',
      'incident_report.witnesses_hint': 'Names of anyone who saw the incident',
      'incident_report.immediate_action': 'Immediate Action Taken (optional)',
      'incident_report.immediate_action_hint':
          'What was done right after the incident?',
      'incident_report.anonymous': 'Submit Anonymously',
      'incident_report.anonymous_note':
          'Your name will not be attached to this report',
      'incident_report.submit_button': 'Submit Incident Report',
      'incident_report.submitted_title': 'Report Submitted',
      'incident_report.escalation_note':
          'This has been escalated as HIGH PRIORITY. Management has been notified.',
      'incident_report.routine_note':
          'Your report has been received and will be reviewed within 24 hours.',
      'incident_report.done_button': 'Done',
      'grievance.title': 'Staff Grievance',
      'grievance.privacy_note':
          'This form is seen only by HR and senior management. You may submit anonymously.',
      'grievance.type_label': 'Grievance Type *',
      'grievance.type.harassment': 'Harassment',
      'grievance.type.discrimination': 'Discrimination',
      'grievance.type.unfair_treatment': 'Unfair Treatment',
      'grievance.type.unsafe_conditions': 'Unsafe Working Conditions',
      'grievance.type.workload': 'Excessive Workload',
      'grievance.type.pay_dispute': 'Pay / Compensation Dispute',
      'grievance.type.schedule_conflict': 'Schedule / Roster Conflict',
      'grievance.type.policy_violation': 'Policy Violation',
      'grievance.type.other': 'Other',
      'grievance.subject_label': 'Subject *',
      'grievance.subject_hint': 'Brief summary of your concern',
      'grievance.subject_required': 'Subject is required',
      'grievance.describe_label': 'Describe your grievance *',
      'grievance.describe_hint':
          'Please provide as much detail as you feel comfortable sharing...',
      'grievance.description_required': 'Description is required',
      'grievance.against_whom_label': 'Against whom (optional)',
      'grievance.against_whom_hint': 'Name or role, if applicable',
      'grievance.dept_label': 'Department (optional)',
      'grievance.date_optional': 'When did this occur? (optional)',
      'grievance.date_prefix': 'When did this occur:',
      'grievance.anonymous': 'Submit Anonymously',
      'grievance.anonymous_note': 'Your identity will not be disclosed',
      'grievance.submit_button': 'Submit Grievance',
      'grievance.submitted_title': 'Grievance Submitted',
      'grievance.acknowledgement_note':
          'Your grievance has been received. HR will acknowledge within 2 working days.',
      'grievance.acknowledgement_anonymous':
          'Submitted anonymously. HR will acknowledge within 2 working days.',
      // Housekeeping
      'housekeeping.hub.title': 'Housekeeping',
      'housekeeping.hub.log_title': 'Log Cleaning',
      'housekeeping.hub.log_subtitle':
          'Record completed cleaning with photo evidence',
      'housekeeping.hub.raise_title': 'Raise Request',
      'housekeeping.hub.raise_subtitle':
          'Report a dirty area or request cleaning',
      'housekeeping.hub.my_title': 'My Activity',
      'housekeeping.hub.my_subtitle':
          'View your logs, assigned tasks, and requests',
      'housekeeping.log.title': 'Log Cleaning',
      'housekeeping.log.type_label': 'Cleaning Type *',
      'housekeeping.type.routine': 'Routine Cleaning',
      'housekeeping.type.deep': 'Deep Cleaning',
      'housekeeping.type.disinfection': 'Disinfection',
      'housekeeping.type.spillage': 'Spillage Clean-up',
      'housekeeping.type.post_procedure': 'Post-Procedure',
      'housekeeping.zone_location_label': 'Zone / Location *',
      'housekeeping.select_zone_label': 'Select Zone (optional)',
      'housekeeping.select_zone_or_type': '-- Select or type below --',
      'housekeeping.describe_location': 'Or describe exact location',
      'housekeeping.location_hint': 'e.g. Room 204, Corridor near lift',
      'housekeeping.photo_evidence': 'Photo Evidence',
      'housekeeping.take_photo': 'Tap to take photo',
      'housekeeping.notes_label': 'Notes (optional)',
      'housekeeping.submit_log': 'Submit Cleaning Log',
      'housekeeping.submitting_log': 'Submitting...',
      'housekeeping.select_zone_error': 'Select a zone or enter location',
      'housekeeping.logged_title': 'Cleaning Logged',
      'housekeeping.logged_body':
          'Your cleaning record has been signed and submitted.',
      'housekeeping.done_button': 'Done',
      'housekeeping.raise.title': 'Raise Request',
      'housekeeping.raise.type_label': 'Request Type *',
      'housekeeping.raise.urgency_label': 'Urgency *',
      'housekeeping.request_type.cleaning': 'General Cleaning',
      'housekeeping.request_type.spillage': 'Spillage / Spill',
      'housekeeping.request_type.waste': 'Waste Disposal',
      'housekeeping.request_type.linen': 'Linen / Bedding',
      'housekeeping.request_type.disinfection': 'Disinfection',
      'housekeeping.request_type.other': 'Other',
      'housekeeping.description_label': 'Description (optional)',
      'housekeeping.description_hint': 'What needs attention?',
      'housekeeping.problem_photo': 'Photo of Problem (optional)',
      'housekeeping.photograph_problem': 'Tap to photograph the problem',
      'housekeeping.raise_request_button': 'Raise Request',
      'housekeeping.raising_button': 'Raising...',
      'housekeeping.raised_title': 'Request Raised',
      'housekeeping.notified_note': 'Housekeeping staff will be notified.',
      'housekeeping.my.title': 'My Activity',
      'housekeeping.my.tab_logs': 'My Logs',
      'housekeeping.my.tab_requests': 'Requests',
      'housekeeping.my.tab_raised': 'Raised by me',
      'housekeeping.my.tab_assigned': 'Assigned to me',
      'housekeeping.no_logs': 'No cleaning logs yet',
      'housekeeping.no_requests': 'No requests here',
      'housekeeping.unknown_location': 'Unknown location',
      'housekeeping.mark_complete': 'Mark Complete',
      'housekeeping.complete_dialog_title': 'Mark as Complete',
      'housekeeping.completion_notes': 'Completion notes (optional)',
      'housekeeping.add_completion_photo': 'Add completion photo',
      'housekeeping.marked_complete': '✅ Request marked as completed',
      'housekeeping.status.verified': 'VERIFIED',
      'housekeeping.status.flagged': 'FLAGGED',
      'housekeeping.status.submitted': 'SUBMITTED',
      // Hospital departments
      'blood_bank.title': 'Blood Bank',
      'blood_bank.tab.inventory': 'Inventory',
      'blood_bank.tab.requests': 'Requests',
      'blood_bank.tab.donations': 'Donations',
      'blood_bank.refresh_tooltip': 'Refresh inventory',
      'blood_bank.legend.adequate': '>= 10 units',
      'blood_bank.legend.low': '5-9 units',
      'blood_bank.legend.critical': '< 5 units',
      'blood_bank.units_suffix': 'units',
      'blood_bank.stock.critical_low': 'Critical low',
      'blood_bank.stock.low': 'Low stock',
      'blood_bank.stock.adequate': 'Adequate',
      'blood_bank.request_header': 'Request Blood',
      'blood_bank.patient_name_label': 'Patient Name',
      'blood_bank.patient_name_required': 'Patient name is required',
      'blood_bank.blood_type_label': 'Blood Type',
      'blood_bank.blood_type_required': 'Select blood type',
      'blood_bank.units_label': 'Units Required',
      'blood_bank.units_required': 'Units required',
      'blood_bank.units_invalid': 'Enter a valid number',
      'blood_bank.reason_label': 'Reason / Notes',
      'blood_bank.submit_request': 'Submit Request',
      'blood_bank.submitting_button': 'Submitting...',
      'blood_bank.request_success': 'Blood request submitted successfully',
      'blood_bank.donations.title': 'Donation Records',
      'blood_bank.donations.body':
          'View and manage blood donation records.\nThis section will display donation history and upcoming donation drives.',
      'dietary.title': 'Dietary Management',
      'dietary.refresh_tooltip': 'Refresh worklist',
      'dietary.new_order_button': 'New Order',
      'dietary.new_order_dialog': 'New Dietary Order',
      'dietary.patient_uid_label': 'Patient UID',
      'dietary.patient_uid_required': 'Required',
      'dietary.diet_type_label': 'Diet Type',
      'dietary.diet_type_required': 'Select diet type',
      'dietary.meal_time_label': 'Meal Time',
      'dietary.meal_time_required': 'Select meal time',
      'dietary.restrictions_label': 'Restrictions / Allergies',
      'dietary.notes_label': 'Notes',
      'dietary.create_button': 'Create',
      'dietary.created_success': 'Dietary order created',
      'dietary.discontinued_success': 'Diet order discontinued',
      'dietary.discontinue': 'Discontinue',
      'dietary.diet.regular': 'Regular',
      'dietary.diet.diabetic': 'Diabetic',
      'dietary.diet.cardiac': 'Cardiac',
      'dietary.diet.renal': 'Renal',
      'dietary.diet.soft': 'Soft',
      'dietary.diet.liquid': 'Liquid',
      'dietary.diet.npo': 'NPO',
      'dietary.diet.enteral': 'Enteral',
      'dietary.meal.breakfast': 'Breakfast',
      'dietary.meal.lunch': 'Lunch',
      'dietary.meal.dinner': 'Dinner',
      'dietary.meal.snack': 'Snack',
      'dietary.empty_title': 'No dietary orders',
      'dietary.empty_body': 'Tap the button below to create a new order',
      'theatre.title': 'Operating Theatre',
      'theatre.pick_date': 'Pick date',
      'theatre.tab.schedule': 'Schedule',
      'theatre.tab.availability': 'Availability',
      'theatre.no_surgeries': 'No surgeries scheduled',
      'theatre.no_room_data': 'No room data available',
      'theatre.status.scheduled': 'Scheduled',
      'theatre.status.in_progress': 'In Progress',
      'theatre.status.completed': 'Completed',
      'theatre.status.cancelled': 'Cancelled',
      'theatre.surgeon_prefix': 'Surgeon:',
      'theatre.label.patient_uid': 'Patient UID',
      'theatre.label.procedure_code': 'Procedure Code',
      'theatre.label.ot_room': 'OT Room',
      'theatre.label.date': 'Date',
      'theatre.label.time': 'Time',
      'theatre.label.duration': 'Duration',
      'theatre.label.surgeon': 'Surgeon',
      'theatre.label.anesthetist': 'Anesthetist',
      'theatre.label.status': 'Status',
      'theatre.label.blood_arranged': 'Blood Arranged',
      'theatre.label.consent': 'Consent',
      'theatre.label.equipment': 'Equipment',
      'theatre.start_surgery': 'Start Surgery',
      'theatre.mark_complete': 'Mark Complete',
      'theatre.cancel_button': 'Cancel',
      'theatre.preop_checklist': 'Pre-op Checklist',
      'theatre.checklist.consent': 'Consent Obtained',
      'theatre.checklist.blood': 'Blood Arranged',
      'theatre.checklist.equipment': 'Equipment Checked',
      'theatre.checklist.patient_id': 'Patient Identified',
      'theatre.submit_checklist': 'Submit Checklist',
      'theatre.checklist_updated': 'Checklist updated',
      'theatre.status_updated_to': 'Status updated to',
      'theatre.yes': 'Yes',
      'theatre.no': 'No',
      'theatre.available': 'Available',
      'theatre.occupied': 'Occupied',
      'radiology.title': 'Radiology',
      'radiology.filters_tooltip': 'Filters',
      'radiology.filters_header': 'Filters',
      'radiology.status_label': 'Status',
      'radiology.modality_label': 'Modality',
      'radiology.status.all': 'All',
      'radiology.status.pending': 'Pending',
      'radiology.status.in_progress': 'In Progress',
      'radiology.status.completed': 'Completed',
      'radiology.status.cancelled': 'Cancelled',
      'radiology.no_orders': 'No radiology orders',
      'radiology.label.study_type': 'Study Type',
      'radiology.label.modality': 'Modality',
      'radiology.label.body_part': 'Body Part',
      'radiology.label.priority': 'Priority',
      'radiology.label.clinical_indication': 'Clinical Indication',
      'radiology.label.notes': 'Notes',
      'radiology.label.report': 'Report',
      'radiology.label.findings': 'Findings',
      'radiology.label.impression': 'Impression',
      'radiology.submit_report': 'Submit Report',
      'radiology.cancel_order': 'Cancel Order',
      'radiology.findings_required': 'Findings are required',
      'radiology.report_submitted': 'Report submitted',
      'radiology.order_cancelled': 'Order cancelled',
      'schedule.title': 'Shift Schedule',
      'schedule.prev_week': 'Previous week',
      'schedule.next_week': 'Next week',
      'schedule.week_this': 'This Week',
      'schedule.week_next': 'Next Week',
      'schedule.week_last': 'Last Week',
      'schedule.total_label': 'Total',
      'schedule.days_logged': 'days logged',
      'schedule.hours_worked_suffix': 'h worked',
      'schedule.upcoming': 'Upcoming',
      'schedule.no_record': 'No record',
      'schedule.load_failed_prefix': 'Could not load schedule:',
      // Lab / Pharmacy / Investigations
      'investigations.title': 'Investigations',
      'investigations.tab.upload': 'Upload Result',
      'investigations.tab.pending': 'Pending',
      'investigations.tab.recent': 'Recent',
      'investigations.upload_intro':
          'Search patient by phone number and upload their investigation results.',
      'investigations.phone_label': 'Patient Phone Number',
      'investigations.phone_hint': '+91 XXXXX XXXXX',
      'investigations.phone_required': 'Phone is required',
      'investigations.phone_invalid': 'Enter valid phone number',
      'investigations.test_type_label': 'Test Type',
      'investigations.test_type_required': 'Select test type',
      'investigations.result_label': 'Result / Summary',
      'investigations.result_hint': 'Enter test results or summary...',
      'investigations.clinical_notes_label': 'Clinical Notes (optional)',
      'investigations.clinical_notes_hint': 'Additional observations...',
      'investigations.attach_report': 'Attach Report File (optional)',
      'investigations.clear_file': 'Clear',
      'investigations.file_too_large': 'File too large. Maximum size is 10 MB.',
      'investigations.file_pick_failed': 'Failed to pick file',
      'investigations.uploading': 'Uploading...',
      'investigations.upload_button': 'Upload Investigation',
      'investigations.upload_success':
          '✅ Investigation result uploaded successfully',
      'investigations.pending_empty': 'No pending investigations',
      'investigations.pending_empty_body': 'All caught up!',
      'investigations.recent_empty': 'No recent investigations',
      'investigations.recent_empty_body':
          'Your investigation uploads will appear here',
      'investigations.start_button': 'Start',
      'investigations.complete_button': 'Complete',
      'investigations.marked_as_prefix': '✅ Investigation marked as',
      'lab_bookings.title': 'Lab Bookings',
      'lab_bookings.tab.new': 'New',
      'lab_bookings.tab.active': 'Active',
      'lab_bookings.tab.done': 'Done',
      'lab_bookings.empty_prefix': 'No bookings',
      'lab_bookings.view_slip': 'View Prescription Slip',
      'lab_bookings.home_collection': 'Home',
      'lab_bookings.walk_in': 'Walk-in',
      'lab_bookings.confirm_dialog': 'Confirm Booking',
      'lab_bookings.actual_tests_label': 'Actual Tests (if different)',
      'lab_bookings.actual_tests_hint': 'Verify/add test names',
      'lab_bookings.final_cost_label': 'Final Cost (₹)',
      'lab_bookings.confirm_button': 'Confirm',
      'lab_bookings.confirmed_toast': 'Booking confirmed',
      'lab_bookings.dispatch_dialog': 'Dispatch Collector',
      'lab_bookings.collector_phone': 'Collector Phone',
      'lab_bookings.dispatch_button': 'Dispatch',
      'lab_bookings.dispatched_toast': 'Collector dispatched',
      'lab_bookings.sharing_location': '📍 Sharing location...',
      'lab_bookings.mark_collected': 'Mark Collected',
      'lab_bookings.samples_collected_toast': 'Samples collected',
      'lab_bookings.start_processing': 'Start Processing',
      'lab_bookings.processing_started_toast': 'Processing started',
      'lab_bookings.upload_result': 'Upload Result',
      'lab_bookings.select_file': 'Select File',
      'lab_bookings.result_uploaded_toast': 'Result uploaded',
      'lab_bookings.view_result': 'View Result',
      'pharmacy.title': 'Pharmacy Orders',
      'pharmacy.queue_title': 'Pharmacy Queue',
      'pharmacy.queue_subtitle': 'orders queued',
      'pharmacy.tab.new': 'New',
      'pharmacy.tab.active': 'Active',
      'pharmacy.tab.done': 'Done',
      'pharmacy.empty.new': 'No new orders',
      'pharmacy.empty.active': 'No active orders',
      'pharmacy.empty.done': 'No completed orders',
      'pharmacy.confirm_dialog': 'Confirm Order',
      'pharmacy.patient_note_prefix': 'Patient Note:',
      'pharmacy.items_label': 'Items (one per line: name, qty, price)',
      'pharmacy.items_hint': 'Dolo 650, 2, 60\nPan 40, 1, 95',
      'pharmacy.total_cost_label': 'Total Cost (₹)',
      'pharmacy.confirm_order': 'Confirm Order',
      'pharmacy.view_confirm': 'View & Confirm',
      'pharmacy.start_preparing': 'Start Preparing',
      'pharmacy.dispatch': 'Dispatch',
      'pharmacy.mark_delivered': 'Mark Delivered',
      'pharmacy.dispatch_dialog': 'Dispatch Order',
      'pharmacy.delivery_person_name': 'Delivery Person Name',
      'pharmacy.delivery_person_phone': 'Delivery Person Phone',
      'pharmacy.mark_delivered_dialog': 'Mark Delivered?',
      'pharmacy.mark_delivered_yes': 'Yes, Delivered',
      'pharmacy.cancel_dialog': 'Cancel Order?',
      'pharmacy.cancellation_reason': 'Reason for cancellation',
      'pharmacy.delivery_type.pickup': 'Pickup',
      'pharmacy.delivery_type.delivery': 'Delivery',
      'pharmacy.order_confirmed_toast': 'Order confirmed',
      'pharmacy.mark_preparing_toast': 'Marked as preparing',
      'pharmacy.order_dispatched_toast': 'Order dispatched',
      'pharmacy.order_delivered_toast': 'Marked as delivered',
      'pharmacy.order_cancelled_toast': 'Order cancelled',
      'pharmacy.status.placed': 'Placed',
      'pharmacy.status.confirmed': 'Confirmed',
      'pharmacy.status.preparing': 'Preparing',
      'pharmacy.status.dispatched': 'Dispatched',
      'pharmacy.status.delivered': 'Delivered',
      'pharmacy.status.cancelled': 'Cancelled',
      // Nursing
      'due_meds.title': 'Due Medications',
      'due_meds.search_hint': 'Search by patient or medication…',
      'due_meds.empty_title': 'No medications due',
      'due_meds.empty_body': 'Tap a bed on the bed board to record vitals.',
      'due_meds.held_badge': 'HELD',
      'due_meds.unknown_patient': 'Unknown patient',
      'due_meds.unnamed_medication': '(unnamed medication)',
      'mar_scan.title': 'Administer Medication',
      'mar_scan.step1_prompt': 'Step 1 of 3 - Scan patient wristband',
      'mar_scan.step1_subtitle':
          "Point the camera at the QR code on the patient's wristband.",
      'mar_scan.step2_prompt': 'Step 2 of 3 - Scan drug barcode',
      'mar_scan.step2_subtitle':
          'Now scan the barcode on the medication label.',
      'mar_scan.step3_header': 'Step 3 of 3 - 5-rights check',
      'mar_scan.right_patient': 'Right patient',
      'mar_scan.right_drug': 'Right drug',
      'mar_scan.right_dose': 'Right dose',
      'mar_scan.right_route': 'Right route',
      'mar_scan.right_time': 'Right time',
      'mar_scan.recording': 'Recording…',
      'mar_scan.administer': 'Administer',
      'mar_scan.check_failed': '5-rights check failed',
      'mar_scan.override_hint':
          'To record this administration, document the reason. This entry is audited.',
      'mar_scan.override_reason_label':
          'Override reason (required, min 5 chars)',
      'mar_scan.override_button': 'Override & administer',
      'mar_scan.recorded': 'Administration recorded',
      'mar_scan.scan_next': 'Scan next dose',
      'mar_scan.scan_again': 'Scan again',
      'mar_scan.try_again': 'Try again',
      'mar_scan.unknown_medication': '(unknown medication)',
      // Discharge Summary
      'discharge.title_prefix': 'Discharge —',
      'discharge.save_draft': 'Save Draft',
      'discharge.draft_saved': 'Draft saved',
      'discharge.sign_summary': 'Sign Summary',
      'discharge.sign_dialog_title': 'Sign Discharge Summary',
      'discharge.sign_dialog_body':
          'Once signed, this discharge summary becomes the official record and cannot be modified (only addenda are allowed).\n\nAre you sure you want to sign?',
      'discharge.sign_button': 'Sign',
      'discharge.signed_success': 'Discharge summary signed - now official',
      'discharge.signed_badge':
          'Signed - This summary is now official and immutable',
      'discharge.proceed_title': 'Confirm Discharge',
      'discharge.proceed_body_prefix': 'Discharge',
      'discharge.proceed_button': 'Discharge',
      'discharge.must_sign_first':
          'Discharge summary must be signed by a doctor first',
      'discharge.patient_discharged': 'Patient discharged successfully',
      'discharge.patient_button': 'Discharge Patient',
      'discharge.generate_title': 'Generate Discharge Summary',
      'discharge.generate_body':
          'This will automatically aggregate all ward notes, vitals, investigations, medications, and diagnoses from this admission into a structured discharge summary.',
      'discharge.generate_button': 'Generate Summary',
      'discharge.generating': 'Generating...',
      'discharge.regenerate': 'Regenerate Summary',
      'discharge.section.hospital_course': 'Hospital Course',
      'discharge.section.diagnosis': 'Discharge Diagnosis',
      'discharge.section.condition': 'Discharge Condition',
      'discharge.section.follow_up': 'Follow-up Instructions',
      'discharge.section.activity': 'Activity Restrictions',
      'discharge.section.diet': 'Diet Instructions',
      'discharge.section.warning_signs': 'Warning Signs',
      'discharge.section.medications': 'Medications on Discharge',
      'discharge.section.investigations': 'Investigations',
      'discharge.section.procedures': 'Procedures Performed',
      // Attendance dispute / overtime
      'dispute.title': 'Attendance Dispute',
      'dispute.tab.submit': 'Submit',
      'dispute.tab.my': 'My Disputes',
      'dispute.intro':
          'Use this to report attendance recording issues. HR will review and correct your record.',
      'dispute.date_label': 'Date',
      'dispute.select_date': 'Select date of issue',
      'dispute.issue_type_label': 'Issue Type',
      'dispute.type.missed_checkin': 'Missed Check-in',
      'dispute.type.missed_checkout': 'Missed Check-out',
      'dispute.type.wrong_time': 'Wrong Time Recorded',
      'dispute.type.app_failure': 'App/Network Failure',
      'dispute.type.other': 'Other',
      'dispute.description_label': 'Description',
      'dispute.description_hint': 'Explain what happened...',
      'dispute.correct_times': 'Correct Times (Optional)',
      'dispute.correct_times_hint':
          'If you know what the correct times should be, enter them here.',
      'dispute.check_in': 'Check-in',
      'dispute.check_out': 'Check-out',
      'dispute.required_error': 'Date and description are required',
      'dispute.submit_button': 'Submit Dispute',
      'dispute.submitted_success':
          '✅ Dispute submitted. HR will review within 24 hours.',
      'dispute.empty': 'No disputes filed',
      'dispute.hr_comment_prefix': 'HR:',
      'overtime.title': 'Overtime Requests',
      'overtime.tab.request': 'Request',
      'overtime.tab.my': 'My Requests',
      'overtime.extra_hours_label': 'Extra Hours',
      'overtime.hours_suffix': 'hrs',
      'overtime.type_label': 'Type',
      'overtime.type.comp_time': 'Compensatory Time Off',
      'overtime.type.payment': 'Overtime Payment',
      'overtime.reason_label': 'Reason',
      'overtime.reason_hint': 'Why did you work overtime?',
      'overtime.required_error': 'Date and reason required',
      'overtime.submit_button': 'Submit Overtime Request',
      'overtime.submitted_success': '✅ Overtime request submitted',
      'overtime.empty': 'No overtime requests',
      'overtime.rejected_prefix': 'Rejected:',
      // Telemedicine
      'telemedicine.title_prefix': 'Video Call —',
      'telemedicine.sdk_missing_title': 'Video SDK not yet integrated',
      'telemedicine.sdk_missing_body':
          'Add agora_rtc_engine or flutter_webrtc to enable.',
      'telemedicine.mute': 'Mute',
      'telemedicine.unmute': 'Unmute',
      'telemedicine.camera_off': 'Camera Off',
      'telemedicine.camera_on': 'Camera On',
      'telemedicine.end_call': 'End Call',
      // Clinical AI
      'clinical_ai.queue.title': 'AI Review Queue',
      'clinical_ai.queue.compose_button': 'Compose runs',
      'clinical_ai.queue.voice_notes_button': 'Voice notes',
      'clinical_ai.queue.filter.pending': 'Pending',
      'clinical_ai.queue.filter.accepted': 'Accepted',
      'clinical_ai.queue.filter.edited': 'Edited',
      'clinical_ai.queue.filter.rejected': 'Rejected',
      'clinical_ai.queue.filter.all': 'All',
      'clinical_ai.queue.empty_title': 'No drafts in this filter',
      'clinical_ai.queue.empty_body':
          'When a clinical AI draft is generated for an admission you reviewer-cover, it will appear here.',
      'clinical_ai.queue.load_failed': 'Failed to load reviews',
      'clinical_ai.queue.patient_fallback': 'Patient',
      'clinical_ai.draft.reject_title': 'Reject draft',
      'clinical_ai.draft.reject_reason_label': 'Reason',
      'clinical_ai.draft.reject_reason_hint': 'Why is this draft unsuitable?',
      'clinical_ai.draft.reject_button': 'Reject',
      'clinical_ai.draft.reviewer_note_title': 'Reviewer note',
      'clinical_ai.draft.reviewer_note_label': 'Note',
      'clinical_ai.draft.reviewer_note_hint':
          'One sentence confirming what you checked before accepting.',
      'clinical_ai.draft.reviewer_note_button': 'Accept with note',
      'clinical_ai.draft.reviewer_note_min_chars':
          'Reviewer note must be at least 3 words.',
      'clinical_ai.draft.review_not_found': 'Review not found.',
      'clinical_ai.draft.invalid_json': 'Edited draft is not valid JSON.',
      'clinical_ai.draft.accept': 'Accept',
      'clinical_ai.draft.accept_edits': 'Accept edits',
      'clinical_ai.draft.needs_revision': 'Needs revision',
      'clinical_ai.draft.decision_recorded': 'Draft decision recorded',
      'clinical_ai.draft.no_safety_flags': 'No safety flags raised.',
      'clinical_ai.draft.screen_title': 'AI Draft Review',
      'clinical_ai.draft.critical_title': 'Critical safety flags',
      'clinical_ai.draft.safety_header': 'Safety flags',
      'clinical_ai.draft.body_header': 'Draft',
      'clinical_ai.draft.edit_header': 'Edit draft (JSON)',
      'clinical_ai.draft.edit_button': 'Edit',
      'clinical_ai.draft.cancel_edit_button': 'Cancel edit',
      'clinical_ai.draft.failed_load': 'Failed to load draft',
      'clinical_ai.draft.patient_prefix': 'Patient:',
      'clinical_ai.draft.admission_prefix': 'Admission:',
      'clinical_ai.draft.status_prefix': 'Status:',
      'clinical_ai.draft.provider_prefix': 'Provider:',
      'clinical_ai.draft.decided_prefix': 'Draft',
      'clinical_ai.draft.decision_failed_prefix': 'Failed to record decision:',
      'clinical_ai.compose_runs.title': 'Compose Runs',
      'clinical_ai.compose_runs.empty': 'No compose runs in this view.',
      'clinical_ai.compose_runs.filter.active': 'Active',
      'clinical_ai.compose_runs.filter.paused': 'Paused',
      'clinical_ai.compose_runs.filter.completed': 'Completed',
      'clinical_ai.compose_runs.filter.failed': 'Failed',
      'clinical_ai.compose_runs.filter.all': 'All',
      'clinical_ai.compose_runs.review_prefix': 'review:',
      'clinical_ai.compose_runs.started_prefix': 'started',
      'clinical_ai.compose_runs.run_prefix': 'Run',
      'clinical_ai.compose_runs.admission_word': 'admission',
      'clinical_ai.compose_run.not_found': 'Run not found.',
      'clinical_ai.compose_run.resumed': 'Compose resumed.',
      'clinical_ai.compose_run.open_in_queue': 'Open in review queue',
      'clinical_ai.compose_run.detail_title_prefix': 'Compose run',
      'clinical_ai.compose_run.admission_header_prefix': 'Admission',
      'clinical_ai.compose_run.subgraphs': 'Subgraphs',
      'clinical_ai.compose_run.no_subgraphs': 'No subgraph runs.',
      'clinical_ai.compose_run.paused_prefix': 'Paused:',
      'clinical_ai.compose_run.review_status_key': 'Review status',
      'clinical_ai.compose_run.started_key': 'Started',
      'clinical_ai.compose_run.finished_key': 'Finished',
      'clinical_ai.compose_run.resume_button': 'Resume compose',
      'clinical_ai.compose_run.resuming_button': 'Resuming...',
      'clinical_ai.compose_run.resume_failed_prefix': 'Resume failed:',
      'clinical_ai.compose_run.critical_word': 'critical',
      'clinical_ai.compose_run.high_word': 'high',
      'clinical_ai.voice_notes.empty': 'No voice notes yet.',
      'clinical_ai.voice_notes.soap_generated':
          'SOAP draft generated; opening review queue.',
      'clinical_ai.voice_notes.title': 'Voice notes',
      'clinical_ai.voice_notes.empty_subtitle':
          'Record a voice note from the desktop client; it will appear here for SOAP drafting.',
      'clinical_ai.voice_notes.note_prefix': 'Voice note',
      'clinical_ai.voice_notes.patient_prefix': 'Patient:',
      'clinical_ai.voice_notes.draft_exists': 'SOAP draft already generated',
      'clinical_ai.voice_notes.generate_soap': 'Generate SOAP draft',
      'clinical_ai.voice_notes.drafting': 'Drafting...',
      'clinical_ai.voice_notes.generation_failed_prefix':
          'SOAP generation failed:',
      // AI Assist (clinical-notes patient explainer)
      'ai_assist.title': 'AI Assist',
      'ai_assist.generate_blurb':
          'Generate a plain-language patient explainer of this note. Draft will land in your review queue for sign-off before reaching the patient.',
      'ai_assist.generate_button': 'Generate patient explainer',
      'ai_assist.note_too_short':
          'Note is too short to generate a patient explainer (need at least 30 characters of content).',
      'ai_assist.generating': 'Generating patient explainer…',
      'ai_assist.failed_prefix': 'AI Assist failed:',
      'ai_assist.cannot_sign':
          'Cannot sign - review row was not created (schema may be unavailable).',
      'ai_assist.reject_title': 'Reject draft?',
      'ai_assist.reject_prompt':
          'Why is this draft not suitable for patient delivery?',
      'ai_assist.reject_min_chars':
          'Rejection reason must be at least 5 characters.',
      'ai_assist.reject_hint': 'e.g. clinical inaccuracy in next-steps section',
      'ai_assist.drawer_title': 'AI Patient Explainer',
      'ai_assist.fallback_banner':
          'The model returned no parseable draft; a fallback shape is shown. Re-generate after checking provider config.',
      'ai_assist.key_points': 'Key points',
      'ai_assist.next_steps': 'Next steps',
      'ai_assist.when_to_seek_help': 'When to seek help',
      'ai_assist.needs_edits': 'Needs edits',
      'ai_assist.accept_sign': 'Accept & sign',
      'ai_assist.summary': 'Summary',
      'ai_assist.empty': '(empty)',
      'ai_assist.decision_prefix': 'Patient explainer',
      'ai_assist.sign_failed_prefix': 'Sign-off failed:',
      // CDS blocker modal - clinical-safety hard block
      'cds.blocker_title': 'Prescription blocked',
      'cds.blocker_body':
          'Clinical decision support flagged the following issues. '
          'Cancel to revise the prescription, or override with a documented reason.',
      'cds.warnings_header': 'Warnings',
      'cds.allergy_hint':
          'Allergy conflict: reference the supervising physician who approved '
          'this override in your reason.',
      'cds.override_reason_label': 'Override reason (required, min 5 chars)',
      'cds.override_button': 'Override',
      'cds.override_save': 'Override & save',
      // Code Blue - emergency overlay
      'code_blue.title': 'CODE BLUE',
      'code_blue.respond': 'Respond immediately.',
      'code_blue.ward_prefix': 'Ward:',
      'code_blue.bed_prefix': 'Bed:',
      'code_blue.patient_prefix': 'Patient ID:',
      'code_blue.acknowledge': 'ACKNOWLEDGED',
      // First-run welcome card
      'first_run.welcome_title': 'A few shortcuts worth knowing',
      'first_run.welcome_dismiss': 'Dismiss',
      'first_run.welcome_got_it': 'Got it',
      'first_run.tip_bed_tap':
          'Tap a bed card on the Bed Board for patient details + quick actions.',
      'first_run.tip_bed_long_press':
          'Long-press a bed card to edit its notes inline (no full sheet).',
      'first_run.tip_magnifier_prefix':
          'Use the magnifier in any header - or press',
      'first_run.tip_magnifier_suffix': '+K - to jump to any patient\'s chart.',
      'first_run.tip_dashboard':
          'The cards above each route to where you can act on them - tap "Due Meds", "Inpatients", etc.',
      // Splash / device integrity
      'splash.app_title': 'VHHealth Staff',
      'splash.device_unsupported_title': 'Device not supported',
      'splash.device_unsupported_body':
          'For patient data safety, VHHealth Staff cannot run on this device. Reason:',
      'splash.device_unsupported_use_hospital_device':
          'Please use a hospital-issued, unmodified device.',
      // Housekeeping tasks (placeholder)
      'housekeeping.tasks_title': 'My Tasks',
      'housekeeping.sample_notice':
          'Showing sample tasks. Backend API coming soon.',
      'housekeeping.task_completed': '✅ Task marked as complete',
      'housekeeping.task_started': 'Task started',
      'housekeeping.no_tasks': 'No tasks here',
      'housekeeping.tab_all': 'All',
      'housekeeping.tab_pending': 'Pending',
      'housekeeping.tab_done': 'Done',
      'housekeeping.action_start': 'Start',
      'housekeeping.action_done': 'Done',
      // Logout
      'logout.dialog_title': 'Logout?',
      'logout.dialog_body':
          'You will need to sign in again with your employee ID and password.',
      'logout.tooltip': 'Logout',
      // Misc shared
      'shift_card.no_shift': 'No shift assigned',
      'pharmacy.no_preview': 'No preview',
      'print.generated_by': 'Generated by VHHealth Staff app',
      'error.something_went_wrong': 'Something went wrong',
      'error.restart_or_contact': 'Please restart the app or contact support.',
      'appointments.no_today': 'No appointments today',
    },
    // ── हिन्दी (Hindi) ────────────────────────────────────────────────
    // Second-pass reviewed for register, common clinical-staff
    // terminology, and natural phrasing. Most strings should be
    // production-ready in Indian government / private hospital
    // contexts; a handful are flagged `// REVIEW:` where local
    // hospital convention may differ (e.g. discharge wording, urgency).
    'hi': {
      // Common actions
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
      // Common labels
      'label.loading': 'लोड हो रहा है…',
      'label.no_data': 'कोई डेटा नहीं',
      'label.no_matches_for': 'कोई मेल नहीं मिला:',
      'label.optional': 'वैकल्पिक',
      'label.required': 'आवश्यक',
      // Greetings
      'dashboard.greeting.morning': 'सुप्रभात',
      'dashboard.greeting.afternoon': 'शुभ दोपहर',
      'dashboard.greeting.evening': 'शुभ संध्या',
      // Dashboard
      'dashboard.checked_in': 'चेक इन हो गया',
      'dashboard.checked_out': 'चेक आउट हो गया',
      'dashboard.not_checked_in': 'चेक इन नहीं हुआ',
      'dashboard.quick_actions_header': 'त्वरित क्रियाएँ',
      'dashboard.recent_patients_header': 'हाल ही के मरीज़',
      'dashboard.stat.alerts': 'अलर्ट',
      'dashboard.stat.appointments': 'आज के अपॉइंटमेंट',
      'dashboard.stat.due_meds': 'देय दवाएँ',
      'dashboard.stat.inpatients': 'भर्ती मरीज़',
      'dashboard.stat.review_queue': 'AI ड्राफ्ट',
      'dashboard.upcoming_appointments': 'आगामी अपॉइंटमेंट',
      // Login
      'login.employee_id_label': 'कर्मचारी आईडी',
      'login.password_label': 'पासवर्ड',
      'login.pin_label': 'पिन',
      'login.sign_in_button': 'साइन इन',
      'login.use_biometric': 'बायोमेट्रिक का उपयोग करें',
      'login.use_password': 'पासवर्ड का उपयोग करें',
      'login.use_pin': 'पिन का उपयोग करें',
      'login.invalid_credentials': 'गलत क्रेडेंशियल। कृपया दोबारा कोशिश करें।',
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
      'dashboard.daily_work': 'दैनिक कार्य',
      'dashboard.op_services': 'OP सेवाएँ',
      'dashboard.ip_services': 'IP सेवाएँ',
      'dashboard.no_op_services': 'इस भूमिका के लिए OP सेवाएँ उपलब्ध नहीं हैं',
      'dashboard.no_ip_services': 'इस भूमिका के लिए IP सेवाएँ उपलब्ध नहीं हैं',
      'dashboard.op_lab_bookings': 'OP लैब बुकिंग',
      'dashboard.ip_lab_bookings': 'IP लैब बुकिंग',
      'dashboard.op_nursing_notes': 'OP नर्सिंग नोट्स',
      'dashboard.ip_nursing_notes': 'IP नर्सिंग नोट्स',
      'dashboard.op_pharmacy': 'OP फ़ार्मेसी',
      'dashboard.ip_pharmacy': 'IP फ़ार्मेसी',
      'dashboard.op_lab_results': 'OP लैब परिणाम',
      'dashboard.ip_lab_results': 'IP लैब परिणाम',
      'dashboard.op_patient_records': 'OP मरीज़ रिकॉर्ड',
      'dashboard.ip_patient_records': 'IP मरीज़ रिकॉर्ड',
      'dashboard.more_tools': 'अधिक टूल',
      'dashboard.more_tools_hint':
          'छुट्टी, प्रोफ़ाइल, सेटिंग्स और कभी-कभार के कार्य',
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
      // Bed
      'bed.label': 'बेड',
      'bed.status.available': 'उपलब्ध',
      'bed.status.occupied': 'व्यस्त',
      'bed.status.maintenance': 'रखरखाव',
      // Bed Board
      'bed_board.title': 'बेड बोर्ड',
      'bed_board.search_wards_hint': 'वार्ड खोजें…',
      'bed_board.search_beds_hint': 'बेड नंबर या मरीज़ का नाम खोजें…',
      'bed_board.select_ward_prompt': 'बेड देखने के लिए वार्ड चुनें',
      'bed_board.empty_title': 'इस वार्ड में कोई बेड नहीं',
      'bed_board.empty_body': 'एडमिन पोर्टल से बेड जोड़ें।',
      'bed_board.filter.all': 'सभी',
      // Bed sheet
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
      'bed_sheet.discharge': 'डिस्चार्ज',
      'bed_sheet.mark_maintenance': 'रखरखाव में डालें',
      'bed_sheet.mark_available': 'उपलब्ध करें',
      'bed_sheet.discharge_confirm_prefix': 'डिस्चार्ज करें',
      'bed_sheet.discharge_confirm_body':
          'इससे बेड खाली हो जाएगा और सक्रिय भर्ती समाप्त हो जाएगी। मरीज़ के EMR रिकॉर्ड बने रहेंगे।',
      // Attendance
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
      'settings.manage_devices.subtitle': 'पंजीकृत डिवाइस देखें और हटाएँ',
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
      'settings.logout.dialog_body': 'क्या आप वाकई लॉग आउट करना चाहते हैं?',
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
      // Leave
      'leave.title': 'अवकाश',
      'leave.tab.apply': 'आवेदन करें',
      'leave.tab.my_leaves': 'मेरे अवकाश',
      'leave.tab.requests': 'अनुरोध',
      'leave.balance_header': 'अवकाश शेष',
      'leave.submit_button': 'आवेदन जमा करें',
      'leave.submitted': 'अवकाश आवेदन जमा हो गया',
      // Notifications / Messaging
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
      // REVIEW: clinical urgency wording - confirm with hospital escalation policy
      'priority.urgent': 'अति आवश्यक',
      // REVIEW: clinical urgency wording - confirm with hospital escalation policy
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
          'VH Health द्वारा अस्पताल स्टाफ प्रबंधन ऐप। उपस्थिति, अवकाश, अपॉइंटमेंट और बहुत कुछ - सब कुछ अपने मोबाइल डिवाइस से प्रबंधित करें।',
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
      'about.feature.investigations.description': 'लैब टेस्ट और निदान रिपोर्ट',
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
      'leave.replacement_staff_hint': 'अपनी जगह काम करने के लिए सहकर्मी चुनें',
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
          'कनेक्शन नहीं - वाइटल्स सहेजे गए और ऑनलाइन होने पर सिंक होंगे',
      // Nursing Notes
      'nursing_notes.title': 'नर्सिंग नोट्स',
      'nursing_notes.tab.add': 'नोट जोड़ें',
      'nursing_notes.tab.recent': 'हाल के नोट्स',
      'nursing_notes.backend_coming_soon':
          'सहेजे गए नोट केवल जोड़ने योग्य EMR प्रविष्टियां हैं। सुधार addendum के रूप में जोड़ें।',
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
          'ऑफ़लाइन सहेजा गया - कनेक्ट होने पर सिंक होगा',
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
      'handover.notes_hint': 'मुख्य अवलोकन, लंबित कार्य, दवा परिवर्तन...',
      'handover.notes_required': 'नोट्स आवश्यक हैं',
      'handover.patient_ref_label': 'मरीज़ संदर्भ (वैकल्पिक)',
      'handover.patient_ref_hint':
          'कक्ष 201 - श्री शर्मा, कक्ष 305 - श्रीमती पटेल',
      'handover.submit_button': 'हैंडओवर जमा करें',
      'handover.submitting_button': 'जमा कर रहा है...',
      // REVIEW: clinical-action confirmation
      'handover.submitted': 'हैंडओवर नोट जमा किया गया',
      'handover.recent_empty_title': 'कोई हाल का हैंडओवर नोट नहीं',
      'handover.recent_empty_body': 'पिछले 24 घंटों के नोट्स यहाँ दिखाई देंगे',
      'handover.note_fallback_title': 'हैंडओवर नोट',
      // Patient picker
      'patient_picker.title': 'मरीज़ खोजें',
      'patient_picker.hint': 'नाम, फ़ोन या ABHA से मरीज़ खोजें…',
      'patient_picker.empty': 'अभी कोई मेल नहीं मिला - टाइप करना जारी रखें।',
      // Voice dictation
      'voice_dictate.tooltip': 'बोलकर लिखें',
      'voice_dictate.recording': 'रिकॉर्ड हो रहा है…',
      'voice_dictate.stop': 'रोकें और लिखें',
      'voice_dictate.transcribing': 'टेक्स्ट में बदल रहा है…',
      'voice_dictate.transcript_added': 'नोट्स में जोड़ा गया',
      'voice_dictate.hint': 'सामान्य रूप से बोलें। समाप्त होने पर रोकें।',
      'voice_dictate.added_toast': 'नोट्स में जोड़ा गया',
      'voice_dictate.recording_started': 'रिकॉर्डिंग शुरू',
      'voice_dictate.recording_stopped':
          'रिकॉर्डिंग रुकी, ट्रांसक्राइब हो रहा है',
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
      'bed_board.admit_search_hint': 'नाम, फ़ोन या ABHA से खोजें…',
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
      // REVIEW: clinical / safety - allergies surfacing
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
      'prescriptions.photo.body': 'फ़ोटो लें या गैलरी से चुनें?',
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
      'prescriptions.follow_up_notes_hint': 'जैसे ब्लड रिपोर्ट लाएँ',
      'prescriptions.clinical_notes': 'क्लिनिकल नोट्स / सलाह',
      'prescriptions.clinical_notes_hint': 'आराम, आहार, फ़ॉलो-अप निर्देश...',
      'prescriptions.photo_attached': 'फ़ोटो संलग्न ✓',
      'prescriptions.attach_handwritten':
          'हस्तलिखित प्रिस्क्रिप्शन संलग्न करें (वैकल्पिक)',
      'prescriptions.creating': 'बना रहा है...',
      'prescriptions.create': 'प्रिस्क्रिप्शन बनाएँ',
      'prescriptions.created_prefix': 'प्रिस्क्रिप्शन',
      'prescriptions.created_suffix': 'बनाया गया',
      'prescriptions.patient_label': 'मरीज़',
      'prescriptions.doctor_label': 'डॉक्टर',
      'prescriptions.search_patient': 'मरीज़ खोजें (फ़ोन/नाम)',
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
      'patient_records.search_hint': 'मरीज़ का नाम या प्रकार से खोजें...',
      'patient_records.clear_tooltip': 'खोज साफ़ करें',
      'patient_records.retry': 'पुनः प्रयास',
      'patient_records.no_found': 'कोई रिकॉर्ड नहीं मिला',
      'patient_records.empty': 'कोई मरीज़ रिकॉर्ड नहीं',
      'patient_records.empty_body': 'मरीज़ रिकॉर्ड यहाँ दिखाई देंगे',
      'patient_records.details': 'रिकॉर्ड विवरण',
      'patient_records.unknown_patient': 'अज्ञात मरीज़',
      // Appointment queue
      'appt_queue.title': 'अपॉइंटमेंट कतार',
      'appt_queue.walk_in': 'वॉक-इन',
      'appt_queue.tab.today_prefix': 'आज की कतार',
      'appt_queue.tab.pending_prefix': 'लंबित',
      'appt_queue.no_today': 'आज कोई अपॉइंटमेंट नहीं',
      'appt_queue.all_confirmed': 'सभी अपॉइंटमेंट पुष्टि किए गए!',
      'appt_queue.confirm_title': 'अपॉइंटमेंट की पुष्टि करें',
      'appt_queue.change_date': 'तिथि बदलें',
      'appt_queue.change_time': 'समय बदलें',
      'appt_queue.notes_optional': 'नोट्स (वैकल्पिक)',
      'appt_queue.confirm_appointment': 'अपॉइंटमेंट की पुष्टि करें',
      // REVIEW: clinical-action confirmation
      'appt_queue.confirmed_toast': 'अपॉइंटमेंट की पुष्टि हुई ✓',
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
      'appt_queue.rx_prompt_title': 'ई-प्रिस्क्रिप्शन बनाएँ?',
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
      'appt_queue.register_walk_in': 'वॉक-इन पंजीकृत करें',
      'appt_queue.patient_phone': 'मरीज़ फ़ोन *',
      'appt_queue.patient_phone_required': 'मरीज़ का फ़ोन आवश्यक है',
      'appt_queue.patient_name': 'मरीज़ का नाम',
      'appt_queue.department': 'विभाग',
      'appt_queue.reason': 'कारण',
      'appt_queue.reason_hint': 'वॉक-इन परामर्श',
      'appt_queue.walk_in_registered_prefix': 'वॉक-इन पंजीकृत! टोकन',
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
      // REVIEW: clinical action - keep DNR/DNI as standard medical abbrev
      'admission.code.full': 'फुल कोड',
      'admission.code.dnr': 'DNR',
      'admission.code.dnr_dni': 'DNR/DNI',
      'admission.code.comfort': 'आरामदायक देखभाल',
      // REVIEW: clinical-action confirmation
      'admission.admitted_success': 'मरीज़ सफलतापूर्वक भर्ती किया गया',
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
      'orders.description_hint': 'घाव की देखभाल, स्थिति बदलना, निगरानी...',
      'orders.frequency_hint_nursing': 'हर 4 घंटे, PRN, एक बार...',
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
      'orders.complete_failed_prefix': 'आदेश पूर्ण करने में विफल:',
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
      'vitals_chart.at_least_one': 'कृपया कम से कम एक वाइटल साइन दर्ज करें',
      // REVIEW: clinical-action confirmation
      'vitals_chart.recorded_success': 'वाइटल्स सफलतापूर्वक दर्ज किए गए',
      'vitals_chart.record_failed_prefix': 'वाइटल्स दर्ज करने में विफल:',
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
      'vitals_chart.no_vitals': 'पिछले 24 घंटों में कोई वाइटल्स दर्ज नहीं',
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
      'vitals_chart.no_io_today': 'आज कोई I/O प्रविष्टि दर्ज नहीं',
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
      // REVIEW: clinical-action - signed/unsigned status
      'clinical_notes.signed': 'हस्ताक्षरित',
      'clinical_notes.unsigned': 'बिना हस्ताक्षर',
      'clinical_notes.retry': 'पुनः प्रयास',
      'clinical_notes.no_found_prefix': 'कोई',
      'clinical_notes.no_found_suffix': 'नोट नहीं मिले',
      // REVIEW: clinical-action confirmation
      'clinical_notes.sign_note': 'नोट पर हस्ताक्षर',
      // REVIEW: clinical-action confirmation
      'clinical_notes.signed_success': 'नोट सफलतापूर्वक हस्ताक्षरित',
      'clinical_notes.sign_failed_prefix': 'नोट हस्ताक्षरित करने में विफल:',
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
      'clinical_notes.subjective_hint': 'मरीज़ की शिकायतें, लक्षण, इतिहास...',
      'clinical_notes.objective_hint': 'जाँच परिणाम, वाइटल्स, लैब परिणाम...',
      'clinical_notes.assessment_hint': 'निदान, क्लिनिकल छाप...',
      'clinical_notes.plan_hint': 'उपचार योजना, आदेश, फ़ॉलो-अप...',
      'clinical_notes.title_field': 'शीर्षक',
      'clinical_notes.content_hint':
          'क्लिनिकल प्रगति, अवलोकन, योजना परिवर्तन...',
      'clinical_notes.procedure_name': 'प्रक्रिया का नाम',
      'clinical_notes.procedure_details_hint': 'तकनीक, दृष्टिकोण, चरण...',
      'clinical_notes.findings_hint': 'अंतर-प्रक्रियात्मक निष्कर्ष...',
      'clinical_notes.complications_hint': 'सामना की गई कोई भी जटिलताएँ...',
      'clinical_notes.required': 'आवश्यक',
      'clinical_notes.save_note': 'नोट सहेजें',
      // REVIEW: clinical-action confirmation
      'clinical_notes.created_success': 'नोट सफलतापूर्वक बनाया गया',
      'clinical_notes.create_failed_prefix': 'नोट बनाने में विफल:',
      // ── Payroll ───────────────────────────────────────────────────
      'payroll.payslip.title': 'मेरी वेतन-पर्चियाँ',
      'payroll.payslip.banner_tax': 'वार्षिक कर सारांश (फॉर्म 16)',
      'payroll.payslip.banner_declaration': 'कर घोषणा (80C/80D)',
      'payroll.payslip.banner_queries': 'वेतन-पर्ची प्रश्न',
      'payroll.payslip.empty_title': 'अभी कोई वेतन-पर्ची उपलब्ध नहीं',
      'payroll.payslip.empty_body':
          'वेतन-पर्चियाँ हर महीने की 5 तारीख को जारी होती हैं',
      'payroll.payslip.new_badge': 'नया',
      'payroll.payslip.net_pay': 'शुद्ध वेतन',
      'payroll.payslip.gross': 'सकल',
      'payroll.payslip.deductions': 'कटौतियाँ',
      'payroll.detail.title_prefix': 'वेतन-पर्ची',
      'payroll.detail.download_pdf': 'PDF डाउनलोड करें',
      'payroll.detail.pdf_not_available':
          'PDF अभी उपलब्ध नहीं - बाद में फिर देखें',
      // REVIEW: error message
      'payroll.detail.pdf_failed_prefix': 'PDF खोलने में विफल:',
      'payroll.detail.pdf_being_generated':
          'PDF वेतन-पर्ची तैयार हो रही है। यह जल्द ही यहाँ दिखेगी।',
      'payroll.detail.pdf_download_button': 'PDF वेतन-पर्ची डाउनलोड करें',
      'payroll.detail.opening': 'खोल रहा है…',
      'payroll.detail.not_found': 'वेतन-पर्ची नहीं मिली',
      'payroll.detail.attendance_header': '📅 उपस्थिति',
      'payroll.detail.earnings_header': '💰 आय',
      'payroll.detail.deductions_header': '📉 कटौतियाँ',
      'payroll.detail.working_days': 'कार्य दिवस',
      'payroll.detail.days_present': 'उपस्थित दिन',
      'payroll.detail.days_absent': 'अनुपस्थित दिन',
      'payroll.detail.lop_days': 'बिना वेतन के दिन (LOP)',
      'payroll.detail.leave_days': 'अवकाश दिन',
      'payroll.detail.overtime_hours': 'ओवरटाइम घंटे',
      'payroll.detail.basic': 'मूल वेतन',
      'payroll.detail.hra': 'HRA',
      'payroll.detail.da': 'DA',
      'payroll.detail.special_allowance': 'विशेष भत्ता',
      'payroll.detail.transport_allowance': 'परिवहन भत्ता',
      'payroll.detail.medical_allowance': 'चिकित्सा भत्ता',
      'payroll.detail.overtime_pay': 'ओवरटाइम वेतन',
      'payroll.detail.bonus': 'बोनस',
      'payroll.detail.arrears': 'भुगतान किए गए बकाया',
      'payroll.detail.gross_salary': 'सकल वेतन',
      'payroll.detail.lop_deduction': 'बिना वेतन की कटौती',
      // REVIEW: financial - verify deduction wording
      'payroll.detail.pf_employee': 'PF (कर्मचारी 12%)',
      // REVIEW: financial - verify deduction wording
      'payroll.detail.esi': 'ESI (0.75%)',
      // REVIEW: financial - verify deduction wording
      'payroll.detail.professional_tax': 'पेशेवर कर',
      // REVIEW: financial - verify deduction wording
      'payroll.detail.tds': 'TDS',
      // REVIEW: financial - verify deduction wording
      'payroll.detail.advance_deduction': 'वेतन अग्रिम कटौती',
      'payroll.detail.total_deductions': 'कुल कटौतियाँ',
      'payroll.query.title': 'वेतन-पर्ची प्रश्न',
      'payroll.query.tab_my': 'मेरे प्रश्न',
      'payroll.query.tab_raise': 'प्रश्न उठाएँ',
      'payroll.query.empty': 'अभी तक कोई प्रश्न नहीं उठाया गया',
      'payroll.query.replies_header': 'उत्तर',
      'payroll.query.raise_header': 'वेतन-पर्ची प्रश्न उठाएँ',
      'payroll.query.select_payslip': 'वेतन-पर्ची चुनें *',
      'payroll.query.choose_payslip_hint': 'वेतन-पर्ची चुनें',
      'payroll.query.category_label': 'श्रेणी *',
      'payroll.query.subject_label': 'विषय *',
      'payroll.query.subject_required': 'विषय आवश्यक है',
      'payroll.query.description_label': 'विवरण *',
      'payroll.query.description_required': 'विवरण आवश्यक है',
      'payroll.query.pick_payslip': 'कृपया एक वेतन-पर्ची चुनें',
      'payroll.query.submit_button': 'प्रश्न सबमिट करें',
      // REVIEW: financial confirmation
      'payroll.query.submitted_success': 'प्रश्न सफलतापूर्वक उठाया गया!',
      'payroll.tax_summary.title': 'वार्षिक कर सारांश',
      'payroll.tax_summary.fy_label': 'वित्तीय वर्ष:',
      'payroll.tax_summary.total_gross': 'कुल सकल',
      'payroll.tax_summary.total_net': 'कुल शुद्ध',
      'payroll.tax_summary.taxable_income': 'कर योग्य आय',
      'payroll.tax_summary.tax_payable': 'देय कर',
      'payroll.tax_summary.earnings_breakdown': '💰 आय विवरण',
      'payroll.tax_summary.deductions_breakdown': '📉 कटौतियाँ विवरण',
      // REVIEW: financial - verify tax-regime wording
      'payroll.tax_summary.tax_computation': '🧾 कर गणना (नई व्यवस्था)',
      // REVIEW: financial - verify deduction wording
      'payroll.tax_summary.standard_deduction': 'घटाएँ: मानक कटौती',
      // REVIEW: financial disclaimer - verify legal wording
      'payroll.tax_summary.disclaimer':
          'यह केवल सांकेतिक है, नई कर व्यवस्था के तहत गणना की गई है। वास्तविक फॉर्म 16 आपके नियोक्ता द्वारा वित्तीय वर्ष के अंत में जारी किया जाएगा।',
      'payroll.tax_summary.download_pdf': 'PDF डाउनलोड करें',
      // REVIEW: financial - verify Form 16 wording
      'payroll.tax_summary.download_form16': 'फॉर्म 16 PDF डाउनलोड करें',
      'payroll.declaration.title': 'कर घोषणा (80C/80D)',
      // REVIEW: financial - verify deduction wording
      'payroll.declaration.estimated_deductions': 'अनुमानित कर कटौतियाँ',
      'payroll.declaration.total_deductions': 'कुल कटौतियाँ',
      'payroll.declaration.section_80c': '80C निवेश (अधिकतम ₹1,50,000)',
      'payroll.declaration.section_80d': '80D स्वास्थ्य बीमा',
      'payroll.declaration.section_other': 'अन्य कटौतियाँ',
      'payroll.declaration.section_rent': 'HRA / किराया',
      'payroll.declaration.field_ppf': 'PPF',
      'payroll.declaration.field_epf': 'EPF स्वैच्छिक',
      'payroll.declaration.field_elss': 'ELSS (म्यूचुअल फंड)',
      'payroll.declaration.field_lic': 'LIC प्रीमियम',
      'payroll.declaration.field_nsc': 'NSC',
      'payroll.declaration.field_home_loan_principal': 'गृह ऋण मूलधन',
      'payroll.declaration.field_tuition': 'ट्यूशन शुल्क (बच्चों का)',
      'payroll.declaration.field_other_80c': 'अन्य 80C',
      'payroll.declaration.field_hi_self': 'स्वास्थ्य बीमा - स्वयं',
      'payroll.declaration.field_hi_parents': 'स्वास्थ्य बीमा - माता-पिता',
      'payroll.declaration.field_nps': 'NPS योगदान (80CCD)',
      'payroll.declaration.field_home_loan_interest': 'गृह ऋण ब्याज (24b)',
      'payroll.declaration.field_edu_loan': 'शिक्षा ऋण ब्याज (80E)',
      'payroll.declaration.field_rent_monthly': 'मासिक किराया भुगतान',
      'payroll.declaration.rent_receipts': 'किराए की रसीदें प्रदान कीं',
      'payroll.declaration.submit_button': 'घोषणा सबमिट करें',
      // REVIEW: financial confirmation
      'payroll.declaration.submitted_success': 'घोषणा सफलतापूर्वक सबमिट की गई!',
      'payroll.declaration.past_title': 'पिछली घोषणाएँ',
      'payroll.declaration.fy_submitted': 'सबमिट किया गया',
      // HR
      'hr.dashboard.title': 'HR डैशबोर्ड',
      'hr.timeframe.this_month': 'इस महीने',
      'hr.timeframe.last_month': 'पिछले महीने',
      'hr.timeframe.this_quarter': 'इस तिमाही',
      'hr.timeframe.this_year': 'इस वर्ष',
      'hr.section.attendance_overview': 'उपस्थिति अवलोकन',
      'hr.section.leave_summary': 'अवकाश सारांश',
      'hr.section.quick_actions': 'त्वरित कार्य',
      'hr.stat.total_staff': 'कुल कर्मचारी',
      'hr.stat.present_today': 'आज उपस्थित',
      'hr.stat.on_leave': 'अवकाश पर',
      'hr.stat.pending_leaves': 'लंबित अवकाश',
      'hr.avg_attendance_rate': 'औसत उपस्थिति दर',
      'hr.late_arrivals': 'देरी से आगमन',
      'hr.absentees': 'अनुपस्थित',
      'hr.total_applications': 'कुल आवेदन',
      'hr.approved': 'स्वीकृत',
      'hr.rejected': 'अस्वीकृत',
      'hr.pending_approval': 'मंज़ूरी लंबित',
      'hr.action.staff_management': 'कर्मचारी प्रबंधन',
      'hr.action.staff_management.subtitle':
          'कर्मचारी देखें, जोड़ें और संपादित करें',
      'hr.action.performance': 'प्रदर्शन समीक्षा',
      'hr.action.performance.subtitle': 'प्रदर्शन रिकॉर्ड प्रबंधित करें',
      'hr.action.staff_directory': 'कर्मचारी निर्देशिका',
      'hr.action.staff_directory.subtitle': 'सभी कर्मचारी देखें',
      'hr.action.reports': 'रिपोर्ट और शिकायतें',
      'hr.action.reports.subtitle': 'घटना रिपोर्ट, कर्मचारी शिकायतें',
      'hr.action.payslips': 'मेरी वेतन-पर्चियाँ',
      'hr.action.payslips.subtitle': 'पिछले 3 महीने देखें और डाउनलोड करें',
      'staff_mgmt.title': 'कर्मचारी प्रबंधन',
      'staff_mgmt.search_hint': 'नाम, विभाग, भूमिका से खोजें…',
      'staff_mgmt.add_staff': 'कर्मचारी जोड़ें',
      'staff_mgmt.edit_staff': 'कर्मचारी संपादित करें',
      'staff_mgmt.full_name': 'पूरा नाम',
      'staff_mgmt.name_required': 'नाम आवश्यक है',
      'staff_mgmt.department': 'विभाग',
      'staff_mgmt.clear_filter': 'फ़िल्टर हटाएँ',
      'staff_mgmt.active': 'सक्रिय',
      'staff_mgmt.inactive': 'निष्क्रिय',
      'staff_mgmt.no_staff_found': 'कोई कर्मचारी नहीं मिला',
      'staff_mgmt.no_staff_members': 'कोई कर्मचारी नहीं',
      'staff_mgmt.search_empty': 'भिन्न खोज शब्द आज़माएँ',
      'staff_mgmt.api_pending': 'API कनेक्ट होने पर कर्मचारी डेटा यहाँ दिखेगा',
      // REVIEW: HR confirmation
      'staff_mgmt.updated_success': '✅ कर्मचारी सफलतापूर्वक अपडेट किया गया',
      // REVIEW: HR confirmation
      'staff_mgmt.added_pending': '✅ कर्मचारी जोड़ा गया (बैकएंड API लंबित)',
      'staff_mgmt.list_api_unavailable':
          'स्टाफ सूची API अभी उपलब्ध नहीं हो सकता है।',
      'performance.title': 'प्रदर्शन समीक्षा',
      'performance.tab.add': 'समीक्षा जोड़ें',
      'performance.tab.reviews': 'समीक्षाएँ',
      'performance.employee_id_label': 'कर्मचारी ID',
      'performance.employee_id_hint': 'जैसे EMP-001',
      'performance.employee_id_required': 'कर्मचारी ID आवश्यक है',
      'performance.review_period_label': 'समीक्षा अवधि',
      'performance.overall_rating': 'समग्र रेटिंग',
      'performance.comments_label': 'प्रदर्शन टिप्पणियाँ',
      'performance.comments_hint':
          'प्रदर्शन, उपलब्धियाँ, सुधार के क्षेत्रों का वर्णन करें…',
      'performance.comments_required': 'टिप्पणियाँ आवश्यक हैं',
      'performance.goals_label': 'अगली अवधि के लक्ष्य (वैकल्पिक)',
      'performance.goals_hint': 'लक्ष्य और अपेक्षाएँ निर्धारित करें…',
      'performance.saving_button': 'सहेज रहा है…',
      'performance.save_review': 'समीक्षा सहेजें',
      // REVIEW: HR confirmation
      'performance.saved_success': '✅ प्रदर्शन समीक्षा सहेजी गई',
      // REVIEW: HR rating - verify scale
      'performance.rating.exceptional': 'असाधारण',
      // REVIEW: HR rating - verify scale
      'performance.rating.exceeds': 'अपेक्षाओं से अधिक',
      // REVIEW: HR rating - verify scale
      'performance.rating.meets': 'अपेक्षाओं के अनुरूप',
      // REVIEW: HR rating - verify scale
      'performance.rating.needs_improvement': 'सुधार की आवश्यकता',
      // REVIEW: HR rating - verify scale
      'performance.rating.unsatisfactory': 'असंतोषजनक',
      'performance.no_reviews': 'अभी तक कोई समीक्षा नहीं',
      'directory.title': 'कर्मचारी निर्देशिका',
      'directory.search_hint': 'नाम, विभाग, भूमिका से खोजें…',
      'directory.empty': 'निर्देशिका खाली है',
      'directory.search_empty': 'भिन्न खोज शब्द आज़माएँ',
      'directory.api_pending': 'API कनेक्ट होने पर कर्मचारी यहाँ दिखेंगे',
      'directory.api_unavailable':
          'स्टाफ निर्देशिका API अभी उपलब्ध नहीं हो सकता है।',
      'directory.staff_empty_body': 'कोई कर्मचारी नहीं मिला',
      // Reports & Grievances
      'reports.hub.title': 'रिपोर्ट और शिकायतें',
      // REVIEW: security/HR - verify policy wording
      'reports.hub.confidentiality_note':
          'सभी रिपोर्टें गोपनीय रूप से संभाली जाती हैं। रिपोर्ट करने वालों के विरुद्ध प्रतिशोध सख्त वर्जित है।',
      'reports.hub.prompt': 'आप क्या रिपोर्ट करना चाहेंगे?',
      'reports.hub.incident_title': 'घटना रिपोर्ट',
      'reports.hub.incident_subtitle':
          'मरीज़ का गिरना, दवा त्रुटि, near-miss, उपकरण विफलता या कोई प्रतिकूल घटना',
      // REVIEW: clinical-safety - verify escalation wording
      'reports.hub.incident_note':
          'सेंटिनल/गंभीर घटनाएँ तुरंत एस्केलेट की जाती हैं',
      'reports.hub.grievance_title': 'कर्मचारी शिकायत',
      'reports.hub.grievance_subtitle':
          'उत्पीड़न, अनुचित व्यवहार, असुरक्षित कार्य परिस्थितियाँ या नीति उल्लंघन',
      // REVIEW: HR/security - verify confidentiality wording
      'reports.hub.grievance_note':
          'अनाम रूप से सबमिट कर सकते हैं। केवल HR तक पहुँच।',
      'reports.hub.my_reports': 'मेरी रिपोर्ट और स्थिति',
      'my_reports.title': 'मेरी रिपोर्ट',
      'my_reports.tab.incidents': 'घटनाएँ',
      'my_reports.tab.grievances': 'शिकायतें',
      'my_reports.empty_incidents': 'कोई घटना रिपोर्ट नहीं',
      'my_reports.empty_grievances': 'कोई शिकायत दर्ज नहीं',
      'my_reports.label.status': 'स्थिति',
      'my_reports.label.severity': 'गंभीरता',
      'my_reports.label.type': 'प्रकार',
      'my_reports.label.location': 'स्थान',
      'my_reports.label.description': 'विवरण',
      'incident_report.title': 'घटना रिपोर्ट',
      // REVIEW: clinical-safety wording
      'incident_report.severity_label': 'गंभीरता *',
      // REVIEW: clinical / safety severity wording
      'incident_report.severity.low': 'कम',
      // REVIEW: clinical-safety wording
      'incident_report.severity.low_desc': 'मामूली, कोई नुकसान नहीं',
      'incident_report.severity.moderate': 'मध्यम',
      // REVIEW: clinical-safety wording
      'incident_report.severity.moderate_desc':
          'कुछ प्रभाव, स्थानीय रूप से प्रबंधित',
      'incident_report.severity.severe': 'गंभीर',
      // REVIEW: clinical-safety wording
      'incident_report.severity.severe_desc': 'महत्वपूर्ण नुकसान, जाँच आवश्यक',
      'incident_report.severity.sentinel': 'सेंटिनल',
      // REVIEW: clinical-safety - sentinel event wording
      'incident_report.severity.sentinel_desc':
          'अप्रत्याशित मृत्यु या गंभीर हानि',
      'incident_report.type_label': 'घटना प्रकार *',
      // REVIEW: clinical-safety - staff commonly say "Near Miss"; Hindi gloss provided
      'incident_report.type.near_miss': 'निकट-चूक (Near Miss)',
      // REVIEW: clinical-safety wording
      'incident_report.type.patient_fall': 'मरीज़ का गिरना',
      // REVIEW: clinical-safety wording
      'incident_report.type.medication_error': 'दवा त्रुटि',
      // REVIEW: clinical-safety wording
      'incident_report.type.needle_stick': 'सुई चुभन / नुकीली चोट',
      'incident_report.type.equipment_failure': 'उपकरण विफलता',
      // REVIEW: clinical-safety wording
      'incident_report.type.infection': 'संक्रमण / एक्सपोज़र',
      'incident_report.type.fire_safety': 'अग्नि / सुरक्षा खतरा',
      // REVIEW: clinical-safety wording
      'incident_report.type.patient_aggression': 'मरीज़ की आक्रामकता',
      // REVIEW: security wording
      'incident_report.type.security_breach': 'सुरक्षा उल्लंघन',
      'incident_report.type.other': 'अन्य',
      'incident_report.title_label': 'संक्षिप्त शीर्षक *',
      'incident_report.title_hint': 'जैसे बेड 12B के पास मरीज़ गिरा',
      'incident_report.title_required': 'शीर्षक आवश्यक है',
      'incident_report.what_happened': 'क्या हुआ? *',
      'incident_report.what_happened_hint':
          'घटना का विस्तार से वर्णन करें - क्या हुआ, कौन शामिल था, परिस्थितियाँ क्या थीं…',
      'incident_report.description_required': 'विवरण आवश्यक है',
      'incident_report.date_label': 'तारीख़ *',
      'incident_report.time_label': 'समय *',
      'incident_report.location_label': 'स्थान (वैकल्पिक)',
      'incident_report.location_hint': 'वार्ड, कमरा या क्षेत्र',
      'incident_report.patient_involved': 'मरीज़ शामिल',
      'incident_report.patient_name_label': 'मरीज़ का नाम / ID (वैकल्पिक)',
      'incident_report.witnesses_label': 'गवाह (वैकल्पिक)',
      'incident_report.witnesses_hint': 'घटना देखने वालों के नाम',
      // REVIEW: clinical-safety wording
      'incident_report.immediate_action': 'तत्काल की गई कार्रवाई (वैकल्पिक)',
      'incident_report.immediate_action_hint':
          'घटना के तुरंत बाद क्या किया गया?',
      // REVIEW: security - verify anonymity wording
      'incident_report.anonymous': 'अनाम रूप से सबमिट करें',
      // REVIEW: security - verify anonymity wording
      'incident_report.anonymous_note':
          'इस रिपोर्ट के साथ आपका नाम नहीं जोड़ा जाएगा',
      'incident_report.submit_button': 'घटना रिपोर्ट सबमिट करें',
      // REVIEW: clinical / safety confirmation
      'incident_report.submitted_title': 'रिपोर्ट सबमिट की गई',
      // REVIEW: clinical-safety - verify escalation wording
      'incident_report.escalation_note':
          'इसे HIGH PRIORITY के रूप में एस्केलेट किया गया है। प्रबंधन को सूचित किया जा चुका है।',
      // REVIEW: clinical-safety wording
      'incident_report.routine_note':
          'आपकी रिपोर्ट प्राप्त हो गई है और 24 घंटे में समीक्षा की जाएगी।',
      'incident_report.done_button': 'पूरा',
      'grievance.title': 'कर्मचारी शिकायत',
      // REVIEW: HR/security - verify confidentiality
      'grievance.privacy_note':
          'यह फ़ॉर्म केवल HR और वरिष्ठ प्रबंधन को दिखता है। आप अनाम रूप से सबमिट कर सकते हैं।',
      'grievance.type_label': 'शिकायत प्रकार *',
      // REVIEW: HR wording
      'grievance.type.harassment': 'उत्पीड़न',
      // REVIEW: HR wording
      'grievance.type.discrimination': 'भेदभाव',
      // REVIEW: HR wording
      'grievance.type.unfair_treatment': 'अनुचित व्यवहार',
      // REVIEW: HR/safety wording
      'grievance.type.unsafe_conditions': 'असुरक्षित कार्य परिस्थितियाँ',
      'grievance.type.workload': 'अत्यधिक कार्यभार',
      // REVIEW: HR/financial wording
      'grievance.type.pay_dispute': 'वेतन / मुआवज़ा विवाद',
      'grievance.type.schedule_conflict': 'शेड्यूल / रोस्टर विवाद',
      // REVIEW: HR wording
      'grievance.type.policy_violation': 'नीति उल्लंघन',
      'grievance.type.other': 'अन्य',
      'grievance.subject_label': 'विषय *',
      'grievance.subject_hint': 'अपनी चिंता का संक्षिप्त सारांश',
      'grievance.subject_required': 'विषय आवश्यक है',
      'grievance.describe_label': 'अपनी शिकायत का विवरण दें *',
      'grievance.describe_hint': 'जितनी जानकारी साझा करना सहज लगे उतनी दें…',
      'grievance.description_required': 'विवरण आवश्यक है',
      'grievance.against_whom_label': 'किसके विरुद्ध (वैकल्पिक)',
      'grievance.against_whom_hint': 'नाम या भूमिका, यदि लागू हो',
      'grievance.dept_label': 'विभाग (वैकल्पिक)',
      'grievance.date_optional': 'यह कब हुआ? (वैकल्पिक)',
      'grievance.date_prefix': 'यह कब हुआ:',
      // REVIEW: security - verify anonymity wording
      'grievance.anonymous': 'अनाम रूप से सबमिट करें',
      // REVIEW: security - verify anonymity wording
      'grievance.anonymous_note': 'आपकी पहचान प्रकट नहीं की जाएगी',
      'grievance.submit_button': 'शिकायत सबमिट करें',
      // REVIEW: HR confirmation
      'grievance.submitted_title': 'शिकायत सबमिट की गई',
      // REVIEW: HR confirmation
      'grievance.acknowledgement_note':
          'आपकी शिकायत प्राप्त हो गई है। HR 2 कार्य दिवस के भीतर पुष्टि करेगा।',
      // REVIEW: HR/security confirmation
      'grievance.acknowledgement_anonymous':
          'अनाम रूप से सबमिट किया गया। HR 2 कार्य दिवस के भीतर पुष्टि करेगा।',
      // Housekeeping
      'housekeeping.hub.title': 'हाउसकीपिंग',
      'housekeeping.hub.log_title': 'सफाई दर्ज करें',
      'housekeeping.hub.log_subtitle':
          'फ़ोटो प्रमाण के साथ पूरी की गई सफाई दर्ज करें',
      'housekeeping.hub.raise_title': 'अनुरोध उठाएँ',
      'housekeeping.hub.raise_subtitle':
          'गंदे क्षेत्र की रिपोर्ट करें या सफाई का अनुरोध करें',
      'housekeeping.hub.my_title': 'मेरी गतिविधि',
      'housekeeping.hub.my_subtitle':
          'अपने लॉग, सौंपे गए कार्य और अनुरोध देखें',
      'housekeeping.log.title': 'सफाई दर्ज करें',
      'housekeeping.log.type_label': 'सफाई प्रकार *',
      'housekeeping.type.routine': 'नियमित सफाई',
      'housekeeping.type.deep': 'गहरी सफाई',
      'housekeeping.type.disinfection': 'कीटाणुशोधन',
      'housekeeping.type.spillage': 'फैलाव सफाई',
      // REVIEW: clinical wording
      'housekeeping.type.post_procedure': 'प्रक्रिया के बाद',
      'housekeeping.zone_location_label': 'ज़ोन / स्थान *',
      'housekeeping.select_zone_label': 'ज़ोन चुनें (वैकल्पिक)',
      'housekeeping.select_zone_or_type': '-- चुनें या नीचे टाइप करें --',
      'housekeeping.describe_location': 'या सटीक स्थान बताएँ',
      'housekeeping.location_hint': 'जैसे कमरा 204, लिफ्ट के पास का गलियारा',
      'housekeeping.photo_evidence': 'फ़ोटो प्रमाण',
      'housekeeping.take_photo': 'फ़ोटो लेने के लिए टैप करें',
      'housekeeping.notes_label': 'नोट्स (वैकल्पिक)',
      'housekeeping.submit_log': 'सफाई लॉग सबमिट करें',
      'housekeeping.submitting_log': 'सबमिट हो रहा है…',
      'housekeeping.select_zone_error': 'ज़ोन चुनें या स्थान दर्ज करें',
      // REVIEW: confirmation
      'housekeeping.logged_title': 'सफाई दर्ज की गई',
      'housekeeping.logged_body':
          'आपका सफाई रिकॉर्ड हस्ताक्षरित होकर सबमिट हो गया है।',
      'housekeeping.done_button': 'पूर्ण',
      'housekeeping.raise.title': 'अनुरोध उठाएँ',
      'housekeeping.raise.type_label': 'अनुरोध प्रकार *',
      'housekeeping.raise.urgency_label': 'अत्यावश्यकता *',
      'housekeeping.request_type.cleaning': 'सामान्य सफाई',
      'housekeeping.request_type.spillage': 'फैलाव',
      'housekeeping.request_type.waste': 'अपशिष्ट निपटान',
      'housekeeping.request_type.linen': 'लिनेन / बिस्तर',
      'housekeeping.request_type.disinfection': 'कीटाणुशोधन',
      'housekeeping.request_type.other': 'अन्य',
      'housekeeping.description_label': 'विवरण (वैकल्पिक)',
      'housekeeping.description_hint': 'किस पर ध्यान चाहिए?',
      'housekeeping.problem_photo': 'समस्या की फ़ोटो (वैकल्पिक)',
      'housekeeping.photograph_problem': 'समस्या की फ़ोटो लेने के लिए टैप करें',
      'housekeeping.raise_request_button': 'अनुरोध उठाएँ',
      'housekeeping.raising_button': 'उठा रहा है…',
      // REVIEW: confirmation
      'housekeeping.raised_title': 'अनुरोध उठाया गया',
      'housekeeping.notified_note': 'हाउसकीपिंग स्टाफ को सूचित किया जाएगा।',
      'housekeeping.my.title': 'मेरी गतिविधि',
      'housekeeping.my.tab_logs': 'मेरे लॉग',
      'housekeeping.my.tab_requests': 'अनुरोध',
      'housekeeping.my.tab_raised': 'मेरे द्वारा उठाए गए',
      'housekeeping.my.tab_assigned': 'मुझे सौंपे गए',
      'housekeeping.no_logs': 'अभी तक कोई सफाई लॉग नहीं',
      'housekeeping.no_requests': 'यहाँ कोई अनुरोध नहीं',
      'housekeeping.unknown_location': 'अज्ञात स्थान',
      'housekeeping.mark_complete': 'पूर्ण के रूप में चिह्नित करें',
      'housekeeping.complete_dialog_title': 'पूर्ण के रूप में चिह्नित करें',
      'housekeeping.completion_notes': 'पूर्णता नोट्स (वैकल्पिक)',
      'housekeeping.add_completion_photo': 'पूर्णता फ़ोटो जोड़ें',
      'housekeeping.marked_complete':
          '✅ अनुरोध पूर्ण के रूप में चिह्नित किया गया',
      'housekeeping.status.verified': 'सत्यापित',
      'housekeeping.status.flagged': 'फ़्लैग किया गया',
      'housekeeping.status.submitted': 'सबमिट किया गया',
      // Hospital departments
      'blood_bank.title': 'ब्लड बैंक',
      'blood_bank.tab.inventory': 'इन्वेंटरी',
      'blood_bank.tab.requests': 'अनुरोध',
      'blood_bank.tab.donations': 'दान',
      'blood_bank.refresh_tooltip': 'इन्वेंटरी ताज़ा करें',
      'blood_bank.legend.adequate': '>= 10 यूनिट',
      'blood_bank.legend.low': '5-9 यूनिट',
      'blood_bank.legend.critical': '< 5 यूनिट',
      'blood_bank.units_suffix': 'यूनिट',
      // REVIEW: clinical - blood stock criticality
      'blood_bank.stock.critical_low': 'गंभीर रूप से कम',
      // REVIEW: clinical - blood stock criticality
      'blood_bank.stock.low': 'कम स्टॉक',
      'blood_bank.stock.adequate': 'पर्याप्त',
      'blood_bank.request_header': 'रक्त अनुरोध',
      'blood_bank.patient_name_label': 'मरीज़ का नाम',
      'blood_bank.patient_name_required': 'मरीज़ का नाम आवश्यक है',
      // REVIEW: clinical - blood typing
      'blood_bank.blood_type_label': 'रक्त समूह',
      // REVIEW: clinical - blood typing
      'blood_bank.blood_type_required': 'रक्त समूह चुनें',
      'blood_bank.units_label': 'आवश्यक यूनिट',
      'blood_bank.units_required': 'यूनिट आवश्यक',
      'blood_bank.units_invalid': 'मान्य संख्या दर्ज करें',
      // REVIEW: clinical - verify request wording
      'blood_bank.reason_label': 'कारण / नोट्स',
      'blood_bank.submit_request': 'अनुरोध सबमिट करें',
      'blood_bank.submitting_button': 'सबमिट हो रहा है…',
      // REVIEW: clinical confirmation
      'blood_bank.request_success': 'रक्त अनुरोध सफलतापूर्वक सबमिट किया गया',
      'blood_bank.donations.title': 'दान रिकॉर्ड',
      'blood_bank.donations.body':
          'रक्त दान रिकॉर्ड देखें और प्रबंधित करें।\n'
          'यह अनुभाग दान का इतिहास और आगामी दान शिविर दिखाएगा।',
      'dietary.title': 'आहार प्रबंधन',
      'dietary.refresh_tooltip': 'वर्कलिस्ट ताज़ा करें',
      'dietary.new_order_button': 'नया आदेश',
      // REVIEW: clinical-action - diet order
      'dietary.new_order_dialog': 'नया आहार आदेश',
      'dietary.patient_uid_label': 'मरीज़ UID',
      'dietary.patient_uid_required': 'आवश्यक',
      'dietary.diet_type_label': 'आहार प्रकार',
      'dietary.diet_type_required': 'आहार प्रकार चुनें',
      'dietary.meal_time_label': 'भोजन समय',
      'dietary.meal_time_required': 'भोजन समय चुनें',
      // REVIEW: clinical-safety - allergy wording
      'dietary.restrictions_label': 'प्रतिबंध / एलर्जी',
      'dietary.notes_label': 'नोट्स',
      'dietary.create_button': 'बनाएँ',
      // REVIEW: clinical confirmation
      'dietary.created_success': 'आहार आदेश बनाया गया',
      // REVIEW: clinical-action confirmation
      'dietary.discontinued_success': 'आहार आदेश बंद किया गया',
      // REVIEW: clinical-action wording
      'dietary.discontinue': 'बंद करें',
      'dietary.diet.regular': 'सामान्य',
      // REVIEW: clinical - diabetic diet
      'dietary.diet.diabetic': 'मधुमेह आहार',
      // REVIEW: clinical - cardiac diet
      'dietary.diet.cardiac': 'हृदय आहार',
      // REVIEW: clinical - renal diet
      'dietary.diet.renal': 'गुर्दा आहार',
      'dietary.diet.soft': 'नर्म आहार',
      'dietary.diet.liquid': 'तरल आहार',
      // REVIEW: clinical-safety - NPO wording
      'dietary.diet.npo': 'NPO (कुछ भी मुँह से नहीं)',
      // REVIEW: clinical - enteral feeding
      'dietary.diet.enteral': 'एंटरल फीडिंग',
      'dietary.meal.breakfast': 'नाश्ता',
      'dietary.meal.lunch': 'दोपहर का भोजन',
      'dietary.meal.dinner': 'रात का भोजन',
      'dietary.meal.snack': 'नाश्ता (स्नैक)',
      'dietary.empty_title': 'कोई आहार आदेश नहीं',
      'dietary.empty_body': 'नया आदेश बनाने के लिए नीचे दिए बटन पर टैप करें',
      'theatre.title': 'ऑपरेटिंग थिएटर',
      'theatre.pick_date': 'तारीख़ चुनें',
      'theatre.tab.schedule': 'अनुसूची',
      'theatre.tab.availability': 'उपलब्धता',
      'theatre.no_surgeries': 'कोई सर्जरी निर्धारित नहीं',
      'theatre.no_room_data': 'कोई कमरा डेटा उपलब्ध नहीं',
      'theatre.status.scheduled': 'निर्धारित',
      // REVIEW: clinical-action status - surgery
      'theatre.status.in_progress': 'चल रहा है',
      // REVIEW: clinical-action status - surgery
      'theatre.status.completed': 'पूर्ण',
      // REVIEW: clinical-action status - surgery
      'theatre.status.cancelled': 'रद्द',
      'theatre.surgeon_prefix': 'सर्जन:',
      'theatre.label.patient_uid': 'मरीज़ UID',
      'theatre.label.procedure_code': 'प्रक्रिया कोड',
      'theatre.label.ot_room': 'OT कमरा',
      'theatre.label.date': 'तारीख़',
      'theatre.label.time': 'समय',
      'theatre.label.duration': 'अवधि',
      'theatre.label.surgeon': 'सर्जन',
      // REVIEW: clinical role wording
      'theatre.label.anesthetist': 'एनेस्थेटिस्ट',
      'theatre.label.status': 'स्थिति',
      // REVIEW: clinical-safety - blood arranged
      'theatre.label.blood_arranged': 'रक्त की व्यवस्था',
      // REVIEW: clinical-safety - consent wording
      'theatre.label.consent': 'सहमति',
      'theatre.label.equipment': 'उपकरण',
      // REVIEW: clinical-action - surgery
      'theatre.start_surgery': 'सर्जरी प्रारंभ करें',
      'theatre.mark_complete': 'पूर्ण के रूप में चिह्नित करें',
      // REVIEW: clinical-action - surgery cancel
      'theatre.cancel_button': 'रद्द करें',
      'theatre.preop_checklist': 'प्री-ऑप चेकलिस्ट',
      // REVIEW: clinical-safety - consent checklist
      'theatre.checklist.consent': 'सहमति प्राप्त',
      // REVIEW: clinical-safety checklist
      'theatre.checklist.blood': 'रक्त की व्यवस्था',
      // REVIEW: clinical-safety checklist
      'theatre.checklist.equipment': 'उपकरण जाँचा गया',
      // REVIEW: clinical-safety - patient ID
      'theatre.checklist.patient_id': 'मरीज़ की पहचान की पुष्टि',
      // REVIEW: clinical-action - pre-op submit
      'theatre.submit_checklist': 'चेकलिस्ट सबमिट करें',
      // REVIEW: clinical-action confirmation
      'theatre.checklist_updated': 'चेकलिस्ट अपडेट की गई',
      // REVIEW: clinical-action confirmation
      'theatre.status_updated_to': 'स्थिति अपडेट की गई:',
      'theatre.yes': 'हाँ',
      'theatre.no': 'नहीं',
      'theatre.available': 'उपलब्ध',
      'theatre.occupied': 'व्यस्त',
      'radiology.title': 'रेडियोलॉजी',
      'radiology.filters_tooltip': 'फ़िल्टर',
      'radiology.filters_header': 'फ़िल्टर',
      'radiology.status_label': 'स्थिति',
      'radiology.modality_label': 'मोडैलिटी',
      'radiology.status.all': 'सभी',
      'radiology.status.pending': 'लंबित',
      'radiology.status.in_progress': 'चल रहा है',
      'radiology.status.completed': 'पूर्ण',
      'radiology.status.cancelled': 'रद्द',
      'radiology.no_orders': 'कोई रेडियोलॉजी आदेश नहीं',
      'radiology.label.study_type': 'अध्ययन प्रकार',
      'radiology.label.modality': 'मोडैलिटी',
      'radiology.label.body_part': 'शरीर का अंग',
      'radiology.label.priority': 'प्राथमिकता',
      // REVIEW: clinical wording
      'radiology.label.clinical_indication': 'क्लिनिकल संकेत',
      'radiology.label.notes': 'नोट्स',
      'radiology.label.report': 'रिपोर्ट',
      // REVIEW: clinical wording
      'radiology.label.findings': 'निष्कर्ष',
      // REVIEW: clinical - radiology impression
      'radiology.label.impression': 'इम्प्रेशन',
      'radiology.submit_report': 'रिपोर्ट सबमिट करें',
      // REVIEW: clinical-action - order cancel
      'radiology.cancel_order': 'आदेश रद्द करें',
      // REVIEW: clinical wording
      'radiology.findings_required': 'निष्कर्ष आवश्यक हैं',
      // REVIEW: clinical-action confirmation
      'radiology.report_submitted': 'रिपोर्ट सबमिट की गई',
      // REVIEW: clinical-action confirmation
      'radiology.order_cancelled': 'आदेश रद्द किया गया',
      'schedule.title': 'पाली अनुसूची',
      'schedule.prev_week': 'पिछला सप्ताह',
      'schedule.next_week': 'अगला सप्ताह',
      'schedule.week_this': 'इस सप्ताह',
      'schedule.week_next': 'अगला सप्ताह',
      'schedule.week_last': 'पिछला सप्ताह',
      'schedule.total_label': 'कुल',
      'schedule.days_logged': 'दिन दर्ज',
      'schedule.hours_worked_suffix': 'घं काम',
      'schedule.upcoming': 'आगामी',
      'schedule.no_record': 'कोई रिकॉर्ड नहीं',
      // REVIEW: error message
      'schedule.load_failed_prefix': 'शेड्यूल लोड नहीं हो सका:',
      // Lab / Pharmacy / Investigations
      'investigations.title': 'जाँचें',
      'investigations.tab.upload': 'परिणाम अपलोड करें',
      'investigations.tab.pending': 'लंबित',
      'investigations.tab.recent': 'हाल का',
      'investigations.upload_intro':
          'फ़ोन नंबर से मरीज़ खोजें और उनकी जाँच के परिणाम अपलोड करें।',
      'investigations.phone_label': 'मरीज़ का फ़ोन नंबर',
      'investigations.phone_hint': '+91 XXXXX XXXXX',
      'investigations.phone_required': 'फ़ोन आवश्यक है',
      'investigations.phone_invalid': 'मान्य फ़ोन नंबर दर्ज करें',
      'investigations.test_type_label': 'टेस्ट प्रकार',
      'investigations.test_type_required': 'टेस्ट प्रकार चुनें',
      // REVIEW: clinical wording
      'investigations.result_label': 'परिणाम / सारांश',
      'investigations.result_hint': 'टेस्ट परिणाम या सारांश दर्ज करें…',
      // REVIEW: clinical wording
      'investigations.clinical_notes_label': 'क्लिनिकल नोट्स (वैकल्पिक)',
      'investigations.clinical_notes_hint': 'अतिरिक्त अवलोकन…',
      'investigations.attach_report': 'रिपोर्ट फ़ाइल संलग्न करें (वैकल्पिक)',
      'investigations.clear_file': 'साफ़ करें',
      'investigations.file_too_large':
          'फ़ाइल बहुत बड़ी है। अधिकतम साइज़ 10 MB।',
      // REVIEW: error message
      'investigations.file_pick_failed': 'फ़ाइल चुनने में विफल',
      'investigations.uploading': 'अपलोड हो रहा है…',
      'investigations.upload_button': 'जाँच अपलोड करें',
      // REVIEW: clinical confirmation
      'investigations.upload_success':
          '✅ जाँच परिणाम सफलतापूर्वक अपलोड किया गया',
      'investigations.pending_empty': 'कोई लंबित जाँच नहीं',
      'investigations.pending_empty_body': 'सब निपट गया!',
      'investigations.recent_empty': 'कोई हाल की जाँच नहीं',
      'investigations.recent_empty_body': 'आपकी जाँच अपलोड यहाँ दिखेंगी',
      'investigations.start_button': 'शुरू',
      'investigations.complete_button': 'पूर्ण',
      // REVIEW: clinical-action confirmation
      'investigations.marked_as_prefix': '✅ जाँच चिह्नित की गई:',
      'lab_bookings.title': 'लैब बुकिंग',
      'lab_bookings.tab.new': 'नई',
      'lab_bookings.tab.active': 'सक्रिय',
      'lab_bookings.tab.done': 'पूर्ण',
      'lab_bookings.empty_prefix': 'कोई बुकिंग नहीं',
      'lab_bookings.view_slip': 'प्रिस्क्रिप्शन स्लिप देखें',
      'lab_bookings.home_collection': 'घर',
      'lab_bookings.walk_in': 'वॉक-इन',
      'lab_bookings.confirm_dialog': 'बुकिंग की पुष्टि करें',
      // REVIEW: clinical-safety - test verification
      'lab_bookings.actual_tests_label': 'वास्तविक टेस्ट (यदि भिन्न हों)',
      'lab_bookings.actual_tests_hint': 'टेस्ट नाम सत्यापित करें/जोड़ें',
      // REVIEW: financial wording
      'lab_bookings.final_cost_label': 'अंतिम लागत (₹)',
      // REVIEW: clinical-action confirmation
      'lab_bookings.confirm_button': 'पुष्टि करें',
      // REVIEW: confirmation
      'lab_bookings.confirmed_toast': 'बुकिंग पुष्टि हुई',
      'lab_bookings.dispatch_dialog': 'कलेक्टर भेजें',
      'lab_bookings.collector_phone': 'कलेक्टर का फ़ोन',
      'lab_bookings.dispatch_button': 'भेजें',
      'lab_bookings.dispatched_toast': 'कलेक्टर भेजा गया',
      'lab_bookings.sharing_location': '📍 स्थान साझा हो रहा है…',
      // REVIEW: clinical-action - sample collection
      'lab_bookings.mark_collected': 'एकत्रित चिह्नित करें',
      // REVIEW: clinical-action confirmation
      'lab_bookings.samples_collected_toast': 'सैंपल एकत्रित किए गए',
      // REVIEW: clinical-action - sample processing
      'lab_bookings.start_processing': 'प्रोसेसिंग शुरू करें',
      // REVIEW: clinical-action confirmation
      'lab_bookings.processing_started_toast': 'प्रोसेसिंग शुरू हुई',
      // REVIEW: clinical-action wording
      'lab_bookings.upload_result': 'परिणाम अपलोड करें',
      'lab_bookings.select_file': 'फ़ाइल चुनें',
      // REVIEW: clinical-action confirmation
      'lab_bookings.result_uploaded_toast': 'परिणाम अपलोड किया गया',
      'lab_bookings.view_result': 'परिणाम देखें',
      'pharmacy.title': 'फार्मेसी आदेश',
      'pharmacy.queue_title': 'फार्मेसी कतार',
      'pharmacy.queue_subtitle': 'आदेश कतार में',
      'pharmacy.tab.new': 'नए',
      'pharmacy.tab.active': 'सक्रिय',
      'pharmacy.tab.done': 'पूर्ण',
      'pharmacy.empty.new': 'कोई नया आदेश नहीं',
      'pharmacy.empty.active': 'कोई सक्रिय आदेश नहीं',
      'pharmacy.empty.done': 'कोई पूर्ण आदेश नहीं',
      // REVIEW: clinical-action - pharmacy order
      'pharmacy.confirm_dialog': 'आदेश की पुष्टि करें',
      'pharmacy.patient_note_prefix': 'मरीज़ का नोट:',
      'pharmacy.items_label': 'आइटम (एक प्रति पंक्ति: नाम, मात्रा, मूल्य)',
      // intentionally English - Indian drug brand-name examples for hint
      'pharmacy.items_hint':
          'Dolo 650, 2, 60\n'
          'Pan 40, 1, 95',
      // REVIEW: financial wording
      'pharmacy.total_cost_label': 'कुल लागत (₹)',
      'pharmacy.confirm_order': 'आदेश की पुष्टि करें',
      // REVIEW: clinical-action - verify before dispatch
      'pharmacy.view_confirm': 'देखें और पुष्टि करें',
      'pharmacy.start_preparing': 'तैयारी शुरू करें',
      'pharmacy.dispatch': 'भेजें',
      'pharmacy.mark_delivered': 'पहुँचा हुआ चिह्नित करें',
      // REVIEW: clinical-action - pharmacy dispatch
      'pharmacy.dispatch_dialog': 'आदेश भेजें',
      'pharmacy.delivery_person_name': 'डिलीवरी व्यक्ति का नाम',
      'pharmacy.delivery_person_phone': 'डिलीवरी व्यक्ति का फ़ोन',
      // REVIEW: clinical-action - pharmacy delivery
      'pharmacy.mark_delivered_dialog': 'डिलीवर्ड चिह्नित करें?',
      // REVIEW: clinical-action confirmation
      'pharmacy.mark_delivered_yes': 'हाँ, डिलीवर हुआ',
      // REVIEW: clinical-action - pharmacy cancel
      'pharmacy.cancel_dialog': 'आदेश रद्द करें?',
      'pharmacy.cancellation_reason': 'रद्द करने का कारण',
      'pharmacy.delivery_type.pickup': 'पिकअप',
      'pharmacy.delivery_type.delivery': 'डिलीवरी',
      // REVIEW: clinical-action confirmation
      'pharmacy.order_confirmed_toast': 'आदेश की पुष्टि हुई',
      // REVIEW: clinical-action confirmation
      'pharmacy.mark_preparing_toast': 'तैयारी के रूप में चिह्नित',
      // REVIEW: clinical-action confirmation
      'pharmacy.order_dispatched_toast': 'आदेश भेजा गया',
      // REVIEW: clinical-action confirmation
      'pharmacy.order_delivered_toast': 'डिलीवर्ड चिह्नित किया गया',
      // REVIEW: clinical-action confirmation
      'pharmacy.order_cancelled_toast': 'आदेश रद्द किया गया',
      'pharmacy.status.placed': 'दर्ज',
      'pharmacy.status.confirmed': 'पुष्टि',
      'pharmacy.status.preparing': 'तैयार हो रहा',
      'pharmacy.status.dispatched': 'भेजा गया',
      'pharmacy.status.delivered': 'डिलीवर्ड',
      'pharmacy.status.cancelled': 'रद्द',
      // Nursing
      'due_meds.title': 'देय दवाएँ',
      'due_meds.search_hint': 'मरीज़ या दवा से खोजें…',
      'due_meds.empty_title': 'कोई दवा देय नहीं',
      'due_meds.empty_body':
          'वाइटल्स दर्ज करने के लिए बेड बोर्ड पर बेड पर टैप करें।',
      // REVIEW: clinical-action - medication hold
      'due_meds.held_badge': 'रोका गया',
      'due_meds.unknown_patient': 'अज्ञात मरीज़',
      // REVIEW: clinical-safety - unnamed med
      'due_meds.unnamed_medication': '(बेनाम दवा)',
      'mar_scan.title': 'दवा प्रशासित करें',
      // REVIEW: clinical-safety - 5 rights
      'mar_scan.step1_prompt': 'चरण 1 / 3 - मरीज़ का रिस्टबैंड स्कैन करें',
      'mar_scan.step1_subtitle': 'मरीज़ के रिस्टबैंड पर QR कोड पर कैमरा लगाएँ।',
      // REVIEW: clinical-safety - 5 rights
      'mar_scan.step2_prompt': 'चरण 2 / 3 - दवा का बारकोड स्कैन करें',
      'mar_scan.step2_subtitle': 'अब दवा के लेबल पर बारकोड स्कैन करें।',
      // REVIEW: clinical-safety - 5 rights
      'mar_scan.step3_header': 'चरण 3 / 3 - 5-rights जाँच',
      // REVIEW: clinical-action / safety wording for medication 5-rights
      'mar_scan.right_patient': 'सही रोगी',
      'mar_scan.right_drug': 'सही दवा',
      'mar_scan.right_dose': 'सही खुराक',
      'mar_scan.right_route': 'सही मार्ग',
      'mar_scan.right_time': 'सही समय',
      'mar_scan.recording': 'रिकॉर्ड हो रहा है…',
      'mar_scan.administer': 'प्रशासित करें',
      // REVIEW: clinical-safety - 5 rights failure
      'mar_scan.check_failed': '5-rights जाँच विफल',
      // REVIEW: clinical-safety - override audit
      'mar_scan.override_hint':
          'इस प्रशासन को रिकॉर्ड करने के लिए कारण दर्ज करें। यह प्रविष्टि ऑडिट होती है।',
      // REVIEW: clinical-safety - override reason
      'mar_scan.override_reason_label':
          'ओवरराइड कारण (आवश्यक, न्यूनतम 5 अक्षर)',
      // REVIEW: clinical-safety - override+administer
      'mar_scan.override_button': 'ओवरराइड करें और प्रशासित करें',
      'mar_scan.recorded': 'प्रशासन रिकॉर्ड किया गया',
      'mar_scan.scan_next': 'अगली खुराक स्कैन करें',
      'mar_scan.scan_again': 'फिर स्कैन करें',
      'mar_scan.try_again': 'फिर कोशिश करें',
      // REVIEW: clinical-safety - unknown med
      'mar_scan.unknown_medication': '(अज्ञात दवा)',
      // Discharge Summary
      'discharge.title_prefix': 'डिस्चार्ज —',
      'discharge.save_draft': 'ड्राफ्ट सहेजें',
      'discharge.draft_saved': 'ड्राफ्ट सहेजा गया',
      // REVIEW: clinical-action confirmation - discharge wording
      'discharge.sign_summary': 'सारांश पर हस्ताक्षर करें',
      // REVIEW: clinical-action - discharge sign
      'discharge.sign_dialog_title': 'डिस्चार्ज सारांश पर हस्ताक्षर करें',
      // REVIEW: clinical-action - discharge sign immutable
      'discharge.sign_dialog_body':
          'हस्ताक्षर के बाद यह डिस्चार्ज सारांश आधिकारिक रिकॉर्ड बन जाता है और इसे संशोधित नहीं किया जा सकता (केवल addenda की अनुमति है)।\n'
          '\n'
          'क्या आप वाकई हस्ताक्षर करना चाहते हैं?',
      'discharge.sign_button': 'हस्ताक्षर करें',
      // REVIEW: clinical-action confirmation
      'discharge.signed_success': 'डिस्चार्ज सारांश हस्ताक्षरित - अब आधिकारिक',
      // REVIEW: clinical-action confirmation
      'discharge.signed_badge':
          'हस्ताक्षरित - यह सारांश अब आधिकारिक और अपरिवर्तनीय है',
      // REVIEW: clinical-action - discharge confirm
      'discharge.proceed_title': 'डिस्चार्ज की पुष्टि करें',
      'discharge.proceed_body_prefix': 'डिस्चार्ज करें',
      'discharge.proceed_button': 'डिस्चार्ज',
      // REVIEW: clinical-action - sign-first guard
      'discharge.must_sign_first':
          'डिस्चार्ज सारांश पर पहले डॉक्टर का हस्ताक्षर आवश्यक है',
      'discharge.patient_discharged': 'रोगी सफलतापूर्वक डिस्चार्ज किया गया',
      'discharge.patient_button': 'रोगी डिस्चार्ज करें',
      // REVIEW: clinical-action - generate summary
      'discharge.generate_title': 'डिस्चार्ज सारांश तैयार करें',
      // REVIEW: clinical-action - auto generate
      'discharge.generate_body':
          'इस भर्ती के सभी वार्ड नोट्स, वाइटल्स, जाँचें, दवाएँ और निदान स्वतः एकत्र होकर एक संरचित डिस्चार्ज सारांश में तैयार हो जाएँगे।',
      'discharge.generate_button': 'सारांश तैयार करें',
      'discharge.generating': 'तैयार हो रहा है…',
      // REVIEW: clinical-action - regenerate summary
      'discharge.regenerate': 'सारांश पुनः तैयार करें',
      // REVIEW: clinical wording
      'discharge.section.hospital_course': 'अस्पताल कोर्स',
      // REVIEW: clinical wording
      'discharge.section.diagnosis': 'डिस्चार्ज निदान',
      // REVIEW: clinical wording
      'discharge.section.condition': 'डिस्चार्ज स्थिति',
      // REVIEW: clinical wording
      'discharge.section.follow_up': 'फॉलो-अप निर्देश',
      // REVIEW: clinical wording
      'discharge.section.activity': 'गतिविधि प्रतिबंध',
      // REVIEW: clinical wording
      'discharge.section.diet': 'आहार निर्देश',
      // REVIEW: clinical-safety - warning signs
      'discharge.section.warning_signs': 'चेतावनी संकेत',
      // REVIEW: clinical-safety - discharge meds
      'discharge.section.medications': 'डिस्चार्ज पर दवाएँ',
      'discharge.section.investigations': 'जाँचें',
      // REVIEW: clinical wording
      'discharge.section.procedures': 'की गई प्रक्रियाएँ',
      // Attendance dispute / overtime
      'dispute.title': 'उपस्थिति विवाद',
      'dispute.tab.submit': 'सबमिट करें',
      'dispute.tab.my': 'मेरे विवाद',
      'dispute.intro':
          'इसका उपयोग उपस्थिति रिकॉर्डिंग समस्याओं की रिपोर्ट करने के लिए करें। HR समीक्षा करेगा और आपका रिकॉर्ड सही करेगा।',
      'dispute.date_label': 'तारीख़',
      'dispute.select_date': 'समस्या की तारीख़ चुनें',
      'dispute.issue_type_label': 'समस्या प्रकार',
      'dispute.type.missed_checkin': 'चेक-इन छूटा',
      'dispute.type.missed_checkout': 'चेक-आउट छूटा',
      'dispute.type.wrong_time': 'गलत समय रिकॉर्ड हुआ',
      'dispute.type.app_failure': 'ऐप / नेटवर्क विफलता',
      'dispute.type.other': 'अन्य',
      'dispute.description_label': 'विवरण',
      'dispute.description_hint': 'समझाएँ कि क्या हुआ…',
      'dispute.correct_times': 'सही समय (वैकल्पिक)',
      'dispute.correct_times_hint': 'यदि सही समय पता हो तो यहाँ दर्ज करें।',
      'dispute.check_in': 'चेक-इन',
      'dispute.check_out': 'चेक-आउट',
      'dispute.required_error': 'तारीख़ और विवरण आवश्यक हैं',
      'dispute.submit_button': 'विवाद सबमिट करें',
      // REVIEW: HR confirmation
      'dispute.submitted_success':
          '✅ विवाद सबमिट किया गया। HR 24 घंटे के भीतर समीक्षा करेगा।',
      'dispute.empty': 'कोई विवाद दर्ज नहीं',
      'dispute.hr_comment_prefix': 'HR:',
      'overtime.title': 'ओवरटाइम अनुरोध',
      'overtime.tab.request': 'अनुरोध',
      'overtime.tab.my': 'मेरे अनुरोध',
      // REVIEW: HR/financial wording
      'overtime.extra_hours_label': 'अतिरिक्त घंटे',
      'overtime.hours_suffix': 'घं',
      'overtime.type_label': 'प्रकार',
      // REVIEW: HR - comp time wording
      'overtime.type.comp_time': 'मुआवज़ा अवकाश',
      // REVIEW: HR/financial wording
      'overtime.type.payment': 'ओवरटाइम भुगतान',
      'overtime.reason_label': 'कारण',
      'overtime.reason_hint': 'आपने ओवरटाइम क्यों किया?',
      'overtime.required_error': 'तारीख़ और कारण आवश्यक हैं',
      'overtime.submit_button': 'ओवरटाइम अनुरोध सबमिट करें',
      // REVIEW: HR confirmation
      'overtime.submitted_success': '✅ ओवरटाइम अनुरोध सबमिट किया गया',
      'overtime.empty': 'कोई ओवरटाइम अनुरोध नहीं',
      // REVIEW: HR rejection wording
      'overtime.rejected_prefix': 'अस्वीकृत:',
      // Telemedicine
      'telemedicine.title_prefix': 'वीडियो कॉल —',
      'telemedicine.sdk_missing_title': 'वीडियो SDK अभी एकीकृत नहीं',
      'telemedicine.sdk_missing_body':
          'सक्षम करने के लिए agora_rtc_engine या flutter_webrtc जोड़ें।',
      'telemedicine.mute': 'म्यूट',
      'telemedicine.unmute': 'अनम्यूट',
      'telemedicine.camera_off': 'कैमरा बंद',
      'telemedicine.camera_on': 'कैमरा चालू',
      'telemedicine.end_call': 'कॉल समाप्त',
      // Clinical AI
      'clinical_ai.queue.title': 'AI समीक्षा कतार',
      // REVIEW: clinical-AI - verify with reviewing clinician
      'clinical_ai.queue.compose_button': 'Compose रन',
      // REVIEW: clinical-AI wording
      'clinical_ai.queue.voice_notes_button': 'वॉइस नोट्स',
      'clinical_ai.queue.filter.pending': 'लंबित',
      'clinical_ai.queue.filter.accepted': 'स्वीकृत',
      'clinical_ai.queue.filter.edited': 'संपादित',
      'clinical_ai.queue.filter.rejected': 'अस्वीकृत',
      'clinical_ai.queue.filter.all': 'सभी',
      'clinical_ai.queue.empty_title': 'इस फ़िल्टर में कोई मसौदा नहीं',
      // REVIEW: clinical-AI wording
      'clinical_ai.queue.empty_body':
          'जब आप जिस भर्ती के समीक्षक हैं उसके लिए क्लिनिकल AI मसौदा बनेगा, वह यहाँ दिखेगा।',
      // REVIEW: error message
      'clinical_ai.queue.load_failed': 'समीक्षाएँ लोड करने में विफल',
      'clinical_ai.queue.patient_fallback': 'मरीज़',
      // REVIEW: clinical-AI - verify reject wording
      'clinical_ai.draft.reject_title': 'मसौदा अस्वीकार करें',
      'clinical_ai.draft.reject_reason_label': 'कारण',
      // REVIEW: clinical-AI - reject reason
      'clinical_ai.draft.reject_reason_hint': 'यह मसौदा अनुपयुक्त क्यों है?',
      'clinical_ai.draft.reject_button': 'अस्वीकार करें',
      'clinical_ai.draft.review_not_found': 'समीक्षा नहीं मिली।',
      // REVIEW: clinical-AI - JSON edit guard
      'clinical_ai.draft.invalid_json': 'संपादित मसौदा मान्य JSON नहीं है।',
      // REVIEW: clinical-action wording
      'clinical_ai.draft.accept': 'स्वीकार करें',
      // REVIEW: clinical-AI - accept edits
      'clinical_ai.draft.accept_edits': 'संपादन स्वीकार करें',
      'clinical_ai.draft.needs_revision': 'संशोधन आवश्यक',
      // REVIEW: clinical-AI confirmation
      'clinical_ai.draft.decision_recorded': 'मसौदा निर्णय रिकॉर्ड किया गया',
      // REVIEW: clinical-safety wording
      'clinical_ai.draft.no_safety_flags': 'कोई सुरक्षा फ्लैग नहीं उठाया गया।',
      // REVIEW: clinical/security wording - confirm with reviewing clinician
      'clinical_ai.draft.screen_title': 'AI मसौदा समीक्षा',
      'clinical_ai.draft.critical_title': 'गंभीर सुरक्षा फ्लैग',
      'clinical_ai.draft.safety_header': 'सुरक्षा फ्लैग',
      'clinical_ai.draft.body_header': 'मसौदा',
      'clinical_ai.draft.edit_header': 'मसौदा संपादित करें (JSON)',
      'clinical_ai.draft.edit_button': 'संपादित करें',
      'clinical_ai.draft.cancel_edit_button': 'संपादन रद्द करें',
      'clinical_ai.draft.failed_load': 'मसौदा लोड करने में विफल',
      'clinical_ai.draft.patient_prefix': 'रोगी:',
      'clinical_ai.draft.admission_prefix': 'भर्ती:',
      'clinical_ai.draft.status_prefix': 'स्थिति:',
      'clinical_ai.draft.provider_prefix': 'प्रदाता:',
      'clinical_ai.draft.decided_prefix': 'मसौदा',
      // REVIEW: error message
      'clinical_ai.draft.decision_failed_prefix':
          'निर्णय रिकॉर्ड करने में विफल:',
      'clinical_ai.compose_runs.title': 'Compose रन',
      'clinical_ai.compose_runs.empty': 'इस दृश्य में कोई compose रन नहीं।',
      'clinical_ai.compose_runs.filter.active': 'सक्रिय',
      'clinical_ai.compose_runs.filter.paused': 'रुका हुआ',
      'clinical_ai.compose_runs.filter.completed': 'पूर्ण',
      'clinical_ai.compose_runs.filter.failed': 'विफल',
      'clinical_ai.compose_runs.filter.all': 'सभी',
      'clinical_ai.compose_runs.review_prefix': 'समीक्षा:',
      'clinical_ai.compose_runs.started_prefix': 'शुरू हुआ',
      'clinical_ai.compose_runs.run_prefix': 'रन',
      'clinical_ai.compose_runs.admission_word': 'भर्ती',
      'clinical_ai.compose_run.not_found': 'रन नहीं मिला।',
      // REVIEW: clinical-AI confirmation
      'clinical_ai.compose_run.resumed': 'Compose फिर से शुरू किया गया।',
      'clinical_ai.compose_run.open_in_queue': 'समीक्षा कतार में खोलें',
      'clinical_ai.compose_run.detail_title_prefix': 'Compose रन',
      'clinical_ai.compose_run.admission_header_prefix': 'भर्ती',
      'clinical_ai.compose_run.subgraphs': 'सबग्राफ़',
      'clinical_ai.compose_run.no_subgraphs': 'कोई सबग्राफ़ रन नहीं।',
      'clinical_ai.compose_run.paused_prefix': 'रुका हुआ:',
      'clinical_ai.compose_run.review_status_key': 'समीक्षा स्थिति',
      'clinical_ai.compose_run.started_key': 'शुरू हुआ',
      'clinical_ai.compose_run.finished_key': 'समाप्त हुआ',
      // REVIEW: clinical-AI - resume action
      'clinical_ai.compose_run.resume_button': 'Compose फिर से शुरू करें',
      'clinical_ai.compose_run.resuming_button': 'फिर से शुरू कर रहा है…',
      // REVIEW: error message
      'clinical_ai.compose_run.resume_failed_prefix':
          'फिर से शुरू करने में विफल:',
      // REVIEW: clinical-safety - severity
      'clinical_ai.compose_run.critical_word': 'गंभीर',
      // REVIEW: clinical-safety - severity
      'clinical_ai.compose_run.high_word': 'उच्च',
      'clinical_ai.voice_notes.empty': 'अभी तक कोई वॉइस नोट नहीं।',
      // REVIEW: clinical-AI confirmation
      'clinical_ai.voice_notes.soap_generated':
          'SOAP मसौदा तैयार; समीक्षा कतार खोल रहा है।',
      'clinical_ai.voice_notes.title': 'वॉइस नोट्स',
      'clinical_ai.voice_notes.empty_subtitle':
          'डेस्कटॉप क्लाइंट से वॉइस नोट रिकॉर्ड करें; SOAP मसौदा बनाने के लिए वह यहाँ दिखेगा।',
      'clinical_ai.voice_notes.note_prefix': 'वॉइस नोट',
      'clinical_ai.voice_notes.patient_prefix': 'मरीज़:',
      // REVIEW: clinical-AI wording
      'clinical_ai.voice_notes.draft_exists': 'SOAP मसौदा पहले से तैयार है',
      // REVIEW: clinical-AI - generate SOAP
      'clinical_ai.voice_notes.generate_soap': 'SOAP मसौदा तैयार करें',
      'clinical_ai.voice_notes.drafting': 'मसौदा बना रहा है…',
      // REVIEW: error message
      'clinical_ai.voice_notes.generation_failed_prefix':
          'SOAP तैयार करने में विफल:',
      // AI Assist (clinical-notes patient explainer)
      'ai_assist.title': 'AI सहायक',
      'ai_assist.generate_blurb':
          'इस नोट का सरल भाषा में रोगी के लिए विवरण तैयार करें। सबमिट करने से पहले समीक्षा कतार में आएगा।',
      'ai_assist.generate_button': 'रोगी के लिए विवरण तैयार करें',
      'ai_assist.note_too_short':
          'विवरण तैयार करने के लिए नोट बहुत छोटा है (कम से कम 30 अक्षर चाहिए)।',
      'ai_assist.generating': 'रोगी विवरण तैयार हो रहा है…',
      'ai_assist.failed_prefix': 'AI सहायक विफल:',
      // REVIEW: clinical-safety - confirm with attending
      'ai_assist.cannot_sign':
          'साइन नहीं किया जा सकता - समीक्षा रिकॉर्ड नहीं बना (स्कीमा अनुपलब्ध हो सकती है)।',
      'ai_assist.reject_title': 'मसौदा अस्वीकार करें?',
      'ai_assist.reject_prompt':
          'यह मसौदा रोगी को देने के लिए उपयुक्त क्यों नहीं है?',
      'ai_assist.reject_min_chars':
          'अस्वीकृति का कारण कम से कम 5 अक्षर का होना चाहिए।',
      'ai_assist.reject_hint': 'जैसे: अगले-कदम भाग में चिकित्सीय अशुद्धि',
      'ai_assist.drawer_title': 'AI रोगी विवरण',
      'ai_assist.fallback_banner':
          'मॉडल ने पार्स करने योग्य मसौदा नहीं दिया; फॉलबैक प्रारूप दिखाया गया है। प्रदाता कॉन्फ़िगरेशन जाँचने के बाद पुनः जनरेट करें।',
      'ai_assist.key_points': 'मुख्य बिंदु',
      'ai_assist.next_steps': 'अगले कदम',
      'ai_assist.when_to_seek_help': 'मदद कब लें',
      'ai_assist.needs_edits': 'संशोधन आवश्यक',
      // REVIEW: clinical-safety - confirm with attending
      'ai_assist.accept_sign': 'स्वीकार करें और साइन करें',
      'ai_assist.summary': 'सारांश',
      'ai_assist.empty': '(खाली)',
      'ai_assist.decision_prefix': 'रोगी विवरण',
      'ai_assist.sign_failed_prefix': 'साइन-ऑफ विफल:',
      // CDS blocker modal - clinical-safety hard block
      'cds.blocker_title': 'नुस्खा अवरुद्ध',
      'cds.blocker_body':
          'क्लिनिकल निर्णय समर्थन ने निम्नलिखित समस्याओं का संकेत दिया है। '
          'नुस्खे को संशोधित करने के लिए रद्द करें, या दर्ज कारण के साथ ओवरराइड करें।',
      'cds.warnings_header': 'चेतावनियाँ',
      'cds.allergy_hint':
          'एलर्जी संघर्ष: कारण में उस पर्यवेक्षक चिकित्सक का उल्लेख करें जिसने इस ओवरराइड को मंजूरी दी।',
      'cds.override_reason_label': 'ओवरराइड कारण (आवश्यक, न्यूनतम 5 अक्षर)',
      'cds.override_button': 'ओवरराइड',
      'cds.override_save': 'ओवरराइड और सेव करें',
      // Code Blue - emergency overlay
      'code_blue.title': 'कोड ब्लू',
      'code_blue.respond': 'तुरंत प्रतिक्रिया दें।',
      'code_blue.ward_prefix': 'वार्ड:',
      'code_blue.bed_prefix': 'बेड:',
      'code_blue.patient_prefix': 'रोगी ID:',
      'code_blue.acknowledge': 'स्वीकार किया',
      // First-run welcome card
      'first_run.welcome_title': 'जानने योग्य कुछ शॉर्टकट',
      'first_run.welcome_dismiss': 'खारिज करें',
      'first_run.welcome_got_it': 'समझ गया',
      'first_run.tip_bed_tap':
          'रोगी विवरण और त्वरित कार्यों के लिए बेड बोर्ड पर बेड कार्ड पर टैप करें।',
      'first_run.tip_bed_long_press':
          'नोट्स को इनलाइन संपादित करने के लिए बेड कार्ड को लंबे समय तक दबाएँ।',
      'first_run.tip_magnifier_prefix':
          'किसी भी हेडर में आवर्धक का उपयोग करें - या दबाएँ',
      'first_run.tip_magnifier_suffix':
          '+K - किसी भी रोगी के चार्ट पर जाने के लिए।',
      'first_run.tip_dashboard':
          'ऊपर के कार्ड आपको कार्य स्थानों पर ले जाते हैं - "देय दवाएँ", "भर्ती मरीज़", आदि पर टैप करें।',
      // Splash / device integrity
      'splash.app_title': 'VHHealth स्टाफ',
      'splash.device_unsupported_title': 'डिवाइस समर्थित नहीं',
      'splash.device_unsupported_body':
          'रोगी डेटा सुरक्षा के लिए, VHHealth स्टाफ इस डिवाइस पर नहीं चल सकता। कारण:',
      'splash.device_unsupported_use_hospital_device':
          'कृपया अस्पताल द्वारा जारी, अनसंशोधित डिवाइस का उपयोग करें।',
      // Housekeeping tasks (placeholder)
      'housekeeping.tasks_title': 'मेरे कार्य',
      'housekeeping.sample_notice':
          'नमूना कार्य दिखाए जा रहे हैं। बैकएंड API जल्द आ रहा है।',
      'housekeeping.task_completed': '✅ कार्य पूर्ण के रूप में चिह्नित',
      'housekeeping.task_started': 'कार्य शुरू किया गया',
      'housekeeping.no_tasks': 'यहाँ कोई कार्य नहीं',
      'housekeeping.tab_all': 'सभी',
      'housekeeping.tab_pending': 'लंबित',
      'housekeeping.tab_done': 'पूर्ण',
      'housekeeping.action_start': 'शुरू',
      'housekeeping.action_done': 'पूर्ण',
      // Logout
      'logout.dialog_title': 'लॉगआउट करें?',
      'logout.dialog_body':
          'आपको अपनी कर्मचारी ID और पासवर्ड के साथ फिर से साइन इन करना होगा।',
      'logout.tooltip': 'लॉगआउट',
      // Misc shared
      'shift_card.no_shift': 'कोई शिफ्ट निर्दिष्ट नहीं',
      'pharmacy.no_preview': 'कोई पूर्वावलोकन नहीं',
      'print.generated_by': 'VHHealth स्टाफ ऐप द्वारा जनरेट किया गया',
      'error.something_went_wrong': 'कुछ गलत हुआ',
      'error.restart_or_contact':
          'कृपया ऐप को पुनरारंभ करें या समर्थन से संपर्क करें।',
      'appointments.no_today': 'आज कोई अपॉइंटमेंट नहीं',
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
      'login.invalid_credentials': 'தவறான விவரங்கள். மீண்டும் முயற்சிக்கவும்.',
      // REVIEW: app branding - keep VHHealth as proper noun
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
      // REVIEW: security message wording - confirm 15-min phrasing
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
      'dashboard.daily_work': 'தினசரி பணி',
      'dashboard.op_services': 'OP சேவைகள்',
      'dashboard.ip_services': 'IP சேவைகள்',
      'dashboard.no_op_services': 'இந்த பணிக்கு OP சேவைகள் கிடைக்கவில்லை',
      'dashboard.no_ip_services': 'இந்த பணிக்கு IP சேவைகள் கிடைக்கவில்லை',
      'dashboard.op_lab_bookings': 'OP ஆய்வக முன்பதிவு',
      'dashboard.ip_lab_bookings': 'IP ஆய்வக முன்பதிவு',
      'dashboard.op_nursing_notes': 'OP செவிலியர் குறிப்புகள்',
      'dashboard.ip_nursing_notes': 'IP செவிலியர் குறிப்புகள்',
      'dashboard.op_pharmacy': 'OP மருந்தகம்',
      'dashboard.ip_pharmacy': 'IP மருந்தகம்',
      'dashboard.op_lab_results': 'OP ஆய்வக முடிவுகள்',
      'dashboard.ip_lab_results': 'IP ஆய்வக முடிவுகள்',
      'dashboard.op_patient_records': 'OP நோயாளர் பதிவுகள்',
      'dashboard.ip_patient_records': 'IP நோயாளர் பதிவுகள்',
      'dashboard.more_tools': 'மேலும் கருவிகள்',
      'dashboard.more_tools_hint':
          'விடுப்பு, சுயவிவரம், அமைப்புகள் மற்றும் அரிதான பணிகள்',
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
      'bed_board.search_beds_hint': 'படுக்கை எண் அல்லது நோயாளி பெயரால் தேடு…',
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
      'settings.about.subtitle': 'பதிப்பு 1.0.0 · ஆப் தகவல் & அம்சங்கள்',
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
      'profile.updated_success': '✅ சுயவிவரம் வெற்றிகரமாக புதுப்பிக்கப்பட்டது',
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
      'messaging.empty_body': 'பணியாளர் அடைவில் இருந்து உரையாடலைத் தொடங்கவும்.',
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
      // Time helpers - REVIEW
      'time.just_now': 'இப்பொழுதே',
      'time.yesterday': 'நேற்று',
      'time.today': 'இன்று',
      'time.minutes_ago_suffix': ' நிமிடங்களுக்கு முன்',
      'time.hours_ago_suffix': ' மணி நேரத்திற்கு முன்',
      'time.days_ago_suffix': ' நாட்களுக்கு முன்',
      // Priority / Urgency - REVIEW (clinical wording)
      'priority.low': 'குறைந்த',
      'priority.normal': 'சாதாரண',
      'priority.high': 'உயர்',
      'priority.urgent': 'அவசர',
      'priority.critical': 'அபாயகர',
      'urgency.low': 'குறைந்த',
      'urgency.normal': 'சாதாரண',
      'urgency.high': 'உயர்',
      'urgency.critical': 'அபாயகர',
      // Departments - REVIEW
      'department.general': 'பொது',
      'department.emergency': 'அவசர',
      'department.icu': 'ICU',
      'department.pediatrics': 'குழந்தை மருத்துவம்',
      'department.surgery': 'அறுவை சிகிச்சை',
      'department.outpatient': 'வெளி நோயாளி',
      // About - REVIEW
      'about.title': 'பற்றி',
      'about.header': 'பற்றி',
      'about.app_name': 'VHHealth பணியாளர்',
      'about.version': 'பதிப்பு 1.0.0',
      'about.description':
          'VH Health-ன் மருத்துவமனை பணியாளர் மேலாண்மை ஆப். வருகை, விடுப்பு, சந்திப்புகள் மற்றும் பலவற்றை - அனைத்தையும் உங்கள் மொபைல் சாதனத்தில் இருந்து நிர்வகிக்கவும்.',
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
      // Leave (additional) - REVIEW
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
      'leave.replacement_staff_label': 'மாற்று பணியாளர் (விருப்பம்)',
      'leave.replacement_staff_hint':
          'உங்களுக்காக கவனிக்க ஒரு சகாவைத் தேர்ந்தெடுக்கவும்',
      'leave.replacement_staff_pick': 'மாற்றைத் தேர்ந்தெடுக்க தட்டவும்',
      'leave.select_replacement': 'மாற்று பணியாளரைத் தேர்ந்தெடு',
      'leave.no_staff_available': 'பணியாளர்கள் இல்லை',
      'leave.search_by_type_hint': 'விடுப்பு வகையால் தேடு…',
      'leave.no_applications': 'விடுப்பு விண்ணப்பங்கள் இல்லை',
      'leave.no_replacement_requests': 'நிலுவையில் மாற்று கோரிக்கைகள் இல்லை',
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
      // Bed sheet (additional) - REVIEW
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
      'bed_sheet.patient_admitted_suffix':
          'இந்தப் படுக்கைக்கு அனுமதிக்கப்பட்டார்',
      'bed_sheet.marked_as_prefix': 'படுக்கை குறிக்கப்பட்டது:',
      // Vitals - REVIEW
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
      'vitals.trends_hint': 'வைட்டல் போக்குகளைக் காண நோயாளி ID உள்ளிடவும்',
      'vitals.no_records': 'இந்த நோயாளிக்கு வைட்டல் பதிவுகள் எதுவும் இல்லை',
      // REVIEW: clinical-action confirmation
      'vitals.recorded_success': 'வைட்டல்ஸ் வெற்றிகரமாக பதிவு செய்யப்பட்டது',
      // REVIEW: clinical / connectivity message
      'vitals.offline_queued':
          'இணைப்பு இல்லை - வைட்டல்ஸ் சேமிக்கப்பட்டு ஆன்லைனில் சிங்க் ஆகும்',
      // Nursing Notes - REVIEW
      'nursing_notes.title': 'செவிலியர் குறிப்புகள்',
      'nursing_notes.tab.add': 'குறிப்பு சேர்',
      'nursing_notes.tab.recent': 'சமீபத்திய குறிப்புகள்',
      'nursing_notes.backend_coming_soon':
          'சேமித்த குறிப்புகள் append-only EMR பதிவுகள். திருத்தங்களை addendum ஆக சேர்க்கவும்.',
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
          'ஆஃப்லைன் சேமிக்கப்பட்டது - இணைக்கப்படும்போது சிங்க் ஆகும்',
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
      // Handover - REVIEW
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
          'இன்னும் நோயாளி பொருத்தங்கள் இல்லை - தொடர்ந்து தட்டச்சு செய்.',
      'voice_dictate.tooltip': 'குரல் → உரை',
      'voice_dictate.recording': 'பதிவு செய்கிறது…',
      'voice_dictate.stop': 'நிறுத்து & எழுது',
      'voice_dictate.transcribing': 'உரையாக்குகிறது…',
      'voice_dictate.transcript_added': 'குறிப்புகளில் சேர்க்கப்பட்டது',
      // REVIEW:
      'voice_dictate.hint':
          'இயல்பாக பேசவும். முடிந்ததும் நிறுத்து என்பதைத் தட்டவும்.',
      // REVIEW:
      'voice_dictate.added_toast': 'குறிப்புகளில் சேர்க்கப்பட்டது',
      // REVIEW:
      'voice_dictate.recording_started': 'பதிவு தொடங்கியது',
      // REVIEW:
      'voice_dictate.recording_stopped': 'பதிவு நின்றது, உரையாக்குகிறது',
      'voice_dictate.mic_denied':
          'மைக்ரோஃபோன் அனுமதி மறுக்கப்பட்டது. OS / பயன்பாட்டு அமைப்புகளில் இயக்கவும்.',
      // Bed Board (additions) - REVIEW
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
      'bed_board.admit_which_patient': 'எந்த நோயாளியை அனுமதி?',
      'bed_board.admit_search_hint': 'பெயர், தொலைபேசி அல்லது ABHA மூலம் தேடு…',
      'bed_board.type_to_find_patient': 'நோயாளியை தேட தட்டச்சு செய்யவும்.',
      'bed_board.patient_unnamed': 'பெயரில்லை',
      // Doctor queue - REVIEW
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
      'queue.no_health_records_found': 'சுகாதார பதிவுகள் காணப்படவில்லை',
      // REVIEW: clinical / safety - allergies surfacing
      'queue.allergies_prefix': 'ஒவ்வாமைகள்:',
      'queue.age_prefix': '• வயது:',
      'queue.write_prescription': 'மருந்துச்சீட்டு எழுது',
      'queue.order_investigation': 'விசாரணை ஆணை',
      'queue.add_notes': 'குறிப்புகள் சேர்',
      'queue.no_phone_number': 'தொலைபேசி எண் இல்லை',
      'queue.record_fallback': 'பதிவு',
      'queue.unknown_patient': 'தெரியாதது',
      // Prescriptions - REVIEW
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
      'prescriptions.clear_follow_up': 'பின்தொடர்தல் தேதியை அழி',
      'prescriptions.follow_up_notes': 'பின்தொடர்தல் குறிப்புகள்',
      'prescriptions.follow_up_notes_hint':
          'எ.கா. இரத்த அறிக்கைகளை கொண்டுவாரும்',
      'prescriptions.clinical_notes': 'மருத்துவ குறிப்புகள் / ஆலோசனை',
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
      'prescriptions.search_patient': 'நோயாளியை தேடு (தொலைபேசி/பெயர்)',
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
      // Patient records (doctor) - REVIEW
      'patient_records.title': 'நோயாளி பதிவுகள்',
      'patient_records.search_hint': 'நோயாளி பெயர் அல்லது வகை மூலம் தேடு...',
      'patient_records.clear_tooltip': 'தேடலை அழி',
      'patient_records.retry': 'மீண்டும் முயற்சி',
      'patient_records.no_found': 'பதிவுகள் காணப்படவில்லை',
      'patient_records.empty': 'நோயாளி பதிவுகள் இல்லை',
      'patient_records.empty_body': 'நோயாளி பதிவுகள் இங்கே தோன்றும்',
      'patient_records.details': 'பதிவு விவரங்கள்',
      'patient_records.unknown_patient': 'தெரியாத நோயாளி',
      // Appointment queue - REVIEW
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
      'appt_queue.confirm_appointment': 'சந்திப்பை உறுதிப்படுத்து',
      // REVIEW: clinical-action confirmation
      'appt_queue.confirmed_toast': 'சந்திப்பு உறுதிப்படுத்தப்பட்டது ✓',
      'appt_queue.failed_prefix': 'தோல்வி:',
      'appt_queue.no_show_title': 'வராதவர் என குறிக்கவா?',
      'appt_queue.no_show_body_suffix': 'வரவில்லையா?',
      'appt_queue.mark_no_show': 'வராதவர் என குறி',
      // REVIEW: clinical-action confirmation
      'appt_queue.no_show_marked': 'வராதவர் என குறிக்கப்பட்டது',
      'appt_queue.complete_title': 'சந்திப்பை முடிக்கவும்',
      'appt_queue.complete_body_prefix': 'குறிக்கவா',
      'appt_queue.complete_body_suffix': 'முடிந்ததாக?',
      'appt_queue.complete_action': 'முடிக்கவும்',
      // REVIEW: clinical-action confirmation
      'appt_queue.completed_toast': 'சந்திப்பு முடிந்தது ✓',
      'appt_queue.rx_prompt_title': 'ஈ-மருந்துச்சீட்டு உருவாக்கவா?',
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
      'appt_queue.patient_phone_required': 'நோயாளி தொலைபேசி தேவை',
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
      // Admission - REVIEW
      'admission.title': 'அனுமதிகள்',
      'admission.admit': 'அனுமதி',
      'admission.admit_patient': 'நோயாளியை அனுமதி',
      'admission.patient_label': 'நோயாளி (பெயர், UID, அல்லது தொலைபேசி)',
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
      // REVIEW: clinical-action - DNR/DNI standard medical
      'admission.code.full': 'முழு குறியீடு',
      'admission.code.dnr': 'DNR',
      'admission.code.dnr_dni': 'DNR/DNI',
      'admission.code.comfort': 'ஆறுதல் பராமரிப்பு',
      // REVIEW: clinical-action confirmation
      'admission.admitted_success': 'நோயாளி வெற்றிகரமாக அனுமதிக்கப்பட்டார்',
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
      // Patient timeline - REVIEW
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
      // Orders - REVIEW
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
      'orders.description_hint': 'காய பராமரிப்பு, நிலை, கண்காணிப்பு...',
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
      'orders.complete_failed_prefix': 'ஆணை முடிக்க முடியவில்லை:',
      'orders.retry': 'மீண்டும் முயற்சி',
      // Vitals chart - REVIEW
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
      'vitals_chart.conscious.verbal': 'குரலுக்கு பதிலளிக்கிறது',
      'vitals_chart.conscious.pain': 'வலிக்கு பதிலளிக்கிறது',
      'vitals_chart.conscious.unresp': 'பதிலளிக்காத',
      'vitals_chart.save_button': 'வைட்டல்ஸ் சேமி',
      'vitals_chart.at_least_one': 'குறைந்தது ஒரு உயிர் அளவீட்டை உள்ளிடவும்',
      // REVIEW: clinical-action confirmation
      'vitals_chart.recorded_success':
          'வைட்டல்ஸ் வெற்றிகரமாக பதிவு செய்யப்பட்டது',
      'vitals_chart.record_failed_prefix': 'வைட்டல்ஸ் பதிவு செய்ய முடியவில்லை:',
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
      'vitals_chart.io_failed_prefix': 'I/O பதிவு செய்ய முடியவில்லை:',
      'vitals_chart.retry': 'மீண்டும் முயற்சி',
      'vitals_chart.no_vitals': 'கடந்த 24 மணிநேரத்தில் வைட்டல்ஸ் இல்லை',
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
      'vitals_chart.no_io_today': 'இன்று I/O உள்ளீடுகள் பதிவு செய்யப்படவில்லை',
      'vitals_chart.record_for_prefix': 'இவருக்கு வைட்டல்ஸ் பதிவு:',
      'vitals_chart.record_patient': 'நோயாளி வைட்டல்ஸ் பதிவு',
      'vitals_chart.record_now': 'இப்போது வைட்டல்ஸ் பதிவு',
      // Clinical notes - REVIEW
      'clinical_notes.title': 'மருத்துவ குறிப்புகள்',
      'clinical_notes.title_prefix': 'குறிப்புகள்',
      'clinical_notes.tab.soap': 'SOAP குறிப்புகள்',
      'clinical_notes.tab.progress': 'முன்னேற்ற குறிப்புகள்',
      'clinical_notes.tab.procedure': 'செயல்முறை குறிப்புகள்',
      'clinical_notes.new_note': 'புதிய குறிப்பு',
      // REVIEW: clinical-action - signed/unsigned status
      'clinical_notes.signed': 'கையெழுத்திட்டது',
      'clinical_notes.unsigned': 'கையெழுத்தில்லை',
      'clinical_notes.retry': 'மீண்டும் முயற்சி',
      'clinical_notes.no_found_prefix': 'எந்த',
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
      'clinical_notes.assessment_hint': 'நோயறிதல், மருத்துவ எண்ணம்...',
      'clinical_notes.plan_hint': 'சிகிச்சை திட்டம், ஆணைகள், பின்தொடர்தல்...',
      'clinical_notes.title_field': 'தலைப்பு',
      'clinical_notes.content_hint':
          'மருத்துவ முன்னேற்றம், கவனிப்புகள், திட்ட மாற்றங்கள்...',
      'clinical_notes.procedure_name': 'செயல்முறை பெயர்',
      'clinical_notes.procedure_details_hint': 'நுட்பம், அணுகுமுறை, படிகள்...',
      'clinical_notes.findings_hint': 'செயல்முறையின் போதான கண்டுபிடிப்புகள்...',
      'clinical_notes.complications_hint': 'சந்தித்த எந்த சிக்கல்களும்...',
      'clinical_notes.required': 'தேவை',
      'clinical_notes.save_note': 'குறிப்பை சேமி',
      // REVIEW: clinical-action confirmation
      'clinical_notes.created_success': 'குறிப்பு வெற்றிகரமாக உருவாக்கப்பட்டது',
      'clinical_notes.create_failed_prefix': 'குறிப்பை உருவாக்க முடியவில்லை:',
      // Payroll
      // REVIEW: financial / payroll wording
      'payroll.payslip.title': 'என் சம்பளப் பட்டியல்கள்',
      'payroll.payslip.banner_tax': 'வருடாந்திர வரி சுருக்கம் (படிவம் 16)',
      'payroll.payslip.banner_declaration': 'வரி அறிவிப்பு (80C/80D)',
      'payroll.payslip.banner_queries': 'சம்பளப் பட்டியல் கேள்விகள்',
      'payroll.payslip.empty_title': 'சம்பளப் பட்டியல்கள் கிடைக்கவில்லை',
      'payroll.payslip.net_pay': 'நிகர சம்பளம்',
      'payroll.payslip.gross': 'மொத்தம்',
      'payroll.payslip.deductions': 'கழிவுகள்',
      'payroll.detail.title_prefix': 'சம்பளப் பட்டியல்',
      'payroll.detail.gross_salary': 'மொத்த சம்பளம்',
      'payroll.detail.total_deductions': 'மொத்த கழிவுகள்',
      'payroll.query.title': 'சம்பளப் பட்டியல் கேள்விகள்',
      'payroll.query.tab_my': 'என் கேள்விகள்',
      'payroll.query.tab_raise': 'கேள்வி எழுப்பு',
      'payroll.query.empty': 'இதுவரை கேள்விகள் எழுப்பப்படவில்லை',
      'payroll.query.submit_button': 'கேள்வி சமர்ப்பி',
      // REVIEW: financial confirmation
      'payroll.query.submitted_success': 'கேள்வி வெற்றிகரமாக எழுப்பப்பட்டது!',
      'payroll.tax_summary.title': 'வருடாந்திர வரி சுருக்கம்',
      'payroll.declaration.title': 'வரி அறிவிப்பு (80C/80D)',
      'payroll.declaration.submit_button': 'அறிவிப்பு சமர்ப்பி',
      // REVIEW: financial confirmation
      'payroll.declaration.submitted_success':
          'அறிவிப்பு வெற்றிகரமாக சமர்ப்பிக்கப்பட்டது!',
      // HR
      'hr.dashboard.title': 'HR டாஷ்போர்டு',
      'hr.section.attendance_overview': 'வருகை மேலோட்டம்',
      'hr.section.leave_summary': 'விடுப்பு சுருக்கம்',
      'hr.section.quick_actions': 'விரைவு செயல்கள்',
      'hr.stat.total_staff': 'மொத்த ஊழியர்கள்',
      'hr.stat.present_today': 'இன்று வந்தவர்கள்',
      'hr.stat.on_leave': 'விடுப்பில்',
      'hr.stat.pending_leaves': 'நிலுவையிலுள்ள விடுப்புகள்',
      'hr.action.staff_management': 'ஊழியர் மேலாண்மை',
      'hr.action.staff_directory': 'ஊழியர் பட்டியல்',
      'hr.action.payslips': 'என் சம்பளப் பட்டியல்கள்',
      'staff_mgmt.title': 'ஊழியர் மேலாண்மை',
      'staff_mgmt.add_staff': 'ஊழியர் சேர்',
      'staff_mgmt.no_staff_found': 'ஊழியர் காணப்படவில்லை',
      // REVIEW: HR confirmation
      'staff_mgmt.updated_success': '✅ ஊழியர் வெற்றிகரமாக புதுப்பிக்கப்பட்டார்',
      'performance.title': 'செயல்திறன் மதிப்பீடுகள்',
      'performance.save_review': 'மதிப்பீட்டை சேமி',
      // REVIEW: HR confirmation
      'performance.saved_success': '✅ செயல்திறன் மதிப்பீடு சேமிக்கப்பட்டது',
      'directory.title': 'ஊழியர் பட்டியல்',
      // Reports
      'reports.hub.title': 'அறிக்கைகள் & குற்றச்சாட்டுகள்',
      'reports.hub.incident_title': 'சம்பவ அறிக்கை',
      'reports.hub.grievance_title': 'ஊழியர் குற்றச்சாட்டு',
      'my_reports.title': 'என் அறிக்கைகள்',
      'incident_report.title': 'சம்பவ அறிக்கை',
      // REVIEW: clinical / safety severity wording
      'incident_report.severity.low': 'குறைவு',
      'incident_report.severity.moderate': 'மிதமான',
      'incident_report.severity.severe': 'கடுமையான',
      'incident_report.severity.sentinel': 'செண்டினல்',
      'incident_report.submit_button': 'சம்பவ அறிக்கை சமர்ப்பி',
      // REVIEW: clinical / safety confirmation
      'incident_report.submitted_title': 'அறிக்கை சமர்ப்பிக்கப்பட்டது',
      'grievance.title': 'ஊழியர் குற்றச்சாட்டு',
      'grievance.submit_button': 'குற்றச்சாட்டு சமர்ப்பி',
      // REVIEW: HR confirmation
      'grievance.submitted_title': 'குற்றச்சாட்டு சமர்ப்பிக்கப்பட்டது',
      // Housekeeping
      'housekeeping.hub.title': 'வீட்டு பராமரிப்பு',
      'housekeeping.log.title': 'சுத்தம் பதிவு',
      'housekeeping.submit_log': 'சுத்தம் பதிவை சமர்ப்பி',
      // REVIEW: confirmation
      'housekeeping.logged_title': 'சுத்தம் பதிவு செய்யப்பட்டது',
      'housekeeping.raise_request_button': 'கோரிக்கை எழுப்பு',
      'housekeeping.raised_title': 'கோரிக்கை எழுப்பப்பட்டது',
      'housekeeping.mark_complete': 'முடிக்கப்பட்டதாக குறி',
      // Hospital departments
      'blood_bank.title': 'இரத்த வங்கி',
      'blood_bank.units_suffix': 'அலகுகள்',
      'blood_bank.submit_request': 'கோரிக்கை சமர்ப்பி',
      // REVIEW: clinical confirmation
      'blood_bank.request_success':
          'இரத்த கோரிக்கை வெற்றிகரமாக சமர்ப்பிக்கப்பட்டது',
      'dietary.title': 'உணவு மேலாண்மை',
      'dietary.create_button': 'உருவாக்கு',
      // REVIEW: clinical confirmation
      'dietary.created_success': 'உணவு கட்டளை உருவாக்கப்பட்டது',
      'theatre.title': 'அறுவை சிகிச்சை அறை',
      // REVIEW: clinical-action - surgery
      'theatre.start_surgery': 'அறுவை சிகிச்சையை தொடங்கு',
      'theatre.mark_complete': 'முடிக்கப்பட்டதாக குறி',
      'theatre.preop_checklist': 'அறுவை சிகிச்சைக்கு முன் சரிபார்ப்பு பட்டியல்',
      'radiology.title': 'கதிரியக்கவியல்',
      'radiology.submit_report': 'அறிக்கை சமர்ப்பி',
      'schedule.title': 'பணி அட்டவணை',
      // Lab / Pharmacy
      'investigations.title': 'புலனாய்வுகள்',
      'investigations.upload_button': 'புலனாய்வு பதிவேற்று',
      // REVIEW: clinical confirmation
      'investigations.upload_success':
          '✅ புலனாய்வு முடிவு வெற்றிகரமாக பதிவேற்றப்பட்டது',
      'lab_bookings.title': 'ஆய்வக முன்பதிவுகள்',
      'pharmacy.title': 'மருந்தக கட்டளைகள்',
      'pharmacy.confirm_order': 'கட்டளையை உறுதி செய்',
      'pharmacy.dispatch': 'அனுப்பு',
      'pharmacy.mark_delivered': 'வழங்கப்பட்டதாக குறி',
      // Nursing
      'due_meds.title': 'வரவேண்டிய மருந்துகள்',
      'mar_scan.title': 'மருந்து வழங்கு',
      // REVIEW: clinical-action / safety wording for medication 5-rights
      'mar_scan.right_patient': 'சரியான நோயாளி',
      'mar_scan.right_drug': 'சரியான மருந்து',
      'mar_scan.right_dose': 'சரியான அளவு',
      'mar_scan.right_route': 'சரியான வழி',
      'mar_scan.right_time': 'சரியான நேரம்',
      'mar_scan.administer': 'வழங்கு',
      'mar_scan.recorded': 'வழங்கல் பதிவு செய்யப்பட்டது',
      // Discharge
      'discharge.save_draft': 'வரைவை சேமி',
      // REVIEW: clinical-action confirmation - discharge wording
      'discharge.sign_summary': 'சுருக்கத்தில் கையெழுத்திடு',
      'discharge.sign_button': 'கையெழுத்திடு',
      // REVIEW: clinical-action confirmation
      'discharge.signed_success':
          'டிஸ்சார்ஜ் சுருக்கம் கையெழுத்திடப்பட்டது - இப்போது அதிகாரப்பூர்வம்',
      'discharge.proceed_button': 'டிஸ்சார்ஜ்',
      'discharge.patient_discharged':
          'நோயாளி வெற்றிகரமாக டிஸ்சார்ஜ் செய்யப்பட்டார்',
      // Attendance / Overtime
      'dispute.title': 'வருகை சர்ச்சை',
      'dispute.submit_button': 'சர்ச்சை சமர்ப்பி',
      // REVIEW: HR confirmation
      'dispute.submitted_success':
          '✅ சர்ச்சை சமர்ப்பிக்கப்பட்டது. HR 24 மணி நேரத்திற்குள் மதிப்பாய்வு செய்யும்.',
      'overtime.title': 'கூடுதல் நேர கோரிக்கைகள்',
      'overtime.submit_button': 'கூடுதல் நேர கோரிக்கை சமர்ப்பி',
      // REVIEW: HR confirmation
      'overtime.submitted_success':
          '✅ கூடுதல் நேர கோரிக்கை சமர்ப்பிக்கப்பட்டது',
      // Telemedicine
      'telemedicine.end_call': 'அழைப்பை முடி',
      // Clinical AI
      'clinical_ai.queue.title': 'AI மதிப்பாய்வு வரிசை',
      // REVIEW: clinical-action wording
      'clinical_ai.draft.accept': 'ஏற்றுக்கொள்',
      'clinical_ai.draft.reject_button': 'நிராகரி',
      'clinical_ai.draft.needs_revision': 'திருத்தம் தேவை',
      // REVIEW: clinical-action / security wording - Tamil-fluent clinician must verify
      'clinical_ai.draft.screen_title': 'AI வரைவு மதிப்பாய்வு',
      'clinical_ai.draft.critical_title': 'அவசர பாதுகாப்பு கொடிகள்',
      'clinical_ai.draft.safety_header': 'பாதுகாப்பு கொடிகள்',
      'clinical_ai.draft.body_header': 'வரைவு',
      'clinical_ai.draft.edit_header': 'வரைவை திருத்தவும் (JSON)',
      'clinical_ai.draft.edit_button': 'திருத்து',
      'clinical_ai.draft.cancel_edit_button': 'திருத்தம் ரத்து செய்',
      'clinical_ai.draft.failed_load': 'வரைவை ஏற்ற முடியவில்லை',
      'clinical_ai.draft.patient_prefix': 'நோயாளி:',
      'clinical_ai.draft.admission_prefix': 'அனுமதி:',
      'clinical_ai.draft.status_prefix': 'நிலை:',
      'clinical_ai.draft.provider_prefix': 'வழங்குநர்:',
      // AI Assist - REVIEW: Tamil-fluent clinician must verify
      'ai_assist.title': 'AI உதவி',
      // REVIEW:
      'ai_assist.generate_blurb':
          'இந்த குறிப்பிற்கு நோயாளிக்கான எளிய மொழி விளக்கத்தை உருவாக்கவும். கையெழுத்துக்காக மதிப்பாய்வு வரிசையில் சேரும்.',
      // REVIEW:
      'ai_assist.generate_button': 'நோயாளி விளக்கத்தை உருவாக்கு',
      // REVIEW:
      'ai_assist.note_too_short':
          'விளக்கத்தை உருவாக்க குறிப்பு மிகச் சிறியது (குறைந்தது 30 எழுத்துகள் தேவை).',
      // REVIEW:
      'ai_assist.generating': 'நோயாளி விளக்கம் உருவாக்கப்படுகிறது…',
      // REVIEW:
      'ai_assist.failed_prefix': 'AI உதவி தோல்வி:',
      // REVIEW: clinical-safety - confirm with attending
      'ai_assist.cannot_sign':
          'கையெழுத்திட முடியாது - மதிப்பாய்வு பதிவு உருவாக்கப்படவில்லை (ஸ்கீமா கிடைக்கவில்லை).',
      // REVIEW:
      'ai_assist.reject_title': 'வரைவை நிராகரிக்கவா?',
      // REVIEW:
      'ai_assist.reject_prompt': 'இந்த வரைவு நோயாளிக்கு ஏன் பொருத்தமற்றது?',
      // REVIEW:
      'ai_assist.reject_min_chars':
          'நிராகரிப்புக் காரணம் குறைந்தது 5 எழுத்துகள் கொண்டிருக்க வேண்டும்.',
      // REVIEW:
      'ai_assist.reject_hint': 'எ.கா: அடுத்த-படிகள் பிரிவில் மருத்துவத் தவறு',
      // REVIEW:
      'ai_assist.drawer_title': 'AI நோயாளி விளக்கம்',
      // REVIEW:
      'ai_assist.fallback_banner':
          'மாதிரி பகுப்பாய்வு செய்யக்கூடிய வரைவை வழங்கவில்லை; ஃபால்பேக் வடிவம் காட்டப்படுகிறது. வழங்குநர் கட்டமைப்பைச் சரிபார்த்த பிறகு மீண்டும் உருவாக்கவும்.',
      // REVIEW:
      'ai_assist.key_points': 'முக்கிய அம்சங்கள்',
      // REVIEW:
      'ai_assist.next_steps': 'அடுத்த படிகள்',
      // REVIEW:
      'ai_assist.when_to_seek_help': 'எப்போது உதவி நாடவேண்டும்',
      // REVIEW:
      'ai_assist.needs_edits': 'திருத்தம் தேவை',
      // REVIEW: clinical-safety - confirm with attending
      'ai_assist.accept_sign': 'ஏற்றுக்கொண்டு கையெழுத்திடு',
      // REVIEW:
      'ai_assist.summary': 'சுருக்கம்',
      // REVIEW:
      'ai_assist.empty': '(காலி)',
      // REVIEW:
      'ai_assist.decision_prefix': 'நோயாளி விளக்கம்',
      // REVIEW:
      'ai_assist.sign_failed_prefix': 'கையெழுத்து தோல்வி:',
      // CDS blocker - REVIEW: clinical-safety, Tamil-fluent clinician must verify
      // REVIEW:
      'cds.blocker_title': 'மருந்துச்சீட்டு தடுக்கப்பட்டது',
      // REVIEW:
      'cds.blocker_body':
          'மருத்துவ முடிவு ஆதரவு பின்வரும் சிக்கல்களைக் குறிப்பிட்டுள்ளது. '
          'மருந்துச்சீட்டை திருத்த ரத்து செய்யவும், அல்லது ஆவணப்படுத்தப்பட்ட காரணத்துடன் மீறவும்.',
      // REVIEW:
      'cds.warnings_header': 'எச்சரிக்கைகள்',
      // REVIEW:
      'cds.allergy_hint':
          'ஒவ்வாமை முரண்: இந்த மீறலை அங்கீகரித்த மேற்பார்வை மருத்துவரை உங்கள் காரணத்தில் குறிப்பிடவும்.',
      // REVIEW:
      'cds.override_reason_label':
          'மீறல் காரணம் (தேவை, குறைந்தது 5 எழுத்துகள்)',
      // REVIEW:
      'cds.override_button': 'மீறு',
      // REVIEW:
      'cds.override_save': 'மீறி சேமி',
      // Code Blue - REVIEW: clinical-safety, Tamil-fluent clinician must verify
      // REVIEW:
      'code_blue.title': 'கோட் ப்ளூ',
      // REVIEW:
      'code_blue.respond': 'உடனடியாக பதிலளிக்கவும்.',
      // REVIEW:
      'code_blue.ward_prefix': 'வார்டு:',
      // REVIEW:
      'code_blue.bed_prefix': 'படுக்கை:',
      // REVIEW:
      'code_blue.patient_prefix': 'நோயாளி ID:',
      // REVIEW:
      'code_blue.acknowledge': 'ஒப்புக்கொள்ளப்பட்டது',
      // First-run welcome
      // REVIEW:
      'first_run.welcome_title': 'தெரிந்துகொள்ள வேண்டிய சில குறுக்குவழிகள்',
      // REVIEW:
      'first_run.welcome_dismiss': 'நிராகரி',
      // REVIEW:
      'first_run.welcome_got_it': 'புரிந்தது',
      // REVIEW:
      'first_run.tip_bed_tap':
          'நோயாளி விவரங்கள் மற்றும் விரைவான செயல்களுக்கு பெட் போர்டில் படுக்கை அட்டையைத் தட்டவும்.',
      // REVIEW:
      'first_run.tip_bed_long_press':
          'குறிப்புகளை இன்லைனில் திருத்த படுக்கை அட்டையை நீண்ட நேரம் அழுத்தவும்.',
      // REVIEW:
      'first_run.tip_magnifier_prefix':
          'எந்த தலைப்பிலும் பெரிதாக்கியைப் பயன்படுத்தவும் - அல்லது அழுத்தவும்',
      // REVIEW:
      'first_run.tip_magnifier_suffix':
          '+K - எந்த நோயாளியின் விவரத்திற்கும் செல்ல.',
      // REVIEW:
      'first_run.tip_dashboard':
          'மேலே உள்ள அட்டைகள் நீங்கள் செயல்பட இடங்களுக்கு வழிநடத்தும் - "தேவையான மருந்துகள்", "உள்நோயாளிகள்" போன்றவற்றைத் தட்டவும்.',
      // Splash
      // REVIEW:
      'splash.app_title': 'VHHealth பணியாளர்',
      // REVIEW:
      'splash.device_unsupported_title': 'சாதனம் ஆதரிக்கப்படவில்லை',
      // REVIEW:
      'splash.device_unsupported_body':
          'நோயாளி தரவு பாதுகாப்பிற்காக, VHHealth பணியாளர் இந்த சாதனத்தில் இயங்க முடியாது. காரணம்:',
      // REVIEW:
      'splash.device_unsupported_use_hospital_device':
          'மருத்துவமனை வழங்கிய, மாற்றப்படாத சாதனத்தைப் பயன்படுத்தவும்.',
      // Housekeeping
      // REVIEW:
      'housekeeping.tasks_title': 'என் பணிகள்',
      // REVIEW:
      'housekeeping.sample_notice':
          'மாதிரி பணிகள் காட்டப்படுகின்றன. பின்-முனை API விரைவில் வருகிறது.',
      // REVIEW:
      'housekeeping.task_completed': '✅ பணி முடிந்ததாக குறிக்கப்பட்டது',
      // REVIEW:
      'housekeeping.task_started': 'பணி தொடங்கப்பட்டது',
      // REVIEW:
      'housekeeping.no_tasks': 'இங்கு எந்த பணியும் இல்லை',
      // REVIEW:
      'housekeeping.tab_all': 'அனைத்து',
      // REVIEW:
      'housekeeping.tab_pending': 'நிலுவையில்',
      // REVIEW:
      'housekeeping.tab_done': 'முடிந்தது',
      // REVIEW:
      'housekeeping.action_start': 'தொடங்கு',
      // REVIEW:
      'housekeeping.action_done': 'முடிந்தது',
      // Logout
      // REVIEW:
      'logout.dialog_title': 'வெளியேறவா?',
      // REVIEW:
      'logout.dialog_body':
          'உங்கள் பணியாளர் ID மற்றும் கடவுச்சொல்லுடன் மீண்டும் உள்நுழைய வேண்டும்.',
      // REVIEW:
      'logout.tooltip': 'வெளியேறு',
      // Misc
      // REVIEW:
      'shift_card.no_shift': 'பணி நேரம் ஒதுக்கப்படவில்லை',
      // REVIEW:
      'pharmacy.no_preview': 'முன்னோட்டம் இல்லை',
      // REVIEW:
      'print.generated_by': 'VHHealth பணியாளர் ஆப் வழியாக உருவாக்கப்பட்டது',
      // REVIEW:
      'error.something_went_wrong': 'ஏதோ தவறு நடந்தது',
      // REVIEW:
      'error.restart_or_contact':
          'ஆப்பை மீண்டும் தொடங்கவும் அல்லது ஆதரவைத் தொடர்புகொள்ளவும்.',
      // REVIEW:
      'directory.api_unavailable':
          'பணியாளர் கோப்பகம் API இன்னும் கிடைக்காமல் இருக்கலாம்.',
      // REVIEW:
      'staff_mgmt.list_api_unavailable':
          'பணியாளர் பட்டியல் API இன்னும் கிடைக்காமல் இருக்கலாம்.',
      // REVIEW:
      'appointments.no_today': 'இன்று எந்த சந்திப்பும் இல்லை',

      // First-pass AI fill (2026-05-03); validate before production.
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.payslip.empty_body':
          'ஒவ்வொரு மாதமும் 5ம் தேதி சம்பள சீட்டு வழங்கப்படுகிறது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.payslip.new_badge': 'புதியது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.download_pdf': 'PDF ஐப் பதிவிறக்கு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.pdf_not_available':
          'PDF இன்னும் கிடைக்கவில்லை - பிறகு பார்க்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.pdf_failed_prefix': 'PDF ஐ திறக்க முடியவில்லை:',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.pdf_being_generated':
          'PDF பேஸ்லிப் உருவாக்கப்படுகிறது. அது விரைவில் இங்கே தோன்றும்.',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.pdf_download_button': 'PDF Payslip ஐப் பதிவிறக்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.opening': 'திறக்கிறது...',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.not_found': 'கட்டணச் சீட்டு கிடைக்கவில்லை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.attendance_header': '📅 வருகை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.earnings_header': '💰 வருவாய்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.deductions_header': '📉 விலக்குகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.working_days': 'வேலை நாட்கள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.days_present': 'தற்போதுள்ள நாட்கள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.days_absent': 'இல்லாத நாட்கள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.lop_days': 'ஊதிய நாட்கள் இழப்பு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.leave_days': 'விடுமுறை நாட்கள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.overtime_hours': 'கூடுதல் நேர நேரம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.basic': 'அடிப்படை சம்பளம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.hra': 'HRA',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.da': 'DA',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.special_allowance': 'சிறப்பு கொடுப்பனவு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.transport_allowance': 'போக்குவரத்து கொடுப்பனவு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.medical_allowance': 'மருத்துவ கொடுப்பனவு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.overtime_pay': 'கூடுதல் நேர ஊதியம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.bonus': 'போனஸ்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.arrears': 'நிலுவைத் தொகை செலுத்தப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.lop_deduction': 'ஊதிய இழப்பு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.pf_employee': 'PF (பணியாளர் 12%)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.esi': 'ESI (0.75%)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.professional_tax': 'தொழில்முறை வரி',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.tds': 'டிடிஎஸ்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.detail.advance_deduction': 'சம்பள அட்வான்ஸ் பிடித்தம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.query.replies_header': 'பதில்கள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.query.raise_header': 'Payslip வினவலை எழுப்பவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.query.select_payslip': 'Payslip ஐத் தேர்ந்தெடுக்கவும் *',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.query.choose_payslip_hint': 'பேஸ்லிப்பைத் தேர்ந்தெடுக்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.query.category_label': 'வகை *',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.query.subject_label': 'பொருள் *',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.query.subject_required': 'பொருள் தேவை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.query.description_label': 'விளக்கம் *',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.query.description_required': 'விளக்கம் தேவை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.query.pick_payslip': 'கட்டணச் சீட்டைத் தேர்ந்தெடுக்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.tax_summary.fy_label': 'நிதி ஆண்டு:',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.tax_summary.total_gross': 'மொத்த மொத்த',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.tax_summary.total_net': 'மொத்த நிகரம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.tax_summary.taxable_income': 'வரி விதிக்கக்கூடிய வருமானம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.tax_summary.tax_payable': 'செலுத்த வேண்டிய வரி',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.tax_summary.earnings_breakdown': '💰 வருவாய் முறிவு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.tax_summary.deductions_breakdown': '📉 விலக்குகள் முறிவு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.tax_summary.tax_computation': '🧾 வரி கணக்கீடு (புதிய ஆட்சி)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.tax_summary.standard_deduction': 'குறைவாக: நிலையான விலக்கு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.tax_summary.disclaimer':
          'இது புதிய வரி முறையின் கீழ் கணக்கிடப்பட்ட குறியீடாக மட்டுமே உள்ளது. உண்மையான படிவம் 16 நிதியாண்டின் இறுதியில் உங்கள் முதலாளியால் வழங்கப்படும்.',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.tax_summary.download_pdf': 'PDF ஐப் பதிவிறக்கு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.tax_summary.download_form16': 'படிவம் 16 PDF ஐப் பதிவிறக்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.declaration.estimated_deductions':
          'மதிப்பிடப்பட்ட வரி விலக்குகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.declaration.total_deductions': 'மொத்த விலக்குகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.declaration.section_80c':
          '80C முதலீடுகள் (அதிகபட்சம் ₹1,50,000)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.declaration.section_80d': '80D சுகாதார காப்பீடு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.declaration.section_other': 'பிற விலக்குகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.declaration.section_rent': 'HRA / வாடகை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_ppf': 'PPF',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_epf': 'EPF தன்னார்வ',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_elss': 'ELSS (மியூச்சுவல் ஃபண்டுகள்)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_lic': 'எல்ஐசி பிரீமியம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_nsc': 'என்.எஸ்.சி',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_home_loan_principal': 'வீட்டுக் கடன் அதிபர்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_tuition': 'கல்விக் கட்டணம் (குழந்தைகள்)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_other_80c': 'மற்ற 80C',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_hi_self': 'சுகாதார காப்பீடு - சுய',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_hi_parents': 'சுகாதார காப்பீடு - பெற்றோர்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_nps': 'NPS பங்களிப்பு (80CCD)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_home_loan_interest':
          'வீட்டுக் கடன் வட்டி (24b)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_edu_loan': 'கல்வி கடன் வட்டி (80E)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_rent_monthly':
          'மாதாந்திர வாடகை செலுத்தப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.declaration.rent_receipts': 'வாடகை ரசீதுகள் வழங்கப்பட்டன',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.declaration.past_title': 'கடந்த கால பிரகடனங்கள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'payroll.declaration.fy_submitted': 'சமர்ப்பிக்கப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'hr.timeframe.this_month': 'இந்த மாதம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'hr.timeframe.last_month': 'கடந்த மாதம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'hr.timeframe.this_quarter': 'இந்த காலாண்டு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'hr.timeframe.this_year': 'இந்த ஆண்டு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'hr.avg_attendance_rate': 'சராசரி வருகை விகிதம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'hr.late_arrivals': 'தாமதமான வருகைகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'hr.absentees': 'வராதவர்கள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'hr.total_applications': 'மொத்த பயன்பாடுகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'hr.approved': 'அங்கீகரிக்கப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'hr.rejected': 'நிராகரிக்கப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'hr.pending_approval': 'ஒப்புதல் நிலுவையில் உள்ளது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'hr.action.staff_management.subtitle':
          'பணியாளர்களைப் பார்க்கவும், சேர்க்கவும் & திருத்தவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'hr.action.performance': 'செயல்திறன் விமர்சனங்கள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'hr.action.performance.subtitle': 'செயல்திறன் பதிவுகளை நிர்வகிக்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'hr.action.staff_directory.subtitle':
          'அனைத்து பணியாளர் உறுப்பினர்களையும் உலாவவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'hr.action.reports': 'அறிக்கைகள் & குறைகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'hr.action.reports.subtitle': 'சம்பவ அறிக்கைகள், ஊழியர்களின் குறைகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'hr.action.payslips.subtitle':
          'கடந்த 3 மாதங்களில் பார்க்கவும் பதிவிறக்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'staff_mgmt.search_hint': 'பெயர், துறை, பங்கு மூலம் தேடுங்கள்...',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'staff_mgmt.edit_staff': 'பணியாளர்களை திருத்தவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'staff_mgmt.full_name': 'முழுப் பெயர்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'staff_mgmt.name_required': 'பெயர் தேவை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'staff_mgmt.department': 'துறை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'staff_mgmt.clear_filter': 'வடிகட்டியை அகற்று',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'staff_mgmt.active': 'செயலில்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'staff_mgmt.inactive': 'செயலற்றது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'staff_mgmt.no_staff_members': 'ஊழியர்கள் இல்லை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'staff_mgmt.search_empty': 'வேறு தேடல் சொல்லை முயற்சிக்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'staff_mgmt.api_pending':
          'API இணைக்கப்பட்டவுடன் பணியாளர் தரவு இங்கே தோன்றும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'staff_mgmt.added_pending':
          '✅ பணியாளர்கள் சேர்க்கப்பட்டனர் (பின்னணி API நிலுவையில் உள்ளது)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'performance.tab.add': 'மதிப்பாய்வைச் சேர்க்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'performance.tab.reviews': 'விமர்சனங்கள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'performance.employee_id_label': 'பணியாளர் ஐடி',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'performance.employee_id_hint': 'எ.கா. EMP-001',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'performance.employee_id_required': 'பணியாளர் ஐடி தேவை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'performance.review_period_label': 'மதிப்பாய்வு காலம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'performance.overall_rating': 'ஒட்டுமொத்த மதிப்பீடு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'performance.comments_label': 'செயல்திறன் கருத்துகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'performance.comments_hint':
          'செயல்திறன், சாதனைகள், முன்னேற்றத்தின் பகுதிகளை விவரிக்கவும்...',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'performance.comments_required': 'கருத்துகள் தேவை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'performance.goals_label': 'அடுத்த காலத்திற்கான இலக்குகள் (விரும்பினால்)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'performance.goals_hint':
          'இலக்குகளையும் எதிர்பார்ப்புகளையும் அமைக்கவும்...',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'performance.saving_button': 'சேமிக்கிறது...',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'performance.rating.exceptional': 'விதிவிலக்கானது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'performance.rating.exceeds': 'எதிர்பார்ப்புகளை மீறுகிறது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'performance.rating.meets': 'எதிர்பார்ப்புகளை சந்திக்கிறது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'performance.rating.needs_improvement': 'முன்னேற்றம் தேவை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'performance.rating.unsatisfactory': 'திருப்தியற்றது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'performance.no_reviews': 'இதுவரை விமர்சனங்கள் இல்லை',
      'directory.search_hint': 'பெயர், துறை, பங்கு மூலம் தேடவும்...',
      'directory.empty': 'கோப்பகம் காலியாக உள்ளது',
      'directory.search_empty': 'வேறு தேடல் சொல்லை முயற்சிக்கவும்',
      'directory.api_pending':
          'API இணைக்கப்பட்டவுடன் ஊழியர்கள் இங்கு தோன்றுவார்கள்',
      'directory.staff_empty_body': 'ஊழியர்கள் இல்லை',
      'reports.hub.confidentiality_note':
          'அனைத்து அறிக்கைகளும் ரகசியமாக கையாளப்படுகின்றன. செய்தியாளர்களை பழிவாங்குவது கண்டிப்பாக தடைசெய்யப்பட்டுள்ளது.',
      'reports.hub.prompt': 'நீங்கள் என்ன புகாரளிக்க விரும்புகிறீர்கள்?',
      'reports.hub.incident_subtitle':
          'நோயாளியின் வீழ்ச்சி, மருந்துப் பிழை, அருகில் தவறுதல், உபகரணங்கள் செயலிழப்பு அல்லது ஏதேனும் பாதகமான நிகழ்வு',
      'reports.hub.incident_note':
          'சென்டினல்/கடுமையான நிகழ்வுகள் உடனடியாக அதிகரிக்கப்படும்',
      'reports.hub.grievance_subtitle':
          'துன்புறுத்தல், நியாயமற்ற சிகிச்சை, பாதுகாப்பற்ற பணி நிலைமைகள் அல்லது கொள்கை மீறல்கள்',
      'reports.hub.grievance_note':
          'பெயர் குறிப்பிடாமல் சமர்ப்பிக்கலாம். HR மட்டும்.',
      'reports.hub.my_reports': 'எனது அறிக்கைகள் & நிலை',
      'my_reports.tab.incidents': 'சம்பவங்கள்',
      'my_reports.tab.grievances': 'குறைகள்',
      'my_reports.empty_incidents': 'சம்பவ அறிக்கைகள் இல்லை',
      'my_reports.empty_grievances': 'புகார்கள் எதுவும் பதிவு செய்யப்படவில்லை',
      'my_reports.label.status': 'நிலை',
      'my_reports.label.severity': 'தீவிரம்',
      'my_reports.label.type': 'வகை',
      'my_reports.label.location': 'இடம்',
      'my_reports.label.description': 'விளக்கம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.severity_label': 'தீவிரம் *',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.severity.low_desc':
          'சிறியது, எந்த பாதிப்பும் ஏற்படவில்லை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.severity.moderate_desc':
          'சில பாதிப்புகள், உள்நாட்டில் நிர்வகிக்கப்படுகின்றன',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.severity.severe_desc':
          'குறிப்பிடத்தக்க தீங்கு, விசாரணை தேவை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.severity.sentinel_desc':
          'எதிர்பாராத மரணம் அல்லது கடுமையான தீங்கு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.type_label': 'சம்பவ வகை *',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.type.near_miss': 'மிஸ் அருகில்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.type.patient_fall': 'நோயாளி வீழ்ச்சி',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.type.medication_error': 'மருந்து பிழை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.type.needle_stick': 'ஊசி குச்சி / கூர்மையான காயம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.type.equipment_failure': 'உபகரணங்கள் செயலிழப்பு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.type.infection': 'தொற்று / வெளிப்பாடு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.type.fire_safety': 'தீ / பாதுகாப்பு ஆபத்து',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.type.patient_aggression': 'நோயாளி ஆக்கிரமிப்பு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.type.security_breach': 'பாதுகாப்பு மீறல்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.type.other': 'மற்றவை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.title_label': 'சுருக்கமான தலைப்பு *',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.title_hint':
          'எ.கா. 12B படுக்கைக்கு அருகில் நோயாளி விழுந்தார்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.title_required': 'தலைப்பு தேவை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.what_happened': 'என்ன நடந்தது? *',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.what_happened_hint':
          'சம்பவத்தை விரிவாக விவரிக்கவும் - என்ன நடந்தது, யார் சம்பந்தப்பட்டவர்கள், நிலைமைகள் என்ன...',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.description_required': 'விளக்கம் தேவை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.date_label': 'தேதி *',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.time_label': 'நேரம்*',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.location_label': 'இடம் (விரும்பினால்)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.location_hint': 'வார்டு, அறை அல்லது பகுதி',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.patient_involved': 'நோயாளி சம்பந்தப்பட்டவர்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.patient_name_label': 'நோயாளி பெயர் / ஐடி (விரும்பினால்)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.witnesses_label': 'சாட்சிகள் (விரும்பினால்)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.witnesses_hint': 'சம்பவத்தைப் பார்த்தவர்களின் பெயர்கள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.immediate_action':
          'உடனடி நடவடிக்கை எடுக்கப்பட்டது (விரும்பினால்)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.immediate_action_hint':
          'சம்பவம் நடந்த உடனேயே என்ன செய்யப்பட்டது?',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.anonymous': 'அநாமதேயமாக சமர்ப்பிக்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.anonymous_note':
          'இந்த அறிக்கையில் உங்கள் பெயர் இணைக்கப்படாது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.escalation_note':
          'இது உயர் முன்னுரிமையாக அதிகரிக்கப்பட்டது. நிர்வாகத்திற்கு அறிவிக்கப்பட்டுள்ளது.',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.routine_note':
          'உங்கள் அறிக்கை பெறப்பட்டது மற்றும் 24 மணிநேரத்திற்குள் மதிப்பாய்வு செய்யப்படும்.',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'incident_report.done_button': 'முடிந்தது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'grievance.privacy_note':
          'இந்தப் படிவம் HR மற்றும் மூத்த நிர்வாகத்தால் மட்டுமே பார்க்கப்படுகிறது. நீங்கள் அநாமதேயமாக சமர்ப்பிக்கலாம்.',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'grievance.type_label': 'புகார் வகை *',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'grievance.type.harassment': 'தொல்லை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'grievance.type.discrimination': 'பாகுபாடு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'grievance.type.unfair_treatment': 'நியாயமற்ற சிகிச்சை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'grievance.type.unsafe_conditions': 'பாதுகாப்பற்ற வேலை நிலைமைகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'grievance.type.workload': 'அதிகப்படியான பணிச்சுமை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'grievance.type.pay_dispute': 'ஊதியம் / இழப்பீடு தகராறு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'grievance.type.schedule_conflict': 'அட்டவணை / பட்டியல் மோதல்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'grievance.type.policy_violation': 'கொள்கை மீறல்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'grievance.type.other': 'மற்றவை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'grievance.subject_label': 'பொருள் *',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'grievance.subject_hint': 'உங்கள் கவலையின் சுருக்கமான சுருக்கம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'grievance.subject_required': 'பொருள் தேவை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'grievance.describe_label': 'உங்கள் குறையை விவரிக்கவும் *',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'grievance.describe_hint':
          'நீங்கள் பகிர்ந்து கொள்ள வசதியாக இருக்கும் அளவு விவரங்களை வழங்கவும்...',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'grievance.description_required': 'விளக்கம் தேவை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'grievance.against_whom_label': 'யாருக்கு எதிராக (விரும்பினால்)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'grievance.against_whom_hint': 'பெயர் அல்லது பங்கு, பொருந்தினால்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'grievance.dept_label': 'துறை (விரும்பினால்)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'grievance.date_optional': 'இது எப்போது ஏற்பட்டது? (விரும்பினால்)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'grievance.date_prefix': 'இது எப்போது நடந்தது:',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'grievance.anonymous': 'அநாமதேயமாக சமர்ப்பிக்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'grievance.anonymous_note': 'உங்கள் அடையாளம் வெளியிடப்படாது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'grievance.acknowledgement_note':
          'உங்கள் புகார் பெறப்பட்டது. HR 2 வேலை நாட்களுக்குள் ஒப்புக் கொள்ளும்.',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'grievance.acknowledgement_anonymous':
          'அநாமதேயமாக சமர்ப்பிக்கப்பட்டது. HR 2 வேலை நாட்களுக்குள் ஒப்புக் கொள்ளும்.',
      'housekeeping.hub.log_title': 'பதிவு சுத்தம்',
      'housekeeping.hub.log_subtitle':
          'புகைப்பட ஆதாரத்துடன் முடிக்கப்பட்ட சுத்திகரிப்பு பதிவு',
      'housekeeping.hub.raise_title': 'கோரிக்கையை எழுப்புங்கள்',
      'housekeeping.hub.raise_subtitle':
          'அழுக்குப் பகுதியைப் புகாரளிக்கவும் அல்லது சுத்தம் செய்யக் கோரவும்',
      'housekeeping.hub.my_title': 'எனது செயல்பாடு',
      'housekeeping.hub.my_subtitle':
          'உங்கள் பதிவுகள், ஒதுக்கப்பட்ட பணிகள் மற்றும் கோரிக்கைகளைப் பார்க்கவும்',
      'housekeeping.log.type_label': 'சுத்தம் செய்யும் வகை*',
      'housekeeping.type.routine': 'வழக்கமான சுத்தம்',
      'housekeeping.type.deep': 'ஆழமான சுத்தம்',
      'housekeeping.type.disinfection': 'கிருமி நீக்கம்',
      'housekeeping.type.spillage': 'கசிவு சுத்தம் செய்தல்',
      'housekeeping.type.post_procedure': 'பிந்தைய நடைமுறை',
      'housekeeping.zone_location_label': 'மண்டலம் / இடம் *',
      'housekeeping.select_zone_label': 'மண்டலத்தைத் தேர்ந்தெடு (விரும்பினால்)',
      'housekeeping.select_zone_or_type':
          '-- தேர்ந்தெடுக்கவும் அல்லது கீழே தட்டச்சு செய்யவும் --',
      'housekeeping.describe_location': 'அல்லது சரியான இடத்தை விவரிக்கவும்',
      'housekeeping.location_hint': 'எ.கா. அறை 204, லிப்ட் அருகில் தாழ்வாரம்',
      'housekeeping.photo_evidence': 'புகைப்பட ஆதாரம்',
      'housekeeping.take_photo': 'புகைப்படம் எடுக்க தட்டவும்',
      'housekeeping.notes_label': 'குறிப்புகள் (விரும்பினால்)',
      'housekeeping.submitting_log': 'சமர்ப்பிக்கிறது...',
      'housekeeping.select_zone_error':
          'ஒரு மண்டலத்தைத் தேர்ந்தெடுக்கவும் அல்லது இருப்பிடத்தை உள்ளிடவும்',
      'housekeeping.logged_body':
          'உங்கள் துப்புரவுப் பதிவு கையொப்பமிடப்பட்டு சமர்ப்பிக்கப்பட்டது.',
      'housekeeping.done_button': 'முடிந்தது',
      'housekeeping.raise.title': 'கோரிக்கையை எழுப்புங்கள்',
      'housekeeping.raise.type_label': 'கோரிக்கை வகை *',
      'housekeeping.raise.urgency_label': 'அவசரம்*',
      'housekeeping.request_type.cleaning': 'பொது சுத்தம்',
      'housekeeping.request_type.spillage': 'கசிவு / கசிவு',
      'housekeeping.request_type.waste': 'கழிவு நீக்கம்',
      'housekeeping.request_type.linen': 'கைத்தறி / படுக்கை',
      'housekeeping.request_type.disinfection': 'கிருமி நீக்கம்',
      'housekeeping.request_type.other': 'மற்றவை',
      'housekeeping.description_label': 'விளக்கம் (விரும்பினால்)',
      'housekeeping.description_hint': 'கவனம் தேவை என்ன?',
      'housekeeping.problem_photo': 'சிக்கலின் புகைப்படம் (விரும்பினால்)',
      'housekeeping.photograph_problem': 'சிக்கலைப் படம்பிடிக்க தட்டவும்',
      'housekeeping.raising_button': 'உயர்த்துகிறது...',
      'housekeeping.notified_note':
          'வீட்டு பராமரிப்பு ஊழியர்களுக்கு அறிவிக்கப்படும்.',
      'housekeeping.my.title': 'எனது செயல்பாடு',
      'housekeeping.my.tab_logs': 'எனது பதிவுகள்',
      'housekeeping.my.tab_requests': 'கோரிக்கைகள்',
      'housekeeping.my.tab_raised': 'என்னால் வளர்க்கப்பட்டது',
      'housekeeping.my.tab_assigned': 'எனக்கு ஒதுக்கப்பட்டது',
      'housekeeping.no_logs': 'இன்னும் சுத்தம் செய்யும் பதிவுகள் இல்லை',
      'housekeeping.no_requests': 'இங்கே கோரிக்கைகள் இல்லை',
      'housekeeping.unknown_location': 'தெரியாத இடம்',
      'housekeeping.complete_dialog_title': 'முழுமையானதாகக் குறிக்கவும்',
      'housekeeping.completion_notes': 'நிறைவு குறிப்புகள் (விரும்பினால்)',
      'housekeeping.add_completion_photo': 'நிறைவு புகைப்படத்தைச் சேர்க்கவும்',
      'housekeeping.marked_complete': '✅ கோரிக்கை முடிந்ததாகக் குறிக்கப்பட்டது',
      'housekeeping.status.verified': 'சரிபார்க்கப்பட்டது',
      'housekeeping.status.flagged': 'கொடியேற்றப்பட்டது',
      'housekeeping.status.submitted': 'சமர்ப்பிக்கப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'blood_bank.tab.inventory': 'சரக்கு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'blood_bank.tab.requests': 'கோரிக்கைகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'blood_bank.tab.donations': 'நன்கொடைகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'blood_bank.refresh_tooltip': 'சரக்குகளைப் புதுப்பிக்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'blood_bank.legend.adequate': '>= 10 அலகுகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'blood_bank.legend.low': '5-9 அலகுகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'blood_bank.legend.critical': '< 5 அலகுகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'blood_bank.stock.critical_low': 'முக்கியமான குறைவு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'blood_bank.stock.low': 'குறைந்த இருப்பு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'blood_bank.stock.adequate': 'போதுமானது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'blood_bank.request_header': 'இரத்தத்தைக் கோருங்கள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'blood_bank.patient_name_label': 'நோயாளி பெயர்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'blood_bank.patient_name_required': 'நோயாளியின் பெயர் தேவை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'blood_bank.blood_type_label': 'இரத்த வகை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'blood_bank.blood_type_required': 'இரத்த வகையைத் தேர்ந்தெடுக்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'blood_bank.units_label': 'அலகுகள் தேவை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'blood_bank.units_required': 'அலகுகள் தேவை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'blood_bank.units_invalid': 'சரியான எண்ணை உள்ளிடவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'blood_bank.reason_label': 'காரணம் / குறிப்புகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'blood_bank.submitting_button': 'சமர்ப்பிக்கிறது...',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'blood_bank.donations.title': 'நன்கொடை பதிவுகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'blood_bank.donations.body':
          'இரத்த தான பதிவுகளைப் பார்த்து நிர்வகிக்கவும்.\nஇந்தப் பிரிவு நன்கொடை வரலாறு மற்றும் வரவிருக்கும் நன்கொடை இயக்ககங்களைக் காண்பிக்கும்.',
      'dietary.refresh_tooltip': 'பணிப்பட்டியலைப் புதுப்பிக்கவும்',
      'dietary.new_order_button': 'புதிய ஆர்டர்',
      'dietary.new_order_dialog': 'புதிய உணவு முறை',
      'dietary.patient_uid_label': 'நோயாளி UID',
      'dietary.patient_uid_required': 'தேவை',
      'dietary.diet_type_label': 'உணவு வகை',
      'dietary.diet_type_required': 'உணவு வகையைத் தேர்ந்தெடுக்கவும்',
      'dietary.meal_time_label': 'உணவு நேரம்',
      'dietary.meal_time_required': 'உணவு நேரத்தைத் தேர்ந்தெடுக்கவும்',
      'dietary.restrictions_label': 'கட்டுப்பாடுகள் / ஒவ்வாமை',
      'dietary.notes_label': 'குறிப்புகள்',
      'dietary.discontinued_success': 'டயட் ஆர்டர் நிறுத்தப்பட்டது',
      'dietary.discontinue': 'நிறுத்து',
      'dietary.diet.regular': 'வழக்கமான',
      'dietary.diet.diabetic': 'நீரிழிவு நோயாளி',
      'dietary.diet.cardiac': 'கார்டியாக்',
      'dietary.diet.renal': 'சிறுநீரகம்',
      'dietary.diet.soft': 'மென்மையானது',
      'dietary.diet.liquid': 'திரவம்',
      'dietary.diet.npo': 'NPO',
      'dietary.diet.enteral': 'என்டரல்',
      'dietary.meal.breakfast': 'காலை உணவு',
      'dietary.meal.lunch': 'மதிய உணவு',
      'dietary.meal.dinner': 'இரவு உணவு',
      'dietary.meal.snack': 'சிற்றுண்டி',
      'dietary.empty_title': 'உணவு உத்தரவுகள் இல்லை',
      'dietary.empty_body':
          'புதிய ஆர்டரை உருவாக்க கீழே உள்ள பொத்தானைத் தட்டவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.pick_date': 'தேதியைத் தேர்ந்தெடுக்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.tab.schedule': 'அட்டவணை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.tab.availability': 'கிடைக்கும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.no_surgeries': 'அறுவை சிகிச்சைகள் எதுவும் திட்டமிடப்படவில்லை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.no_room_data': 'அறை தரவு இல்லை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.status.scheduled': 'திட்டமிடப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.status.in_progress': 'செயல்பாட்டில் உள்ளது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.status.completed': 'முடிக்கப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.status.cancelled': 'ரத்து செய்யப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.surgeon_prefix': 'அறுவை சிகிச்சை நிபுணர்:',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.label.patient_uid': 'நோயாளி UID',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.label.procedure_code': 'நடைமுறை குறியீடு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.label.ot_room': 'OT அறை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.label.date': 'தேதி',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.label.time': 'நேரம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.label.duration': 'கால அளவு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.label.surgeon': 'அறுவை சிகிச்சை நிபுணர்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.label.anesthetist': 'மயக்க மருந்து நிபுணர்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.label.status': 'நிலை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.label.blood_arranged': 'இரத்த ஏற்பாடு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.label.consent': 'சம்மதம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.label.equipment': 'உபகரணங்கள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.cancel_button': 'ரத்து செய்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.checklist.consent': 'ஒப்புதல் பெறப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.checklist.blood': 'இரத்த ஏற்பாடு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.checklist.equipment': 'உபகரணங்கள் சரிபார்க்கப்பட்டன',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.checklist.patient_id': 'நோயாளி அடையாளம் காணப்பட்டார்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.submit_checklist': 'சரிபார்ப்புப் பட்டியலைச் சமர்ப்பிக்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.checklist_updated': 'சரிபார்ப்பு பட்டியல் புதுப்பிக்கப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.status_updated_to': 'நிலை புதுப்பிக்கப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.yes': 'ஆம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.no': 'இல்லை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.available': 'கிடைக்கும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'theatre.occupied': 'ஆக்கிரமிக்கப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'radiology.filters_tooltip': 'வடிப்பான்கள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'radiology.filters_header': 'வடிப்பான்கள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'radiology.status_label': 'நிலை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'radiology.modality_label': 'மாடலிட்டி',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'radiology.status.all': 'அனைத்து',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'radiology.status.pending': 'நிலுவையில் உள்ளது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'radiology.status.in_progress': 'செயல்பாட்டில் உள்ளது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'radiology.status.completed': 'முடிக்கப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'radiology.status.cancelled': 'ரத்து செய்யப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'radiology.no_orders': 'கதிரியக்க உத்தரவுகள் இல்லை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'radiology.label.study_type': 'படிப்பு வகை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'radiology.label.modality': 'மாடலிட்டி',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'radiology.label.body_part': 'உடல் பகுதி',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'radiology.label.priority': 'முன்னுரிமை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'radiology.label.clinical_indication': 'மருத்துவ அறிகுறி',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'radiology.label.notes': 'குறிப்புகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'radiology.label.report': 'அறிக்கை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'radiology.label.findings': 'கண்டுபிடிப்புகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'radiology.label.impression': 'இம்ப்ரெஷன்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'radiology.cancel_order': 'ஆர்டரை ரத்து செய்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'radiology.findings_required': 'கண்டுபிடிப்புகள் தேவை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'radiology.report_submitted': 'அறிக்கை சமர்ப்பிக்கப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'radiology.order_cancelled': 'ஆர்டர் ரத்து செய்யப்பட்டது',
      'schedule.prev_week': 'முந்தைய வாரம்',
      'schedule.next_week': 'அடுத்த வாரம்',
      'schedule.week_this': 'இந்த வாரம்',
      'schedule.week_next': 'அடுத்த வாரம்',
      'schedule.week_last': 'போன வாரம்',
      'schedule.total_label': 'மொத்தம்',
      'schedule.days_logged': 'பதிவு செய்யப்பட்ட நாட்கள்',
      'schedule.hours_worked_suffix': 'h வேலை செய்தார்',
      'schedule.upcoming': 'வரவிருக்கிறது',
      'schedule.no_record': 'பதிவு இல்லை',
      'schedule.load_failed_prefix': 'அட்டவணையை ஏற்ற முடியவில்லை:',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'investigations.tab.upload': 'முடிவைப் பதிவேற்றவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'investigations.tab.pending': 'நிலுவையில் உள்ளது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'investigations.tab.recent': 'சமீபத்திய',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'investigations.upload_intro':
          'தொலைபேசி எண் மூலம் நோயாளியைத் தேடி, அவர்களின் விசாரணை முடிவுகளைப் பதிவேற்றவும்.',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'investigations.phone_label': 'நோயாளியின் தொலைபேசி எண்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'investigations.phone_hint': '+91 XXXXX XXXXX',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'investigations.phone_required': 'தொலைபேசி தேவை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'investigations.phone_invalid': 'சரியான தொலைபேசி எண்ணை உள்ளிடவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'investigations.test_type_label': 'சோதனை வகை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'investigations.test_type_required': 'சோதனை வகையைத் தேர்ந்தெடுக்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'investigations.result_label': 'முடிவு / சுருக்கம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'investigations.result_hint':
          'சோதனை முடிவுகள் அல்லது சுருக்கத்தை உள்ளிடவும்...',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'investigations.clinical_notes_label':
          'மருத்துவ குறிப்புகள் (விரும்பினால்)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'investigations.clinical_notes_hint': 'கூடுதல் அவதானிப்புகள்...',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'investigations.attach_report':
          'அறிக்கை கோப்பை இணைக்கவும் (விரும்பினால்)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'investigations.clear_file': 'தெளிவு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'investigations.file_too_large':
          'கோப்பு மிகவும் பெரியது. அதிகபட்ச அளவு 10 எம்பி.',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'investigations.file_pick_failed': 'கோப்பைத் தேர்ந்தெடுக்க முடியவில்லை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'investigations.uploading': 'பதிவேற்றுகிறது...',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'investigations.pending_empty': 'நிலுவையில் விசாரணைகள் இல்லை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'investigations.pending_empty_body': 'எல்லாம் பிடிபட்டது!',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'investigations.recent_empty': 'சமீபத்திய விசாரணைகள் இல்லை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'investigations.recent_empty_body':
          'உங்கள் விசாரணைப் பதிவேற்றங்கள் இங்கே தோன்றும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'investigations.start_button': 'தொடங்கு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'investigations.complete_button': 'நிறைவு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'investigations.marked_as_prefix': '✅ விசாரணை எனக் குறிக்கப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'lab_bookings.tab.new': 'புதியது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'lab_bookings.tab.active': 'செயலில்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'lab_bookings.tab.done': 'முடிந்தது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'lab_bookings.empty_prefix': 'முன்பதிவு இல்லை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'lab_bookings.view_slip': 'மருந்துச் சீட்டைப் பார்க்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'lab_bookings.home_collection': 'வீடு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'lab_bookings.walk_in': 'வாக்-இன்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'lab_bookings.confirm_dialog': 'முன்பதிவை உறுதிப்படுத்தவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'lab_bookings.actual_tests_label': 'உண்மையான சோதனைகள் (வேறுபட்டால்)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'lab_bookings.actual_tests_hint':
          'சோதனைப் பெயர்களைச் சரிபார்க்கவும்/சேர்க்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'lab_bookings.final_cost_label': 'இறுதி விலை (₹)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'lab_bookings.confirm_button': 'உறுதிப்படுத்தவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'lab_bookings.confirmed_toast': 'முன்பதிவு உறுதி செய்யப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'lab_bookings.dispatch_dialog': 'அனுப்பு கலெக்டர்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'lab_bookings.collector_phone': 'கலெக்டர் போன்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'lab_bookings.dispatch_button': 'அனுப்பு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'lab_bookings.dispatched_toast': 'கலெக்டர் அனுப்பி வைத்தார்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'lab_bookings.sharing_location': '📍 இருப்பிடத்தைப் பகிர்கிறது...',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'lab_bookings.mark_collected': 'மார்க் சேகரிக்கப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'lab_bookings.samples_collected_toast': 'மாதிரிகள் சேகரிக்கப்பட்டன',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'lab_bookings.start_processing': 'செயலாக்கத்தைத் தொடங்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'lab_bookings.processing_started_toast': 'செயலாக்கம் தொடங்கியது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'lab_bookings.upload_result': 'முடிவைப் பதிவேற்றவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'lab_bookings.select_file': 'கோப்பைத் தேர்ந்தெடுக்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'lab_bookings.result_uploaded_toast': 'முடிவு பதிவேற்றப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'lab_bookings.view_result': 'முடிவைப் பார்க்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.queue_title': 'மருந்தக வரிசை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.queue_subtitle': 'ஆர்டர்கள் வரிசையில் நிற்கின்றன',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.tab.new': 'புதியது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.tab.active': 'செயலில்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.tab.done': 'முடிந்தது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.empty.new': 'புதிய ஆர்டர்கள் இல்லை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.empty.active': 'செயலில் ஆர்டர்கள் இல்லை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.empty.done': 'பூர்த்தி செய்யப்பட்ட ஆர்டர்கள் இல்லை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.confirm_dialog': 'ஆர்டரை உறுதிப்படுத்தவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.patient_note_prefix': 'நோயாளி குறிப்பு:',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.items_label':
          'பொருட்கள் (ஒரு வரிக்கு ஒன்று: பெயர், அளவு, விலை)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.items_hint': 'டோலோ 650, 2, 60\nபான் 40, 1, 95',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.total_cost_label': 'மொத்த செலவு (₹)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.view_confirm': 'பார்க்கவும் மற்றும் உறுதிப்படுத்தவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.start_preparing': 'தயார் செய்யத் தொடங்குங்கள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.dispatch_dialog': 'அனுப்புதல் உத்தரவு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.delivery_person_name': 'டெலிவரி நபர் பெயர்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.delivery_person_phone': 'டெலிவரி நபர் தொலைபேசி',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.mark_delivered_dialog': 'மார்க் வழங்கப்பட்டது?',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.mark_delivered_yes': 'ஆம், வழங்கப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.cancel_dialog': 'ஆர்டரை ரத்து செய்யவா?',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.cancellation_reason': 'ரத்து செய்வதற்கான காரணம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.delivery_type.pickup': 'பிக்கப்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.delivery_type.delivery': 'டெலிவரி',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.order_confirmed_toast': 'ஆர்டர் உறுதி செய்யப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.mark_preparing_toast': 'தயார் என குறிக்கப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.order_dispatched_toast': 'ஆர்டர் அனுப்பப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.order_delivered_toast': 'வழங்கப்பட்டதாகக் குறிக்கப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.order_cancelled_toast': 'ஆர்டர் ரத்து செய்யப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.status.placed': 'வைக்கப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.status.confirmed': 'உறுதி செய்யப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.status.preparing': 'தயாராகிறது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.status.dispatched': 'அனுப்பப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.status.delivered': 'வழங்கப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'pharmacy.status.cancelled': 'ரத்து செய்யப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'due_meds.search_hint': 'நோயாளி அல்லது மருந்து மூலம் தேடுங்கள்...',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'due_meds.empty_title': 'மருந்துகள் இல்லை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'due_meds.empty_body':
          'உயிர்களை பதிவு செய்ய படுக்கை பலகையில் ஒரு படுக்கையைத் தட்டவும்.',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'due_meds.held_badge': 'நடைபெற்றது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'due_meds.unknown_patient': 'தெரியாத நோயாளி',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'due_meds.unnamed_medication': '(பெயரிடப்படாத மருந்து)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'mar_scan.step1_prompt':
          'படி 1 இல் 3 - நோயாளியின் மணிக்கட்டை ஸ்கேன் செய்யவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'mar_scan.step1_subtitle':
          'நோயாளியின் ரிஸ்ட் பேண்டில் உள்ள QR குறியீட்டில் கேமராவைச் சுட்டி.',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'mar_scan.step2_prompt': 'படி 2 இல் 3 - மருந்து பார்கோடு ஸ்கேன்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'mar_scan.step2_subtitle':
          'இப்போது மருந்து லேபிளில் உள்ள பார்கோடை ஸ்கேன் செய்யவும்.',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'mar_scan.step3_header': 'படி 3 இல் 3 - 5-உரிமைகள் சரிபார்ப்பு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'mar_scan.recording': 'பதிவு செய்கிறது…',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'mar_scan.check_failed': '5-உரிமைகள் சரிபார்ப்பு தோல்வியடைந்தது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'mar_scan.override_hint':
          'இந்த நிர்வாகத்தை பதிவு செய்ய, காரணத்தை ஆவணப்படுத்தவும். இந்த பதிவு தணிக்கை செய்யப்பட்டது.',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'mar_scan.override_reason_label':
          'காரணத்தை மீறு (தேவை, குறைந்தபட்சம் 5 எழுத்துகள்)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'mar_scan.override_button': 'மேலெழுந்து நிர்வகி',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'mar_scan.scan_next': 'அடுத்த டோஸை ஸ்கேன் செய்யவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'mar_scan.scan_again': 'மீண்டும் ஸ்கேன் செய்யவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'mar_scan.try_again': 'மீண்டும் முயற்சிக்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'mar_scan.unknown_medication': '(தெரியாத மருந்து)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'discharge.title_prefix': 'வெளியேற்றம் -',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'discharge.draft_saved': 'வரைவு சேமிக்கப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'discharge.sign_dialog_title': 'கையொப்பம் வெளியேற்ற சுருக்கம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'discharge.sign_dialog_body':
          'கையொப்பமிட்டவுடன், இந்த டிஸ்சார்ஜ் சுருக்கம் அதிகாரப்பூர்வ பதிவாக மாறும், அதை மாற்ற முடியாது (சேர்க்கை மட்டுமே அனுமதிக்கப்படும்).\n\nநிச்சயமாக கையொப்பமிட விரும்புகிறீர்களா?',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'discharge.signed_badge':
          'கையொப்பமிடப்பட்டது - இந்த சுருக்கம் இப்போது அதிகாரப்பூர்வமானது மற்றும் மாறாதது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'discharge.proceed_title': 'வெளியேற்றத்தை உறுதிப்படுத்தவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'discharge.proceed_body_prefix': 'வெளியேற்றம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'discharge.must_sign_first':
          'வெளியேற்ற சுருக்கம் முதலில் ஒரு மருத்துவரால் கையொப்பமிடப்பட வேண்டும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'discharge.patient_button': 'டிஸ்சார்ஜ் நோயாளி',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'discharge.generate_title': 'வெளியேற்ற சுருக்கத்தை உருவாக்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'discharge.generate_body':
          'இது தானாக அனைத்து வார்டு குறிப்புகள், உயிர்கள், விசாரணைகள், மருந்துகள் மற்றும் இந்த சேர்க்கையிலிருந்து ஒரு கட்டமைக்கப்பட்ட வெளியேற்ற சுருக்கமாக ஒருங்கிணைக்கும்.',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'discharge.generate_button': 'சுருக்கத்தை உருவாக்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'discharge.generating': 'உருவாக்குகிறது...',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'discharge.regenerate': 'சுருக்கத்தை மீண்டும் உருவாக்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'discharge.section.hospital_course': 'மருத்துவமனை படிப்பு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'discharge.section.diagnosis': 'வெளியேற்ற நோய் கண்டறிதல்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'discharge.section.condition': 'வெளியேற்ற நிலை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'discharge.section.follow_up': 'பின்தொடர்தல் வழிமுறைகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'discharge.section.activity': 'செயல்பாட்டுக் கட்டுப்பாடுகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'discharge.section.diet': 'உணவு வழிமுறைகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'discharge.section.warning_signs': 'எச்சரிக்கை அறிகுறிகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'discharge.section.medications': 'வெளியேற்றத்திற்கான மருந்துகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'discharge.section.investigations': 'விசாரணைகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'discharge.section.procedures': 'நடைமுறைகள் நிறைவேற்றப்பட்டன',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'dispute.tab.submit': 'சமர்ப்பிக்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'dispute.tab.my': 'எனது சர்ச்சைகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'dispute.intro':
          'வருகைப் பதிவுச் சிக்கல்களைப் புகாரளிக்க இதைப் பயன்படுத்தவும். HR உங்கள் பதிவை மதிப்பாய்வு செய்து திருத்தும்.',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'dispute.date_label': 'தேதி',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'dispute.select_date': 'வெளியீட்டு தேதியைத் தேர்ந்தெடுக்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'dispute.issue_type_label': 'பிரச்சினை வகை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'dispute.type.missed_checkin': 'செக்-இன் தவறிவிட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'dispute.type.missed_checkout': 'செக்-அவுட் தவறிவிட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'dispute.type.wrong_time': 'தவறான நேரம் பதிவு செய்யப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'dispute.type.app_failure': 'பயன்பாடு/நெட்வொர்க் தோல்வி',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'dispute.type.other': 'மற்றவை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'dispute.description_label': 'விளக்கம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'dispute.description_hint': 'என்ன நடந்தது என்பதை விளக்குங்கள்...',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'dispute.correct_times': 'சரியான நேரங்கள் (விரும்பினால்)',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'dispute.correct_times_hint':
          'சரியான நேரங்கள் என்னவென்று உங்களுக்குத் தெரிந்தால், அவற்றை இங்கே உள்ளிடவும்.',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'dispute.check_in': 'செக்-இன்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'dispute.check_out': 'செக்-அவுட்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'dispute.required_error': 'தேதி மற்றும் விளக்கம் தேவை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'dispute.empty': 'சர்ச்சைகள் எதுவும் தாக்கல் செய்யப்படவில்லை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'dispute.hr_comment_prefix': 'HR:',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'overtime.tab.request': 'கோரிக்கை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'overtime.tab.my': 'எனது கோரிக்கைகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'overtime.extra_hours_label': 'கூடுதல் நேரம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'overtime.hours_suffix': 'மணி',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'overtime.type_label': 'வகை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'overtime.type.comp_time': 'இழப்பீட்டு நேரம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'overtime.type.payment': 'கூடுதல் நேர கட்டணம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'overtime.reason_label': 'காரணம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'overtime.reason_hint': 'ஏன் ஓவர் டைம் வேலை செய்தாய்?',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'overtime.required_error': 'தேதி மற்றும் காரணம் தேவை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'overtime.empty': 'கூடுதல் நேர கோரிக்கைகள் இல்லை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'overtime.rejected_prefix': 'நிராகரிக்கப்பட்டது:',
      'telemedicine.title_prefix': 'வீடியோ அழைப்பு -',
      'telemedicine.sdk_missing_title':
          'வீடியோ SDK இன்னும் ஒருங்கிணைக்கப்படவில்லை',
      'telemedicine.sdk_missing_body':
          'இயக்குவதற்கு agora_rtc_engine அல்லது flutter_webrtc ஐச் சேர்க்கவும்.',
      'telemedicine.mute': 'முடக்கு',
      'telemedicine.unmute': 'ஒலியடக்கவும்',
      'telemedicine.camera_off': 'கேமரா ஆஃப்',
      'telemedicine.camera_on': 'கேமரா ஆன்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.queue.compose_button': 'ரன்களை எழுதுங்கள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.queue.voice_notes_button': 'குரல் குறிப்புகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.queue.filter.pending': 'நிலுவையில் உள்ளது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.queue.filter.accepted': 'ஏற்றுக்கொள்ளப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.queue.filter.edited': 'திருத்தப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.queue.filter.rejected': 'நிராகரிக்கப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.queue.filter.all': 'அனைத்து',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.queue.empty_title': 'இந்த வடிகட்டியில் வரைவுகள் இல்லை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.queue.empty_body':
          'நீங்கள் மதிப்பாய்வு செய்பவர்-கவர் சேர்க்கைக்காக மருத்துவ AI வரைவு உருவாக்கப்படும் போது, அது இங்கே தோன்றும்.',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.queue.load_failed': 'மதிப்புரைகளை ஏற்ற முடியவில்லை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.queue.patient_fallback': 'நோயாளி',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.draft.reject_title': 'வரைவை நிராகரிக்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.draft.reject_reason_label': 'காரணம்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.draft.reject_reason_hint': 'இந்த வரைவு ஏன் பொருத்தமற்றது?',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.draft.review_not_found': 'மதிப்பாய்வு கிடைக்கவில்லை.',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.draft.invalid_json':
          'திருத்தப்பட்ட வரைவு JSON செல்லுபடியாகாது.',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.draft.accept_edits': 'திருத்தங்களை ஏற்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.draft.decision_recorded': 'வரைவு முடிவு பதிவு செய்யப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.draft.no_safety_flags':
          'பாதுகாப்புக் கொடிகள் உயர்த்தப்படவில்லை.',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.draft.decided_prefix': 'வரைவு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.draft.decision_failed_prefix':
          'முடிவை பதிவு செய்ய முடியவில்லை:',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_runs.title': 'ரன்களை எழுதுங்கள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_runs.empty':
          'இந்தக் காட்சியில் எந்த இசையும் இயங்கவில்லை.',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_runs.filter.active': 'செயலில்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_runs.filter.paused': 'இடைநிறுத்தப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_runs.filter.completed': 'முடிக்கப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_runs.filter.failed': 'தோல்வியடைந்தது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_runs.filter.all': 'அனைத்து',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_runs.review_prefix': 'விமர்சனம்:',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_runs.started_prefix': 'தொடங்கியது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_runs.run_prefix': 'ஓடவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_runs.admission_word': 'சேர்க்கை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.not_found': 'ஓடியது கிடைக்கவில்லை.',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.resumed': 'மீண்டும் எழுதப்பட்டது.',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.open_in_queue': 'மதிப்பாய்வு வரிசையில் திற',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.detail_title_prefix': 'ரன் எழுதவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.admission_header_prefix': 'சேர்க்கை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.subgraphs': 'துணை வரைபடங்கள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.no_subgraphs': 'சப்கிராஃப் இயங்கவில்லை.',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.paused_prefix': 'இடைநிறுத்தப்பட்டது:',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.review_status_key': 'மதிப்பாய்வு நிலையை',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.started_key': 'தொடங்கப்பட்டது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.finished_key': 'முடிந்தது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.resume_button': 'மீண்டும் எழுதவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.resuming_button': 'மீண்டும் தொடங்குகிறது...',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.resume_failed_prefix': 'ரெஸ்யூம் தோல்வி:',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.critical_word': 'முக்கியமான',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.high_word': 'உயர்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.voice_notes.empty': 'இன்னும் குரல் குறிப்புகள் இல்லை.',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.voice_notes.soap_generated':
          'SOAP வரைவு உருவாக்கப்பட்டது; மறுஆய்வு வரிசையைத் திறக்கிறது.',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.voice_notes.title': 'குரல் குறிப்புகள்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.voice_notes.empty_subtitle':
          'டெஸ்க்டாப் கிளையண்டிலிருந்து குரல் குறிப்பை பதிவு செய்யவும்; இது SOAP வரைவிற்காக இங்கே தோன்றும்.',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.voice_notes.note_prefix': 'குரல் குறிப்பு',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.voice_notes.patient_prefix': 'நோயாளி:',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.voice_notes.draft_exists':
          'SOAP வரைவு ஏற்கனவே உருவாக்கப்பட்டுள்ளது',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.voice_notes.generate_soap': 'SOAP வரைவை உருவாக்கவும்',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.voice_notes.drafting': 'வரைவு...',
      // REVIEW: AI first-pass ta translation - confirm clinical/security/financial wording before production
      'clinical_ai.voice_notes.generation_failed_prefix':
          'SOAP உருவாக்கம் தோல்வியடைந்தது:',
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
      // REVIEW: app branding - keep VHHealth as proper noun
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
      // REVIEW: security message wording - confirm 15-min phrasing
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
      'dashboard.daily_work': 'రోజువారీ పని',
      'dashboard.op_services': 'OP సేవలు',
      'dashboard.ip_services': 'IP సేవలు',
      'dashboard.no_op_services': 'ఈ పాత్రకు OP సేవలు అందుబాటులో లేవు',
      'dashboard.no_ip_services': 'ఈ పాత్రకు IP సేవలు అందుబాటులో లేవు',
      'dashboard.op_lab_bookings': 'OP ల్యాబ్ బుకింగ్స్',
      'dashboard.ip_lab_bookings': 'IP ల్యాబ్ బుకింగ్స్',
      'dashboard.op_nursing_notes': 'OP నర్సింగ్ నోట్లు',
      'dashboard.ip_nursing_notes': 'IP నర్సింగ్ నోట్లు',
      'dashboard.op_pharmacy': 'OP ఫార్మసీ',
      'dashboard.ip_pharmacy': 'IP ఫార్మసీ',
      'dashboard.op_lab_results': 'OP ల్యాబ్ ఫలితాలు',
      'dashboard.ip_lab_results': 'IP ల్యాబ్ ఫలితాలు',
      'dashboard.op_patient_records': 'OP రోగి రికార్డులు',
      'dashboard.ip_patient_records': 'IP రోగి రికార్డులు',
      'dashboard.more_tools': 'మరిన్ని టూల్స్',
      'dashboard.more_tools_hint':
          'సెలవు, ప్రొఫైల్, సెట్టింగులు మరియు అప్పుడప్పుడు చేసే పనులు',
      'dashboard.recent_activity': 'ఇటీవలి కార్యకలాపం',
      'dashboard.checked_in_title': 'చెక్ ఇన్',
      'dashboard.not_checked_in_title': 'చెక్ ఇన్ కాలేదు',
      'dashboard.since_time_prefix': 'నుండి',
      'dashboard.tap_to_manage': 'హాజరును నిర్వహించడానికి ట్యాప్ చేయండి',
      'dashboard.new_live_notification.one': 'కొత్త లైవ్ నోటిఫికేషన్',
      'dashboard.new_live_notification.other': 'కొత్త లైవ్ నోటిఫికేషన్‌లు',
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
      'settings.about.subtitle': 'వెర్షన్ 1.0.0 · యాప్ సమాచారం & ఫీచర్లు',
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
      'profile.updated_success': '✅ ప్రొఫైల్ విజయవంతంగా అప్‌డేట్ చేయబడింది',
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
      // Time helpers - REVIEW
      'time.just_now': 'ఇప్పుడే',
      'time.yesterday': 'నిన్న',
      'time.today': 'ఈరోజు',
      'time.minutes_ago_suffix': ' నిమిషాల క్రితం',
      'time.hours_ago_suffix': ' గంటల క్రితం',
      'time.days_ago_suffix': ' రోజుల క్రితం',
      // Priority / Urgency - REVIEW
      'priority.low': 'తక్కువ',
      'priority.normal': 'సాధారణ',
      'priority.high': 'అధిక',
      'priority.urgent': 'తక్షణ',
      'priority.critical': 'క్లిష్టమైన',
      'urgency.low': 'తక్కువ',
      'urgency.normal': 'సాధారణ',
      'urgency.high': 'అధిక',
      'urgency.critical': 'క్లిష్టమైన',
      // Departments - REVIEW
      'department.general': 'సాధారణ',
      'department.emergency': 'అత్యవసరం',
      'department.icu': 'ICU',
      'department.pediatrics': 'శిశు వైద్యశాస్త్రం',
      'department.surgery': 'శస్త్రచికిత్స',
      'department.outpatient': 'బాహ్య రోగి',
      // About - REVIEW
      'about.title': 'గురించి',
      'about.header': 'గురించి',
      'about.app_name': 'VHHealth సిబ్బంది',
      'about.version': 'వెర్షన్ 1.0.0',
      'about.description':
          'VH Health ద్వారా ఆసుపత్రి సిబ్బంది నిర్వహణ యాప్. హాజరు, సెలవు, అపాయింట్‌మెంట్‌లు మరియు మరిన్ని - అన్నింటినీ మీ మొబైల్ పరికరం నుండి నిర్వహించండి.',
      'about.features_header': 'ఫీచర్లు',
      'about.support_header': 'మద్దతు',
      'about.support_email_label': 'ఇమెయిల్',
      'about.website_label': 'వెబ్‌సైట్',
      'about.copyright': '© 2026 VH Health. అన్ని హక్కులు రిజర్వ్ చేయబడ్డాయి.',
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
      // Leave (additional) - REVIEW
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
      'leave.replacement_staff_label': 'ప్రత్యామ్నాయ సిబ్బంది (ఐచ్ఛికం)',
      'leave.replacement_staff_hint':
          'మీ స్థానంలో పనిచేయడానికి సహోద్యోగిని ఎంచుకోండి',
      'leave.replacement_staff_pick':
          'ప్రత్యామ్నాయాన్ని ఎంచుకోవడానికి ట్యాప్ చేయండి',
      'leave.select_replacement': 'ప్రత్యామ్నాయ సిబ్బందిని ఎంచుకోండి',
      'leave.no_staff_available': 'సిబ్బంది అందుబాటులో లేరు',
      'leave.search_by_type_hint': 'సెలవు రకం ద్వారా వెతకండి…',
      'leave.no_applications': 'సెలవు దరఖాస్తులు లేవు',
      'leave.no_replacement_requests': 'పెండింగ్ ప్రత్యామ్నాయ అభ్యర్థనలు లేవు',
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
      // Bed sheet (additional) - REVIEW
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
      'bed_sheet.no_patient_assigned': 'ప్రస్తుతం రోగి అసైన్ చేయబడలేదు.',
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
      // Vitals - REVIEW
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
      'vitals.trends_hint': 'వైటల్ ట్రెండ్‌లను చూడటానికి రోగి ID నమోదు చేయండి',
      'vitals.no_records': 'ఈ రోగికి వైటల్ రికార్డులు ఏవీ కనుగొనబడలేదు',
      // REVIEW: clinical-action confirmation
      'vitals.recorded_success': 'వైటల్స్ విజయవంతంగా రికార్డ్ చేయబడ్డాయి',
      // REVIEW: clinical / connectivity message
      'vitals.offline_queued':
          'కనెక్షన్ లేదు - వైటల్స్ సేవ్ చేయబడ్డాయి, ఆన్‌లైన్‌కి వచ్చినప్పుడు సింక్ అవుతాయి',
      // Nursing Notes - REVIEW
      'nursing_notes.title': 'నర్సింగ్ నోట్స్',
      'nursing_notes.tab.add': 'గమనిక జోడించు',
      'nursing_notes.tab.recent': 'ఇటీవలి గమనికలు',
      'nursing_notes.backend_coming_soon':
          'సేవ్ చేసిన గమనికలు append-only EMR ఎంట్రీలు. సవరణలను addendum గా జోడించండి.',
      'nursing_notes.patient_phone_label': 'రోగి ఫోన్ నంబర్',
      'nursing_notes.patient_phone_hint': '+91 XXXXX XXXXX',
      'nursing_notes.phone_required': 'ఫోన్ అవసరం',
      'nursing_notes.phone_invalid': 'చెల్లుబాటు అయ్యే ఫోన్ నంబర్ నమోదు చేయండి',
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
      'nursing_notes.saved_success': 'నర్సింగ్ గమనిక విజయవంతంగా సేవ్ చేయబడింది',
      // REVIEW: clinical / connectivity message
      'nursing_notes.offline_queued':
          'ఆఫ్‌లైన్‌లో సేవ్ చేయబడింది - కనెక్ట్ అయినప్పుడు సింక్ అవుతుంది',
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
      // Handover - REVIEW
      'handover.title': 'హ్యాండోవర్ గమనికలు',
      'handover.tab.write': 'రాయి',
      'handover.tab.recent': 'ఇటీవలి',
      'handover.department_label': 'విభాగం',
      'handover.urgency_label': 'తక్షణత',
      'handover.notes_label': 'హ్యాండోవర్ గమనికలు',
      'handover.notes_hint': 'ముఖ్య పరిశీలనలు, పెండింగ్ పనులు, ఔషధ మార్పులు...',
      'handover.notes_required': 'గమనికలు అవసరం',
      'handover.patient_ref_label': 'రోగి సూచనలు (ఐచ్ఛికం)',
      'handover.patient_ref_hint':
          'గది 201 - శ్రీ. శర్మ, గది 305 - శ్రీమతి పటేల్',
      'handover.submit_button': 'హ్యాండోవర్ సమర్పించు',
      'handover.submitting_button': 'సమర్పిస్తోంది...',
      // REVIEW: clinical-action confirmation
      'handover.submitted': 'హ్యాండోవర్ గమనిక సమర్పించబడింది',
      'handover.recent_empty_title': 'ఇటీవలి హ్యాండోవర్ గమనికలు లేవు',
      'handover.recent_empty_body': 'గత 24 గంటల గమనికలు ఇక్కడ కనిపిస్తాయి',
      'handover.note_fallback_title': 'హ్యాండోవర్ గమనిక',
      'patient_picker.title': 'రోగిని కనుగొనండి',
      'patient_picker.hint': 'పేరు, ఫోన్ లేదా ABHA ద్వారా రోగిని కనుగొనండి…',
      'patient_picker.empty':
          'ఇంకా రోగి సరిపోలికలు లేవు - టైప్ చేయడం కొనసాగించండి.',
      'voice_dictate.tooltip': 'వాయిస్ → టెక్స్ట్',
      'voice_dictate.recording': 'రికార్డ్ అవుతోంది…',
      'voice_dictate.stop': 'ఆపండి & ట్రాన్స్క్రైబ్',
      'voice_dictate.transcribing': 'ట్రాన్స్క్రైబ్ అవుతోంది…',
      'voice_dictate.transcript_added': 'గమనికలకు జోడించబడింది',
      // REVIEW:
      'voice_dictate.hint': 'సహజంగా మాట్లాడండి. పూర్తయినప్పుడు ఆపు నొక్కండి.',
      // REVIEW:
      'voice_dictate.added_toast': 'గమనికలకు జోడించబడింది',
      // REVIEW:
      'voice_dictate.recording_started': 'రికార్డింగ్ ప్రారంభమైంది',
      // REVIEW:
      'voice_dictate.recording_stopped':
          'రికార్డింగ్ ఆగింది, ట్రాన్స్‌క్రైబ్ అవుతోంది',
      'voice_dictate.mic_denied':
          'మైక్రోఫోన్ అనుమతి తిరస్కరించబడింది. OS / యాప్ సెట్టింగ్‌లలో ప్రారంభించండి.',
      // Bed Board (additions) - REVIEW
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
      'bed_board.admit_which_patient': 'ఏ రోగిని అడ్మిట్ చేయాలి?',
      'bed_board.admit_search_hint': 'పేరు, ఫోన్ లేదా ABHA ద్వారా వెతకండి…',
      'bed_board.type_to_find_patient': 'రోగిని కనుగొనడానికి టైప్ చేయండి.',
      'bed_board.patient_unnamed': 'పేరు లేని',
      // Doctor queue - REVIEW
      'queue.title': 'రోగి క్యూ',
      'queue.refresh_tooltip': 'క్యూ రిఫ్రెష్',
      'queue.section.in_consultation': 'సంప్రదింపులో',
      'queue.section.waiting_prefix': 'వేచి ఉన్నవారు',
      'queue.section.completed_prefix': 'పూర్తయింది',
      'queue.call_next_patient': 'తదుపరి రోగిని పిలవండి',
      // REVIEW: clinical-action confirmation
      'queue.complete_consultation': 'సంప్రదింపును పూర్తి చేయండి',
      'queue.call_tooltip': 'పిలవండి',
      'queue.no_patients_waiting': 'వేచి ఉన్న రోగులు లేరు',
      'queue.no_completed_consultations': 'పూర్తయిన సంప్రదింపులు లేవు',
      'queue.waiting_prefix': 'వేచి ఉన్నది',
      'queue.in_prefix': 'లో',
      'queue.patient_info': 'రోగి సమాచారం',
      'queue.recent_records': 'ఇటీవలి రికార్డులు',
      'queue.no_health_records_found': 'ఆరోగ్య రికార్డులు కనుగొనబడలేదు',
      // REVIEW: clinical / safety - allergies surfacing
      'queue.allergies_prefix': 'అలెర్జీలు:',
      'queue.age_prefix': '• వయస్సు:',
      'queue.write_prescription': 'ప్రిస్క్రిప్షన్ రాయండి',
      'queue.order_investigation': 'పరిశోధన ఆర్డర్',
      'queue.add_notes': 'గమనికలు జోడించు',
      'queue.no_phone_number': 'ఫోన్ నంబర్ అందుబాటులో లేదు',
      'queue.record_fallback': 'రికార్డు',
      'queue.unknown_patient': 'తెలియదు',
      // Prescriptions - REVIEW
      'prescriptions.title': 'ఈ-ప్రిస్క్రిప్షన్‌లు',
      'prescriptions.tab.new': 'కొత్త ప్రిస్క్రిప్షన్',
      'prescriptions.tab.recent': 'ఇటీవలి',
      'prescriptions.error.select_patient_doctor':
          'దయచేసి రోగి మరియు డాక్టర్‌ను ఎంచుకోండి',
      'prescriptions.error.fill_medication_names':
          'దయచేసి అన్ని మందుల పేర్లను నింపండి',
      'prescriptions.photo.title': 'ప్రిస్క్రిప్షన్ ఫోటో',
      'prescriptions.photo.body': 'ఫోటో తీయండి లేదా గ్యాలరీ నుండి ఎంచుకోండి?',
      'prescriptions.photo.camera': 'కెమెరా',
      'prescriptions.photo.gallery': 'గ్యాలరీ',
      'prescriptions.vitals_collapse': 'వైటల్స్ (ఐచ్ఛికం)',
      'prescriptions.diagnosis_label': 'రోగనిర్ధారణ / ముఖ్య ఫిర్యాదు *',
      'prescriptions.diagnosis_required': 'రోగనిర్ధారణ అవసరం',
      'prescriptions.medications_header': 'మందులు *',
      'prescriptions.add_button': 'జోడించు',
      'prescriptions.set_follow_up': 'ఫాలో-అప్ తేదీని సెట్ చేయండి',
      'prescriptions.follow_up_prefix': 'ఫాలో-అప్:',
      'prescriptions.clear_follow_up': 'ఫాలో-అప్ తేదీని క్లియర్',
      'prescriptions.follow_up_notes': 'ఫాలో-అప్ గమనికలు',
      'prescriptions.follow_up_notes_hint': 'ఉదా. రక్త నివేదికలు తీసుకురండి',
      'prescriptions.clinical_notes': 'క్లినికల్ గమనికలు / సలహా',
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
      'prescriptions.search_patient': 'రోగిని వెతకండి (ఫోన్/పేరు)',
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
      // Patient records - REVIEW
      'patient_records.title': 'రోగి రికార్డులు',
      'patient_records.search_hint': 'రోగి పేరు లేదా రకం ద్వారా వెతకండి...',
      'patient_records.clear_tooltip': 'శోధన క్లియర్',
      'patient_records.retry': 'మళ్ళీ ప్రయత్నించు',
      'patient_records.no_found': 'రికార్డులు కనుగొనబడలేదు',
      'patient_records.empty': 'రోగి రికార్డులు లేవు',
      'patient_records.empty_body': 'రోగి రికార్డులు ఇక్కడ కనిపిస్తాయి',
      'patient_records.details': 'రికార్డు వివరాలు',
      'patient_records.unknown_patient': 'తెలియని రోగి',
      // Appointment queue - REVIEW
      'appt_queue.title': 'అపాయింట్‌మెంట్ క్యూ',
      'appt_queue.walk_in': 'వాక్-ఇన్',
      'appt_queue.tab.today_prefix': 'నేటి క్యూ',
      'appt_queue.tab.pending_prefix': 'పెండింగ్',
      'appt_queue.no_today': 'నేడు అపాయింట్‌మెంట్‌లు లేవు',
      'appt_queue.all_confirmed': 'అన్ని అపాయింట్‌మెంట్‌లు నిర్ధారించబడ్డాయి!',
      'appt_queue.confirm_title': 'అపాయింట్‌మెంట్‌ను నిర్ధారించండి',
      'appt_queue.change_date': 'తేదీని మార్చండి',
      'appt_queue.change_time': 'సమయాన్ని మార్చండి',
      'appt_queue.notes_optional': 'గమనికలు (ఐచ్ఛికం)',
      'appt_queue.confirm_appointment': 'అపాయింట్‌మెంట్‌ను నిర్ధారించండి',
      // REVIEW: clinical-action confirmation
      'appt_queue.confirmed_toast': 'అపాయింట్‌మెంట్ నిర్ధారించబడింది ✓',
      'appt_queue.failed_prefix': 'విఫలమైంది:',
      'appt_queue.no_show_title': 'నో-షోగా గుర్తించాలా?',
      'appt_queue.no_show_body_suffix': 'రాలేదా?',
      'appt_queue.mark_no_show': 'నో-షోగా గుర్తించు',
      // REVIEW: clinical-action confirmation
      'appt_queue.no_show_marked': 'నో-షోగా గుర్తించబడింది',
      'appt_queue.complete_title': 'అపాయింట్‌మెంట్‌ను పూర్తి చేయండి',
      'appt_queue.complete_body_prefix': 'గుర్తించాలా',
      'appt_queue.complete_body_suffix': 'పూర్తయినదిగా?',
      'appt_queue.complete_action': 'పూర్తి',
      // REVIEW: clinical-action confirmation
      'appt_queue.completed_toast': 'అపాయింట్‌మెంట్ పూర్తయింది ✓',
      'appt_queue.rx_prompt_title': 'ఈ-ప్రిస్క్రిప్షన్ సృష్టించాలా?',
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
      'appt_queue.doc_uploaded': 'డాక్యుమెంట్ అప్‌లోడ్ చేయబడింది ✓',
      'appt_queue.upload_failed_prefix': 'అప్‌లోడ్ విఫలమైంది:',
      'appt_queue.register_walk_in': 'వాక్-ఇన్ నమోదు చేయండి',
      'appt_queue.patient_phone': 'రోగి ఫోన్ *',
      'appt_queue.patient_phone_required': 'రోగి ఫోన్ అవసరం',
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
      // Admission - REVIEW
      'admission.title': 'అడ్మిషన్‌లు',
      'admission.admit': 'అడ్మిట్',
      'admission.admit_patient': 'రోగిని అడ్మిట్ చేయండి',
      'admission.patient_label': 'రోగి (పేరు, UID, లేదా ఫోన్)',
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
      // REVIEW: clinical-action - DNR/DNI standard medical
      'admission.code.full': 'ఫుల్ కోడ్',
      'admission.code.dnr': 'DNR',
      'admission.code.dnr_dni': 'DNR/DNI',
      'admission.code.comfort': 'కంఫర్ట్ కేర్',
      // REVIEW: clinical-action confirmation
      'admission.admitted_success': 'రోగి విజయవంతంగా అడ్మిట్ చేయబడ్డారు',
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
      // Patient timeline - REVIEW
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
      // Orders - REVIEW
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
      'orders.description_hint': 'గాయం సంరక్షణ, స్థానీకరణ, పర్యవేక్షణ...',
      'orders.frequency_hint_nursing': 'ప్రతి 4 గం., PRN, ఒకసారి...',
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
      'orders.complete_failed_prefix': 'ఆర్డర్ పూర్తి చేయడంలో విఫలమైంది:',
      'orders.retry': 'మళ్ళీ ప్రయత్నించు',
      // Vitals chart - REVIEW
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
      'vitals_chart.conscious.verbal': 'వాయిస్‌కు ప్రతిస్పందిస్తుంది',
      'vitals_chart.conscious.pain': 'నొప్పికి ప్రతిస్పందిస్తుంది',
      'vitals_chart.conscious.unresp': 'ప్రతిస్పందించదు',
      'vitals_chart.save_button': 'వైటల్స్ సేవ్',
      'vitals_chart.at_least_one': 'దయచేసి కనీసం ఒక వైటల్ సైన్‌ను నమోదు చేయండి',
      // REVIEW: clinical-action confirmation
      'vitals_chart.recorded_success': 'వైటల్స్ విజయవంతంగా రికార్డ్ చేయబడ్డాయి',
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
      'vitals_chart.io_failed_prefix': 'I/O రికార్డ్ చేయడంలో విఫలమైంది:',
      'vitals_chart.retry': 'మళ్ళీ ప్రయత్నించు',
      'vitals_chart.no_vitals': 'గత 24 గంటల్లో వైటల్స్ రికార్డ్ చేయబడలేదు',
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
      'vitals_chart.no_io_today': 'నేడు I/O ఎంట్రీలు రికార్డు కాలేదు',
      'vitals_chart.record_for_prefix': 'వీరి కోసం వైటల్స్ రికార్డ్:',
      'vitals_chart.record_patient': 'రోగి వైటల్స్ రికార్డ్',
      'vitals_chart.record_now': 'ఇప్పుడు వైటల్స్ రికార్డ్',
      // Clinical notes - REVIEW
      'clinical_notes.title': 'క్లినికల్ నోట్స్',
      'clinical_notes.title_prefix': 'నోట్స్',
      'clinical_notes.tab.soap': 'SOAP నోట్స్',
      'clinical_notes.tab.progress': 'ప్రోగ్రెస్ నోట్స్',
      'clinical_notes.tab.procedure': 'ప్రొసీజర్ నోట్స్',
      'clinical_notes.new_note': 'కొత్త నోట్',
      // REVIEW: clinical-action - signed/unsigned status
      'clinical_notes.signed': 'సంతకం చేయబడింది',
      'clinical_notes.unsigned': 'సంతకం లేదు',
      'clinical_notes.retry': 'మళ్ళీ ప్రయత్నించు',
      'clinical_notes.no_found_prefix': 'ఏ',
      'clinical_notes.no_found_suffix': 'నోట్‌లు కనుగొనబడలేదు',
      // REVIEW: clinical-action confirmation
      'clinical_notes.sign_note': 'నోట్‌పై సంతకం చేయండి',
      // REVIEW: clinical-action confirmation
      'clinical_notes.signed_success': 'నోట్ విజయవంతంగా సంతకం చేయబడింది',
      'clinical_notes.sign_failed_prefix': 'నోట్‌పై సంతకం చేయడంలో విఫలమైంది:',
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
      'clinical_notes.subjective_hint': 'రోగి ఫిర్యాదులు, లక్షణాలు, చరిత్ర...',
      'clinical_notes.objective_hint':
          'పరీక్ష ఫలితాలు, వైటల్స్, ల్యాబ్ ఫలితాలు...',
      'clinical_notes.assessment_hint': 'రోగనిర్ధారణ, క్లినికల్ ఇంప్రెషన్...',
      'clinical_notes.plan_hint': 'చికిత్స ప్రణాళిక, ఆర్డర్‌లు, ఫాలో-అప్...',
      'clinical_notes.title_field': 'శీర్షిక',
      'clinical_notes.content_hint':
          'క్లినికల్ ప్రోగ్రెస్, పరిశీలనలు, ప్రణాళిక మార్పులు...',
      'clinical_notes.procedure_name': 'ప్రొసీజర్ పేరు',
      'clinical_notes.procedure_details_hint': 'టెక్నిక్, విధానం, దశలు...',
      'clinical_notes.findings_hint': 'ప్రొసీజర్ సమయంలో కనుగొన్నవి...',
      'clinical_notes.complications_hint': 'ఎదుర్కొన్న ఏదైనా సంక్లిష్టతలు...',
      'clinical_notes.required': 'అవసరం',
      'clinical_notes.save_note': 'నోట్ సేవ్',
      // REVIEW: clinical-action confirmation
      'clinical_notes.created_success': 'నోట్ విజయవంతంగా సృష్టించబడింది',
      'clinical_notes.create_failed_prefix': 'నోట్ సృష్టించడంలో విఫలమైంది:',
      // Payroll
      // REVIEW: financial / payroll wording
      'payroll.payslip.title': 'నా జీతం స్లిప్‌లు',
      'payroll.payslip.banner_tax': 'వార్షిక పన్ను సారాంశం (ఫారం 16)',
      'payroll.payslip.banner_declaration': 'పన్ను ప్రకటన (80C/80D)',
      'payroll.payslip.banner_queries': 'జీతం స్లిప్ ప్రశ్నలు',
      'payroll.payslip.empty_title': 'జీతం స్లిప్‌లు అందుబాటులో లేవు',
      'payroll.payslip.net_pay': 'నికర వేతనం',
      'payroll.payslip.gross': 'మొత్తం',
      'payroll.payslip.deductions': 'మినహాయింపులు',
      'payroll.detail.title_prefix': 'జీతం స్లిప్',
      'payroll.detail.gross_salary': 'స్థూల జీతం',
      'payroll.detail.total_deductions': 'మొత్తం మినహాయింపులు',
      'payroll.query.title': 'జీతం స్లిప్ ప్రశ్నలు',
      'payroll.query.tab_my': 'నా ప్రశ్నలు',
      'payroll.query.tab_raise': 'ప్రశ్న లేవనెత్తు',
      'payroll.query.empty': 'ఇంకా ప్రశ్నలు లేవు',
      'payroll.query.submit_button': 'ప్రశ్న సమర్పించు',
      // REVIEW: financial confirmation
      'payroll.query.submitted_success': 'ప్రశ్న విజయవంతంగా లేవనెత్తబడింది!',
      'payroll.tax_summary.title': 'వార్షిక పన్ను సారాంశం',
      'payroll.declaration.title': 'పన్ను ప్రకటన (80C/80D)',
      'payroll.declaration.submit_button': 'ప్రకటన సమర్పించు',
      // REVIEW: financial confirmation
      'payroll.declaration.submitted_success':
          'ప్రకటన విజయవంతంగా సమర్పించబడింది!',
      // HR
      'hr.dashboard.title': 'HR డాష్‌బోర్డ్',
      'hr.section.attendance_overview': 'హాజరు అవలోకనం',
      'hr.section.leave_summary': 'సెలవు సారాంశం',
      'hr.section.quick_actions': 'శీఘ్ర చర్యలు',
      'hr.stat.total_staff': 'మొత్తం సిబ్బంది',
      'hr.stat.present_today': 'ఈరోజు హాజరు',
      'hr.stat.on_leave': 'సెలవులో',
      'hr.stat.pending_leaves': 'పెండింగ్ సెలవులు',
      'hr.action.staff_management': 'సిబ్బంది నిర్వహణ',
      'hr.action.staff_directory': 'సిబ్బంది డైరెక్టరీ',
      'hr.action.payslips': 'నా జీతం స్లిప్‌లు',
      'staff_mgmt.title': 'సిబ్బంది నిర్వహణ',
      'staff_mgmt.add_staff': 'సిబ్బందిని జోడించు',
      'staff_mgmt.no_staff_found': 'సిబ్బంది కనుగొనబడలేదు',
      // REVIEW: HR confirmation
      'staff_mgmt.updated_success': '✅ సిబ్బంది విజయవంతంగా నవీకరించబడింది',
      'performance.title': 'పనితీరు సమీక్షలు',
      'performance.save_review': 'సమీక్షను సేవ్ చేయి',
      // REVIEW: HR confirmation
      'performance.saved_success': '✅ పనితీరు సమీక్ష సేవ్ చేయబడింది',
      'directory.title': 'సిబ్బంది డైరెక్టరీ',
      // Reports
      'reports.hub.title': 'నివేదికలు & ఫిర్యాదులు',
      'reports.hub.incident_title': 'సంఘటన నివేదిక',
      'reports.hub.grievance_title': 'సిబ్బంది ఫిర్యాదు',
      'my_reports.title': 'నా నివేదికలు',
      'incident_report.title': 'సంఘటన నివేదిక',
      // REVIEW: clinical / safety severity wording
      'incident_report.severity.low': 'తక్కువ',
      'incident_report.severity.moderate': 'మధ్యస్థ',
      'incident_report.severity.severe': 'తీవ్రమైన',
      'incident_report.severity.sentinel': 'సెంటినెల్',
      'incident_report.submit_button': 'సంఘటన నివేదిక సమర్పించు',
      // REVIEW: clinical / safety confirmation
      'incident_report.submitted_title': 'నివేదిక సమర్పించబడింది',
      'grievance.title': 'సిబ్బంది ఫిర్యాదు',
      'grievance.submit_button': 'ఫిర్యాదు సమర్పించు',
      // REVIEW: HR confirmation
      'grievance.submitted_title': 'ఫిర్యాదు సమర్పించబడింది',
      // Housekeeping
      'housekeeping.hub.title': 'హౌస్‌కీపింగ్',
      'housekeeping.log.title': 'శుభ్రపరచడం లాగ్',
      'housekeeping.submit_log': 'శుభ్రపరచడం లాగ్ సమర్పించు',
      // REVIEW: confirmation
      'housekeeping.logged_title': 'శుభ్రపరచడం లాగ్ చేయబడింది',
      'housekeeping.raise_request_button': 'అభ్యర్థన లేవనెత్తు',
      'housekeeping.raised_title': 'అభ్యర్థన లేవనెత్తబడింది',
      'housekeeping.mark_complete': 'పూర్తయినట్లు గుర్తించు',
      // Hospital departments
      'blood_bank.title': 'రక్త నిధి',
      'blood_bank.units_suffix': 'యూనిట్‌లు',
      'blood_bank.submit_request': 'అభ్యర్థన సమర్పించు',
      // REVIEW: clinical confirmation
      'blood_bank.request_success': 'రక్త అభ్యర్థన విజయవంతంగా సమర్పించబడింది',
      'dietary.title': 'ఆహార నిర్వహణ',
      'dietary.create_button': 'సృష్టించు',
      // REVIEW: clinical confirmation
      'dietary.created_success': 'ఆహార ఆర్డర్ సృష్టించబడింది',
      'theatre.title': 'ఆపరేటింగ్ థియేటర్',
      // REVIEW: clinical-action - surgery
      'theatre.start_surgery': 'శస్త్రచికిత్స ప్రారంభించు',
      'theatre.mark_complete': 'పూర్తయినట్లు గుర్తించు',
      'theatre.preop_checklist': 'శస్త్రచికిత్స ముందు చెక్‌లిస్ట్',
      'radiology.title': 'రేడియాలజీ',
      'radiology.submit_report': 'నివేదిక సమర్పించు',
      'schedule.title': 'షిఫ్ట్ షెడ్యూల్',
      // Lab / Pharmacy
      'investigations.title': 'పరిశోధనలు',
      'investigations.upload_button': 'పరిశోధన అప్‌లోడ్',
      // REVIEW: clinical confirmation
      'investigations.upload_success':
          '✅ పరిశోధన ఫలితం విజయవంతంగా అప్‌లోడ్ చేయబడింది',
      'lab_bookings.title': 'ల్యాబ్ బుకింగ్‌లు',
      'pharmacy.title': 'ఫార్మసీ ఆర్డర్‌లు',
      'pharmacy.confirm_order': 'ఆర్డర్ నిర్ధారించు',
      'pharmacy.dispatch': 'పంపు',
      'pharmacy.mark_delivered': 'డెలివర్ అయినట్లు గుర్తించు',
      // Nursing
      'due_meds.title': 'వచ్చే మందులు',
      'mar_scan.title': 'మందు వేయి',
      // REVIEW: clinical-action / safety wording for medication 5-rights
      'mar_scan.right_patient': 'సరైన రోగి',
      'mar_scan.right_drug': 'సరైన మందు',
      'mar_scan.right_dose': 'సరైన మోతాదు',
      'mar_scan.right_route': 'సరైన మార్గం',
      'mar_scan.right_time': 'సరైన సమయం',
      'mar_scan.administer': 'వేయి',
      'mar_scan.recorded': 'వేయడం రికార్డ్ చేయబడింది',
      // Discharge
      'discharge.save_draft': 'డ్రాఫ్ట్ సేవ్',
      // REVIEW: clinical-action confirmation - discharge wording
      'discharge.sign_summary': 'సారాంశంపై సంతకం చేయి',
      'discharge.sign_button': 'సంతకం',
      // REVIEW: clinical-action confirmation
      'discharge.signed_success':
          'డిశ్చార్జ్ సారాంశం సంతకం చేయబడింది - ఇప్పుడు అధికారికం',
      'discharge.proceed_button': 'డిశ్చార్జ్',
      'discharge.patient_discharged': 'రోగి విజయవంతంగా డిశ్చార్జ్ చేయబడ్డారు',
      // Attendance / Overtime
      'dispute.title': 'హాజరు వివాదం',
      'dispute.submit_button': 'వివాదం సమర్పించు',
      // REVIEW: HR confirmation
      'dispute.submitted_success':
          '✅ వివాదం సమర్పించబడింది. HR 24 గంటల్లో సమీక్షిస్తుంది.',
      'overtime.title': 'ఓవర్‌టైమ్ అభ్యర్థనలు',
      'overtime.submit_button': 'ఓవర్‌టైమ్ అభ్యర్థన సమర్పించు',
      // REVIEW: HR confirmation
      'overtime.submitted_success': '✅ ఓవర్‌టైమ్ అభ్యర్థన సమర్పించబడింది',
      // Telemedicine
      'telemedicine.end_call': 'కాల్ ముగించు',
      // Clinical AI
      'clinical_ai.queue.title': 'AI సమీక్ష క్యూ',
      // REVIEW: clinical-action wording
      'clinical_ai.draft.accept': 'అంగీకరించు',
      'clinical_ai.draft.reject_button': 'తిరస్కరించు',
      'clinical_ai.draft.needs_revision': 'పునర్విమర్శ అవసరం',
      // REVIEW: clinical-action / security wording - Telugu-fluent clinician must verify
      'clinical_ai.draft.screen_title': 'AI ముసాయిదా సమీక్ష',
      'clinical_ai.draft.critical_title': 'క్లిష్ట భద్రత ఫ్లాగ్‌లు',
      'clinical_ai.draft.safety_header': 'భద్రత ఫ్లాగ్‌లు',
      'clinical_ai.draft.body_header': 'ముసాయిదా',
      'clinical_ai.draft.edit_header': 'ముసాయిదాను సవరించండి (JSON)',
      'clinical_ai.draft.edit_button': 'సవరించు',
      'clinical_ai.draft.cancel_edit_button': 'సవరణ రద్దు',
      'clinical_ai.draft.failed_load': 'ముసాయిదాను లోడ్ చేయడంలో విఫలమైంది',
      'clinical_ai.draft.patient_prefix': 'రోగి:',
      'clinical_ai.draft.admission_prefix': 'ప్రవేశం:',
      'clinical_ai.draft.status_prefix': 'స్థితి:',
      'clinical_ai.draft.provider_prefix': 'ప్రదాత:',
      // AI Assist - REVIEW: Telugu-fluent clinician must verify
      // REVIEW:
      'ai_assist.title': 'AI సహాయం',
      // REVIEW:
      'ai_assist.generate_blurb':
          'ఈ గమనిక యొక్క సాధారణ-భాషలో రోగి వివరణను రూపొందించండి. సంతకం కోసం మీ సమీక్ష క్యూలో కనిపిస్తుంది.',
      // REVIEW:
      'ai_assist.generate_button': 'రోగి వివరణ రూపొందించు',
      // REVIEW:
      'ai_assist.note_too_short':
          'వివరణ రూపొందించడానికి గమనిక చాలా తక్కువ (కనీసం 30 అక్షరాలు అవసరం).',
      // REVIEW:
      'ai_assist.generating': 'రోగి వివరణ రూపొందుతోంది…',
      // REVIEW:
      'ai_assist.failed_prefix': 'AI సహాయం విఫలమైంది:',
      // REVIEW: clinical-safety - confirm with attending
      'ai_assist.cannot_sign':
          'సంతకం చేయలేరు - సమీక్ష రికార్డ్ సృష్టించబడలేదు (స్కీమా అందుబాటులో లేకపోవచ్చు).',
      // REVIEW:
      'ai_assist.reject_title': 'ముసాయిదాను తిరస్కరించాలా?',
      // REVIEW:
      'ai_assist.reject_prompt':
          'ఈ ముసాయిదా రోగికి అందించడానికి ఎందుకు అనుకూలం కాదు?',
      // REVIEW:
      'ai_assist.reject_min_chars': 'తిరస్కరణ కారణం కనీసం 5 అక్షరాలు ఉండాలి.',
      // REVIEW:
      'ai_assist.reject_hint': 'ఉదా: తదుపరి-దశల విభాగంలో వైద్య అశుద్ధత',
      // REVIEW:
      'ai_assist.drawer_title': 'AI రోగి వివరణ',
      // REVIEW:
      'ai_assist.fallback_banner':
          'మోడల్ పార్స్ చేయగల ముసాయిదాను అందించలేదు; ఫాల్‌బ్యాక్ ఆకృతి చూపబడుతోంది. ప్రొవైడర్ కాన్ఫిగరేషన్ తనిఖీ చేసిన తర్వాత మళ్లీ రూపొందించండి.',
      // REVIEW:
      'ai_assist.key_points': 'ముఖ్య అంశాలు',
      // REVIEW:
      'ai_assist.next_steps': 'తదుపరి దశలు',
      // REVIEW:
      'ai_assist.when_to_seek_help': 'ఎప్పుడు సహాయం తీసుకోవాలి',
      // REVIEW:
      'ai_assist.needs_edits': 'సవరణలు అవసరం',
      // REVIEW: clinical-safety - confirm with attending
      'ai_assist.accept_sign': 'అంగీకరించి సంతకం చేయి',
      // REVIEW:
      'ai_assist.summary': 'సారాంశం',
      // REVIEW:
      'ai_assist.empty': '(ఖాళీ)',
      // REVIEW:
      'ai_assist.decision_prefix': 'రోగి వివరణ',
      // REVIEW:
      'ai_assist.sign_failed_prefix': 'సంతకం విఫలమైంది:',
      // CDS blocker - REVIEW: clinical-safety, Telugu-fluent clinician must verify
      // REVIEW:
      'cds.blocker_title': 'ప్రిస్క్రిప్షన్ నిరోధించబడింది',
      // REVIEW:
      'cds.blocker_body':
          'క్లినికల్ నిర్ణయ మద్దతు కింది సమస్యలను సూచించింది. '
          'ప్రిస్క్రిప్షన్‌ను సవరించడానికి రద్దు చేయండి, లేదా నమోదు చేసిన కారణంతో అతిక్రమించండి.',
      // REVIEW:
      'cds.warnings_header': 'హెచ్చరికలు',
      // REVIEW:
      'cds.allergy_hint':
          'అలర్జీ సంఘర్షణ: ఈ అతిక్రమణను ఆమోదించిన పర్యవేక్షక వైద్యుడిని మీ కారణంలో పేర్కొనండి.',
      // REVIEW:
      'cds.override_reason_label': 'అతిక్రమణ కారణం (అవసరం, కనీసం 5 అక్షరాలు)',
      // REVIEW:
      'cds.override_button': 'అతిక్రమించు',
      // REVIEW:
      'cds.override_save': 'అతిక్రమించి సేవ్ చేయి',
      // Code Blue - REVIEW: clinical-safety, Telugu-fluent clinician must verify
      // REVIEW:
      'code_blue.title': 'కోడ్ బ్లూ',
      // REVIEW:
      'code_blue.respond': 'తక్షణం స్పందించండి.',
      // REVIEW:
      'code_blue.ward_prefix': 'వార్డు:',
      // REVIEW:
      'code_blue.bed_prefix': 'మంచం:',
      // REVIEW:
      'code_blue.patient_prefix': 'రోగి ID:',
      // REVIEW:
      'code_blue.acknowledge': 'అంగీకరించబడింది',
      // First-run welcome
      // REVIEW:
      'first_run.welcome_title': 'తెలుసుకోవలసిన కొన్ని సత్వరమార్గాలు',
      // REVIEW:
      'first_run.welcome_dismiss': 'తొలగించు',
      // REVIEW:
      'first_run.welcome_got_it': 'అర్థమైంది',
      // REVIEW:
      'first_run.tip_bed_tap':
          'రోగి వివరాలు మరియు త్వరిత చర్యల కోసం బెడ్ బోర్డులోని బెడ్ కార్డుపై ట్యాప్ చేయండి.',
      // REVIEW:
      'first_run.tip_bed_long_press':
          'గమనికలను ఇన్‌లైన్‌లో సవరించడానికి బెడ్ కార్డుపై ఎక్కువ సేపు నొక్కండి.',
      // REVIEW:
      'first_run.tip_magnifier_prefix':
          'ఏ హెడర్‌లోనైనా మాగ్నిఫైయర్‌ను ఉపయోగించండి - లేదా నొక్కండి',
      // REVIEW:
      'first_run.tip_magnifier_suffix': '+K - ఏ రోగి చార్టుకైనా వెళ్లడానికి.',
      // REVIEW:
      'first_run.tip_dashboard':
          'పైన ఉన్న కార్డులు మీరు చర్య తీసుకోగల ప్రదేశాలకు తీసుకువెళతాయి - "డ్యూ మెడ్స్", "ఇన్‌పేషెంట్స్" మొదలైనవి ట్యాప్ చేయండి.',
      // Splash
      // REVIEW:
      'splash.app_title': 'VHHealth సిబ్బంది',
      // REVIEW:
      'splash.device_unsupported_title': 'పరికరం మద్దతు లేదు',
      // REVIEW:
      'splash.device_unsupported_body':
          'రోగి డేటా భద్రత కోసం, VHHealth సిబ్బంది ఈ పరికరంలో నడవలేదు. కారణం:',
      // REVIEW:
      'splash.device_unsupported_use_hospital_device':
          'దయచేసి హాస్పిటల్ జారీ చేసిన, మార్చబడని పరికరాన్ని ఉపయోగించండి.',
      // Housekeeping
      // REVIEW:
      'housekeeping.tasks_title': 'నా పనులు',
      // REVIEW:
      'housekeeping.sample_notice':
          'నమూనా పనులు చూపబడుతున్నాయి. బ్యాకెండ్ API త్వరలో వస్తుంది.',
      // REVIEW:
      'housekeeping.task_completed': '✅ పని పూర్తైనట్లు గుర్తించబడింది',
      // REVIEW:
      'housekeeping.task_started': 'పని ప్రారంభమైంది',
      // REVIEW:
      'housekeeping.no_tasks': 'ఇక్కడ ఎటువంటి పనులు లేవు',
      // REVIEW:
      'housekeeping.tab_all': 'అన్నీ',
      // REVIEW:
      'housekeeping.tab_pending': 'పెండింగ్',
      // REVIEW:
      'housekeeping.tab_done': 'పూర్తైంది',
      // REVIEW:
      'housekeeping.action_start': 'ప్రారంభించు',
      // REVIEW:
      'housekeeping.action_done': 'పూర్తైంది',
      // Logout
      // REVIEW:
      'logout.dialog_title': 'లాగౌట్?',
      // REVIEW:
      'logout.dialog_body':
          'మీరు మీ ఉద్యోగి ID మరియు పాస్‌వర్డ్‌తో మళ్లీ సైన్ ఇన్ చేయాల్సి ఉంటుంది.',
      // REVIEW:
      'logout.tooltip': 'లాగౌట్',
      // Misc
      // REVIEW:
      'shift_card.no_shift': 'షిఫ్ట్ కేటాయించబడలేదు',
      // REVIEW:
      'pharmacy.no_preview': 'ప్రివ్యూ లేదు',
      // REVIEW:
      'print.generated_by': 'VHHealth సిబ్బంది యాప్ ద్వారా రూపొందించబడింది',
      // REVIEW:
      'error.something_went_wrong': 'ఏదో తప్పు జరిగింది',
      // REVIEW:
      'error.restart_or_contact':
          'దయచేసి యాప్‌ను పునఃప్రారంభించండి లేదా మద్దతును సంప్రదించండి.',
      // REVIEW:
      'directory.api_unavailable':
          'సిబ్బంది డైరెక్టరీ API ఇంకా అందుబాటులో లేకపోవచ్చు.',
      // REVIEW:
      'staff_mgmt.list_api_unavailable':
          'సిబ్బంది జాబితా API ఇంకా అందుబాటులో లేకపోవచ్చు.',
      // REVIEW:
      'appointments.no_today': 'నేడు ఎటువంటి అపాయింట్‌మెంట్‌లు లేవు',

      // First-pass AI fill (2026-05-03); validate before production.
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.payslip.empty_body':
          'ప్రతినెలా 5వ తేదీన పేస్లిప్‌లు జారీ చేస్తారు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.payslip.new_badge': 'కొత్త',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.download_pdf': 'PDFని డౌన్‌లోడ్ చేయండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.pdf_not_available':
          'PDF ఇంకా అందుబాటులో లేదు - తర్వాత తనిఖీ చేయండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.pdf_failed_prefix': 'PDF తెరవడం విఫలమైంది:',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.pdf_being_generated':
          'PDF పేస్లిప్ రూపొందించబడుతోంది. ఇది త్వరలో ఇక్కడ కనిపిస్తుంది.',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.pdf_download_button': 'PDF Payslipని డౌన్‌లోడ్ చేయండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.opening': 'తెరుస్తోంది...',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.not_found': 'పేస్లిప్ కనుగొనబడలేదు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.attendance_header': '📅 హాజరు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.earnings_header': '💰 సంపాదన',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.deductions_header': '📉 తగ్గింపులు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.working_days': 'పని దినాలు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.days_present': 'ప్రస్తుతం ఉన్న రోజులు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.days_absent': 'రోజులు గైర్హాజరు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.lop_days': 'చెల్లింపు రోజుల నష్టం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.leave_days': 'రోజులు సెలవు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.overtime_hours': 'ఓవర్ టైం గంటలు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.basic': 'ప్రాథమిక జీతం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.hra': 'HRA',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.da': 'DA',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.special_allowance': 'ప్రత్యేక భత్యం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.transport_allowance': 'రవాణా భత్యం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.medical_allowance': 'మెడికల్ అలవెన్స్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.overtime_pay': 'ఓవర్ టైం చెల్లింపు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.bonus': 'బోనస్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.arrears': 'బకాయిలు చెల్లించారు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.lop_deduction': 'చెల్లింపు నష్టం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.pf_employee': 'PF (ఉద్యోగి 12%)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.esi': 'ESI (0.75%)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.professional_tax': 'వృత్తి పన్ను',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.tds': 'TDS',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.detail.advance_deduction': 'జీతం అడ్వాన్స్ తగ్గింపు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.query.replies_header': 'ప్రత్యుత్తరాలు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.query.raise_header': 'Payslip ప్రశ్నను పెంచండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.query.select_payslip': 'Payslip ఎంచుకోండి *',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.query.choose_payslip_hint': 'పేస్లిప్ ఎంచుకోండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.query.category_label': 'వర్గం *',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.query.subject_label': 'విషయం *',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.query.subject_required': 'సబ్జెక్ట్ అవసరం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.query.description_label': 'వివరణ *',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.query.description_required': 'వివరణ అవసరం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.query.pick_payslip': 'దయచేసి పేస్లిప్‌ని ఎంచుకోండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.tax_summary.fy_label': 'ఆర్థిక సంవత్సరం:',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.tax_summary.total_gross': 'మొత్తం స్థూల',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.tax_summary.total_net': 'మొత్తం నికర',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.tax_summary.taxable_income': 'పన్ను విధించదగిన ఆదాయం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.tax_summary.tax_payable': 'చెల్లించవలసిన పన్ను',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.tax_summary.earnings_breakdown': '💰 ఆదాయాల విభజన',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.tax_summary.deductions_breakdown': '📉 తగ్గింపుల విభజన',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.tax_summary.tax_computation': '🧾 పన్ను గణన (కొత్త పాలన)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.tax_summary.standard_deduction': 'తక్కువ: స్టాండర్డ్ డిడక్షన్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.tax_summary.disclaimer':
          'ఇది కొత్త పన్ను విధానంలో లెక్కించబడిన సూచిక మాత్రమే. వాస్తవ ఫారం 16 ఆర్థిక సంవత్సరం చివరిలో మీ యజమాని ద్వారా జారీ చేయబడుతుంది.',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.tax_summary.download_pdf': 'PDFని డౌన్‌లోడ్ చేయండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.tax_summary.download_form16': 'ఫారమ్ 16 PDFని డౌన్‌లోడ్ చేయండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.declaration.estimated_deductions':
          'అంచనా వేసిన పన్ను మినహాయింపులు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.declaration.total_deductions': 'మొత్తం తగ్గింపులు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.declaration.section_80c':
          '80C పెట్టుబడులు (గరిష్టంగా ₹1,50,000)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.declaration.section_80d': '80D ఆరోగ్య బీమా',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.declaration.section_other': 'ఇతర తగ్గింపులు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.declaration.section_rent': 'HRA / అద్దె',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_ppf': 'PPF',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_epf': 'EPF వాలంటరీ',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_elss': 'ELSS (మ్యూచువల్ ఫండ్స్)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_lic': 'LIC ప్రీమియం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_nsc': 'NSC',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_home_loan_principal': 'హోమ్ లోన్ ప్రిన్సిపాల్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_tuition': 'ట్యూషన్ ఫీజు (పిల్లలు)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_other_80c': 'ఇతర 80C',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_hi_self': 'ఆరోగ్య బీమా - స్వీయ',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_hi_parents': 'ఆరోగ్య బీమా - తల్లిదండ్రులు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_nps': 'NPS సహకారం (80CCD)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_home_loan_interest': 'హోమ్ లోన్ వడ్డీ (24బి)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_edu_loan': 'విద్యా రుణ వడ్డీ (80E)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.declaration.field_rent_monthly': 'నెలవారీ అద్దె చెల్లించారు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.declaration.rent_receipts': 'అద్దె రసీదులు అందించారు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.declaration.past_title': 'గత ప్రకటనలు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'payroll.declaration.fy_submitted': 'సమర్పించారు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'hr.timeframe.this_month': 'ఈ నెల',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'hr.timeframe.last_month': 'గత నెల',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'hr.timeframe.this_quarter': 'ఈ త్రైమాసికం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'hr.timeframe.this_year': 'ఈ సంవత్సరం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'hr.avg_attendance_rate': 'సగటు హాజరు రేటు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'hr.late_arrivals': 'ఆలస్యంగా వచ్చినవి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'hr.absentees': 'హాజరుకానివారు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'hr.total_applications': 'మొత్తం అప్లికేషన్లు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'hr.approved': 'ఆమోదించబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'hr.rejected': 'తిరస్కరించబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'hr.pending_approval': 'ఆమోదం పెండింగ్‌లో ఉంది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'hr.action.staff_management.subtitle':
          'సిబ్బందిని వీక్షించండి, జోడించండి & సవరించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'hr.action.performance': 'పనితీరు సమీక్షలు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'hr.action.performance.subtitle': 'పనితీరు రికార్డులను నిర్వహించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'hr.action.staff_directory.subtitle':
          'సిబ్బంది సభ్యులందరినీ బ్రౌజ్ చేయండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'hr.action.reports': 'నివేదికలు & ఫిర్యాదులు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'hr.action.reports.subtitle': 'సంఘటన నివేదికలు, సిబ్బంది మనోవేదనలు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'hr.action.payslips.subtitle':
          'గత 3 నెలల్లో వీక్షించండి & డౌన్‌లోడ్ చేయండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'staff_mgmt.search_hint': 'పేరు, విభాగం, పాత్ర ద్వారా శోధించండి...',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'staff_mgmt.edit_staff': 'సిబ్బందిని సవరించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'staff_mgmt.full_name': 'పూర్తి పేరు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'staff_mgmt.name_required': 'పేరు అవసరం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'staff_mgmt.department': 'శాఖ',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'staff_mgmt.clear_filter': 'ఫిల్టర్‌ని తీసివేయండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'staff_mgmt.active': 'చురుకుగా',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'staff_mgmt.inactive': 'నిష్క్రియ',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'staff_mgmt.no_staff_members': 'సిబ్బంది లేరు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'staff_mgmt.search_empty': 'వేరొక శోధన పదాన్ని ప్రయత్నించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'staff_mgmt.api_pending':
          'API కనెక్ట్ అయిన తర్వాత సిబ్బంది డేటా ఇక్కడ కనిపిస్తుంది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'staff_mgmt.added_pending':
          '✅ సిబ్బంది జోడించబడింది (బ్యాకెండ్ API పెండింగ్‌లో ఉంది)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'performance.tab.add': 'సమీక్షను జోడించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'performance.tab.reviews': 'సమీక్షలు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'performance.employee_id_label': 'ఉద్యోగి ID',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'performance.employee_id_hint': 'ఉదా EMP-001',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'performance.employee_id_required': 'ఉద్యోగి ID అవసరం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'performance.review_period_label': 'సమీక్ష వ్యవధి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'performance.overall_rating': 'మొత్తం రేటింగ్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'performance.comments_label': 'పనితీరు వ్యాఖ్యలు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'performance.comments_hint':
          'పనితీరు, విజయాలు, అభివృద్ధి రంగాలను వివరించండి...',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'performance.comments_required': 'వ్యాఖ్యలు అవసరం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'performance.goals_label': 'తదుపరి వ్యవధి కోసం లక్ష్యాలు (ఐచ్ఛికం)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'performance.goals_hint': 'లక్ష్యాలు మరియు అంచనాలను సెట్ చేయండి...',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'performance.saving_button': 'సేవ్ చేస్తోంది...',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'performance.rating.exceptional': 'అసాధారణమైనది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'performance.rating.exceeds': 'అంచనాలను మించిపోయింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'performance.rating.meets': 'అంచనాలను అందుకుంటుంది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'performance.rating.needs_improvement': 'మెరుగుదల అవసరం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'performance.rating.unsatisfactory': 'సంతృప్తికరంగా లేదు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'performance.no_reviews': 'ఇంకా సమీక్షలు లేవు',
      'directory.search_hint': 'పేరు, శాఖ, పాత్ర ద్వారా శోధించండి...',
      'directory.empty': 'డైరెక్టరీ ఖాళీగా ఉంది',
      'directory.search_empty': 'వేరొక శోధన పదాన్ని ప్రయత్నించండి',
      'directory.api_pending':
          'API కనెక్ట్ అయిన తర్వాత సిబ్బంది సభ్యులు ఇక్కడ కనిపిస్తారు',
      'directory.staff_empty_body': 'సిబ్బంది దొరకలేదు',
      'reports.hub.confidentiality_note':
          'అన్ని నివేదికలు గోప్యంగా నిర్వహించబడతాయి. విలేకరులపై ప్రతీకారం ఖచ్చితంగా నిషేధించబడింది.',
      'reports.hub.prompt': 'మీరు ఏమి నివేదించాలనుకుంటున్నారు?',
      'reports.hub.incident_subtitle':
          'రోగి పడిపోవడం, మందుల లోపం, సమీపంలో మిస్, పరికరాలు వైఫల్యం లేదా ఏదైనా ప్రతికూల సంఘటన',
      'reports.hub.incident_note':
          'సెంటినల్/తీవ్రమైన సంఘటనలు తక్షణమే తీవ్రమవుతాయి',
      'reports.hub.grievance_subtitle':
          'వేధింపులు, అన్యాయమైన చికిత్స, అసురక్షిత పని పరిస్థితులు లేదా విధాన ఉల్లంఘనలు',
      'reports.hub.grievance_note': 'అనామకంగా సమర్పించవచ్చు. HR మాత్రమే.',
      'reports.hub.my_reports': 'నా నివేదికలు & స్థితి',
      'my_reports.tab.incidents': 'సంఘటనలు',
      'my_reports.tab.grievances': 'మనోవేదనలు',
      'my_reports.empty_incidents': 'సంఘటన నివేదికలు లేవు',
      'my_reports.empty_grievances': 'ఎలాంటి ఫిర్యాదులు దాఖలు చేయలేదు',
      'my_reports.label.status': 'స్థితి',
      'my_reports.label.severity': 'తీవ్రత',
      'my_reports.label.type': 'టైప్ చేయండి',
      'my_reports.label.location': 'స్థానం',
      'my_reports.label.description': 'వివరణ',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.severity_label': 'తీవ్రత *',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.severity.low_desc': 'చిన్నది, ఎటువంటి హాని జరగలేదు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.severity.moderate_desc':
          'కొంత ప్రభావం, స్థానికంగా నిర్వహించబడుతుంది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.severity.severe_desc': 'ముఖ్యమైన హాని, విచారణ అవసరం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.severity.sentinel_desc':
          'ఊహించని మరణం లేదా తీవ్రమైన హాని',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.type_label': 'సంఘటన రకం *',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.type.near_miss': 'మిస్ దగ్గర',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.type.patient_fall': 'రోగి పతనం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.type.medication_error': 'మందుల లోపం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.type.needle_stick': 'నీడిల్ స్టిక్ / షార్ప్స్ గాయం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.type.equipment_failure': 'సామగ్రి వైఫల్యం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.type.infection': 'ఇన్ఫెక్షన్ / ఎక్స్పోజర్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.type.fire_safety': 'అగ్ని / భద్రత ప్రమాదం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.type.patient_aggression': 'రోగి దూకుడు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.type.security_breach': 'భద్రతా ఉల్లంఘన',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.type.other': 'ఇతర',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.title_label': 'సంక్షిప్త శీర్షిక *',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.title_hint': 'ఉదా రోగి మంచం 12B దగ్గర పడిపోయాడు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.title_required': 'శీర్షిక అవసరం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.what_happened': 'ఏం జరిగింది? *',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.what_happened_hint':
          'సంఘటనను వివరంగా వివరించండి - ఏమి జరిగింది, ఎవరు పాల్గొన్నారు, పరిస్థితులు ఏమిటి...',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.description_required': 'వివరణ అవసరం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.date_label': 'తేదీ *',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.time_label': 'సమయం *',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.location_label': 'స్థానం (ఐచ్ఛికం)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.location_hint': 'వార్డ్, గది లేదా ప్రాంతం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.patient_involved': 'రోగి ప్రమేయం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.patient_name_label': 'రోగి పేరు / ID (ఐచ్ఛికం)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.witnesses_label': 'సాక్షులు (ఐచ్ఛికం)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.witnesses_hint': 'సంఘటన చూసిన వారి పేర్లు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.immediate_action': 'తక్షణ చర్య తీసుకోబడింది (ఐచ్ఛికం)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.immediate_action_hint': 'ఘటన జరిగిన వెంటనే ఏం చేశారు?',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.anonymous': 'అనామకంగా సమర్పించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.anonymous_note': 'ఈ నివేదికకు మీ పేరు జోడించబడదు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.escalation_note':
          'ఇది అధిక ప్రాధాన్యతగా పెంచబడింది. నిర్వహణకు నోటీసులిచ్చింది.',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.routine_note':
          'మీ నివేదిక స్వీకరించబడింది మరియు 24 గంటల్లో సమీక్షించబడుతుంది.',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'incident_report.done_button': 'పూర్తయింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'grievance.privacy_note':
          'ఈ ఫారమ్ HR మరియు సీనియర్ మేనేజ్‌మెంట్ ద్వారా మాత్రమే కనిపిస్తుంది. మీరు అనామకంగా సమర్పించవచ్చు.',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'grievance.type_label': 'ఫిర్యాదు రకం *',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'grievance.type.harassment': 'వేధింపులు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'grievance.type.discrimination': 'వివక్ష',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'grievance.type.unfair_treatment': 'అన్యాయమైన చికిత్స',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'grievance.type.unsafe_conditions': 'అసురక్షిత పని పరిస్థితులు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'grievance.type.workload': 'విపరీతమైన పనిభారం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'grievance.type.pay_dispute': 'చెల్లింపు / పరిహారం వివాదం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'grievance.type.schedule_conflict': 'షెడ్యూల్ / రోస్టర్ వైరుధ్యం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'grievance.type.policy_violation': 'విధాన ఉల్లంఘన',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'grievance.type.other': 'ఇతర',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'grievance.subject_label': 'విషయం *',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'grievance.subject_hint': 'మీ ఆందోళన యొక్క సంక్షిప్త సారాంశం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'grievance.subject_required': 'సబ్జెక్ట్ అవసరం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'grievance.describe_label': 'మీ మనోవేదనను వివరించండి*',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'grievance.describe_hint':
          'దయచేసి మీరు భాగస్వామ్యం చేయడానికి సుఖంగా ఉన్నంత వివరాలను అందించండి...',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'grievance.description_required': 'వివరణ అవసరం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'grievance.against_whom_label': 'ఎవరికి వ్యతిరేకంగా (ఐచ్ఛికం)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'grievance.against_whom_hint': 'పేరు లేదా పాత్ర, వర్తిస్తే',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'grievance.dept_label': 'విభాగం (ఐచ్ఛికం)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'grievance.date_optional': 'ఇది ఎప్పుడు జరిగింది? (ఐచ్ఛికం)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'grievance.date_prefix': 'ఇది ఎప్పుడు జరిగింది:',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'grievance.anonymous': 'అనామకంగా సమర్పించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'grievance.anonymous_note': 'మీ గుర్తింపు బహిర్గతం చేయబడదు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'grievance.acknowledgement_note':
          'మీ ఫిర్యాదు స్వీకరించబడింది. HR 2 పని రోజులలోపు ధృవీకరిస్తుంది.',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'grievance.acknowledgement_anonymous':
          'అజ్ఞాతంగా సమర్పించబడింది. HR 2 పని రోజులలోపు ధృవీకరిస్తుంది.',
      'housekeeping.hub.log_title': 'లాగ్ క్లీనింగ్',
      'housekeeping.hub.log_subtitle':
          'ఫోటో సాక్ష్యంతో పూర్తయిన శుభ్రతను రికార్డ్ చేయండి',
      'housekeeping.hub.raise_title': 'అభ్యర్థనను పెంచండి',
      'housekeeping.hub.raise_subtitle':
          'మురికిగా ఉన్న ప్రాంతాన్ని నివేదించండి లేదా శుభ్రపరచడానికి అభ్యర్థించండి',
      'housekeeping.hub.my_title': 'నా కార్యాచరణ',
      'housekeeping.hub.my_subtitle':
          'మీ లాగ్‌లు, కేటాయించిన విధులు మరియు అభ్యర్థనలను వీక్షించండి',
      'housekeeping.log.type_label': 'శుభ్రపరిచే రకం *',
      'housekeeping.type.routine': 'రొటీన్ క్లీనింగ్',
      'housekeeping.type.deep': 'డీప్ క్లీనింగ్',
      'housekeeping.type.disinfection': 'క్రిమిసంహారక',
      'housekeeping.type.spillage': 'స్పిల్లేజ్ క్లీన్-అప్',
      'housekeeping.type.post_procedure': 'పోస్ట్-ప్రొసీజర్',
      'housekeeping.zone_location_label': 'జోన్ / స్థానం *',
      'housekeeping.select_zone_label': 'జోన్‌ని ఎంచుకోండి (ఐచ్ఛికం)',
      'housekeeping.select_zone_or_type':
          '-- ఎంచుకోండి లేదా క్రింద టైప్ చేయండి --',
      'housekeeping.describe_location': 'లేదా ఖచ్చితమైన స్థానాన్ని వివరించండి',
      'housekeeping.location_hint': 'ఉదా గది 204, లిఫ్ట్ దగ్గర కారిడార్',
      'housekeeping.photo_evidence': 'ఫోటో సాక్ష్యం',
      'housekeeping.take_photo': 'ఫోటో తీయడానికి నొక్కండి',
      'housekeeping.notes_label': 'గమనికలు (ఐచ్ఛికం)',
      'housekeeping.submitting_log': 'సమర్పిస్తోంది...',
      'housekeeping.select_zone_error':
          'జోన్‌ను ఎంచుకోండి లేదా స్థానాన్ని నమోదు చేయండి',
      'housekeeping.logged_body':
          'మీ క్లీనింగ్ రికార్డ్ సంతకం చేసి సమర్పించబడింది.',
      'housekeeping.done_button': 'పూర్తయింది',
      'housekeeping.raise.title': 'అభ్యర్థనను పెంచండి',
      'housekeeping.raise.type_label': 'అభ్యర్థన రకం *',
      'housekeeping.raise.urgency_label': 'అత్యవసరం *',
      'housekeeping.request_type.cleaning': 'జనరల్ క్లీనింగ్',
      'housekeeping.request_type.spillage': 'చిందటం / స్పిల్',
      'housekeeping.request_type.waste': 'వ్యర్థాల తొలగింపు',
      'housekeeping.request_type.linen': 'నార / పరుపు',
      'housekeeping.request_type.disinfection': 'క్రిమిసంహారక',
      'housekeeping.request_type.other': 'ఇతర',
      'housekeeping.description_label': 'వివరణ (ఐచ్ఛికం)',
      'housekeeping.description_hint': 'శ్రద్ధ అవసరం ఏమిటి?',
      'housekeeping.problem_photo': 'సమస్య ఫోటో (ఐచ్ఛికం)',
      'housekeeping.photograph_problem': 'సమస్యను ఫోటో తీయడానికి నొక్కండి',
      'housekeeping.raising_button': 'పెంచడం...',
      'housekeeping.notified_note': 'హౌస్ కీపింగ్ సిబ్బందికి తెలియజేయబడుతుంది.',
      'housekeeping.my.title': 'నా కార్యాచరణ',
      'housekeeping.my.tab_logs': 'నా లాగ్‌లు',
      'housekeeping.my.tab_requests': 'అభ్యర్థనలు',
      'housekeeping.my.tab_raised': 'నా చేత పెంచబడింది',
      'housekeeping.my.tab_assigned': 'నాకు కేటాయించబడింది',
      'housekeeping.no_logs': 'ఇంకా శుభ్రపరిచే లాగ్‌లు లేవు',
      'housekeeping.no_requests': 'ఇక్కడ అభ్యర్థనలు లేవు',
      'housekeeping.unknown_location': 'తెలియని స్థానం',
      'housekeeping.complete_dialog_title': 'పూర్తయినట్లు గుర్తు పెట్టండి',
      'housekeeping.completion_notes': 'పూర్తి గమనికలు (ఐచ్ఛికం)',
      'housekeeping.add_completion_photo': 'పూర్తయిన ఫోటోను జోడించండి',
      'housekeeping.marked_complete':
          '✅ అభ్యర్థన పూర్తయినట్లు గుర్తు పెట్టబడింది',
      'housekeeping.status.verified': 'ధృవీకరించబడింది',
      'housekeeping.status.flagged': 'ధ్వజమెత్తారు',
      'housekeeping.status.submitted': 'సమర్పించబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'blood_bank.tab.inventory': 'ఇన్వెంటరీ',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'blood_bank.tab.requests': 'అభ్యర్థనలు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'blood_bank.tab.donations': 'విరాళాలు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'blood_bank.refresh_tooltip': 'ఇన్వెంటరీని రిఫ్రెష్ చేయండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'blood_bank.legend.adequate': '>= 10 యూనిట్లు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'blood_bank.legend.low': '5-9 యూనిట్లు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'blood_bank.legend.critical': '< 5 యూనిట్లు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'blood_bank.stock.critical_low': 'క్లిష్టమైన తక్కువ',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'blood_bank.stock.low': 'తక్కువ స్టాక్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'blood_bank.stock.adequate': 'తగినది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'blood_bank.request_header': 'రక్తాన్ని అభ్యర్థించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'blood_bank.patient_name_label': 'రోగి పేరు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'blood_bank.patient_name_required': 'రోగి పేరు అవసరం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'blood_bank.blood_type_label': 'రక్త రకం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'blood_bank.blood_type_required': 'రక్త రకాన్ని ఎంచుకోండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'blood_bank.units_label': 'యూనిట్లు అవసరం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'blood_bank.units_required': 'యూనిట్లు అవసరం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'blood_bank.units_invalid': 'చెల్లుబాటు అయ్యే నంబర్‌ను నమోదు చేయండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'blood_bank.reason_label': 'కారణం / గమనికలు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'blood_bank.submitting_button': 'సమర్పిస్తోంది...',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'blood_bank.donations.title': 'విరాళం రికార్డులు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'blood_bank.donations.body':
          'రక్తదాన రికార్డులను వీక్షించండి మరియు నిర్వహించండి.\nఈ విభాగం విరాళం చరిత్ర మరియు రాబోయే విరాళం డ్రైవ్‌లను ప్రదర్శిస్తుంది.',
      'dietary.refresh_tooltip': 'వర్క్‌లిస్ట్‌ని రిఫ్రెష్ చేయండి',
      'dietary.new_order_button': 'కొత్త ఆర్డర్',
      'dietary.new_order_dialog': 'కొత్త ఆహార క్రమం',
      'dietary.patient_uid_label': 'రోగి UID',
      'dietary.patient_uid_required': 'అవసరం',
      'dietary.diet_type_label': 'ఆహారం రకం',
      'dietary.diet_type_required': 'ఆహార రకాన్ని ఎంచుకోండి',
      'dietary.meal_time_label': 'భోజన సమయం',
      'dietary.meal_time_required': 'భోజన సమయాన్ని ఎంచుకోండి',
      'dietary.restrictions_label': 'పరిమితులు / అలెర్జీలు',
      'dietary.notes_label': 'గమనికలు',
      'dietary.discontinued_success': 'డైట్ ఆర్డర్ నిలిపివేయబడింది',
      'dietary.discontinue': 'నిలిపివేయండి',
      'dietary.diet.regular': 'రెగ్యులర్',
      'dietary.diet.diabetic': 'డయాబెటిక్',
      'dietary.diet.cardiac': 'కార్డియాక్',
      'dietary.diet.renal': 'మూత్రపిండము',
      'dietary.diet.soft': 'మృదువైన',
      'dietary.diet.liquid': 'లిక్విడ్',
      'dietary.diet.npo': 'NPO',
      'dietary.diet.enteral': 'ఎంటరల్',
      'dietary.meal.breakfast': 'అల్పాహారం',
      'dietary.meal.lunch': 'లంచ్',
      'dietary.meal.dinner': 'డిన్నర్',
      'dietary.meal.snack': 'చిరుతిండి',
      'dietary.empty_title': 'ఆహార నియమాలు లేవు',
      'dietary.empty_body':
          'కొత్త ఆర్డర్‌ని సృష్టించడానికి దిగువ బటన్‌ను నొక్కండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.pick_date': 'తేదీని ఎంచుకోండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.tab.schedule': 'షెడ్యూల్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.tab.availability': 'లభ్యత',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.no_surgeries': 'శస్త్రచికిత్సలు షెడ్యూల్ చేయబడలేదు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.no_room_data': 'గది డేటా అందుబాటులో లేదు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.status.scheduled': 'షెడ్యూల్ చేయబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.status.in_progress': 'పురోగతిలో ఉంది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.status.completed': 'పూర్తయింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.status.cancelled': 'రద్దు చేయబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.surgeon_prefix': 'సర్జన్:',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.label.patient_uid': 'రోగి UID',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.label.procedure_code': 'ప్రొసీజర్ కోడ్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.label.ot_room': 'OT గది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.label.date': 'తేదీ',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.label.time': 'సమయం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.label.duration': 'వ్యవధి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.label.surgeon': 'సర్జన్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.label.anesthetist': 'మత్తు వైద్యుడు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.label.status': 'స్థితి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.label.blood_arranged': 'బ్లడ్ అరేంజ్డ్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.label.consent': 'సమ్మతి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.label.equipment': 'పరికరాలు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.cancel_button': 'రద్దు చేయి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.checklist.consent': 'సమ్మతి లభించింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.checklist.blood': 'బ్లడ్ అరేంజ్డ్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.checklist.equipment': 'సామగ్రి తనిఖీ చేయబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.checklist.patient_id': 'రోగిని గుర్తించారు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.submit_checklist': 'చెక్‌లిస్ట్‌ను సమర్పించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.checklist_updated': 'చెక్‌లిస్ట్ నవీకరించబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.status_updated_to': 'స్థితి అప్‌డేట్ చేయబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.yes': 'అవును',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.no': 'నం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.available': 'అందుబాటులో ఉంది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'theatre.occupied': 'ఆక్రమించబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'radiology.filters_tooltip': 'ఫిల్టర్లు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'radiology.filters_header': 'ఫిల్టర్లు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'radiology.status_label': 'స్థితి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'radiology.modality_label': 'మోడాలిటీ',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'radiology.status.all': 'అన్నీ',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'radiology.status.pending': 'పెండింగ్‌లో ఉంది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'radiology.status.in_progress': 'పురోగతిలో ఉంది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'radiology.status.completed': 'పూర్తయింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'radiology.status.cancelled': 'రద్దు చేయబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'radiology.no_orders': 'రేడియాలజీ ఆదేశాలు లేవు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'radiology.label.study_type': 'అధ్యయనం రకం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'radiology.label.modality': 'మోడాలిటీ',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'radiology.label.body_part': 'శరీర భాగం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'radiology.label.priority': 'ప్రాధాన్యత',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'radiology.label.clinical_indication': 'క్లినికల్ సూచన',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'radiology.label.notes': 'గమనికలు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'radiology.label.report': 'నివేదించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'radiology.label.findings': 'కనుగొన్నవి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'radiology.label.impression': 'ముద్ర',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'radiology.cancel_order': 'ఆర్డర్ రద్దు చేయండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'radiology.findings_required': 'అన్వేషణలు అవసరం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'radiology.report_submitted': 'నివేదిక సమర్పించారు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'radiology.order_cancelled': 'ఆర్డర్ రద్దు చేయబడింది',
      'schedule.prev_week': 'మునుపటి వారం',
      'schedule.next_week': 'వచ్చే వారం',
      'schedule.week_this': 'ఈ వారం',
      'schedule.week_next': 'తదుపరి వారం',
      'schedule.week_last': 'గత వారం',
      'schedule.total_label': 'మొత్తం',
      'schedule.days_logged': 'రోజులు లాగిన్',
      'schedule.hours_worked_suffix': 'h పనిచేశారు',
      'schedule.upcoming': 'రాబోయేది',
      'schedule.no_record': 'రికార్డు లేదు',
      'schedule.load_failed_prefix': 'షెడ్యూల్‌ను లోడ్ చేయడం సాధ్యపడలేదు:',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'investigations.tab.upload': 'ఫలితాన్ని అప్‌లోడ్ చేయండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'investigations.tab.pending': 'పెండింగ్‌లో ఉంది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'investigations.tab.recent': 'ఇటీవలి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'investigations.upload_intro':
          'ఫోన్ నంబర్ ద్వారా రోగిని శోధించండి మరియు వారి పరిశోధన ఫలితాలను అప్‌లోడ్ చేయండి.',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'investigations.phone_label': 'రోగి ఫోన్ నంబర్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'investigations.phone_hint': '+91 XXXXX XXXXX',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'investigations.phone_required': 'ఫోన్ అవసరం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'investigations.phone_invalid':
          'చెల్లుబాటు అయ్యే ఫోన్ నంబర్‌ను నమోదు చేయండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'investigations.test_type_label': 'పరీక్ష రకం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'investigations.test_type_required': 'పరీక్ష రకాన్ని ఎంచుకోండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'investigations.result_label': 'ఫలితం / సారాంశం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'investigations.result_hint':
          'పరీక్ష ఫలితాలు లేదా సారాంశాన్ని నమోదు చేయండి...',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'investigations.clinical_notes_label': 'క్లినికల్ నోట్స్ (ఐచ్ఛికం)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'investigations.clinical_notes_hint': 'అదనపు పరిశీలనలు...',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'investigations.attach_report': 'నివేదిక ఫైల్‌ను అటాచ్ చేయండి (ఐచ్ఛికం)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'investigations.clear_file': 'క్లియర్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'investigations.file_too_large':
          'ఫైల్ చాలా పెద్దది. గరిష్ట పరిమాణం 10 MB.',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'investigations.file_pick_failed': 'ఫైల్‌ని ఎంచుకోవడంలో విఫలమైంది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'investigations.uploading': 'అప్‌లోడ్ చేస్తోంది...',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'investigations.pending_empty': 'పెండింగ్‌లో విచారణలు లేవు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'investigations.pending_empty_body': 'అన్నీ పట్టుబడ్డాయి!',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'investigations.recent_empty': 'ఇటీవలి పరిశోధనలు లేవు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'investigations.recent_empty_body':
          'మీ పరిశోధన అప్‌లోడ్‌లు ఇక్కడ కనిపిస్తాయి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'investigations.start_button': 'ప్రారంభించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'investigations.complete_button': 'పూర్తి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'investigations.marked_as_prefix': '✅ దర్యాప్తుగా గుర్తించబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'lab_bookings.tab.new': 'కొత్తది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'lab_bookings.tab.active': 'చురుకుగా',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'lab_bookings.tab.done': 'పూర్తయింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'lab_bookings.empty_prefix': 'బుకింగ్‌లు లేవు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'lab_bookings.view_slip': 'ప్రిస్క్రిప్షన్ స్లిప్ చూడండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'lab_bookings.home_collection': 'హోమ్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'lab_bookings.walk_in': 'వాక్-ఇన్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'lab_bookings.confirm_dialog': 'బుకింగ్‌ని నిర్ధారించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'lab_bookings.actual_tests_label': 'వాస్తవ పరీక్షలు (వేరేగా ఉంటే)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'lab_bookings.actual_tests_hint': 'పరీక్ష పేర్లను ధృవీకరించండి/జోడించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'lab_bookings.final_cost_label': 'తుది ధర (₹)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'lab_bookings.confirm_button': 'నిర్ధారించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'lab_bookings.confirmed_toast': 'బుకింగ్ నిర్ధారించబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'lab_bookings.dispatch_dialog': 'డిస్పాచ్ కలెక్టర్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'lab_bookings.collector_phone': 'కలెక్టర్ ఫోన్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'lab_bookings.dispatch_button': 'పంపండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'lab_bookings.dispatched_toast': 'కలెక్టర్ పంపించారు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'lab_bookings.sharing_location': '📍 స్థానాన్ని భాగస్వామ్యం చేస్తోంది...',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'lab_bookings.mark_collected': 'మార్క్ సేకరించబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'lab_bookings.samples_collected_toast': 'నమూనాలను సేకరించారు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'lab_bookings.start_processing': 'ప్రాసెసింగ్ ప్రారంభించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'lab_bookings.processing_started_toast': 'ప్రాసెసింగ్ ప్రారంభమైంది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'lab_bookings.upload_result': 'ఫలితాన్ని అప్‌లోడ్ చేయండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'lab_bookings.select_file': 'ఫైల్‌ని ఎంచుకోండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'lab_bookings.result_uploaded_toast': 'ఫలితం అప్‌లోడ్ చేయబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'lab_bookings.view_result': 'ఫలితాన్ని వీక్షించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.queue_title': 'ఫార్మసీ క్యూ',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.queue_subtitle': 'ఆర్డర్లు క్యూ కట్టాయి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.tab.new': 'కొత్తది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.tab.active': 'చురుకుగా',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.tab.done': 'పూర్తయింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.empty.new': 'కొత్త ఆర్డర్‌లు లేవు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.empty.active': 'యాక్టివ్ ఆర్డర్‌లు లేవు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.empty.done': 'పూర్తి చేసిన ఆర్డర్‌లు లేవు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.confirm_dialog': 'ఆర్డర్ నిర్ధారించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.patient_note_prefix': 'రోగి గమనిక:',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.items_label': 'వస్తువులు (ఒక పంక్తికి ఒకటి: పేరు, పరిమాణం, ధర)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.items_hint': 'డోలో 650, 2, 60\nపాన్ 40, 1, 95',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.total_cost_label': 'మొత్తం ధర (₹)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.view_confirm': 'వీక్షించండి & నిర్ధారించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.start_preparing': 'సిద్ధం చేయడం ప్రారంభించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.dispatch_dialog': 'డిస్పాచ్ ఆర్డర్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.delivery_person_name': 'డెలివరీ వ్యక్తి పేరు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.delivery_person_phone': 'డెలివరీ పర్సన్ ఫోన్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.mark_delivered_dialog': 'మార్క్ బట్వాడా?',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.mark_delivered_yes': 'అవును, డెలివరీ చేయబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.cancel_dialog': 'ఆర్డర్ రద్దు చేయాలా?',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.cancellation_reason': 'రద్దుకు కారణం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.delivery_type.pickup': 'పికప్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.delivery_type.delivery': 'డెలివరీ',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.order_confirmed_toast': 'ఆర్డర్ ధృవీకరించబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.mark_preparing_toast': 'సిద్ధమవుతున్నట్లు గుర్తు పెట్టబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.order_dispatched_toast': 'ఆర్డర్ పంపబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.order_delivered_toast': 'బట్వాడా చేసినట్లు గుర్తు పెట్టబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.order_cancelled_toast': 'ఆర్డర్ రద్దు చేయబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.status.placed': 'ఉంచబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.status.confirmed': 'నిర్ధారించారు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.status.preparing': 'సిద్ధమౌతోంది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.status.dispatched': 'పంపబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.status.delivered': 'పంపిణీ చేయబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'pharmacy.status.cancelled': 'రద్దు చేయబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'due_meds.search_hint': 'రోగి లేదా మందుల ద్వారా శోధించండి...',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'due_meds.empty_title': 'మందులు లేవు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'due_meds.empty_body':
          'ప్రాణాధారాలను రికార్డ్ చేయడానికి బెడ్ బోర్డ్‌పై ఉన్న మంచాన్ని నొక్కండి.',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'due_meds.held_badge': 'పట్టుకుంది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'due_meds.unknown_patient': 'తెలియని రోగి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'due_meds.unnamed_medication': '(పేరులేని మందులు)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'mar_scan.step1_prompt': '3లో 1వ దశ - రోగి చేతిపట్టీని స్కాన్ చేయండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'mar_scan.step1_subtitle':
          'రోగి రిస్ట్‌బ్యాండ్‌పై ఉన్న QR కోడ్‌పై కెమెరాను సూచించండి.',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'mar_scan.step2_prompt': '3లో 2వ దశ - డ్రగ్ బార్‌కోడ్‌ని స్కాన్ చేయండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'mar_scan.step2_subtitle':
          'ఇప్పుడు మందుల లేబుల్‌పై బార్‌కోడ్‌ను స్కాన్ చేయండి.',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'mar_scan.step3_header': '3లో 3వ దశ - 5-హక్కుల తనిఖీ',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'mar_scan.recording': 'రికార్డింగ్…',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'mar_scan.check_failed': '5-హక్కుల తనిఖీ విఫలమైంది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'mar_scan.override_hint':
          'ఈ పరిపాలనను రికార్డ్ చేయడానికి, కారణాన్ని డాక్యుమెంట్ చేయండి. ఈ ఎంట్రీ ఆడిట్ చేయబడింది.',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'mar_scan.override_reason_label':
          'ఓవర్‌రైడ్ కారణం (అవసరం, నిమి 5 అక్షరాలు)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'mar_scan.override_button': 'భర్తీ & నిర్వహించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'mar_scan.scan_next': 'తదుపరి మోతాదును స్కాన్ చేయండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'mar_scan.scan_again': 'మళ్లీ స్కాన్ చేయండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'mar_scan.try_again': 'మళ్లీ ప్రయత్నించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'mar_scan.unknown_medication': '(తెలియని మందులు)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'discharge.title_prefix': 'డిశ్చార్జ్ -',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'discharge.draft_saved': 'డ్రాఫ్ట్ సేవ్ చేయబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'discharge.sign_dialog_title': 'సైన్ డిశ్చార్జ్ సారాంశం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'discharge.sign_dialog_body':
          'సంతకం చేసిన తర్వాత, ఈ ఉత్సర్గ సారాంశం అధికారిక రికార్డ్ అవుతుంది మరియు సవరించబడదు (అడెండా మాత్రమే అనుమతించబడుతుంది).\n\nమీరు ఖచ్చితంగా సంతకం చేయాలనుకుంటున్నారా?',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'discharge.signed_badge':
          'సంతకం చేయబడింది - ఈ సారాంశం ఇప్పుడు అధికారికం మరియు మార్పులేనిది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'discharge.proceed_title': 'ఉత్సర్గను నిర్ధారించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'discharge.proceed_body_prefix': 'డిశ్చార్జ్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'discharge.must_sign_first':
          'డిశ్చార్జ్ సారాంశంపై ముందుగా డాక్టర్ సంతకం చేయాలి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'discharge.patient_button': 'డిశ్చార్జ్ పేషెంట్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'discharge.generate_title': 'ఉత్సర్గ సారాంశాన్ని రూపొందించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'discharge.generate_body':
          'ఇది స్వయంచాలకంగా ఈ అడ్మిషన్ నుండి అన్ని వార్డ్ నోట్స్, ప్రాణాధారాలు, పరిశోధనలు, మందులు మరియు రోగనిర్ధారణలను స్ట్రక్చర్డ్ డిశ్చార్జ్ సమ్మరీగా సంకలనం చేస్తుంది.',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'discharge.generate_button': 'సారాంశాన్ని రూపొందించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'discharge.generating': 'ఉత్పత్తి చేస్తోంది...',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'discharge.regenerate': 'సారాంశాన్ని పునరుత్పత్తి చేయండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'discharge.section.hospital_course': 'హాస్పిటల్ కోర్సు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'discharge.section.diagnosis': 'ఉత్సర్గ నిర్ధారణ',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'discharge.section.condition': 'ఉత్సర్గ పరిస్థితి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'discharge.section.follow_up': 'ఫాలో-అప్ సూచనలు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'discharge.section.activity': 'కార్యాచరణ పరిమితులు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'discharge.section.diet': 'డైట్ సూచనలు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'discharge.section.warning_signs': 'హెచ్చరిక సంకేతాలు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'discharge.section.medications': 'ఉత్సర్గపై మందులు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'discharge.section.investigations': 'పరిశోధనలు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'discharge.section.procedures': 'విధివిధానాలు నిర్వహించారు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'dispute.tab.submit': 'సమర్పించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'dispute.tab.my': 'నా వివాదాలు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'dispute.intro':
          'హాజరు రికార్డింగ్ సమస్యలను నివేదించడానికి దీన్ని ఉపయోగించండి. HR మీ రికార్డ్‌ని సమీక్షిస్తుంది మరియు సరిచేస్తుంది.',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'dispute.date_label': 'తేదీ',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'dispute.select_date': 'జారీ చేసిన తేదీని ఎంచుకోండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'dispute.issue_type_label': 'సమస్య రకం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'dispute.type.missed_checkin': 'చెక్-ఇన్ మిస్ అయింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'dispute.type.missed_checkout': 'చెక్ అవుట్ మిస్ అయింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'dispute.type.wrong_time': 'తప్పు సమయం నమోదు చేయబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'dispute.type.app_failure': 'యాప్/నెట్‌వర్క్ వైఫల్యం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'dispute.type.other': 'ఇతర',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'dispute.description_label': 'వివరణ',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'dispute.description_hint': 'ఏం జరిగిందో వివరించండి...',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'dispute.correct_times': 'సరైన సమయాలు (ఐచ్ఛికం)',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'dispute.correct_times_hint':
          'సరైన సమయాలు ఏమిటో మీకు తెలిస్తే, వాటిని ఇక్కడ నమోదు చేయండి.',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'dispute.check_in': 'చెక్-ఇన్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'dispute.check_out': 'చెక్-అవుట్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'dispute.required_error': 'తేదీ మరియు వివరణ అవసరం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'dispute.empty': 'ఎలాంటి వివాదాలు నమోదు కాలేదు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'dispute.hr_comment_prefix': 'HR:',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'overtime.tab.request': 'అభ్యర్థన',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'overtime.tab.my': 'నా అభ్యర్థనలు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'overtime.extra_hours_label': 'అదనపు గంటలు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'overtime.hours_suffix': 'గం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'overtime.type_label': 'టైప్ చేయండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'overtime.type.comp_time': 'పరిహారం సమయం ఆఫ్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'overtime.type.payment': 'ఓవర్ టైం చెల్లింపు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'overtime.reason_label': 'కారణం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'overtime.reason_hint': 'మీరు ఓవర్ టైం ఎందుకు పని చేసారు?',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'overtime.required_error': 'తేదీ మరియు కారణం అవసరం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'overtime.empty': 'ఓవర్ టైం అభ్యర్థనలు లేవు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'overtime.rejected_prefix': 'తిరస్కరించబడింది:',
      'telemedicine.title_prefix': 'వీడియో కాల్ -',
      'telemedicine.sdk_missing_title': 'వీడియో SDK ఇంకా సమగ్రపరచబడలేదు',
      'telemedicine.sdk_missing_body':
          'ఎనేబుల్ చేయడానికి agora_rtc_engine లేదా flutter_webrtcని జోడించండి.',
      'telemedicine.mute': 'మ్యూట్ చేయండి',
      'telemedicine.unmute': 'అన్‌మ్యూట్ చేయండి',
      'telemedicine.camera_off': 'కెమెరా ఆఫ్',
      'telemedicine.camera_on': 'కెమెరా ఆన్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.queue.compose_button': 'పరుగులు కంపోజ్ చేయండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.queue.voice_notes_button': 'వాయిస్ నోట్స్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.queue.filter.pending': 'పెండింగ్‌లో ఉంది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.queue.filter.accepted': 'అంగీకరించబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.queue.filter.edited': 'సవరించబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.queue.filter.rejected': 'తిరస్కరించబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.queue.filter.all': 'అన్నీ',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.queue.empty_title': 'ఈ ఫిల్టర్‌లో చిత్తుప్రతులు లేవు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.queue.empty_body':
          'మీరు రివ్యూయర్ కవర్ చేసే అడ్మిషన్ కోసం క్లినికల్ AI డ్రాఫ్ట్ రూపొందించబడినప్పుడు, అది ఇక్కడ కనిపిస్తుంది.',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.queue.load_failed': 'సమీక్షలను లోడ్ చేయడంలో విఫలమైంది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.queue.patient_fallback': 'రోగి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.draft.reject_title': 'చిత్తుప్రతిని తిరస్కరించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.draft.reject_reason_label': 'కారణం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.draft.reject_reason_hint': 'ఈ ముసాయిదా ఎందుకు సరిపోదు?',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.draft.review_not_found': 'సమీక్ష కనుగొనబడలేదు.',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.draft.invalid_json': 'సవరించిన చిత్తుప్రతి JSON చెల్లదు.',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.draft.accept_edits': 'సవరణలను ఆమోదించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.draft.decision_recorded':
          'ముసాయిదా నిర్ణయం రికార్డ్ చేయబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.draft.no_safety_flags': 'భద్రతా జెండాలు ఎగరలేదు.',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.draft.decided_prefix': 'డ్రాఫ్ట్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.draft.decision_failed_prefix':
          'నిర్ణయాన్ని రికార్డ్ చేయడంలో విఫలమైంది:',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_runs.title': 'పరుగులు కంపోజ్ చేయండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_runs.empty': 'ఈ వీక్షణలో ఏ కంపోజ్ అమలు చేయబడదు.',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_runs.filter.active': 'చురుకుగా',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_runs.filter.paused': 'పాజ్ చేయబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_runs.filter.completed': 'పూర్తయింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_runs.filter.failed': 'విఫలమైంది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_runs.filter.all': 'అన్నీ',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_runs.review_prefix': 'సమీక్ష:',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_runs.started_prefix': 'ప్రారంభించారు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_runs.run_prefix': 'పరుగు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_runs.admission_word': 'ప్రవేశం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.not_found': 'పరుగు దొరకలేదు.',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.resumed': 'కంపోజ్ పునఃప్రారంభించబడింది.',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.open_in_queue': 'సమీక్ష క్యూలో తెరవండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.detail_title_prefix': 'కంపోజ్ రన్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.admission_header_prefix': 'ప్రవేశం',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.subgraphs': 'సబ్‌గ్రాఫ్‌లు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.no_subgraphs': 'సబ్‌గ్రాఫ్ పరుగులు లేవు.',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.paused_prefix': 'పాజ్ చేయబడింది:',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.review_status_key': 'స్థితిని సమీక్షించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.started_key': 'ప్రారంభించారు',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.finished_key': 'పూర్తయింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.resume_button': 'కంపోజ్ పునఃప్రారంభించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.resuming_button': 'పునఃప్రారంభిస్తోంది...',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.resume_failed_prefix': 'రెజ్యూమ్ విఫలమైంది:',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.critical_word': 'క్లిష్టమైన',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.compose_run.high_word': 'అధిక',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.voice_notes.empty': 'ఇంకా వాయిస్ నోట్స్ లేవు.',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.voice_notes.soap_generated':
          'SOAP డ్రాఫ్ట్ రూపొందించబడింది; ప్రారంభ సమీక్ష క్యూ.',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.voice_notes.title': 'వాయిస్ నోట్స్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.voice_notes.empty_subtitle':
          'డెస్క్‌టాప్ క్లయింట్ నుండి వాయిస్ నోట్‌ను రికార్డ్ చేయండి; ఇది SOAP డ్రాఫ్టింగ్ కోసం ఇక్కడ కనిపిస్తుంది.',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.voice_notes.note_prefix': 'వాయిస్ నోట్',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.voice_notes.patient_prefix': 'రోగి:',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.voice_notes.draft_exists':
          'SOAP డ్రాఫ్ట్ ఇప్పటికే రూపొందించబడింది',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.voice_notes.generate_soap': 'SOAP డ్రాఫ్ట్‌ను రూపొందించండి',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.voice_notes.drafting': 'డ్రాఫ్టింగ్...',
      // REVIEW: AI first-pass te translation - confirm clinical/security/financial wording before production
      'clinical_ai.voice_notes.generation_failed_prefix':
          'SOAP ఉత్పత్తి విఫలమైంది:',
    },
  };
}
