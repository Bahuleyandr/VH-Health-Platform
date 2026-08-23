// ignore: unused_import
import 'package:intl/intl.dart' as intl;

import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for English (`en`).
class AppLocalizationsEn extends AppLocalizations {
  AppLocalizationsEn([String locale = 'en']) : super(locale);

  @override
  String get authLoginTitle => 'Login to your account';

  @override
  String get authPhoneNumber => 'Phone number';

  @override
  String get authPhonePrefix => '+91 ';

  @override
  String get authPhoneValidationEmpty => 'Please enter your phone number';

  @override
  String get authPhoneValidationInvalid =>
      'Please enter a valid 10-digit phone number';

  @override
  String get authGetOtp => 'Get OTP';

  @override
  String get authSendingOtp => 'Sending OTP…';

  @override
  String get authMagicLinkSent => 'Magic link sent successfully';

  @override
  String get authMagicLinkFailed => 'Failed to send magic link';

  @override
  String get authMagicLinkError =>
      'Something went wrong while sending the magic link';

  @override
  String get authContinueAsGuest => 'Continue as Guest';

  @override
  String get authByContinuingYouAgree => 'By continuing, you agree to the';

  @override
  String get authTerms => 'Terms';

  @override
  String get authConditions => 'Conditions';

  @override
  String get authAnd => 'and';

  @override
  String get authPrivacyPolicy => 'Privacy Policy';

  @override
  String get authSosTooltip => 'Send SOS';

  @override
  String get authSosSending => 'Sending SOS alert…';

  @override
  String get authSosTriggered => 'SOS alert has been triggered!';

  @override
  String get authSosBackendFailed =>
      'Couldn\'t send the SOS alert to the hospital. Stay on the emergency call — the phone line is your backup.';

  @override
  String get authSosGuestSkipped =>
      'Emergency call opened. Sign in to also send an SOS alert to the hospital.';

  @override
  String get authGuestUserSOS => 'guest_user_sos';

  @override
  String get otpVerifyOtpTitle => 'Verify OTP';

  @override
  String get otpOtpSentTo => 'OTP sent to';

  @override
  String get otpEnterOtp => 'Enter OTP';

  @override
  String get otpPleaseEnterOtp => 'Please enter the OTP';

  @override
  String get otpOtpMustBe6Digits => 'OTP must be 6 digits';

  @override
  String get otpVerify => 'Verify';

  @override
  String get otpResendOtpIn => 'Resend OTP in';

  @override
  String get otpResendOtp => 'Resend OTP';

  @override
  String get otpErrorOccurred => 'An error occurred';

  @override
  String get otpLoginSuccessful => 'Login successful';

  @override
  String get otpLoginFailed => 'Login failed';

  @override
  String get otpFailed => 'Failed to verify OTP';

  @override
  String get otpInvalidOtp => 'Invalid OTP';

  @override
  String get otpOtpSessionExpired => 'OTP session expired';

  @override
  String get otpOtpResendFailed => 'Failed to resend OTP';

  @override
  String get otpOtpResentSuccessfully => 'OTP resent successfully';

  @override
  String get otpInvalidFirebaseToken => 'Invalid Firebase token';

  @override
  String get autoSignInSuccess => 'You have been signed in automatically!';

  @override
  String get commonTermsConditionsDisclaimerTitle =>
      'Terms, Conditions & Privacy';

  @override
  String get commonTermsOfUse => 'Terms of Use';

  @override
  String get commonConditions => 'Conditions';

  @override
  String get commonPrivacyPolicy => 'Privacy Policy';

  @override
  String get commonBackToLogin => 'Back to Login';

  @override
  String get backToDashboard => 'Back to Dashboard';

  @override
  String get termsBody =>
      'Welcome to VH Health. By accessing and using this mobile application, you agree to be bound by these Terms of Use.\n\n1. Purpose: VH Health is a mobile application designed to assist patients in managing their health records, appointments, prescriptions, investigations, and communication with the hospital.\n2. Eligibility: You must be at least 18 years old to use this app independently. Use by minors must be supervised by a guardian.\n3. Use of Services:\n   • You agree to provide accurate and complete information.\n   • You agree not to misuse or interfere with the app’s functionality or security.\n   • Any unlawful or prohibited use is strictly forbidden.\n4. Intellectual Property: All content within the app, including logos, text, images, and data, is the property of VH Health or its licensors and protected by applicable copyright and trademark laws.\n5. Modification: We reserve the right to modify or discontinue any feature or functionality at any time, with or without notice.\n6. Termination: VH Health may suspend or terminate access to any user found violating the Terms or engaging in misuse.';

  @override
  String get conditionsBody =>
      '1. **Medical Advice Disclaimer:**\n   • The app is intended for general informational purposes and convenience.\n   • It does not replace direct consultation with qualified healthcare professionals.\n   • Always consult your doctor or hospital staff for diagnosis and treatment.\n\n2. Emergency Use:\n   • This app is not intended for emergency medical assistance.\n   • In case of emergency, please call your local emergency number or go to the nearest hospital.\n\n3. Service Availability:\n   • We strive for consistent availability, but do not guarantee uninterrupted access.\n   • Technical issues, updates, or network failures may occasionally impact access.\n\n4. Data Accuracy:\n   • Information such as appointment schedules and reports are retrieved from hospital systems and may be subject to manual entry.\n   • VH Health is not liable for errors caused by incorrect data entry or third-party system issues.';

  @override
  String get privacyBody =>
      '1. **Information Collection:**\n   • We collect your name, phone number, UID, medical records, appointment data, and uploads.\n   • We may also collect device identifiers and usage analytics for improving app performance.\n\n2. Use of Information:\n   • Your information is used strictly for providing services within the app.\n   • We do not sell your data or use it for advertising purposes.\n\n3. Data Sharing:\n   • Your data may be shared with authorized hospital staff and medical professionals involved in your care.\n   • We may also disclose data if required by law or in case of legal obligations.\n\n4. Data Security:\n   • We use industry-standard security practices to protect your data.\n   • However, no system is 100% secure; use of the app is at your own risk.\n\n5. Your Rights:\n   • You may request access to your stored information or request corrections.\n   • You may also request deletion of your account by contacting the hospital administration.\n\n6. Data Retention:\n   • Your data will be retained as long as necessary for healthcare or legal purposes.';

  @override
  String get profileEditScreenTitle => 'Edit Profile';

  @override
  String get profileNameLabel => 'Full name';

  @override
  String get profileNameHint => 'Enter your full name';

  @override
  String get profileNameValidationRequired => 'Name is required';

  @override
  String get profileEmailLabel => 'Email address';

  @override
  String get profileEmailHint => 'example@domain.com';

  @override
  String get profileEmailValidationInvalid => 'Enter a valid email address';

  @override
  String get profileBirthdayLabel => 'Birthday';

  @override
  String get profileBirthdayHint => 'Select your birth date';

  @override
  String get profileSaveChangesButton => 'Save changes';

  @override
  String get profileUpdatedSuccessfully => 'Profile updated successfully';

  @override
  String get networkError => 'Network error. Please try again.';

  @override
  String get profileSetupTitle => 'Set up your profile';

  @override
  String get profileUploadProfilePic => 'Add photo';

  @override
  String get profileSetupSaved => 'Profile saved successfully';

  @override
  String get profileSetupSaveFailed => 'Unable to save profile';

  @override
  String get profileGenderLabel => 'Gender';

  @override
  String get profileGenderMale => 'Male';

  @override
  String get profileGenderFemale => 'Female';

  @override
  String get profileGenderOther => 'Other';

  @override
  String get profileGenderValidationRequired => 'Please select a gender';

  @override
  String get profileEmailHintOptional => 'Optional';

  @override
  String get profileBirthdaySelectLabel => 'Select birthday';

  @override
  String get profileBirthdayLabelShort => 'Birthday';

  @override
  String get profileAnniversarySelectLabel => 'Select anniversary';

  @override
  String get profileAnniversaryLabelShort => 'Anniversary';

  @override
  String get commonSkipButton => 'Skip';

  @override
  String get commonSubmitButton => 'Submit';

  @override
  String get commonCancelButton => 'Cancel';

  @override
  String get filesPickerError => 'Could not pick file. Please try again.';

  @override
  String get hello => 'Hello';

  @override
  String get changeLanguage => 'Change language';

  @override
  String get lastAppointment => 'Last appointment';

  @override
  String get upcomingAppointment => 'Upcoming appointment';

  @override
  String get notAvailable => 'N/A';

  @override
  String get yourHealth => 'Your Health';

  @override
  String get appointments => 'Appointments';

  @override
  String get pharmacy => 'Pharmacy';

  @override
  String get investigations => 'Tests & Reports';

  @override
  String get askDoubt => 'Ask a Doubt';

  @override
  String get triviaLabel => 'Trivia';

  @override
  String get departments => 'Departments';

  @override
  String get aboutUsLabel => 'About Us';

  @override
  String get yourHealthTitle => 'Your Health';

  @override
  String get yourHealthSortNewest => 'Sort: newest first';

  @override
  String get yourHealthSortOldest => 'Sort: oldest first';

  @override
  String get yourHealthFilterByType => 'Filter by type';

  @override
  String get yourHealthNoRecords => 'No records found';

  @override
  String get yourHealthUploaded => 'Uploaded';

  @override
  String get yourHealthLoginToView => 'Log in to access your medical records';

  @override
  String get recordsLoadFailed => 'Could not load records';

  @override
  String get recordsShowingOffline => 'Showing offline data';

  @override
  String get fileQuarantined => 'File is quarantined and cannot be downloaded';

  @override
  String get fileCouldNotOpen => 'Unable to open file';

  @override
  String get recordTypeAll => 'All';

  @override
  String get recordTypeConsultation => 'Consultation';

  @override
  String get recordTypeInvestigation => 'Investigation';

  @override
  String get recordTypeReport => 'Report';

  @override
  String get login => 'Login';

  @override
  String get requestAppointment => 'Request Appointment';

  @override
  String get enterYourPhone => 'Enter your phone number';

  @override
  String get enterValidPhone => 'Please enter a valid 10-digit phone number';

  @override
  String get chooseDepartmentOrDoctor => 'Select department';

  @override
  String get selectDoctorPlaceholder => 'Select doctor (optional)';

  @override
  String get selectDoctorAndDate => 'Please choose a department';

  @override
  String get submitRequest => 'Submit request';

  @override
  String get appointmentConfirmationNote =>
      'Appointment request received! We’ll confirm soon.';

  @override
  String get appointmentFailed => 'Failed to book appointment';

  @override
  String get genericError => 'Something went wrong. Please try again.';

  @override
  String get calendarSyncTitle => 'Add to Calendar?';

  @override
  String get calendarSyncPrompt =>
      'Do you want to add this appointment to your calendar?';

  @override
  String get yesAlways => 'Yes, always';

  @override
  String get no => 'No';

  @override
  String get calendarEventTitle => 'VH Health Appointment';

  @override
  String calendarEventDescription(Object doctor) {
    return 'Appointment with $doctor';
  }

  @override
  String get calendarEventLocation => 'VH Health Hospital';

  @override
  String get generalDoctor => 'the doctor';

  @override
  String get sosSent => 'SOS alert sent!';

  @override
  String get requestAppointmentPhoneNumber => 'Phone number';

  @override
  String get cardiology => 'Cardiology';

  @override
  String get neurology => 'Neurology';

  @override
  String get orthopedics => 'Orthopedics';

  @override
  String get dermatology => 'Dermatology';

  @override
  String get pediatrics => 'Pediatrics';

  @override
  String get general_medicine => 'General Medicine';

  @override
  String get pharmacyTitle => 'Order Medicines';

  @override
  String get pharmacyPermissionsRequired =>
      'Storage permission required to select files.';

  @override
  String get pharmacyFilePickerError =>
      'Could not pick the file. Please try again.';

  @override
  String get pharmacyFormAndFileRequired =>
      'Please complete the form and attach a prescription file.';

  @override
  String get pharmacyUploadFailed => 'Upload failed. Please try again.';

  @override
  String get pharmacySubmissionFailed => 'Order submission failed.';

  @override
  String get pharmacyConfirmationNote =>
      'Order placed! Our pharmacy will call to confirm.';

  @override
  String get pharmacyInfoBanner =>
      'Upload your doctor’s prescription (PDF or image) and delivery address.';

  @override
  String get pharmacyUploadPrescriptionButton => 'Upload prescription';

  @override
  String get fileSelected => 'Selected';

  @override
  String get fileClearSelection => 'Clear';

  @override
  String get pharmacyDeliveryAddressLabel => 'Delivery address';

  @override
  String get pharmacyDeliveryAddressHint =>
      'House / flat no., street, area, pin code…';

  @override
  String get pharmacyDeliveryAddressValidationRequired => 'Address is required';

  @override
  String get pharmacySubmitOrderButton => 'Submit order';

  @override
  String get pharmacyCallButton => 'Call pharmacy';

