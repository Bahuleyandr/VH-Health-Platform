// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for Hindi (`hi`).
class AppLocalizationsHi extends AppLocalizations {
  AppLocalizationsHi([String locale = 'hi']) : super(locale);

  @override
  String get authLoginTitle => 'अपने खाते में लॉग इन करें';

  @override
  String get authPhoneNumber => 'फ़ोन नंबर';

  @override
  String get authPhonePrefix => '+91 ';

  @override
  String get authPhoneValidationEmpty => 'कृपया अपना फ़ोन नंबर दर्ज करें';

  @override
  String get authPhoneValidationInvalid =>
      'कृपया एक मान्य 10-अंकीय फ़ोन नंबर दर्ज करें';

  @override
  String get authGetOtp => 'OTP प्राप्त करें';

  @override
  String get authSendingOtp => 'OTP भेजा जा रहा है...';

  @override
  String get authMagicLinkSent => 'मैजिक लिंक सफलतापूर्वक भेजा गया';

  @override
  String get authMagicLinkFailed => 'मैजिक लिंक भेजने में विफल';

  @override
  String get authMagicLinkError => 'मैजिक लिंक भेजते समय कुछ गलत हो गया';

  @override
  String get authContinueAsGuest => 'अतिथि के रूप में जारी रखें';

  @override
  String get authByContinuingYouAgree => 'जारी रखकर, आप सहमत हैं';

  @override
  String get authTerms => 'शर्तें';

  @override
  String get authConditions => 'नियम';

  @override
  String get authAnd => 'और';

  @override
  String get authPrivacyPolicy => 'गोपनीयता नीति';

  @override
  String get authSosTooltip => 'SOS भेजें';

  @override
  String get authSosTriggered => 'SOS अलर्ट शुरू हो गया है!';

  @override
  String get authGuestUserSOS => 'अतिथि_उपयोगकर्ता_sos';

  @override
  String get otpVerifyOtpTitle => 'OTP सत्यापित करें';

  @override
  String get otpOtpSentTo => 'OTP भेजा गया';

  @override
  String get otpEnterOtp => 'OTP दर्ज करें';

  @override
  String get otpPleaseEnterOtp => 'कृपया OTP दर्ज करें';

  @override
  String get otpOtpMustBe6Digits => 'OTP 6 अंकों का होना चाहिए';

  @override
  String get otpVerify => 'सत्यापित करें';

  @override
  String get otpResendOtpIn => 'OTP फिर से भेजें';

  @override
  String get otpResendOtp => 'OTP फिर से भेजें';

  @override
  String get otpErrorOccurred => 'एक त्रुटि हुई';

  @override
  String get otpLoginSuccessful => 'लॉगिन सफल';

  @override
  String get otpLoginFailed => 'लॉगिन विफल';

  @override
  String get otpFailed => 'OTP सत्यापित करने में विफल';

  @override
  String get otpInvalidOtp => 'अमान्य OTP';

  @override
  String get otpOtpSessionExpired => 'OTP सत्र समाप्त हो गया';

  @override
  String get otpOtpResendFailed => 'OTP फिर से भेजने में विफल';

  @override
  String get otpOtpResentSuccessfully => 'OTP सफलतापूर्वक फिर से भेजा गया';

  @override
  String get otpInvalidFirebaseToken => 'अमान्य Firebase टोकन';

  @override
  String get autoSignInSuccess => 'आप स्वचालित रूप से साइन इन हो गए हैं!';

  @override
  String get commonTermsConditionsDisclaimerTitle => 'शर्तें, नियम और गोपनीयता';

  @override
  String get commonTermsOfUse => 'उपयोग की शर्तें';

  @override
  String get commonConditions => 'नियम';

  @override
  String get commonPrivacyPolicy => 'गोपनीयता नीति';

  @override
  String get commonBackToLogin => 'लॉगिन पर वापस जाएं';

  @override
  String get backToDashboard => 'डैशबोर्ड पर वापस जाएं';

  @override
  String get termsBody =>
      'VH Health में आपका स्वागत है। इस मोबाइल एप्लिकेशन को एक्सेस और उपयोग करके, आप इन उपयोग की शर्तों से बंधे होने के लिए सहमत हैं।\n\n1. उद्देश्य: VH Health एक मोबाइल एप्लिकेशन है जो रोगियों को उनके स्वास्थ्य रिकॉर्ड, अपॉइंटमेंट्स, नुस्खे, जांच और अस्पताल के साथ संचार का प्रबंधन करने में सहायता करने के लिए डिज़ाइन किया गया है।\n2. पात्रता: इस ऐप का स्वतंत्र रूप से उपयोग करने के लिए आपकी आयु कम से कम 18 वर्ष होनी चाहिए। नाबालिगों द्वारा उपयोग एक अभिभावक द्वारा पर्यवेक्षित किया जाना चाहिए।\n3. सेवाओं का उपयोग:\n   • आप सटीक और पूरी जानकारी प्रदान करने के लिए सहमत हैं।\n   • आप ऐप की कार्यक्षमता या सुरक्षा का दुरुपयोग या हस्तक्षेप नहीं करने के लिए सहमत हैं।\n   • किसी भी गैर-कानूनी या निषिद्ध उपयोग की सख्त मनाही है।\n4. बौद्धिक संपदा: ऐप के भीतर सभी सामग्री, जिसमें लोगो, टेक्स्ट, चित्र और डेटा शामिल हैं, VH Health या उसके लाइसेंसदाताओं की संपत्ति है और लागू कॉपीराइट और ट्रेडमार्क कानूनों द्वारा संरक्षित है।\n5. संशोधन: हम किसी भी समय, बिना किसी सूचना के, किसी भी सुविधा या कार्यक्षमता को संशोधित करने या बंद करने का अधिकार सुरक्षित रखते हैं।\n6. समाप्ति: VH Health शर्तों का उल्लंघन करने वाले या दुरुपयोग में लिप्त किसी भी उपयोगकर्ता की पहुंच को निलंबित या समाप्त कर सकता है।';

  @override
  String get conditionsBody =>
      '1. **चिकित्सा सलाह अस्वीकरण:**\n   • यह ऐप सामान्य सूचनात्मक उद्देश्यों और सुविधा के लिए है।\n   • यह योग्य स्वास्थ्य पेशेवरों के साथ सीधे परामर्श का विकल्प नहीं है।\n   • निदान और उपचार के लिए हमेशा अपने डॉक्टर या अस्पताल के कर्मचारियों से परामर्श करें।\n\n2. आपातकालीन उपयोग:\n   • यह ऐप आपातकालीन चिकित्सा सहायता के लिए नहीं है।\n   • आपातकाल की स्थिति में, कृपया अपने स्थानीय आपातकालीन नंबर पर कॉल करें या निकटतम अस्पताल जाएं।\n\n3. सेवा उपलब्धता:\n   • हम निरंतर उपलब्धता के लिए प्रयास करते हैं, लेकिन निर्बाध पहुंच की गारंटी नहीं देते हैं।\n   • तकनीकी समस्याएं, अपडेट या नेटवर्क विफलताएं कभी-कभी पहुंच को प्रभावित कर सकती हैं।\n\n4. डेटा सटीकता:\n   • अपॉइंटमेंट शेड्यूल और रिपोर्ट जैसी जानकारी अस्पताल प्रणालियों से प्राप्त की जाती है और मैनुअल प्रविष्टि के अधीन हो सकती है।\n   • VH Health गलत डेटा प्रविष्टि या तीसरे पक्ष के सिस्टम मुद्दों के कारण होने वाली त्रुटियों के लिए उत्तरदायी नहीं है।';

