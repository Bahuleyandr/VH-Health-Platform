import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/intl.dart' as intl;

import 'app_localizations_en.dart';
import 'app_localizations_hi.dart';
import 'app_localizations_ml.dart';
import 'app_localizations_ta.dart';
import 'app_localizations_te.dart';

// ignore_for_file: type=lint

/// Callers can lookup localized strings with an instance of AppLocalizations
/// returned by `AppLocalizations.of(context)`.
///
/// Applications need to include `AppLocalizations.delegate()` in their app's
/// `localizationDelegates` list, and the locales they support in the app's
/// `supportedLocales` list. For example:
///
/// ```dart
/// import 'generated/app_localizations.dart';
///
/// return MaterialApp(
///   localizationsDelegates: AppLocalizations.localizationsDelegates,
///   supportedLocales: AppLocalizations.supportedLocales,
///   home: MyApplicationHome(),
/// );
/// ```
///
/// ## Update pubspec.yaml
///
/// Please make sure to update your pubspec.yaml to include the following
/// packages:
///
/// ```yaml
/// dependencies:
///   # Internationalization support.
///   flutter_localizations:
///     sdk: flutter
///   intl: any # Use the pinned version from flutter_localizations
///
///   # Rest of dependencies
/// ```
///
/// ## iOS Applications
///
/// iOS applications define key application metadata, including supported
/// locales, in an Info.plist file that is built into the application bundle.
/// To configure the locales supported by your app, you’ll need to edit this
/// file.
///
/// First, open your project’s ios/Runner.xcworkspace Xcode workspace file.
/// Then, in the Project Navigator, open the Info.plist file under the Runner
/// project’s Runner folder.
///
/// Next, select the Information Property List item, select Add Item from the
/// Editor menu, then select Localizations from the pop-up menu.
///
/// Select and expand the newly-created Localizations item then, for each
/// locale your application supports, add a new item and select the locale
/// you wish to add from the pop-up menu in the Value field. This list should
/// be consistent with the languages listed in the AppLocalizations.supportedLocales
/// property.
abstract class AppLocalizations {
  AppLocalizations(String locale)
    : localeName = intl.Intl.canonicalizedLocale(locale.toString());

  final String localeName;

  static AppLocalizations? of(BuildContext context) {
    return Localizations.of<AppLocalizations>(context, AppLocalizations);
  }

  static const LocalizationsDelegate<AppLocalizations> delegate =
      _AppLocalizationsDelegate();

  /// A list of this localizations delegate along with the default localizations
  /// delegates.
  ///
  /// Returns a list of localizations delegates containing this delegate along with
  /// GlobalMaterialLocalizations.delegate, GlobalCupertinoLocalizations.delegate,
  /// and GlobalWidgetsLocalizations.delegate.
  ///
  /// Additional delegates can be added by appending to this list in
  /// MaterialApp. This list does not have to be used at all if a custom list
  /// of delegates is preferred or required.
  static const List<LocalizationsDelegate<dynamic>> localizationsDelegates =
      <LocalizationsDelegate<dynamic>>[
        delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
      ];

  /// A list of this localizations delegate's supported locales.
  static const List<Locale> supportedLocales = <Locale>[
    Locale('en'),
    Locale('ta'),
    Locale('hi'),
    Locale('te'),
    Locale('ml'),
  ];

  /// Headline on the login screen
  ///
  /// In en, this message translates to:
  /// **'Login to your account'**
  String get authLoginTitle;

  /// Label for the phone number input field
  ///
  /// In en, this message translates to:
  /// **'Phone number'**
  String get authPhoneNumber;

  /// Prefix shown before the phone number text field (India country code)
  ///
  /// In en, this message translates to:
  /// **'+91 '**
  String get authPhonePrefix;

  /// Validation error when phone field is left empty
  ///
  /// In en, this message translates to:
  /// **'Please enter your phone number'**
  String get authPhoneValidationEmpty;

  /// Validation error when phone number format is incorrect
  ///
  /// In en, this message translates to:
  /// **'Please enter a valid 10-digit phone number'**
  String get authPhoneValidationInvalid;

  /// Button text to request an OTP
  ///
  /// In en, this message translates to:
  /// **'Get OTP'**
  String get authGetOtp;

  /// Status label shown while OTP request is in progress
  ///
  /// In en, this message translates to:
  /// **'Sending OTP…'**
  String get authSendingOtp;

  /// Success message shown after the magic link email has been dispatched.
  ///
  /// In en, this message translates to:
  /// **'Magic link sent successfully'**
  String get authMagicLinkSent;

  /// Error message shown when the server fails to send the magic link.
  ///
  /// In en, this message translates to:
  /// **'Failed to send magic link'**
  String get authMagicLinkFailed;

  /// Generic error message for unexpected issues during the magic link process.
  ///
  /// In en, this message translates to:
  /// **'Something went wrong while sending the magic link'**
  String get authMagicLinkError;

  /// Button text for guest login flow
  ///
  /// In en, this message translates to:
  /// **'Continue as Guest'**
  String get authContinueAsGuest;

  /// Prefix text for the terms and conditions sentence
  ///
  /// In en, this message translates to:
  /// **'By continuing, you agree to the'**
  String get authByContinuingYouAgree;

  /// Clickable link text for Terms document
  ///
  /// In en, this message translates to:
  /// **'Terms'**
  String get authTerms;

  /// Clickable link text for Conditions document
  ///
  /// In en, this message translates to:
  /// **'Conditions'**
  String get authConditions;

  /// The conjunction between Conditions and Privacy Policy
  ///
  /// In en, this message translates to:
  /// **'and'**
  String get authAnd;

  /// Clickable link text for Privacy Policy document
  ///
  /// In en, this message translates to:
  /// **'Privacy Policy'**
  String get authPrivacyPolicy;

  /// Tooltip shown when hovering the SOS FloatingActionButton
  ///
  /// In en, this message translates to:
  /// **'Send SOS'**
  String get authSosTooltip;

  /// Snack-bar message after SOS is successfully sent
  ///
  /// In en, this message translates to:
  /// **'SOS alert has been triggered!'**
  String get authSosTriggered;

  /// Identifier used when SOS is triggered without a signed-in phone
  ///
  /// In en, this message translates to:
  /// **'guest_user_sos'**
  String get authGuestUserSOS;

  /// Title in the app bar of the OTP verification screen
  ///
  /// In en, this message translates to:
  /// **'Verify OTP'**
  String get otpVerifyOtpTitle;

  /// Prefix before the user phone number
  ///
  /// In en, this message translates to:
  /// **'OTP sent to'**
  String get otpOtpSentTo;

  /// Label above the six-digit OTP input
  ///
  /// In en, this message translates to:
  /// **'Enter OTP'**
  String get otpEnterOtp;

  /// Validation message when OTP field is empty
  ///
  /// In en, this message translates to:
  /// **'Please enter the OTP'**
  String get otpPleaseEnterOtp;

  /// Validation message when OTP length is not six
  ///
  /// In en, this message translates to:
  /// **'OTP must be 6 digits'**
  String get otpOtpMustBe6Digits;

  /// Primary button text to verify OTP
  ///
  /// In en, this message translates to:
  /// **'Verify'**
  String get otpVerify;

  /// Prefix before cooldown seconds, e.g. 'Resend OTP in 25 s'
  ///
  /// In en, this message translates to:
  /// **'Resend OTP in'**
  String get otpResendOtpIn;

  /// Clickable text to resend OTP once cooldown is over
  ///
  /// In en, this message translates to:
  /// **'Resend OTP'**
  String get otpResendOtp;

  /// Generic error prefix in snackbars
  ///
  /// In en, this message translates to:
  /// **'An error occurred'**
  String get otpErrorOccurred;

  /// Snackbar shown after successful login
  ///
  /// In en, this message translates to:
  /// **'Login successful'**
  String get otpLoginSuccessful;

  /// Snackbar when backend login fails
  ///
  /// In en, this message translates to:
  /// **'Login failed'**
  String get otpLoginFailed;

  /// Generic OTP verification failure message
  ///
  /// In en, this message translates to:
  /// **'Failed to verify OTP'**
  String get otpFailed;

  /// FirebaseAuthException: invalid-verification-code
  ///
  /// In en, this message translates to:
  /// **'Invalid OTP'**
  String get otpInvalidOtp;

  /// FirebaseAuthException: session-expired
  ///
  /// In en, this message translates to:
  /// **'OTP session expired'**
  String get otpOtpSessionExpired;

  /// Snackbar when resend attempt fails
  ///
  /// In en, this message translates to:
  /// **'Failed to resend OTP'**
  String get otpOtpResendFailed;

  /// Snackbar when resend attempt succeeds
  ///
  /// In en, this message translates to:
  /// **'OTP resent successfully'**
  String get otpOtpResentSuccessfully;

  /// Edge-case error when Firebase returns null ID token
  ///
  /// In en, this message translates to:
  /// **'Invalid Firebase token'**
  String get otpInvalidFirebaseToken;

  /// Snackbar after Firebase phone auth auto-verification succeeds
  ///
  /// In en, this message translates to:
  /// **'You have been signed in automatically!'**
  String get autoSignInSuccess;

  /// App-bar title for Terms / Conditions / Privacy screen
  ///
  /// In en, this message translates to:
  /// **'Terms, Conditions & Privacy'**
  String get commonTermsConditionsDisclaimerTitle;

  /// Section header for Terms of Use
  ///
  /// In en, this message translates to:
  /// **'Terms of Use'**
  String get commonTermsOfUse;

  /// Section header for Conditions / Disclaimers
  ///
  /// In en, this message translates to:
  /// **'Conditions'**
  String get commonConditions;

  /// Section header for Privacy Policy
  ///
  /// In en, this message translates to:
  /// **'Privacy Policy'**
  String get commonPrivacyPolicy;

  /// Button text to return to Login screen
  ///
  /// In en, this message translates to:
  /// **'Back to Login'**
  String get commonBackToLogin;

  /// Button text to navigate back to the main dashboard screen
  ///
  /// In en, this message translates to:
  /// **'Back to Dashboard'**
  String get backToDashboard;

  /// Entire Terms of Use content displayed in the Terms disclaimer screen
  ///
  /// In en, this message translates to:
  /// **'Welcome to VH Health. By accessing and using this mobile application, you agree to be bound by these Terms of Use.\n\n1. Purpose: VH Health is a mobile application designed to assist patients in managing their health records, appointments, prescriptions, investigations, and communication with the hospital.\n2. Eligibility: You must be at least 18 years old to use this app independently. Use by minors must be supervised by a guardian.\n3. Use of Services:\n   • You agree to provide accurate and complete information.\n   • You agree not to misuse or interfere with the app’s functionality or security.\n   • Any unlawful or prohibited use is strictly forbidden.\n4. Intellectual Property: All content within the app, including logos, text, images, and data, is the property of VH Health or its licensors and protected by applicable copyright and trademark laws.\n5. Modification: We reserve the right to modify or discontinue any feature or functionality at any time, with or without notice.\n6. Termination: VH Health may suspend or terminate access to any user found violating the Terms or engaging in misuse.'**
  String get termsBody;

  /// Entire Conditions / medical disclaimer text
  ///
  /// In en, this message translates to:
  /// **'1. **Medical Advice Disclaimer:**\n   • The app is intended for general informational purposes and convenience.\n   • It does not replace direct consultation with qualified healthcare professionals.\n   • Always consult your doctor or hospital staff for diagnosis and treatment.\n\n2. Emergency Use:\n   • This app is not intended for emergency medical assistance.\n   • In case of emergency, please call your local emergency number or go to the nearest hospital.\n\n3. Service Availability:\n   • We strive for consistent availability, but do not guarantee uninterrupted access.\n   • Technical issues, updates, or network failures may occasionally impact access.\n\n4. Data Accuracy:\n   • Information such as appointment schedules and reports are retrieved from hospital systems and may be subject to manual entry.\n   • VH Health is not liable for errors caused by incorrect data entry or third-party system issues.'**
  String get conditionsBody;

  /// Entire Privacy Policy text
  ///
  /// In en, this message translates to:
  /// **'1. **Information Collection:**\n   • We collect your name, phone number, UID, medical records, appointment data, and uploads.\n   • We may also collect device identifiers and usage analytics for improving app performance.\n\n2. Use of Information:\n   • Your information is used strictly for providing services within the app.\n   • We do not sell your data or use it for advertising purposes.\n\n3. Data Sharing:\n   • Your data may be shared with authorized hospital staff and medical professionals involved in your care.\n   • We may also disclose data if required by law or in case of legal obligations.\n\n4. Data Security:\n   • We use industry-standard security practices to protect your data.\n   • However, no system is 100% secure; use of the app is at your own risk.\n\n5. Your Rights:\n   • You may request access to your stored information or request corrections.\n   • You may also request deletion of your account by contacting the hospital administration.\n\n6. Data Retention:\n   • Your data will be retained as long as necessary for healthcare or legal purposes.'**
  String get privacyBody;

  /// Title of the profile edit screen
  ///
  /// In en, this message translates to:
  /// **'Edit Profile'**
  String get profileEditScreenTitle;

  /// Label for name input
  ///
  /// In en, this message translates to:
  /// **'Full name'**
  String get profileNameLabel;

  /// Hint for name input
  ///
  /// In en, this message translates to:
  /// **'Enter your full name'**
  String get profileNameHint;

  /// Validation message when name is empty
  ///
  /// In en, this message translates to:
  /// **'Name is required'**
  String get profileNameValidationRequired;

  /// Label for email input
  ///
  /// In en, this message translates to:
  /// **'Email address'**
  String get profileEmailLabel;

  /// Hint for email input
  ///
  /// In en, this message translates to:
  /// **'example@domain.com'**
  String get profileEmailHint;

  /// Validation message for invalid email
  ///
  /// In en, this message translates to:
  /// **'Enter a valid email address'**
  String get profileEmailValidationInvalid;

  /// Label for birthday field
  ///
  /// In en, this message translates to:
  /// **'Birthday'**
  String get profileBirthdayLabel;

  /// Hint for birthday field
  ///
  /// In en, this message translates to:
  /// **'Select your birth date'**
  String get profileBirthdayHint;

  /// Button text to save profile edits
  ///
  /// In en, this message translates to:
  /// **'Save changes'**
  String get profileSaveChangesButton;

  /// Snackbar text after successful profile update
  ///
  /// In en, this message translates to:
  /// **'Profile updated successfully'**
  String get profileUpdatedSuccessfully;

  /// Snackbar text when a generic network error occurs
  ///
  /// In en, this message translates to:
  /// **'Network error. Please try again.'**
  String get networkError;

  /// App-bar title of profile setup screen
  ///
  /// In en, this message translates to:
  /// **'Set up your profile'**
  String get profileSetupTitle;