  @override
  String get pharmacyCallFailed => 'Could not launch dialer.';

  @override
  String get pharmacyPhoneNumberLabel => 'Phone number';

  @override
  String get pharmacyPhoneNumberHint => '10-digit mobile number';

  @override
  String get pharmacyPhoneNumberValidationInvalid =>
      'Enter a valid 10-digit phone number';

  @override
  String get investigationsTitle => 'Tests & Reports';

  @override
  String get investigationsTestNameLabel => 'Test name';

  @override
  String get investigationsTestNameHint => 'e.g. Complete blood count';

  @override
  String get investigationsTestNameValidationRequired =>
      'Test name is required';

  @override
  String get investigationsUploadFileButtonLabel => 'Upload doctor’s order';

  @override
  String get investigationsSubmitRequestButton => 'Submit request';

  @override
  String get investigationsViewReportsButton => 'View investigation reports';

  @override
  String get investigationsFormAndFileRequired =>
      'Please complete the form and attach a file.';

  @override
  String get investigationsConfirmationNote =>
      'Request sent! We’ll contact you to schedule.';

  @override
  String get investigationsFailed => 'Failed to submit request.';

  @override
  String get investigationsUploadFailed =>
      'File upload failed. Please try again.';

  @override
  String get investigationsPermissionsRequired =>
      'Storage permission required.';

  @override
  String get investigationsFilePickerError =>
      'Could not pick a file. Please try again.';

  @override
  String investigationsUploadNotAvailableForDependent(String name) {
    return 'Report uploads aren\'t available while viewing $name\'s profile. Switch back to your own profile to upload a report.';
  }

  @override
  String get triviaTitle => 'Health Trivia';

  @override
  String get triviaDidYouKnow => 'Did you know?';

  @override
  String get triviaNewTriviaButton => 'Show another fact';

  @override
  String get triviaFact1 =>
      'The human heart beats about 100,000 times per day.';

  @override
  String get triviaFact2 =>
      'Laughing 100 times is roughly equivalent to 15 minutes of exercise on a stationary bike.';

  @override
  String get triviaFact3 => 'Your nose can remember 50,000 different scents.';

  @override
  String get triviaFact4 =>
      'Bones are about five times stronger than steel of the same weight.';

  @override
  String get triviaFact5 =>
      'The average adult skin covers about 2 square meters.';

  @override
  String get triviaFact6 =>
      'Your stomach lining replaces itself every few days to avoid digesting itself.';

  @override
  String get triviaFact7 =>
      'The strongest muscle (by weight) is the masseter—the jaw muscle.';

  @override
  String get triviaFact8 =>
      'People are about 1 cm taller in the morning than at night.';

  @override
  String get triviaFact9 =>
      'Sweat itself is odorless; bacteria on skin produce body odor.';

  @override
  String get triviaFact10 => 'Humans share 50% of their DNA with bananas.';

  @override
  String get departmentsTitle => 'Hospital Departments';

  @override
  String get departmentsLoadFailed =>
      'Unable to load departments. Please pull down to retry.';

  @override
  String get departmentsNoneFound => 'No departments found.';

  @override
  String get departmentsUnknown => 'Unknown department';

  @override
  String get departmentsDoctor => 'Doctor';

  @override
  String get departmentsBook => 'Book';

  @override
  String get guestUser => 'Guest';

  @override
  String get aboutUsContent =>
      'Since our inception in 2003, Venkataeswara Hospitals has stood as a beacon of hope and healing in the heart of Chennai. Founded by the visionary cardiologist Dr. Thillai Vallal, we have transformed from a specialized cardiac care center into one of Chennai\'s most trusted multispecialty healthcare institutions, touching over a million lives with our commitment to compassionate care.\n\n## Our Mission: Prevention is Our Passion\nAt Venkataeswara Hospitals, we believe that the best treatment is prevention. Our primary mission extends beyond healing—we are dedicated to preventing the onset of lifestyle diseases through comprehensive screening, education, and personalized wellness programs. This proactive approach has helped thousands of patients avoid heart attacks, strokes, and other preventable conditions.\n\n## World-Class Facilities, Hometown Care\nOur 150-bed facility at Chamiers Road, Nandanam, combines cutting-edge technology with the warmth of personalized care. With over 100 distinguished doctors across multiple specialties and state-of-the-art infrastructure, we offer:\n\n- **Advanced Cardiac Care**: Over 100,000 successful cardiac procedures completed\n- **24/7 Emergency Services**: Round-the-clock trauma and critical care\n- **Comprehensive Specialties**: From cardiology to cosmetology, neurology to nephrology\n- **Modern ICU**: 25-bed closed ICU with 1:1 nurse-patient ratio and advanced monitoring systems\n- **Cutting-Edge Diagnostics**: MRI, CT scan, advanced pathology lab, and imaging facilities\n\n## Pioneering Medical Excellence\n### Latest Procedures & Technologies\n\n**Minimally Invasive Cardiac Interventions**\n- Advanced angioplasty techniques with drug-eluting stents\n- Transcatheter Aortic Valve Replacement (TAVR)\n- Leadless pacemaker implantation\n- 3D mapping for complex arrhythmia ablations\n- Intravascular ultrasound (IVUS) guided procedures\n\n**Robotic & Laparoscopic Surgery**\n- Robot-assisted surgeries for precise tumor removal\n- Single-incision laparoscopic procedures\n- Endoscopic spine surgeries with faster recovery\n- Laser-assisted surgeries for minimal scarring\n\n**Advanced Cancer Care**\n- Targeted therapy and immunotherapy protocols\n- Image-guided radiation therapy (IGRT)\n- CyberKnife radiosurgery for tumor treatment\n- Personalized cancer genomics testing\n- Pain-free chemotherapy delivery systems\n\n**Cutting-Edge Diagnostics**\n- 3 Tesla MRI for ultra-high resolution imaging\n- 256-slice CT scanner for cardiac and whole-body scans\n- PET-CT for early cancer detection\n- Advanced 4D ultrasound technology\n- AI-powered diagnostic interpretation systems\n\n**Innovative Treatment Approaches**\n- Stem cell therapy for cardiac regeneration\n- Platelet-rich plasma (PRP) therapy\n- Non-surgical body contouring and aesthetic procedures\n- Advanced wound healing with hyperbaric oxygen therapy\n- Integrated holistic healing combining Siddha and modern medicine\n\n## Recognition & Excellence\n- **Radio City Icon Award 2022** for Excellence in Heart Care\n- **NABH Accreditation** ensuring highest standards of patient care and safety\n- **4.7/5 Patient Satisfaction Rating** based on thousands of reviews\n- **Center of Excellence** designation in multiple specialties\n\n## Innovation in Healthcare Education\nBeyond patient care, we nurture the next generation of healthcare professionals through our Allied Health Sciences programs. Affiliated with The Tamil Nadu Dr. M.G.R. Medical University, we offer specialized courses in cardiac technology, critical care, and healthcare management.\n\n## Our Values, Your Trust\n**Kindness** – Every patient is family  \n**Excellence** – Pursuit of the highest medical standards  \n**Innovation** – Embracing advanced treatments and technologies  \n**Integrity** – Transparent, ethical healthcare delivery\n\n## Leadership That Inspires\nUnder the leadership of Dr. Thillai Vallal—an active member of the Cardiological Society of India, European Society of Cardiology, and Indian Medical Association—our hospital continues to pioneer integrated healthcare approaches, combining modern medicine with holistic wellness.\n\n## Your Health, Our Commitment\nFrom routine check-ups to complex surgeries, from preventive care to emergency interventions, Venkataeswara Hospitals stands ready to serve you 24/7. With cashless insurance facilities, affordable treatment options, and a patient-first approach, we ensure that quality healthcare remains accessible to all.\n\n**Visit us at:** \n36-A, Chamiers Road, Nandanam  \nChennai – 600035  \n(Near Devar Statue)\n\n*Where healing meets heart, and technology meets compassion—Welcome to Venkataeswara Hospitals, your partner in lifelong wellness.*';

  @override
  String get settingsTitle => 'Settings';

  @override
  String get settingsEditProfile => 'Edit profile';

  @override
  String get settingsLanguage => 'Language';

  @override
  String get settingsAccessibility => 'Accessibility';

  @override
  String get settingsFontSize => 'Font size';

  @override
  String get settingsFontSizeChanged => 'Font size set to';

  @override
  String get settingsTheme => 'Dark theme';

  @override
  String get settingsDarkTheme => 'Dark mode enabled';

  @override
  String get settingsLightTheme => 'Light mode enabled';

  @override
  String get settingsSecurity => 'Security';

  @override
  String get biometricGateReason => 'Unlock to view your medical records';

  @override
  String get biometricGateLockedTitle => 'Unlock required';

  @override
  String get biometricGateLockedMessage =>
      'Your health records are protected by your biometric lock. Confirm your identity to continue.';

  @override
  String get biometricGateUnlockButton => 'Unlock';

  @override
  String get settingsBiometricLogin => 'Use biometric login';

  @override
  String get settingsBiometricNotSupported =>
      'Biometrics not supported on this device.';

  @override
  String get settingsLogout => 'Log out';

  @override
  String get settingsLogoutConfirmation => 'Log out';

  @override
  String get settingsAreYouSureLogout => 'Are you sure you want to log out?';

  @override
  String get settingsConfirmLogout => 'Yes, log out';

  @override
  String get calendarFullAccess => 'My Health Calendar';

  @override
  String get calendarPermissionDenied => 'Calendar permission denied.';

  @override
  String get calendarEnablePermissions =>
      'Enable calendar permission in settings to view your events.';

  @override
  String get openSettings => 'Open settings';

  @override
  String get settingsPermissionsTitle => 'Permissions';

  @override
  String get settingsPermissionCalendar => 'Calendar Access';

  @override
  String get settingsPermissionCalendarDesc =>
      'Used to show appointments and investigations';

  @override
  String get settingsPermissionLocation => 'Location Access';

  @override
  String get settingsPermissionLocationDesc =>
      'Used for SOS and nearby hospital finder';

  @override
  String get settingsPermissionCamera => 'Camera Access';

  @override
  String get settingsPermissionCameraDesc =>
      'Used to scan prescriptions and upload images';

  @override
  String get settingsPermissionManage => 'Manage';

  @override
  String get settingsPermissionGranted => 'Granted';

  @override
  String get settingsPermissionDenied => 'Denied';

  @override
  String get settingsDynamicColors => 'Dynamic Theme Colors';

  @override
  String get settingsDynamicColorsDesc =>
      'Update app colors based on selected feature';

  @override
  String get settingsCurrentAccentColor => 'Current Accent Color';

  @override
  String get settingsAccentColorDesc => 'Applied from circular dial';

  @override
  String get settingsResetTheme => 'Reset Theme Settings';

  @override
  String get settingsResetThemeDesc => 'Restore default theme configuration';

  @override
  String get settingsResetThemeConfirm =>
      'This will reset theme mode, font size, and dynamic colors to defaults.';

  @override
  String get settingsThemeResetSuccess => 'Theme settings reset to defaults';

  @override
  String get commonResetButton => 'Reset';

  @override
  String get refreshCalendar => 'Refresh events';

  @override
  String get calendarLoadFailed => 'Unable to load calendar events.';

  @override
  String get selectDayPrompt => 'Select a day to view events';

  @override
  String get noEventsForDay => 'No events for this day';

  @override
  String get unknownEvent => 'Unknown event';

  @override
  String get eventTypesAppointment => 'Appointment';

  @override
  String get eventTypesInvestigation => 'Investigation';

  @override
  String get eventTypesPharmacyOrder => 'Pharmacy order';

  @override
  String get feedbackPhoneNumber => 'Phone number';

  @override
  String get feedbackPlaceholder => 'Type your question here';

  @override
  String get feedbackHint =>
      'Example: Should I continue my medication after surgery?';

  @override
  String get questionCannotBeEmpty => 'Question cannot be empty.';

  @override
  String get submit => 'Submit';

  @override
  String get feedbackSuccess =>
      'Your question has been sent! Our team will reply soon.';

  @override
  String get feedbackFailed =>
      'Could not send your question. Please try again.';

  @override
  String get notifications => 'Notifications';

  @override
  String get failedToFetchNotifications =>
      'Unable to fetch notifications. Please pull to refresh.';

  @override
  String get errorFetchingNotifications =>
      'Network error while fetching notifications.';

  @override
  String get noNotifications => 'You have no notifications.';

  @override
  String get notificationMarkedAsRead => 'Notification marked as read';

  @override
  String get notification => 'Notification';

  @override
  String get downloadPermissionDenied =>
      'Storage permission is required to download files.';

  @override
  String get yourHealthTabRecords => 'Records';

  @override
  String get yourHealthTabConsultations => 'Consultations';

  @override
  String get yourHealthTabConsultationNotes => 'Consultation notes';

  @override
  String get yourHealthTabSummary => 'Summary';

  @override
  String get consultationDoctor => 'Doctor';

