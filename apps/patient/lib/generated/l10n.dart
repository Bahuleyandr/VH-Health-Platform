// GENERATED CODE - DO NOT MODIFY BY HAND
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import 'intl/messages_all.dart';

// **************************************************************************
// Generator: Flutter Intl IDE plugin
// Made by Localizely
// **************************************************************************

// ignore_for_file: non_constant_identifier_names, lines_longer_than_80_chars
// ignore_for_file: join_return_with_assignment, prefer_final_in_for_each
// ignore_for_file: avoid_redundant_argument_values, avoid_escaping_inner_quotes

class S {
  S();

  static S? _current;

  static S get current {
    assert(
      _current != null,
      'No instance of S was loaded. Try to initialize the S delegate before accessing S.current.',
    );
    return _current!;
  }

  static const AppLocalizationDelegate delegate = AppLocalizationDelegate();

  static Future<S> load(Locale locale) {
    final name = (locale.countryCode?.isEmpty ?? false)
        ? locale.languageCode
        : locale.toString();
    final localeName = Intl.canonicalizedLocale(name);
    return initializeMessages(localeName).then((_) {
      Intl.defaultLocale = localeName;
      final instance = S();
      S._current = instance;

      return instance;
    });
  }

  static S of(BuildContext context) {
    final instance = S.maybeOf(context);
    assert(
      instance != null,
      'No instance of S present in the widget tree. Did you add S.delegate in localizationsDelegates?',
    );
    return instance!;
  }

  static S? maybeOf(BuildContext context) {
    return Localizations.of<S>(context, S);
  }

  /// `English`
  String get languageName {
    return Intl.message(
      'English',
      name: 'languageName',
      desc: 'The name of the language',
      args: [],
    );
  }

  /// `Welcome to VH Health!`
  String get welcome {
    return Intl.message(
      'Welcome to VH Health!',
      name: 'welcome',
      desc: 'Welcome message',
      args: [],
    );
  }

  /// `Dashboard`
  String get dashboard {
    return Intl.message(
      'Dashboard',
      name: 'dashboard',
      desc: 'Dashboard screen title',
      args: [],
    );
  }

  /// `Last Appointment`
  String get lastAppointment {
    return Intl.message(
      'Last Appointment',
      name: 'lastAppointment',
      desc: 'Label for the last appointment',
      args: [],
    );
  }

  /// `Upcoming Appointment`
  String get upcomingAppointment {
    return Intl.message(
      'Upcoming Appointment',
      name: 'upcomingAppointment',
      desc: 'Label for the next appointment',
      args: [],
    );
  }

  /// `Your Health`
  String get yourHealth {
    return Intl.message(
      'Your Health',
      name: 'yourHealth',
      desc: 'Title for the user\'s health summary section',
      args: [],
    );
  }

  /// `Appointments`
  String get appointments {
    return Intl.message(
      'Appointments',
      name: 'appointments',
      desc: 'Title for the appointments feature',
      args: [],
    );
  }

  /// `Investigations`
  String get investigations {
    return Intl.message(
      'Investigations',
      name: 'investigations',
      desc: 'Title for the investigations feature',
      args: [],
    );
  }

  /// `Pharmacy`
  String get pharmacy {
    return Intl.message(
      'Pharmacy',
      name: 'pharmacy',
      desc: 'Title for the pharmacy feature',
      args: [],
    );
  }

  /// `Ask a Doubt`
  String get askDoubt {
    return Intl.message(
      'Ask a Doubt',
      name: 'askDoubt',
      desc: 'Label for the feature to ask a question',
      args: [],
    );
  }

  /// `Cancel`
  String get common_cancel {
    return Intl.message(
      'Cancel',
      name: 'common_cancel',
      desc: 'Generic cancel button text',
      args: [],
    );
  }

  /// `Success`
  String get common_success {
    return Intl.message(
      'Success',
      name: 'common_success',
      desc: 'Generic success message',
      args: [],
    );
  }

  /// `Failed`
  String get common_failed {
    return Intl.message(
      'Failed',
      name: 'common_failed',
      desc: 'Generic failure message',
      args: [],
    );
  }

  /// `Error`
  String get common_error {
    return Intl.message(
      'Error',
      name: 'common_error',
      desc: 'Generic error message',
      args: [],
    );
  }

  /// `Invalid`
  String get common_invalid {
    return Intl.message(
      'Invalid',
      name: 'common_invalid',
      desc: 'Generic invalid input message',
      args: [],
    );
  }

  /// `Skip`
  String get common_skipButton {
    return Intl.message(
      'Skip',
      name: 'common_skipButton',
      desc: 'Generic skip button text',
      args: [],
    );
  }

  /// `Submit`
  String get common_submitButton {
    return Intl.message(
      'Submit',
      name: 'common_submitButton',
      desc: 'Generic submit button text',
      args: [],
    );
  }

  /// `Back`
  String get common_back {
    return Intl.message(
      'Back',
      name: 'common_back',
      desc: 'Generic back button text',
      args: [],
    );
  }

  /// `Confirm`
  String get common_confirm {
    return Intl.message(
      'Confirm',
      name: 'common_confirm',
      desc: 'Generic confirm button text',
      args: [],
    );
  }

  /// `Send`
  String get common_send {
    return Intl.message(
      'Send',
      name: 'common_send',
      desc: 'Generic send button text',
      args: [],
    );
  }

  /// `Conditions`
  String get common_conditions {
    return Intl.message(
      'Conditions',
      name: 'common_conditions',
      desc: 'Link text for \'Conditions\'',
      args: [],
    );
  }

  /// `and`
  String get common_and {
    return Intl.message(
      'and',
      name: 'common_and',
      desc: 'The word \'and\'',
      args: [],
    );
  }

  /// `Privacy Policy`
  String get common_privacyPolicy {
    return Intl.message(
      'Privacy Policy',
      name: 'common_privacyPolicy',
      desc: 'Link text for \'Privacy Policy\'',
      args: [],
    );
  }

  /// `Network error. Please check your connection.`
  String get common_networkError {
    return Intl.message(
      'Network error. Please check your connection.',
      name: 'common_networkError',
      desc: 'Network error message',
      args: [],
    );
  }

  /// `Terms, Conditions & Disclaimer`
  String get common_termsConditionsDisclaimerTitle {
    return Intl.message(
      'Terms, Conditions & Disclaimer',
      name: 'common_termsConditionsDisclaimerTitle',
      desc: 'Title for the Terms, Conditions & Disclaimer page',
      args: [],
    );
  }

  /// `Terms of Use`
  String get common_termsOfUse {
    return Intl.message(
      'Terms of Use',
      name: 'common_termsOfUse',
      desc: 'Link text for \'Terms of Use\'',
      args: [],
    );
  }

  /// `Back to Login`
  String get common_backToLogin {
    return Intl.message(
      'Back to Login',
      name: 'common_backToLogin',
      desc: 'Button to go back to the login screen',
      args: [],
    );
  }

  /// `Permissions are required to proceed.`
  String get common_permissions_required {
    return Intl.message(
      'Permissions are required to proceed.',
      name: 'common_permissions_required',
      desc: 'Message shown when permissions are needed',
      args: [],
    );
  }

  /// `Health Trivia`
  String get trivia_title {
    return Intl.message(
      'Health Trivia',
      name: 'trivia_title',
      desc: 'Title for the trivia section',
      args: [],
    );
  }

  /// `Did You Know?`
  String get trivia_didYouKnow {
    return Intl.message(
      'Did You Know?',
      name: 'trivia_didYouKnow',
      desc: 'Header for a trivia fact',
      args: [],
    );
  }

  /// `New Trivia`
  String get trivia_newTrivia {
    return Intl.message(
      'New Trivia',
      name: 'trivia_newTrivia',
      desc: 'Label for new trivia',
      args: [],
    );
  }

  /// `New Trivia`
  String get trivia_newTriviaButton {
    return Intl.message(
      'New Trivia',
      name: 'trivia_newTriviaButton',
      desc: 'Button to fetch new trivia',
      args: [],
    );
  }

  /// `Drinking water first thing in the morning helps jumpstart your metabolism.`
  String get trivia_fact1 {
    return Intl.message(
      'Drinking water first thing in the morning helps jumpstart your metabolism.',
      name: 'trivia_fact1',
      desc: 'Health fact 1',
      args: [],
    );
  }

