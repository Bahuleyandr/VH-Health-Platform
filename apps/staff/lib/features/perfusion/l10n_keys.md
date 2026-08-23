# Perfusion module — new AppStrings keys

Coordinator: add these to `lib/l10n/app_strings.dart` (getter + all five locale
maps) before the suite runs. Getter names are referenced from
`lib/features/perfusion/screens/perfusion_record_screen.dart`.

`perfusion.finalize_blocked` en copy is the **server refusal verbatim**
(`PERFUSION_SIGNOFF_REVIEWS_REQUIRED` in
`apps/backend/src/services/theatre/ctvsPerfusionService.js`) and is pinned by
`test/features/perfusion/perfusion_record_test.dart` — do not reword the en
value.

hi is first-pass reviewed register; ta/te/ml are first-pass machine
translation — flag for the next clinician translator pass (same status policy
as the file header documents).

## Getters

| getter | key |
|---|---|
| perfusionTitle | perfusion.title |
| perfusionCaseRefLabel | perfusion.case_ref |
| perfusionRecordsHeader | perfusion.records_header |
| perfusionNewEntryHeader | perfusion.new_entry_header |
| perfusionBypassStartedLabel | perfusion.bypass_started |
| perfusionBypassEndedLabel | perfusion.bypass_ended |
| perfusionClampStartedLabel | perfusion.clamp_started |
| perfusionClampEndedLabel | perfusion.clamp_ended |
| perfusionActBaselineLabel | perfusion.act_baseline |
| perfusionActPeakLabel | perfusion.act_peak |
| perfusionActLastLabel | perfusion.act_last |
| perfusionTempMinLabel | perfusion.temp_min |
| perfusionTempMaxLabel | perfusion.temp_max |
| perfusionComplicationsLabel | perfusion.complications |
| perfusionSavedMessage | perfusion.saved |
| perfusionDeviceLinksHeader | perfusion.device_links_header |
| perfusionDeviceAssociationIdLabel | perfusion.device_association_id |
| perfusionVendorDocumentRefLabel | perfusion.vendor_document_ref |
| perfusionSignoffAction | perfusion.signoff_action |
| perfusionFinalizeAction | perfusion.finalize_action |
| perfusionSignoffConfirmBody | perfusion.signoff_confirm_body |
| perfusionFinalizeConfirmBody | perfusion.finalize_confirm_body |
| perfusionFinalizeBlockedMessage | perfusion.finalize_blocked |
| perfusionFinalizedReadOnlyBanner | perfusion.finalized_readonly |

## Values (key | en | hi | ta | te | ml)