  @override
  String get privacyBody =>
      '1. **सूचना संग्रह:**\n   • हम आपका नाम, फ़ोन नंबर, यूआईडी, मेडिकल रिकॉर्ड, अपॉइंटमेंट डेटा और अपलोड एकत्र करते हैं।\n   • हम ऐप के प्रदर्शन को बेहतर बनाने के लिए डिवाइस पहचानकर्ता और उपयोग विश्लेषण भी एकत्र कर सकते हैं।\n\n2. सूचना का उपयोग:\n   • आपकी जानकारी का उपयोग केवल ऐप के भीतर सेवाएं प्रदान करने के लिए किया जाता है।\n   • हम आपके डेटा को नहीं बेचते हैं या विज्ञापन उद्देश्यों के लिए इसका उपयोग नहीं करते हैं।\n\n3. डेटा साझाकरण:\n   • आपका डेटा आपकी देखभाल में शामिल अधिकृत अस्पताल कर्मचारियों और चिकित्सा पेशेवरों के साथ साझा किया जा सकता है।\n   • यदि कानून द्वारा आवश्यक हो या कानूनी दायित्वों के मामले में हम डेटा का खुलासा भी कर सकते हैं।\n\n4. डेटा सुरक्षा:\n   • हम आपके डेटा की सुरक्षा के लिए उद्योग-मानक सुरक्षा प्रथाओं का उपयोग करते हैं।\n   • हालांकि, कोई भी प्रणाली 100% सुरक्षित नहीं है; ऐप का उपयोग आपके अपने जोखिम पर है।\n\n5. आपके अधिकार:\n   • आप अपनी संग्रहीत जानकारी तक पहुंच का अनुरोध कर सकते हैं या सुधार का अनुरोध कर सकते हैं।\n   • आप अस्पताल प्रशासन से संपर्क करके अपने खाते को हटाने का अनुरोध भी कर सकते हैं।\n\n6. डेटा प्रतिधारण:\n   • आपका डेटा स्वास्थ्य सेवा या कानूनी उद्देश्यों के लिए आवश्यक होने तक बनाए रखा जाएगा।';

  @override
  String get profileEditScreenTitle => 'प्रोफ़ाइल संपादित करें';

  @override
  String get profileNameLabel => 'पूरा नाम';

  @override
  String get profileNameHint => 'अपना पूरा नाम दर्ज करें';

  @override
  String get profileNameValidationRequired => 'नाम आवश्यक है';

  @override
  String get profileEmailLabel => 'ईमेल पता';

  @override
  String get profileEmailHint => 'example@domain.com';

  @override
  String get profileEmailValidationInvalid => 'एक मान्य ईमेल पता दर्ज करें';

  @override
  String get profileBirthdayLabel => 'जन्मदिन';

  @override
  String get profileBirthdayHint => 'अपनी जन्म तिथि चुनें';

  @override
  String get profileSaveChangesButton => 'बदलाव सहेजें';

  @override
  String get profileUpdatedSuccessfully => 'प्रोफ़ाइल सफलतापूर्वक अपडेट की गई';

  @override
  String get networkError => 'नेटवर्क त्रुटि। कृपया पुनः प्रयास करें।';

  @override
  String get profileSetupTitle => 'अपनी प्रोफ़ाइल सेट करें';

  @override
  String get profileUploadProfilePic => 'फोटो जोड़ें';

  @override
  String get profileSetupSaved => 'प्रोफ़ाइल सफलतापूर्वक सहेजी गई';

  @override
  String get profileSetupSaveFailed => 'प्रोफ़ाइल सहेजने में असमर्थ';

  @override
  String get profileGenderLabel => 'लिंग';

  @override
  String get profileGenderMale => 'पुरुष';

  @override
  String get profileGenderFemale => 'महिला';

  @override
  String get profileGenderOther => 'अन्य';

  @override
  String get profileGenderValidationRequired => 'कृपया एक लिंग चुनें';

  @override
  String get profileEmailHintOptional => 'वैकल्पिक';

  @override
  String get profileBirthdaySelectLabel => 'जन्मदिन चुनें';

  @override
  String get profileBirthdayLabelShort => 'जन्मदिन';

  @override
  String get profileAnniversarySelectLabel => 'सालगिरह चुनें';

  @override
  String get profileAnniversaryLabelShort => 'सालगिरह';

  @override
  String get commonSkipButton => 'छोड़ें';

  @override
  String get commonSubmitButton => 'सबमिट करें';

  @override
  String get commonCancelButton => 'रद्द करें';

  @override
  String get filesPickerError => 'फ़ाइल नहीं चुन सका। कृपया पुनः प्रयास करें।';

  @override
  String get hello => 'नमस्ते';

  @override
  String get changeLanguage => 'भाषा बदलें';

  @override
  String get lastAppointment => 'पिछली अपॉइंटमेंट';

  @override
  String get upcomingAppointment => 'आगामी अपॉइंटमेंट';

  @override
  String get notAvailable => 'उपलब्ध नहीं';

  @override
  String get yourHealth => 'आपका स्वास्थ्य';

  @override
  String get appointments => 'अपॉइंटमेंट्स';

  @override
  String get pharmacy => 'फार्मेसी';

  @override
  String get investigations => 'जांच';

  @override
  String get askDoubt => 'संदेह पूछें';

  @override
  String get triviaLabel => 'रोचक तथ्य';

  @override
  String get departments => 'विभाग';

  @override
  String get aboutUsLabel => 'हमारे बारे में';

  @override
  String get yourHealthTitle => 'आपका स्वास्थ्य';

  @override
  String get yourHealthSortNewest => 'क्रमबद्ध करें: नवीनतम पहले';

  @override
  String get yourHealthSortOldest => 'क्रमबद्ध करें: सबसे पुराना पहले';

  @override
  String get yourHealthFilterByType => 'प्रकार के अनुसार फ़िल्टर करें';

  @override
  String get yourHealthNoRecords => 'कोई रिकॉर्ड नहीं मिला';

  @override
  String get yourHealthUploaded => 'अपलोड किया गया';

  @override
  String get yourHealthLoginToView =>
      'अपने मेडिकल रिकॉर्ड तक पहुंचने के लिए लॉग इन करें';

  @override
  String get recordsLoadFailed => 'रिकॉर्ड लोड नहीं हो सके';

  @override
  String get recordsShowingOffline => 'ऑफ़लाइन डेटा दिखाया जा रहा है';

  @override
  String get fileQuarantined =>
      'फ़ाइल क्वारंटाइन में है और डाउनलोड नहीं की जा सकती';

  @override
  String get fileCouldNotOpen => 'फ़ाइल खोलने में असमर्थ';

  @override
  String get recordTypeAll => 'सभी';

  @override
  String get recordTypeConsultation => 'परामर्श';

  @override
  String get recordTypeInvestigation => 'जांच';

  @override
  String get recordTypeReport => 'रिपोर्ट';

  @override
  String get login => 'लॉग इन करें';

  @override
  String get requestAppointment => 'अपॉइंटमेंट का अनुरोध करें';

  @override
  String get enterYourPhone => 'अपना फ़ोन नंबर दर्ज करें';

  @override
  String get enterValidPhone => 'कृपया एक मान्य 10-अंकीय फ़ोन नंबर दर्ज करें';

  @override
  String get chooseDepartmentOrDoctor => 'विभाग चुनें';

  @override
  String get selectDoctorPlaceholder => 'डॉक्टर चुनें (वैकल्पिक)';

  @override
  String get selectDoctorAndDate => 'कृपया एक विभाग चुनें';

  @override
  String get submitRequest => 'अनुरोध सबमिट करें';

  @override
  String get appointmentConfirmationNote =>
      'अपॉइंटमेंट अनुरोध प्राप्त हुआ! हम जल्द ही पुष्टि करेंगे।';

  @override
  String get appointmentFailed => 'अपॉइंटमेंट बुक करने में विफल';

  @override
  String get genericError => 'कुछ गलत हो गया। कृपया पुनः प्रयास करें।';

  @override
  String get calendarSyncTitle => 'कैलेंडर में जोड़ें?';

  @override
  String get calendarSyncPrompt =>
      'क्या आप इस अपॉइंटमेंट को अपने कैलेंडर में जोड़ना चाहते हैं?';

  @override
  String get yesAlways => 'हाँ, हमेशा';

  @override
  String get no => 'नहीं';

  @override
  String get calendarEventTitle => 'VH Health अपॉइंटमेंट';

  @override
  String calendarEventDescription(Object doctor) {
    return '$doctor के साथ अपॉइंटमेंट';
  }

  @override
  String get calendarEventLocation => 'VH Health अस्पताल';

  @override
  String get generalDoctor => 'डॉक्टर';

  @override
  String get sosSent => 'SOS अलर्ट भेजा गया!';

  @override
  String get requestAppointmentPhoneNumber => 'फ़ोन नंबर';

  @override
  String get cardiology => 'हृदय रोग विज्ञान';

  @override
  String get neurology => 'तंत्रिका विज्ञान';

  @override
  String get orthopedics => 'हड्डी रोग';

  @override
  String get dermatology => 'त्वचा विज्ञान';

  @override
  String get pediatrics => 'बाल रोग';