  /// Prompt inside empty avatar
  ///
  /// In en, this message translates to:
  /// **'Add photo'**
  String get profileUploadProfilePic;

  /// Snackbar after profile saved
  ///
  /// In en, this message translates to:
  /// **'Profile saved successfully'**
  String get profileSetupSaved;

  /// Snackbar when save fails
  ///
  /// In en, this message translates to:
  /// **'Unable to save profile'**
  String get profileSetupSaveFailed;

  /// Label for gender dropdown
  ///
  /// In en, this message translates to:
  /// **'Gender'**
  String get profileGenderLabel;

  /// Gender option: male
  ///
  /// In en, this message translates to:
  /// **'Male'**
  String get profileGenderMale;

  /// Gender option: female
  ///
  /// In en, this message translates to:
  /// **'Female'**
  String get profileGenderFemale;

  /// Gender option: other
  ///
  /// In en, this message translates to:
  /// **'Other'**
  String get profileGenderOther;

  /// Validation when no gender chosen
  ///
  /// In en, this message translates to:
  /// **'Please select a gender'**
  String get profileGenderValidationRequired;

  /// Hint text showing email field is optional
  ///
  /// In en, this message translates to:
  /// **'Optional'**
  String get profileEmailHintOptional;

  /// Label when birthday not chosen
  ///
  /// In en, this message translates to:
  /// **'Select birthday'**
  String get profileBirthdaySelectLabel;

  /// Short label used before formatted date
  ///
  /// In en, this message translates to:
  /// **'Birthday'**
  String get profileBirthdayLabelShort;

  /// Label when anniversary not chosen
  ///
  /// In en, this message translates to:
  /// **'Select anniversary'**
  String get profileAnniversarySelectLabel;

  /// Short label used before formatted date
  ///
  /// In en, this message translates to:
  /// **'Anniversary'**
  String get profileAnniversaryLabelShort;

  /// Secondary button that lets the user skip an optional step
  ///
  /// In en, this message translates to:
  /// **'Skip'**
  String get commonSkipButton;

  /// Primary button used to confirm or finish an action
  ///
  /// In en, this message translates to:
  /// **'Submit'**
  String get commonSubmitButton;

  /// Generic button label for cancelling a dialog or action
  ///
  /// In en, this message translates to:
  /// **'Cancel'**
  String get commonCancelButton;

  /// Snackbar when image picker fails
  ///
  /// In en, this message translates to:
  /// **'Could not pick file. Please try again.'**
  String get filesPickerError;

  /// Greeting used on dashboard app-bar
  ///
  /// In en, this message translates to:
  /// **'Hello'**
  String get hello;

  /// Tooltip for language switcher
  ///
  /// In en, this message translates to:
  /// **'Change language'**
  String get changeLanguage;

  /// Label before date of last appointment
  ///
  /// In en, this message translates to:
  /// **'Last appointment'**
  String get lastAppointment;

  /// Label before next appointment date
  ///
  /// In en, this message translates to:
  /// **'Upcoming appointment'**
  String get upcomingAppointment;

  /// Shown when a value is unavailable
  ///
  /// In en, this message translates to:
  /// **'N/A'**
  String get notAvailable;

  /// Dashboard tile: Your Health
  ///
  /// In en, this message translates to:
  /// **'Your Health'**
  String get yourHealth;

  /// Dashboard tile: Appointments
  ///
  /// In en, this message translates to:
  /// **'Appointments'**
  String get appointments;

  /// Dashboard tile: Pharmacy
  ///
  /// In en, this message translates to:
  /// **'Pharmacy'**
  String get pharmacy;

  /// Dashboard tile: Tests & Reports
  ///
  /// In en, this message translates to:
  /// **'Tests & Reports'**
  String get investigations;

  /// Dashboard tile: Ask a Doubt
  ///
  /// In en, this message translates to:
  /// **'Ask a Doubt'**
  String get askDoubt;

  /// Dashboard tile: Trivia
  ///
  /// In en, this message translates to:
  /// **'Trivia'**
  String get triviaLabel;

  /// Dashboard tile: Departments
  ///
  /// In en, this message translates to:
  /// **'Departments'**
  String get departments;

  /// Dashboard tile: About Us
  ///
  /// In en, this message translates to:
  /// **'About Us'**
  String get aboutUsLabel;

  /// App-bar title for Your Health screen
  ///
  /// In en, this message translates to:
  /// **'Your Health'**
  String get yourHealthTitle;

  /// Tooltip when list is oldest→newest; tapping switches to newest first
  ///
  /// In en, this message translates to:
  /// **'Sort: newest first'**
  String get yourHealthSortNewest;

  /// Tooltip when list is newest→oldest; tapping switches to oldest first
  ///
  /// In en, this message translates to:
  /// **'Sort: oldest first'**
  String get yourHealthSortOldest;

  /// Dropdown label for record type filter
  ///
  /// In en, this message translates to:
  /// **'Filter by type'**
  String get yourHealthFilterByType;

  /// Shown when the records list is empty
  ///
  /// In en, this message translates to:
  /// **'No records found'**
  String get yourHealthNoRecords;

  /// Prefix before upload date
  ///
  /// In en, this message translates to:
  /// **'Uploaded'**
  String get yourHealthUploaded;

  /// Message shown to guest users
  ///
  /// In en, this message translates to:
  /// **'Log in to access your medical records'**
  String get yourHealthLoginToView;

  /// Snackbar text when API fetch fails
  ///
  /// In en, this message translates to:
  /// **'Could not load records'**
  String get recordsLoadFailed;

  /// Snackbar when cached data is displayed
  ///
  /// In en, this message translates to:
  /// **'Showing offline data'**
  String get recordsShowingOffline;

  /// Snackbar when backend indicates file quarantine
  ///
  /// In en, this message translates to:
  /// **'File is quarantined and cannot be downloaded'**
  String get fileQuarantined;

  /// Snackbar when file cannot be downloaded or opened
  ///
  /// In en, this message translates to:
  /// **'Unable to open file'**
  String get fileCouldNotOpen;

  /// Record type option: all
  ///
  /// In en, this message translates to:
  /// **'All'**
  String get recordTypeAll;

  /// Record type option: consultation
  ///
  /// In en, this message translates to:
  /// **'Consultation'**
  String get recordTypeConsultation;

  /// Record type option: investigation
  ///
  /// In en, this message translates to:
  /// **'Investigation'**
  String get recordTypeInvestigation;

  /// Record type option: report
  ///
  /// In en, this message translates to:
  /// **'Report'**
  String get recordTypeReport;

  /// Generic login button label
  ///
  /// In en, this message translates to:
  /// **'Login'**
  String get login;

  /// App-bar title
  ///
  /// In en, this message translates to:
  /// **'Request Appointment'**
  String get requestAppointment;

  /// Heading for phone input when guest
  ///
  /// In en, this message translates to:
  /// **'Enter your phone number'**
  String get enterYourPhone;

  /// Validation for phone field
  ///
  /// In en, this message translates to:
  /// **'Please enter a valid 10-digit phone number'**
  String get enterValidPhone;

  /// Dropdown label for department select
  ///
  /// In en, this message translates to:
  /// **'Select department'**
  String get chooseDepartmentOrDoctor;

  /// Label for doctor dropdown
  ///
  /// In en, this message translates to:
  /// **'Select doctor (optional)'**
  String get selectDoctorPlaceholder;

  /// Validation when no department chosen
  ///
  /// In en, this message translates to:
  /// **'Please choose a department'**
  String get selectDoctorAndDate;

  /// Button text to submit appointment request
  ///
  /// In en, this message translates to:
  /// **'Submit request'**
  String get submitRequest;

  /// Snackbar after successful submission
  ///
  /// In en, this message translates to:
  /// **'Appointment request received! We’ll confirm soon.'**
  String get appointmentConfirmationNote;

  /// Generic API failure message
  ///
  /// In en, this message translates to:
  /// **'Failed to book appointment'**
  String get appointmentFailed;

  /// Generic network/error snackbar
  ///
  /// In en, this message translates to:
  /// **'Something went wrong. Please try again.'**
  String get genericError;

  /// Dialog title for calendar sync
  ///
  /// In en, this message translates to:
  /// **'Add to Calendar?'**
  String get calendarSyncTitle;

  /// Dialog body for calendar sync
  ///
  /// In en, this message translates to:
  /// **'Do you want to add this appointment to your calendar?'**
  String get calendarSyncPrompt;

  /// Dialog button: always add to calendar
  ///
  /// In en, this message translates to:
  /// **'Yes, always'**
  String get yesAlways;

  /// Dialog button: decline adding to calendar
  ///
  /// In en, this message translates to:
  /// **'No'**
  String get no;

  /// Title for calendar event
  ///
  /// In en, this message translates to:
  /// **'VH Health Appointment'**
  String get calendarEventTitle;

  /// Description for calendar event
  ///
  /// In en, this message translates to:
  /// **'Appointment with {doctor}'**
  String calendarEventDescription(Object doctor);

  /// Location string for calendar event
  ///
  /// In en, this message translates to:
  /// **'VH Health Hospital'**
  String get calendarEventLocation;

  /// Fallback doctor name in calendar description
  ///
  /// In en, this message translates to:
  /// **'the doctor'**
  String get generalDoctor;

  /// Snackbar after SOS button tapped
  ///
  /// In en, this message translates to:
  /// **'SOS alert sent!'**
  String get sosSent;

  /// Label for phone text field
  ///
  /// In en, this message translates to:
  /// **'Phone number'**
  String get requestAppointmentPhoneNumber;

  /// No description provided for @cardiology.
  ///
  /// In en, this message translates to:
  /// **'Cardiology'**
  String get cardiology;

  /// No description provided for @neurology.
  ///
  /// In en, this message translates to:
  /// **'Neurology'**
  String get neurology;

  /// No description provided for @orthopedics.
  ///
  /// In en, this message translates to:
  /// **'Orthopedics'**
  String get orthopedics;

  /// No description provided for @dermatology.
  ///
  /// In en, this message translates to:
  /// **'Dermatology'**
  String get dermatology;

  /// No description provided for @pediatrics.
  ///
  /// In en, this message translates to:
  /// **'Pediatrics'**
  String get pediatrics;

  /// No description provided for @general_medicine.
  ///
  /// In en, this message translates to:
  /// **'General Medicine'**
  String get general_medicine;

  /// App-bar title for pharmacy screen
  ///
  /// In en, this message translates to:
  /// **'Order Medicines'**
  String get pharmacyTitle;

  /// Snackbar when user denies file-picker permissions
  ///
  /// In en, this message translates to:
  /// **'Storage permission required to select files.'**
  String get pharmacyPermissionsRequired;

  /// Snackbar when file-picker fails
  ///
  /// In en, this message translates to:
  /// **'Could not pick the file. Please try again.'**
  String get pharmacyFilePickerError;

  /// Snackbar when submit pressed without form/file
  ///
  /// In en, this message translates to:
  /// **'Please complete the form and attach a prescription file.'**
  String get pharmacyFormAndFileRequired;

  /// Snackbar when prescription upload fails
  ///
  /// In en, this message translates to:
  /// **'Upload failed. Please try again.'**
  String get pharmacyUploadFailed;

  /// Generic fallback message from backend error
  ///
  /// In en, this message translates to:
  /// **'Order submission failed.'**
  String get pharmacySubmissionFailed;

  /// Snackbar after successful order
  ///
  /// In en, this message translates to:
  /// **'Order placed! Our pharmacy will call to confirm.'**
  String get pharmacyConfirmationNote;

  /// Top banner with instructions
  ///
  /// In en, this message translates to:
  /// **'Upload your doctor’s prescription (PDF or image) and delivery address.'**
  String get pharmacyInfoBanner;

  /// Button text to pick a file
  ///
  /// In en, this message translates to:
  /// **'Upload prescription'**
  String get pharmacyUploadPrescriptionButton;

  /// Prefix before selected filename
  ///
  /// In en, this message translates to:
  /// **'Selected'**
  String get fileSelected;

  /// Link to remove selected file
  ///
  /// In en, this message translates to:
  /// **'Clear'**
  String get fileClearSelection;

  /// Label for address textarea
  ///
  /// In en, this message translates to:
  /// **'Delivery address'**
  String get pharmacyDeliveryAddressLabel;

  /// Hint inside address textarea
  ///
  /// In en, this message translates to:
  /// **'House / flat no., street, area, pin code…'**
  String get pharmacyDeliveryAddressHint;

  /// Validation when address empty
  ///
  /// In en, this message translates to:
  /// **'Address is required'**
  String get pharmacyDeliveryAddressValidationRequired;

  /// Primary button to submit pharmacy order
  ///
  /// In en, this message translates to:
  /// **'Submit order'**
  String get pharmacySubmitOrderButton;

  /// Button to trigger phone call to pharmacy
  ///
  /// In en, this message translates to:
  /// **'Call pharmacy'**
  String get pharmacyCallButton;

  /// Snackbar when tel: launch fails
  ///
  /// In en, this message translates to:
  /// **'Could not launch dialer.'**
  String get pharmacyCallFailed;

  /// Label for phone field (guest mode)
  ///
  /// In en, this message translates to:
  /// **'Phone number'**
  String get pharmacyPhoneNumberLabel;

  /// Hint for phone field
  ///
  /// In en, this message translates to:
  /// **'10-digit mobile number'**
  String get pharmacyPhoneNumberHint;

  /// Validation error for phone input
  ///
  /// In en, this message translates to:
  /// **'Enter a valid 10-digit phone number'**
  String get pharmacyPhoneNumberValidationInvalid;

  /// App-bar title
  ///
  /// In en, this message translates to:
  /// **'Tests & Reports'**
  String get investigationsTitle;

  /// Label for investigation test name
  ///
  /// In en, this message translates to:
  /// **'Test name'**
  String get investigationsTestNameLabel;

  /// Hint in test name field
  ///
  /// In en, this message translates to:
  /// **'e.g. Complete blood count'**
  String get investigationsTestNameHint;

  /// Validation when test name empty
  ///
  /// In en, this message translates to:
  /// **'Test name is required'**
  String get investigationsTestNameValidationRequired;

  /// Button text to pick file
  ///
  /// In en, this message translates to:
  /// **'Upload doctor’s order'**
  String get investigationsUploadFileButtonLabel;

  /// Primary button text
  ///
  /// In en, this message translates to:
  /// **'Submit request'**
  String get investigationsSubmitRequestButton;

  /// Link to Your Health investigation filter
  ///
  /// In en, this message translates to:
  /// **'View investigation reports'**
  String get investigationsViewReportsButton;