  @override
  String get consultationDiagnosis => 'Diagnosis';

  @override
  String get consultationNotes => 'Notes';

  @override
  String get consultationDate => 'Date';

  @override
  String get consultationsEmpty => 'No consultations found';

  @override
  String get consultationNotesEmptyTitle => 'No consultation notes yet';

  @override
  String get consultationNotesEmptySubtitle =>
      'Signed appointment notes from your doctor will appear here after your visit.';

  @override
  String get consultationNotesLoadFailed =>
      'Unable to load consultation notes.';

  @override
  String get consultationNotesDetailLoadFailed =>
      'Unable to load this consultation note.';

  @override
  String get consultationNotesUntitled => 'Consultation note';

  @override
  String get consultationNotesUnknownRole => 'Care team';

  @override
  String get consultationNotesDoctorRole => 'Doctor role';

  @override
  String get consultationNotesType => 'Type';

  @override
  String get consultationNotesSignedAt => 'Signed';

  @override
  String get consultationNotesUpdatedAt => 'Updated';

  @override
  String get consultationNotesDetails => 'Note details';

  @override
  String get consultationNotesNoDetails =>
      'No details were documented for this note.';

  @override
  String get consultationNoteTypeOpConsultation => 'OP consultation';

  @override
  String get consultationNoteTypeConsultation => 'Consultation';

  @override
  String get consultationNoteTypeConsultationNote => 'Consultation note';

  @override
  String get consultationNoteTypeFollowUp => 'Follow-up';

  @override
  String get consultationNoteTypeProgress => 'Progress note';

  @override
  String get consultationNoteTypeSoap => 'SOAP note';

  @override
  String get yourHealthHospitalRecordsTab => 'Hospital records';

  @override
  String get dischargeSummariesTab => 'Discharge summaries';

  @override
  String get dischargeSummariesTitle => 'Discharge summaries';

  @override
  String get dischargeSummariesEmptyTitle => 'No discharge summaries yet';

  @override
  String get dischargeSummariesEmptySubtitle =>
      'Signed discharge summaries from hospital admissions will appear here.';

  @override
  String get dischargeSummariesLoadFailed =>
      'Unable to load discharge summaries.';

  @override
  String get dischargeSummaryDetailLoadFailed =>
      'Unable to load this discharge summary.';

  @override
  String get dischargeSummaryUntitled => 'Discharge summary';

  @override
  String get dischargeSummaryPrimaryDiagnosis => 'Diagnosis';

  @override
  String get dischargeSummaryHospitalNumber => 'Hospital no.';

  @override
  String get dischargeSummaryAdmitted => 'Admitted';

  @override
  String get dischargeSummaryDischarged => 'Discharged';

  @override
  String get dischargeSummaryWard => 'Ward';

  @override
  String get dischargeSummarySignedBy => 'Signed by';

  @override
  String get dischargeSummarySignedAt => 'Signed';

  @override
  String get dischargeSummarySectionsTitle => 'Summary sections';

  @override
  String get dischargeSummaryNoSections =>
      'No discharge summary sections are available.';

  @override
  String get dischargeSummaryOpenPdf => 'Open PDF';

  @override
  String get dischargeSummaryOpeningPdf => 'Opening PDF...';

  @override
  String get dischargeSummaryPdfOpenFailed =>
      'Could not open the discharge summary PDF.';

  @override
  String get dischargeSummaryPendingResultsTitle =>
      'Results pending at discharge';

  @override
  String get dischargeSummaryPendingResultsSubtitle =>
      'These results were pending when this signed summary was issued. The named clinician remains responsible for follow-up.';

  @override
  String get dischargeSummaryPendingResultClinician => 'Responsible clinician';

  @override
  String get dischargeSummariesOfficialHint =>
      'Official signed summaries from your hospital stay are fetched separately.';

  @override
  String get labResultsTitle => 'Lab results';

  @override
  String get labResultsEmptyTitle => 'No lab results yet';

  @override
  String get labResultsEmptySubtitle =>
      'Released lab results will appear here. Pull to refresh.';

  @override
  String get labResultsLoadFailed => 'Unable to load lab results.';

  @override
  String get labResultDetailsTitle => 'Lab result';

  @override
  String get labResultDetailLoadFailed => 'Unable to load this lab result.';

  @override
  String get labResultValue => 'Value';

  @override
  String get labResultReference => 'Reference';

  @override
  String get labResultObserved => 'Observed';

  @override
  String get labResultCode => 'Test code';

  @override
  String get labResultLoincCode => 'LOINC code';

  @override
  String get labResultTrendTitle => 'Trend';

  @override
  String get labResultTrendLast => 'Last';

  @override
  String get labResultTrendMonths => 'months';

  @override
  String get labResultTrendLatest => 'Latest';

  @override
  String get labResultTrendRange => 'Range';

  @override
  String get labResultTrendPoints => 'Points';

  @override
  String get labResultTrendResultsLabel => 'results';

  @override
  String get labResultTrendLoadFailed => 'Unable to load this trend.';

  @override
  String get labResultTrendEmptyTitle => 'Not enough trend data yet';

  @override
  String get labResultTrendEmptySubtitle =>
      'At least two released numeric results are needed to draw a trend.';

  @override
  String get labResultTrendUnavailable =>
      'A trend is not available for this result because no test code is linked.';

  @override
  String get diagnosticResultsTitle => 'Imaging and pathology reports';

  @override
  String get diagnosticResultsEmptyTitle => 'No released reports yet';

  @override
  String get diagnosticResultsEmptySubtitle =>
      'Clinician-signed reports released by your care team will appear here.';

  @override
  String get diagnosticResultsLoadFailed =>
      'Unable to load imaging and pathology reports.';

  @override
  String get diagnosticResultDetailsTitle => 'Diagnostic report';

  @override
  String get diagnosticResultDetailLoadFailed =>
      'Unable to load this diagnostic report.';

  @override
  String get diagnosticResultRadiology => 'Imaging report';

  @override
  String get diagnosticResultPathology => 'Pathology report';

  @override
  String get diagnosticResultAmended => 'Amended';

  @override
  String get diagnosticResultAddendum => 'Signed addendum';

  @override
  String get diagnosticResultAdvice =>
      'Please discuss this report with your doctor if you have questions about what it means for your care.';

  @override
  String get summaryAllergies => 'Allergies';

  @override
  String get summaryConditions => 'Conditions';

  @override
  String get summaryOverview => 'Health Overview';

  @override
  String get summaryNoAllergies => 'No known allergies';

  @override
  String get summaryNoConditions => 'No known conditions';

  @override
  String get summaryNoData => 'No health summary available';

  @override
  String get investigationsResultsTitle => 'Investigation Results';

  @override
  String get investigationsTabUpload => 'Upload';

  @override
  String get investigationsTabResults => 'Results';

  @override
  String get investigationsStatusPending => 'Pending';

  @override
  String get investigationsStatusCompleted => 'Completed';

  @override
  String get investigationsNoResults => 'No investigation results yet';

  @override
  String get investigationsDownloadReport => 'Download Report';

  @override
  String get investigationsDownloadFailed => 'Failed to download report';

  @override
  String get investigationsFiles => 'Files';

  @override
  String get profileIncomplete => 'Please complete your profile to continue';

  @override
  String get vitalsTitle => 'Vitals';

  @override
  String get vitalsLogTab => 'Log Vitals';

  @override
  String get vitalsHistoryTab => 'History';

  @override
  String get vitalsLogHeading => 'Log Your Daily Vitals';

  @override
  String get vitalsLogSubheading =>
      'Fill in any vitals you want to record today.';

  @override
  String get vitalsBloodPressure => 'Blood Pressure';

  @override
  String get vitalsSystolic => 'Systolic';

  @override
  String get vitalsDiastolic => 'Diastolic';

  @override
  String get vitalsHeartRate => 'Heart Rate';

  @override
  String get vitalsTemperature => 'Temperature';

  @override
  String get vitalsBloodSugar => 'Blood Sugar';

  @override
  String get vitalsWeight => 'Weight';

  @override
  String get vitalsSpO2 => 'SpO2';

  @override
  String get vitalsRecordButton => 'Record Vitals';

  @override
  String get vitalsSubmitting => 'Submitting...';

  @override
  String get vitalsRecordedSuccess => 'Vitals recorded successfully';

  @override
  String get vitalsRecordFailed => 'Failed to record vitals';

  @override
  String get vitalsAtLeastOne => 'Please enter at least one vital sign';

  @override
  String get vitalsNoHistory => 'No vitals recorded yet';

  @override
  String get vitalsNoHistoryHint => 'Log your vitals using the Log Vitals tab.';

  @override
  String get vitalsHistoryFailed =>
      'Unable to load vitals history. Please try again.';

  @override
  String get familyTitle => 'Family Members';

  @override
  String get familyYourFamily => 'Your Family';

  @override
  String get familyManageHint =>
      'Manage family members linked to your account.';

  @override
  String get familyNoMembers => 'No family members yet';

  @override
  String get familyNoMembersHint => 'Add family members to manage shared care.';

  @override
  String get familyAddMember => 'Add Family Member';

  @override
  String get familyFullName => 'Full Name';

  @override
  String get familyPhone => 'Phone Number';

  @override
  String get familyRelationship => 'Relationship';

  @override
  String get familyDateOfBirth => 'Date of Birth (optional)';

  @override
  String get familyAdding => 'Adding...';

  @override
  String get familyAddedSuccess => 'Family member added successfully';

  @override
  String get familyAddFailed => 'Failed to add family member';

  @override
  String get familyRemoveTitle => 'Remove Family Member';

  @override
  String familyRemoveConfirm(String name) {
    return 'Are you sure you want to remove $name?';
  }

  @override
  String familyRemoved(String name) {
    return '$name removed from family members';
  }

  @override
  String get familyRemoveFailed => 'Failed to remove member';

  @override
  String get refillTitle => 'Prescription Refills';

  @override
  String get refillActivePrescriptions => 'Active Prescriptions';

  @override
  String get refillHint =>
      'Tap \"Request Refill\" to ask your doctor for a renewal.';

  @override
  String get refillNoActive => 'No active prescriptions';

  @override
  String get refillNoActiveHint =>
      'Your prescriptions from consultations will appear here.';

  @override
  String get refillRequestButton => 'Request Refill';

  @override
  String get refillRequesting => 'Requesting...';

  @override
  String get refillRetry => 'Retry Refill Request';

  @override
  String get refillConfirmTitle => 'Request Refill';

  @override
  String refillConfirmBody(String medication) {
    return 'Request a refill for $medication?';
  }

  @override
  String refillRequested(String medication) {
    return 'Refill requested for $medication';
  }

  @override
  String get refillRequestFailed => 'Failed to request refill';

  @override
  String get refillStatusActive => 'ACTIVE';

  @override
  String get refillStatusExpired => 'EXPIRED';

  @override
  String get stepsTitle => 'Step Challenge';

  @override
  String get stepsProfile => 'Profile';

  @override
  String get stepsHistory => 'History';

  @override
  String get stepsLeaderboard => 'Leaderboard';

  @override
  String get stepsRewards => 'Rewards';

  @override
  String get stepsStartWalk => 'Start Walk';

  @override
  String get stepsStopWalk => 'Stop Walk';

  @override
  String get stepsSessionStarted => 'Walk session started';

  @override
  String get stepsSessionStopped => 'Walk done!';

  @override
  String get stepsNoHistory => 'No walk sessions yet';

  @override
  String get stepsNoHistoryHint => 'Start a walk to begin tracking your steps.';

  @override
  String get abdmTitle => 'ABDM (Ayushman Bharat)';

  @override
  String get abdmRegister => 'Register ABHA';

  @override
  String get abdmVerify => 'Verify ABHA';

  @override
  String get abdmConsents => 'Consents';

  @override
  String get abdmNoConsents => 'No consent requests';

  @override
  String get medicationRemindersTitle => 'Medication Reminders';

  @override
  String get medicationReminderAdd => 'Add Reminder';

  @override
  String get medicationReminderName => 'Medication Name';

  @override
  String get medicationReminderDosage => 'Dosage';

  @override
  String get medicationReminderFrequency => 'Frequency';

  @override
  String get medicationReminderNoReminders => 'No medication reminders set';

  @override
  String get updateAvailableTitle => 'Update Available';

  @override
  String get updateAvailableBody =>
      'A new version of VH Health is available. Please update for the best experience.';

  @override
  String get updateNow => 'Update Now';

  @override
  String get updateLater => 'Later';

  @override
  String get bookInvestigationTitle => 'Book Investigation';

  @override
  String get bookInvestigationStepChoose => 'Choose Tests';

  @override
  String get bookInvestigationStepCollection => 'Collection Preference';

  @override
  String get bookInvestigationStepReview => 'Review & Book';

  @override
  String get bookInvestigationOrType => 'Or type test names:';

  @override
  String get bookInvestigationOrUploadSlip => 'Or upload prescription slip:';

  @override
  String get bookInvestigationEstimatedCost => 'Estimated Cost';