  @override
  String get general_medicine => 'सामान्य चिकित्सा';

  @override
  String get pharmacyTitle => 'दवाएं ऑर्डर करें';

  @override
  String get pharmacyPermissionsRequired =>
      'फ़ाइलों का चयन करने के लिए संग्रहण अनुमति आवश्यक है।';

  @override
  String get pharmacyFilePickerError =>
      'फ़ाइल नहीं चुन सका। कृपया पुनः प्रयास करें।';

  @override
  String get pharmacyFormAndFileRequired =>
      'कृपया फ़ॉर्म पूरा करें और एक नुस्खे की फ़ाइल संलग्न करें।';

  @override
  String get pharmacyUploadFailed => 'अपलोड विफल। कृपया पुनः प्रयास करें।';

  @override
  String get pharmacySubmissionFailed => 'ऑर्डर सबमिशन विफल।';

  @override
  String get pharmacyConfirmationNote =>
      'ऑर्डर दिया गया! हमारी फार्मेसी पुष्टि करने के लिए कॉल करेगी।';

  @override
  String get pharmacyInfoBanner =>
      'अपने डॉक्टर का नुस्खा (पीडीएफ या छवि) और डिलीवरी पता अपलोड करें।';

  @override
  String get pharmacyUploadPrescriptionButton => 'नुस्खा अपलोड करें';

  @override
  String get fileSelected => 'चयनित';

  @override
  String get fileClearSelection => 'साफ़ करें';

  @override
  String get pharmacyDeliveryAddressLabel => 'डिलीवरी का पता';

  @override
  String get pharmacyDeliveryAddressHint =>
      'मकान / फ्लैट नंबर, गली, क्षेत्र, पिन कोड...';

  @override
  String get pharmacyDeliveryAddressValidationRequired => 'पता आवश्यक है';

  @override
  String get pharmacySubmitOrderButton => 'ऑर्डर सबमिट करें';

  @override
  String get pharmacyCallButton => 'फार्मेसी को कॉल करें';

  @override
  String get pharmacyCallFailed => 'डायलर लॉन्च नहीं हो सका।';

  @override
  String get pharmacyPhoneNumberLabel => 'फ़ोन नंबर';

  @override
  String get pharmacyPhoneNumberHint => '10-अंकीय मोबाइल नंबर';

  @override
  String get pharmacyPhoneNumberValidationInvalid =>
      'एक मान्य 10-अंकीय मोबाइल नंबर दर्ज करें';

  @override
  String get investigationsTitle => 'जांच का अनुरोध करें';

  @override
  String get investigationsTestNameLabel => 'परीक्षण का नाम';

  @override
  String get investigationsTestNameHint => 'उदा. पूर्ण रक्त गणना';

  @override
  String get investigationsTestNameValidationRequired =>
      'परीक्षण का नाम आवश्यक है';

  @override
  String get investigationsUploadFileButtonLabel => 'डॉक्टर का आदेश अपलोड करें';

  @override
  String get investigationsSubmitRequestButton => 'अनुरोध सबमिट करें';

  @override
  String get investigationsViewReportsButton => 'जांच रिपोर्ट देखें';

  @override
  String get investigationsFormAndFileRequired =>
      'कृपया फ़ॉर्म पूरा करें और एक फ़ाइल संलग्न करें।';

  @override
  String get investigationsConfirmationNote =>
      'अनुरोध भेजा गया! हम शेड्यूल करने के लिए आपसे संपर्क करेंगे।';

  @override
  String get investigationsFailed => 'अनुरोध सबमिट करने में विफल।';

  @override
  String get investigationsUploadFailed =>
      'फ़ाइल अपलोड विफल। कृपया पुनः प्रयास करें।';

  @override
  String get investigationsPermissionsRequired => 'संग्रहण अनुमति आवश्यक है।';

  @override
  String get investigationsFilePickerError =>
      'एक फ़ाइल नहीं चुन सका। कृपया पुनः प्रयास करें।';

  @override
  String get triviaTitle => 'स्वास्थ्य रोचक तथ्य';

  @override
  String get triviaDidYouKnow => 'क्या आप जानते हैं?';

  @override
  String get triviaNewTriviaButton => 'एक और तथ्य दिखाएं';

  @override
  String get triviaFact1 =>
      'मानव का हृदय प्रति दिन लगभग 100,000 बार धड़कता है।';

  @override
  String get triviaFact2 =>
      '100 बार हंसना लगभग एक स्थिर बाइक पर 15 मिनट के व्यायाम के बराबर है।';

  @override
  String get triviaFact3 => 'आपकी नाक 50,000 विभिन्न गंधों को याद रख सकती है।';

  @override
  String get triviaFact4 =>
      'हड्डियाँ समान वजन के स्टील से लगभग पाँच गुना मजबूत होती हैं।';

  @override
  String get triviaFact5 =>
      'एक औसत वयस्क की त्वचा लगभग 2 वर्ग मीटर को कवर करती है।';

  @override
  String get triviaFact6 =>
      'आपका पेट खुद को पचाने से बचने के लिए हर कुछ दिनों में अपनी परत बदलता है।';

  @override
  String get triviaFact7 =>
      'सबसे मजबूत मांसपेशी (वजन के हिसाब से) मैसेटर है—जबड़े की मांसपेशी।';

  @override
  String get triviaFact8 =>
      'लोग रात की तुलना में सुबह में लगभग 1 सेमी लम्बे होते हैं।';

  @override
  String get triviaFact9 =>
      'पसीना खुद गंधहीन होता है; त्वचा पर बैक्टीरिया शरीर की गंध पैदा करते हैं।';

  @override
  String get triviaFact10 =>
      'मनुष्य अपने डीएनए का 50% केले के साथ साझा करते हैं।';

  @override
  String get departmentsTitle => 'अस्पताल के विभाग';

  @override
  String get departmentsLoadFailed =>
      'विभागों को लोड करने में असमर्थ। पुनः प्रयास करने के लिए नीचे खींचें।';

  @override
  String get departmentsNoneFound => 'कोई विभाग नहीं मिला।';

  @override
  String get departmentsUnknown => 'अज्ञात विभाग';

  @override
  String get departmentsDoctor => 'डॉक्टर';

  @override
  String get departmentsBook => 'बुक करें';

  @override
  String get guestUser => 'अतिथि';