  /// Snackbar when form/file missing
  ///
  /// In en, this message translates to:
  /// **'Please complete the form and attach a file.'**
  String get investigationsFormAndFileRequired;

  /// Snackbar after successful submission
  ///
  /// In en, this message translates to:
  /// **'Request sent! We’ll contact you to schedule.'**
  String get investigationsConfirmationNote;

  /// Generic backend failure
  ///
  /// In en, this message translates to:
  /// **'Failed to submit request.'**
  String get investigationsFailed;

  /// Snackbar when upload fails
  ///
  /// In en, this message translates to:
  /// **'File upload failed. Please try again.'**
  String get investigationsUploadFailed;

  /// Snackbar when user denies permissions
  ///
  /// In en, this message translates to:
  /// **'Storage permission required.'**
  String get investigationsPermissionsRequired;

  /// Snackbar when file-picker throws
  ///
  /// In en, this message translates to:
  /// **'Could not pick a file. Please try again.'**
  String get investigationsFilePickerError;

  /// App-bar title for trivia screen
  ///
  /// In en, this message translates to:
  /// **'Health Trivia'**
  String get triviaTitle;

  /// Heading above the trivia fact
  ///
  /// In en, this message translates to:
  /// **'Did you know?'**
  String get triviaDidYouKnow;

  /// Button to load a new random trivia fact
  ///
  /// In en, this message translates to:
  /// **'Show another fact'**
  String get triviaNewTriviaButton;

  /// Random trivia fact #1
  ///
  /// In en, this message translates to:
  /// **'The human heart beats about 100,000 times per day.'**
  String get triviaFact1;

  /// Random trivia fact #2
  ///
  /// In en, this message translates to:
  /// **'Laughing 100 times is roughly equivalent to 15 minutes of exercise on a stationary bike.'**
  String get triviaFact2;

  /// Random trivia fact #3
  ///
  /// In en, this message translates to:
  /// **'Your nose can remember 50,000 different scents.'**
  String get triviaFact3;

  /// Random trivia fact #4
  ///
  /// In en, this message translates to:
  /// **'Bones are about five times stronger than steel of the same weight.'**
  String get triviaFact4;

  /// Random trivia fact #5
  ///
  /// In en, this message translates to:
  /// **'The average adult skin covers about 2 square meters.'**
  String get triviaFact5;

  /// Random trivia fact #6
  ///
  /// In en, this message translates to:
  /// **'Your stomach lining replaces itself every few days to avoid digesting itself.'**
  String get triviaFact6;

  /// Random trivia fact #7
  ///
  /// In en, this message translates to:
  /// **'The strongest muscle (by weight) is the masseter—the jaw muscle.'**
  String get triviaFact7;

  /// Random trivia fact #8
  ///
  /// In en, this message translates to:
  /// **'People are about 1 cm taller in the morning than at night.'**
  String get triviaFact8;

  /// Random trivia fact #9
  ///
  /// In en, this message translates to:
  /// **'Sweat itself is odorless; bacteria on skin produce body odor.'**
  String get triviaFact9;

  /// Random trivia fact #10
  ///
  /// In en, this message translates to:
  /// **'Humans share 50% of their DNA with bananas.'**
  String get triviaFact10;

  /// App-bar title for departments screen
  ///
  /// In en, this message translates to:
  /// **'Hospital Departments'**
  String get departmentsTitle;

  /// Snackbar when fetch fails
  ///
  /// In en, this message translates to:
  /// **'Unable to load departments. Please pull down to retry.'**
  String get departmentsLoadFailed;

  /// Shown when API returns empty list
  ///
  /// In en, this message translates to:
  /// **'No departments found.'**
  String get departmentsNoneFound;

  /// Fallback name when department field missing
  ///
  /// In en, this message translates to:
  /// **'Unknown department'**
  String get departmentsUnknown;

  /// Fallback doctor name
  ///
  /// In en, this message translates to:
  /// **'Doctor'**
  String get departmentsDoctor;

  /// Button text to book an appointment with a doctor
  ///
  /// In en, this message translates to:
  /// **'Book'**
  String get departmentsBook;

  /// Display name for guest users
  ///
  /// In en, this message translates to:
  /// **'Guest'**
  String get guestUser;

  /// Full markdown content for About Us screen
  ///
  /// In en, this message translates to:
  /// **'Since our inception in 2003, Venkataeswara Hospitals has stood as a beacon of hope and healing in the heart of Chennai. Founded by the visionary cardiologist Dr. Thillai Vallal, we have transformed from a specialized cardiac care center into one of Chennai\'s most trusted multispecialty healthcare institutions, touching over a million lives with our commitment to compassionate care.\n\n## Our Mission: Prevention is Our Passion\nAt Venkataeswara Hospitals, we believe that the best treatment is prevention. Our primary mission extends beyond healing—we are dedicated to preventing the onset of lifestyle diseases through comprehensive screening, education, and personalized wellness programs. This proactive approach has helped thousands of patients avoid heart attacks, strokes, and other preventable conditions.\n\n## World-Class Facilities, Hometown Care\nOur 150-bed facility at Chamiers Road, Nandanam, combines cutting-edge technology with the warmth of personalized care. With over 100 distinguished doctors across multiple specialties and state-of-the-art infrastructure, we offer:\n\n- **Advanced Cardiac Care**: Over 100,000 successful cardiac procedures completed\n- **24/7 Emergency Services**: Round-the-clock trauma and critical care\n- **Comprehensive Specialties**: From cardiology to cosmetology, neurology to nephrology\n- **Modern ICU**: 25-bed closed ICU with 1:1 nurse-patient ratio and advanced monitoring systems\n- **Cutting-Edge Diagnostics**: MRI, CT scan, advanced pathology lab, and imaging facilities\n\n## Pioneering Medical Excellence\n### Latest Procedures & Technologies\n\n**Minimally Invasive Cardiac Interventions**\n- Advanced angioplasty techniques with drug-eluting stents\n- Transcatheter Aortic Valve Replacement (TAVR)\n- Leadless pacemaker implantation\n- 3D mapping for complex arrhythmia ablations\n- Intravascular ultrasound (IVUS) guided procedures\n\n**Robotic & Laparoscopic Surgery**\n- Robot-assisted surgeries for precise tumor removal\n- Single-incision laparoscopic procedures\n- Endoscopic spine surgeries with faster recovery\n- Laser-assisted surgeries for minimal scarring\n\n**Advanced Cancer Care**\n- Targeted therapy and immunotherapy protocols\n- Image-guided radiation therapy (IGRT)\n- CyberKnife radiosurgery for tumor treatment\n- Personalized cancer genomics testing\n- Pain-free chemotherapy delivery systems\n\n**Cutting-Edge Diagnostics**\n- 3 Tesla MRI for ultra-high resolution imaging\n- 256-slice CT scanner for cardiac and whole-body scans\n- PET-CT for early cancer detection\n- Advanced 4D ultrasound technology\n- AI-powered diagnostic interpretation systems\n\n**Innovative Treatment Approaches**\n- Stem cell therapy for cardiac regeneration\n- Platelet-rich plasma (PRP) therapy\n- Non-surgical body contouring and aesthetic procedures\n- Advanced wound healing with hyperbaric oxygen therapy\n- Integrated holistic healing combining Siddha and modern medicine\n\n## Recognition & Excellence\n- **Radio City Icon Award 2022** for Excellence in Heart Care\n- **NABH Accreditation** ensuring highest standards of patient care and safety\n- **4.7/5 Patient Satisfaction Rating** based on thousands of reviews\n- **Center of Excellence** designation in multiple specialties\n\n## Innovation in Healthcare Education\nBeyond patient care, we nurture the next generation of healthcare professionals through our Allied Health Sciences programs. Affiliated with The Tamil Nadu Dr. M.G.R. Medical University, we offer specialized courses in cardiac technology, critical care, and healthcare management.\n\n## Our Values, Your Trust\n**Kindness** – Every patient is family  \n**Excellence** – Pursuit of the highest medical standards  \n**Innovation** – Embracing advanced treatments and technologies  \n**Integrity** – Transparent, ethical healthcare delivery\n\n## Leadership That Inspires\nUnder the leadership of Dr. Thillai Vallal—an active member of the Cardiological Society of India, European Society of Cardiology, and Indian Medical Association—our hospital continues to pioneer integrated healthcare approaches, combining modern medicine with holistic wellness.\n\n## Your Health, Our Commitment\nFrom routine check-ups to complex surgeries, from preventive care to emergency interventions, Venkataeswara Hospitals stands ready to serve you 24/7. With cashless insurance facilities, affordable treatment options, and a patient-first approach, we ensure that quality healthcare remains accessible to all.\n\n**Visit us at:** \n36-A, Chamiers Road, Nandanam  \nChennai – 600035  \n(Near Devar Statue)\n\n*Where healing meets heart, and technology meets compassion—Welcome to Venkataeswara Hospitals, your partner in lifelong wellness.*'**
  String get aboutUsContent;

  /// App-bar title
  ///
  /// In en, this message translates to:
  /// **'Settings'**
  String get settingsTitle;

  /// List-tile label to edit profile
  ///
  /// In en, this message translates to:
  /// **'Edit profile'**
  String get settingsEditProfile;

  /// Section title for language
  ///
  /// In en, this message translates to:
  /// **'Language'**
  String get settingsLanguage;

  /// Section title for font size slider
  ///
  /// In en, this message translates to:
  /// **'Accessibility'**
  String get settingsAccessibility;

  /// Label for font size option
  ///
  /// In en, this message translates to:
  /// **'Font size'**
  String get settingsFontSize;

  /// Snackbar prefix after font size change
  ///
  /// In en, this message translates to:
  /// **'Font size set to'**
  String get settingsFontSizeChanged;

  /// Label for theme toggle
  ///
  /// In en, this message translates to:
  /// **'Dark theme'**
  String get settingsTheme;

  /// Subtitle when dark mode on
  ///
  /// In en, this message translates to:
  /// **'Dark mode enabled'**
  String get settingsDarkTheme;

  /// Subtitle when dark mode off
  ///
  /// In en, this message translates to:
  /// **'Light mode enabled'**
  String get settingsLightTheme;

  /// Section title for biometric login
  ///
  /// In en, this message translates to:
  /// **'Security'**
  String get settingsSecurity;

  /// Label for biometric toggle
  ///
  /// In en, this message translates to:
  /// **'Use biometric login'**
  String get settingsBiometricLogin;

  /// Snackbar when device lacks biometrics
  ///
  /// In en, this message translates to:
  /// **'Biometrics not supported on this device.'**
  String get settingsBiometricNotSupported;

  /// Label on logout button
  ///
  /// In en, this message translates to:
  /// **'Log out'**
  String get settingsLogout;

  /// Dialog title asking for logout confirmation
  ///
  /// In en, this message translates to:
  /// **'Log out'**
  String get settingsLogoutConfirmation;

  /// Dialog body for logout confirmation
  ///
  /// In en, this message translates to:
  /// **'Are you sure you want to log out?'**
  String get settingsAreYouSureLogout;

  /// Dialog confirm button
  ///
  /// In en, this message translates to:
  /// **'Yes, log out'**
  String get settingsConfirmLogout;

  /// App-bar title and permission prompt heading
  ///
  /// In en, this message translates to:
  /// **'My Health Calendar'**
  String get calendarFullAccess;

  /// Snackbar text when user denies calendar permission
  ///
  /// In en, this message translates to:
  /// **'Calendar permission denied.'**
  String get calendarPermissionDenied;

  /// Message shown when permission not granted
  ///
  /// In en, this message translates to:
  /// **'Enable calendar permission in settings to view your events.'**
  String get calendarEnablePermissions;

  /// Button label to open system settings
  ///
  /// In en, this message translates to:
  /// **'Open settings'**
  String get openSettings;

  /// Section title for app permissions like calendar, camera, etc.
  ///
  /// In en, this message translates to:
  /// **'Permissions'**
  String get settingsPermissionsTitle;

  /// Label for calendar permission
  ///
  /// In en, this message translates to:
  /// **'Calendar Access'**
  String get settingsPermissionCalendar;

  /// Description of calendar permission use
  ///
  /// In en, this message translates to:
  /// **'Used to show appointments and investigations'**
  String get settingsPermissionCalendarDesc;

  /// Label for location permission
  ///
  /// In en, this message translates to:
  /// **'Location Access'**
  String get settingsPermissionLocation;

  /// Description of location permission use
  ///
  /// In en, this message translates to:
  /// **'Used for SOS and nearby hospital finder'**
  String get settingsPermissionLocationDesc;

  /// Label for camera permission
  ///
  /// In en, this message translates to:
  /// **'Camera Access'**
  String get settingsPermissionCamera;

  /// Description of camera permission use
  ///
  /// In en, this message translates to:
  /// **'Used to scan prescriptions and upload images'**
  String get settingsPermissionCameraDesc;

  /// Label for button that opens system settings for permission control
  ///
  /// In en, this message translates to:
  /// **'Manage'**
  String get settingsPermissionManage;

  /// Label showing permission is granted
  ///
  /// In en, this message translates to:
  /// **'Granted'**
  String get settingsPermissionGranted;

  /// Label showing permission is denied
  ///
  /// In en, this message translates to:
  /// **'Denied'**
  String get settingsPermissionDenied;

  /// Label for the dynamic theme colors option
  ///
  /// In en, this message translates to:
  /// **'Dynamic Theme Colors'**
  String get settingsDynamicColors;

  /// Description for the dynamic colors feature
  ///
  /// In en, this message translates to:
  /// **'Update app colors based on selected feature'**
  String get settingsDynamicColorsDesc;

  /// Label for the current accent color display
  ///
  /// In en, this message translates to:
  /// **'Current Accent Color'**
  String get settingsCurrentAccentColor;

  /// Description explaining where the accent color is applied from
  ///
  /// In en, this message translates to:
  /// **'Applied from circular dial'**
  String get settingsAccentColorDesc;

  /// Label for the option to reset theme settings
  ///
  /// In en, this message translates to:
  /// **'Reset Theme Settings'**
  String get settingsResetTheme;

  /// Description for the reset theme option
  ///
  /// In en, this message translates to:
  /// **'Restore default theme configuration'**
  String get settingsResetThemeDesc;

  /// Confirmation message shown when user taps the reset theme option
  ///
  /// In en, this message translates to:
  /// **'This will reset theme mode, font size, and dynamic colors to defaults.'**
  String get settingsResetThemeConfirm;

  /// Snackbar message shown after theme settings have been reset
  ///
  /// In en, this message translates to:
  /// **'Theme settings reset to defaults'**
  String get settingsThemeResetSuccess;

  /// Generic label for a reset button
  ///
  /// In en, this message translates to:
  /// **'Reset'**
  String get commonResetButton;