  /// `Walking 30 minutes a day reduces the risk of heart disease.`
  String get trivia_fact2 {
    return Intl.message(
      'Walking 30 minutes a day reduces the risk of heart disease.',
      name: 'trivia_fact2',
      desc: 'Health fact 2',
      args: [],
    );
  }

  /// `Laughter boosts the immune system.`
  String get trivia_fact3 {
    return Intl.message(
      'Laughter boosts the immune system.',
      name: 'trivia_fact3',
      desc: 'Health fact 3',
      args: [],
    );
  }

  /// `Handwashing is one of the best ways to prevent illness.`
  String get trivia_fact4 {
    return Intl.message(
      'Handwashing is one of the best ways to prevent illness.',
      name: 'trivia_fact4',
      desc: 'Health fact 4',
      args: [],
    );
  }

  /// `Sleep is as important to health as diet and exercise.`
  String get trivia_fact5 {
    return Intl.message(
      'Sleep is as important to health as diet and exercise.',
      name: 'trivia_fact5',
      desc: 'Health fact 5',
      args: [],
    );
  }

  /// `Dark chocolate is rich in antioxidants and heart-healthy.`
  String get trivia_fact6 {
    return Intl.message(
      'Dark chocolate is rich in antioxidants and heart-healthy.',
      name: 'trivia_fact6',
      desc: 'Health fact 6',
      args: [],
    );
  }

  /// `Your brain uses more energy than any other organ.`
  String get trivia_fact7 {
    return Intl.message(
      'Your brain uses more energy than any other organ.',
      name: 'trivia_fact7',
      desc: 'Health fact 7',
      args: [],
    );
  }

  /// `Eating fiber-rich foods helps digestion and heart health.`
  String get trivia_fact8 {
    return Intl.message(
      'Eating fiber-rich foods helps digestion and heart health.',
      name: 'trivia_fact8',
      desc: 'Health fact 8',
      args: [],
    );
  }

  /// `Good posture improves breathing and energy levels.`
  String get trivia_fact9 {
    return Intl.message(
      'Good posture improves breathing and energy levels.',
      name: 'trivia_fact9',
      desc: 'Health fact 9',
      args: [],
    );
  }

  /// `Sunlight helps your body produce Vitamin D naturally.`
  String get trivia_fact10 {
    return Intl.message(
      'Sunlight helps your body produce Vitamin D naturally.',
      name: 'trivia_fact10',
      desc: 'Health fact 10',
      args: [],
    );
  }

  /// `Departments`
  String get departments {
    return Intl.message(
      'Departments',
      name: 'departments',
      desc: 'Title for hospital departments',
      args: [],
    );
  }

  /// `Venkataeswara Hospitals`
  String get aboutUs_title {
    return Intl.message(
      'Venkataeswara Hospitals',
      name: 'aboutUs_title',
      desc: 'Title for the \'About Us\' section',
      args: [],
    );
  }

  /// `Founded in 2003 by the renowned interventional cardiologist Dr. Thillai Vallal, Venkataeswara Hospitals is a trusted multi-specialty healthcare institution located in the heart of Chennai at Nandanam.`
  String get aboutUs_para1 {
    return Intl.message(
      'Founded in 2003 by the renowned interventional cardiologist Dr. Thillai Vallal, Venkataeswara Hospitals is a trusted multi-specialty healthcare institution located in the heart of Chennai at Nandanam.',
      name: 'aboutUs_para1',
      desc: 'First paragraph for \'About Us\'',
      args: [],
    );
  }

  /// `Our 130-bed facility, including advanced ICU care, is equipped with state-of-the-art diagnostic and surgical infrastructure such as MRI, CT, digital X-ray, and fully integrated labs.`
  String get aboutUs_para2 {
    return Intl.message(
      'Our 130-bed facility, including advanced ICU care, is equipped with state-of-the-art diagnostic and surgical infrastructure such as MRI, CT, digital X-ray, and fully integrated labs.',
      name: 'aboutUs_para2',
      desc: 'Second paragraph for \'About Us\'',
      args: [],
    );
  }

  /// `Our team of highly experienced doctors, nurses, and staff work in harmony to provide personalized treatment plans across various specialties.`
  String get aboutUs_para3 {
    return Intl.message(
      'Our team of highly experienced doctors, nurses, and staff work in harmony to provide personalized treatment plans across various specialties.',
      name: 'aboutUs_para3',
      desc: 'Third paragraph for \'About Us\'',
      args: [],
    );
  }

  /// `We are particularly proud of our leadership in lifestyle disease management and preventive cardiology.`
  String get aboutUs_para4 {
    return Intl.message(
      'We are particularly proud of our leadership in lifestyle disease management and preventive cardiology.',
      name: 'aboutUs_para4',
      desc: 'Fourth paragraph for \'About Us\'',
      args: [],
    );
  }

  /// `Calendar`
  String get calendar {
    return Intl.message(
      'Calendar',
      name: 'calendar',
      desc: 'Label for the calendar',
      args: [],
    );
  }

  /// `Hello`
  String get hello {
    return Intl.message(
      'Hello',
      name: 'hello',
      desc: 'A common greeting',
      args: [],
    );
  }

  /// `Settings`
  String get settings_title {
    return Intl.message(
      'Settings',
      name: 'settings_title',
      desc: 'Title for the settings screen',
      args: [],
    );
  }

  /// `Edit Profile`
  String get settings_editProfile {
    return Intl.message(
      'Edit Profile',
      name: 'settings_editProfile',
      desc: 'Option in settings to edit profile',
      args: [],
    );
  }

  /// `Language`
  String get settings_language {
    return Intl.message(
      'Language',
      name: 'settings_language',
      desc: 'Option in settings to change language',
      args: [],
    );
  }

  /// `Accessibility`
  String get settings_accessibility {
    return Intl.message(
      'Accessibility',
      name: 'settings_accessibility',
      desc: 'Option in settings for accessibility features',
      args: [],
    );
  }

  /// `Font Size`
  String get settings_fontSize {
    return Intl.message(
      'Font Size',
      name: 'settings_fontSize',
      desc: 'Option in settings to change font size',
      args: [],
    );
  }

  /// `Font size set to`
  String get settings_fontSizeChanged {
    return Intl.message(
      'Font size set to',
      name: 'settings_fontSizeChanged',
      desc: 'Confirmation message after changing font size',
      args: [],
    );
  }

  /// `Theme`
  String get settings_theme {
    return Intl.message(
      'Theme',
      name: 'settings_theme',
      desc: 'Option in settings to change theme',
      args: [],
    );
  }

  /// `Dark`
  String get settings_darkTheme {
    return Intl.message(
      'Dark',
      name: 'settings_darkTheme',
      desc: 'The \'Dark\' theme option',
      args: [],
    );
  }

  /// `Light`
  String get settings_lightTheme {
    return Intl.message(
      'Light',
      name: 'settings_lightTheme',
      desc: 'The \'Light\' theme option',
      args: [],
    );
  }

  /// `Switch to Dark Mode`
  String get settings_switchToDark {
    return Intl.message(
      'Switch to Dark Mode',
      name: 'settings_switchToDark',
      desc: 'Button to switch to dark mode',
      args: [],
    );
  }

  /// `Switch to Light Mode`
  String get settings_switchToLight {
    return Intl.message(
      'Switch to Light Mode',
      name: 'settings_switchToLight',
      desc: 'Button to switch to light mode',
      args: [],
    );
  }

  /// `Biometric Login`
  String get settings_biometricLogin {
    return Intl.message(
      'Biometric Login',
      name: 'settings_biometricLogin',
      desc: 'Label for biometric login setting',
      args: [],
    );
  }

  /// `Biometric authentication is not supported on this device.`
  String get settings_biometricNotSupported {
    return Intl.message(
      'Biometric authentication is not supported on this device.',
      name: 'settings_biometricNotSupported',
      desc: 'Message when biometrics are not supported',
      args: [],
    );
  }

  /// `Enable biometric login`
  String get settings_enableBiometricLogin {
    return Intl.message(
      'Enable biometric login',
      name: 'settings_enableBiometricLogin',
      desc: 'Label to enable biometric login',
      args: [],
    );
  }