  @override
  String get aboutUsContent =>
      '2003 में हमारी स्थापना के बाद से, वेंकटेश्वर अस्पताल चेन्नई के हृदय में आशा और उपचार का प्रतीक रहा है। दूरदर्शी हृदय रोग विशेषज्ञ डॉ. थिलाई वल्लाल द्वारा स्थापित, हम एक विशेष हृदय देखभाल केंद्र से चेन्नई के सबसे भरोसेमंद मल्टीस्पेशलिटी स्वास्थ्य संस्थानों में से एक बन गए हैं, जिसने हमारी दयालु देखभाल की प्रतिबद्धता के साथ दस लाख से अधिक जिंदगियों को छुआ है।\n\n## हमारा मिशन: रोकथाम ही हमारा जुनून है\nवेंकटेश्वर अस्पताल में, हम मानते हैं कि सबसे अच्छा उपचार रोकथाम है। हमारा प्राथमिक मिशन उपचार से परे है—हम व्यापक स्क्रीनिंग, शिक्षा और व्यक्तिगत कल्याण कार्यक्रमों के माध्यम से जीवनशैली से जुड़ी बीमारियों की शुरुआत को रोकने के लिए समर्पित हैं। इस सक्रिय दृष्टिकोण ने हजारों रोगियों को दिल के दौरे, स्ट्रोक और अन्य रोकी जा सकने वाली स्थितियों से बचने में मदद की है।\n\n## विश्वस्तरीय सुविधाएं, अपनेपन वाली देखभाल\nनंदनम, चैमियर्स रोड पर हमारी 150 बिस्तरों वाली सुविधा अत्याधुनिक तकनीक को व्यक्तिगत देखभाल की गर्मजोशी के साथ जोड़ती है। कई विशिष्टताओं में 100 से अधिक प्रतिष्ठित डॉक्टरों और अत्याधुनिक बुनियादी ढांचे के साथ, हम प्रदान करते हैं:\n\n- **उन्नत हृदय देखभाल**: 100,000 से अधिक सफल हृदय प्रक्रियाएं पूरी हुईं\n- **24/7 आपातकालीन सेवाएं**: चौबीसों घंटे ट्रॉमा और क्रिटिकल केयर\n- **व्यापक विशेषज्ञताएं**: कार्डियोलॉजी से कॉस्मेटोलॉजी तक, न्यूरोलॉजी से नेफ्रोलॉजी तक\n- **आधुनिक आईसीयू**: 1:1 नर्स-रोगी अनुपात और उन्नत निगरानी प्रणालियों के साथ 25 बिस्तरों वाला बंद आईसीयू\n- **अत्याधुनिक निदान**: एमआरआई, सीटी स्कैन, उन्नत विकृति विज्ञान प्रयोगशाला और इमेजिंग सुविधाएं\n\n## चिकित्सा उत्कृष्टता में अग्रणी\n### नवीनतम प्रक्रियाएं और प्रौद्योगिकियां\n\n**न्यूनतम इनवेसिव कार्डियक हस्तक्षेप**\n- ड्रग-एल्यूटिंग स्टेंट के साथ उन्नत एंजियोप्लास्टी तकनीक\n- ट्रांसकैथेटर एओर्टिक वाल्व रिप्लेसमेंट (TAVR)\n- लीडलेस पेसमेकर इम्प्लांटेशन\n- जटिल अतालता पृथक्करण के लिए 3डी मैपिंग\n- इंट्रावास्कुलर अल्ट्रासाउंड (IVUS) निर्देशित प्रक्रियाएं\n\n**रोबोटिक और लेप्रोस्कोपिक सर्जरी**\n- सटीक ट्यूमर हटाने के लिए रोबोट-सहायता प्राप्त सर्जरी\n- सिंगल-इंसीजन लेप्रोस्कोपिक प्रक्रियाएं\n- तेजी से रिकवरी के साथ एंडोस्कोपिक स्पाइन सर्जरी\n- न्यूनतम निशान के लिए लेजर-सहायता प्राप्त सर्जरी\n\n**उन्नत कैंसर देखभाल**\n- लक्षित चिकित्सा और इम्यूनोथेरेपी प्रोटोकॉल\n- छवि-निर्देशित विकिरण चिकित्सा (IGRT)\n- ट्यूमर के उपचार के लिए साइबरनाइफ रेडियोसर्जरी\n- व्यक्तिगत कैंसर जीनोमिक्स परीक्षण\n- दर्द रहित कीमोथेरेपी वितरण प्रणाली\n\n**अत्याधुनिक निदान**\n- अल्ट्रा-हाई रेजोल्यूशन इमेजिंग के लिए 3 टेस्ला एमआरआई\n- कार्डियक और पूरे शरीर के स्कैन के लिए 256-स्लाइस सीटी स्कैनर\n- प्रारंभिक कैंसर का पता लगाने के लिए पीईटी-सीटी\n- उन्नत 4डी अल्ट्रासाउंड तकनीक\n- एआई-संचालित नैदानिक व्याख्या प्रणाली\n\n**अभिनव उपचार दृष्टिकोण**\n- कार्डियक पुनर्जनन के लिए स्टेम सेल थेरेपी\n- प्लेटलेट-रिच प्लाज्मा (पीआरपी) थेरेपी\n- गैर-सर्जिकल बॉडी कॉन्टूरिंग और एस्थेटिक प्रक्रियाएं\n- हाइपरबेरिक ऑक्सीजन थेरेपी के साथ उन्नत घाव भरना\n- सिद्ध और आधुनिक चिकित्सा को मिलाकर एकीकृत समग्र उपचार\n\n## मान्यता और उत्कृष्टता\n- **रेडियो सिटी आइकन अवार्ड 2022** हृदय देखभाल में उत्कृष्टता के लिए\n- **NABH मान्यता** रोगी देखभाल और सुरक्षा के उच्चतम मानकों को सुनिश्चित करना\n- **4.7/5 रोगी संतुष्टि रेटिंग** हजारों समीक्षाओं के आधार पर\n- कई विशिष्टताओं में **उत्कृष्टता केंद्र** का पदनाम\n\n## स्वास्थ्य सेवा शिक्षा में नवाचार\nरोगी देखभाल से परे, हम अपने संबद्ध स्वास्थ्य विज्ञान कार्यक्रमों के माध्यम से स्वास्थ्य पेशेवरों की अगली पीढ़ी का पोषण करते हैं। तमिलनाडु डॉ. एम.जी.आर. मेडिकल यूनिवर्सिटी से संबद्ध, हम कार्डियक टेक्नोलॉजी, क्रिटिकल केयर और हेल्थकेयर मैनेजमेंट में विशेष पाठ्यक्रम प्रदान करते हैं।\n\n## हमारे मूल्य, आपका विश्वास\n**दया** - हर मरीज परिवार है\n**उत्कृष्टता** - उच्चतम चिकित्सा मानकों की खोज\n**नवाचार** - उन्नत उपचारों और प्रौद्योगिकियों को अपनाना\n**अखंडता** - पारदर्शी, नैतिक स्वास्थ्य सेवा वितरण\n\n## प्रेरणा देने वाला नेतृत्व\nकार्डियोलॉजिकल सोसाइटी ऑफ इंडिया, यूरोपियन सोसाइटी ऑफ कार्डियोलॉजी और इंडियन मेडिकल एसोसिएशन के एक सक्रिय सदस्य डॉ. थिलाई वल्लाल के नेतृत्व में, हमारा अस्पताल आधुनिक चिकित्सा को समग्र कल्याण के साथ जोड़कर एकीकृत स्वास्थ्य सेवा दृष्टिकोणों में अग्रणी बना हुआ है।\n\n## आपका स्वास्थ्य, हमारी प्रतिबद्धता\nनियमित जांच से लेकर जटिल सर्जरी तक, निवारक देखभाल से लेकर आपातकालीन हस्तक्षेप तक, वेंकटेश्वर अस्पताल 24/7 आपकी सेवा के लिए तैयार है। कैशलेस बीमा सुविधाओं, सस्ती उपचार विकल्पों और रोगी-प्रथम दृष्टिकोण के साथ, हम यह सुनिश्चित करते हैं कि गुणवत्तापूर्ण स्वास्थ्य सेवा सभी के लिए सुलभ बनी रहे।\n\n**हमसे मिलें:**\n36-ए, चैमियर्स रोड, नंदनम\nचेन्नई - 600035\n(देवर प्रतिमा के पास)\n\n*जहां उपचार दिल से मिलता है, और तकनीक करुणा से मिलती है—वेंकटेश्वर अस्पताल में आपका स्वागत है, आजीवन कल्याण में आपका साथी।*';

  @override
  String get settingsTitle => 'सेटिंग्स';

  @override
  String get settingsEditProfile => 'प्रोफ़ाइल संपादित करें';

  @override
  String get settingsLanguage => 'भाषा';

  @override
  String get settingsAccessibility => 'सरल उपयोग';

  @override
  String get settingsFontSize => 'फ़ॉन्ट आकार';

  @override
  String get settingsFontSizeChanged => 'फ़ॉन्ट आकार सेट किया गया';

  @override
  String get settingsTheme => 'डार्क थीम';

  @override
  String get settingsDarkTheme => 'डार्क मोड सक्षम';

  @override
  String get settingsLightTheme => 'लाइट मोड सक्षम';

  @override
  String get settingsSecurity => 'सुरक्षा';

  @override
  String get settingsBiometricLogin => 'बायोमेट्रिक लॉगिन का उपयोग करें';

  @override
  String get settingsBiometricNotSupported =>
      'इस डिवाइस पर बायोमेट्रिक्स समर्थित नहीं है।';

  @override
  String get settingsLogout => 'लॉग आउट करें';

  @override
  String get settingsLogoutConfirmation => 'लॉग आउट करें';

  @override
  String get settingsAreYouSureLogout => 'क्या आप वाकई लॉग आउट करना चाहते हैं?';

  @override
  String get settingsConfirmLogout => 'हाँ, लॉग आउट करें';

  @override
  String get calendarFullAccess => 'मेरा स्वास्थ्य कैलेंडर';

  @override
  String get calendarPermissionDenied => 'कैलेंडर अनुमति अस्वीकृत।';

  @override
  String get calendarEnablePermissions =>
      'अपने ईवेंट देखने के लिए सेटिंग्स में कैलेंडर अनुमति सक्षम करें।';

  @override
  String get openSettings => 'सेटिंग्स खोलें';

  @override
  String get settingsPermissionsTitle => 'अनुमतियाँ';