  /// Tooltip on refresh icon
  ///
  /// In en, this message translates to:
  /// **'Refresh events'**
  String get refreshCalendar;

  /// Snackbar when API fetch fails
  ///
  /// In en, this message translates to:
  /// **'Unable to load calendar events.'**
  String get calendarLoadFailed;

  /// Shown when no date is selected
  ///
  /// In en, this message translates to:
  /// **'Select a day to view events'**
  String get selectDayPrompt;

  /// Shown when selected day has no events
  ///
  /// In en, this message translates to:
  /// **'No events for this day'**
  String get noEventsForDay;

  /// Fallback title when event type/title missing
  ///
  /// In en, this message translates to:
  /// **'Unknown event'**
  String get unknownEvent;

  /// Readable name for appointment events
  ///
  /// In en, this message translates to:
  /// **'Appointment'**
  String get eventTypesAppointment;

  /// Readable name for investigation events
  ///
  /// In en, this message translates to:
  /// **'Investigation'**
  String get eventTypesInvestigation;

  /// Readable name for pharmacy events
  ///
  /// In en, this message translates to:
  /// **'Pharmacy order'**
  String get eventTypesPharmacyOrder;

  /// Label for phone text field when guest users ask a doubt
  ///
  /// In en, this message translates to:
  /// **'Phone number'**
  String get feedbackPhoneNumber;

  /// Label on the multi-line question field
  ///
  /// In en, this message translates to:
  /// **'Type your question here'**
  String get feedbackPlaceholder;

  /// Hint text inside the question input
  ///
  /// In en, this message translates to:
  /// **'Example: Should I continue my medication after surgery?'**
  String get feedbackHint;

  /// Validation message when question field is blank
  ///
  /// In en, this message translates to:
  /// **'Question cannot be empty.'**
  String get questionCannotBeEmpty;

  /// Generic submit button label
  ///
  /// In en, this message translates to:
  /// **'Submit'**
  String get submit;

  /// Snackbar after successful submission
  ///
  /// In en, this message translates to:
  /// **'Your question has been sent! Our team will reply soon.'**
  String get feedbackSuccess;

  /// Fallback error message when API call fails
  ///
  /// In en, this message translates to:
  /// **'Could not send your question. Please try again.'**
  String get feedbackFailed;

  /// App-bar title
  ///
  /// In en, this message translates to:
  /// **'Notifications'**
  String get notifications;

  /// Snackbar when backend returns error status
  ///
  /// In en, this message translates to:
  /// **'Unable to fetch notifications. Please pull to refresh.'**
  String get failedToFetchNotifications;

  /// Snackbar when request throws exception
  ///
  /// In en, this message translates to:
  /// **'Network error while fetching notifications.'**
  String get errorFetchingNotifications;

  /// Shown when notifications list is empty
  ///
  /// In en, this message translates to:
  /// **'You have no notifications.'**
  String get noNotifications;

  /// Snackbar after user swipes to mark read
  ///
  /// In en, this message translates to:
  /// **'Notification marked as read'**
  String get notificationMarkedAsRead;

  /// Fallback title when notification title missing
  ///
  /// In en, this message translates to:
  /// **'Notification'**
  String get notification;

  /// Shown when user refuses storage permission
  ///
  /// In en, this message translates to:
  /// **'Storage permission is required to download files.'**
  String get downloadPermissionDenied;

  /// No description provided for @yourHealthTabRecords.
  ///
  /// In en, this message translates to:
  /// **'Records'**
  String get yourHealthTabRecords;

  /// No description provided for @yourHealthTabConsultations.
  ///
  /// In en, this message translates to:
  /// **'Consultations'**
  String get yourHealthTabConsultations;

  /// No description provided for @yourHealthTabConsultationNotes.
  ///
  /// In en, this message translates to:
  /// **'Consultation notes'**
  String get yourHealthTabConsultationNotes;

  /// No description provided for @yourHealthTabSummary.
  ///
  /// In en, this message translates to:
  /// **'Summary'**
  String get yourHealthTabSummary;

  /// No description provided for @consultationDoctor.
  ///
  /// In en, this message translates to:
  /// **'Doctor'**
  String get consultationDoctor;

  /// No description provided for @consultationDiagnosis.
  ///
  /// In en, this message translates to:
  /// **'Diagnosis'**
  String get consultationDiagnosis;

  /// No description provided for @consultationNotes.
  ///
  /// In en, this message translates to:
  /// **'Notes'**
  String get consultationNotes;

  /// No description provided for @consultationDate.
  ///
  /// In en, this message translates to:
  /// **'Date'**
  String get consultationDate;

  /// No description provided for @consultationsEmpty.
  ///
  /// In en, this message translates to:
  /// **'No consultations found'**
  String get consultationsEmpty;

  /// No description provided for @consultationNotesEmptyTitle.
  ///
  /// In en, this message translates to:
  /// **'No consultation notes yet'**
  String get consultationNotesEmptyTitle;

  /// No description provided for @consultationNotesEmptySubtitle.
  ///
  /// In en, this message translates to:
  /// **'Signed appointment notes from your doctor will appear here after your visit.'**
  String get consultationNotesEmptySubtitle;

  /// No description provided for @consultationNotesLoadFailed.
  ///
  /// In en, this message translates to:
  /// **'Unable to load consultation notes.'**
  String get consultationNotesLoadFailed;

  /// No description provided for @consultationNotesDetailLoadFailed.
  ///
  /// In en, this message translates to:
  /// **'Unable to load this consultation note.'**
  String get consultationNotesDetailLoadFailed;

  /// No description provided for @consultationNotesUntitled.
  ///
  /// In en, this message translates to:
  /// **'Consultation note'**
  String get consultationNotesUntitled;

  /// No description provided for @consultationNotesUnknownRole.
  ///
  /// In en, this message translates to:
  /// **'Care team'**
  String get consultationNotesUnknownRole;

  /// No description provided for @consultationNotesDoctorRole.
  ///
  /// In en, this message translates to:
  /// **'Doctor role'**
  String get consultationNotesDoctorRole;

  /// No description provided for @consultationNotesType.
  ///
  /// In en, this message translates to:
  /// **'Type'**
  String get consultationNotesType;

  /// No description provided for @consultationNotesSignedAt.
  ///
  /// In en, this message translates to:
  /// **'Signed'**
  String get consultationNotesSignedAt;

  /// No description provided for @consultationNotesUpdatedAt.
  ///
  /// In en, this message translates to:
  /// **'Updated'**
  String get consultationNotesUpdatedAt;

  /// No description provided for @consultationNotesDetails.
  ///
  /// In en, this message translates to:
  /// **'Note details'**
  String get consultationNotesDetails;

  /// No description provided for @consultationNotesNoDetails.
  ///
  /// In en, this message translates to:
  /// **'No details were documented for this note.'**
  String get consultationNotesNoDetails;

  /// No description provided for @consultationNoteTypeOpConsultation.
  ///
  /// In en, this message translates to:
  /// **'OP consultation'**
  String get consultationNoteTypeOpConsultation;

  /// No description provided for @consultationNoteTypeConsultation.
  ///
  /// In en, this message translates to:
  /// **'Consultation'**
  String get consultationNoteTypeConsultation;

  /// No description provided for @consultationNoteTypeConsultationNote.
  ///
  /// In en, this message translates to:
  /// **'Consultation note'**
  String get consultationNoteTypeConsultationNote;

  /// No description provided for @consultationNoteTypeFollowUp.
  ///
  /// In en, this message translates to:
  /// **'Follow-up'**
  String get consultationNoteTypeFollowUp;

  /// No description provided for @consultationNoteTypeProgress.
  ///
  /// In en, this message translates to:
  /// **'Progress note'**
  String get consultationNoteTypeProgress;

  /// No description provided for @consultationNoteTypeSoap.
  ///
  /// In en, this message translates to:
  /// **'SOAP note'**
  String get consultationNoteTypeSoap;

  /// No description provided for @yourHealthHospitalRecordsTab.
  ///
  /// In en, this message translates to:
  /// **'Hospital records'**
  String get yourHealthHospitalRecordsTab;

  /// No description provided for @dischargeSummariesTab.
  ///
  /// In en, this message translates to:
  /// **'Discharge summaries'**
  String get dischargeSummariesTab;

  /// No description provided for @dischargeSummariesTitle.
  ///
  /// In en, this message translates to:
  /// **'Discharge summaries'**
  String get dischargeSummariesTitle;

  /// No description provided for @dischargeSummariesEmptyTitle.
  ///
  /// In en, this message translates to:
  /// **'No discharge summaries yet'**
  String get dischargeSummariesEmptyTitle;

  /// No description provided for @dischargeSummariesEmptySubtitle.
  ///
  /// In en, this message translates to:
  /// **'Signed discharge summaries from hospital admissions will appear here.'**
  String get dischargeSummariesEmptySubtitle;

  /// No description provided for @dischargeSummariesLoadFailed.
  ///
  /// In en, this message translates to:
  /// **'Unable to load discharge summaries.'**
  String get dischargeSummariesLoadFailed;

  /// No description provided for @dischargeSummaryDetailLoadFailed.
  ///
  /// In en, this message translates to:
  /// **'Unable to load this discharge summary.'**
  String get dischargeSummaryDetailLoadFailed;

  /// No description provided for @dischargeSummaryUntitled.
  ///
  /// In en, this message translates to:
  /// **'Discharge summary'**
  String get dischargeSummaryUntitled;

  /// No description provided for @dischargeSummaryPrimaryDiagnosis.
  ///
  /// In en, this message translates to:
  /// **'Diagnosis'**
  String get dischargeSummaryPrimaryDiagnosis;

  /// No description provided for @dischargeSummaryHospitalNumber.
  ///
  /// In en, this message translates to:
  /// **'Hospital no.'**
  String get dischargeSummaryHospitalNumber;

  /// No description provided for @dischargeSummaryAdmitted.
  ///
  /// In en, this message translates to:
  /// **'Admitted'**
  String get dischargeSummaryAdmitted;

  /// No description provided for @dischargeSummaryDischarged.
  ///
  /// In en, this message translates to:
  /// **'Discharged'**
  String get dischargeSummaryDischarged;

  /// No description provided for @dischargeSummaryWard.
  ///
  /// In en, this message translates to:
  /// **'Ward'**
  String get dischargeSummaryWard;

  /// No description provided for @dischargeSummarySignedBy.
  ///
  /// In en, this message translates to:
  /// **'Signed by'**
  String get dischargeSummarySignedBy;

  /// No description provided for @dischargeSummarySignedAt.
  ///
  /// In en, this message translates to:
  /// **'Signed'**
  String get dischargeSummarySignedAt;

  /// No description provided for @dischargeSummarySectionsTitle.
  ///
  /// In en, this message translates to:
  /// **'Summary sections'**
  String get dischargeSummarySectionsTitle;

  /// No description provided for @dischargeSummaryNoSections.
  ///
  /// In en, this message translates to:
  /// **'No discharge summary sections are available.'**
  String get dischargeSummaryNoSections;

  /// No description provided for @dischargeSummaryOpenPdf.
  ///
  /// In en, this message translates to:
  /// **'Open PDF'**
  String get dischargeSummaryOpenPdf;

  /// No description provided for @dischargeSummaryOpeningPdf.
  ///
  /// In en, this message translates to:
  /// **'Opening PDF...'**
  String get dischargeSummaryOpeningPdf;

  /// No description provided for @dischargeSummaryPdfOpenFailed.
  ///
  /// In en, this message translates to:
  /// **'Could not open the discharge summary PDF.'**
  String get dischargeSummaryPdfOpenFailed;

  /// No description provided for @dischargeSummariesOfficialHint.
  ///
  /// In en, this message translates to:
  /// **'Official signed summaries from your hospital stay are fetched separately.'**
  String get dischargeSummariesOfficialHint;

  /// No description provided for @labResultsTitle.
  ///
  /// In en, this message translates to:
  /// **'Lab results'**
  String get labResultsTitle;

  /// No description provided for @labResultsEmptyTitle.
  ///
  /// In en, this message translates to:
  /// **'No lab results yet'**
  String get labResultsEmptyTitle;

  /// No description provided for @labResultsEmptySubtitle.
  ///
  /// In en, this message translates to:
  /// **'Released lab results will appear here. Pull to refresh.'**
  String get labResultsEmptySubtitle;

  /// No description provided for @labResultsLoadFailed.
  ///
  /// In en, this message translates to:
  /// **'Unable to load lab results.'**
  String get labResultsLoadFailed;

  /// No description provided for @labResultDetailsTitle.
  ///
  /// In en, this message translates to:
  /// **'Lab result'**
  String get labResultDetailsTitle;

  /// No description provided for @labResultDetailLoadFailed.
  ///
  /// In en, this message translates to:
  /// **'Unable to load this lab result.'**
  String get labResultDetailLoadFailed;

  /// No description provided for @labResultValue.
  ///
  /// In en, this message translates to:
  /// **'Value'**
  String get labResultValue;

  /// No description provided for @labResultReference.
  ///
  /// In en, this message translates to:
  /// **'Reference'**
  String get labResultReference;

  /// No description provided for @labResultObserved.
  ///
  /// In en, this message translates to:
  /// **'Observed'**
  String get labResultObserved;

  /// No description provided for @labResultCode.
  ///
  /// In en, this message translates to:
  /// **'Test code'**
  String get labResultCode;

  /// No description provided for @labResultLoincCode.
  ///
  /// In en, this message translates to:
  /// **'LOINC code'**
  String get labResultLoincCode;

  /// No description provided for @labResultTrendTitle.
  ///
  /// In en, this message translates to:
  /// **'Trend'**
  String get labResultTrendTitle;

  /// No description provided for @labResultTrendLast.
  ///
  /// In en, this message translates to:
  /// **'Last'**
  String get labResultTrendLast;

  /// No description provided for @labResultTrendMonths.
  ///
  /// In en, this message translates to:
  /// **'months'**
  String get labResultTrendMonths;

  /// No description provided for @labResultTrendLatest.
  ///
  /// In en, this message translates to:
  /// **'Latest'**
  String get labResultTrendLatest;

  /// No description provided for @labResultTrendRange.
  ///
  /// In en, this message translates to:
  /// **'Range'**
  String get labResultTrendRange;

  /// No description provided for @labResultTrendPoints.
  ///
  /// In en, this message translates to:
  /// **'Points'**
  String get labResultTrendPoints;

  /// No description provided for @labResultTrendResultsLabel.
  ///
  /// In en, this message translates to:
  /// **'results'**
  String get labResultTrendResultsLabel;

  /// No description provided for @labResultTrendLoadFailed.
  ///
  /// In en, this message translates to:
  /// **'Unable to load this trend.'**
  String get labResultTrendLoadFailed;