  /// `Disable biometric login`
  String get settings_disableBiometricLogin {
    return Intl.message(
      'Disable biometric login',
      name: 'settings_disableBiometricLogin',
      desc: 'Label to disable biometric login',
      args: [],
    );
  }

  /// `Logout`
  String get settings_logout {
    return Intl.message(
      'Logout',
      name: 'settings_logout',
      desc: 'Logout button text',
      args: [],
    );
  }

  /// `Confirm Logout`
  String get settings_logoutConfirmation {
    return Intl.message(
      'Confirm Logout',
      name: 'settings_logoutConfirmation',
      desc: 'Title for logout confirmation dialog',
      args: [],
    );
  }

  /// `Are you sure you want to log out?`
  String get settings_areYouSureLogout {
    return Intl.message(
      'Are you sure you want to log out?',
      name: 'settings_areYouSureLogout',
      desc: 'Confirmation question for logging out',
      args: [],
    );
  }

  /// `Logout`
  String get settings_confirmLogout {
    return Intl.message(
      'Logout',
      name: 'settings_confirmLogout',
      desc: 'Confirmation button text for logout',
      args: [],
    );
  }

  /// `Security`
  String get settings_security {
    return Intl.message(
      'Security',
      name: 'settings_security',
      desc: 'Label for security settings section',
      args: [],
    );
  }

  /// `Please login to view your health records.`
  String get auth_loginToView {
    return Intl.message(
      'Please login to view your health records.',
      name: 'auth_loginToView',
      desc: 'Message prompting user to login',
      args: [],
    );
  }

  /// `Please authenticate to access VH Health`
  String get auth_pleaseAuthenticate {
    return Intl.message(
      'Please authenticate to access VH Health',
      name: 'auth_pleaseAuthenticate',
      desc: 'Prompt to authenticate',
      args: [],
    );
  }

  /// `Enter Your Phone Number`
  String get auth_enterYourPhone {
    return Intl.message(
      'Enter Your Phone Number',
      name: 'auth_enterYourPhone',
      desc: 'Instruction to enter phone number',
      args: [],
    );
  }

  /// `Phone Number`
  String get auth_phoneNumber {
    return Intl.message(
      'Phone Number',
      name: 'auth_phoneNumber',
      desc: 'Label for phone number field',
      args: [],
    );
  }

  /// `Phone Number`
  String get auth_phoneNumber_label {
    return Intl.message(
      'Phone Number',
      name: 'auth_phoneNumber_label',
      desc: 'Label for phone number input',
      args: [],
    );
  }

  /// `Enter your phone number`
  String get auth_phoneNumber_hint {
    return Intl.message(
      'Enter your phone number',
      name: 'auth_phoneNumber_hint',
      desc: 'Hint text for phone number input',
      args: [],
    );
  }

  /// `Please enter a valid 10-digit phone number.`
  String get auth_enterValidPhone {
    return Intl.message(
      'Please enter a valid 10-digit phone number.',
      name: 'auth_enterValidPhone',
      desc: 'Validation error for phone number',
      args: [],
    );
  }

  /// `By logging in, you agree to our Terms, Conditions, and Privacy Policy.`
  String get auth_loginAgreement {
    return Intl.message(
      'By logging in, you agree to our Terms, Conditions, and Privacy Policy.',
      name: 'auth_loginAgreement',
      desc: 'Login agreement text',
      args: [],
    );
  }

  /// `Welcome to VH Health`
  String get auth_loginTitle {
    return Intl.message(
      'Welcome to VH Health',
      name: 'auth_loginTitle',
      desc: 'Title on the login screen',
      args: [],
    );
  }

  /// `Get OTP`
  String get auth_getOtp {
    return Intl.message(
      'Get OTP',
      name: 'auth_getOtp',
      desc: 'Button to request an OTP',
      args: [],
    );
  }

  /// `By continuing, you agree to our`
  String get auth_byContinuingYouAgree {
    return Intl.message(
      'By continuing, you agree to our',
      name: 'auth_byContinuingYouAgree',
      desc: 'Agreement text part 1',
      args: [],
    );
  }

  /// `Biometric authentication is not available on this device.`
  String get auth_biometricNotAvailable {
    return Intl.message(
      'Biometric authentication is not available on this device.',
      name: 'auth_biometricNotAvailable',
      desc: 'Error when biometrics are unavailable',
      args: [],
    );
  }

  /// `Biometric authentication failed.`
  String get auth_biometricError {
    return Intl.message(
      'Biometric authentication failed.',
      name: 'auth_biometricError',
      desc: 'Error when biometric auth fails',
      args: [],
    );
  }

  /// `Logout failed.`
  String get auth_logoutFailed {
    return Intl.message(
      'Logout failed.',
      name: 'auth_logoutFailed',
      desc: 'Error when logout fails',
      args: [],
    );
  }

  /// `Enter OTP`
  String get otp_verifyOtpTitle {
    return Intl.message(
      'Enter OTP',
      name: 'otp_verifyOtpTitle',
      desc: 'Title for the OTP entry screen',
      args: [],
    );
  }

  /// `OTP sent to`
  String get otp_otpSentTo {
    return Intl.message(
      'OTP sent to',
      name: 'otp_otpSentTo',
      desc: 'Message indicating where OTP was sent',
      args: [],
    );
  }

  /// `Enter 6-digit OTP`
  String get otp_enterOtp {
    return Intl.message(
      'Enter 6-digit OTP',
      name: 'otp_enterOtp',
      desc: 'Hint text for OTP input',
      args: [],
    );
  }

  /// `Verify`
  String get otp_verify {
    return Intl.message(
      'Verify',
      name: 'otp_verify',
      desc: 'Button to verify OTP',
      args: [],
    );
  }

  /// `OTP verification failed, please try again`
  String get otp_otpFailed {
    return Intl.message(
      'OTP verification failed, please try again',
      name: 'otp_otpFailed',
      desc: 'Error for failed OTP verification',
      args: [],
    );
  }

  /// `Login failed`
  String get otp_loginFailed {
    return Intl.message(
      'Login failed',
      name: 'otp_loginFailed',
      desc: 'Error for failed login',
      args: [],
    );
  }

  /// `Continue as Guest`
  String get otp_continueAsGuest {
    return Intl.message(
      'Continue as Guest',
      name: 'otp_continueAsGuest',
      desc: 'Button to continue as a guest',
      args: [],
    );
  }

  /// `By logging in, you agree to our`
  String get otp_byLoggingIn {
    return Intl.message(
      'By logging in, you agree to our',
      name: 'otp_byLoggingIn',
      desc: 'Agreement text on login',
      args: [],
    );
  }

  /// `Please enter phone number`
  String get otp_pleaseEnterPhone {
    return Intl.message(
      'Please enter phone number',
      name: 'otp_pleaseEnterPhone',
      desc: 'Error if phone number is missing',
      args: [],
    );
  }

  /// `Sending OTP...`
  String get otp_sendingOtp {
    return Intl.message(
      'Sending OTP...',
      name: 'otp_sendingOtp',
      desc: 'Status message while sending OTP',
      args: [],
    );
  }

  /// `Automatic sign-in successful!`
  String get otp_autoSignInSuccess {
    return Intl.message(
      'Automatic sign-in successful!',
      name: 'otp_autoSignInSuccess',
      desc: 'Success message for auto sign-in',
      args: [],
    );
  }

  /// `Login Successful!`
  String get otp_loginSuccessful {
    return Intl.message(
      'Login Successful!',
      name: 'otp_loginSuccessful',
      desc: 'Success message for login',
      args: [],
    );
  }

  /// `Invalid OTP. Please check and try again.`
  String get otp_invalidOtp {
    return Intl.message(
      'Invalid OTP. Please check and try again.',
      name: 'otp_invalidOtp',
      desc: 'Error for invalid OTP',
      args: [],
    );
  }

  /// `OTP session has expired. Please request a new OTP.`
  String get otp_otpSessionExpired {
    return Intl.message(
      'OTP session has expired. Please request a new OTP.',
      name: 'otp_otpSessionExpired',
      desc: 'Error for expired OTP session',
      args: [],
    );
  }

  /// `An error occurred`
  String get otp_errorOccurred {
    return Intl.message(
      'An error occurred',
      name: 'otp_errorOccurred',
      desc: 'Generic error message',
      args: [],
    );
  }