  @override
  String get settingsPermissionCalendar => 'कैलेंडर तक पहुंच';

  @override
  String get settingsPermissionCalendarDesc =>
      'अपॉइंटमेंट और जांच दिखाने के लिए उपयोग किया जाता है';

  @override
  String get settingsPermissionLocation => 'स्थान तक पहुंच';

  @override
  String get settingsPermissionLocationDesc =>
      'SOS और आस-पास के अस्पताल खोजने के लिए उपयोग किया जाता है';

  @override
  String get settingsPermissionCamera => 'कैमरा तक पहुंच';

  @override
  String get settingsPermissionCameraDesc =>
      'नुस्खे स्कैन करने और छवियाँ अपलोड करने के लिए उपयोग किया जाता है';

  @override
  String get settingsPermissionManage => 'प्रबंधित करें';

  @override
  String get settingsPermissionGranted => 'अनुमति दी गई';

  @override
  String get settingsPermissionDenied => 'अस्वीकृत';

  @override
  String get settingsDynamicColors => 'डायनामिक थीम रंग';

  @override
  String get settingsDynamicColorsDesc =>
      'चयनित सुविधा के आधार पर ऐप के रंग अपडेट करें';

  @override
  String get settingsCurrentAccentColor => 'वर्तमान एक्सेंट रंग';

  @override
  String get settingsAccentColorDesc => 'सर्कुलर डायल से लागू किया गया';

  @override
  String get settingsResetTheme => 'थीम सेटिंग्स रीसेट करें';

  @override
  String get settingsResetThemeDesc =>
      'डिफ़ॉल्ट थीम कॉन्फ़िगरेशन पुनर्स्थापित करें';

  @override
  String get settingsResetThemeConfirm =>
      'यह थीम मोड, फ़ॉन्ट आकार और डायनामिक रंगों को डिफ़ॉल्ट पर रीसेट कर देगा।';

  @override
  String get settingsThemeResetSuccess =>
      'थीम सेटिंग्स डिफ़ॉल्ट पर रीसेट हो गईं';

  @override
  String get commonResetButton => 'रीसेट';

  @override
  String get refreshCalendar => 'ईवेंट ताज़ा करें';

  @override
  String get calendarLoadFailed => 'कैलेंडर ईवेंट लोड करने में असमर्थ।';

  @override
  String get selectDayPrompt => 'ईवेंट देखने के लिए एक दिन चुनें';

  @override
  String get noEventsForDay => 'इस दिन के लिए कोई ईवेंट नहीं है';

  @override
  String get unknownEvent => 'अज्ञात ईवेंट';

  @override
  String get eventTypesAppointment => 'अपॉइंटमेंट';

  @override
  String get eventTypesInvestigation => 'जांच';

  @override
  String get eventTypesPharmacyOrder => 'फार्मेसी ऑर्डर';

  @override
  String get feedbackPhoneNumber => 'फ़ोन नंबर';

  @override
  String get feedbackPlaceholder => 'अपना प्रश्न यहाँ टाइप करें';

  @override
  String get feedbackHint =>
      'उदाहरण: क्या मुझे सर्जरी के बाद अपनी दवा जारी रखनी चाहिए?';

  @override
  String get questionCannotBeEmpty => 'प्रश्न खाली नहीं हो सकता।';

  @override
  String get submit => 'सबमिट करें';

  @override
  String get feedbackSuccess =>
      'आपका प्रश्न भेज दिया गया है! हमारी टीम जल्द ही जवाब देगी।';

  @override
  String get feedbackFailed =>
      'आपका प्रश्न नहीं भेज सका। कृपया पुनः प्रयास करें।';

  @override
  String get notifications => 'सूचनाएं';

  @override
  String get failedToFetchNotifications =>
      'सूचनाएं प्राप्त करने में असमर्थ। कृपया ताज़ा करने के लिए खींचें।';

  @override
  String get errorFetchingNotifications =>
      'सूचनाएं प्राप्त करते समय नेटवर्क त्रुटि।';

  @override
  String get noNotifications => 'आपके पास कोई सूचना नहीं है।';

  @override
  String get notificationMarkedAsRead => 'सूचना पढ़ी गई के रूप में चिह्नित';

  @override
  String get notification => 'सूचना';

  @override
  String get downloadPermissionDenied =>
      'फ़ाइलें डाउनलोड करने के लिए संग्रहण अनुमति आवश्यक है।';

  @override
  String get yourHealthTabRecords => 'रिकॉर्ड';

  @override
  String get yourHealthTabConsultations => 'परामर्श';

  @override
  String get yourHealthTabSummary => 'सारांश';

  @override
  String get consultationDoctor => 'डॉक्टर';

  @override
  String get consultationDiagnosis => 'निदान';

  @override
  String get consultationNotes => 'टिप्पणियाँ';

  @override
  String get consultationDate => 'तारीख';

  @override
  String get consultationsEmpty => 'कोई परामर्श नहीं मिला';

  @override
  String get summaryAllergies => 'एलर्जी';

  @override
  String get summaryConditions => 'स्थितियाँ';

  @override
  String get summaryOverview => 'स्वास्थ्य अवलोकन';

  @override
  String get summaryNoAllergies => 'कोई ज्ञात एलर्जी नहीं';

  @override
  String get summaryNoConditions => 'कोई ज्ञात स्थिति नहीं';

  @override
  String get summaryNoData => 'कोई स्वास्थ्य सारांश उपलब्ध नहीं';

  @override
  String get investigationsResultsTitle => 'जाँच परिणाम';

  @override
  String get investigationsTabUpload => 'अपलोड';

  @override
  String get investigationsTabResults => 'परिणाम';

  @override
  String get investigationsStatusPending => 'लंबित';

  @override
  String get investigationsStatusCompleted => 'पूर्ण';

  @override
  String get investigationsNoResults => 'अभी तक कोई जाँच परिणाम नहीं';

  @override
  String get investigationsDownloadReport => 'रिपोर्ट डाउनलोड करें';

  @override
  String get investigationsDownloadFailed => 'रिपोर्ट डाउनलोड करने में विफल';

  @override
  String get investigationsFiles => 'फ़ाइलें';

  @override
  String get profileIncomplete =>
      'जारी रखने के लिए कृपया अपनी प्रोफ़ाइल पूरी करें';

  @override
  String get vitalsTitle => 'महत्वपूर्ण संकेत';

  @override
  String get vitalsLogTab => 'रिकॉर्ड करें';

  @override
  String get vitalsHistoryTab => 'इतिहास';

  @override
  String get vitalsLogHeading => 'अपने दैनिक महत्वपूर्ण संकेत दर्ज करें';

  @override
  String get vitalsLogSubheading =>
      'आज जो भी संकेत आप रिकॉर्ड करना चाहते हैं, उन्हें भरें।';

  @override
  String get vitalsBloodPressure => 'रक्तचाप';

  @override
  String get vitalsSystolic => 'सिस्टोलिक';

  @override
  String get vitalsDiastolic => 'डायस्टोलिक';

  @override
  String get vitalsHeartRate => 'हृदय गति';

  @override
  String get vitalsTemperature => 'तापमान';

  @override
  String get vitalsBloodSugar => 'रक्त शर्करा';

  @override
  String get vitalsWeight => 'वज़न';

  @override
  String get vitalsSpO2 => 'SpO2';

  @override
  String get vitalsRecordButton => 'रिकॉर्ड करें';

  @override
  String get vitalsSubmitting => 'सबमिट किया जा रहा है...';

  @override
  String get vitalsRecordedSuccess =>
      'महत्वपूर्ण संकेत सफलतापूर्वक रिकॉर्ड किए गए';

  @override
  String get vitalsRecordFailed => 'महत्वपूर्ण संकेत रिकॉर्ड करने में विफल';

  @override
  String get vitalsAtLeastOne => 'कृपया कम से कम एक महत्वपूर्ण संकेत दर्ज करें';

  @override
  String get vitalsNoHistory => 'अभी तक कोई रिकॉर्ड नहीं';

  @override
  String get vitalsNoHistoryHint =>
      'रिकॉर्ड करें टैब का उपयोग करके अपने महत्वपूर्ण संकेत दर्ज करें।';

  @override
  String get vitalsHistoryFailed => 'महत्वपूर्ण संकेत इतिहास लोड करने में विफल';

  @override
  String get familyTitle => 'परिवार के सदस्य';

