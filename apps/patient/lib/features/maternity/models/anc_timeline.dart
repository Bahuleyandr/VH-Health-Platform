import 'package:vhhealth/core/models/status_enums.dart';

class AncTimelineData {
  const AncTimelineData({
    required this.pregnancy,
    required this.visits,
    required this.supplements,
    required this.fetalKicks,
    required this.packages,
    required this.advice,
    this.bookedVisits = const [],
    this.generalVitals = const [],
    this.contentPendingReview = false,
    this.adviceLoadFailed = false,
    this.staleLabel,
  });

  final AncPregnancy? pregnancy;
  final List<AncVisit> visits;
  final List<AncSupplement> supplements;
  final List<AncFetalKick> fetalKicks;
  final List<MaternityPackage> packages;
  final List<AncAdvice> advice;
  final List<AncBookedVisit> bookedVisits;
  final List<AncGeneralVital> generalVitals;
  final bool contentPendingReview;
  final bool adviceLoadFailed;
  final String? staleLabel;

  bool get hasActivePregnancy => pregnancy != null;

  int? get currentTrimester => pregnancy?.trimester;

  List<AncAdvice> get dangerSigns =>
      advice.where((item) => item.isDangerSigns).toList(growable: false);

  List<AncAdvice> get selfCareAdvice =>
      advice.where((item) => !item.isDangerSigns).toList(growable: false);

  AncTimelineData copyWith({
    AncPregnancy? pregnancy,
    List<AncVisit>? visits,
    List<AncSupplement>? supplements,
    List<AncFetalKick>? fetalKicks,
    List<MaternityPackage>? packages,
    List<AncAdvice>? advice,
    List<AncBookedVisit>? bookedVisits,
    List<AncGeneralVital>? generalVitals,
    bool? contentPendingReview,
    bool? adviceLoadFailed,
    String? staleLabel,
  }) {
    return AncTimelineData(
      pregnancy: pregnancy ?? this.pregnancy,
      visits: visits ?? this.visits,
      supplements: supplements ?? this.supplements,
      fetalKicks: fetalKicks ?? this.fetalKicks,
      packages: packages ?? this.packages,
      advice: advice ?? this.advice,
      bookedVisits: bookedVisits ?? this.bookedVisits,
      generalVitals: generalVitals ?? this.generalVitals,
      contentPendingReview: contentPendingReview ?? this.contentPendingReview,
      adviceLoadFailed: adviceLoadFailed ?? this.adviceLoadFailed,
      staleLabel: staleLabel ?? this.staleLabel,
    );
  }

  factory AncTimelineData.fromResponses({
    required Object? timelineData,
    required Object? packagesData,
    required Object? adviceData,
    String? staleLabel,
    bool adviceLoadFailed = false,
  }) {
    final timeline = asStringMap(timelineData);
    final adviceMap = asStringMap(adviceData);
    if (timeline == null) {
      return AncTimelineData(
        pregnancy: null,
        visits: const [],
        supplements: const [],
        fetalKicks: const [],
        packages: listOfMaps(
          packagesData,
        ).map(MaternityPackage.fromJson).toList(growable: false),
        advice: listOfMaps(
          adviceMap?['advice'],
        ).map(AncAdvice.fromJson).toList(growable: false),
        contentPendingReview: adviceMap?['content_pending_review'] == true,
        adviceLoadFailed: adviceLoadFailed,
        staleLabel: staleLabel,
      );
    }

    return AncTimelineData(
      pregnancy: AncPregnancy.fromJson(
        asStringMap(timeline['pregnancy']) ?? const {},
      ),
      visits: listOfMaps(
        timeline['visits'],
      ).map(AncVisit.fromJson).toList(growable: false),
      supplements: listOfMaps(
        timeline['supplements'],
      ).map(AncSupplement.fromJson).toList(growable: false),
      fetalKicks: listOfMaps(
        timeline['fetal_kicks'],
      ).map(AncFetalKick.fromJson).toList(growable: false),
      // Optional in older responses; absent or malformed values fall back
      // to empty lists so the rest of the timeline still renders.
      bookedVisits: listOfMaps(
        timeline['booked_visits'],
      ).map(AncBookedVisit.fromJson).toList(growable: false),
      generalVitals: listOfMaps(
        timeline['general_vitals'],
      ).map(AncGeneralVital.fromJson).toList(growable: false),
      packages: listOfMaps(
        packagesData,
      ).map(MaternityPackage.fromJson).toList(growable: false),
      advice: listOfMaps(
        adviceMap?['advice'],
      ).map(AncAdvice.fromJson).toList(growable: false),
      contentPendingReview: adviceMap?['content_pending_review'] == true,
      adviceLoadFailed: adviceLoadFailed,
      staleLabel: staleLabel,
    );
  }
}