  @override
  String get bookInvestigationHomeCollection => 'Home Collection';

  @override
  String get bookInvestigationVisitLab => 'Visit Lab';

  @override
  String get bookInvestigationTapToSelect => 'Tap to select';

  @override
  String get bookInvestigationPreferredTimeSlot => 'Preferred Time Slot';

  @override
  String get bookInvestigationReviewBooking => 'Review Your Booking';

  @override
  String get bookInvestigationSelectedTests => 'Selected Tests:';

  @override
  String get bookInvestigationCustomTests => 'Custom Tests:';

  @override
  String get bookInvestigationSlipAttached => 'Prescription slip attached';

  @override
  String get bookInvestigationBooked => 'Test Booked!';

  @override
  String get bookInvestigationConfirmationNote =>
      'You will receive a confirmation call shortly.\nWe\'ll keep you updated on your booking status.';

  @override
  String get bookInvestigationBackButton => 'Back to Tests & Reports';

  @override
  String get stepsSetupProfileTitle => 'Set up your profile';

  @override
  String get stepsPickColor => 'Pick a color:';

  @override
  String get stepsSaveProfile => 'Save Profile';

  @override
  String get stepsStartWalkUpper => 'START WALK';

  @override
  String get stepsWalkInProgress => 'Walk in progress…';

  @override
  String get stepsStopWalkUpper => 'STOP WALK';

  @override
  String get stepsNoDailyData => 'No daily data yet';

  @override
  String get stepsNoWeeklyData => 'No weekly data yet';

  @override
  String get stepsNoMonthlyData => 'No monthly data yet';

  @override
  String get stepsThisMonth => 'This month';

  @override
  String get stepsNoLeaderboardData => 'No leaderboard data yet';

  @override
  String get stepsYourRewards => 'Your Rewards';

  @override
  String get familyMemberIdNotFound => 'Member ID not found';

  @override
  String get familyRemoveFailedRetry =>
      'Failed to remove member. Please try again.';

  @override
  String get familyAddFailedRetry =>
      'Failed to add family member. Please try again.';

  @override
  String get familyRemoveButton => 'Remove';

  @override
  String get familyRemoveTooltip => 'Remove member';

  @override
  String get familyRetryButton => 'Retry';

  @override
  String get familyAddMemberShort => 'Add Member';

  @override
  String get familyTapToSelect => 'Tap to select';

  @override
  String get familyDobPrefix => 'DOB:';

  @override
  String get familyNameRequired => 'Name is required';

  @override
  String get familyPhoneRequired => 'Phone is required';

  @override
  String get familyPhoneInvalid => 'Enter a valid phone number';

  @override
  String get familyLoadFailed =>
      'Unable to load family members. Please try again.';

  @override
  String get familyUnknown => 'Unknown';

  @override
  String get recordsDocumentUrlMissing => 'Document URL not available';

  @override
  String get recordsDeleteTitle => 'Delete Record?';

  @override
  String get recordsDeletePrefix => 'Delete ';

  @override
  String get recordsDeleted => 'Record deleted';

  @override
  String get recordsPickFileFirst => 'Please pick a file and enter a title';

  @override
  String get recordsUploaded => 'Record uploaded';

  @override
  String get recordsUploadButton => 'Upload Record';

  @override
  String get recordsHospitalEmpty =>
      'Your prescriptions and reports from visits will appear here';

  @override
  String get recordsHospitalEmptySubtitle =>
      'Hospital-issued documents will appear here after your visit.';

  @override
  String get recordsUploadEmptyHint =>
      'Upload your previous prescriptions and reports to keep them in one place';

  @override
  String get recordsUploadSheetTitle => 'Upload a Record';

  @override
  String get abdmHeading => 'Ayushman Bharat Health Account';

  @override
  String get abdmDescription =>
      'ABHA (Ayushman Bharat Health Account) is a unique health ID that lets you store and share your health records digitally.';

  @override
  String get abdmDataSecurityNote =>
      'Your data stays secure and is shared only with your consent.';

  @override
  String get abdmYourNumber => 'Your ABHA Number';

  @override
  String get abdmVerifyHeading => 'Verify Your ABHA';

  @override
  String get abdmEnterOtp => 'Enter the OTP sent to your mobile number';

  @override
  String get medicationRemindersEmpty => 'No medication reminders yet';

  @override
  String get medicationRemindersEmptyHint => 'Tap + to add one';

  @override
  String get medicationReminderRequiredFields =>
      'Medication name and dosage are required';

  @override
  String get medicationReminderSaveFailed => 'Unable to save reminder';

  @override
  String get medicationReminderAddSheetTitle => 'Add Medication Reminder';

  @override
  String get medicationReminderTimes => 'Reminder Times';

  @override
  String get medicationReminderAddTime => 'Add time';

  @override
  String get medicationReminderSave => 'Save Reminder';

  @override
  String get pharmacyTakePhoto => 'Take Photo';

  @override
  String get pharmacyChooseFromGallery => 'Choose from Gallery';

  @override
  String get pharmacyOrderPlacedTitle => 'Order Placed!';

  @override
  String get pharmacyOrderPlacedBody =>
      'Our pharmacist will review your prescription and confirm your order shortly.';

  @override
  String get pharmacyUploadHeading => 'Upload Prescription';

  @override
  String get pharmacyTapToUpload => 'Tap to upload prescription';

  @override
  String get pharmacyCameraOrGallery => 'Camera or Gallery';

  @override
  String get pharmacyOrDescribe => 'Or Describe Your Order';

  @override
  String get pharmacyDeliveryPreference => 'Delivery Preference';

  @override
  String get refillPrescriptionIdMissing => 'Prescription ID not found';

  @override
  String get refillRequestRetry =>
      'Failed to request refill. Please try again.';

  @override
  String get refillTapPrefix => 'Tap ';

  @override
  String get refillRequestedHeading => 'Refill Requested';

  @override
  String get vitalsTrendsHeading => 'Trends vs Last Reading';

  @override
  String get vitalsRecordFailedRetry =>
      'Failed to record vitals. Please try again.';

  @override
  String get yourHealthPrescriptionsEmpty => 'No prescriptions yet';

  @override
  String get yourHealthPrescriptionsEmptyHint =>
      'Your doctor prescriptions will appear here';

  @override
  String get yourHealthClinicalNotes => 'Clinical Notes';

  @override
  String get yourHealthDownloadPdf => 'Download PDF';

  @override
  String get yourHealthOrderMedicines => 'Order Medicines';

  @override
  String get yourHealthPlaceOrder => 'Place Order';

  @override
  String get yourHealthSafetyNotes => 'Safety notes';

  @override
  String get yourHealthClinicianOverride => 'Clinician override on file:';

  @override
  String get yourHealthTabExplanations => 'Explanations';

  @override
  String get yourHealthExplanationsDetailTitle => 'Explanation';

  @override
  String get yourHealthExplanationsReviewedLabel => 'Reviewed';

  @override
  String get yourHealthExplanationsSummary => 'Summary';

  @override
  String get yourHealthExplanationsKeyPoints => 'Key points';

  @override
  String get yourHealthExplanationsNextSteps => 'Next steps';

  @override
  String get yourHealthExplanationsWhenToSeekHelp => 'When to seek help';

  @override
  String get yourHealthExplanationsSafetyTitle => 'Review flag';

  @override
  String get yourHealthExplanationsSafetyBody =>
      'Your care team marked this explanation for extra attention. Follow the guidance below and contact the hospital if symptoms worsen.';

  @override
  String get yourHealthExplanationsNoSummary => 'No details provided';

  @override
  String get yourHealthExplanationsLoadFailed =>
      'Could not load this explanation.';

  @override
  String get yourHealthExplanationsRetry => 'Retry';

  @override
  String get yourHealthExplanationsEmpty => 'No reviewed explanations yet';

  @override
  String get appointmentsCancel => 'Cancel Appointment';

  @override
  String get appointmentsConfirmCancel => 'Yes, Cancel';

  @override
  String get appointmentsSelectTimeSlot => 'Select Time Slot';

  @override
  String get appointmentsLogOutAndBack =>
      'Please log out and log back in to view your appointments.';

  @override
  String get appointmentsEmpty => 'No appointments yet';

  @override
  String get appointmentsBookOneNow => 'Book one now';

  @override
  String get appointmentsViewPrescription => 'View Prescription';

  @override
  String get symptomCheckerTitle => 'Symptom checker';

  @override
  String get symptomCheckerDescribePrompt => 'Describe what you\'re feeling';

  @override
  String get symptomCheckerRedFlags => 'Red flags';

  @override
  String get symptomCheckerPossibleCauses => 'Possible causes';

  @override
  String get symptomCheckerBookAppointment => 'Book an appointment';

  @override
  String get symptomCheckerDisclaimer =>
      'Triage output is AI-assisted and not a medical diagnosis. Always consult a qualified clinician.';

  @override
  String get checkinSaveFailed => 'Could not save check-in. Please try again.';

  @override
  String get checkinTitle => 'Daily Check-In';

  @override
  String get checkinHowFeeling => 'How are you feeling today?';

  @override
  String get checkinQuickVitals => 'Quick vitals (optional)';

  @override
  String get checkinSaveButton => 'Save check-in  ·  +10 points';

  @override
  String get checkinSavedToast => '+10 health points added. See you tomorrow!';

  @override
  String get settingsHealthIdLabel => 'Health ID (ABHA)';

  @override
  String get settingsHealthIdSubtitle => 'Ayushman Bharat Health Account';

  @override
  String get settingsConnectWearables => 'Connect wearables';

  @override
  String get settingsConnectWearablesSubtitle =>
      'Sync steps, heart rate, SpO₂ from Apple Health / Google Health Connect';

  @override
  String get settingsHealthPermissionsDenied =>
      'Health permissions were not granted';

  @override
  String get settingsSyncingHealth => 'Syncing health data…';

  @override
  String get otpVerifyPhoneHeading => 'Verify Your Phone Number';

  @override
  String get otpEnterDigits => 'Enter the 6-digit OTP sent to';

  @override
  String get otpVerifyButtonText => 'Verify OTP';

  @override
  String get otpResendingOtp => 'Resending OTP...';

  @override
  String get otpSentSuccess => 'OTP has been sent to your phone number';

  @override
  String get otpFieldSemanticLabel => '6-digit OTP code';