  @override
  String get familyYourFamily => 'आपका परिवार';

  @override
  String get familyManageHint =>
      'अपने खाते से जुड़े परिवार के सदस्यों का प्रबंधन करें।';

  @override
  String get familyNoMembers => 'अभी तक कोई परिवार का सदस्य नहीं';

  @override
  String get familyNoMembersHint =>
      'साझा देखभाल प्रबंधित करने के लिए परिवार के सदस्य जोड़ें।';

  @override
  String get familyAddMember => 'परिवार का सदस्य जोड़ें';

  @override
  String get familyFullName => 'पूरा नाम';

  @override
  String get familyPhone => 'फोन नंबर';

  @override
  String get familyRelationship => 'रिश्ता';

  @override
  String get familyDateOfBirth => 'जन्म तिथि (वैकल्पिक)';

  @override
  String get familyAdding => 'जोड़ा जा रहा है...';

  @override
  String get familyAddedSuccess => 'परिवार का सदस्य सफलतापूर्वक जोड़ा गया';

  @override
  String get familyAddFailed => 'परिवार का सदस्य जोड़ने में विफल';

  @override
  String get familyRemoveTitle => 'परिवार का सदस्य हटाएँ';

  @override
  String familyRemoveConfirm(String name) {
    return 'क्या आप वाकई $name को हटाना चाहते हैं?';
  }

  @override
  String familyRemoved(String name) {
    return '$name को परिवार के सदस्यों से हटा दिया गया';
  }

  @override
  String get familyRemoveFailed => 'सदस्य हटाने में विफल';

  @override
  String get refillTitle => 'प्रिस्क्रिप्शन रिफिल';

  @override
  String get refillActivePrescriptions => 'सक्रिय प्रिस्क्रिप्शन';

  @override
  String get refillHint =>
      'नवीनीकरण के लिए डॉक्टर से अनुरोध करने के लिए \"रिफिल अनुरोध करें\" पर टैप करें।';

  @override
  String get refillNoActive => 'कोई सक्रिय प्रिस्क्रिप्शन नहीं';

  @override
  String get refillNoActiveHint =>
      'परामर्श से आपके प्रिस्क्रिप्शन यहाँ दिखाई देंगे।';

  @override
  String get refillRequestButton => 'रिफिल अनुरोध करें';

  @override
  String get refillRequesting => 'अनुरोध किया जा रहा है...';

  @override
  String get refillRetry => 'रिफिल अनुरोध फिर से करें';

  @override
  String get refillConfirmTitle => 'रिफिल अनुरोध करें';

  @override
  String refillConfirmBody(String medication) {
    return '$medication के लिए रिफिल का अनुरोध करें?';
  }

  @override
  String refillRequested(String medication) {
    return '$medication के लिए रिफिल का अनुरोध किया गया';
  }

  @override
  String get refillRequestFailed => 'रिफिल अनुरोध करने में विफल';

  @override
  String get refillStatusActive => 'सक्रिय';

  @override
  String get refillStatusExpired => 'समाप्त';

  @override
  String get stepsTitle => 'कदम चुनौती';

  @override
  String get stepsProfile => 'प्रोफ़ाइल';

  @override
  String get stepsHistory => 'इतिहास';

  @override
  String get stepsLeaderboard => 'लीडरबोर्ड';

  @override
  String get stepsRewards => 'पुरस्कार';

  @override
  String get stepsStartWalk => 'चलना शुरू करें';

  @override
  String get stepsStopWalk => 'चलना बंद करें';

  @override
  String get stepsSessionStarted => 'वॉक सत्र शुरू हुआ';

  @override
  String get stepsSessionStopped => 'वॉक पूरा हुआ!';

  @override
  String get stepsNoHistory => 'अभी तक कोई वॉक सत्र नहीं';

  @override
  String get stepsNoHistoryHint =>
      'अपने कदमों को ट्रैक करना शुरू करने के लिए वॉक शुरू करें।';

  @override
  String get abdmTitle => 'ABDM (आयुष्मान भारत)';

  @override
  String get abdmRegister => 'ABHA पंजीकृत करें';

  @override
  String get abdmVerify => 'ABHA सत्यापित करें';

  @override
  String get abdmConsents => 'सहमतियाँ';

  @override
  String get abdmNoConsents => 'कोई सहमति अनुरोध नहीं';

  @override
  String get medicationRemindersTitle => 'दवा रिमाइंडर';

  @override
  String get medicationReminderAdd => 'रिमाइंडर जोड़ें';

  @override
  String get medicationReminderName => 'दवा का नाम';

  @override
  String get medicationReminderDosage => 'खुराक';

  @override
  String get medicationReminderFrequency => 'आवृत्ति';

  @override
  String get medicationReminderNoReminders => 'कोई दवा रिमाइंडर सेट नहीं';

  @override
  String get updateAvailableTitle => 'अपडेट उपलब्ध';

  @override
  String get updateAvailableBody =>
      'VH Health का नया संस्करण उपलब्ध है। कृपया बेहतर अनुभव के लिए अपडेट करें।';

  @override
  String get updateNow => 'अभी अपडेट करें';

  @override
  String get updateLater => 'बाद में';

  @override
  String get bookInvestigationTitle => 'जाँच बुक करें';

  @override
  String get bookInvestigationStepChoose => 'जाँच चुनें';

  @override
  String get bookInvestigationStepCollection => 'संग्रह वरीयता';

  @override
  String get bookInvestigationStepReview => 'समीक्षा और बुक करें';

  @override
  String get bookInvestigationOrType => 'या जाँच के नाम लिखें:';

  @override
  String get bookInvestigationOrUploadSlip =>
      'या प्रिस्क्रिप्शन स्लिप अपलोड करें:';

  @override
  String get bookInvestigationEstimatedCost => 'अनुमानित लागत';

  @override
  String get bookInvestigationHomeCollection => 'घर पर संग्रह';

  @override
  String get bookInvestigationVisitLab => 'लैब में जाएँ';

  @override
  String get bookInvestigationTapToSelect => 'चुनने के लिए टैप करें';

  @override
  String get bookInvestigationPreferredTimeSlot => 'पसंदीदा समय स्लॉट';

  @override
  String get bookInvestigationReviewBooking => 'अपनी बुकिंग की समीक्षा करें';

  @override
  String get bookInvestigationSelectedTests => 'चुनी गई जाँच:';

  @override
  String get bookInvestigationCustomTests => 'कस्टम जाँच:';

  @override
  String get bookInvestigationSlipAttached => 'प्रिस्क्रिप्शन स्लिप संलग्न';

  @override
  String get bookInvestigationBooked => 'जाँच बुक हो गई!';

  @override
  String get bookInvestigationConfirmationNote =>
      'आपको जल्द ही पुष्टिकरण कॉल प्राप्त होगी।\nहम आपको बुकिंग की स्थिति पर अपडेट करते रहेंगे।';

  @override
  String get bookInvestigationBackButton => 'जाँच पर वापस जाएँ';

  @override
  String get stepsSetupProfileTitle => 'अपनी प्रोफ़ाइल सेट करें';

  @override
  String get stepsPickColor => 'एक रंग चुनें:';

  @override
  String get stepsSaveProfile => 'प्रोफ़ाइल सहेजें';

  @override
  String get stepsStartWalkUpper => 'चलना शुरू करें';

  @override
  String get stepsWalkInProgress => 'चलना जारी है…';

  @override
  String get stepsStopWalkUpper => 'चलना बंद करें';

  @override
  String get stepsNoDailyData => 'अभी तक कोई दैनिक डेटा नहीं';

  @override
  String get stepsNoWeeklyData => 'अभी तक कोई साप्ताहिक डेटा नहीं';

  @override
  String get stepsNoMonthlyData => 'अभी तक कोई मासिक डेटा नहीं';

  @override
  String get stepsThisMonth => 'इस महीने';

  @override
  String get stepsNoLeaderboardData => 'अभी तक कोई लीडरबोर्ड डेटा नहीं';

  @override
  String get stepsYourRewards => 'आपके पुरस्कार';

  @override
  String get familyMemberIdNotFound => 'सदस्य ID नहीं मिली';

  @override
  String get familyRemoveFailedRetry =>
      'सदस्य हटाने में विफल। कृपया पुनः प्रयास करें।';

  @override
  String get familyAddFailedRetry =>
      'परिवार का सदस्य जोड़ने में विफल। कृपया पुनः प्रयास करें।';

