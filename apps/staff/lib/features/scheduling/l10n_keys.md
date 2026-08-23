# Scheduling Workbench — new AppStrings keys

New keys required by `scheduling_workbench_screen.dart`. The coordinator adds
each row to `lib/l10n/app_strings.dart` (getter + all five locale maps) before
the suite runs. Getter naming follows the existing house pattern
(`String get <getter> => _t('<key>');`).

31 new keys. Existing getters reused hard (no new keys needed for them):
`actionCancel`, `actionConfirm`, `actionRetry`, `actionSave`, `actionSearch`,
`actionSubmit`, `labelNoData`, `labelOptional`, `labelRequired`,
`theatreLabelDate`, `prescriptionsDoctorLabel`, `prescriptionsPatientLabel`,
`leaveReasonLabel`, `clinicalInboxPriority`, `radiologyLabelNotes`,
`profileFieldName`, `myReportsLabelLocation`.

| getter | key | en | hi | ta | te | ml |
|---|---|---|---|---|---|---|
| schedulingWorkbenchTitle | scheduling.workbench_title | Scheduling Workbench | शेड्यूलिंग वर्कबेंच | திட்டமிடல் பணிமேடை | షెడ్యూలింగ్ వర్క్‌బెంచ్ | ഷെഡ്യൂളിംഗ് വർക്ക്ബെഞ്ച് |
| schedulingTabSlotGrid | scheduling.tab.slot_grid | Slot Grid | स्लॉट ग्रिड | ஸ்லாட் கட்டம் | స్లాట్ గ్రిడ్ | സ്ലോട്ട് ഗ്രിഡ് |
| schedulingTabWaitlist | scheduling.tab.waitlist | Waitlist | प्रतीक्षा सूची | காத்திருப்புப் பட்டியல் | వేచి ఉన్న జాబితా | കാത്തിരിപ്പ് പട്ടിക |
| schedulingTabTemplates | scheduling.tab.templates | Templates | टेम्पलेट | வார்ப்புருக்கள் | టెంప్లేట్లు | ടെംപ്ലേറ്റുകൾ |
| schedulingTabResources | scheduling.tab.resources | Resources | संसाधन | வளங்கள் | వనరులు | വിഭവങ്ങൾ |
| schedulingSlotOpen | scheduling.slot.open | Open | खाली | காலி | ఖాళీ | ഒഴിവ് |
| schedulingSlotHeld | scheduling.slot.held | Held | होल्ड पर | நிறுத்தி வைக்கப்பட்டது | హోల్డ్‌లో | ഹോൾഡിൽ |
| schedulingSlotBooked | scheduling.slot.booked | Booked | बुक हो गया | முன்பதிவு | బుక్ అయింది | ബുക്ക് ചെയ്തു |
| schedulingSlotBlocked | scheduling.slot.blocked | Blocked | अवरुद्ध | தடுக்கப்பட்டது | బ్లాక్ చేయబడింది | തടഞ്ഞു |
| schedulingHoldTitle | scheduling.hold.title | Hold slot | स्लॉट होल्ड करें | ஸ்லாட்டை நிறுத்தி வைக்கவும் | స్లాట్ హోల్డ్ చేయండి | സ്ലോട്ട് ഹോൾഡ് ചെയ്യുക |
| schedulingHoldRelease | scheduling.hold.release | Release | रिलीज़ करें | விடுவிக்கவும் | విడుదల చేయండి | റിലീസ് ചെയ്യുക |
| schedulingOnLeave | scheduling.on_leave | Doctor on leave | डॉक्टर अवकाश पर हैं | மருத்துவர் விடுப்பில் உள்ளார் | డాక్టర్ సెలవులో ఉన్నారు | ഡോക്ടർ അവധിയിലാണ് |
| schedulingClosed | scheduling.closed | Schedule closed | शेड्यूल बंद है | அட்டவணை மூடப்பட்டுள்ளது | షెడ్యూల్ మూసివేయబడింది | ഷെഡ്യൂൾ അടച്ചിരിക്കുന്നു |
| schedulingCapacityLabel | scheduling.capacity_label | Capacity | क्षमता | கொள்ளளவு | సామర్థ్యం | ശേഷി |
| schedulingOverbookLabel | scheduling.overbook_label | Overbook allowance | ओवरबुक सीमा | ஓவர்புக் வரம்பு | ఓవర్‌బుక్ పరిమితి | ഓവർബുക്ക് പരിധി |
| schedulingWaitlistAddTitle | scheduling.waitlist.add_title | Add to waitlist | प्रतीक्षा सूची में जोड़ें | காத்திருப்புப் பட்டியலில் சேர்க்கவும் | వేచి ఉన్న జాబితాకు జోడించండి | കാത്തിരിപ്പ് പട്ടികയിൽ ചേർക്കുക |
| schedulingWaitlistFill | scheduling.waitlist.fill | Fill from waitlist | प्रतीक्षा सूची से भरें | காத்திருப்புப் பட்டியலிலிருந்து நிரப்பவும் | వేచి ఉన్న జాబితా నుండి నింపండి | കാത്തിരിപ്പ് പട്ടികയിൽ നിന്ന് നിറയ്ക്കുക |
| schedulingWaitlistSessionOnly | scheduling.waitlist.session_only | Session results only — the server has no waitlist list endpoint | केवल इस सत्र के परिणाम — सर्वर प्रतीक्षा-सूची की सूची नहीं देता | இந்த அமர்வின் முடிவுகள் மட்டும் — சேவையகம் காத்திருப்புப் பட்டியலைத் தருவதில்லை | ఈ సెషన్ ఫలితాలు మాత్రమే — సర్వర్ వెయిట్‌లిస్ట్ జాబితాను అందించదు | ഈ സെഷനിലെ ഫലങ്ങൾ മാത്രം — സെർവർ കാത്തിരിപ്പ് പട്ടിക നൽകുന്നില്ല |
| schedulingWaitlistOffers | scheduling.waitlist.offers | Offers | प्रस्ताव | வாய்ப்புகள் | ఆఫర్లు | ഓഫറുകൾ |
| schedulingTemplateCreateTitle | scheduling.template.create_title | New template | नया टेम्पलेट | புதிய வார்ப்புரு | కొత్త టెంప్లేట్ | പുതിയ ടെംപ്ലേറ്റ് |
| schedulingTemplateExceptionTitle | scheduling.template.exception_title | Add exception | अपवाद जोड़ें | விதிவிலக்கு சேர்க்கவும் | మినహాయింపు జోడించండి | ഒഴിവാക്കൽ ചേർക്കുക |
| schedulingLeaveTitle | scheduling.leave.title | Record leave | अवकाश दर्ज करें | விடுப்பு பதிவு செய்யவும் | సెలవు నమోదు చేయండి | അവധി രേഖപ്പെടുത്തുക |
| schedulingWeekdayLabel | scheduling.weekday_label | Weekday (0 = Sunday) | सप्ताह-दिन (0 = रविवार) | வாரநாள் (0 = ஞாயிறு) | వారపు రోజు (0 = ఆదివారం) | ആഴ്ചദിവസം (0 = ഞായർ) |
| schedulingStartLabel | scheduling.start_label | Start | प्रारंभ | தொடக்கம் | ప్రారంభం | തുടക്കം |
| schedulingEndLabel | scheduling.end_label | End | समाप्ति | முடிவு | ముగింపు | അവസാനം |
| schedulingResourceCreateTitle | scheduling.resource.create_title | New resource | नया संसाधन | புதிய வளம் | కొత్త వనరు | പുതിയ വിഭവം |
| schedulingResourceIdLabel | scheduling.resource.id_label | Resource ID | संसाधन आईडी | வள ஐடி | వనరు ఐడీ | വിഭവ ഐഡി |
| schedulingResourceCompatTitle | scheduling.resource.compat_title | Compatibility | संगतता | இணக்கத்தன்மை | అనుకూలత | അനുയോജ്യത |
| schedulingResourceBookTitle | scheduling.resource.book_title | Book resource | संसाधन बुक करें | வளத்தை முன்பதிவு செய்யவும் | వనరును బుక్ చేయండి | വിഭവം ബുക്ക് ചെയ്യുക |
| schedulingResourceScheduleTitle | scheduling.resource.schedule_title | Bookings | बुकिंग | முன்பதிவுகள் | బుకింగ్‌లు | ബുക്കിംഗുകൾ |
| schedulingSaved | scheduling.saved | Saved | सहेजा गया | சேமிக்கப்பட்டது | సేవ్ అయింది | സേവ് ചെയ്തു |

Notes for the coordinator:

- API enum values shown as-is in the UI (guard-exempt lowercase display data,
  not copy): `any/am/pm`, `room/equipment`, `compatible/preferred/required`,
  `booked/expired/cancelled`, `closed/blocked/modified/extra`, `other`, plus
  server-returned statuses and reasons (`waiting`, `offered`,
  `doctor_on_leave`, `no_free_slots`, hold statuses).
- Format-pattern hints (`yyyy-MM-dd`, `HH:mm`) and the unit abbreviation
  `min` are intentionally literal (i18n-guard exempt, matching the
  housekeeping `08:00:00` precedent).