  /// No description provided for @labResultTrendEmptyTitle.
  ///
  /// In en, this message translates to:
  /// **'Not enough trend data yet'**
  String get labResultTrendEmptyTitle;

  /// No description provided for @labResultTrendEmptySubtitle.
  ///
  /// In en, this message translates to:
  /// **'At least two released numeric results are needed to draw a trend.'**
  String get labResultTrendEmptySubtitle;

  /// No description provided for @labResultTrendUnavailable.
  ///
  /// In en, this message translates to:
  /// **'A trend is not available for this result because no test code is linked.'**
  String get labResultTrendUnavailable;

  /// No description provided for @summaryAllergies.
  ///
  /// In en, this message translates to:
  /// **'Allergies'**
  String get summaryAllergies;

  /// No description provided for @summaryConditions.
  ///
  /// In en, this message translates to:
  /// **'Conditions'**
  String get summaryConditions;

  /// No description provided for @summaryOverview.
  ///
  /// In en, this message translates to:
  /// **'Health Overview'**
  String get summaryOverview;

  /// No description provided for @summaryNoAllergies.
  ///
  /// In en, this message translates to:
  /// **'No known allergies'**
  String get summaryNoAllergies;

  /// No description provided for @summaryNoConditions.
  ///
  /// In en, this message translates to:
  /// **'No known conditions'**
  String get summaryNoConditions;

  /// No description provided for @summaryNoData.
  ///
  /// In en, this message translates to:
  /// **'No health summary available'**
  String get summaryNoData;

  /// No description provided for @investigationsResultsTitle.
  ///
  /// In en, this message translates to:
  /// **'Investigation Results'**
  String get investigationsResultsTitle;

  /// No description provided for @investigationsTabUpload.
  ///
  /// In en, this message translates to:
  /// **'Upload'**
  String get investigationsTabUpload;

  /// No description provided for @investigationsTabResults.
  ///
  /// In en, this message translates to:
  /// **'Results'**
  String get investigationsTabResults;

  /// No description provided for @investigationsStatusPending.
  ///
  /// In en, this message translates to:
  /// **'Pending'**
  String get investigationsStatusPending;

  /// No description provided for @investigationsStatusCompleted.
  ///
  /// In en, this message translates to:
  /// **'Completed'**
  String get investigationsStatusCompleted;

  /// No description provided for @investigationsNoResults.
  ///
  /// In en, this message translates to:
  /// **'No investigation results yet'**
  String get investigationsNoResults;

  /// No description provided for @investigationsDownloadReport.
  ///
  /// In en, this message translates to:
  /// **'Download Report'**
  String get investigationsDownloadReport;

  /// No description provided for @investigationsDownloadFailed.
  ///
  /// In en, this message translates to:
  /// **'Failed to download report'**
  String get investigationsDownloadFailed;

  /// No description provided for @investigationsFiles.
  ///
  /// In en, this message translates to:
  /// **'Files'**
  String get investigationsFiles;

  /// No description provided for @profileIncomplete.
  ///
  /// In en, this message translates to:
  /// **'Please complete your profile to continue'**
  String get profileIncomplete;

  /// No description provided for @vitalsTitle.
  ///
  /// In en, this message translates to:
  /// **'Vitals'**
  String get vitalsTitle;

  /// No description provided for @vitalsLogTab.
  ///
  /// In en, this message translates to:
  /// **'Log Vitals'**
  String get vitalsLogTab;

  /// No description provided for @vitalsHistoryTab.
  ///
  /// In en, this message translates to:
  /// **'History'**
  String get vitalsHistoryTab;

  /// No description provided for @vitalsLogHeading.
  ///
  /// In en, this message translates to:
  /// **'Log Your Daily Vitals'**
  String get vitalsLogHeading;

  /// No description provided for @vitalsLogSubheading.
  ///
  /// In en, this message translates to:
  /// **'Fill in any vitals you want to record today.'**
  String get vitalsLogSubheading;

  /// No description provided for @vitalsBloodPressure.
  ///
  /// In en, this message translates to:
  /// **'Blood Pressure'**
  String get vitalsBloodPressure;

  /// No description provided for @vitalsSystolic.
  ///
  /// In en, this message translates to:
  /// **'Systolic'**
  String get vitalsSystolic;

  /// No description provided for @vitalsDiastolic.
  ///
  /// In en, this message translates to:
  /// **'Diastolic'**
  String get vitalsDiastolic;

  /// No description provided for @vitalsHeartRate.
  ///
  /// In en, this message translates to:
  /// **'Heart Rate'**
  String get vitalsHeartRate;

  /// No description provided for @vitalsTemperature.
  ///
  /// In en, this message translates to:
  /// **'Temperature'**
  String get vitalsTemperature;

  /// No description provided for @vitalsBloodSugar.
  ///
  /// In en, this message translates to:
  /// **'Blood Sugar'**
  String get vitalsBloodSugar;

  /// No description provided for @vitalsWeight.
  ///
  /// In en, this message translates to:
  /// **'Weight'**
  String get vitalsWeight;

  /// No description provided for @vitalsSpO2.
  ///
  /// In en, this message translates to:
  /// **'SpO2'**
  String get vitalsSpO2;

  /// No description provided for @vitalsRecordButton.
  ///
  /// In en, this message translates to:
  /// **'Record Vitals'**
  String get vitalsRecordButton;

  /// No description provided for @vitalsSubmitting.
  ///
  /// In en, this message translates to:
  /// **'Submitting...'**
  String get vitalsSubmitting;

  /// No description provided for @vitalsRecordedSuccess.
  ///
  /// In en, this message translates to:
  /// **'Vitals recorded successfully'**
  String get vitalsRecordedSuccess;

  /// No description provided for @vitalsRecordFailed.
  ///
  /// In en, this message translates to:
  /// **'Failed to record vitals'**
  String get vitalsRecordFailed;

  /// No description provided for @vitalsAtLeastOne.
  ///
  /// In en, this message translates to:
  /// **'Please enter at least one vital sign'**
  String get vitalsAtLeastOne;

  /// No description provided for @vitalsNoHistory.
  ///
  /// In en, this message translates to:
  /// **'No vitals recorded yet'**
  String get vitalsNoHistory;

  /// No description provided for @vitalsNoHistoryHint.
  ///
  /// In en, this message translates to:
  /// **'Log your vitals using the Log Vitals tab.'**
  String get vitalsNoHistoryHint;

  /// No description provided for @vitalsHistoryFailed.
  ///
  /// In en, this message translates to:
  /// **'Failed to load vitals history'**
  String get vitalsHistoryFailed;

  /// No description provided for @familyTitle.
  ///
  /// In en, this message translates to:
  /// **'Family Members'**
  String get familyTitle;

  /// No description provided for @familyYourFamily.
  ///
  /// In en, this message translates to:
  /// **'Your Family'**
  String get familyYourFamily;

  /// No description provided for @familyManageHint.
  ///
  /// In en, this message translates to:
  /// **'Manage family members linked to your account.'**
  String get familyManageHint;

  /// No description provided for @familyNoMembers.
  ///
  /// In en, this message translates to:
  /// **'No family members yet'**
  String get familyNoMembers;

  /// No description provided for @familyNoMembersHint.
  ///
  /// In en, this message translates to:
  /// **'Add family members to manage shared care.'**
  String get familyNoMembersHint;

  /// No description provided for @familyAddMember.
  ///
  /// In en, this message translates to:
  /// **'Add Family Member'**
  String get familyAddMember;

  /// No description provided for @familyFullName.
  ///
  /// In en, this message translates to:
  /// **'Full Name'**
  String get familyFullName;

  /// No description provided for @familyPhone.
  ///
  /// In en, this message translates to:
  /// **'Phone Number'**
  String get familyPhone;

  /// No description provided for @familyRelationship.
  ///
  /// In en, this message translates to:
  /// **'Relationship'**
  String get familyRelationship;

  /// No description provided for @familyDateOfBirth.
  ///
  /// In en, this message translates to:
  /// **'Date of Birth (optional)'**
  String get familyDateOfBirth;

  /// No description provided for @familyAdding.
  ///
  /// In en, this message translates to:
  /// **'Adding...'**
  String get familyAdding;

  /// No description provided for @familyAddedSuccess.
  ///
  /// In en, this message translates to:
  /// **'Family member added successfully'**
  String get familyAddedSuccess;

  /// No description provided for @familyAddFailed.
  ///
  /// In en, this message translates to:
  /// **'Failed to add family member'**
  String get familyAddFailed;

  /// No description provided for @familyRemoveTitle.
  ///
  /// In en, this message translates to:
  /// **'Remove Family Member'**
  String get familyRemoveTitle;

  /// No description provided for @familyRemoveConfirm.
  ///
  /// In en, this message translates to:
  /// **'Are you sure you want to remove {name}?'**
  String familyRemoveConfirm(String name);

  /// No description provided for @familyRemoved.
  ///
  /// In en, this message translates to:
  /// **'{name} removed from family members'**
  String familyRemoved(String name);

  /// No description provided for @familyRemoveFailed.
  ///
  /// In en, this message translates to:
  /// **'Failed to remove member'**
  String get familyRemoveFailed;

  /// No description provided for @refillTitle.
  ///
  /// In en, this message translates to:
  /// **'Prescription Refills'**
  String get refillTitle;

  /// No description provided for @refillActivePrescriptions.
  ///
  /// In en, this message translates to:
  /// **'Active Prescriptions'**
  String get refillActivePrescriptions;

  /// No description provided for @refillHint.
  ///
  /// In en, this message translates to:
  /// **'Tap \"Request Refill\" to ask your doctor for a renewal.'**
  String get refillHint;

  /// No description provided for @refillNoActive.
  ///
  /// In en, this message translates to:
  /// **'No active prescriptions'**
  String get refillNoActive;

  /// No description provided for @refillNoActiveHint.
  ///
  /// In en, this message translates to:
  /// **'Your prescriptions from consultations will appear here.'**
  String get refillNoActiveHint;

  /// No description provided for @refillRequestButton.
  ///
  /// In en, this message translates to:
  /// **'Request Refill'**
  String get refillRequestButton;

  /// No description provided for @refillRequesting.
  ///
  /// In en, this message translates to:
  /// **'Requesting...'**
  String get refillRequesting;

  /// No description provided for @refillRetry.
  ///
  /// In en, this message translates to:
  /// **'Retry Refill Request'**
  String get refillRetry;

  /// No description provided for @refillConfirmTitle.
  ///
  /// In en, this message translates to:
  /// **'Request Refill'**
  String get refillConfirmTitle;

  /// No description provided for @refillConfirmBody.
  ///
  /// In en, this message translates to:
  /// **'Request a refill for {medication}?'**
  String refillConfirmBody(String medication);

  /// No description provided for @refillRequested.
  ///
  /// In en, this message translates to:
  /// **'Refill requested for {medication}'**
  String refillRequested(String medication);

  /// No description provided for @refillRequestFailed.
  ///
  /// In en, this message translates to:
  /// **'Failed to request refill'**
  String get refillRequestFailed;

  /// No description provided for @refillStatusActive.
  ///
  /// In en, this message translates to:
  /// **'ACTIVE'**
  String get refillStatusActive;

  /// No description provided for @refillStatusExpired.
  ///
  /// In en, this message translates to:
  /// **'EXPIRED'**
  String get refillStatusExpired;

  /// No description provided for @stepsTitle.
  ///
  /// In en, this message translates to:
  /// **'Step Challenge'**
  String get stepsTitle;

  /// No description provided for @stepsProfile.
  ///
  /// In en, this message translates to:
  /// **'Profile'**
  String get stepsProfile;

  /// No description provided for @stepsHistory.
  ///
  /// In en, this message translates to:
  /// **'History'**
  String get stepsHistory;

  /// No description provided for @stepsLeaderboard.
  ///
  /// In en, this message translates to:
  /// **'Leaderboard'**
  String get stepsLeaderboard;

  /// No description provided for @stepsRewards.
  ///
  /// In en, this message translates to:
  /// **'Rewards'**
  String get stepsRewards;

  /// No description provided for @stepsStartWalk.
  ///
  /// In en, this message translates to:
  /// **'Start Walk'**
  String get stepsStartWalk;

  /// No description provided for @stepsStopWalk.
  ///
  /// In en, this message translates to:
  /// **'Stop Walk'**
  String get stepsStopWalk;

  /// No description provided for @stepsSessionStarted.
  ///
  /// In en, this message translates to:
  /// **'Walk session started'**
  String get stepsSessionStarted;

  /// No description provided for @stepsSessionStopped.
  ///
  /// In en, this message translates to:
  /// **'Walk done!'**
  String get stepsSessionStopped;

  /// No description provided for @stepsNoHistory.
  ///
  /// In en, this message translates to:
  /// **'No walk sessions yet'**
  String get stepsNoHistory;

  /// No description provided for @stepsNoHistoryHint.
  ///
  /// In en, this message translates to:
  /// **'Start a walk to begin tracking your steps.'**
  String get stepsNoHistoryHint;

  /// No description provided for @abdmTitle.
  ///
  /// In en, this message translates to:
  /// **'ABDM (Ayushman Bharat)'**
  String get abdmTitle;

  /// No description provided for @abdmRegister.
  ///
  /// In en, this message translates to:
  /// **'Register ABHA'**
  String get abdmRegister;

  /// No description provided for @abdmVerify.
  ///
  /// In en, this message translates to:
  /// **'Verify ABHA'**
  String get abdmVerify;

  /// No description provided for @abdmConsents.
  ///
  /// In en, this message translates to:
  /// **'Consents'**
  String get abdmConsents;

  /// No description provided for @abdmNoConsents.
  ///
  /// In en, this message translates to:
  /// **'No consent requests'**
  String get abdmNoConsents;

  /// No description provided for @medicationRemindersTitle.
  ///
  /// In en, this message translates to:
  /// **'Medication Reminders'**
  String get medicationRemindersTitle;

  /// No description provided for @medicationReminderAdd.
  ///
  /// In en, this message translates to:
  /// **'Add Reminder'**
  String get medicationReminderAdd;

  /// No description provided for @medicationReminderName.
  ///
  /// In en, this message translates to:
  /// **'Medication Name'**
  String get medicationReminderName;

  /// No description provided for @medicationReminderDosage.
  ///
  /// In en, this message translates to:
  /// **'Dosage'**
  String get medicationReminderDosage;

  /// No description provided for @medicationReminderFrequency.
  ///
  /// In en, this message translates to:
  /// **'Frequency'**
  String get medicationReminderFrequency;

  /// No description provided for @medicationReminderNoReminders.
  ///
  /// In en, this message translates to:
  /// **'No medication reminders set'**
  String get medicationReminderNoReminders;