  @override
  String get familyRemoveButton => 'हटाएँ';

  @override
  String get familyRemoveTooltip => 'सदस्य हटाएँ';

  @override
  String get familyRetryButton => 'पुनः प्रयास करें';

  @override
  String get familyAddMemberShort => 'सदस्य जोड़ें';

  @override
  String get familyTapToSelect => 'चुनने के लिए टैप करें';

  @override
  String get familyDobPrefix => 'जन्म तिथि:';

  @override
  String get familyNameRequired => 'नाम आवश्यक है';

  @override
  String get familyPhoneRequired => 'फ़ोन नंबर आवश्यक है';

  @override
  String get familyPhoneInvalid => 'एक मान्य फ़ोन नंबर दर्ज करें';

  @override
  String get familyLoadFailed => 'परिवार के सदस्य लोड करने में विफल';

  @override
  String get familyUnknown => 'अज्ञात';

  @override
  String get recordsDocumentUrlMissing => 'दस्तावेज़ URL उपलब्ध नहीं';

  @override
  String get recordsDeleteTitle => 'रिकॉर्ड हटाएँ?';

  @override
  String get recordsDeletePrefix => 'हटाएँ ';

  @override
  String get recordsDeleted => 'रिकॉर्ड हटा दिया गया';

  @override
  String get recordsPickFileFirst => 'कृपया एक फ़ाइल चुनें और शीर्षक दर्ज करें';

  @override
  String get recordsUploaded => 'रिकॉर्ड अपलोड किया गया';

  @override
  String get recordsUploadButton => 'रिकॉर्ड अपलोड करें';

  @override
  String get recordsHospitalEmpty =>
      'विज़िट से आपके प्रिस्क्रिप्शन और रिपोर्ट यहाँ दिखाई देंगे';

  @override
  String get recordsUploadEmptyHint =>
      'अपने पिछले प्रिस्क्रिप्शन और रिपोर्ट एक ही जगह रखने के लिए अपलोड करें';

  @override
  String get recordsUploadSheetTitle => 'रिकॉर्ड अपलोड करें';

  @override
  String get abdmHeading => 'आयुष्मान भारत हेल्थ अकाउंट';

  @override
  String get abdmDescription =>
      'ABHA (आयुष्मान भारत हेल्थ अकाउंट) एक विशिष्ट हेल्थ ID है जो आपको अपने स्वास्थ्य रिकॉर्ड को डिजिटल रूप से संग्रहीत और साझा करने देती है।';

  @override
  String get abdmDataSecurityNote =>
      'आपका डेटा सुरक्षित रहता है और केवल आपकी सहमति से ही साझा किया जाता है।';

  @override
  String get abdmYourNumber => 'आपका ABHA नंबर';

  @override
  String get abdmVerifyHeading => 'अपना ABHA सत्यापित करें';

  @override
  String get abdmEnterOtp => 'अपने मोबाइल नंबर पर भेजा गया OTP दर्ज करें';

  @override
  String get medicationRemindersEmpty => 'अभी तक कोई दवा रिमाइंडर नहीं';

  @override
  String get medicationRemindersEmptyHint => 'जोड़ने के लिए + टैप करें';

  @override
  String get medicationReminderRequiredFields =>
      'दवा का नाम और खुराक आवश्यक हैं';

  @override
  String get medicationReminderSaveFailed => 'रिमाइंडर सहेजने में असमर्थ';

  @override
  String get medicationReminderAddSheetTitle => 'दवा रिमाइंडर जोड़ें';

  @override
  String get medicationReminderTimes => 'रिमाइंडर समय';

  @override
  String get medicationReminderAddTime => 'समय जोड़ें';

  @override
  String get medicationReminderSave => 'रिमाइंडर सहेजें';

  @override
  String get pharmacyTakePhoto => 'फोटो लें';

  @override
  String get pharmacyChooseFromGallery => 'गैलरी से चुनें';

  @override
  String get pharmacyOrderPlacedTitle => 'ऑर्डर हो गया!';

  @override
  String get pharmacyOrderPlacedBody =>
      'हमारे फार्मासिस्ट आपके प्रिस्क्रिप्शन की समीक्षा करेंगे और जल्द ही आपके ऑर्डर की पुष्टि करेंगे।';

  @override
  String get pharmacyUploadHeading => 'प्रिस्क्रिप्शन अपलोड करें';

  @override
  String get pharmacyTapToUpload => 'प्रिस्क्रिप्शन अपलोड करने के लिए टैप करें';

  @override
  String get pharmacyCameraOrGallery => 'कैमरा या गैलरी';

  @override
  String get pharmacyOrDescribe => 'या अपना ऑर्डर लिखें';

  @override
  String get pharmacyDeliveryPreference => 'डिलीवरी वरीयता';

  @override
  String get refillPrescriptionIdMissing => 'प्रिस्क्रिप्शन ID नहीं मिली';

  @override
  String get refillRequestRetry =>
      'रिफिल अनुरोध करने में विफल। कृपया पुनः प्रयास करें।';

  @override
  String get refillTapPrefix => 'टैप करें ';

  @override
  String get refillRequestedHeading => 'रिफिल अनुरोध किया गया';

  @override
  String get vitalsTrendsHeading => 'पिछले माप के मुक़ाबले रुझान';

  @override
  String get vitalsRecordFailedRetry =>
      'महत्वपूर्ण संकेत रिकॉर्ड करने में विफल। कृपया पुनः प्रयास करें।';

  @override
  String get yourHealthPrescriptionsEmpty => 'अभी तक कोई प्रिस्क्रिप्शन नहीं';

  @override
  String get yourHealthPrescriptionsEmptyHint =>
      'आपके डॉक्टर के प्रिस्क्रिप्शन यहाँ दिखाई देंगे';

  @override
  String get yourHealthClinicalNotes => 'क्लिनिकल टिप्पणियाँ';

  @override
  String get yourHealthDownloadPdf => 'PDF डाउनलोड करें';

  @override
  String get yourHealthOrderMedicines => 'दवाएँ ऑर्डर करें';

  @override
  String get yourHealthPlaceOrder => 'ऑर्डर करें';

  @override
  String get yourHealthSafetyNotes => 'सुरक्षा टिप्पणियाँ';

  @override
  String get yourHealthClinicianOverride => 'फ़ाइल में चिकित्सक का ओवरराइड:';

  @override
  String get yourHealthTabExplanations => 'व्याख्याएँ';

  @override
  String get yourHealthExplanationsDetailTitle => 'व्याख्या';

  @override
  String get yourHealthExplanationsReviewedLabel => 'समीक्षित';

  @override
  String get yourHealthExplanationsSummary => 'सारांश';

  @override
  String get yourHealthExplanationsKeyPoints => 'मुख्य बातें';

  @override
  String get yourHealthExplanationsNextSteps => 'अगले कदम';

  @override
  String get yourHealthExplanationsWhenToSeekHelp => 'कब मदद लें';

  @override
  String get yourHealthExplanationsSafetyTitle => 'समीक्षा संकेत';

  @override
  String get yourHealthExplanationsSafetyBody =>
      'आपकी देखभाल टीम ने इस व्याख्या पर अतिरिक्त ध्यान देने के लिए चिह्नित किया है। नीचे दिए गए मार्गदर्शन का पालन करें और लक्षण बिगड़ने पर अस्पताल से संपर्क करें।';

  @override
  String get yourHealthExplanationsNoSummary => 'कोई विवरण उपलब्ध नहीं है';

  @override
  String get yourHealthExplanationsLoadFailed => 'यह व्याख्या लोड नहीं हो सकी।';

  @override
  String get yourHealthExplanationsRetry => 'पुनः प्रयास करें';

  @override
  String get yourHealthExplanationsEmpty => 'अभी तक कोई समीक्षित व्याख्या नहीं';

  @override
  String get appointmentsCancel => 'अपॉइंटमेंट रद्द करें';

  @override
  String get appointmentsConfirmCancel => 'हाँ, रद्द करें';

  @override
  String get appointmentsSelectTimeSlot => 'समय स्लॉट चुनें';

  @override
  String get appointmentsLogOutAndBack =>
      'अपने अपॉइंटमेंट देखने के लिए कृपया लॉग आउट करके दोबारा लॉग इन करें।';

  @override
  String get appointmentsEmpty => 'अभी तक कोई अपॉइंटमेंट नहीं';

  @override
  String get appointmentsBookOneNow => 'अभी एक बुक करें';