  /// `Failed to resend OTP. Please try again.`
  String get otp_otpResendFailed {
    return Intl.message(
      'Failed to resend OTP. Please try again.',
      name: 'otp_otpResendFailed',
      desc: 'Error when resending OTP fails',
      args: [],
    );
  }

  /// `OTP has been resent successfully.`
  String get otp_otpResentSuccessfully {
    return Intl.message(
      'OTP has been resent successfully.',
      name: 'otp_otpResentSuccessfully',
      desc: 'Success message for resending OTP',
      args: [],
    );
  }

  /// `Please enter the OTP.`
  String get otp_pleaseEnterOtp {
    return Intl.message(
      'Please enter the OTP.',
      name: 'otp_pleaseEnterOtp',
      desc: 'Error if OTP is not entered',
      args: [],
    );
  }

  /// `OTP must be 6 digits.`
  String get otp_otpMustBe6Digits {
    return Intl.message(
      'OTP must be 6 digits.',
      name: 'otp_otpMustBe6Digits',
      desc: 'Validation error for OTP length',
      args: [],
    );
  }

  /// `Resend OTP in`
  String get otp_resendOtpIn {
    return Intl.message(
      'Resend OTP in',
      name: 'otp_resendOtpIn',
      desc: 'Label for OTP resend timer',
      args: [],
    );
  }

  /// `Resend OTP`
  String get otp_resendOtp {
    return Intl.message(
      'Resend OTP',
      name: 'otp_resendOtp',
      desc: 'Button to resend OTP',
      args: [],
    );
  }

  /// `Profile`
  String get profile_title {
    return Intl.message(
      'Profile',
      name: 'profile_title',
      desc: 'Title for the profile screen',
      args: [],
    );
  }

  /// `Edit Profile`
  String get profile_editScreen_title {
    return Intl.message(
      'Edit Profile',
      name: 'profile_editScreen_title',
      desc: 'Title for the profile editing screen',
      args: [],
    );
  }

  /// `Profile updated successfully.`
  String get profile_updatedSuccessfully {
    return Intl.message(
      'Profile updated successfully.',
      name: 'profile_updatedSuccessfully',
      desc: 'Success message after updating profile',
      args: [],
    );
  }

  /// `Failed to update profile. Please try again.`
  String get profile_updateFailed {
    return Intl.message(
      'Failed to update profile. Please try again.',
      name: 'profile_updateFailed',
      desc: 'Error message when profile update fails',
      args: [],
    );
  }

  /// `Complete Your Profile`
  String get profile_setup_title {
    return Intl.message(
      'Complete Your Profile',
      name: 'profile_setup_title',
      desc: 'Title for the initial profile setup screen',
      args: [],
    );
  }

  /// `Profile saved successfully!`
  String get profile_setup_saved {
    return Intl.message(
      'Profile saved successfully!',
      name: 'profile_setup_saved',
      desc: 'Success message after saving profile setup',
      args: [],
    );
  }

  /// `Failed to save profile. Please try again.`
  String get profile_setup_saveFailed {
    return Intl.message(
      'Failed to save profile. Please try again.',
      name: 'profile_setup_saveFailed',
      desc: 'Error message when profile setup fails',
      args: [],
    );
  }

  /// `Add Photo`
  String get profile_setup_addPhoto {
    return Intl.message(
      'Add Photo',
      name: 'profile_setup_addPhoto',
      desc: 'Button to add a profile photo',
      args: [],
    );
  }

  /// `Full Name`
  String get profile_name_label {
    return Intl.message(
      'Full Name',
      name: 'profile_name_label',
      desc: 'Label for the full name field',
      args: [],
    );
  }

  /// `Enter your full name`
  String get profile_name_hint {
    return Intl.message(
      'Enter your full name',
      name: 'profile_name_hint',
      desc: 'Hint text for the full name field',
      args: [],
    );
  }

  /// `Name is required.`
  String get profile_name_validation_required {
    return Intl.message(
      'Name is required.',
      name: 'profile_name_validation_required',
      desc: 'Validation error for required name',
      args: [],
    );
  }

  /// `Gender`
  String get profile_gender_label {
    return Intl.message(
      'Gender',
      name: 'profile_gender_label',
      desc: 'Label for the gender field',
      args: [],
    );
  }

  /// `Male`
  String get profile_gender_male {
    return Intl.message(
      'Male',
      name: 'profile_gender_male',
      desc: 'Gender option: Male',
      args: [],
    );
  }

  /// `Female`
  String get profile_gender_female {
    return Intl.message(
      'Female',
      name: 'profile_gender_female',
      desc: 'Gender option: Female',
      args: [],
    );
  }

  /// `Other`
  String get profile_gender_other {
    return Intl.message(
      'Other',
      name: 'profile_gender_other',
      desc: 'Gender option: Other',
      args: [],
    );
  }

  /// `Gender is required.`
  String get profile_gender_validation_required {
    return Intl.message(
      'Gender is required.',
      name: 'profile_gender_validation_required',
      desc: 'Validation error for required gender',
      args: [],
    );
  }

  /// `Email Address`
  String get profile_email_label {
    return Intl.message(
      'Email Address',
      name: 'profile_email_label',
      desc: 'Label for the email field',
      args: [],
    );
  }

  /// `Enter your email address`
  String get profile_email_hint {
    return Intl.message(
      'Enter your email address',
      name: 'profile_email_hint',
      desc: 'Hint text for the email field',
      args: [],
    );
  }

  /// `Enter your email (optional)`
  String get profile_email_hintOptional {
    return Intl.message(
      'Enter your email (optional)',
      name: 'profile_email_hintOptional',
      desc: 'Hint text for optional email field',
      args: [],
    );
  }

  /// `Enter a valid email address.`
  String get profile_email_validation_invalid {
    return Intl.message(
      'Enter a valid email address.',
      name: 'profile_email_validation_invalid',
      desc: 'Validation error for invalid email',
      args: [],
    );
  }

  /// `Date of Birth`
  String get profile_birthday_label {
    return Intl.message(
      'Date of Birth',
      name: 'profile_birthday_label',
      desc: 'Label for the date of birth field',
      args: [],
    );
  }

  /// `Select your date of birth`
  String get profile_birthday_hint {
    return Intl.message(
      'Select your date of birth',
      name: 'profile_birthday_hint',
      desc: 'Hint text for date of birth selection',
      args: [],
    );
  }

  /// `Select Date of Birth`
  String get profile_birthday_selectLabel {
    return Intl.message(
      'Select Date of Birth',
      name: 'profile_birthday_selectLabel',
      desc: 'Label for date of birth selector',
      args: [],
    );
  }

  /// `Birthday`
  String get profile_birthday_labelShort {
    return Intl.message(
      'Birthday',
      name: 'profile_birthday_labelShort',
      desc: 'Short label for birthday',
      args: [],
    );
  }

  /// `Select Anniversary (Optional)`
  String get profile_anniversary_selectLabel {
    return Intl.message(
      'Select Anniversary (Optional)',
      name: 'profile_anniversary_selectLabel',
      desc: 'Label for anniversary selector',
      args: [],
    );
  }

  /// `Anniversary`
  String get profile_anniversary_labelShort {
    return Intl.message(
      'Anniversary',
      name: 'profile_anniversary_labelShort',
      desc: 'Short label for anniversary',
      args: [],
    );
  }

  /// `Save Changes`
  String get profile_saveChangesButton {
    return Intl.message(
      'Save Changes',
      name: 'profile_saveChangesButton',
      desc: 'Button to save profile changes',
      args: [],
    );
  }

  /// `Hello! Tell us about yourself:`
  String get profile_header {
    return Intl.message(
      'Hello! Tell us about yourself:',
      name: 'profile_header',
      desc: 'Header text on profile setup screen',
      args: [],
    );
  }

  /// `Your Name *`
  String get profile_namePlaceholder {
    return Intl.message(
      'Your Name *',
      name: 'profile_namePlaceholder',
      desc: 'Placeholder for name input',
      args: [],
    );
  }

  /// `Gender (Male/Female/Other) *`
  String get profile_genderPlaceholder {
    return Intl.message(
      'Gender (Male/Female/Other) *',
      name: 'profile_genderPlaceholder',
      desc: 'Placeholder for gender input',
      args: [],
    );
  }