class AncPregnancy {
  const AncPregnancy({
    required this.id,
    this.eddDate,
    this.gestationalAgeLabel,
    this.gestationalWeeks,
    this.gestationalDays,
    this.highRisk = false,
    this.highRiskReasons = const [],
  });

  final int id;
  final String? eddDate;
  final String? gestationalAgeLabel;
  final int? gestationalWeeks;
  final int? gestationalDays;
  final bool highRisk;
  final List<String> highRiskReasons;

  int? get trimester {
    final weeks = gestationalWeeks;
    if (weeks == null) return null;
    if (weeks < 14) return 1;
    if (weeks < 28) return 2;
    return 3;
  }

  factory AncPregnancy.fromJson(Map<String, dynamic> json) {
    final ga = asStringMap(json['gestational_age']);
    return AncPregnancy(
      id: toInt(json['id']) ?? 0,
      eddDate: json['edd_date']?.toString(),
      gestationalAgeLabel: ga?['label']?.toString(),
      gestationalWeeks: toInt(ga?['weeks']),
      gestationalDays: toInt(ga?['days']),
      highRisk: json['high_risk'] == true,
      highRiskReasons: listOfStrings(json['high_risk_reasons']),
    );
  }
}

class AncVisit {
  const AncVisit({
    this.visitNumber,
    this.visitDate,
    this.gestationalAgeWeeks,
    this.weightKg,
    this.bpSystolic,
    this.bpDiastolic,
    this.fundalHeightCm,
    this.fetalHeartRateBpm,
    this.hbGmDl,
    this.urineAlbumin,
    this.nextVisitDate,
    this.notes,
  });

  final int? visitNumber;
  final String? visitDate;
  final int? gestationalAgeWeeks;
  final num? weightKg;
  final int? bpSystolic;
  final int? bpDiastolic;
  final num? fundalHeightCm;
  final int? fetalHeartRateBpm;
  final num? hbGmDl;
  final String? urineAlbumin;
  final String? nextVisitDate;
  final String? notes;

  factory AncVisit.fromJson(Map<String, dynamic> json) {
    return AncVisit(
      visitNumber: toInt(json['visit_number']),
      visitDate: json['visit_date']?.toString(),
      gestationalAgeWeeks: toInt(json['gestational_age_weeks']),
      weightKg: toNum(json['weight_kg']),
      bpSystolic: toInt(json['bp_systolic']),
      bpDiastolic: toInt(json['bp_diastolic']),
      fundalHeightCm: toNum(json['fundal_height_cm']),
      fetalHeartRateBpm: toInt(json['fetal_heart_rate_bpm']),
      hbGmDl: toNum(json['hb_gm_dl']),
      urineAlbumin: json['urine_albumin']?.toString(),
      nextVisitDate: json['next_visit_date']?.toString(),
      notes: json['notes']?.toString(),
    );
  }
}

/// A booked OB/ANC appointment from `booked_visits`.
///
/// Only the factual booking fields are parsed. The backend also decorates
/// each row with derived schedule data (milestone_label, gestational_age,
/// trimester, visit_sequence_number); that is schedule inference and is
/// deliberately not part of the approved patient-facing scope.
class AncBookedVisit {
  const AncBookedVisit({
    this.id,
    this.appointmentDate,
    this.appointmentTime,
    this.status,
    this.department,
    this.reason,
  });

  final int? id;
  final String? appointmentDate;
  final String? appointmentTime;
  final String? status;
  final String? department;
  final String? reason;

  /// The appointment's semantic calendar date, without timezone conversion.
  ///
  /// PostgreSQL `date` values can arrive as either `YYYY-MM-DD` or a midnight
  /// ISO timestamp. In both cases the leading date is the booked day and must
  /// not move when the device timezone differs from the backend timezone.
  DateTime? get appointmentCalendarDate {
    final raw = appointmentDate?.trim();
    if (raw == null || raw.isEmpty) return null;
    final match = RegExp(
      r'^(\d{4})-(\d{2})-(\d{2})(?:$|[T ]\d{2}:\d{2}'
      r'(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)$',
    ).firstMatch(raw);
    if (match == null) return null;
    final year = int.parse(match.group(1)!);
    final month = int.parse(match.group(2)!);
    final day = int.parse(match.group(3)!);
    final parsed = DateTime(year, month, day);
    if (parsed.year != year || parsed.month != month || parsed.day != day) {
      return null;
    }
    if (raw.length > 10 && DateTime.tryParse(raw) == null) return null;
    return parsed;
  }