  @override
  String get appointmentsViewPrescription => 'प्रिस्क्रिप्शन देखें';

  @override
  String get symptomCheckerTitle => 'लक्षण जाँच';

  @override
  String get symptomCheckerDescribePrompt => 'बताएँ आप कैसा महसूस कर रहे हैं';

  @override
  String get symptomCheckerRedFlags => 'गंभीर संकेत';

  @override
  String get symptomCheckerPossibleCauses => 'संभावित कारण';

  @override
  String get symptomCheckerBookAppointment => 'अपॉइंटमेंट बुक करें';

  @override
  String get symptomCheckerDisclaimer =>
      'ट्राइएज परिणाम AI-सहायता प्राप्त है और चिकित्सकीय निदान नहीं है। हमेशा योग्य चिकित्सक से सलाह लें।';

  @override
  String get checkinSaveFailed =>
      'चेक-इन सहेजा नहीं जा सका। कृपया पुनः प्रयास करें।';

  @override
  String get checkinTitle => 'दैनिक चेक-इन';

  @override
  String get checkinHowFeeling => 'आज आप कैसा महसूस कर रहे हैं?';

  @override
  String get checkinQuickVitals => 'त्वरित संकेत (वैकल्पिक)';

  @override
  String get checkinSaveButton => 'चेक-इन सहेजें  ·  +10 अंक';

  @override
  String get checkinSavedToast => '+10 हेल्थ पॉइंट जोड़े गए। कल मिलते हैं!';

  @override
  String get settingsHealthIdLabel => 'हेल्थ ID (ABHA)';

  @override
  String get settingsHealthIdSubtitle => 'आयुष्मान भारत हेल्थ अकाउंट';

  @override
  String get settingsConnectWearables => 'वियरेबल कनेक्ट करें';

  @override
  String get settingsConnectWearablesSubtitle =>
      'Apple Health / Google Health Connect से कदम, हृदय गति, SpO₂ सिंक करें';

  @override
  String get settingsHealthPermissionsDenied => 'हेल्थ अनुमतियाँ नहीं दी गईं';

  @override
  String get settingsSyncingHealth => 'हेल्थ डेटा सिंक हो रहा है…';

  @override
  String get otpVerifyPhoneHeading => 'अपना फ़ोन नंबर सत्यापित करें';

  @override
  String get otpEnterDigits => 'इस नंबर पर भेजा गया 6-अंकीय OTP दर्ज करें';

  @override
  String get otpVerifyButtonText => 'OTP सत्यापित करें';

  @override
  String get otpResendingOtp => 'OTP फिर से भेजा जा रहा है...';

  @override
  String get otpSentSuccess => 'OTP आपके फ़ोन नंबर पर भेज दिया गया है';

  @override
  String get dashboardScheduleNextVisit => 'अपनी अगली विज़िट शेड्यूल करें';

  @override
  String get dashboardStayOnTop => 'अपने स्वास्थ्य पर ध्यान दें';

  @override
  String get dashboardBookNow => 'अभी बुक करें';

  @override
  String get dashboardLastVisit => 'पिछली विज़िट';

  @override
  String get dashboardNextVisit => 'अगली विज़िट';

  @override
  String get dashboardLastVisitColon => 'पिछली:';

  @override
  String get dashboardNextVisitColon => 'अगली:';

  @override
  String get dashboardToggleTheme => 'थीम बदलें';

  @override
  String get dashboardToggleFontSize => 'फ़ॉन्ट आकार बदलें';

  @override
  String get dashboardHealthPoints => 'हेल्थ पॉइंट';

  @override
  String get dashboardWellnessScore => 'वेलनेस स्कोर';

  @override
  String get dashboardLastVisitTitle => 'पिछली विज़िट';

  @override
  String get dashboardNextVisitTitle => 'अगली विज़िट';

  @override
  String get investigationsFileTooLarge =>
      'फ़ाइल बहुत बड़ी है। अधिकतम आकार 10 MB है।';

  @override
  String get investigationsViewDownloadReport => 'रिपोर्ट देखें / डाउनलोड करें';

  @override
  String get investigationsBookButton => 'जाँच बुक करें';

  @override
  String get investigationsNoFiles => 'कोई फ़ाइल उपलब्ध नहीं';

  @override
  String get myBookingsSlipAttached => 'प्रिस्क्रिप्शन स्लिप संलग्न';

  @override
  String get myBookingsDownloadResult => 'परिणाम डाउनलोड करें';

  @override
  String get pharmacyOrderNote => 'ऑर्डर नोट';

  @override
  String get pharmacyDeliveryInfo => 'डिलीवरी जानकारी';

  @override
  String get pharmacyOrdersEmpty => 'अभी तक कोई ऑर्डर नहीं';

  @override
  String get pharmacyOrdersEmptyHint => 'ऑर्डर टैब से अपना पहला ऑर्डर करें';

  @override
  String get pharmacyOrderCancelled => 'ऑर्डर रद्द';

  @override
  String get splashDeviceNotSupported => 'डिवाइस समर्थित नहीं';

  @override
  String get splashDeviceNotSupportedBody =>
      'आपकी सुरक्षा के लिए, VH Health इस डिवाइस पर नहीं चल सकता। कारण:';

  @override
  String get splashAppName => 'VH Health';

  @override
  String get splashTapAnywhere => 'जारी रखने के लिए कहीं भी टैप करें';

  @override
  String get gamificationRewardClaimed => 'पुरस्कार प्राप्त!';

  @override
  String get gamificationVoucherCode => 'आपका वाउचर कोड:';

  @override
  String get gamificationVoucherCopied => 'वाउचर कोड कॉपी किया गया!';

  @override
  String get gamificationCouldNotShare => 'अभी साझा नहीं किया जा सका';

  @override
  String get gamificationShareSubtitle =>
      'अपनी प्रगति परिवार और दोस्तों के साथ साझा करें';

  @override
  String get gamificationLoadFailed => 'आपके अंक का सारांश लोड नहीं हो सका';

  @override
  String get gamificationHowToEarn => 'अंक कैसे अर्जित करें';

  @override
  String get gamificationCompleteMilestones =>
      'पुरस्कार पाने के लिए माइलस्टोन पूरे करें!';

  @override
  String get gamificationNoPointHistory => 'अभी तक कोई अंक इतिहास नहीं';

  @override
  String get gamificationNoMilestones => 'अभी तक कोई माइलस्टोन उपलब्ध नहीं';

  @override
  String get stepsShareCardTitle => 'VH Health कदम चुनौती';

  @override
  String get stepsShareCardSubtitle => 'वेंकटेश्वर अस्पताल, चेन्नई';

  @override
  String get stepsShareCardFooter => 'VH Health ऐप';

  @override
  String get documentOpening => 'दस्तावेज़ खोला जा रहा है...';

  @override
  String get documentCouldNotOpen => 'दस्तावेज़ नहीं खोला जा सका';

  @override
  String get permissionsNotNow => 'अभी नहीं';

  @override
  String get permissionsOpenSettings => 'सेटिंग्स खोलें';

  @override
  String get feedbackRateExperience => 'अपने अनुभव को रेट करें';

  @override
  String get feedbackSubmitButton => 'फ़ीडबैक सबमिट करें';

  @override
  String get feedbackHistoryTitle => 'मेरा फ़ीडबैक';

  @override
  String get logoutConfirmTitle => 'लॉगआउट की पुष्टि करें';

  @override
  String get logoutConfirmBody => 'क्या आप वाकई लॉगआउट करना चाहते हैं?';

  @override
  String get aboutHospitalName => 'वेंकटेश्वर अस्पताल';

  @override
  String get aboutOpenInMaps => 'Google Maps में खोलने के लिए टैप करें →';

  @override
  String get departmentsConsultationFee => 'परामर्श शुल्क';

  @override
  String get departmentsNoDoctors => 'इस विभाग में कोई डॉक्टर उपलब्ध नहीं';

  @override
  String get circularDialNoFeatures => 'कोई सुविधा उपलब्ध नहीं';

  @override
  String get deliveryYourLocation => 'आपका स्थान';

  @override
  String get authDevLoginSkipOtp => 'डेव लॉगिन (OTP छोड़ें)';

  @override
  String get permissionGateSettingUp => 'सेट किया जा रहा है...';

  @override
  String get yourHealthUploadRecord => 'रिकॉर्ड अपलोड करें';
}