  /// `Address`
  String get profile_addressPlaceholder {
    return Intl.message(
      'Address',
      name: 'profile_addressPlaceholder',
      desc: 'Placeholder for address input',
      args: [],
    );
  }

  /// `Email ID (optional)`
  String get profile_emailPlaceholder {
    return Intl.message(
      'Email ID (optional)',
      name: 'profile_emailPlaceholder',
      desc: 'Placeholder for email input',
      args: [],
    );
  }

  /// `Birthday (DD-MM-YYYY)`
  String get profile_birthdayPlaceholder {
    return Intl.message(
      'Birthday (DD-MM-YYYY)',
      name: 'profile_birthdayPlaceholder',
      desc: 'Placeholder for birthday input',
      args: [],
    );
  }

  /// `Anniversary (DD-MM-YYYY)`
  String get profile_anniversaryPlaceholder {
    return Intl.message(
      'Anniversary (DD-MM-YYYY)',
      name: 'profile_anniversaryPlaceholder',
      desc: 'Placeholder for anniversary input',
      args: [],
    );
  }

  /// `Height (cm)`
  String get profile_heightPlaceholder {
    return Intl.message(
      'Height (cm)',
      name: 'profile_heightPlaceholder',
      desc: 'Placeholder for height input',
      args: [],
    );
  }

  /// `Weight (kg)`
  String get profile_weightPlaceholder {
    return Intl.message(
      'Weight (kg)',
      name: 'profile_weightPlaceholder',
      desc: 'Placeholder for weight input',
      args: [],
    );
  }

  /// `Submit Profile`
  String get profile_submitProfile {
    return Intl.message(
      'Submit Profile',
      name: 'profile_submitProfile',
      desc: 'Button to submit profile',
      args: [],
    );
  }

  /// `Saving profile...`
  String get profile_savingProfile {
    return Intl.message(
      'Saving profile...',
      name: 'profile_savingProfile',
      desc: 'Status message while saving profile',
      args: [],
    );
  }

  /// `Name and gender are required.`
  String get profile_nameGenderRequired {
    return Intl.message(
      'Name and gender are required.',
      name: 'profile_nameGenderRequired',
      desc: 'Validation error for required name and gender',
      args: [],
    );
  }

  /// `Failed to save profile.`
  String get profile_saveFailed {
    return Intl.message(
      'Failed to save profile.',
      name: 'profile_saveFailed',
      desc: 'Error message when profile save fails',
      args: [],
    );
  }

  /// `Edit Profile`
  String get profile_editProfile {
    return Intl.message(
      'Edit Profile',
      name: 'profile_editProfile',
      desc: 'Button/link to edit profile',
      args: [],
    );
  }

  /// `Upload Profile Picture 📷`
  String get profile_uploadProfilePic {
    return Intl.message(
      'Upload Profile Picture 📷',
      name: 'profile_uploadProfilePic',
      desc: 'Button to upload profile picture',
      args: [],
    );
  }

  /// `Save Profile`
  String get profile_saveProfile {
    return Intl.message(
      'Save Profile',
      name: 'profile_saveProfile',
      desc: 'Button to save profile',
      args: [],
    );
  }

  /// `Profile saved successfully!`
  String get profile_saved {
    return Intl.message(
      'Profile saved successfully!',
      name: 'profile_saved',
      desc: 'Success message for saving profile',
      args: [],
    );
  }

  /// `No records found.`
  String get records_noRecords {
    return Intl.message(
      'No records found.',
      name: 'records_noRecords',
      desc: 'Message when no records are found',
      args: [],
    );
  }

  /// `Please login to view your health records.`
  String get records_loginToView {
    return Intl.message(
      'Please login to view your health records.',
      name: 'records_loginToView',
      desc: 'Prompt to log in to see records',
      args: [],
    );
  }

  /// `Newest First 🔽`
  String get records_sortNewest {
    return Intl.message(
      'Newest First 🔽',
      name: 'records_sortNewest',
      desc: 'Sort option: Newest first',
      args: [],
    );
  }

  /// `Oldest First 🔼`
  String get records_sortOldest {
    return Intl.message(
      'Oldest First 🔼',
      name: 'records_sortOldest',
      desc: 'Sort option: Oldest first',
      args: [],
    );
  }

  /// `All Types`
  String get records_filters_allTypes {
    return Intl.message(
      'All Types',
      name: 'records_filters_allTypes',
      desc: 'Filter option: All types',
      args: [],
    );
  }

  /// `Consultation`
  String get records_filters_consultation {
    return Intl.message(
      'Consultation',
      name: 'records_filters_consultation',
      desc: 'Filter option: Consultation',
      args: [],
    );
  }

  /// `Investigation`
  String get records_filters_investigation {
    return Intl.message(
      'Investigation',
      name: 'records_filters_investigation',
      desc: 'Filter option: Investigation',
      args: [],
    );
  }

  /// `Report`
  String get records_filters_report {
    return Intl.message(
      'Report',
      name: 'records_filters_report',
      desc: 'Filter option: Report',
      args: [],
    );
  }

  /// `Record`
  String get records_filters_record {
    return Intl.message(
      'Record',
      name: 'records_filters_record',
      desc: 'Filter option: Record',
      args: [],
    );
  }

  /// `Uploaded`
  String get records_filters_uploaded {
    return Intl.message(
      'Uploaded',
      name: 'records_filters_uploaded',
      desc: 'Filter option: Uploaded',
      args: [],
    );
  }

  /// `Could not open file`
  String get records_filters_couldNotOpenFile {
    return Intl.message(
      'Could not open file',
      name: 'records_filters_couldNotOpenFile',
      desc: 'Error when a file cannot be opened',
      args: [],
    );
  }

  /// `Appointments`
  String get appointmentsSection_title {
    return Intl.message(
      'Appointments',
      name: 'appointmentsSection_title',
      desc: 'Title for the appointments section',
      args: [],
    );
  }

  /// `Request an Appointment`
  String get appointmentsSection_request {
    return Intl.message(
      'Request an Appointment',
      name: 'appointmentsSection_request',
      desc: 'Button to request an appointment',
      args: [],
    );
  }

  /// `Choose Department or Doctor`
  String get appointmentsSection_chooseDepartmentOrDoctor {
    return Intl.message(
      'Choose Department or Doctor',
      name: 'appointmentsSection_chooseDepartmentOrDoctor',
      desc: 'Instructional text for booking',
      args: [],
    );
  }

  /// `Select Department or Doctor`
  String get appointmentsSection_selectDoctorPlaceholder {
    return Intl.message(
      'Select Department or Doctor',
      name: 'appointmentsSection_selectDoctorPlaceholder',
      desc: 'Placeholder for doctor/department selection',
      args: [],
    );
  }

  /// `Preferred Date:`
  String get appointmentsSection_preferredDate {
    return Intl.message(
      'Preferred Date:',
      name: 'appointmentsSection_preferredDate',
      desc: 'Label for preferred date selection',
      args: [],
    );
  }

  /// `Submit Request`
  String get appointmentsSection_submitRequest {
    return Intl.message(
      'Submit Request',
      name: 'appointmentsSection_submitRequest',
      desc: 'Button to submit an appointment request',
      args: [],
    );
  }

  /// `Appointment requested successfully!`
  String get appointmentsSection_success {
    return Intl.message(
      'Appointment requested successfully!',
      name: 'appointmentsSection_success',
      desc: 'Success message for appointment request',
      args: [],
    );
  }

  /// `Our staff will call you to confirm your appointment time.`
  String get appointmentsSection_confirmationNote {
    return Intl.message(
      'Our staff will call you to confirm your appointment time.',
      name: 'appointmentsSection_confirmationNote',
      desc: 'Note about appointment confirmation process',
      args: [],
    );
  }

  /// `Failed to submit appointment. Please try again.`
  String get appointmentsSection_failed {
    return Intl.message(
      'Failed to submit appointment. Please try again.',
      name: 'appointmentsSection_failed',
      desc: 'Error message for failed appointment request',
      args: [],
    );
  }