  /// No description provided for @updateAvailableTitle.
  ///
  /// In en, this message translates to:
  /// **'Update Available'**
  String get updateAvailableTitle;

  /// No description provided for @updateAvailableBody.
  ///
  /// In en, this message translates to:
  /// **'A new version of VH Health is available. Please update for the best experience.'**
  String get updateAvailableBody;

  /// No description provided for @updateNow.
  ///
  /// In en, this message translates to:
  /// **'Update Now'**
  String get updateNow;

  /// No description provided for @updateLater.
  ///
  /// In en, this message translates to:
  /// **'Later'**
  String get updateLater;

  /// AppBar title for the investigation booking screen
  ///
  /// In en, this message translates to:
  /// **'Book Investigation'**
  String get bookInvestigationTitle;

  /// Stepper label for choosing tests
  ///
  /// In en, this message translates to:
  /// **'Choose Tests'**
  String get bookInvestigationStepChoose;

  /// Stepper label for collection preference
  ///
  /// In en, this message translates to:
  /// **'Collection Preference'**
  String get bookInvestigationStepCollection;

  /// Stepper label for review and book
  ///
  /// In en, this message translates to:
  /// **'Review & Book'**
  String get bookInvestigationStepReview;

  /// Heading above the custom test input
  ///
  /// In en, this message translates to:
  /// **'Or type test names:'**
  String get bookInvestigationOrType;

  /// Heading above the slip upload buttons
  ///
  /// In en, this message translates to:
  /// **'Or upload prescription slip:'**
  String get bookInvestigationOrUploadSlip;

  /// Label for the estimated cost summary
  ///
  /// In en, this message translates to:
  /// **'Estimated Cost'**
  String get bookInvestigationEstimatedCost;

  /// Segmented button label for home collection
  ///
  /// In en, this message translates to:
  /// **'Home Collection'**
  String get bookInvestigationHomeCollection;

  /// Segmented button label for visiting the lab
  ///
  /// In en, this message translates to:
  /// **'Visit Lab'**
  String get bookInvestigationVisitLab;

  /// Subtitle for date tile when no date picked
  ///
  /// In en, this message translates to:
  /// **'Tap to select'**
  String get bookInvestigationTapToSelect;

  /// Heading above time-slot chips
  ///
  /// In en, this message translates to:
  /// **'Preferred Time Slot'**
  String get bookInvestigationPreferredTimeSlot;

  /// Title above review summary
  ///
  /// In en, this message translates to:
  /// **'Review Your Booking'**
  String get bookInvestigationReviewBooking;

  /// Heading above selected tests list
  ///
  /// In en, this message translates to:
  /// **'Selected Tests:'**
  String get bookInvestigationSelectedTests;

  /// Heading above custom tests text
  ///
  /// In en, this message translates to:
  /// **'Custom Tests:'**
  String get bookInvestigationCustomTests;

  /// Indicator that prescription slip was attached
  ///
  /// In en, this message translates to:
  /// **'Prescription slip attached'**
  String get bookInvestigationSlipAttached;

  /// Success heading after booking
  ///
  /// In en, this message translates to:
  /// **'Test Booked!'**
  String get bookInvestigationBooked;

  /// Success body text after booking
  ///
  /// In en, this message translates to:
  /// **'You will receive a confirmation call shortly.\nWe\'ll keep you updated on your booking status.'**
  String get bookInvestigationConfirmationNote;

  /// Button to return to investigations from success screen
  ///
  /// In en, this message translates to:
  /// **'Back to Tests & Reports'**
  String get bookInvestigationBackButton;

  /// Heading on step challenge profile setup card
  ///
  /// In en, this message translates to:
  /// **'Set up your profile'**
  String get stepsSetupProfileTitle;

  /// Label above color picker on profile setup
  ///
  /// In en, this message translates to:
  /// **'Pick a color:'**
  String get stepsPickColor;

  /// Button label to save step challenge profile
  ///
  /// In en, this message translates to:
  /// **'Save Profile'**
  String get stepsSaveProfile;

  /// Button label to begin a walk session (uppercase)
  ///
  /// In en, this message translates to:
  /// **'START WALK'**
  String get stepsStartWalkUpper;

  /// Indicator during active walk
  ///
  /// In en, this message translates to:
  /// **'Walk in progress…'**
  String get stepsWalkInProgress;

  /// Button label to stop a walk session (uppercase)
  ///
  /// In en, this message translates to:
  /// **'STOP WALK'**
  String get stepsStopWalkUpper;

  /// Empty state for daily steps chart
  ///
  /// In en, this message translates to:
  /// **'No daily data yet'**
  String get stepsNoDailyData;

  /// Empty state for weekly steps chart
  ///
  /// In en, this message translates to:
  /// **'No weekly data yet'**
  String get stepsNoWeeklyData;

  /// Empty state for monthly steps chart
  ///
  /// In en, this message translates to:
  /// **'No monthly data yet'**
  String get stepsNoMonthlyData;

  /// Label for current month section
  ///
  /// In en, this message translates to:
  /// **'This month'**
  String get stepsThisMonth;

  /// Empty state for leaderboard
  ///
  /// In en, this message translates to:
  /// **'No leaderboard data yet'**
  String get stepsNoLeaderboardData;

  /// Section heading for user rewards
  ///
  /// In en, this message translates to:
  /// **'Your Rewards'**
  String get stepsYourRewards;

  /// Snackbar when member id missing during remove
  ///
  /// In en, this message translates to:
  /// **'Member ID not found'**
  String get familyMemberIdNotFound;

  /// Snackbar when remove member request fails (retryable)
  ///
  /// In en, this message translates to:
  /// **'Failed to remove member. Please try again.'**
  String get familyRemoveFailedRetry;

  /// Snackbar when add family member request fails (retryable)
  ///
  /// In en, this message translates to:
  /// **'Failed to add family member. Please try again.'**
  String get familyAddFailedRetry;

  /// Dialog action label to confirm removing a member
  ///
  /// In en, this message translates to:
  /// **'Remove'**
  String get familyRemoveButton;

  /// Tooltip for the remove member icon
  ///
  /// In en, this message translates to:
  /// **'Remove member'**
  String get familyRemoveTooltip;

  /// Button label to retry loading family members
  ///
  /// In en, this message translates to:
  /// **'Retry'**
  String get familyRetryButton;

  /// Submit button on add family member sheet
  ///
  /// In en, this message translates to:
  /// **'Add Member'**
  String get familyAddMemberShort;

  /// Hint inside the date of birth field
  ///
  /// In en, this message translates to:
  /// **'Tap to select'**
  String get familyTapToSelect;

  /// Prefix before formatted date of birth on member card
  ///
  /// In en, this message translates to:
  /// **'DOB:'**
  String get familyDobPrefix;

  /// Validation when family member name empty
  ///
  /// In en, this message translates to:
  /// **'Name is required'**
  String get familyNameRequired;

  /// Validation when family member phone empty
  ///
  /// In en, this message translates to:
  /// **'Phone is required'**
  String get familyPhoneRequired;

  /// Validation when family member phone invalid
  ///
  /// In en, this message translates to:
  /// **'Enter a valid phone number'**
  String get familyPhoneInvalid;

  /// Error state when family members fetch fails
  ///
  /// In en, this message translates to:
  /// **'Failed to load family members'**
  String get familyLoadFailed;

  /// Fallback name when family member name missing
  ///
  /// In en, this message translates to:
  /// **'Unknown'**
  String get familyUnknown;

  /// Snackbar when document URL is missing
  ///
  /// In en, this message translates to:
  /// **'Document URL not available'**
  String get recordsDocumentUrlMissing;

  /// Dialog title to confirm record deletion
  ///
  /// In en, this message translates to:
  /// **'Delete Record?'**
  String get recordsDeleteTitle;

  /// Prefix before record title in delete confirmation
  ///
  /// In en, this message translates to:
  /// **'Delete '**
  String get recordsDeletePrefix;

  /// Snackbar after record deleted
  ///
  /// In en, this message translates to:
  /// **'Record deleted'**
  String get recordsDeleted;

  /// Validation when file or title missing on upload
  ///
  /// In en, this message translates to:
  /// **'Please pick a file and enter a title'**
  String get recordsPickFileFirst;

  /// Snackbar after record uploaded
  ///
  /// In en, this message translates to:
  /// **'Record uploaded'**
  String get recordsUploaded;

  /// Button label to open upload record sheet
  ///
  /// In en, this message translates to:
  /// **'Upload Record'**
  String get recordsUploadButton;

  /// Empty-state body for hospital documents tab
  ///
  /// In en, this message translates to:
  /// **'Your prescriptions and reports from visits will appear here'**
  String get recordsHospitalEmpty;

  /// Empty-state subtitle for hospital documents tab
  ///
  /// In en, this message translates to:
  /// **'Hospital-issued documents will appear here after your visit.'**
  String get recordsHospitalEmptySubtitle;

  /// Empty-state hint for my uploads tab
  ///
  /// In en, this message translates to:
  /// **'Upload your previous prescriptions and reports to keep them in one place'**
  String get recordsUploadEmptyHint;

  /// Title of the upload record bottom sheet
  ///
  /// In en, this message translates to:
  /// **'Upload a Record'**
  String get recordsUploadSheetTitle;

  /// Heading on ABDM screen
  ///
  /// In en, this message translates to:
  /// **'Ayushman Bharat Health Account'**
  String get abdmHeading;

  /// Description paragraph on ABDM screen
  ///
  /// In en, this message translates to:
  /// **'ABHA (Ayushman Bharat Health Account) is a unique health ID that lets you store and share your health records digitally.'**
  String get abdmDescription;

  /// Reassurance about data privacy
  ///
  /// In en, this message translates to:
  /// **'Your data stays secure and is shared only with your consent.'**
  String get abdmDataSecurityNote;

  /// Label above the user's ABHA number
  ///
  /// In en, this message translates to:
  /// **'Your ABHA Number'**
  String get abdmYourNumber;

  /// Heading on verify ABHA screen
  ///
  /// In en, this message translates to:
  /// **'Verify Your ABHA'**
  String get abdmVerifyHeading;

  /// Instruction above OTP input on verify ABHA screen
  ///
  /// In en, this message translates to:
  /// **'Enter the OTP sent to your mobile number'**
  String get abdmEnterOtp;

  /// Empty state for medication reminders
  ///
  /// In en, this message translates to:
  /// **'No medication reminders yet'**
  String get medicationRemindersEmpty;

  /// Hint below empty state
  ///
  /// In en, this message translates to:
  /// **'Tap + to add one'**
  String get medicationRemindersEmptyHint;

  /// Validation when name/dosage empty
  ///
  /// In en, this message translates to:
  /// **'Medication name and dosage are required'**
  String get medicationReminderRequiredFields;

  /// Snackbar when reminder save fails
  ///
  /// In en, this message translates to:
  /// **'Unable to save reminder'**
  String get medicationReminderSaveFailed;

  /// Title of the add reminder bottom sheet
  ///
  /// In en, this message translates to:
  /// **'Add Medication Reminder'**
  String get medicationReminderAddSheetTitle;

  /// Heading for list of reminder times
  ///
  /// In en, this message translates to:
  /// **'Reminder Times'**
  String get medicationReminderTimes;

  /// Button to add another reminder time
  ///
  /// In en, this message translates to:
  /// **'Add time'**
  String get medicationReminderAddTime;

  /// Button to save reminder
  ///
  /// In en, this message translates to:
  /// **'Save Reminder'**
  String get medicationReminderSave;

  /// Action label to take a photo from camera
  ///
  /// In en, this message translates to:
  /// **'Take Photo'**
  String get pharmacyTakePhoto;

  /// Action label to pick from gallery
  ///
  /// In en, this message translates to:
  /// **'Choose from Gallery'**
  String get pharmacyChooseFromGallery;

  /// Success heading after pharmacy order
  ///
  /// In en, this message translates to:
  /// **'Order Placed!'**
  String get pharmacyOrderPlacedTitle;

  /// Success body after pharmacy order
  ///
  /// In en, this message translates to:
  /// **'Our pharmacist will review your prescription and confirm your order shortly.'**
  String get pharmacyOrderPlacedBody;

  /// Heading above pharmacy upload area
  ///
  /// In en, this message translates to:
  /// **'Upload Prescription'**
  String get pharmacyUploadHeading;

  /// Empty-state text inside upload card
  ///
  /// In en, this message translates to:
  /// **'Tap to upload prescription'**
  String get pharmacyTapToUpload;

  /// Subtitle below tap to upload
  ///
  /// In en, this message translates to:
  /// **'Camera or Gallery'**
  String get pharmacyCameraOrGallery;

  /// Heading above the description input
  ///
  /// In en, this message translates to:
  /// **'Or Describe Your Order'**
  String get pharmacyOrDescribe;

  /// Heading for delivery option chooser
  ///
  /// In en, this message translates to:
  /// **'Delivery Preference'**
  String get pharmacyDeliveryPreference;

  /// Snackbar when prescription id missing during refill
  ///
  /// In en, this message translates to:
  /// **'Prescription ID not found'**
  String get refillPrescriptionIdMissing;

  /// Snackbar when refill request fails (retryable)
  ///
  /// In en, this message translates to:
  /// **'Failed to request refill. Please try again.'**
  String get refillRequestRetry;

  /// Hint prefix before button name
  ///
  /// In en, this message translates to:
  /// **'Tap '**
  String get refillTapPrefix;

  /// Heading shown when a refill request is in flight
  ///
  /// In en, this message translates to:
  /// **'Refill Requested'**
  String get refillRequestedHeading;

  /// Heading above vitals trends chart
  ///
  /// In en, this message translates to:
  /// **'Trends vs Last Reading'**
  String get vitalsTrendsHeading;

  /// Snackbar when vitals record fails (retryable)
  ///
  /// In en, this message translates to:
  /// **'Failed to record vitals. Please try again.'**
  String get vitalsRecordFailedRetry;

  /// Empty state for prescriptions tab
  ///
  /// In en, this message translates to:
  /// **'No prescriptions yet'**
  String get yourHealthPrescriptionsEmpty;

  /// Empty state hint for prescriptions tab
  ///
  /// In en, this message translates to:
  /// **'Your doctor prescriptions will appear here'**
  String get yourHealthPrescriptionsEmptyHint;

  /// Heading for clinical notes section
  ///
  /// In en, this message translates to:
  /// **'Clinical Notes'**
  String get yourHealthClinicalNotes;

  /// Button to download a prescription PDF
  ///
  /// In en, this message translates to:
  /// **'Download PDF'**
  String get yourHealthDownloadPdf;

  /// Button to start a pharmacy order from a prescription
  ///
  /// In en, this message translates to:
  /// **'Order Medicines'**
  String get yourHealthOrderMedicines;