  @override
  String otpDigitsRemaining(num count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: 'Enter $count more digits',
      one: 'Enter 1 more digit',
    );
    return '$_temp0';
  }

  @override
  String get otpAllDigitsEntered => 'All 6 digits entered';

  @override
  String get otpVerifying => 'Verifying...';

  @override
  String get otpDidntReceiveResend => 'Didn\'t receive OTP? Resend';

  @override
  String get otpInvalidTryAgain => 'Invalid OTP. Please try again.';

  @override
  String get otpVerificationSessionExpired =>
      'Verification session expired. Please resend the OTP.';

  @override
  String get otpAutoFilled => 'OTP auto-filled';

  @override
  String get otpVerifiedSuccess => 'OTP verified';

  @override
  String get otpBackendLoginFailed =>
      'Phone verified, but hospital login failed. Please try again.';

  @override
  String get otpAuthenticationFailed =>
      'Authentication failed. Please try again.';

  @override
  String get dashboardScheduleNextVisit => 'Schedule your next visit';

  @override
  String get dashboardStayOnTop => 'Stay on top of your health';

  @override
  String get dashboardBookNow => 'Book Now';

  @override
  String get dashboardLastVisit => 'Last visit';

  @override
  String get dashboardNextVisit => 'Next visit';

  @override
  String get dashboardLastVisitColon => 'Last:';

  @override
  String get dashboardNextVisitColon => 'Next:';

  @override
  String get dashboardToggleTheme => 'Toggle theme';

  @override
  String get dashboardToggleFontSize => 'Toggle font size';

  @override
  String get dashboardHealthPoints => 'Health Points';

  @override
  String get dashboardWellnessScore => 'Wellness Score';

  @override
  String get dashboardLastVisitTitle => 'Last Visit';

  @override
  String get dashboardNextVisitTitle => 'Next Visit';

  @override
  String get investigationsFileTooLarge =>
      'File too large. Maximum size is 10 MB.';

  @override
  String get investigationsViewDownloadReport => 'View / Download Report';

  @override
  String get investigationsBookButton => 'Book Investigation';

  @override
  String get investigationsNoFiles => 'No files available';

  @override
  String get myBookingsSlipAttached => 'Prescription slip attached';

  @override
  String get myBookingsDownloadResult => 'Download Result';

  @override
  String get pharmacyOrderNote => 'Order Note';

  @override
  String get pharmacyDeliveryInfo => 'Delivery Info';

  @override
  String get pharmacyOrdersEmpty => 'No orders yet';

  @override
  String get pharmacyOrdersEmptyHint =>
      'Place your first order from the Order tab';

  @override
  String get pharmacyOrderCancelled => 'Order Cancelled';

  @override
  String get splashDeviceNotSupported => 'Device not supported';

  @override
  String get splashDeviceNotSupportedBody =>
      'For your safety, VH Health cannot run on this device. Reason:';

  @override
  String get splashAppName => 'VH Health';

  @override
  String get splashTapAnywhere => 'Tap anywhere to continue';

  @override
  String get gamificationRewardClaimed => 'Reward Claimed!';

  @override
  String get gamificationVoucherCode => 'Your voucher code:';

  @override
  String get gamificationVoucherCopied => 'Voucher code copied!';

  @override
  String get gamificationCouldNotShare => 'Could not share right now';

  @override
  String get gamificationShareSubtitle =>
      'Share your progress with family and friends';

  @override
  String get gamificationLoadFailed => 'Could not load your points summary';

  @override
  String get gamificationHowToEarn => 'How to earn points';

  @override
  String get gamificationCompleteMilestones =>
      'Complete milestones to earn rewards!';

  @override
  String get gamificationNoPointHistory => 'No point history yet';

  @override
  String get gamificationNoMilestones => 'No milestones available yet';

  @override
  String get stepsShareCardTitle => 'VH Health Step Challenge';

  @override
  String get stepsShareCardSubtitle => 'Venkataeswara Hospitals, Chennai';

  @override
  String get stepsShareCardFooter => 'VH Health App';

  @override
  String get documentOpening => 'Opening document...';

  @override
  String get documentCouldNotOpen => 'Could not open document';

  @override
  String get permissionsNotNow => 'Not Now';

  @override
  String get permissionsOpenSettings => 'Open Settings';

  @override
  String get feedbackRateExperience => 'Rate your experience';

  @override
  String get feedbackSubmitButton => 'Submit Feedback';

  @override
  String get feedbackHistoryTitle => 'My Feedback';

  @override
  String get logoutConfirmTitle => 'Confirm Logout';

  @override
  String get logoutConfirmBody => 'Are you sure you want to logout?';

  @override
  String get logoutProgressMessage => 'Signing out…';

  @override
  String get aboutHospitalName => 'Venkataeswara Hospitals';

  @override
  String get aboutOpenInMaps => 'Tap to open in Google Maps →';

  @override
  String get departmentsConsultationFee => 'Consultation Fee';

  @override
  String get departmentsNoDoctors => 'No doctors available in this department';

  @override
  String get circularDialNoFeatures => 'No features available';

  @override
  String get circularDialCenterLabel => 'Health Hub';

  @override
  String get circularDialCenterHint => 'Opens Health Points';

  @override
  String get deliveryYourLocation => 'Your Location';

  @override
  String get authDevLoginSkipOtp => 'Dev login (skip OTP)';

  @override
  String get permissionGateSettingUp => 'Setting up...';

  @override
  String get yourHealthUploadRecord => 'Upload record';

  @override
  String get yourHealthWhatsNextTitle => 'What\'s next';

  @override
  String get yourHealthWhatsNextSubtitle =>
      'Information and next steps your care team shared with you.';

  @override
  String get yourHealthWhatsNextGoals => 'Goals';

  @override
  String get yourHealthWhatsNextFollowUps => 'Follow-ups';

  @override
  String get yourHealthWhatsNextLoadFailed => 'Could not load your next steps.';

  @override
  String get yourHealthWhatsNextRetry => 'Retry';

  @override
  String get yourHealthWhatsNextPlan => 'Plan';

  @override
  String get yourHealthWhatsNextTarget => 'Target';

  @override
  String get yourHealthWhatsNextCurrent => 'Current';

  @override
  String get yourHealthWhatsNextDue => 'Due';

  @override
  String get yourHealthWhatsNextActions => 'Next steps';

  @override
  String get yourHealthWhatsNextStatus => 'Status';

  @override
  String get yourHealthWhatsNextResponsibleClinician => 'Responsible clinician';

  @override
  String get yourHealthWhatsNextContact => 'Contact';

  @override
  String get yourHealthWhatsNextPatientAction => 'What you can do';

  @override
  String get yourHealthWhatsNextStatusPlanned => 'Planned';

  @override
  String get yourHealthWhatsNextStatusOpen => 'Open';

  @override
  String get yourHealthWhatsNextStatusScheduled => 'Scheduled';

  @override
  String get yourHealthWhatsNextStatusPending => 'Pending';

  @override
  String get yourHealthWhatsNextStatusInProgress => 'In progress';

  @override
  String get yourHealthWhatsNextStatusReady => 'Ready';

  @override
  String get yourHealthWhatsNextStatusCompleted => 'Completed';

  @override
  String get yourHealthWhatsNextStatusCancelled => 'Cancelled';

  @override
  String get yourHealthWhatsNextStatusOnHold => 'On hold';

  @override
  String get yourHealthWhatsNextStatusOverdue => 'Overdue';

  @override
  String get ancTimelineTitle => 'ANC Timeline';

  @override
  String get ancLoadFailed => 'Could not load ANC timeline';

  @override
  String get ancNoActivePregnancyTitle => 'No active pregnancy on record';

  @override
  String get ancNoActivePregnancySubtitle =>
      'If you have started antenatal care, your doctor will register your pregnancy at your next visit.';

  @override
  String get ancDuePrefix => 'Due';

  @override
  String get ancGestationalAgeFallback => 'Gestational age unavailable';

  @override
  String get ancHighRiskPregnancy => 'High-risk pregnancy';

  @override
  String get ancHighRiskPrefix => 'High-risk';

  @override
  String get ancDangerSignsTitle => 'Danger signs';

  @override
  String get ancSafetyGuidanceTitle => 'ANC self-care';

  @override
  String get ancSafetyGuidanceSubtitle =>
      'Call the hospital or seek urgent care if any of these appear.';

  @override
  String get ancTrimesterPrefix => 'Trimester';

  @override
  String get ancClinicalContentPending => 'Clinical content pending review';

  @override
  String get ancContentPendingReview =>
      'Reviewed local-language guidance is pending clinical sign-off.';

  @override
  String get ancAdviceLoadFailed =>
      'ANC safety guidance could not be loaded right now.';

  @override
  String get ancFetalKickCounter => 'Fetal kick counter';

  @override
  String get ancLastSavedPrefix => 'Last saved';

  @override
  String get ancKicksUnit => 'kicks';

  @override
  String get ancOnDatePrefix => 'on';

  @override
  String get ancKickCountLabel => 'Kick count';

  @override
  String get ancObservationWindowLabel => 'Observation window (minutes)';

  @override
  String get ancNotesLabel => 'Notes';

  @override
  String get ancKickCountValidation => 'Enter a kick count between 0 and 999';

  @override
  String get ancWindowValidation => 'Observation window must be 1-1440 minutes';

  @override
  String get ancKickCountSaved => 'Kick count saved';

  @override
  String get ancCouldNotSaveKickCount => 'Could not save kick count';

  @override
  String get ancSaveKickCount => 'Save kick count';

  @override
  String get ancSaving => 'Saving...';

  @override
  String get ancMaternityPackages => 'Maternity packages';

  @override
  String get ancPackageFallback => 'Maternity package';

  @override
  String get ancPricingUnderReview => 'Pricing under review';

  @override
  String get ancDaysSuffix => 'days';

  @override
  String get ancNextVisit => 'Next visit';

  @override
  String get ancToBeScheduled => 'To be scheduled';

  @override
  String get ancVisitsSoFar => 'Visits so far';

  @override
  String get ancVisit => 'Visit';

  @override
  String get ancVisitNumberPrefix => 'Visit #';

  @override
  String get ancGaWeeksSuffix => 'weeks';

  @override
  String get ancBpLabel => 'BP';

  @override
  String get ancWeightLabel => 'Weight';

  @override
  String get ancFhrLabel => 'FHR';

  @override
  String get ancFundalHeightLabel => 'Fundal ht.';

  @override
  String get ancHbLabel => 'Hb';

  @override
  String get ancUrineAlbuminLabel => 'Urine albumin';

  @override
  String get ancSupplements => 'Supplements';

  @override
  String get ancDosePrefix => 'Dose';

  @override
  String get ancFrequencyPrefix => 'Frequency';

  @override
  String get ancSincePrefix => 'since';

  @override
  String get ancReminderTimesPrefix => 'Reminder times';

  @override
  String get ancNoFixedReminderTime => 'No fixed reminder time';

  @override
  String get ancReminderEnabledLabel => 'On';

  @override
  String get ancReminderDisabledLabel => 'Off';

  @override
  String get ancReminderOn => 'Supplement reminder turned on';

  @override
  String get ancReminderOff => 'Supplement reminder turned off';

  @override
  String get ancReminderToggleFailed => 'Could not update supplement reminder';

  @override
  String get ancReminderScheduleFailed =>
      'Reminder saved, but no fixed local notification could be scheduled.';

  @override
  String get ancAdviceCategoryDangerSigns => 'Danger signs';

  @override
  String get ancAdviceCategoryFetalMovement => 'Baby movements';

  @override
  String get ancAdviceCategoryFoodsToAvoid => 'Foods to avoid';

  @override
  String get ancAdviceCategoryWhenToContact => 'When to contact us';

  @override
  String get ancFrequencyOnceDaily => 'Once daily';

  @override
  String get ancFrequencyTwiceDaily => 'Twice daily';

  @override
  String get ancFrequencyThriceDaily => 'Three times daily';

  @override
  String get ancFrequencyWeekly => 'Weekly';

  @override
  String get ancFrequencyAsNeeded => 'As needed';

  @override
  String get recordAccessTitle => 'Record access';

  @override
  String get recordAccessSettingsSubtitle =>
      'Control who can see your released records';

  @override
  String get recordAccessLoadFailed => 'Could not load record access';

  @override
  String get recordAccessGrantButton => 'Grant access';

  @override
  String get recordAccessGrantConfirmTitle => 'Grant record access?';

  @override
  String get recordAccessGrantConfirmBody =>
      'This person will be able to view the selected released portal records until you revoke access or the grant expires.';

  @override
  String get recordAccessGrantSuccess => 'Record access granted';

  @override
  String get recordAccessGrantFailed => 'Could not grant record access';

  @override
  String get recordAccessRevokeConfirmTitle => 'Revoke access?';

  @override
  String get recordAccessRevokeConfirmBody =>
      'This stops future proxy access. It does not remove clinical or audit records already retained by the hospital.';

  @override
  String get recordAccessRevokeButton => 'Revoke';

  @override
  String get recordAccessRevokedByPatient => 'Revoked by patient in app';

  @override
  String get recordAccessRevokeSuccess => 'Record access revoked';

  @override
  String get recordAccessRevokeFailed => 'Could not revoke record access';

  @override
  String get recordAccessEmptyTitle => 'No record access grants';

  @override
  String get recordAccessEmptySubtitle =>
      'People you allow to view your released records will appear here.';

  @override
  String get recordAccessConsentTitle => 'You are in control';

  @override
  String get recordAccessConsentBody =>
      'Grant access only to someone you trust. They can view released portal records for the selected scope; in-hospital notes are never shared through the patient portal.';

  @override
  String get recordAccessGrantedByMeTitle => 'People who can see my records';

  @override
  String get recordAccessHeldByMeTitle => 'Records shared with me';

  @override
  String get recordAccessStatus => 'Status';

  @override
  String get recordAccessScope => 'Scope';

  @override
  String get recordAccessGranted => 'Granted';

  @override
  String get recordAccessExpires => 'Expires';

  @override
  String get recordAccessRevoked => 'Revoked';

  @override
  String get recordAccessGrantSheetTitle => 'Grant record access';

  @override
  String get recordAccessGrantSheetBody =>
      'Enter the proxy\'s patient UID exactly as issued by the hospital. Ask reception if you do not know it.';

  @override
  String get recordAccessProxyUidLabel => 'Proxy patient UID';

  @override
  String get recordAccessProxyUidHelper =>
      'Hospital-issued UUID for the person receiving access';

  @override
  String get recordAccessProxyUidRequired => 'Enter the proxy patient UID';

  @override
  String get recordAccessProxyUidInvalid => 'Enter a valid UUID';

  @override
  String get recordAccessRelationshipLabel => 'Relationship';

  @override
  String get recordAccessRelationshipHelper =>
      'Example: spouse, parent, caregiver';

  @override
  String get recordAccessRelationshipRequired => 'Enter the relationship';

  @override
  String get recordAccessScopeResults => 'Released results';

  @override
  String get recordAccessScopeResultsSubtitle =>
      'Lab results and released portal result records';

  @override
  String get recordAccessScopeClaimDocuments => 'Claim documents';

  @override
  String get recordAccessScopeClaimDocumentsSubtitle =>
      'Released insurance or claim-support documents';

  @override
  String get recordAccessConsentMethodLabel => 'Consent method';

  @override
  String get recordAccessConsentMethodOtp => 'OTP / app confirmation';

  @override
  String get recordAccessConsentMethodWritten => 'Written consent';

  @override
  String get recordAccessConsentMethodVerbal => 'Verbal consent documented';

  @override
  String get recordAccessConsentMethodGuardian => 'Guardian for minor';

  @override
  String get recordAccessSignatureLabel => 'Your signature';

  @override
  String get recordAccessSignatureHint => 'Sign inside this box';

  @override
  String get recordAccessSignatureClear => 'Clear';

  @override
  String get recordAccessSignatureRequired =>
      'Add your signature before continuing.';

  @override
  String get recordAccessContinueButton => 'Continue';

  @override
  String get recordAccessProxyFallback => 'Proxy';

  @override
  String get recordAccessStatusActive => 'Active';

  @override
  String get recordAccessStatusRevoked => 'Revoked';

  @override
  String get commonRetry => 'Retry';

  @override
  String get commonContinueButton => 'Continue';

  @override
  String get commonBackButton => 'Back';

  @override
  String get commonOkButton => 'OK';

  @override
  String get navigationHome => 'Home';

  @override
  String get notificationsTitle => 'Notifications';

  @override
  String get appointmentsBookTab => 'Book';

  @override
  String get appointmentsMyAppointmentsTab => 'My Appointments';

  @override
  String get pharmacyOrderTab => 'Order';

  @override
  String get pharmacyMyOrdersTab => 'My Orders';

  @override
  String get pharmacyFileTooLarge => 'File too large. Maximum size is 10 MB.';

  @override
  String get pharmacyPrescriptionOrDescriptionRequired =>
      'Please upload a prescription or describe your order';

  @override
  String pharmacyOrderPlacedToast(String orderNumber) {
    return 'Order placed! $orderNumber';
  }

  @override
  String pharmacyOrderNumber(String orderNumber) {
    return 'Order Number: $orderNumber';
  }

  @override
  String get pharmacyPlaceOrderFailed =>
      'Unable to place order. Please try again.';

  @override
  String pharmacyPlaceOrderError(String error) {
    return 'Error: $error';
  }

  @override
  String get billsTitle => 'Bills';

  @override
  String get billsLoadFailed =>
      'Unable to load bills. Please pull down to retry.';

  @override
  String get billsEmptyTitle => 'No bills yet';

  @override
  String get billsEmptySubtitle =>
      'Bills issued by the hospital will appear here. Pull to refresh.';

  @override
  String billsInvoiceFallback(int id) {
    return 'Invoice #$id';
  }

  @override
  String get billsTotal => 'Total';

  @override
  String get billsPaid => 'Paid';

  @override
  String get billsDue => 'Due';

  @override
  String get tpaClaimsTitle => 'Insurance claims';

  @override
  String get tpaClaimsLoadFailed =>
      'Unable to load insurance claims. Please pull down to retry.';

  @override
  String get tpaClaimsEmptyTitle => 'No insurance claims yet';

  @override
  String get tpaClaimFallback => 'Claim';

  @override
  String get tpaClaimClaimed => 'Claimed';

  @override
  String get tpaClaimApproved => 'Approved';

  @override
  String get tpaClaimPaidByInsurer => 'Paid by insurer';

  @override
  String get tpaClaimBreakdownTitle => 'Claim breakdown';

  @override
  String get tpaClaimNoData => 'No data';

  @override
  String get tpaClaimDocumentsLoadFailed => 'Could not load claim documents';

  @override
  String get tpaClaimLoadFailed =>
      'Unable to load claim. Please pull down to retry.';

  @override
  String get tpaClaimDocumentDownloadFailed => 'Could not download document';

  @override
  String get tpaClaimSummary => 'Summary';

  @override
  String get tpaClaimHospitalBilled => 'Hospital billed';

  @override
  String get tpaClaimTpaClaimed => 'TPA claimed';

  @override
  String get tpaClaimTpaApproved => 'TPA approved';

  @override
  String get tpaClaimTpaDisallowed => 'TPA disallowed';

  @override
  String get tpaClaimNonPayableItems => 'Non-payable items';

  @override
  String get tpaClaimPolicyCopay => 'Policy co-pay';

  @override
  String get tpaClaimYouPaid => 'You paid';

  @override
  String get tpaClaimDocuments => 'Claim documents';

  @override
  String get tpaClaimDocumentFallback => 'Document';

  @override
  String get tpaClaimDownloadTooltip => 'Download';

  @override
  String get tpaClaimLatestInsurerMessage => 'Latest insurer message';

  @override
  String get tpaClaimWhyDisallowed => 'Why an amount was disallowed';

  @override
  String get tpaClaimInvoiceBreakdown => 'Invoice breakdown';

  @override
  String get tpaClaimTotal => 'Total';

  @override
  String get tpaClaimCorrespondence => 'Correspondence';

  @override
  String get addDependentTitle => 'Add a dependent';

  @override
  String get addDependentHeading => 'Link a minor patient';

  @override
  String get addDependentIntro =>
      'Enter the phone number or VH Health UID of the minor patient. The minor must already be registered, typically at reception during their first visit.';

  @override
  String get addDependentIdentifierLabel => 'Phone number or UID';

  @override
  String get addDependentIdentifierHint =>
      '+91 9876543210 or a-uuid-from-reception';

  @override
  String get addDependentIdentifierRequired => 'Phone or UID is required';

  @override
  String get addDependentIdentifierInvalid =>
      'Enter a phone (10-15 digits) or a UID';

  @override
  String get addDependentRelationshipLabel => 'Your relationship to them';

  @override
  String get addDependentRelationshipParent => 'Parent';

  @override
  String get addDependentRelationshipMother => 'Mother';

  @override
  String get addDependentRelationshipFather => 'Father';

  @override
  String get addDependentRelationshipLegalGuardian => 'Legal guardian';

  @override
  String get addDependentRelationshipGrandparent => 'Grandparent';

  @override
  String get addDependentRelationshipSibling => 'Sibling';

  @override
  String get addDependentRelationshipSpouse => 'Spouse';

  @override
  String get addDependentRelationshipOther => 'Other';

  @override
  String get addDependentLinkedTitle => 'Dependent linked';

  @override
  String addDependentLinkedBody(String name) {
    return '$name is now linked under your account. Switch to their profile now?';
  }

  @override
  String get addDependentNotYetButton => 'Not yet';

  @override
  String get addDependentSwitchProfileButton => 'Switch profile';

  @override
  String addDependentLinkedToast(String name) {
    return 'Linked $name';
  }

  @override
  String get addDependentLinkFailed =>
      'Failed to link dependent. Please try again.';

  @override
  String get addDependentLinkingButton => 'Linking...';

  @override
  String get addDependentLinkButton => 'Link dependent';

  @override
  String get addDependentReceptionHint =>
      'Do not see the dependent? Ask reception to register them first. They need a VH Health UID before you can link them.';

  @override
  String get medicationFrequencyOnceDaily => 'Once Daily';

  @override
  String get medicationFrequencyTwiceDaily => 'Twice Daily';

  @override
  String get medicationFrequencyThriceDaily => 'Thrice Daily';

  @override
  String get medicationFrequencyAsNeeded => 'As Needed';

  @override
  String get medicationRemindersLoadFailed =>
      'Unable to load medication reminders. Please pull down to retry.';

  @override
  String get medicationRemindersRetryButton => 'Retry reminders';

  @override
  String get medicationReminderAncSupplement => 'ANC supplement';

  @override
  String get medicationReminderDeleteTooltip => 'Delete reminder';

  @override
  String get medicationReminderUpdateFailed => 'Unable to update reminder';

  @override
  String get medicationReminderDeleteFailed => 'Unable to delete reminder';

  @override
  String get medicationReminderPausedLabel => 'Paused';

  @override
  String medicationReminderDosageLine(String dosage) {
    return 'Dosage: $dosage';
  }

  @override
  String medicationReminderFrequencyLine(String frequency) {
    return 'Frequency: $frequency';
  }

  @override
  String medicationReminderTimesLine(String times) {
    return 'Times: $times';
  }

  @override
  String medicationReminderNotesLine(String notes) {
    return 'Notes: $notes';
  }

  @override
  String medicationReminderStartLine(String date) {
    return 'Start: $date';
  }

  @override
  String medicationReminderEndLine(String date) {
    return 'End: $date';
  }

  @override
  String get medicationReminderNoEndDate => 'End: No end date';

  @override
  String get medicationReminderNotesOptional => 'Notes (optional)';

  @override
  String get bookInvestigationSlotMorning => 'Morning (9 AM - 12 PM)';

  @override
  String get bookInvestigationSlotAfternoon => 'Afternoon (12 PM - 3 PM)';

  @override
  String get bookInvestigationSlotEvening => 'Evening (3 PM - 6 PM)';

  @override
  String get bookInvestigationBookingFailed => 'Booking failed';

  @override
  String get bookInvestigationBookingError =>
      'Unable to book the investigation. Please try again.';

  @override
  String get bookInvestigationBookNowButton => 'Book Now';

  @override
  String get bookInvestigationBookingButton => 'Booking...';

  @override
  String bookInvestigationSelectedCount(int count) {
    return '$count selected';
  }

  @override
  String get bookInvestigationSearchHint => 'Search tests...';

  @override
  String bookInvestigationCostFasting(String cost) {
    return '₹$cost • Fasting required';
  }

  @override
  String get bookInvestigationCustomTestHint => 'e.g. CBC, Sugar test, Thyroid';

  @override
  String get bookInvestigationCameraButton => 'Camera';

  @override
  String get bookInvestigationGalleryButton => 'Gallery';

  @override
  String get bookInvestigationPhotoSelected => 'Photo selected';

  @override
  String get bookInvestigationCollectionAddressLabel => 'Collection Address *';

  @override
  String get bookInvestigationCollectionAddressHint =>
      'Enter your full address';

  @override
  String get bookInvestigationLandmarkLabel => 'Landmark';

  @override
  String get bookInvestigationLandmarkHint => 'Near/opposite...';

  @override
  String get bookInvestigationPreferredDate => 'Preferred Date';

  @override
  String get bookInvestigationNotesOptional => 'Notes (optional)';

  @override
  String get bookInvestigationNotesHint => 'Any special instructions...';

  @override
  String get vitalsInvalidValue => 'Invalid';

  @override
  String get vitalsHeartRateRange => 'Enter 30-250 bpm';

  @override
  String get vitalsTemperatureRange => 'Enter 90-110 °F';

  @override
  String get vitalsBloodSugarRange => 'Enter 20-600 mg/dL';

  @override
  String get vitalsWeightRange => 'Enter 1-300 kg';

  @override
  String get vitalsSpo2Range => 'Enter 50-100%';

  @override
  String get vitalsHistoryHeading => 'History';

  @override
  String get yourHealthTabTimeline => 'Timeline';

  @override
  String get yourHealthTabMyUploads => 'My Uploads';

  @override
  String get yourHealthTabPrescriptions => 'Prescriptions';

  @override
  String get pharmacyOrderNoteHint =>
      'e.g., Dolo 650 - 2 strips, Pan 40 - 1 strip...';

  @override
  String get pharmacyHomeDelivery => 'Home Delivery';

  @override
  String get pharmacyPickup => 'Pickup';

  @override
  String get pharmacyLandmarkOptional => 'Landmark (optional)';

  @override
  String get pharmacyLandmarkHint => 'Near...';

  @override
  String get commonCouldNotOpenLink => 'Could not open the link';

  @override
  String get commonCloseButton => 'Close';

  @override
  String get commonOpenButton => 'Open';

  @override
  String get commonRefreshButton => 'Refresh';

  @override
  String get guestSignInDefaultFeature => 'this feature';

  @override
  String get guestSignInTitle => 'Sign in required';

  @override
  String guestSignInBody(String feature) {
    return 'Sign in to use $feature.';
  }

  @override
  String get guestSignInKeepBrowsing => 'Keep browsing';

  @override
  String get guestSignInAndReturn => 'Sign in and return';

  @override
  String get dashboardOpenStepChallenge => 'Open step challenge';

  @override
  String get dashboardRecentActivity => 'Recent activity';

  @override
  String get dashboardOpenHealthPoints => 'Open health points';

  @override
  String get dashboardHealthConnectSynced =>
      'Health data synced - activity and vitals updated';

  @override
  String get dashboardHealthConnectNoSamples => 'No new samples to sync';

  @override
  String get dashboardHealthConnectOpenFailed =>
      'Could not open Health Connect';

  @override
  String get dashboardExploreSection => 'Explore';

  @override
  String get dashboardCareToolsSection => 'Care tools';

  @override
  String get dashboardTodaySection => 'Today';

  @override
  String get profileSwitcherSelfName => 'You';

  @override
  String get profileSwitcherTitle => 'Profiles';

  @override
  String get profileSwitcherSubtitle =>
      'Switch between your profile and linked dependents';

  @override
  String get profileSwitcherYourProfile => 'Your profile';

  @override
  String get profileSwitcherNoDependents => 'No dependents linked yet';

  @override
  String get profileSwitcherRemoveDependentTitle => 'Remove dependent?';

  @override
  String profileSwitcherRemoveDependentBody(String name) {
    return 'Remove $name from your linked profiles?';
  }

  @override
  String get profileSwitcherRemoveButton => 'Remove';

  @override
  String profileSwitcherRemovedToast(String name) {
    return 'Removed $name';
  }

  @override
  String get profileSwitcherRemoveFailed =>
      'Could not remove dependent. Please try again.';

  @override
  String get periodTrackerMarkStartedToday => 'Mark started today';

  @override
  String get periodTrackerEnterStartDate => 'Enter start date';

  @override
  String get periodTrackerOpen => 'Open tracker';

  @override
  String get periodTrackerCycleStartRecorded => 'Cycle start recorded';

  @override
  String get periodTrackerCycleStartSaveFailed => 'Could not save cycle start';

  @override
  String get periodTrackerSavedToast => 'Cycle tracker saved';

  @override
  String get periodTrackerLastPeriodStart => 'Last period start';

  @override
  String get periodTrackerTitle => 'Period Tracker';

  @override
  String get periodTrackerCycleDetails => 'Cycle details';

  @override
  String get periodTrackerCycleLength => 'Cycle length';

  @override
  String get periodTrackerDays => 'days';

  @override
  String get periodTrackerPeriodLength => 'Period length';

  @override
  String get periodTrackerSaving => 'Saving';

  @override
  String get periodTrackerSaveTracker => 'Save tracker';

  @override
  String get periodTrackerAddFirstDay =>
      'Add the first day of your last period.';

  @override
  String get periodTrackerPregnancyCaution =>
      'This is not a diagnosis. Consider a pregnancy test or clinician review.';

  @override
  String periodTrackerCycleDay(int cycleDay) {
    return 'Cycle day $cycleDay';
  }

  @override
  String get periodTrackerStartedToday => 'Started today';

  @override
  String get periodTrackerAddDate => 'Add date';

  @override
  String get periodTrackerEnterDate => 'Enter date';

  @override
  String get periodTrackerStartTracking => 'Start tracking';

  @override
  String get periodTrackerMayBePregnant => 'You may be pregnant';

  @override
  String periodTrackerCycleDelayed(int days) {
    return 'Cycle delayed by $days days';
  }

  @override
  String get periodTrackerCycleDueToday => 'Cycle due today';

  @override
  String periodTrackerDaysToNextCycle(int days) {
    return '$days days to next cycle';
  }

  @override
  String get periodTrackerLastRecordedPeriod => 'Last recorded period';

  @override
  String get periodTrackerEstimatedFertileWindow => 'Estimated fertile window';

  @override
  String get periodTrackerExpectedPeriodDate => 'Expected period date';

  @override
  String get periodTrackerExpectedNextPeriod => 'Expected next period';

  @override
  String get periodTrackerPrivacyNote =>
      'Saved locally on this device for now. Hospital sync can be added after consent, retention, and clinical review rules are finalized.';

  @override
  String get billDetailLoadFailed => 'Unable to load bill. Please retry.';

  @override
  String get billDetailDownloadPdf => 'Download PDF';

  @override
  String get billDetailDownloadFailed =>
      'Could not download the bill. Please retry.';

  @override
  String get billDetailPaymentLinkFailed => 'Could not generate payment link';

  @override
  String get billDetailSubtotal => 'Subtotal';

  @override
  String get billDetailDiscount => 'Discount';

  @override
  String billDetailPayViaUpi(String amount) {
    return 'Pay $amount via UPI';
  }

  @override
  String get billDetailPayViaUpiBody =>
      'Tap to open your UPI app with the amount pre-filled.';

  @override
  String get billDetailGenerating => 'Generating...';

  @override
  String get billDetailPayNow => 'Pay now';

  @override
  String billDetailPaymentLinkReference(String token) {
    return 'Payment link reference: $token...';
  }

  @override
  String get billDetailInsuranceBreakdown => 'Insurance / TPA breakdown';

  @override
  String billDetailClaimNumber(String claimNumber) {
    return 'Claim $claimNumber';
  }

  @override
  String get billDetailTotalBilled => 'Total billed';

  @override
  String get billDetailTpaPaid => 'TPA paid';

  @override
  String get billDetailPatientShare => 'Patient share';

  @override
  String get billDetailWhatWasNotCovered => 'What was not covered';

  @override
  String get billDetailLatestInsurerNote => 'Latest insurer note';

  @override
  String get billDetailViewFullInsuranceClaim => 'View full insurance claim';

  @override
  String get billDetailItems => 'Items';

  @override
  String get billDetailPaymentHistory => 'Payment history';

  @override
  String get labOrdersLoadFailed =>
      'Unable to load lab orders. Please pull down to retry.';

  @override
  String get labOrdersDownloadFailed => 'Could not download report';

  @override
  String get labOrdersTitle => 'Lab Orders';

  @override
  String get labOrdersEmptyTitle => 'No lab orders';

  @override
  String get labOrdersEmptySubtitle =>
      'Lab tests ordered by your doctor will appear here with collection instructions and reports.';

  @override
  String labOrdersOrderedBy(String doctorName) {
    return 'Ordered by $doctorName';
  }

  @override
  String get labOrdersWhere => 'Where';

  @override
  String get labOrdersBy => 'By';

  @override
  String get labOrdersScheduled => 'Scheduled';

  @override
  String get labOrdersNoCollectionInstructions =>
      'Your doctor has not provided collection instructions yet. Please ask staff for the lab location and timing.';

  @override
  String get labOrdersCompleted => 'Completed';

  @override
  String get labOrdersDownloading => 'Downloading...';

  @override
  String get labOrdersDownloadReport => 'Download report';

  @override
  String labOrdersRequestedOn(String date) {
    return 'Requested $date';
  }

  @override
  String get labOrdersFastingRequired => 'Fasting required';

  @override
  String get messagesCategoryGeneral => 'General';

  @override
  String get messagesCategoryAppointment => 'Appointment';

  @override
  String get messagesCategoryPrescription => 'Prescription';

  @override
  String get messagesCategoryLabResult => 'Lab result';

  @override
  String get messagesCategoryBilling => 'Billing';

  @override
  String get messagesCategoryDischarge => 'Discharge';

  @override
  String get messagesCategoryOther => 'Other';

  @override
  String get messagesLoadFailed => 'Unable to load messages. Please retry.';

  @override
  String get messagesTitle => 'Messages';

  @override
  String get messagesNewMessage => 'New message';

  @override
  String get messagesEmptyTitle => 'No messages yet';

  @override
  String get messagesEmptySubtitle =>
      'Start a secure conversation with the hospital using the New Message button below.';

  @override
  String get messagesUrgent => 'URGENT';

  @override
  String get messagesSubjectBodyRequired =>
      'Subject and message body are required.';

  @override
  String get messagesSendFailed => 'Failed to send message. Please try again.';

  @override
  String get messagesCategoryLabel => 'Category';

  @override
  String get messagesSubjectLabel => 'Subject';

  @override
  String get messagesBodyLabel => 'Message';

  @override
  String get messagesSending => 'Sending...';

  @override
  String get messagesSendButton => 'Send';

  @override
  String get recordsPickFile => 'Please pick a file';

  @override
  String get settingsDeletingAccount => 'Deleting account...';

  @override
  String get settingsDeleteAccountFailed =>
      'Could not delete account. Please try again.';

  @override
  String get settingsExportDataTitle => 'Download my data';

  @override
  String get settingsExportDataSubtitle =>
      'Export everything the hospital holds about you as a file';

  @override
  String get settingsExportDataFailed =>
      'Could not export your data. Please retry.';

  @override
  String get settingsDeleteAccountTitle => 'Delete account';

  @override
  String get settingsDeleteAccountConsequences =>
      'This will remove your login access and clear your personal identity details from your account. Clinical, billing, and audit records are retained where the hospital is legally required to keep them. You cannot delete the account while an active admission is open.';

  @override
  String get settingsEnterOtp => 'Enter the 6-digit OTP.';

  @override
  String get settingsOtpNotReady => 'OTP is not ready yet. Resend code.';

  @override
  String get settingsOtpVerificationFailed =>
      'OTP verification failed. Please try again.';

  @override
  String get settingsVerifyPhoneTitle => 'Verify your phone';

  @override
  String settingsFreshOtpSent(String phone) {
    return 'We sent a fresh OTP to $phone.';
  }

  @override
  String get settingsSendingOtp => 'Sending OTP...';

  @override
  String get settingsResendOtp => 'Resend';

  @override
  String get settingsVerifyButton => 'Verify';

  @override
  String get settingsConfirmDeletionTitle => 'Confirm deletion';

  @override
  String get settingsConfirmDeletionBody =>
      'This action cannot be undone. You will be logged out on this device and all other sessions will be revoked.';

  @override
  String get settingsDeleteAccountButton => 'Delete account';

  @override
  String get settingsActiveAdmissionBlocksDeletion =>
      'Account deletion is blocked while an active admission is open.';

  @override
  String settingsHospitalIdLine(String name, String hospitalNumber) {
    return '$name - Hospital ID $hospitalNumber';
  }

  @override
  String get settingsManageDependents => 'Manage dependents';

  @override
  String get settingsManageDependentsSubtitle =>
      'Link or remove a minor under your account';

  @override
  String get settingsHealthDataSynced =>
      'Health data synced - activity and vitals updated';

  @override
  String get settingsNoNewSamplesToSync => 'No new samples to sync';

  @override
  String get settingsDeleteAccountSubtitle =>
      'Re-authenticate with OTP before deletion';

  @override
  String get settingsLegalSection => 'Legal';

  @override
  String get settingsOpenTermsInBrowser =>
      'Open the current terms in your browser';

  @override
  String get settingsOpenPrivacyInBrowser =>
      'Open the current privacy policy in your browser';

  @override
  String get splashUseStandardPhone =>
      'Please use a standard, unmodified phone.';

  @override
  String get splashAuthenticateToContinue => 'Please authenticate to continue';

  @override
  String get splashUpdateRequired => 'Update required';

  @override
  String get splashUpdateBody =>
      'This version of VH Health is no longer supported. Please install the latest version to continue.';

  @override
  String get splashUpdateButton => 'Update VH Health';

  @override
  String get splashUpdateNoStoreBody =>
      'The updated version is not yet available for download on this device. Please contact the hospital reception for help installing the latest version of VH Health.';

  @override
  String get yourHealthTimelineFilterAll => 'All';

  @override
  String get yourHealthTimelineFilterVisits => 'Visits';

  @override
  String get yourHealthTimelineFilterPrescriptions => 'Prescriptions';

  @override
  String get yourHealthTimelineFilterLabs => 'Labs';

  @override
  String get yourHealthTimelineFilterUploads => 'Uploads';

  @override
  String get yourHealthTimelineFilterHospital => 'Hospital Docs';

  @override
  String get yourHealthTimelineReady => 'Your health timeline is ready';

  @override
  String yourHealthTimelineUpdateCount(int count) {
    return '$count health updates in one timeline';
  }

  @override
  String get yourHealthTimelineRxPill => 'Rx';

  @override
  String get yourHealthTimelineVisitsPill => 'Visits';

  @override
  String get yourHealthTimelineUploadsPill => 'Uploads';

  @override
  String get yourHealthTimelineDatePending => 'Date pending';

  @override
  String yourHealthTimelineFilteredEmpty(String filter) {
    return 'No $filter yet';
  }

  @override
  String get yourHealthTimelineEmptyTitle => 'No timeline items yet';

  @override
  String get yourHealthTimelineFilteredEmptySubtitle =>
      'Try another filter or refresh the latest hospital records.';

  @override
  String get yourHealthTimelineEmptySubtitle =>
      'Prescriptions, consultations, hospital docs, and uploads will collect here automatically.';

  @override
  String get recordExtractionMissingRecordId => 'Record ID is missing';

  @override
  String get recordExtractionUnavailable => 'Extraction is not available yet';

  @override
  String get recordExtractionProcessFailed =>
      'Extraction could not be processed';

  @override
  String get recordExtractionUploadedRecord => 'Uploaded record';

  @override
  String get recordExtractionMessageSent => 'Message sent to the hospital team';

  @override
  String get recordExtractionMessageFailed =>
      'Message could not be sent. Please try again.';

  @override
  String get recordExtractionMessageHospital => 'Message hospital';

  @override
  String get recordExtractionRefresh => 'Refresh extraction';

  @override
  String get recordExtractionUploadedFile => 'Uploaded file';

  @override
  String get recordExtractionFilePreviewUnavailable =>
      'File preview unavailable';

  @override
  String get recordExtractionOpenFileToCompare => 'Open the file to compare it';

  @override
  String get recordExtractionImagePreviewUnavailable =>
      'Image preview unavailable';

  @override
  String get recordExtractionReviewFlags => 'Review flags';

  @override
  String get recordExtractionPatientIdentifiers => 'Patient identifiers';

  @override
  String get recordExtractionDiagnoses => 'Diagnoses';

  @override
  String get recordExtractionMedications => 'Medications';

  @override
  String get recordExtractionTestsReports => 'Tests & Reports';

  @override
  String get recordExtractionFollowUp => 'Follow up';

  @override
  String get recordExtractionOtherFields => 'Other extracted fields';

  @override
  String get recordExtractionDates => 'Dates';

  @override
  String get recordExtractionCitations => 'Citations';

  @override
  String get recordExtractionOcrText => 'OCR text';

  @override
  String recordExtractionReviewed(String status) {
    return 'Extraction reviewed: $status';
  }

  @override
  String get recordExtractionDraftWarning =>
      'AI draft - cross-check every extracted value against the original document before relying on it.';

  @override
  String get recordExtractionDocument => 'Document';

  @override
  String get recordExtractionProcessing => 'Processing';

  @override
  String get recordExtractionNoValues => 'No extracted values';

  @override
  String get recordExtractionProcessButton => 'Process extraction';

  @override
  String get dashboardHealthConnectPermissionDenied =>
      'Health Connect permission was not granted. In-app walk tracking still works.';

  @override
  String get dashboardWellnessBandExcellent => 'You\'re doing great';

  @override
  String get dashboardWellnessBandGood => 'Keep it up';

  @override
  String get dashboardWellnessBandNeedsAttention => 'Some attention needed';

  @override
  String get dashboardWellnessShowBreakdown => 'Show breakdown';

  @override
  String get dashboardWellnessHideBreakdown => 'Hide breakdown';

  @override
  String get dashboardWellnessBreakdownTitle => 'Wellness breakdown';

  @override
  String get dashboardWellnessNoSplit => 'No wellness split is available yet.';

  @override
  String get dashboardWellnessMedicationStatus => 'Medication status';

  @override
  String get dashboardWellnessMedicationProxy =>
      'Prescription-status proxy, not dose adherence';

  @override
  String get dashboardWellnessNoPrescriptions =>
      'No prescriptions to track yet';

  @override
  String dashboardWellnessPrescriptionsActive(int active, int total) {
    return '$active of $total prescriptions active/unexpired';
  }

  @override
  String get healthPointsCentralStats => 'Central stats';

  @override
  String get healthPointsRefreshingActivity => 'Refreshing your activity';

  @override
  String get healthPointsCentralStatsSubtitle =>
      'Walking, points, wellness, and sleep readiness';

  @override
  String healthPointsCentralStatsFromSource(String source) {
    return 'Walking, sleep, and points from $source';
  }

  @override
  String get healthPointsRefreshStatsTooltip => 'Refresh stats';

  @override
  String get healthPointsWalking => 'Walking';

  @override
  String healthPointsGoalStepCaption(int goal) {
    return '$goal-step goal';
  }

  @override
  String healthPointsActivitySourceCaption(String activity, String source) {
    return '$activity - $source';
  }

  @override
  String get healthPointsDistance => 'Distance';

  @override
  String get healthPointsToday => 'today';

  @override
  String get healthPointsSleep => 'Sleep';

  @override
  String get healthPointsNoData => 'No data';

  @override
  String get healthPointsConnectHealthData => 'Connect Health data';

  @override
  String healthPointsSyncSource(String source) {
    return '$source sync';
  }

  @override
  String get healthPointsWellness => 'Wellness';

  @override
  String get healthPointsOutOfHundred => 'out of 100';

  @override
  String get healthPointsPoints => 'Points';

  @override
  String get healthPointsCurrentBalance => 'current balance';

  @override
  String get healthPointsGoal => 'Goal';

  @override
  String get healthPointsStepsToday => 'steps today';

  @override
  String get dashboardHealthConnectPrompt =>
      'Allow Health Connect so VH Health can sync steps counted while the app is closed.';

  @override
  String get tpaClaimsEmptySubtitle =>
      'Insurance and cashless claims raised for your visits will appear here.';

  @override
  String get tpaClaimNoDataHint =>
      'Pull down or tap Refresh to check for the latest claim details.';

  @override
  String get appointmentsLoadFailed =>
      'Unable to load appointments. Please pull down to retry.';

  @override
  String get appointmentsNoDocuments =>
      'No documents are available for this appointment yet.';

  @override
  String get appointmentsDocumentsTitle => 'Documents';

  @override
  String get appointmentsDocumentFallback => 'Document';

  @override
  String get appointmentsDocumentsLoadFailed =>
      'Unable to load appointment documents. Please try again.';

  @override
  String appointmentsCancelConfirm(String doctor, String date, String time) {
    return 'Cancel appointment with $doctor on $date at $time?';
  }

  @override
  String get appointmentsCancelledToast => 'Appointment cancelled';

  @override
  String get appointmentsCancelFailed =>
      'Unable to cancel appointment. Please try again.';

  @override
  String get appointmentsReschedule => 'Reschedule';

  @override
  String get appointmentsRescheduleTitle => 'Choose a new slot';

  @override
  String get appointmentsRescheduleDate => 'New date';

  @override
  String get appointmentsRescheduleTime => 'New time';

  @override
  String get appointmentsRescheduleNote => 'Note for the care team';

  @override
  String get appointmentsRescheduleReview => 'Review';

  @override
  String appointmentsRescheduleConfirm(
    String doctor,
    String date,
    String time,
  ) {
    return 'Reschedule appointment with $doctor to $date at $time?';
  }

  @override
  String get appointmentsRescheduledToast => 'Appointment rescheduled';

  @override
  String get appointmentsRescheduleFailed =>
      'Unable to reschedule appointment. Please try another slot.';

  @override
  String get appointmentsEmptyHint =>
      'Book a visit with your care team and it will appear here.';

  @override
  String get appointmentsUpcomingSection => 'Upcoming';

  @override
  String get appointmentsPastSection => 'Past';

  @override
  String get bookInvestigationCatalogLoadFailed =>
      'Unable to load the investigation catalog. You can retry or enter tests manually.';

  @override
  String get bookInvestigationCatalogEmptyTitle => 'No tests found';

  @override
  String get bookInvestigationCatalogEmptySubtitle =>
      'Try another search, enter a custom test, or upload a prescription slip.';

  @override
  String get pharmacyPlaceOrderButton => 'Place Order';

  @override
  String get pharmacyPlacingOrderButton => 'Placing order...';

  @override
  String get appointmentDetailTitle => 'Appointment details';

  @override
  String get appointmentDetailDate => 'Date';

  @override
  String get appointmentDetailTime => 'Time';

  @override
  String get appointmentDetailReason => 'Reason';

  @override
  String get teleconsultBadge => 'TELE';

  @override
  String get teleconsultJoinVideoConsult => 'Join video consult';

  @override
  String get teleconsultStateChecking => 'Checking teleconsult status';

  @override
  String get teleconsultNotYet => 'Lobby opens closer to your visit';

  @override
  String get teleconsultLobbyOpen => 'Lobby is open';

  @override
  String get teleconsultInProgress => 'Consultation in progress';

  @override
  String get teleconsultEnded => 'Consultation ended';

  @override
  String get teleconsultCancelled => 'Consultation cancelled';

  @override
  String get teleconsultUnavailableYet =>
      'Teleconsultation is not available yet';

  @override
  String get teleconsultStateUnknown => 'Teleconsult status is unavailable';

  @override
  String get teleconsultNotYetBody =>
      'You can enter the lobby shortly before the scheduled time.';

  @override
  String get teleconsultLobbyOpenBody =>
      'Confirm consent and check your camera or microphone to continue.';

  @override
  String get teleconsultInProgressBody =>
      'The consultation is active. You can rejoin while it remains open.';

  @override
  String get teleconsultEndedBody => 'This video consultation is closed.';

  @override
  String get teleconsultCancelledBody =>
      'This video consultation was cancelled.';

  @override
  String get teleconsultUnavailableBody =>
      'Video is not enabled for this visit right now. Secure messages remain available.';

  @override
  String get teleconsultStateUnknownBody =>
      'Pull down or tap refresh to check again.';

  @override
  String get teleconsultRecordingOff =>
      'Recording is off for this consultation.';

  @override
  String get teleconsultLobbyTitle => 'Video consult lobby';

  @override
  String get teleconsultRefresh => 'Refresh';

  @override
  String get teleconsultDeviceNotChecked =>
      'Camera and microphone have not been checked.';

  @override
  String get teleconsultCheckDevices => 'Check devices';

  @override
  String get teleconsultCheckingDevices => 'Checking...';

  @override
  String get teleconsultDeviceVideoReady => 'Camera and microphone are ready.';

  @override
  String get teleconsultDeviceAudioOnly =>
      'Microphone is ready. Video is unavailable, so audio-only is recommended.';

  @override
  String get teleconsultDeviceUnavailable =>
      'Microphone permission is required to join.';

  @override
  String get teleconsultDeviceRequired =>
      'Please allow microphone access before joining.';

  @override
  String get teleconsultConsentTitle => 'Consent before joining';

  @override
  String get teleconsultConsentIdentity =>
      'I confirm this appointment is for me.';

  @override
  String get teleconsultConsentRemote =>
      'I agree to a remote video or audio consultation.';

  @override
  String get teleconsultConsentDegradation =>
      'I understand video may switch to audio-only or secure messages.';

  @override
  String get teleconsultConsentEmergency =>
      'I understand this is not for emergencies.';

  @override
  String get teleconsultConsentRecordingOff => 'I understand recording is off.';

  @override
  String get teleconsultConsentRequired =>
      'Please accept all consent items before joining.';

  @override
  String get teleconsultConsentFailed =>
      'Could not record consent. Please try again.';

  @override
  String get teleconsultContinueToCall => 'Continue to call';

  @override
  String get teleconsultConsultTitle => 'Video consultation';

  @override
  String get teleconsultConnecting => 'Connecting to the consultation...';

  @override
  String get teleconsultVideoUnavailableChatAvailable =>
      'Video is unavailable. You can continue through secure messages.';

  @override
  String get teleconsultAudioOnlyBanner => 'Audio-only mode is active.';

  @override
  String get teleconsultCallEnded => 'The consultation has ended.';

  @override
  String get teleconsultRemoteVideo => 'Doctor video';

  @override
  String get teleconsultLocalVideo => 'Your video';

  @override
  String get teleconsultMicrophoneOn => 'Microphone on';

  @override
  String get teleconsultMicrophoneOff => 'Microphone off';

  @override
  String get teleconsultCameraOn => 'Camera on';

  @override
  String get teleconsultCameraOff => 'Camera off';

  @override
  String get teleconsultSwitchAudioOnly => 'Audio only';

  @override
  String get teleconsultOpenSecureMessages => 'Secure messages';

  @override
  String get teleconsultSecureMessagesFailed =>
      'Could not open secure messages. Please try again.';

  @override
  String get teleconsultSecureMessageSubject => 'Video consult follow-up';

  @override
  String get teleconsultSecureMessageBody =>
      'I need to continue my video consult in secure messages.';

  @override
  String get teleconsultEndCall => 'End call';

  @override
  String get referralsTitle => 'Referrals';

  @override
  String get referralsLoadFailed =>
      'We could not load your referral updates. Please try again.';

  @override
  String get referralsEmptyTitle => 'No referral updates yet';

  @override
  String get referralsEmptySubtitle =>
      'Signed specialist updates that your care team releases will appear here.';

  @override
  String get referralsSpecialist => 'Specialist referral';

  @override
  String get referralsSummary => 'Specialist summary';

  @override
  String get referralsNextSteps => 'What to do next';

  @override
  String get referralsFollowUp => 'Follow-up plan';

  @override
  String get referralsAppointment => 'Appointment';

  @override
  String get referralsAppointmentLinked =>
      'A follow-up appointment is linked to this referral.';

  @override
  String get patientOutageTitle => 'Hospital service temporarily unavailable';

  @override
  String get patientOutageChecking => 'Checking hospital service…';

  @override
  String patientOutageMessage(String facilityContactNumber) {
    return 'Hospital systems are temporarily unavailable. The information shown here was saved earlier — check the \'last updated\' time on each page. New bookings, cancellations, and medical requests are paused until service is restored. For urgent needs, please contact the hospital directly at $facilityContactNumber. In an emergency, call your local emergency number or come straight to the Emergency Department.';
  }

  @override
  String get patientOutageRetry => 'Retry';

  @override
  String get patientOutageCallHospital => 'Call hospital';

  @override
  String get patientOutageMutationNotSent => 'This request was not sent.';

  @override
  String get patientOutageEmergencyNotSent =>
      'The hospital emergency alert was not sent.';

  @override
  String patientOutageCachedAt(String timestamp) {
    return 'Saved on this device $timestamp';
  }

  @override
  String patientOutageDownloadedAt(String timestamp) {
    return 'Downloaded on this device $timestamp';
  }

  @override
  String get patientOutageCacheUnavailable =>
      'This information is not available on this device.';

  @override
  String get patientOutageDialogTitle => 'Service unavailable';

  @override
  String get patientOutageContactUnavailable =>
      'The facility contact number is not configured on this device.';
}