  /// `Please select both doctor and preferred date.`
  String get appointmentsSection_selectDoctorAndDate {
    return Intl.message(
      'Please select both doctor and preferred date.',
      name: 'appointmentsSection_selectDoctorAndDate',
      desc: 'Validation error for appointment request',
      args: [],
    );
  }

  /// `Next Appointment`
  String get appointmentsSection_next {
    return Intl.message(
      'Next Appointment',
      name: 'appointmentsSection_next',
      desc: 'Label for the next scheduled appointment',
      args: [],
    );
  }

  /// `Pharmacy`
  String get pharmacySection_title {
    return Intl.message(
      'Pharmacy',
      name: 'pharmacySection_title',
      desc: 'Title for the pharmacy section',
      args: [],
    );
  }

  /// `Upload Prescription`
  String get pharmacySection_uploadPrescription {
    return Intl.message(
      'Upload Prescription',
      name: 'pharmacySection_uploadPrescription',
      desc: 'Button to upload a prescription',
      args: [],
    );
  }

  /// `Upload PDF / Image`
  String get pharmacySection_uploadPDF {
    return Intl.message(
      'Upload PDF / Image',
      name: 'pharmacySection_uploadPDF',
      desc: 'Instruction on what file to upload',
      args: [],
    );
  }

  /// `How to get your medicines:\n1. Upload your prescription or take a picture\n2. Confirm or Edit your delivery address\n3. We'll take care of the rest, our team will contact you!`
  String get pharmacySection_uploadInstructions {
    return Intl.message(
      'How to get your medicines:\n1. Upload your prescription or take a picture\n2. Confirm or Edit your delivery address\n3. We\'ll take care of the rest, our team will contact you!',
      name: 'pharmacySection_uploadInstructions',
      desc: 'Instructions for ordering medicine',
      args: [],
    );
  }

  /// `Enter Delivery Address`
  String get pharmacySection_enterDeliveryAddress {
    return Intl.message(
      'Enter Delivery Address',
      name: 'pharmacySection_enterDeliveryAddress',
      desc: 'Label for delivery address input',
      args: [],
    );
  }

  /// `Order Medicine`
  String get pharmacySection_submitOrder {
    return Intl.message(
      'Order Medicine',
      name: 'pharmacySection_submitOrder',
      desc: 'Button to submit a medicine order',
      args: [],
    );
  }

  /// `Call Pharmacy`
  String get pharmacySection_call {
    return Intl.message(
      'Call Pharmacy',
      name: 'pharmacySection_call',
      desc: 'Button to call the pharmacy',
      args: [],
    );
  }

  /// `Please upload a prescription and enter delivery address.`
  String get pharmacySection_prescriptionAndAddressRequired {
    return Intl.message(
      'Please upload a prescription and enter delivery address.',
      name: 'pharmacySection_prescriptionAndAddressRequired',
      desc: 'Validation error for medicine order',
      args: [],
    );
  }

  /// `We will call you to confirm your order and delivery address.`
  String get pharmacySection_confirmationNote {
    return Intl.message(
      'We will call you to confirm your order and delivery address.',
      name: 'pharmacySection_confirmationNote',
      desc: 'Note about order confirmation process',
      args: [],
    );
  }

  /// `File`
  String get files_file {
    return Intl.message(
      'File',
      name: 'files_file',
      desc: 'Generic term for a file',
      args: [],
    );
  }

  /// `No valid files selected. Try again.`
  String get files_noValidFiles {
    return Intl.message(
      'No valid files selected. Try again.',
      name: 'files_noValidFiles',
      desc: 'Error when no valid files are picked',
      args: [],
    );
  }

  /// `Upload failed.`
  String get files_uploadFailed {
    return Intl.message(
      'Upload failed.',
      name: 'files_uploadFailed',
      desc: 'Error when a file upload fails',
      args: [],
    );
  }

  /// `Camera access denied.`
  String get files_permissionDenied {
    return Intl.message(
      'Camera access denied.',
      name: 'files_permissionDenied',
      desc: 'Error when camera permission is denied',
      args: [],
    );
  }

  /// `Could not take photo.`
  String get files_photoError {
    return Intl.message(
      'Could not take photo.',
      name: 'files_photoError',
      desc: 'Error when taking a photo fails',
      args: [],
    );
  }

  /// `Could not select file.`
  String get files_pickerError {
    return Intl.message(
      'Could not select file.',
      name: 'files_pickerError',
      desc: 'Error when picking a file fails',
      args: [],
    );
  }

  /// `File exceeds 5MB. Upload may fail.`
  String get files_largeFileWarning {
    return Intl.message(
      'File exceeds 5MB. Upload may fail.',
      name: 'files_largeFileWarning',
      desc: 'Warning for large files',
      args: [],
    );
  }

  /// `Permissions are required to pick a photo.`
  String get files_permissionsRequired {
    return Intl.message(
      'Permissions are required to pick a photo.',
      name: 'files_permissionsRequired',
      desc: 'Message when permissions are needed for photos',
      args: [],
    );
  }

  /// `Hi! I'm VH Health Assistant. How can I help you today?`
  String get chatbot_greeting {
    return Intl.message(
      'Hi! I\'m VH Health Assistant. How can I help you today?',
      name: 'chatbot_greeting',
      desc: 'Chatbot\'s initial greeting message',
      args: [],
    );
  }

  /// `You can book an appointment from the Appointments section.`
  String get chatbot_replyAppointment {
    return Intl.message(
      'You can book an appointment from the Appointments section.',
      name: 'chatbot_replyAppointment',
      desc: 'Chatbot response for appointment queries',
      args: [],
    );
  }

  /// `Stay hydrated, rest well, monitor your fever, and consult a doctor.`
  String get chatbot_replyFever {
    return Intl.message(
      'Stay hydrated, rest well, monitor your fever, and consult a doctor.',
      name: 'chatbot_replyFever',
      desc: 'Chatbot response for fever queries',
      args: [],
    );
  }

  /// `Use the Pharmacy section to upload your prescription or request delivery.`
  String get chatbot_replyPharmacy {
    return Intl.message(
      'Use the Pharmacy section to upload your prescription or request delivery.',
      name: 'chatbot_replyPharmacy',
      desc: 'Chatbot response for pharmacy queries',
      args: [],
    );
  }

  /// `Use the red SOS button in the bottom corner for emergencies.`
  String get chatbot_replySOS {
    return Intl.message(
      'Use the red SOS button in the bottom corner for emergencies.',
      name: 'chatbot_replySOS',
      desc: 'Chatbot response for SOS queries',
      args: [],
    );
  }

  /// `You can view your records in the Your Health section.`
  String get chatbot_replyRecords {
    return Intl.message(
      'You can view your records in the Your Health section.',
      name: 'chatbot_replyRecords',
      desc: 'Chatbot response for records queries',
      args: [],
    );
  }

  /// `Thank you for your question. We'll get back to you if needed.`
  String get chatbot_replyDefault {
    return Intl.message(
      'Thank you for your question. We\'ll get back to you if needed.',
      name: 'chatbot_replyDefault',
      desc: 'Chatbot\'s default fallback response',
      args: [],
    );
  }

  /// `Type your question...`
  String get chatbot_chatPlaceholder {
    return Intl.message(
      'Type your question...',
      name: 'chatbot_chatPlaceholder',
      desc: 'Placeholder text for chatbot input',
      args: [],
    );
  }

  /// `Search Department or Doctor`
  String get search_placeholder {
    return Intl.message(
      'Search Department or Doctor',
      name: 'search_placeholder',
      desc: 'Placeholder for the main search bar',
      args: [],
    );
  }

  /// `Book Department Appointment`
  String get search_bookDepartment {
    return Intl.message(
      'Book Department Appointment',
      name: 'search_bookDepartment',
      desc: 'Button in search results to book by department',
      args: [],
    );
  }

  /// `Book Doctor Appointment`
  String get search_bookDoctor {
    return Intl.message(
      'Book Doctor Appointment',
      name: 'search_bookDoctor',
      desc: 'Button in search results to book a specific doctor',
      args: [],
    );
  }

  /// `Senior cardiologist with 15 years of experience.`
  String get doctorIntros_cardio1 {
    return Intl.message(
      'Senior cardiologist with 15 years of experience.',
      name: 'doctorIntros_cardio1',
      desc: 'Intro for a specific cardiologist',
      args: [],
    );
  }