  /// Whether this booking should still appear on the patient timeline.
  ///
  /// Completed appointments are excluded so they are not duplicated with
  /// the recorded ANC visits; anything unparseable fails closed (hidden).
  bool isUpcomingOrActive(DateTime now) {
    final normalizedStatus = status?.trim().toUpperCase();
    final parsedStatus = AppointmentStatus.fromString(normalizedStatus);
    if (parsedStatus == AppointmentStatus.inProgress ||
        normalizedStatus == 'CHECKED_IN' ||
        normalizedStatus == 'WAITING') {
      return true;
    }
    if (parsedStatus != AppointmentStatus.scheduled &&
        parsedStatus != AppointmentStatus.confirmed) {
      return false;
    }
    final visitDay = appointmentCalendarDate;
    if (visitDay == null) return false;
    final today = DateTime(now.year, now.month, now.day);
    return !visitDay.isBefore(today);
  }

  factory AncBookedVisit.fromJson(Map<String, dynamic> json) {
    return AncBookedVisit(
      id: toInt(json['id']),
      appointmentDate: json['appointment_date']?.toString(),
      appointmentTime: json['appointment_time']?.toString(),
      status: json['status']?.toString(),
      department: json['department']?.toString(),
      reason: json['reason']?.toString(),
    );
  }
}

/// A reading from `general_vitals` (vitals recorded outside the ANC
/// composer, e.g. on the general vitals screen).
///
/// The approved patient-facing scope is limited to recorded BP and weight;
/// other columns in the row are intentionally not parsed.
class AncGeneralVital {
  const AncGeneralVital({
    this.id,
    this.recordedAt,
    this.systolicBp,
    this.diastolicBp,
    this.weightKg,
  });

  final int? id;
  final String? recordedAt;
  final int? systolicBp;
  final int? diastolicBp;
  final num? weightKg;

  bool get hasBloodPressure => systolicBp != null && diastolicBp != null;

  bool get hasWeight => weightKg != null;

  DateTime? get recordedDateTime {
    final raw = recordedAt?.trim();
    if (raw == null || raw.isEmpty) return null;
    final match = RegExp(
      r'^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})'
      r'(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$',
    ).firstMatch(raw);
    if (match == null) return null;

    final year = int.parse(match.group(1)!);
    final month = int.parse(match.group(2)!);
    final day = int.parse(match.group(3)!);
    final hour = int.parse(match.group(4)!);
    final minute = int.parse(match.group(5)!);
    final second = int.tryParse(match.group(6) ?? '') ?? 0;
    final validated = DateTime.utc(year, month, day, hour, minute, second);
    if (validated.year != year ||
        validated.month != month ||
        validated.day != day ||
        validated.hour != hour ||
        validated.minute != minute ||
        validated.second != second) {
      return null;
    }
    return DateTime.tryParse(raw);
  }

  bool get hasDisplayableReading =>
      recordedDateTime != null && (hasBloodPressure || hasWeight);

  factory AncGeneralVital.fromJson(Map<String, dynamic> json) {
    return AncGeneralVital(
      id: toInt(json['id']),
      recordedAt: json['recorded_at']?.toString(),
      systolicBp: toInt(json['systolic_bp']),
      diastolicBp: toInt(json['diastolic_bp']),
      weightKg: toNum(json['weight_kg']),
    );
  }
}

class AncSupplement {
  const AncSupplement({
    required this.id,
    required this.supplement,
    this.dose,
    this.frequency,
    this.startDate,
    this.endDate,
    this.reminderEnabled = false,
    this.notes,
    this.doseTimes = const [],
  });

  final int id;
  final String supplement;
  final String? dose;
  final String? frequency;
  final String? startDate;
  final String? endDate;
  final bool reminderEnabled;
  final String? notes;
  final List<String> doseTimes;

  String get displayName => titleCase(supplement.replaceAll('_', ' '));

  AncSupplement copyWith({
    String? supplement,
    String? dose,
    String? frequency,
    String? startDate,
    String? endDate,
    bool? reminderEnabled,
    String? notes,
    List<String>? doseTimes,
  }) {
    return AncSupplement(
      id: id,
      supplement: supplement ?? this.supplement,
      dose: dose ?? this.dose,
      frequency: frequency ?? this.frequency,
      startDate: startDate ?? this.startDate,
      endDate: endDate ?? this.endDate,
      reminderEnabled: reminderEnabled ?? this.reminderEnabled,
      notes: notes ?? this.notes,
      doseTimes: doseTimes ?? this.doseTimes,
    );
  }