  /// Button to confirm a pharmacy order
  ///
  /// In en, this message translates to:
  /// **'Place Order'**
  String get yourHealthPlaceOrder;

  /// Heading for safety notes section
  ///
  /// In en, this message translates to:
  /// **'Safety notes'**
  String get yourHealthSafetyNotes;

  /// Label before clinician override note
  ///
  /// In en, this message translates to:
  /// **'Clinician override on file:'**
  String get yourHealthClinicianOverride;

  /// Tab label for accepted patient explanations in Your Health
  ///
  /// In en, this message translates to:
  /// **'Explanations'**
  String get yourHealthTabExplanations;

  /// App bar title for a patient explanation detail
  ///
  /// In en, this message translates to:
  /// **'Explanation'**
  String get yourHealthExplanationsDetailTitle;

  /// Label before the reviewed date on a patient explanation
  ///
  /// In en, this message translates to:
  /// **'Reviewed'**
  String get yourHealthExplanationsReviewedLabel;

  /// Section heading for explanation summary
  ///
  /// In en, this message translates to:
  /// **'Summary'**
  String get yourHealthExplanationsSummary;

  /// Section heading for explanation key points
  ///
  /// In en, this message translates to:
  /// **'Key points'**
  String get yourHealthExplanationsKeyPoints;

  /// Section heading for explanation next steps
  ///
  /// In en, this message translates to:
  /// **'Next steps'**
  String get yourHealthExplanationsNextSteps;

  /// Section heading for explanation urgent-care guidance
  ///
  /// In en, this message translates to:
  /// **'When to seek help'**
  String get yourHealthExplanationsWhenToSeekHelp;

  /// Heading for safety or review flag banner on explanation detail
  ///
  /// In en, this message translates to:
  /// **'Review flag'**
  String get yourHealthExplanationsSafetyTitle;

  /// Body text for safety or review flag banner on explanation detail
  ///
  /// In en, this message translates to:
  /// **'Your care team marked this explanation for extra attention. Follow the guidance below and contact the hospital if symptoms worsen.'**
  String get yourHealthExplanationsSafetyBody;

  /// Fallback text when an explanation section is empty
  ///
  /// In en, this message translates to:
  /// **'No details provided'**
  String get yourHealthExplanationsNoSummary;

  /// Error text when explanation detail loading fails
  ///
  /// In en, this message translates to:
  /// **'Could not load this explanation.'**
  String get yourHealthExplanationsLoadFailed;

  /// Retry button label for explanation detail
  ///
  /// In en, this message translates to:
  /// **'Retry'**
  String get yourHealthExplanationsRetry;

  /// Empty state for explanations tab if a visible tab refreshes to no data
  ///
  /// In en, this message translates to:
  /// **'No reviewed explanations yet'**
  String get yourHealthExplanationsEmpty;

  /// Dialog title to cancel an appointment
  ///
  /// In en, this message translates to:
  /// **'Cancel Appointment'**
  String get appointmentsCancel;

  /// Confirm button to cancel an appointment
  ///
  /// In en, this message translates to:
  /// **'Yes, Cancel'**
  String get appointmentsConfirmCancel;

  /// Sheet title for time slot picker
  ///
  /// In en, this message translates to:
  /// **'Select Time Slot'**
  String get appointmentsSelectTimeSlot;

  /// Message asking user to re-login when patient id missing
  ///
  /// In en, this message translates to:
  /// **'Please log out and log back in to view your appointments.'**
  String get appointmentsLogOutAndBack;

  /// Empty state for appointments list
  ///
  /// In en, this message translates to:
  /// **'No appointments yet'**
  String get appointmentsEmpty;

  /// Button label to book first appointment
  ///
  /// In en, this message translates to:
  /// **'Book one now'**
  String get appointmentsBookOneNow;

  /// Button to view prescription from appointment
  ///
  /// In en, this message translates to:
  /// **'View Prescription'**
  String get appointmentsViewPrescription;

  /// AppBar title for symptom checker
  ///
  /// In en, this message translates to:
  /// **'Symptom checker'**
  String get symptomCheckerTitle;

  /// Heading above symptom input
  ///
  /// In en, this message translates to:
  /// **'Describe what you\'re feeling'**
  String get symptomCheckerDescribePrompt;

  /// Section heading for red-flag symptoms
  ///
  /// In en, this message translates to:
  /// **'Red flags'**
  String get symptomCheckerRedFlags;

  /// Section heading for possible causes
  ///
  /// In en, this message translates to:
  /// **'Possible causes'**
  String get symptomCheckerPossibleCauses;

  /// Button to book an appointment from symptom checker
  ///
  /// In en, this message translates to:
  /// **'Book an appointment'**
  String get symptomCheckerBookAppointment;

  /// Footer disclaimer about AI triage
  ///
  /// In en, this message translates to:
  /// **'Triage output is AI-assisted and not a medical diagnosis. Always consult a qualified clinician.'**
  String get symptomCheckerDisclaimer;

  /// Snackbar when daily check-in save fails
  ///
  /// In en, this message translates to:
  /// **'Could not save check-in. Please try again.'**
  String get checkinSaveFailed;

  /// Sheet title for daily check-in
  ///
  /// In en, this message translates to:
  /// **'Daily Check-In'**
  String get checkinTitle;

  /// Mood prompt in check-in sheet
  ///
  /// In en, this message translates to:
  /// **'How are you feeling today?'**
  String get checkinHowFeeling;

  /// Heading for optional quick vitals
  ///
  /// In en, this message translates to:
  /// **'Quick vitals (optional)'**
  String get checkinQuickVitals;

  /// Submit button on check-in sheet
  ///
  /// In en, this message translates to:
  /// **'Save check-in  ·  +10 points'**
  String get checkinSaveButton;

  /// Snackbar after successful check-in
  ///
  /// In en, this message translates to:
  /// **'+10 health points added. See you tomorrow!'**
  String get checkinSavedToast;

  /// Section title for ABHA in settings
  ///
  /// In en, this message translates to:
  /// **'Health ID (ABHA)'**
  String get settingsHealthIdLabel;

  /// Subtitle under Health ID section
  ///
  /// In en, this message translates to:
  /// **'Ayushman Bharat Health Account'**
  String get settingsHealthIdSubtitle;

  /// Section title for wearables connection
  ///
  /// In en, this message translates to:
  /// **'Connect wearables'**
  String get settingsConnectWearables;

  /// Subtitle under wearables section
  ///
  /// In en, this message translates to:
  /// **'Sync steps, heart rate, SpO₂ from Apple Health / Google Health Connect'**
  String get settingsConnectWearablesSubtitle;

  /// Snackbar when health permissions denied
  ///
  /// In en, this message translates to:
  /// **'Health permissions were not granted'**
  String get settingsHealthPermissionsDenied;

  /// Snackbar while syncing health data
  ///
  /// In en, this message translates to:
  /// **'Syncing health data…'**
  String get settingsSyncingHealth;

  /// Heading on the OTP verification screen
  ///
  /// In en, this message translates to:
  /// **'Verify Your Phone Number'**
  String get otpVerifyPhoneHeading;

  /// Subheading prefix above phone number on OTP screen
  ///
  /// In en, this message translates to:
  /// **'Enter the 6-digit OTP sent to'**
  String get otpEnterDigits;

  /// Button label to verify OTP
  ///
  /// In en, this message translates to:
  /// **'Verify OTP'**
  String get otpVerifyButtonText;

  /// Status while OTP resend is in progress
  ///
  /// In en, this message translates to:
  /// **'Resending OTP...'**
  String get otpResendingOtp;

  /// Snackbar after OTP resend succeeds
  ///
  /// In en, this message translates to:
  /// **'OTP has been sent to your phone number'**
  String get otpSentSuccess;

  /// Dashboard widget title when no upcoming visit
  ///
  /// In en, this message translates to:
  /// **'Schedule your next visit'**
  String get dashboardScheduleNextVisit;

  /// Dashboard widget body when no upcoming visit
  ///
  /// In en, this message translates to:
  /// **'Stay on top of your health'**
  String get dashboardStayOnTop;

  /// Dashboard CTA to book an appointment
  ///
  /// In en, this message translates to:
  /// **'Book Now'**
  String get dashboardBookNow;

  /// Label for last visit date
  ///
  /// In en, this message translates to:
  /// **'Last visit'**
  String get dashboardLastVisit;

  /// Label for next visit date
  ///
  /// In en, this message translates to:
  /// **'Next visit'**
  String get dashboardNextVisit;

  /// Compact label for last visit
  ///
  /// In en, this message translates to:
  /// **'Last:'**
  String get dashboardLastVisitColon;

  /// Compact label for next visit
  ///
  /// In en, this message translates to:
  /// **'Next:'**
  String get dashboardNextVisitColon;

  /// Tooltip on theme toggle
  ///
  /// In en, this message translates to:
  /// **'Toggle theme'**
  String get dashboardToggleTheme;

  /// Tooltip on font size toggle
  ///
  /// In en, this message translates to:
  /// **'Toggle font size'**
  String get dashboardToggleFontSize;

  /// Dashboard widget title for health points
  ///
  /// In en, this message translates to:
  /// **'Health Points'**
  String get dashboardHealthPoints;

  /// Dashboard widget title for wellness score
  ///
  /// In en, this message translates to:
  /// **'Wellness Score'**
  String get dashboardWellnessScore;

  /// Title for last visit card
  ///
  /// In en, this message translates to:
  /// **'Last Visit'**
  String get dashboardLastVisitTitle;

  /// Title for next visit card
  ///
  /// In en, this message translates to:
  /// **'Next Visit'**
  String get dashboardNextVisitTitle;

  /// Snackbar when uploaded file exceeds size limit
  ///
  /// In en, this message translates to:
  /// **'File too large. Maximum size is 10 MB.'**
  String get investigationsFileTooLarge;

  /// Button label to view or download a report
  ///
  /// In en, this message translates to:
  /// **'View / Download Report'**
  String get investigationsViewDownloadReport;

  /// Button to navigate to book investigation
  ///
  /// In en, this message translates to:
  /// **'Book Investigation'**
  String get investigationsBookButton;

  /// Empty state for investigation files list
  ///
  /// In en, this message translates to:
  /// **'No files available'**
  String get investigationsNoFiles;

  /// Indicator on bookings list
  ///
  /// In en, this message translates to:
  /// **'Prescription slip attached'**
  String get myBookingsSlipAttached;

  /// Button to download investigation result
  ///
  /// In en, this message translates to:
  /// **'Download Result'**
  String get myBookingsDownloadResult;

  /// Label for order note section
  ///
  /// In en, this message translates to:
  /// **'Order Note'**
  String get pharmacyOrderNote;

  /// Label for delivery info section
  ///
  /// In en, this message translates to:
  /// **'Delivery Info'**
  String get pharmacyDeliveryInfo;

  /// Empty state for orders list
  ///
  /// In en, this message translates to:
  /// **'No orders yet'**
  String get pharmacyOrdersEmpty;

  /// Empty-state hint for orders list
  ///
  /// In en, this message translates to:
  /// **'Place your first order from the Order tab'**
  String get pharmacyOrdersEmptyHint;

  /// Status label when order cancelled
  ///
  /// In en, this message translates to:
  /// **'Order Cancelled'**
  String get pharmacyOrderCancelled;

  /// Heading shown when device fails attestation
  ///
  /// In en, this message translates to:
  /// **'Device not supported'**
  String get splashDeviceNotSupported;

  /// Body shown when device fails attestation
  ///
  /// In en, this message translates to:
  /// **'For your safety, VH Health cannot run on this device. Reason:'**
  String get splashDeviceNotSupportedBody;

  /// App name shown on splash screen
  ///
  /// In en, this message translates to:
  /// **'VH Health'**
  String get splashAppName;

  /// Splash hint to tap to continue
  ///
  /// In en, this message translates to:
  /// **'Tap anywhere to continue'**
  String get splashTapAnywhere;

  /// Dialog title after redeeming a reward
  ///
  /// In en, this message translates to:
  /// **'Reward Claimed!'**
  String get gamificationRewardClaimed;

  /// Label above voucher code
  ///
  /// In en, this message translates to:
  /// **'Your voucher code:'**
  String get gamificationVoucherCode;

  /// Snackbar after copying voucher code
  ///
  /// In en, this message translates to:
  /// **'Voucher code copied!'**
  String get gamificationVoucherCopied;

  /// Snackbar when share fails
  ///
  /// In en, this message translates to:
  /// **'Could not share right now'**
  String get gamificationCouldNotShare;

  /// Subtitle on share card
  ///
  /// In en, this message translates to:
  /// **'Share your progress with family and friends'**
  String get gamificationShareSubtitle;

  /// Error state for points summary
  ///
  /// In en, this message translates to:
  /// **'Could not load your points summary'**
  String get gamificationLoadFailed;

  /// Heading above earning rules
  ///
  /// In en, this message translates to:
  /// **'How to earn points'**
  String get gamificationHowToEarn;

  /// Empty state for rewards tab
  ///
  /// In en, this message translates to:
  /// **'Complete milestones to earn rewards!'**
  String get gamificationCompleteMilestones;

  /// Empty state for points history
  ///
  /// In en, this message translates to:
  /// **'No point history yet'**
  String get gamificationNoPointHistory;

  /// Empty state for milestones
  ///
  /// In en, this message translates to:
  /// **'No milestones available yet'**
  String get gamificationNoMilestones;

  /// Title on the step share card image
  ///
  /// In en, this message translates to:
  /// **'VH Health Step Challenge'**
  String get stepsShareCardTitle;

  /// Subtitle on the step share card image
  ///
  /// In en, this message translates to:
  /// **'Venkataeswara Hospitals, Chennai'**
  String get stepsShareCardSubtitle;

  /// Footer on the step share card image
  ///
  /// In en, this message translates to:
  /// **'VH Health App'**
  String get stepsShareCardFooter;

  /// Snackbar while opening a document
  ///
  /// In en, this message translates to:
  /// **'Opening document...'**
  String get documentOpening;

  /// Snackbar when document fails to open
  ///
  /// In en, this message translates to:
  /// **'Could not open document'**
  String get documentCouldNotOpen;

  /// Permission prompt: dismiss button
  ///
  /// In en, this message translates to:
  /// **'Not Now'**
  String get permissionsNotNow;

  /// Permission prompt: open settings button
  ///
  /// In en, this message translates to:
  /// **'Open Settings'**
  String get permissionsOpenSettings;

  /// Heading on feedback prompt
  ///
  /// In en, this message translates to:
  /// **'Rate your experience'**
  String get feedbackRateExperience;

  /// Button to submit feedback
  ///
  /// In en, this message translates to:
  /// **'Submit Feedback'**
  String get feedbackSubmitButton;