  /// `Specialist in interventional cardiology and heart failure.`
  String get doctorIntros_cardio2 {
    return Intl.message(
      'Specialist in interventional cardiology and heart failure.',
      name: 'doctorIntros_cardio2',
      desc: 'Intro for a specific cardiologist',
      args: [],
    );
  }

  /// `Expert in stroke and neuromuscular disorders.`
  String get doctorIntros_neuro1 {
    return Intl.message(
      'Expert in stroke and neuromuscular disorders.',
      name: 'doctorIntros_neuro1',
      desc: 'Intro for a specific neurologist',
      args: [],
    );
  }

  /// `Focus on epilepsy and neurocritical care.`
  String get doctorIntros_neuro2 {
    return Intl.message(
      'Focus on epilepsy and neurocritical care.',
      name: 'doctorIntros_neuro2',
      desc: 'Intro for a specific neurologist',
      args: [],
    );
  }

  /// `Specialist in joint replacements and sports injuries.`
  String get doctorIntros_ortho1 {
    return Intl.message(
      'Specialist in joint replacements and sports injuries.',
      name: 'doctorIntros_ortho1',
      desc: 'Intro for a specific orthopedist',
      args: [],
    );
  }

  /// `Expert in spinal surgeries and fractures.`
  String get doctorIntros_ortho2 {
    return Intl.message(
      'Expert in spinal surgeries and fractures.',
      name: 'doctorIntros_ortho2',
      desc: 'Intro for a specific orthopedist',
      args: [],
    );
  }

  /// `Dedicated to child care and development.`
  String get doctorIntros_pedia1 {
    return Intl.message(
      'Dedicated to child care and development.',
      name: 'doctorIntros_pedia1',
      desc: 'Intro for a specific pediatrician',
      args: [],
    );
  }

  /// `Focus on neonatal and adolescent health.`
  String get doctorIntros_pedia2 {
    return Intl.message(
      'Focus on neonatal and adolescent health.',
      name: 'doctorIntros_pedia2',
      desc: 'Intro for a specific pediatrician',
      args: [],
    );
  }

  /// `Expert in skin allergies and cosmetic treatments.`
  String get doctorIntros_derma1 {
    return Intl.message(
      'Expert in skin allergies and cosmetic treatments.',
      name: 'doctorIntros_derma1',
      desc: 'Intro for a specific dermatologist',
      args: [],
    );
  }

  /// `Specialist in acne, psoriasis, and dermatology.`
  String get doctorIntros_derma2 {
    return Intl.message(
      'Specialist in acne, psoriasis, and dermatology.',
      name: 'doctorIntros_derma2',
      desc: 'Intro for a specific dermatologist',
      args: [],
    );
  }

  /// `Experienced general physician for complex cases.`
  String get doctorIntros_med1 {
    return Intl.message(
      'Experienced general physician for complex cases.',
      name: 'doctorIntros_med1',
      desc: 'Intro for a general physician',
      args: [],
    );
  }

  /// `Specialist in preventive medicine and diabetes care.`
  String get doctorIntros_med2 {
    return Intl.message(
      'Specialist in preventive medicine and diabetes care.',
      name: 'doctorIntros_med2',
      desc: 'Intro for a general physician',
      args: [],
    );
  }

  /// `Investigations`
  String get investigationsSection_title {
    return Intl.message(
      'Investigations',
      name: 'investigationsSection_title',
      desc: 'Title for the investigations section',
      args: [],
    );
  }

  /// `Request New Test`
  String get investigationsSection_requestTest {
    return Intl.message(
      'Request New Test',
      name: 'investigationsSection_requestTest',
      desc: 'Button to request a new test',
      args: [],
    );
  }

  /// `View My Reports`
  String get investigationsSection_viewReports {
    return Intl.message(
      'View My Reports',
      name: 'investigationsSection_viewReports',
      desc: 'Button to view reports',
      args: [],
    );
  }

  /// `Request Investigation`
  String get investigationsSection_requestInvestigation {
    return Intl.message(
      'Request Investigation',
      name: 'investigationsSection_requestInvestigation',
      desc: 'Button to request an investigation',
      args: [],
    );
  }

  /// `Enter Test Name (e.g., CBC, Lipid Profile)`
  String get investigationsSection_enterTestName {
    return Intl.message(
      'Enter Test Name (e.g., CBC, Lipid Profile)',
      name: 'investigationsSection_enterTestName',
      desc: 'Hint text for test name input',
      args: [],
    );
  }

  /// `Investigation request submitted!`
  String get investigationsSection_success {
    return Intl.message(
      'Investigation request submitted!',
      name: 'investigationsSection_success',
      desc: 'Success message for investigation request',
      args: [],
    );
  }

  /// `A staff member will call you to confirm your test slot.`
  String get investigationsSection_confirmationNote {
    return Intl.message(
      'A staff member will call you to confirm your test slot.',
      name: 'investigationsSection_confirmationNote',
      desc: 'Note about investigation confirmation',
      args: [],
    );
  }

  /// `Failed to submit investigation request.`
  String get investigationsSection_failed {
    return Intl.message(
      'Failed to submit investigation request.',
      name: 'investigationsSection_failed',
      desc: 'Error message for failed investigation request',
      args: [],
    );
  }

  /// `Test name is required.`
  String get investigationsSection_testNameRequired {
    return Intl.message(
      'Test name is required.',
      name: 'investigationsSection_testNameRequired',
      desc: 'Validation error for test name',
      args: [],
    );
  }

  /// `How was your consultation?`
  String get feedback_prompt {
    return Intl.message(
      'How was your consultation?',
      name: 'feedback_prompt',
      desc: 'Prompt for feedback rating',
      args: [],
    );
  }

  /// `Any comments (optional)`
  String get feedback_placeholder {
    return Intl.message(
      'Any comments (optional)',
      name: 'feedback_placeholder',
      desc: 'Placeholder for feedback comments',
      args: [],
    );
  }

  /// `Submit Feedback`
  String get feedback_submit {
    return Intl.message(
      'Submit Feedback',
      name: 'feedback_submit',
      desc: 'Button to submit feedback',
      args: [],
    );
  }

  /// `Feedback submitted successfully!`
  String get feedback_success {
    return Intl.message(
      'Feedback submitted successfully!',
      name: 'feedback_success',
      desc: 'Success message for feedback submission',
      args: [],
    );
  }

  /// `Could not submit feedback.`
  String get feedback_failed {
    return Intl.message(
      'Could not submit feedback.',
      name: 'feedback_failed',
      desc: 'Error message for failed feedback submission',
      args: [],
    );
  }

  /// `Please select a rating before submitting.`
  String get feedback_selectRatingPrompt {
    return Intl.message(
      'Please select a rating before submitting.',
      name: 'feedback_selectRatingPrompt',
      desc: 'Validation error for feedback rating',
      args: [],
    );
  }

  /// `Thank you!`
  String get feedback_thankYou {
    return Intl.message(
      'Thank you!',
      name: 'feedback_thankYou',
      desc: 'Thank you message after feedback',
      args: [],
    );
  }

  /// `Submitting...`
  String get feedback_submitting {
    return Intl.message(
      'Submitting...',
      name: 'feedback_submitting',
      desc: 'Status message while submitting feedback',
      args: [],
    );
  }

  /// `SOS triggered`
  String get sos_triggered {
    return Intl.message(
      'SOS triggered',
      name: 'sos_triggered',
      desc: 'Status message when SOS is triggered',
      args: [],
    );
  }

  /// `SOS sent to hospital`
  String get sos_sent {
    return Intl.message(
      'SOS sent to hospital',
      name: 'sos_sent',
      desc: 'Status message when SOS is sent',
      args: [],
    );
  }

  /// `Emergency alert sent!`
  String get sos_sosSent {
    return Intl.message(
      'Emergency alert sent!',
      name: 'sos_sosSent',
      desc: 'Confirmation that emergency alert was sent',
      args: [],
    );
  }

  /// `SOS Emergency`
  String get sos_buttonTooltip {
    return Intl.message(
      'SOS Emergency',
      name: 'sos_buttonTooltip',
      desc: 'Tooltip for the SOS button',
      args: [],
    );
  }

