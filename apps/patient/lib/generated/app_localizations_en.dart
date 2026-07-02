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
  String get authSosTriggered => 'SOS alert has been triggered!';

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
  String get vitalsHistoryFailed => 'Failed to load vitals history';

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
  String get familyLoadFailed => 'Failed to load family members';

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
  String get deliveryYourLocation => 'Your Location';

  @override
  String get authDevLoginSkipOtp => 'Dev login (skip OTP)';

  @override
  String get permissionGateSettingUp => 'Setting up...';

  @override
  String get yourHealthUploadRecord => 'Upload Record';
}