  /// AppBar title for feedback history
  ///
  /// In en, this message translates to:
  /// **'My Feedback'**
  String get feedbackHistoryTitle;

  /// Dialog title to confirm logout
  ///
  /// In en, this message translates to:
  /// **'Confirm Logout'**
  String get logoutConfirmTitle;

  /// Dialog body to confirm logout
  ///
  /// In en, this message translates to:
  /// **'Are you sure you want to logout?'**
  String get logoutConfirmBody;

  /// Hospital name heading on About Us
  ///
  /// In en, this message translates to:
  /// **'Venkataeswara Hospitals'**
  String get aboutHospitalName;

  /// Link to open hospital location in Google Maps
  ///
  /// In en, this message translates to:
  /// **'Tap to open in Google Maps →'**
  String get aboutOpenInMaps;

  /// Label for doctor consultation fee
  ///
  /// In en, this message translates to:
  /// **'Consultation Fee'**
  String get departmentsConsultationFee;

  /// Empty state for doctors in a department
  ///
  /// In en, this message translates to:
  /// **'No doctors available in this department'**
  String get departmentsNoDoctors;

  /// Empty state for circular feature dial
  ///
  /// In en, this message translates to:
  /// **'No features available'**
  String get circularDialNoFeatures;

  /// Label for user location on delivery map
  ///
  /// In en, this message translates to:
  /// **'Your Location'**
  String get deliveryYourLocation;

  /// Dev-only button to skip OTP
  ///
  /// In en, this message translates to:
  /// **'Dev login (skip OTP)'**
  String get authDevLoginSkipOtp;

  /// Status text while permission gate runs
  ///
  /// In en, this message translates to:
  /// **'Setting up...'**
  String get permissionGateSettingUp;

  /// Action button on Your Health screen to open upload sheet
  ///
  /// In en, this message translates to:
  /// **'Upload Record'**
  String get yourHealthUploadRecord;

  /// Heading for the care-plan next steps section in Your Health
  ///
  /// In en, this message translates to:
  /// **'What\'s next'**
  String get yourHealthWhatsNextTitle;

  /// Subtitle for the care-plan next steps section
  ///
  /// In en, this message translates to:
  /// **'Goals and follow-ups your care team marked for you.'**
  String get yourHealthWhatsNextSubtitle;

  /// Heading for active care-plan goals
  ///
  /// In en, this message translates to:
  /// **'Goals'**
  String get yourHealthWhatsNextGoals;

  /// Heading for care-plan follow-up plans
  ///
  /// In en, this message translates to:
  /// **'Follow-ups'**
  String get yourHealthWhatsNextFollowUps;

  /// Error text when care-plan next steps loading fails
  ///
  /// In en, this message translates to:
  /// **'Could not load your next steps.'**
  String get yourHealthWhatsNextLoadFailed;

  /// Retry button for the care-plan next steps section
  ///
  /// In en, this message translates to:
  /// **'Retry'**
  String get yourHealthWhatsNextRetry;

  /// Label before a care-plan name
  ///
  /// In en, this message translates to:
  /// **'Plan'**
  String get yourHealthWhatsNextPlan;

  /// Label before a care-plan goal target value
  ///
  /// In en, this message translates to:
  /// **'Target'**
  String get yourHealthWhatsNextTarget;

  /// Label before a care-plan goal current value
  ///
  /// In en, this message translates to:
  /// **'Current'**
  String get yourHealthWhatsNextCurrent;

  /// Label before a care-plan due date
  ///
  /// In en, this message translates to:
  /// **'Due'**
  String get yourHealthWhatsNextDue;

  /// Screen title for antenatal-care timeline
  ///
  /// In en, this message translates to:
  /// **'ANC Timeline'**
  String get ancTimelineTitle;

  /// Error title when ANC timeline loading fails
  ///
  /// In en, this message translates to:
  /// **'Could not load ANC timeline'**
  String get ancLoadFailed;

  /// Empty-state title when no pregnancy is linked
  ///
  /// In en, this message translates to:
  /// **'No active pregnancy on record'**
  String get ancNoActivePregnancyTitle;

  /// Empty-state subtitle when no pregnancy is linked
  ///
  /// In en, this message translates to:
  /// **'If you have started antenatal care, your doctor will register your pregnancy at your next visit.'**
  String get ancNoActivePregnancySubtitle;

  /// Prefix before expected delivery date
  ///
  /// In en, this message translates to:
  /// **'Due'**
  String get ancDuePrefix;

  /// Fallback when gestational age is unavailable
  ///
  /// In en, this message translates to:
  /// **'Gestational age unavailable'**
  String get ancGestationalAgeFallback;

  /// Label for high-risk pregnancy flag
  ///
  /// In en, this message translates to:
  /// **'High-risk pregnancy'**
  String get ancHighRiskPregnancy;

  /// Prefix before high-risk reasons
  ///
  /// In en, this message translates to:
  /// **'High-risk'**
  String get ancHighRiskPrefix;

  /// Prominent ANC safety heading for danger signs
  ///
  /// In en, this message translates to:
  /// **'Danger signs'**
  String get ancDangerSignsTitle;

  /// Heading for ANC self-care advice
  ///
  /// In en, this message translates to:
  /// **'ANC self-care'**
  String get ancSafetyGuidanceTitle;

  /// Subtitle under danger-sign safety guidance
  ///
  /// In en, this message translates to:
  /// **'Call the hospital or seek urgent care if any of these appear.'**
  String get ancSafetyGuidanceSubtitle;

  /// Prefix before trimester number
  ///
  /// In en, this message translates to:
  /// **'Trimester'**
  String get ancTrimesterPrefix;

  /// Shown when backend advice content is pending review
  ///
  /// In en, this message translates to:
  /// **'Clinical content pending review'**
  String get ancClinicalContentPending;

  /// Small note when ANC advice content is pending clinical review
  ///
  /// In en, this message translates to:
  /// **'Reviewed local-language guidance is pending clinical sign-off.'**
  String get ancContentPendingReview;

  /// Inline error when ANC advice loading fails
  ///
  /// In en, this message translates to:
  /// **'ANC safety guidance could not be loaded right now.'**
  String get ancAdviceLoadFailed;

  /// Heading for fetal kick counter card
  ///
  /// In en, this message translates to:
  /// **'Fetal kick counter'**
  String get ancFetalKickCounter;

  /// Prefix before last fetal kick log
  ///
  /// In en, this message translates to:
  /// **'Last saved'**
  String get ancLastSavedPrefix;

  /// Unit label for fetal kicks
  ///
  /// In en, this message translates to:
  /// **'kicks'**
  String get ancKicksUnit;

  /// Small connector before a date
  ///
  /// In en, this message translates to:
  /// **'on'**
  String get ancOnDatePrefix;

  /// Input label for fetal kick count
  ///
  /// In en, this message translates to:
  /// **'Kick count'**
  String get ancKickCountLabel;

  /// Input label for fetal kick observation window
  ///
  /// In en, this message translates to:
  /// **'Observation window (minutes)'**
  String get ancObservationWindowLabel;

  /// Input label for optional notes
  ///
  /// In en, this message translates to:
  /// **'Notes'**
  String get ancNotesLabel;

  /// Validation error for fetal kick count
  ///
  /// In en, this message translates to:
  /// **'Enter a kick count between 0 and 999'**
  String get ancKickCountValidation;

  /// Validation error for fetal kick observation window
  ///
  /// In en, this message translates to:
  /// **'Observation window must be 1-1440 minutes'**
  String get ancWindowValidation;

  /// Success message after saving fetal kicks
  ///
  /// In en, this message translates to:
  /// **'Kick count saved'**
  String get ancKickCountSaved;

  /// Error message when fetal kick save fails
  ///
  /// In en, this message translates to:
  /// **'Could not save kick count'**
  String get ancCouldNotSaveKickCount;

  /// Button label to save fetal kicks
  ///
  /// In en, this message translates to:
  /// **'Save kick count'**
  String get ancSaveKickCount;

  /// Button label while saving
  ///
  /// In en, this message translates to:
  /// **'Saving...'**
  String get ancSaving;

  /// Heading for maternity packages
  ///
  /// In en, this message translates to:
  /// **'Maternity packages'**
  String get ancMaternityPackages;

  /// Fallback name for maternity package
  ///
  /// In en, this message translates to:
  /// **'Maternity package'**
  String get ancPackageFallback;

  /// Fallback when package pricing is unavailable
  ///
  /// In en, this message translates to:
  /// **'Pricing under review'**
  String get ancPricingUnderReview;

  /// Suffix after duration count
  ///
  /// In en, this message translates to:
  /// **'days'**
  String get ancDaysSuffix;

  /// Heading for next ANC visit card
  ///
  /// In en, this message translates to:
  /// **'Next visit'**
  String get ancNextVisit;

  /// Fallback when next visit date is not set
  ///
  /// In en, this message translates to:
  /// **'To be scheduled'**
  String get ancToBeScheduled;

  /// Heading for completed ANC visits
  ///
  /// In en, this message translates to:
  /// **'Visits so far'**
  String get ancVisitsSoFar;

  /// Fallback visit title
  ///
  /// In en, this message translates to:
  /// **'Visit'**
  String get ancVisit;

  /// Prefix before ANC visit number
  ///
  /// In en, this message translates to:
  /// **'Visit #'**
  String get ancVisitNumberPrefix;

  /// Suffix after gestational age week count
  ///
  /// In en, this message translates to:
  /// **'weeks'**
  String get ancGaWeeksSuffix;

  /// Blood pressure label
  ///
  /// In en, this message translates to:
  /// **'BP'**
  String get ancBpLabel;

  /// Weight label
  ///
  /// In en, this message translates to:
  /// **'Weight'**
  String get ancWeightLabel;

  /// Fetal heart rate label
  ///
  /// In en, this message translates to:
  /// **'FHR'**
  String get ancFhrLabel;

  /// Fundal height label
  ///
  /// In en, this message translates to:
  /// **'Fundal ht.'**
  String get ancFundalHeightLabel;

  /// Hemoglobin label
  ///
  /// In en, this message translates to:
  /// **'Hb'**
  String get ancHbLabel;

  /// Urine albumin label
  ///
  /// In en, this message translates to:
  /// **'Urine albumin'**
  String get ancUrineAlbuminLabel;

  /// Heading for ANC supplements
  ///
  /// In en, this message translates to:
  /// **'Supplements'**
  String get ancSupplements;

  /// Prefix before supplement dose
  ///
  /// In en, this message translates to:
  /// **'Dose'**
  String get ancDosePrefix;

  /// Prefix before supplement frequency
  ///
  /// In en, this message translates to:
  /// **'Frequency'**
  String get ancFrequencyPrefix;

  /// Prefix before supplement start date
  ///
  /// In en, this message translates to:
  /// **'since'**
  String get ancSincePrefix;

  /// Prefix before supplement reminder times
  ///
  /// In en, this message translates to:
  /// **'Reminder times'**
  String get ancReminderTimesPrefix;

  /// Shown when supplement has no fixed dose time
  ///
  /// In en, this message translates to:
  /// **'No fixed reminder time'**
  String get ancNoFixedReminderTime;

  /// Supplement reminder enabled label
  ///
  /// In en, this message translates to:
  /// **'On'**
  String get ancReminderEnabledLabel;

  /// Supplement reminder disabled label
  ///
  /// In en, this message translates to:
  /// **'Off'**
  String get ancReminderDisabledLabel;

  /// Snackbar when supplement reminder is enabled
  ///
  /// In en, this message translates to:
  /// **'Supplement reminder turned on'**
  String get ancReminderOn;

  /// Snackbar when supplement reminder is disabled
  ///
  /// In en, this message translates to:
  /// **'Supplement reminder turned off'**
  String get ancReminderOff;

  /// Snackbar when supplement reminder toggle fails
  ///
  /// In en, this message translates to:
  /// **'Could not update supplement reminder'**
  String get ancReminderToggleFailed;

  /// Snackbar when backend toggle saved but local notification scheduling is unavailable
  ///
  /// In en, this message translates to:
  /// **'Reminder saved, but no fixed local notification could be scheduled.'**
  String get ancReminderScheduleFailed;

  /// ANC advice category label
  ///
  /// In en, this message translates to:
  /// **'Danger signs'**
  String get ancAdviceCategoryDangerSigns;

  /// ANC advice category label
  ///
  /// In en, this message translates to:
  /// **'Baby movements'**
  String get ancAdviceCategoryFetalMovement;

  /// ANC advice category label
  ///
  /// In en, this message translates to:
  /// **'Foods to avoid'**
  String get ancAdviceCategoryFoodsToAvoid;

  /// ANC advice category label
  ///
  /// In en, this message translates to:
  /// **'When to contact us'**
  String get ancAdviceCategoryWhenToContact;

  /// Supplement frequency label
  ///
  /// In en, this message translates to:
  /// **'Once daily'**
  String get ancFrequencyOnceDaily;

  /// Supplement frequency label
  ///
  /// In en, this message translates to:
  /// **'Twice daily'**
  String get ancFrequencyTwiceDaily;

  /// Supplement frequency label
  ///
  /// In en, this message translates to:
  /// **'Three times daily'**
  String get ancFrequencyThriceDaily;

  /// Supplement frequency label
  ///
  /// In en, this message translates to:
  /// **'Weekly'**
  String get ancFrequencyWeekly;

  /// Supplement frequency label
  ///
  /// In en, this message translates to:
  /// **'As needed'**
  String get ancFrequencyAsNeeded;
}

class _AppLocalizationsDelegate
    extends LocalizationsDelegate<AppLocalizations> {
  const _AppLocalizationsDelegate();

  @override
  Future<AppLocalizations> load(Locale locale) {
    return SynchronousFuture<AppLocalizations>(lookupAppLocalizations(locale));
  }

  @override
  bool isSupported(Locale locale) =>
      <String>['en', 'hi', 'ml', 'ta', 'te'].contains(locale.languageCode);

  @override
  bool shouldReload(_AppLocalizationsDelegate old) => false;
}

AppLocalizations lookupAppLocalizations(Locale locale) {
  // Lookup logic when only language code is specified.
  switch (locale.languageCode) {
    case 'en':
      return AppLocalizationsEn();
    case 'hi':
      return AppLocalizationsHi();
    case 'ml':
      return AppLocalizationsMl();
    case 'ta':
      return AppLocalizationsTa();
    case 'te':
      return AppLocalizationsTe();
  }

  throw FlutterError(
    'AppLocalizations.delegate failed to load unsupported locale "$locale". This is likely '
    'an issue with the localizations generation tool. Please file an issue '
    'on GitHub with a reproducible sample app and the gen-l10n configuration '
    'that was used.',
  );
}