  /// `Cardiology`
  String get sos_cardiology {
    return Intl.message(
      'Cardiology',
      name: 'sos_cardiology',
      desc: 'SOS department option',
      args: [],
    );
  }

  /// `Neurology`
  String get sos_neurology {
    return Intl.message(
      'Neurology',
      name: 'sos_neurology',
      desc: 'SOS department option',
      args: [],
    );
  }

  /// `Orthopedics`
  String get sos_orthopedics {
    return Intl.message(
      'Orthopedics',
      name: 'sos_orthopedics',
      desc: 'SOS department option',
      args: [],
    );
  }

  /// `Dermatology`
  String get sos_dermatology {
    return Intl.message(
      'Dermatology',
      name: 'sos_dermatology',
      desc: 'SOS department option',
      args: [],
    );
  }

  /// `Pediatrics`
  String get sos_pediatrics {
    return Intl.message(
      'Pediatrics',
      name: 'sos_pediatrics',
      desc: 'SOS department option',
      args: [],
    );
  }

  /// `General Medicine`
  String get sos_general_medicine {
    return Intl.message(
      'General Medicine',
      name: 'sos_general_medicine',
      desc: 'SOS department option',
      args: [],
    );
  }

  /// `Departments & Doctors`
  String get departmentsDetails_title {
    return Intl.message(
      'Departments & Doctors',
      name: 'departmentsDetails_title',
      desc: 'Title for department details screen',
      args: [],
    );
  }

  /// `Failed to load departments`
  String get departmentsDetails_loadFailed {
    return Intl.message(
      'Failed to load departments',
      name: 'departmentsDetails_loadFailed',
      desc: 'Error when loading departments fails',
      args: [],
    );
  }

  /// `Book`
  String get departmentsDetails_book {
    return Intl.message(
      'Book',
      name: 'departmentsDetails_book',
      desc: 'Generic \'Book\' button text',
      args: [],
    );
  }

  /// `Doctor`
  String get departmentsDetails_doctor {
    return Intl.message(
      'Doctor',
      name: 'departmentsDetails_doctor',
      desc: 'Generic \'Doctor\' label',
      args: [],
    );
  }

  /// `Department`
  String get departmentsDetails_unknown {
    return Intl.message(
      'Department',
      name: 'departmentsDetails_unknown',
      desc: 'Fallback text for an unknown department',
      args: [],
    );
  }

  /// `Health Trivia`
  String get labels_trivia {
    return Intl.message(
      'Health Trivia',
      name: 'labels_trivia',
      desc: 'Label for trivia',
      args: [],
    );
  }

  /// `About Us`
  String get labels_aboutUs {
    return Intl.message(
      'About Us',
      name: 'labels_aboutUs',
      desc: 'Label for about us',
      args: [],
    );
  }

  /// `Cardiology`
  String get departmentNames_cardiology {
    return Intl.message(
      'Cardiology',
      name: 'departmentNames_cardiology',
      desc: 'Name of Cardiology department',
      args: [],
    );
  }

  /// `Neurology`
  String get departmentNames_neurology {
    return Intl.message(
      'Neurology',
      name: 'departmentNames_neurology',
      desc: 'Name of Neurology department',
      args: [],
    );
  }

  /// `Orthopedics`
  String get departmentNames_orthopedics {
    return Intl.message(
      'Orthopedics',
      name: 'departmentNames_orthopedics',
      desc: 'Name of Orthopedics department',
      args: [],
    );
  }

  /// `Dermatology`
  String get departmentNames_dermatology {
    return Intl.message(
      'Dermatology',
      name: 'departmentNames_dermatology',
      desc: 'Name of Dermatology department',
      args: [],
    );
  }

  /// `Pediatrics`
  String get departmentNames_pediatrics {
    return Intl.message(
      'Pediatrics',
      name: 'departmentNames_pediatrics',
      desc: 'Name of Pediatrics department',
      args: [],
    );
  }

  /// `General Medicine`
  String get departmentNames_general_medicine {
    return Intl.message(
      'General Medicine',
      name: 'departmentNames_general_medicine',
      desc: 'Name of General Medicine department',
      args: [],
    );
  }

  /// `Get OTP`
  String get getOtp {
    return Intl.message(
      'Get OTP',
      name: 'getOtp',
      desc: 'Repeated key for \'Get OTP\' button',
      args: [],
    );
  }

  /// `Continue as Guest`
  String get continueAsGuest {
    return Intl.message(
      'Continue as Guest',
      name: 'continueAsGuest',
      desc: 'Repeated key for \'Continue as Guest\' button',
      args: [],
    );
  }

  /// `By continuing, you agree to our`
  String get byContinuingYouAgree {
    return Intl.message(
      'By continuing, you agree to our',
      name: 'byContinuingYouAgree',
      desc: 'Repeated key for agreement text',
      args: [],
    );
  }

  /// `Terms`
  String get terms {
    return Intl.message(
      'Terms',
      name: 'terms',
      desc: 'Repeated key for \'Terms\' link',
      args: [],
    );
  }

  /// `SOS Emergency`
  String get sosButtonTooltip {
    return Intl.message(
      'SOS Emergency',
      name: 'sosButtonTooltip',
      desc: 'Repeated key for SOS tooltip',
      args: [],
    );
  }

  /// `Change Language`
  String get changeLanguage {
    return Intl.message(
      'Change Language',
      name: 'changeLanguage',
      desc: 'Button to change language',
      args: [],
    );
  }

  /// `Health Trivia`
  String get triviaLabel {
    return Intl.message(
      'Health Trivia',
      name: 'triviaLabel',
      desc: 'Repeated key for trivia label',
      args: [],
    );
  }

  /// `About Us`
  String get aboutUsLabel {
    return Intl.message(
      'About Us',
      name: 'aboutUsLabel',
      desc: 'Repeated key for about us label',
      args: [],
    );
  }

  /// `Login`
  String get login {
    return Intl.message(
      'Login',
      name: 'login',
      desc: 'Repeated key for login button',
      args: [],
    );
  }

  /// `Request Appointment`
  String get requestAppointment {
    return Intl.message(
      'Request Appointment',
      name: 'requestAppointment',
      desc: 'Repeated key for request appointment button',
      args: [],
    );
  }

  /// `Any comments (optional)`
  String get feedbackPlaceholder {
    return Intl.message(
      'Any comments (optional)',
      name: 'feedbackPlaceholder',
      desc: 'Repeated key for feedback placeholder',
      args: [],
    );
  }

  /// `Share your feedback...`
  String get feedbackHint {
    return Intl.message(
      'Share your feedback...',
      name: 'feedbackHint',
      desc: 'Hint text for feedback input',
      args: [],
    );
  }

  /// `Network error. Please check your connection.`
  String get networkError {
    return Intl.message(
      'Network error. Please check your connection.',
      name: 'networkError',
      desc: 'Repeated key for network error',
      args: [],
    );
  }

  /// `Guest User`
  String get guestUser {
    return Intl.message(
      'Guest User',
      name: 'guestUser',
      desc: 'Label for a guest user',
      args: [],
    );
  }

  /// `Not Available`
  String get notAvailable {
    return Intl.message(
      'Not Available',
      name: 'notAvailable',
      desc: 'Generic \'not available\' text',
      args: [],
    );
  }

  /// `Submit`
  String get submit {
    return Intl.message(
      'Submit',
      name: 'submit',
      desc: 'Repeated key for submit button',
      args: [],
    );
  }
}

class AppLocalizationDelegate extends LocalizationsDelegate<S> {
  const AppLocalizationDelegate();

  List<Locale> get supportedLocales {
    return const <Locale>[
      Locale.fromSubtags(languageCode: 'en'),
      Locale.fromSubtags(languageCode: 'hi'),
      Locale.fromSubtags(languageCode: 'ml'),
      Locale.fromSubtags(languageCode: 'ta'),
      Locale.fromSubtags(languageCode: 'te'),
    ];
  }

  @override
  bool isSupported(Locale locale) => _isSupported(locale);
  @override
  Future<S> load(Locale locale) => S.load(locale);
  @override
  bool shouldReload(AppLocalizationDelegate old) => false;

  bool _isSupported(Locale locale) {
    for (var supportedLocale in supportedLocales) {
      if (supportedLocale.languageCode == locale.languageCode) {
        return true;
      }
    }
    return false;
  }
}