  factory AncSupplement.fromJson(Map<String, dynamic> json) {
    final doseSchedule = asStringMap(json['dose_schedule']);
    return AncSupplement(
      id: toInt(json['id']) ?? 0,
      supplement: json['supplement']?.toString() ?? '',
      dose: json['dose']?.toString(),
      frequency: json['frequency']?.toString(),
      startDate: json['start_date']?.toString(),
      endDate: json['end_date']?.toString(),
      reminderEnabled: json['reminder_enabled'] == true,
      notes: json['notes']?.toString(),
      doseTimes: listOfStrings(doseSchedule?['times']),
    );
  }

  AncSupplement mergeServerUpdate(Map<String, dynamic> json) {
    return copyWith(
      supplement: json['supplement']?.toString(),
      dose: json['dose']?.toString(),
      frequency: json['frequency']?.toString(),
      startDate: json['start_date']?.toString(),
      endDate: json['end_date']?.toString(),
      reminderEnabled: json['reminder_enabled'] == true,
      notes: json['notes']?.toString(),
    );
  }
}

class AncFetalKick {
  const AncFetalKick({
    this.id,
    this.logDate,
    this.kickCount,
    this.lowCountFlag = false,
    this.observationWindowMinutes,
    this.notes,
  });

  final int? id;
  final String? logDate;
  final int? kickCount;
  final bool lowCountFlag;
  final int? observationWindowMinutes;
  final String? notes;

  factory AncFetalKick.fromJson(Map<String, dynamic> json) {
    return AncFetalKick(
      id: toInt(json['id']),
      logDate: json['log_date']?.toString(),
      kickCount: toInt(json['kick_count']),
      lowCountFlag: json['low_count_flag'] == true,
      observationWindowMinutes: toInt(json['observation_window_minutes']),
      notes: json['notes']?.toString(),
    );
  }
}

class MaternityPackage {
  const MaternityPackage({
    this.displayName,
    this.description,
    this.durationDays,
    this.fixedPriceMinor,
  });

  final String? displayName;
  final String? description;
  final int? durationDays;
  final num? fixedPriceMinor;

  factory MaternityPackage.fromJson(Map<String, dynamic> json) {
    return MaternityPackage(
      displayName: json['display_name']?.toString(),
      description: json['description']?.toString(),
      durationDays: toInt(json['duration_days']),
      fixedPriceMinor: toNum(json['fixed_price_minor']),
    );
  }
}

class AncAdvice {
  const AncAdvice({
    required this.id,
    required this.trimester,
    required this.category,
    this.title,
    this.content,
    this.contentStatus,
  });

  final int id;
  final int trimester;
  final String category;
  final String? title;
  final String? content;
  final String? contentStatus;

  bool get isDangerSigns => category == 'danger_signs';

  bool get isPendingClinicalReview =>
      contentStatus == 'pending_clinical_review' ||
      content == null ||
      content!.trim().isEmpty;

  factory AncAdvice.fromJson(Map<String, dynamic> json) {
    return AncAdvice(
      id: toInt(json['id']) ?? 0,
      trimester: toInt(json['trimester']) ?? 0,
      category: json['category']?.toString() ?? '',
      title: json['title']?.toString(),
      content: json['content']?.toString(),
      contentStatus: json['content_status']?.toString(),
    );
  }
}

Map<String, dynamic>? asStringMap(Object? value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return Map<String, dynamic>.from(value);
  return null;
}

List<Map<String, dynamic>> listOfMaps(Object? value) {
  if (value is! List) return const [];
  return value
      .whereType<Map>()
      .map((item) => Map<String, dynamic>.from(item))
      .toList(growable: false);
}

List<String> listOfStrings(Object? value) {
  if (value is! List) return const [];
  return value.map((item) => item.toString()).toList(growable: false);
}

int? toInt(Object? value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '');
}

num? toNum(Object? value) {
  if (value is num) return value;
  return num.tryParse(value?.toString() ?? '');
}

String titleCase(String value) {
  final text = value.trim();
  if (text.isEmpty) return text;
  return text
      .split(RegExp(r'\s+'))
      .map((word) {
        if (word.isEmpty) return word;
        return '${word[0].toUpperCase()}${word.substring(1)}';
      })
      .join(' ');
}