| key | en | hi | ta | te | ml |
|---|---|---|---|---|---|
| perfusion.title | CTVS Perfusion | CTVS परफ़्यूज़न | CTVS பர்ஃப்யூஷன் | CTVS పెర్ఫ్యూజన్ | CTVS പെർഫ്യൂഷൻ |
| perfusion.case_ref | Theatre case ID | थिएटर केस ID | தியேட்டர் கேஸ் ID | థియేటర్ కేసు ID | തിയേറ്റർ കേസ് ID |
| perfusion.records_header | Perfusion records | परफ़्यूज़न रिकॉर्ड | பர்ஃப்யூஷன் பதிவுகள் | పెర్ఫ్యూజన్ రికార్డులు | പെർഫ്യൂഷൻ രേഖകൾ |
| perfusion.new_entry_header | New perfusion entry | नई परफ़्यूज़न प्रविष्टि | புதிய பர்ஃப்யூஷன் பதிவு | కొత్త పెర్ఫ్యూజన్ నమోదు | പുതിയ പെർഫ്യൂഷൻ എൻട്രി |
| perfusion.bypass_started | Bypass started at | बाईपास प्रारंभ समय | பைபாஸ் தொடங்கிய நேரம் | బైపాస్ ప్రారంభ సమయం | ബൈപ്പാസ് തുടങ്ങിയ സമയം |
| perfusion.bypass_ended | Bypass ended at | बाईपास समाप्ति समय | பைபாஸ் முடிந்த நேரம் | బైపాస్ ముగింపు సమయం | ബൈപ്പാസ് അവസാനിച്ച സമയം |
| perfusion.clamp_started | Cross-clamp started at | क्रॉस-क्लैम्प प्रारंभ समय | கிராஸ்-கிளாம்ப் தொடங்கிய நேரம் | క్రాస్-క్లాంప్ ప్రారంభ సమయం | ക്രോസ്-ക്ലാമ്പ് തുടങ്ങിയ സമയം |
| perfusion.clamp_ended | Cross-clamp ended at | क्रॉस-क्लैम्प समाप्ति समय | கிராஸ்-கிளாம்ப் முடிந்த நேரம் | క్రాస్-క్లాంప్ ముగింపు సమయం | ക്രോസ്-ക്ലാമ്പ് അവസാനിച്ച സമയം |
| perfusion.act_baseline | ACT baseline (seconds) | ACT बेसलाइन (सेकंड) | ACT அடிப்படை (வினாடிகள்) | ACT బేస్‌లైన్ (సెకన్లు) | ACT ബേസ്‌ലൈൻ (സെക്കൻഡ്) |
| perfusion.act_peak | ACT peak (seconds) | ACT उच्चतम (सेकंड) | ACT உச்சம் (வினாடிகள்) | ACT గరిష్ఠం (సెకన్లు) | ACT ഉയർന്നത് (സെക്കൻഡ്) |
| perfusion.act_last | ACT last (seconds) | ACT अंतिम (सेकंड) | ACT கடைசி (வினாடிகள்) | ACT చివరిది (సెకన్లు) | ACT അവസാനത്തേത് (സെക്കൻഡ്) |
| perfusion.temp_min | Lowest temperature (°C) | न्यूनतम तापमान (°C) | குறைந்தபட்ச வெப்பநிலை (°C) | కనిష్ఠ ఉష్ణోగ్రత (°C) | ഏറ്റവും കുറഞ്ഞ താപനില (°C) |
| perfusion.temp_max | Highest temperature (°C) | अधिकतम तापमान (°C) | அதிகபட்ச வெப்பநிலை (°C) | గరిష్ఠ ఉష్ణోగ్రత (°C) | ഏറ്റവും കൂടിയ താപനില (°C) |
| perfusion.complications | Complications | जटिलताएँ | சிக்கல்கள் | సమస్యలు | സങ്കീർണതകൾ |
| perfusion.saved | Saved | सहेजा गया | சேமிக்கப்பட்டது | సేవ్ చేయబడింది | സേവ് ചെയ്തു |
| perfusion.device_links_header | Device links | डिवाइस लिंक | சாதன இணைப்புகள் | పరికర లింకులు | ഉപകരണ ലിങ്കുകൾ |
| perfusion.device_association_id | Device-patient association ID | डिवाइस-रोगी एसोसिएशन ID | சாதனம்-நோயாளி இணைப்பு ID | పరికరం-రోగి అసోసియేషన్ ID | ഉപകരണ-രോഗി അസോസിയേഷൻ ID |
| perfusion.vendor_document_ref | Vendor document reference | वेंडर दस्तावेज़ संदर्भ | விற்பனையாளர் ஆவணக் குறிப்பு | విక్రేత పత్ర సూచన | വെൻഡർ രേഖാ റഫറൻസ് |
| perfusion.signoff_action | Sign off | साइन ऑफ़ | கையொப்பமிடு | సైన్ ఆఫ్ | സൈൻ ഓഫ് |
| perfusion.finalize_action | Finalize | अंतिम रूप दें | இறுதிசெய் | ఖరారు చేయండి | അന്തിമമാക്കുക |
| perfusion.signoff_confirm_body | You are signing this perfusion record as the perfusionist of record. Your staff identity and the time will be recorded as the perfusionist signature. | आप इस परफ़्यूज़न रिकॉर्ड पर रिकॉर्ड के परफ़्यूज़निस्ट के रूप में हस्ताक्षर कर रहे हैं। आपकी स्टाफ़ पहचान और समय परफ़्यूज़निस्ट हस्ताक्षर के रूप में दर्ज होंगे। | இந்த பர்ஃப்யூஷன் பதிவில் நீங்கள் பதிவு-பர்ஃப்யூஷனிஸ்ட்டாக கையொப்பமிடுகிறீர்கள். உங்கள் பணியாளர் அடையாளமும் நேரமும் கையொப்பமாக பதிவு செய்யப்படும். | ఈ పెర్ఫ్యూజన్ రికార్డుపై మీరు రికార్డ్ పెర్ఫ్యూజనిస్ట్‌గా సంతకం చేస్తున్నారు. మీ సిబ్బంది గుర్తింపు మరియు సమయం సంతకంగా నమోదు అవుతాయి. | ഈ പെർഫ്യൂഷൻ രേഖയിൽ നിങ്ങൾ റെക്കോർഡ് പെർഫ്യൂഷനിസ്റ്റായി ഒപ്പിടുകയാണ്. നിങ്ങളുടെ സ്റ്റാഫ് ഐഡന്റിറ്റിയും സമയവും ഒപ്പായി രേഖപ്പെടുത്തും. |
| perfusion.finalize_confirm_body | Finalizing permanently locks this perfusion record. No corrections are possible after finalize. | अंतिम रूप देने से यह परफ़्यूज़न रिकॉर्ड स्थायी रूप से लॉक हो जाएगा। इसके बाद कोई सुधार संभव नहीं है। | இறுதிசெய்தால் இந்த பர்ஃப்யூஷன் பதிவு நிரந்தரமாக பூட்டப்படும். அதன் பிறகு திருத்தங்கள் செய்ய முடியாது. | ఖరారు చేస్తే ఈ పెర్ఫ్యూజన్ రికార్డ్ శాశ్వతంగా లాక్ అవుతుంది. ఆ తర్వాత సవరణలు సాధ్యం కావు. | അന്തിമമാക്കിയാൽ ഈ പെർഫ്യൂഷൻ രേഖ ശാശ്വതമായി ലോക്ക് ആകും. ശേഷം തിരുത്തലുകൾ സാധ്യമല്ല. |
| perfusion.finalize_blocked | Perfusionist sign-off, surgeon review, and anesthesia review are required before finalize | अंतिम रूप देने से पहले परफ़्यूज़निस्ट साइन-ऑफ़, सर्जन समीक्षा और एनेस्थीसिया समीक्षा आवश्यक हैं | இறுதிசெய்வதற்கு முன் பர்ஃப்யூஷனிஸ்ட் கையொப்பம், அறுவை சிகிச்சை நிபுணர் மதிப்பாய்வு மற்றும் மயக்கவியல் மதிப்பாய்வு தேவை | ఖరారుకు ముందు పెర్ఫ్యూజనిస్ట్ సైన్-ఆఫ్, సర్జన్ సమీక్ష మరియు అనస్థీషియా సమీక్ష అవసరం | അന്തിമമാക്കുന്നതിന് മുമ്പ് പെർഫ്യൂഷനിസ്റ്റ് സൈൻ-ഓഫ്, സർജൻ അവലോകനം, അനസ്തേഷ്യ അവലോകനം എന്നിവ ആവശ്യമാണ് |
| perfusion.finalized_readonly | Finalized — read only | अंतिम रूप दिया गया — केवल पढ़ने के लिए | இறுதிசெய்யப்பட்டது — படிக்க மட்டும் | ఖరారు చేయబడింది — చదవడానికి మాత్రమే | അന്തിമമാക്കി — വായനയ്ക്ക് മാത്രം |

## Reused existing getters (no new keys)

actionCancel, actionConfirm, actionSave, actionSearch, actionRetry,
labelLoading, labelNoData, labelOptional, labelRequired,
theatreLabelSurgeon, theatreLabelAnesthetist, errorSomethingWentWrong.
