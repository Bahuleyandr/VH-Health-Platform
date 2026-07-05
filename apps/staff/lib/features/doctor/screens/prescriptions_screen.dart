// ignore_for_file: unused_element_parameter

import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';
import '../../../core/models/composition_alternatives.dart';
import '../../../core/platform_info.dart';
import '../../../core/services/api_client.dart';
import '../../../core/services/clinical_print_service.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/services/prescription_payloads.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/api_error_messages.dart';
import '../../../core/widgets/clinical_print_pdf_action.dart';
import '../../../core/widgets/constrained_content.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/states/empty_state.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';
import '../../../core/widgets/states/success_toast.dart';
import '../../../core/widgets/vital_text_field.dart';
import '../../../l10n/app_strings.dart';
import '../../ipd/utils/drug_chart_utils.dart';
import '../../pharmacy/widgets/composition_alternatives_panel.dart';
import '../prescription_offline_rx.dart';
import '../widgets/cds_blocker_modal.dart';
import '../widgets/prescription_submit_button.dart';

/// E-Prescriptions screen — structured prescription entry with medicine type-ahead.
class PrescriptionsScreen extends StatefulWidget {
  final Map<String, dynamic>? prefilledAppointment;
  const PrescriptionsScreen({super.key, this.prefilledAppointment});

  @override
  State<PrescriptionsScreen> createState() => _PrescriptionsScreenState();
}

class _PrescriptionsScreenState extends State<PrescriptionsScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(
      length: 2,
      vsync: this,
      initialIndex: widget.prefilledAppointment != null ? 0 : 0,
    );
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return StaffScaffold(
      title: s.prescriptionsTitle,
      body: ConstrainedContent(
        child: Column(
          children: [
            Container(
              color: AppTheme.cardSurface,
              child: TabBar(
                controller: _tabController,
                labelColor: const Color(0xFF00838F),
                unselectedLabelColor: AppTheme.textSecondary,
                indicatorColor: const Color(0xFF00838F),
                tabs: [
                  Tab(text: s.prescriptionsTabNew),
                  Tab(text: s.prescriptionsTabRecent),
                ],
              ),
            ),
            Expanded(
              child: TabBarView(
                controller: _tabController,
                children: [
                  _NewEPrescriptionTab(
                    prefilledAppointment: widget.prefilledAppointment,
                  ),
                  const _RecentEPrescriptionsTab(),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Medication model
// ═══════════════════════════════════════════════════════════════════════════════

int? _entryInt(Object? value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '');
}

String? _entryText(Object? value) {
  final text = value?.toString().trim() ?? '';
  if (text.isEmpty || text.toLowerCase() == 'null') return null;
  return text;
}

class _MedicationEntry {
  String name;
  String displayName;
  String? genericName;
  int? catalogId;
  int? originalCatalogId;
  int? compositionId;
  String? compositionLabel;
  String? compositionConfidence;
  String? strengthKey;
  String? form;
  String? formKey;
  String? releaseKey;
  List<Map<String, dynamic>> catalogRows;
  String strength;
  List<String> strengthOptions;
  String dosage;
  String frequency;
  Set<String> doseTimes;
  String duration;
  String route;
  String instructions;
  String foodTiming;
  int quantity;
  int days;
  int refills;
  bool prn;
  bool nte;
  bool daw;
  String type;
  String category;
  String pharmacy;

  _MedicationEntry({
    this.name = '',
    this.displayName = '',
    this.genericName,
    this.catalogId,
    this.originalCatalogId,
    this.compositionId,
    this.compositionLabel,
    this.compositionConfidence,
    this.strengthKey,
    this.form,
    this.formKey,
    this.releaseKey,
    List<Map<String, dynamic>>? catalogRows,
    this.strength = '',
    List<String>? strengthOptions,
    this.dosage = '',
    this.frequency = 'BD',
    Set<String>? doseTimes,
    this.duration = '',
    this.route = 'Oral',
    this.instructions = '',
    this.foodTiming = '',
    this.quantity = 1,
    this.days = 5,
    this.refills = 0,
    this.prn = false,
    this.nte = false,
    this.daw = false,
    this.type = '',
    this.category = '',
    this.pharmacy = '',
  }) : catalogRows = catalogRows ?? const [],
       strengthOptions =
           strengthOptions ??
           (strength.trim().isEmpty ? <String>[] : <String>[strength.trim()]),
       doseTimes = doseTimes ?? <String>{'morning', 'night'};

  Map<String, dynamic> toJson() {
    final baseName = name.trim();
    final visibleName = displayName.trim().isNotEmpty
        ? displayName.trim()
        : baseName;
    return {
      'name': baseName,
      if (baseName.isNotEmpty) 'medication_name': baseName,
      if (baseName.isNotEmpty) 'base_name': baseName,
      if (visibleName.isNotEmpty) 'display_name': visibleName,
      if (genericName != null) 'generic_name': genericName,
      if (catalogId != null) 'catalog_id': catalogId,
      if (originalCatalogId != null &&
          catalogId != null &&
          originalCatalogId != catalogId)
        'original_catalog_id': originalCatalogId,
      if (compositionId != null) 'composition_id': compositionId,
      if (compositionLabel != null) 'composition_label': compositionLabel,
      if (compositionConfidence != null)
        'composition_confidence': compositionConfidence,
      if (strengthKey != null) 'strength_key': strengthKey,
      if (form != null) 'form': form,
      if (formKey != null) 'form_key': formKey,
      if (releaseKey != null) 'release_key': releaseKey,
      if (strength.trim().isNotEmpty) 'strength': strength.trim(),
      'dosage': dosage.trim().isNotEmpty ? dosage.trim() : strength.trim(),
      'frequency': frequency,
      if (doseTimes.isNotEmpty) 'dose_times': doseTimes.toList(growable: false),
      if (foodTiming.trim().isNotEmpty) 'food_timing': foodTiming.trim(),
      'duration': duration.trim().isNotEmpty ? duration.trim() : '$days days',
      'days': days,
      'route': route,
      'instructions': instructions,
      'quantity': quantity,
      'refills': refills,
      if (prn) 'prn': true,
      if (nte) 'nte': true,
      if (daw) 'do_not_substitute': true,
      if (type.trim().isNotEmpty) 'type': type.trim(),
      if (category.trim().isNotEmpty) 'category': category.trim(),
      if (pharmacy.trim().isNotEmpty) 'pharmacy': pharmacy.trim(),
    };
  }

  factory _MedicationEntry.fromJson(Map<String, dynamic> json) {
    final doseTimes = json['dose_times'] ?? json['doseTimes'];
    return _MedicationEntry(
      name:
          json['base_name']?.toString() ??
          json['drug_name']?.toString() ??
          json['name']?.toString() ??
          '',
      displayName:
          json['display_name']?.toString() ?? json['name']?.toString() ?? '',
      genericName: json['generic_name']?.toString(),
      catalogId: _entryInt(json['catalog_id'] ?? json['id']),
      originalCatalogId: _entryInt(json['original_catalog_id']),
      compositionId: _entryInt(json['composition_id']),
      compositionLabel: _entryText(json['composition_label']),
      compositionConfidence: _entryText(json['composition_confidence']),
      strengthKey: _entryText(json['strength_key']),
      form: _entryText(json['form']),
      formKey: _entryText(json['form_key']),
      releaseKey: _entryText(json['release_key']),
      strength: json['strength']?.toString() ?? '',
      strengthOptions: (json['strength_options'] as List?)
          ?.map((value) => value.toString())
          .where((value) => value.trim().isNotEmpty)
          .toList(growable: false),
      dosage: json['dosage']?.toString() ?? '',
      frequency: json['frequency']?.toString() ?? 'BD',
      doseTimes: doseTimes is List
          ? doseTimes.map((value) => value.toString()).toSet()
          : null,
      duration: json['duration']?.toString() ?? '',
      route: json['route']?.toString() ?? 'Oral',
      instructions: json['instructions']?.toString() ?? '',
      foodTiming: json['food_timing']?.toString() ?? '',
      quantity: json['quantity'] is int
          ? json['quantity'] as int
          : int.tryParse(json['quantity']?.toString() ?? '') ?? 1,
      days: json['days'] is int
          ? json['days'] as int
          : int.tryParse(json['days']?.toString() ?? '') ?? 5,
      refills: json['refills'] is int
          ? json['refills'] as int
          : int.tryParse(json['refills']?.toString() ?? '') ?? 0,
      prn: json['prn'] == true,
      nte: json['nte'] == true,
      daw: json['do_not_substitute'] == true || json['daw'] == true,
      type: json['type']?.toString() ?? '',
      category: json['category']?.toString() ?? '',
      pharmacy: json['pharmacy']?.toString() ?? '',
    );
  }
}

class _SubmitPrescriptionIntent extends Intent {
  const _SubmitPrescriptionIntent();
}

class _AddMedicationIntent extends Intent {
  const _AddMedicationIntent();
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEW E-PRESCRIPTION TAB
// ═══════════════════════════════════════════════════════════════════════════════

class _NewEPrescriptionTab extends StatefulWidget {
  final Map<String, dynamic>? prefilledAppointment;
  const _NewEPrescriptionTab({this.prefilledAppointment});

  @override
  State<_NewEPrescriptionTab> createState() => _NewEPrescriptionTabState();
}

class _NewEPrescriptionTabState extends State<_NewEPrescriptionTab> {
  final _formKey = GlobalKey<FormState>();
  final _diagnosisCtrl = TextEditingController();
  final _clinicalNotesCtrl = TextEditingController();
  final _followUpNotesCtrl = TextEditingController();

  // Patient + Appointment
  int? _patientId;
  int? _doctorId;
  int? _appointmentId;
  String? _patientUid;
  String? _patientName;
  String? _doctorName;

  // Vitals
  bool _showVitals = false;
  final _bpSysCtrl = TextEditingController();
  final _bpDiaCtrl = TextEditingController();
  final _pulseCtrl = TextEditingController();
  final _tempCtrl = TextEditingController();
  final _respRateCtrl = TextEditingController();
  final _spo2Ctrl = TextEditingController();
  final _weightCtrl = TextEditingController();
  final _heightCtrl = TextEditingController();
  final _bsCtrl = TextEditingController();
  String? _temperatureRoute;

  // Medications
  final List<_MedicationEntry> _medications = [_MedicationEntry()];
  String _preferredPharmacy = 'In House Dispensary';
  final Map<_MedicationEntry, List<Map<String, dynamic>>> _drugSuggestions = {};
  final Set<_MedicationEntry> _drugSuggestionLoading = {};
  final Map<_MedicationEntry, String> _drugSuggestionQuery = {};
  final Map<_MedicationEntry, TextEditingController> _drugTextControllers = {};
  final Map<_MedicationEntry, FocusNode> _drugFocusNodes = {};
  final ScrollController _medicationTableHorizontalCtrl = ScrollController();
  final List<_MedicationEntry> _favorites = [];

  // Follow-up
  DateTime? _followUpDate;
  int? _lastCreatedPrescriptionId;
  String? _lastCreatedPrescriptionPdfUrl;
  String? _lastPharmacyOrderMessage;
  bool _signingLastPrescription = false;
  bool _printingLastPrescription = false;
  bool _lastCreatedPrescriptionSigned = false;
  int? _appointmentPrescriptionId;
  bool _appointmentPrescriptionLocked = false;
  bool _loadingAppointmentPrescription = false;

  // Photo
  File? _handwrittenPhoto;

  bool _submitting = false;

  static const _favoritesPrefsKey = 'op_prescription_medication_favorites';
  static const _doseSlotLabels = {
    'morning': 'M',
    'afternoon': 'A',
    'evening': 'E',
    'night': 'N',
  };
  static const _doseSlotNames = {
    'morning': 'Morning',
    'afternoon': 'Afternoon',
    'evening': 'Evening',
    'night': 'Night',
  };
  // API/store values. Dropdown display labels are localized at render time.
  static const _routes = [
    'Oral',
    'IV',
    'IM',
    'Topical',
    'Inhalation',
    'Sublingual',
  ];
  static const _pharmacyOptions = [
    'In House Dispensary',
    'Patient choice',
    'External pharmacy',
  ];
  static const _foodTimingOptions = [
    '',
    'Before food',
    'After food',
    'With food',
    'Empty stomach',
    'At bedtime',
  ];

  @override
  void initState() {
    super.initState();
    if (widget.prefilledAppointment != null) {
      final a = widget.prefilledAppointment!;
      _appointmentId = a['id'] as int?;
      _patientId = a['patient_id'] as int?;
      _doctorId = a['doctor_id'] as int?;
      final nestedPatient = a['patient'];
      _patientUid = _cleanAppointmentText(
        a['patient_uid'] ??
            a['patientUid'] ??
            a['patient_uuid'] ??
            (nestedPatient is Map ? nestedPatient['uid'] : null),
      );
      _patientName = a['patient_name']?.toString();
      _doctorName = a['doctor_name']?.toString();
      _setControllerIfEmpty(_diagnosisCtrl, a['diagnosis']);
      _setControllerIfEmpty(
        _clinicalNotesCtrl,
        a['clinical_notes'] ?? a['clinicalNotes'],
      );
      _prefillLatestVitals();
      _loadAppointmentPrescriptionAndNoteContext();
    }
    _loadFavorites();
  }

  @override
  void dispose() {
    _disposeMedicationEditors();
    _medicationTableHorizontalCtrl.dispose();
    _diagnosisCtrl.dispose();
    _clinicalNotesCtrl.dispose();
    _followUpNotesCtrl.dispose();
    _bpSysCtrl.dispose();
    _bpDiaCtrl.dispose();
    _pulseCtrl.dispose();
    _tempCtrl.dispose();
    _respRateCtrl.dispose();
    _spo2Ctrl.dispose();
    _weightCtrl.dispose();
    _heightCtrl.dispose();
    _bsCtrl.dispose();
    super.dispose();
  }

  void _disposeMedicationEditors() {
    for (final controller in _drugTextControllers.values) {
      controller.dispose();
    }
    for (final node in _drugFocusNodes.values) {
      node.dispose();
    }
    _drugTextControllers.clear();
    _drugFocusNodes.clear();
  }

  void _disposeMedicationEditor(_MedicationEntry med) {
    _drugTextControllers.remove(med)?.dispose();
    _drugFocusNodes.remove(med)?.dispose();
  }

  TextEditingController _drugControllerFor(_MedicationEntry med) {
    return _drugTextControllers.putIfAbsent(
      med,
      () => TextEditingController(
        text: med.displayName.trim().isNotEmpty ? med.displayName : med.name,
      ),
    );
  }

  void _refreshDrugAutocompleteOptions(_MedicationEntry med) {
    final controller = _drugTextControllers[med];
    if (controller == null) return;
    // RawAutocomplete recalculates options from controller notifications, but
    // the backend suggestions arrive asynchronously after the text has changed.
    // ignore: invalid_use_of_protected_member, invalid_use_of_visible_for_testing_member
    controller.notifyListeners();
  }

  FocusNode _drugFocusFor(_MedicationEntry med) {
    return _drugFocusNodes.putIfAbsent(med, FocusNode.new);
  }

  Future<void> _loadFavorites() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getStringList(_favoritesPrefsKey) ?? const [];
      final rows = raw
          .map((value) {
            try {
              final decoded = jsonDecode(value);
              if (decoded is Map<String, dynamic>) {
                return _MedicationEntry.fromJson(decoded);
              }
            } catch (_) {
              return null;
            }
            return null;
          })
          .whereType<_MedicationEntry>()
          .where((med) => med.name.trim().isNotEmpty)
          .toList(growable: false);
      if (!mounted) return;
      setState(() {
        _favorites
          ..clear()
          ..addAll(rows);
      });
    } catch (_) {
      // Favorites are a local workflow accelerator; failed reads should not
      // block prescribing.
    }
  }

  Future<void> _persistFavorites() async {
    final prefs = await SharedPreferences.getInstance();
    final payload = _favorites
        .map((med) => jsonEncode(med.toJson()))
        .toList(growable: false);
    await prefs.setStringList(_favoritesPrefsKey, payload);
  }

  Future<void> _saveFavorite(_MedicationEntry med) async {
    _syncMedicationDerivedFields(med);
    if (med.name.trim().isEmpty) return;
    final key = '${med.name}|${med.strength}|${med.route}|${med.frequency}'
        .toLowerCase();
    setState(() {
      _favorites.removeWhere(
        (item) =>
            '${item.name}|${item.strength}|${item.route}|${item.frequency}'
                .toLowerCase() ==
            key,
      );
      _favorites.insert(0, _MedicationEntry.fromJson(med.toJson()));
      if (_favorites.length > 12) {
        _favorites.removeRange(12, _favorites.length);
      }
    });
    await _persistFavorites();
    if (mounted) {
      SuccessToast.show(
        context,
        AppStrings.of(context).lookup('s4.lib.prescriptions.saved_as_favorite'),
      );
    }
  }

  Future<void> _removeFavorite(_MedicationEntry med) async {
    setState(() => _favorites.remove(med));
    await _persistFavorites();
  }

  void _applyFavorite(_MedicationEntry favorite) {
    final target = _medications.firstWhere(
      (med) => med.name.trim().isEmpty,
      orElse: () {
        final med = _MedicationEntry(pharmacy: _preferredPharmacy);
        _medications.add(med);
        return med;
      },
    );
    setState(() {
      target
        ..name = favorite.name
        ..displayName = favorite.displayName
        ..genericName = favorite.genericName
        ..catalogId = favorite.catalogId
        ..originalCatalogId = favorite.originalCatalogId ?? favorite.catalogId
        ..compositionId = favorite.compositionId
        ..compositionLabel = favorite.compositionLabel
        ..compositionConfidence = favorite.compositionConfidence
        ..strengthKey = favorite.strengthKey
        ..form = favorite.form
        ..formKey = favorite.formKey
        ..releaseKey = favorite.releaseKey
        ..strength = favorite.strength
        ..strengthOptions = _uniqueStrengths([
          favorite.strength,
          ...favorite.strengthOptions,
        ])
        ..dosage = favorite.dosage
        ..frequency = favorite.frequency
        ..doseTimes = {...favorite.doseTimes}
        ..duration = favorite.duration
        ..route = favorite.route
        ..instructions = favorite.instructions
        ..foodTiming = favorite.foodTiming
        ..quantity = favorite.quantity
        ..days = favorite.days
        ..refills = favorite.refills
        ..prn = favorite.prn
        ..nte = favorite.nte
        ..daw = favorite.daw
        ..type = favorite.type
        ..category = favorite.category
        ..pharmacy = favorite.pharmacy.isEmpty
            ? _preferredPharmacy
            : favorite.pharmacy;
      _syncMedicationDerivedFields(target);
      _updateDrugControllerText(target);
    });
  }

  String? _patientIdentifierForVitals() {
    final a = widget.prefilledAppointment;
    if (a != null) {
      final nestedPatient = a['patient'];
      final uid =
          a['patient_uid'] ??
          a['patientUid'] ??
          a['patient_uuid'] ??
          (nestedPatient is Map ? nestedPatient['uid'] : null);
      if (uid != null && uid.toString().isNotEmpty) return uid.toString();
    }
    return _patientId?.toString();
  }

  void _setControllerIfEmpty(TextEditingController ctrl, Object? value) {
    if (value == null || ctrl.text.isNotEmpty) return;
    ctrl.text = value.toString();
  }

  String? _cleanAppointmentText(Object? value) {
    final text = value?.toString().trim() ?? '';
    if (text.isEmpty || text.toLowerCase() == 'null') return null;
    return text;
  }

  Future<void> _loadAppointmentPrescriptionAndNoteContext() async {
    final appointmentId = _appointmentId;
    if (appointmentId == null) return;
    setState(() => _loadingAppointmentPrescription = true);
    try {
      final rx = await MedicalApiService.getEPrescriptionByAppointment(
        appointmentId,
      );
      if (!mounted) return;
      setState(() {
        _populateFromExistingPrescription(rx);
        _loadingAppointmentPrescription = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _loadingAppointmentPrescription = false);
    }
    await _prefillOpNoteContext();
  }

  Future<void> _prefillOpNoteContext() async {
    final uid = _patientUid;
    final appointmentId = _appointmentId;
    if (uid == null || appointmentId == null) return;
    try {
      final data = await MedicalApiService.getPatientNotes(
        uid,
        noteType: 'op_consultation',
      );
      final raw = data['notes'] ?? data['data'] ?? data['items'];
      if (raw is! List) return;
      for (final item in raw.whereType<Map>()) {
        final note = Map<String, dynamic>.from(item);
        final content = _asStringMap(note['content']);
        final noteAppointmentId =
            _asInt(note['appointment_id']) ?? _asInt(content['appointment_id']);
        if (noteAppointmentId != appointmentId) continue;
        if (!mounted) return;
        setState(() {
          _setControllerIfEmpty(
            _diagnosisCtrl,
            content['diagnosis'] ?? content['assessment'],
          );
          _setControllerIfEmpty(
            _clinicalNotesCtrl,
            _clinicalNotesFromOpContent(content),
          );
        });
        return;
      }
    } catch (_) {
      // OP note context is a convenience prefill; prescribing still works.
    }
  }

  Map<String, dynamic> _asStringMap(Object? value) {
    if (value is Map<String, dynamic>) return value;
    if (value is Map) return value.cast<String, dynamic>();
    if (value is String && value.trim().isNotEmpty) {
      try {
        final parsed = jsonDecode(value);
        if (parsed is Map<String, dynamic>) return parsed;
        if (parsed is Map) return parsed.cast<String, dynamic>();
      } catch (_) {
        return const {};
      }
    }
    return const {};
  }

  int? _asInt(Object? value) {
    if (value is int) return value;
    if (value is num) return value.toInt();
    return int.tryParse(value?.toString() ?? '');
  }

  String _clinicalNotesFromOpContent(Map<String, dynamic> content) {
    final parts = <String>[];
    void add(String label, Object? value) {
      final text = value?.toString().trim() ?? '';
      if (text.isNotEmpty && text.toLowerCase() != 'null') {
        parts.add('$label: $text');
      }
    }

    add(
      'Chief complaints',
      content['chief_complaint'] ?? content['chief_complaints'],
    );
    add('History', content['history']);
    add('Examination', content['examination']);
    add('Diagnosis', content['diagnosis'] ?? content['assessment']);
    add('Plan', content['plan']);
    return parts.join('\n\n');
  }

  bool _isPrescriptionLocked(Map<String, dynamic> rx) {
    final lifecycle = rx['lifecycle_status']?.toString().toLowerCase() ?? '';
    final status = rx['status']?.toString().toLowerCase() ?? '';
    return rx['signed_at'] != null ||
        rx['locked_at'] != null ||
        lifecycle == 'signed' ||
        status == 'fulfilled' ||
        status == 'dispensed' ||
        status == 'cancelled' ||
        status == 'canceled';
  }

  void _populateFromExistingPrescription(Map<String, dynamic> rx) {
    final id = _asInt(rx['id']);
    _appointmentPrescriptionId = id;
    _lastCreatedPrescriptionId = id;
    _lastCreatedPrescriptionPdfUrl = rx['pdf_url']?.toString();
    _appointmentPrescriptionLocked = _isPrescriptionLocked(rx);
    _lastCreatedPrescriptionSigned = _appointmentPrescriptionLocked;
    _setControllerIfEmpty(_diagnosisCtrl, rx['diagnosis']);
    _setControllerIfEmpty(_clinicalNotesCtrl, rx['clinical_notes']);
    _setControllerIfEmpty(_followUpNotesCtrl, rx['follow_up_notes']);
    final followUp = rx['follow_up_date']?.toString();
    if (followUp != null && followUp.isNotEmpty) {
      _followUpDate ??= DateTime.tryParse(followUp);
    }

    final rawMeds = rx['medications'];
    Object medList = const [];
    if (rawMeds is List) {
      medList = rawMeds;
    } else if (rawMeds is String && rawMeds.trim().isNotEmpty) {
      try {
        medList = jsonDecode(rawMeds);
      } catch (_) {
        medList = const [];
      }
    }
    if (medList is List && medList.isNotEmpty) {
      _disposeMedicationEditors();
      _medications
        ..clear()
        ..addAll(
          medList.whereType<Map>().map(
            (item) => _MedicationEntry.fromJson(item.cast<String, dynamic>()),
          ),
        );
      for (final med in _medications) {
        _syncMedicationDerivedFields(med);
      }
    }
  }

  Future<void> _prefillLatestVitals() async {
    final patient = _patientIdentifierForVitals();
    if (patient == null) return;
    try {
      final data = await MedicalApiService.getLatestVitals(patient);
      final vitals = data['id'] != null ? data : data['vitals'];
      if (vitals is! Map) return;
      if (!mounted) return;
      setState(() {
        _setControllerIfEmpty(_bpSysCtrl, vitals['systolic_bp']);
        _setControllerIfEmpty(_bpDiaCtrl, vitals['diastolic_bp']);
        _setControllerIfEmpty(_pulseCtrl, vitals['heart_rate']);
        _setControllerIfEmpty(_tempCtrl, vitals['temperature']);
        _setControllerIfEmpty(_respRateCtrl, vitals['respiratory_rate']);
        _setControllerIfEmpty(_spo2Ctrl, vitals['spo2']);
        _setControllerIfEmpty(_weightCtrl, vitals['weight_kg']);
        _setControllerIfEmpty(_heightCtrl, vitals['height_cm']);
        final route = vitals['temperature_route']?.toString();
        if (route != null && route.isNotEmpty && _temperatureRoute == null) {
          _temperatureRoute = route;
        }
        _showVitals = true;
      });
    } catch (_) {
      // Latest vitals are helpful prefill only; prescription creation remains usable.
    }
  }

  Map<String, dynamic>? _buildVitals() {
    final v = <String, dynamic>{};
    final bpSys = normalizeVitalValue(_bpSysCtrl.text, VitalUnit.bp);
    final bpDia = normalizeVitalValue(_bpDiaCtrl.text, VitalUnit.bp);
    final pulse = normalizeVitalValue(_pulseCtrl.text, VitalUnit.pulse);
    final temp = normalizeVitalValue(_tempCtrl.text, VitalUnit.temperature);
    final respRate = normalizeVitalValue(
      _respRateCtrl.text,
      VitalUnit.respiratoryRate,
    );
    final spo2 = normalizeVitalValue(_spo2Ctrl.text, VitalUnit.spo2);
    final weight = normalizeVitalValue(_weightCtrl.text, VitalUnit.weight);
    final height = normalizeVitalValue(_heightCtrl.text, 'cm');
    final bloodSugar = normalizeVitalValue(_bsCtrl.text, VitalUnit.cbg);
    if (bpSys.isNotEmpty) {
      v['bp_systolic'] = int.tryParse(bpSys);
    }
    if (bpDia.isNotEmpty) {
      v['bp_diastolic'] = int.tryParse(bpDia);
    }
    if (pulse.isNotEmpty) {
      v['pulse'] = int.tryParse(pulse);
    }
    if (temp.isNotEmpty) {
      v['temperature'] = double.tryParse(temp);
    }
    if (_temperatureRoute != null && _temperatureRoute!.isNotEmpty) {
      v['temperature_route'] = _temperatureRoute;
    }
    if (respRate.isNotEmpty) {
      v['respiratory_rate'] = int.tryParse(respRate);
    }
    if (spo2.isNotEmpty) {
      v['spo2'] = int.tryParse(spo2);
    }
    if (weight.isNotEmpty) {
      v['weight'] = double.tryParse(weight);
      v['weight_kg'] = double.tryParse(weight);
    }
    if (height.isNotEmpty) {
      v['height_cm'] = double.tryParse(height);
    }
    if (bloodSugar.isNotEmpty) {
      v['blood_sugar'] = int.tryParse(bloodSugar);
    }
    return v.isEmpty ? null : v;
  }

  int? _createdPrescriptionId(Map<String, dynamic> result) {
    final value =
        result['id'] ?? result['prescription_id'] ?? result['data']?['id'];
    if (value is int) return value;
    return int.tryParse(value?.toString() ?? '');
  }

  Future<String?> _loadPrescriptionPdfUrl(int prescriptionId) async {
    try {
      return await MedicalApiService.getPrescriptionPdfUrl(prescriptionId);
    } catch (_) {
      return null;
    }
  }

  Future<String?> _orderInHousePharmacyIfNeeded({
    required int prescriptionId,
    required List<Map<String, dynamic>> medications,
  }) async {
    if (_preferredPharmacy != 'In House Dispensary') return null;
    final strings = AppStrings.of(context);
    try {
      final order = await MedicalApiService.orderPrescriptionToPharmacy(
        prescriptionId,
        deliveryType: 'counter',
        medications: medications,
      );
      final orderNumber =
          order['order_number'] ?? order['data']?['order_number'] ?? '';
      return orderNumber.toString().trim().isEmpty
          ? strings.lookup('s4.lib.prescriptions.pharmacy_order_sent')
          : strings.format(
              's4.dynamic.prescriptions.pharmacy_order_sent_number',
              {'number': orderNumber},
            );
    } catch (e) {
      return strings.format(
        's4.dynamic.prescriptions.pharmacy_handoff_needs_formulary_match',
        {'error': e.toString().replaceFirst('Exception: ', '')},
      );
    }
  }

  Future<void> _openPrescriptionPdf(String? url) async {
    final parsed = Uri.tryParse(url ?? '');
    if (parsed == null) {
      ErrorToast.show(
        context,
        AppStrings.of(
          context,
        ).lookup('s4.lib.prescriptions.pdf_not_available_yet'),
      );
      return;
    }
    final launched = await launchUrl(
      parsed,
      mode: LaunchMode.externalApplication,
    );
    if (!launched && mounted) {
      ErrorToast.show(
        context,
        AppStrings.of(context).lookup('s4.lib.prescriptions.pdf_open_failed'),
      );
    }
  }

  Future<void> _signLastPrescription() async {
    final id = _lastCreatedPrescriptionId;
    if (id == null || _lastCreatedPrescriptionSigned) return;
    setState(() => _signingLastPrescription = true);
    try {
      await MedicalApiService.signEPrescription(id);
      if (!mounted) return;
      setState(() {
        _lastCreatedPrescriptionSigned = true;
        _signingLastPrescription = false;
      });
      SuccessToast.show(
        context,
        AppStrings.of(context).lookup('s4.lib.prescriptions.signed_locked'),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _signingLastPrescription = false);
      ErrorToast.show(context, e.toString().replaceFirst('Exception: ', ''));
    }
  }

  Future<void> _printLastPrescriptionPdf() async {
    final id = _lastCreatedPrescriptionId;
    if (id == null || _printingLastPrescription) return;
    setState(() => _printingLastPrescription = true);
    try {
      await ClinicalPrintService.printPrescription(prescriptionId: id);
    } catch (e) {
      if (!mounted) return;
      final strings = AppStrings.of(context);
      ErrorToast.show(
        context,
        strings.format('s4.dynamic.prescriptions.pdf_open_failed_detail', {
          'error': e.toString().replaceFirst('Exception: ', ''),
        }),
      );
    } finally {
      if (mounted) setState(() => _printingLastPrescription = false);
    }
  }

  Future<void> _submit() async {
    if (_submitting) return;
    if (!_formKey.currentState!.validate()) return;
    if (_patientId == null || _doctorId == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            AppStrings.of(context).prescriptionsErrorSelectPatientDoctor,
          ),
          backgroundColor: AppTheme.errorRed,
        ),
      );
      return;
    }
    if (_appointmentPrescriptionLocked) {
      ErrorToast.show(
        context,
        AppStrings.of(
          context,
        ).lookup('s4.lib.prescriptions.visit_prescription_locked'),
      );
      return;
    }
    for (final med in _medications) {
      _syncMedicationDerivedFields(med);
    }
    if (_medications.any((m) => m.name.trim().isEmpty)) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            AppStrings.of(context).prescriptionsErrorFillMedicationNames,
          ),
          backgroundColor: AppTheme.errorRed,
        ),
      );
      return;
    }
    if (_medications.any((m) => m.days < 1)) {
      ErrorToast.show(
        context,
        AppStrings.of(
          context,
        ).lookup('s4.lib.prescriptions.days_must_be_at_least_1'),
      );
      return;
    }

    setState(() => _submitting = true);
    try {
      final meds = _medications.map((m) => m.toJson()).toList();

      if (!ConnectivitySyncService.instance.isOnline) {
        // Photo prescriptions can't be queued — the offline queue is JSON-only.
        if (_handwrittenPhoto != null) {
          if (mounted) {
            ErrorToast.show(
              context,
              AppStrings.of(
                context,
              ).lookup('s4.lib.prescriptions.photo_needs_connection'),
            );
            setState(() => _submitting = false);
          }
          return;
        }
        final intent = buildOfflineRxIntent(
          deviceType: currentDeviceType,
          patientId: _patientId!,
          doctorId: _doctorId!,
          appointmentId: _appointmentId,
          diagnosis: _diagnosisCtrl.text.trim(),
          clinicalNotes: _clinicalNotesCtrl.text.trim().isEmpty
              ? null
              : _clinicalNotesCtrl.text.trim(),
          medications: meds,
          followUpDate: _followUpDate != null
              ? DateFormat('yyyy-MM-dd').format(_followUpDate!)
              : null,
          followUpNotes: _followUpNotesCtrl.text.trim().isEmpty
              ? null
              : _followUpNotesCtrl.text.trim(),
          vitals: _buildVitals(),
        );
        if (intent.block) {
          if (mounted) {
            ErrorToast.show(context, intent.reason!);
            setState(() => _submitting = false);
          }
          return; // keep the form; NEVER enqueue on a blocked device
        }
        final firstName = meds.isNotEmpty
            ? (meds.first['name'] ??
                  meds.first['medication_name'] ??
                  'medication')
            : 'medication';
        await ConnectivitySyncService.instance.enqueue(
          endpoint: intent.endpoint,
          method: 'POST',
          body: intent.body,
          contextLabel: AppStrings.of(context).format(
            's4.dynamic.prescriptions.offline_context',
            {'name': firstName},
          ),
        );
        if (mounted) {
          SuccessToast.show(
            context,
            AppStrings.of(
              context,
            ).lookup('s4.lib.prescriptions.queued_safety_checked_on_sync'),
          );
          _formKey.currentState!.reset();
          setState(() {
            if (widget.prefilledAppointment == null) {
              _resetPrescriptionDraft(keepPatientContext: false);
            }
            _submitting = false;
          });
        }
        return;
      }

      // ── CDS hard-block preview ──
      // Run safety-check first so we can drive the modal without burning the
      // clinician's form state on a server-side 409.
      final safety = await MedicalApiService.checkPrescriptionSafety(
        patientId: _patientId!,
        medications: meds,
      );
      final blockers = (safety['blockers'] as List?) ?? const [];
      final warnings = (safety['warnings'] as List?) ?? const [];
      String? overrideReason;
      if (blockers.isNotEmpty) {
        if (!mounted) return;
        final outcome = await CdsBlockerModal.show(
          context,
          blockers: blockers,
          warnings: warnings,
        );
        if (outcome == null || !outcome.shouldProceed) {
          if (mounted) setState(() => _submitting = false);
          return;
        }
        overrideReason = outcome.overrideReason;
      } else if (warnings.isNotEmpty) {
        if (!mounted) return;
        final proceed = await _showPrescriptionWarnings(warnings);
        if (proceed != true) {
          if (mounted) setState(() => _submitting = false);
          return;
        }
      }

      final body = buildPrescriptionBody(
        patientId: _patientId!,
        doctorId: _doctorId!,
        appointmentId: _appointmentId,
        diagnosis: _diagnosisCtrl.text.trim(),
        clinicalNotes: _clinicalNotesCtrl.text.trim().isEmpty
            ? null
            : _clinicalNotesCtrl.text.trim(),
        medications: meds,
        followUpDate: _followUpDate != null
            ? DateFormat('yyyy-MM-dd').format(_followUpDate!)
            : null,
        followUpNotes: _followUpNotesCtrl.text.trim().isEmpty
            ? null
            : _followUpNotesCtrl.text.trim(),
        override: overrideReason != null ? {'reason': overrideReason} : null,
        vitals: _buildVitals(),
      );

      final editingPrescriptionId = _appointmentPrescriptionId;
      final result = editingPrescriptionId != null
          ? await MedicalApiService.updateEPrescription(
              editingPrescriptionId,
              body,
            )
          : await MedicalApiService.createEPrescription(
              body,
              photo: _handwrittenPhoto,
            );
      final createdId = _createdPrescriptionId(result);
      String? pdfUrl;
      String? pharmacyMessage;
      if (createdId != null && editingPrescriptionId == null) {
        pharmacyMessage = await _orderInHousePharmacyIfNeeded(
          prescriptionId: createdId,
          medications: meds,
        );
        pdfUrl = await _loadPrescriptionPdfUrl(createdId);
      } else if (createdId != null) {
        pdfUrl = await _loadPrescriptionPdfUrl(createdId);
      }
      final rxNum =
          result['prescription_number'] ??
          result['data']?['prescription_number'] ??
          '';

      if (mounted) {
        SuccessToast.show(
          context,
          AppStrings.of(context).prescriptionsCreated('$rxNum'),
        );
        if (pharmacyMessage != null && pharmacyMessage.isNotEmpty) {
          final isWarning = pharmacyMessage.contains('needs formulary match');
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(pharmacyMessage),
              backgroundColor: isWarning ? Colors.orange.shade800 : null,
            ),
          );
        }
        if (pdfUrl != null && pdfUrl.isNotEmpty) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: const AppText(
                's4.lib.prescriptions.prescription_pdf_is_ready',
              ),
              action: SnackBarAction(
                label: AppStrings.of(
                  context,
                ).lookup('s4.lib.prescriptions.open_pdf'),
                onPressed: () => _openPrescriptionPdf(pdfUrl),
              ),
            ),
          );
        }
        // Reset form
        _formKey.currentState!.reset();
        setState(() {
          _lastCreatedPrescriptionId = createdId;
          _lastCreatedPrescriptionPdfUrl = pdfUrl;
          _lastPharmacyOrderMessage = pharmacyMessage;
          _appointmentPrescriptionId = createdId ?? _appointmentPrescriptionId;
          _lastCreatedPrescriptionSigned = false;
          if (widget.prefilledAppointment == null) {
            _resetPrescriptionDraft(keepPatientContext: false);
          }
        });
      }
    } catch (e) {
      if (mounted) {
        ErrorToast.show(context, e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<bool?> _showPrescriptionWarnings(List<dynamic> warnings) {
    return showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        title: const Row(
          children: [
            Icon(Icons.warning_amber_outlined, color: Colors.orange),
            SizedBox(width: 8),
            Expanded(
              child: AppText(
                's4.lib.prescriptions.review_prescription_warnings',
              ),
            ),
          ],
        ),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const AppText(
                's4.lib.prescriptions.the_server_returned_non_blocking_cds_warnings_fo',
              ),
              const SizedBox(height: 12),
              for (final warning in warnings)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(
                        Icons.info_outline,
                        size: 18,
                        color: AppTheme.warningOnSurface,
                      ),
                      const SizedBox(width: 8),
                      Expanded(child: Text(_cdsIssueText(warning))),
                    ],
                  ),
                ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const AppText('s4.lib.prescriptions.review_draft'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const AppText('s4.lib.prescriptions.continue'),
          ),
        ],
      ),
    );
  }

  String _cdsIssueText(dynamic issue) {
    if (issue is Map) {
      for (final key in const ['message', 'reason', 'description', 'type']) {
        final text = issue[key]?.toString().trim() ?? '';
        if (text.isNotEmpty && text.toLowerCase() != 'null') return text;
      }
    }
    final text = issue?.toString().trim() ?? '';
    return text.isEmpty ? 'Prescription warning' : text;
  }

  Future<void> _pickPhoto() async {
    final s = AppStrings.of(context);
    final source = await showDialog<ImageSource>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(s.prescriptionsPhotoTitle),
        content: Text(s.prescriptionsPhotoBody),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, ImageSource.camera),
            child: Text(s.prescriptionsPhotoCamera),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, ImageSource.gallery),
            child: Text(s.prescriptionsPhotoGallery),
          ),
        ],
      ),
    );
    if (source == null) return;
    final picker = ImagePicker();
    final picked = await picker.pickImage(
      source: source,
      maxWidth: 1920,
      imageQuality: 85,
    );
    if (picked != null) {
      setState(() => _handwrittenPhoto = File(picked.path));
    }
  }

  String _durationForDays(int days) => days <= 1 ? '$days day' : '$days days';

  Map<String, String> _routeLabels(AppStrings s) => {
    'Oral': s.lookup('s4.lib.prescriptions.route.oral'),
    'IV': s.lookup('s4.lib.prescriptions.route.iv'),
    'IM': s.lookup('s4.lib.prescriptions.route.im'),
    'Topical': s.lookup('s4.lib.prescriptions.route.topical'),
    'Inhalation': s.lookup('s4.lib.prescriptions.route.inhalation'),
    'Sublingual': s.lookup('s4.lib.prescriptions.route.sublingual'),
  };

  Map<String, String> _pharmacyLabels(AppStrings s) => {
    'In House Dispensary': s.lookup(
      's4.lib.prescriptions.pharmacy.in_house_dispensary',
    ),
    'Patient choice': s.lookup('s4.lib.prescriptions.pharmacy.patient_choice'),
    'External pharmacy': s.lookup(
      's4.lib.prescriptions.pharmacy.external_pharmacy',
    ),
  };

  Map<String, String> _foodTimingLabels(AppStrings s) => {
    '': s.lookup('s4.lib.prescriptions.any_time'),
    'Before food': s.drugChartFoodBefore,
    'After food': s.drugChartFoodAfter,
    'With food': s.drugChartFoodWith,
    'Empty stomach': s.drugChartFoodEmptyStomach,
    'At bedtime': s.drugChartFoodBedtime,
  };

  String _frequencyForDoseTimes(Set<String> doseTimes) {
    final slots = _doseSlotLabels.keys
        .where((key) => doseTimes.contains(key))
        .toList(growable: false);
    if (slots.isEmpty) return 'SOS';
    if (slots.length == 1) return slots.single == 'night' ? 'HS' : 'OD';
    if (slots.length == 2 &&
        slots.contains('morning') &&
        slots.contains('night')) {
      return 'BD';
    }
    if (slots.length == 3 &&
        slots.contains('morning') &&
        slots.contains('afternoon') &&
        slots.contains('night')) {
      return 'TDS';
    }
    if (slots.length == 4) return 'QID';
    return slots.map((slot) => _doseSlotNames[slot] ?? slot).join(' + ');
  }

  String _routeForMedicineType(String type) {
    final text = type.trim().toLowerCase();
    if (text.contains('inj') ||
        text.contains('injection') ||
        text.contains('infusion') ||
        text.contains('vial') ||
        text.contains('ampoule')) {
      return 'IV';
    }
    if (text.contains('cream') ||
        text.contains('ointment') ||
        text.contains('gel') ||
        text.contains('lotion')) {
      return 'Topical';
    }
    if (text.contains('inhaler') || text.contains('nebul')) {
      return 'Inhalation';
    }
    return 'Oral';
  }

  String _drugFormPrefix({required String type, required String route}) {
    final combined = '$type $route'.trim().toLowerCase();
    if (combined.contains('inj') ||
        combined.contains('injection') ||
        combined.contains('infusion') ||
        combined.contains('vial') ||
        combined.contains('ampoule') ||
        route.toUpperCase() == 'IV' ||
        route.toUpperCase() == 'IM') {
      return 'Inj.';
    }
    if (combined.contains('cap') || combined.contains('capsule')) {
      return 'Cap.';
    }
    if (combined.contains('syrup') || combined.contains('suspension')) {
      return 'Syp.';
    }
    if (combined.contains('drops')) return 'Drops';
    if (combined.contains('inhaler')) return 'Inh.';
    if (combined.contains('cream')) return 'Cream';
    if (combined.contains('ointment')) return 'Oint.';
    if (combined.contains('sachet')) return 'Sachet';
    return 'Tab.';
  }

  String _stripDrugDisplayPrefix(String value) {
    return value
        .replaceFirst(
          RegExp(
            r'^\s*(tab\.?|tablet|inj\.?|injection|cap\.?|capsule|syp\.?|syrup|drops?|inh\.?|inhaler|cream|oint\.?|ointment|sachet)\s+',
            caseSensitive: false,
          ),
          '',
        )
        .trim();
  }

  bool _hasDrugDisplayPrefix(String value) {
    return RegExp(
      r'^\s*(tab\.?|tablet|inj\.?|injection|cap\.?|capsule|syp\.?|syrup|drops?|inh\.?|inhaler|cream|oint\.?|ointment|sachet)\b',
      caseSensitive: false,
    ).hasMatch(value);
  }

  String _drugDisplayName(
    String name, {
    required String type,
    required String route,
  }) {
    final clean = name.trim();
    if (clean.isEmpty) return '';
    if (_hasDrugDisplayPrefix(clean)) return clean;
    final prefix = _drugFormPrefix(type: type, route: route);
    return '$prefix $clean'.replaceAll(RegExp(r'\s+'), ' ').trim();
  }

  void _updateDrugControllerText(_MedicationEntry med) {
    final controller = _drugControllerFor(med);
    final text = med.displayName.trim().isNotEmpty
        ? med.displayName.trim()
        : med.name.trim();
    controller.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
  }

  void _syncMedicationDerivedFields(_MedicationEntry med) {
    final strength = med.strength.trim();
    if (strength.isNotEmpty && !med.strengthOptions.contains(strength)) {
      med.strengthOptions = [strength, ...med.strengthOptions];
    }
    if (med.dosage.trim().isEmpty) {
      final derived = med.strength.trim().isNotEmpty
          ? med.strength.trim()
          : deriveDoseFromDrug(med.name);
      if (derived.isNotEmpty) med.dosage = derived;
    }
    med.frequency = _frequencyForDoseTimes(med.doseTimes);
    med.duration = _durationForDays(med.days);
    med.quantity =
        med.days * (med.doseTimes.isEmpty ? 1 : med.doseTimes.length);
    if (med.pharmacy.trim().isEmpty) {
      med.pharmacy = _preferredPharmacy;
    }
    med.displayName = _drugDisplayName(
      _stripDrugDisplayPrefix(med.name),
      type: med.type,
      route: med.route,
    );
  }

  void _syncCatalogIdForStrength(_MedicationEntry med) {
    if (med.catalogRows.isEmpty || med.strength.trim().isEmpty) return;
    final selected = med.strength.trim().toLowerCase();
    for (final row in med.catalogRows) {
      if (_extractStrengthFromCatalog(row).toLowerCase() == selected) {
        _syncCatalogIdentityFromRow(med, row, resetOriginal: true);
        med.type = _extractMedicineTypeFromCatalog(row);
        med.route = _routeForMedicineType(med.type);
        med.category = _rowText(row, const ['category', 'drug_class']);
        return;
      }
    }
  }

  void _addBlankMedication() {
    setState(() {
      final med = _MedicationEntry(pharmacy: _preferredPharmacy);
      _syncMedicationDerivedFields(med);
      _medications.add(med);
    });
  }

  void _removeMedicationAt(int index) {
    if (_medications.length <= 1) return;
    final med = _medications[index];
    setState(() {
      _drugSuggestions.remove(med);
      _drugSuggestionLoading.remove(med);
      _drugSuggestionQuery.remove(med);
      _medications.removeAt(index);
    });
    _disposeMedicationEditor(med);
  }

  bool get _hasPrescriptionDraft {
    final hasMedication = _medications.any(
      (med) =>
          med.name.trim().isNotEmpty ||
          med.displayName.trim().isNotEmpty ||
          med.strength.trim().isNotEmpty ||
          med.instructions.trim().isNotEmpty,
    );
    return hasMedication ||
        _diagnosisCtrl.text.trim().isNotEmpty ||
        _clinicalNotesCtrl.text.trim().isNotEmpty ||
        _followUpNotesCtrl.text.trim().isNotEmpty ||
        _followUpDate != null ||
        _handwrittenPhoto != null;
  }

  void _resetPrescriptionDraft({
    bool keepPatientContext = true,
    bool keepLastCreated = true,
  }) {
    _disposeMedicationEditors();
    _drugSuggestions.clear();
    _drugSuggestionLoading.clear();
    _drugSuggestionQuery.clear();
    final med = _MedicationEntry(pharmacy: _preferredPharmacy);
    _syncMedicationDerivedFields(med);
    _medications
      ..clear()
      ..add(med);
    _diagnosisCtrl.clear();
    _clinicalNotesCtrl.clear();
    _followUpNotesCtrl.clear();
    _followUpDate = null;
    _handwrittenPhoto = null;
    _bpSysCtrl.clear();
    _bpDiaCtrl.clear();
    _pulseCtrl.clear();
    _tempCtrl.clear();
    _spo2Ctrl.clear();
    _weightCtrl.clear();
    _heightCtrl.clear();
    _respRateCtrl.clear();
    _temperatureRoute = null;
    _bsCtrl.clear();
    if (!keepPatientContext) {
      _patientId = null;
      _doctorId = null;
      _appointmentId = null;
      _patientUid = null;
      _patientName = null;
      _doctorName = null;
    }
    if (!keepLastCreated) {
      _lastCreatedPrescriptionId = null;
      _lastCreatedPrescriptionPdfUrl = null;
      _lastPharmacyOrderMessage = null;
      _lastCreatedPrescriptionSigned = false;
      _appointmentPrescriptionId = null;
      _appointmentPrescriptionLocked = false;
      _signingLastPrescription = false;
      _printingLastPrescription = false;
    }
  }

  Future<void> _clearPrescriptionDraft() async {
    if (!_hasPrescriptionDraft) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const AppText('s4.lib.prescriptions.clear_prescription_draft'),
        content: const AppText(
          's4.lib.prescriptions.this_removes_the_medicines_notes_vitals_and_foll',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const AppText('action.cancel'),
          ),
          FilledButton.icon(
            onPressed: () => Navigator.pop(ctx, true),
            icon: const Icon(Icons.delete_outline),
            label: const AppText('s4.lib.prescriptions.clear_draft'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _resetPrescriptionDraft(keepLastCreated: false));
  }

  String _rowText(Map<String, dynamic> row, List<String> keys) {
    for (final key in keys) {
      final value = row[key]?.toString().trim() ?? '';
      if (value.isNotEmpty && value.toLowerCase() != 'null') return value;
    }
    return '';
  }

  String _extractDrugNameFromCatalog(Map<String, dynamic> row) {
    if (row['__grouped'] == true) {
      return _rowText(row, const ['name', 'drug_name', 'medicine_name']);
    }
    final name = _rowText(row, const ['name', 'drug_name', 'medicine_name']);
    if (name.isEmpty) return '';
    final cleaned = name
        .replaceAll(
          RegExp(
            r'\b\d+(?:\.\d+)?\s?(?:mg|mcg|g|ml|iu|units?|%)\b',
            caseSensitive: false,
          ),
          ' ',
        )
        .replaceAll(RegExp(r'\s+\d+\s*$'), ' ')
        .replaceAll(RegExp(r'\s+'), ' ')
        .trim();
    return cleaned.isEmpty ? name : cleaned;
  }

  String _extractStrengthFromCatalog(Map<String, dynamic> row) {
    if (row['__grouped'] == true) {
      final options = row['strength_options'];
      if (options is List && options.isNotEmpty) {
        return options.first.toString();
      }
    }
    final explicit = _rowText(row, const ['strength', 'dosage', 'dose']);
    final strengthPattern = RegExp(
      r'(\d+(?:\.\d+)?\s?(?:mg|mcg|g|ml|iu|units?|%))',
      caseSensitive: false,
    );
    if (explicit.isNotEmpty) {
      final match = strengthPattern.firstMatch(explicit);
      return match?.group(1) ?? explicit;
    }
    final name = _rowText(row, const ['name', 'drug_name', 'medicine_name']);
    final match = strengthPattern.firstMatch(name);
    return match?.group(1) ?? '';
  }

  String _extractMedicineTypeFromCatalog(Map<String, dynamic> row) {
    final groupedForm = _rowText(row, const ['form', 'dosage_form', 'type']);
    if (row['__grouped'] == true && groupedForm.isNotEmpty) {
      return groupedForm;
    }
    final explicit = _rowText(row, const ['form', 'dosage_form', 'type']);
    if (explicit.isNotEmpty) return explicit;
    final text = [
      _rowText(row, const ['name', 'drug_name', 'medicine_name']),
      _rowText(row, const ['pack_size']),
      _rowText(row, const ['category', 'drug_class']),
    ].join(' ').toLowerCase();
    if (text.contains('inj') || text.contains('injection')) return 'Injection';
    if (text.contains('cap') || text.contains('capsule')) return 'Capsule';
    if (text.contains('syrup') || text.contains('suspension')) return 'Syrup';
    if (text.contains('drop')) return 'Drops';
    if (text.contains('inhaler')) return 'Inhaler';
    if (text.contains('cream') || text.contains('ointment')) return 'Cream';
    if (text.contains('sachet')) return 'Sachet';
    return 'Tablet';
  }

  List<String> _uniqueStrengths(Iterable<String> values) {
    final seen = <String>{};
    final out = <String>[];
    for (final value in values) {
      final text = value.trim();
      if (text.isEmpty) continue;
      final key = text.toLowerCase();
      if (seen.add(key)) out.add(text);
    }
    return out;
  }

  int _stockCount(Map<String, dynamic> row) {
    final value = row['stock'] ?? row['stock_quantity'] ?? row['quantity'];
    if (value is num) return value.toInt();
    return int.tryParse(value?.toString() ?? '') ?? 0;
  }

  bool _isCatalogRowInStock(Map<String, dynamic> row) {
    final explicit = row['in_stock'] ?? row['is_available'];
    if (explicit is bool && explicit == false) return false;
    return _stockCount(row) > 0 || explicit == true;
  }

  String _stockLabel(AppStrings s, Map<String, dynamic> row) {
    final availability = _rowText(row, const ['availability_status']);
    if (availability == 'may_be_available') {
      return s.lookup('s4.lib.prescriptions.may_be_available');
    }
    final count = _stockCount(row);
    if (!_isCatalogRowInStock(row)) {
      return s.lookup('s4.lib.prescriptions.out_of_stock');
    }
    if (count <= 0) return s.lookup('s4.lib.prescriptions.in_stock');
    return s.format('s4.dynamic.prescriptions.in_stock_count', {
      'count': count,
    });
  }

  String _catalogGroupKey(Map<String, dynamic> row) {
    final name = _extractDrugNameFromCatalog(row).toLowerCase();
    final generic = _rowText(row, const [
      'generic_name',
      'generic',
    ]).toLowerCase();
    return '$name|$generic';
  }

  List<Map<String, dynamic>> _groupCatalogRows(
    Iterable<Map<String, dynamic>> rows,
  ) {
    final groups = <String, List<Map<String, dynamic>>>{};
    for (final row in rows) {
      final key = _catalogGroupKey(row);
      if (key.trim() == '|') continue;
      groups.putIfAbsent(key, () => <Map<String, dynamic>>[]).add(row);
    }
    final grouped = <Map<String, dynamic>>[];
    for (final rows in groups.values) {
      rows.sort((a, b) {
        final stockDelta = _stockCount(b).compareTo(_stockCount(a));
        if (stockDelta != 0) return stockDelta;
        return _extractStrengthFromCatalog(
          a,
        ).compareTo(_extractStrengthFromCatalog(b));
      });
      final first = rows.first;
      final strengths = _uniqueStrengths(rows.map(_extractStrengthFromCatalog));
      final forms = _uniqueStrengths(rows.map(_extractMedicineTypeFromCatalog));
      final totalStock = rows.fold<int>(
        0,
        (sum, row) => sum + _stockCount(row),
      );
      grouped.add({
        '__grouped': true,
        '__rows': rows,
        'id': first['id'],
        'catalog_id': first['catalog_id'] ?? first['id'],
        'name': _extractDrugNameFromCatalog(first),
        'generic_name': _rowText(first, const ['generic_name', 'generic']),
        'category': _rowText(first, const ['category', 'drug_class']),
        'composition_id': first['composition_id'],
        'composition_label': first['composition_label'],
        'composition_confidence': first['composition_confidence'],
        'strength_key': first['strength_key'],
        'form_key': first['form_key'],
        'release_key': first['release_key'],
        'strength_options': strengths,
        'strength': strengths.isNotEmpty ? strengths.first : '',
        'form': forms.isNotEmpty
            ? forms.first
            : _extractMedicineTypeFromCatalog(first),
        'forms': forms,
        'stock': totalStock,
        'in_stock': rows.any(_isCatalogRowInStock),
        'pack_size': _rowText(first, const ['pack_size']),
      });
    }
    grouped.sort((a, b) {
      final stockDelta = _stockCount(b).compareTo(_stockCount(a));
      if (stockDelta != 0) return stockDelta;
      return _extractDrugNameFromCatalog(
        a,
      ).compareTo(_extractDrugNameFromCatalog(b));
    });
    return grouped.take(12).toList(growable: false);
  }

  String _normalizedCatalogSearchText(Object? value) {
    return value
            ?.toString()
            .toLowerCase()
            .replaceAll(RegExp(r'[^a-z0-9]+'), '')
            .trim() ??
        '';
  }

  List<String> _catalogSearchTokens(Object? value) {
    final text = value?.toString().toLowerCase() ?? '';
    return RegExp(r'[a-z0-9]+')
        .allMatches(text)
        .map((match) => match.group(0) ?? '')
        .where((token) => token.isNotEmpty)
        .toList(growable: false);
  }

  bool _catalogRowMatchesQuery(Map<String, dynamic> row, String query) {
    final cleanQuery = _stripDrugDisplayPrefix(query);
    final queryTokens = _catalogSearchTokens(cleanQuery);
    if (queryTokens.isEmpty) return true;
    final needle = _normalizedCatalogSearchText(cleanQuery);
    final fields = [
      _extractDrugNameFromCatalog(row),
      _rowText(row, const ['generic_name', 'generic']),
      _rowText(row, const ['name', 'drug_name', 'medicine_name']),
    ];
    return fields.any((field) {
      final normalized = _normalizedCatalogSearchText(
        _stripDrugDisplayPrefix(field),
      );
      final fieldTokens = _catalogSearchTokens(_stripDrugDisplayPrefix(field));
      if (normalized.startsWith(needle)) return true;
      return queryTokens.every(
        (queryToken) =>
            fieldTokens.any((fieldToken) => fieldToken.startsWith(queryToken)),
      );
    });
  }

  List<String> _strengthOptionsForCatalogRow(
    Map<String, dynamic> row,
    Iterable<Map<String, dynamic>> candidates,
  ) {
    if (row['__grouped'] == true) {
      final options = row['strength_options'];
      if (options is List) {
        return _uniqueStrengths(options.map((value) => value.toString()));
      }
    }
    final drugName = _extractDrugNameFromCatalog(row).toLowerCase();
    return _uniqueStrengths([
      _extractStrengthFromCatalog(row),
      ...candidates
          .where(
            (candidate) =>
                _extractDrugNameFromCatalog(candidate).toLowerCase() ==
                drugName,
          )
          .map(_extractStrengthFromCatalog),
    ]);
  }

  int? _rowInt(Map<String, dynamic> row, String key) {
    if (row['__grouped'] == true && row['__rows'] is List) {
      final rows = row['__rows'] as List;
      if (rows.isNotEmpty && rows.first is Map) {
        return _rowInt(Map<String, dynamic>.from(rows.first as Map), key);
      }
    }
    final value = row[key];
    if (value is int) return value;
    if (value is num) return value.toInt();
    return int.tryParse(value?.toString() ?? '');
  }

  int? _catalogIdFromRow(Map<String, dynamic> row) {
    return _rowInt(row, 'id') ?? _rowInt(row, 'catalog_id');
  }

  void _syncCatalogIdentityFromRow(
    _MedicationEntry med,
    Map<String, dynamic> row, {
    bool resetOriginal = false,
    int? originalCatalogId,
  }) {
    med.catalogId = _catalogIdFromRow(row) ?? med.catalogId;
    med.compositionId = _rowInt(row, 'composition_id') ?? med.compositionId;
    med.compositionLabel =
        _entryText(_rowText(row, const ['composition_label'])) ??
        med.compositionLabel;
    med.compositionConfidence =
        _entryText(_rowText(row, const ['composition_confidence'])) ??
        med.compositionConfidence;
    med.strengthKey =
        _entryText(_rowText(row, const ['strength_key'])) ?? med.strengthKey;
    med.form = _entryText(_rowText(row, const ['form'])) ?? med.form;
    med.formKey = _entryText(_rowText(row, const ['form_key'])) ?? med.formKey;
    med.releaseKey =
        _entryText(_rowText(row, const ['release_key'])) ?? med.releaseKey;
    if (originalCatalogId != null) {
      med.originalCatalogId = originalCatalogId;
    } else if (resetOriginal) {
      med.originalCatalogId = med.catalogId;
    } else {
      med.originalCatalogId ??= med.catalogId;
    }
  }

  void _clearCatalogIdentity(_MedicationEntry med) {
    med
      ..catalogId = null
      ..originalCatalogId = null
      ..compositionId = null
      ..compositionLabel = null
      ..compositionConfidence = null
      ..strengthKey = null
      ..form = null
      ..formKey = null
      ..releaseKey = null
      ..catalogRows = const [];
  }

  _MedicationEntry _medicationFromCatalogRow(Map<String, dynamic> row) {
    final name = _extractDrugNameFromCatalog(row);
    final strength = _extractStrengthFromCatalog(row);
    final type = _extractMedicineTypeFromCatalog(row);
    final route = _routeForMedicineType(type);
    final category = _rowText(row, const ['category', 'drug_class']);
    final catalogRows = row['__rows'] is List
        ? (row['__rows'] as List)
              .whereType<Map>()
              .map((value) => Map<String, dynamic>.from(value))
              .toList(growable: false)
        : <Map<String, dynamic>>[row];
    final med = _MedicationEntry(
      name: name,
      genericName: _rowText(row, const ['generic_name', 'generic']).isEmpty
          ? null
          : _rowText(row, const ['generic_name', 'generic']),
      catalogId: _catalogIdFromRow(row),
      originalCatalogId: _catalogIdFromRow(row),
      compositionId: _rowInt(row, 'composition_id'),
      compositionLabel: _entryText(_rowText(row, const ['composition_label'])),
      compositionConfidence: _entryText(
        _rowText(row, const ['composition_confidence']),
      ),
      strengthKey: _entryText(_rowText(row, const ['strength_key'])),
      form: _entryText(_rowText(row, const ['form'])),
      formKey: _entryText(_rowText(row, const ['form_key'])),
      releaseKey: _entryText(_rowText(row, const ['release_key'])),
      catalogRows: catalogRows,
      strength: strength,
      strengthOptions: _strengthOptionsForCatalogRow(row, [row]),
      dosage: strength,
      frequency: 'BD',
      days: 5,
      duration: _durationForDays(5),
      route: route,
      quantity: 1,
      type: type,
      category: category,
      pharmacy: _preferredPharmacy,
    );
    _syncMedicationDerivedFields(med);
    return med;
  }

  String _catalogDrugLabel(Map<String, dynamic> row) {
    final name = _extractDrugNameFromCatalog(row);
    final raw = name.isNotEmpty
        ? name
        : _rowText(row, const ['name', 'drug_name', 'medicine_name']);
    if (raw.isEmpty) return raw;
    final type = _extractMedicineTypeFromCatalog(row);
    return _drugDisplayName(
      raw,
      type: type,
      route: _routeForMedicineType(type),
    );
  }

  void _applyCatalogRowToMedication(
    _MedicationEntry target,
    Map<String, dynamic> row,
  ) {
    final selected = _medicationFromCatalogRow(row);
    final strengthOptions = _strengthOptionsForCatalogRow(
      row,
      _drugSuggestions[target] ?? [row],
    );
    setState(() {
      target
        ..name = selected.name
        ..displayName = selected.displayName
        ..genericName = selected.genericName
        ..catalogId = selected.catalogId
        ..originalCatalogId = selected.originalCatalogId
        ..compositionId = selected.compositionId
        ..compositionLabel = selected.compositionLabel
        ..compositionConfidence = selected.compositionConfidence
        ..strengthKey = selected.strengthKey
        ..form = selected.form
        ..formKey = selected.formKey
        ..releaseKey = selected.releaseKey
        ..catalogRows = selected.catalogRows
        ..strength = selected.strength
        ..strengthOptions = strengthOptions
        ..dosage = selected.dosage
        ..frequency = selected.frequency
        ..duration = selected.duration
        ..route = selected.route
        ..instructions = selected.instructions
        ..foodTiming = selected.foodTiming
        ..quantity = selected.quantity
        ..days = selected.days
        ..refills = selected.refills
        ..prn = selected.prn
        ..nte = selected.nte
        ..daw = selected.daw
        ..type = selected.type
        ..category = selected.category
        ..pharmacy = selected.pharmacy;
      _drugSuggestions[target] = [];
      _drugSuggestionLoading.remove(target);
      _drugSuggestionQuery.remove(target);
      _syncMedicationDerivedFields(target);
      _updateDrugControllerText(target);
    });
  }

  void _applyCompositionAlternative(
    _MedicationEntry target,
    CompositionAlternativeItem item,
  ) {
    final originalCatalogId = target.originalCatalogId ?? target.catalogId;
    final row = item.toCatalogRow(
      compositionId: target.compositionId,
      compositionLabel: target.compositionLabel ?? target.genericName,
    );
    final selected = _medicationFromCatalogRow(row);
    final strengthOptions = _uniqueStrengths([
      selected.strength,
      ...target.strengthOptions,
    ]);
    setState(() {
      target
        ..name = selected.name
        ..displayName = selected.displayName
        ..genericName = selected.genericName
        ..catalogId = selected.catalogId
        ..originalCatalogId = originalCatalogId
        ..compositionId = target.compositionId ?? selected.compositionId
        ..compositionLabel =
            target.compositionLabel ?? selected.compositionLabel
        ..compositionConfidence =
            target.compositionConfidence ?? selected.compositionConfidence
        ..strengthKey = selected.strengthKey
        ..form = selected.form
        ..formKey = selected.formKey
        ..releaseKey = selected.releaseKey
        ..catalogRows = [row]
        ..strength = selected.strength
        ..strengthOptions = strengthOptions
        ..dosage = selected.dosage
        ..route = selected.route
        ..type = selected.type
        ..category = selected.category;
      _drugSuggestions[target] = [];
      _drugSuggestionLoading.remove(target);
      _drugSuggestionQuery.remove(target);
      _syncMedicationDerivedFields(target);
      _updateDrugControllerText(target);
    });
  }

  Future<void> _searchDrugSuggestions(
    _MedicationEntry med,
    String query,
  ) async {
    final q = query.trim();
    if (q.isEmpty) {
      final needsClear =
          _drugSuggestions.containsKey(med) ||
          _drugSuggestionLoading.contains(med) ||
          _drugSuggestionQuery.containsKey(med);
      if (needsClear) {
        setState(() {
          _drugSuggestions.remove(med);
          _drugSuggestionLoading.remove(med);
          _drugSuggestionQuery.remove(med);
        });
        _refreshDrugAutocompleteOptions(med);
      }
      return;
    }
    setState(() {
      _drugSuggestionQuery[med] = q;
      _drugSuggestionLoading.add(med);
    });
    try {
      final rows = await MedicalApiService.searchMedicationCatalog(
        q,
        minLength: 1,
      );
      if (!mounted) return;
      if (_drugSuggestionQuery[med] != q) return;
      final relevantRows = rows
          .where((row) => _catalogRowMatchesQuery(row, q))
          .toList(growable: false);
      setState(() {
        _drugSuggestions[med] = _groupCatalogRows(relevantRows);
      });
      _refreshDrugAutocompleteOptions(med);
    } catch (e) {
      if (!mounted) return;
      setState(() => _drugSuggestions[med] = const []);
      _refreshDrugAutocompleteOptions(med);
    } finally {
      if (mounted && _drugSuggestionQuery[med] == q) {
        setState(() => _drugSuggestionLoading.remove(med));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Shortcuts(
      shortcuts: const {
        SingleActivator(LogicalKeyboardKey.enter, control: true):
            _SubmitPrescriptionIntent(),
        SingleActivator(LogicalKeyboardKey.keyN, control: true):
            _AddMedicationIntent(),
      },
      child: Actions(
        actions: {
          _SubmitPrescriptionIntent: CallbackAction<_SubmitPrescriptionIntent>(
            onInvoke: (_) {
              if (!_submitting) _submit();
              return null;
            },
          ),
          _AddMedicationIntent: CallbackAction<_AddMedicationIntent>(
            onInvoke: (_) {
              _addBlankMedication();
              return null;
            },
          ),
        },
        child: LayoutBuilder(
          builder: (context, constraints) {
            final desktop = constraints.maxWidth >= 1050;
            return SingleChildScrollView(
              padding: const EdgeInsets.all(16),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _buildPatientDoctorSelectors(s),
                    const SizedBox(height: 12),
                    _buildClinicalContextCard(s, desktop: desktop),
                    const SizedBox(height: 12),
                    _buildRxWorkspace(s, desktop: desktop),
                    const SizedBox(height: 12),
                    _buildFollowupAndSubmit(s, desktop: desktop),
                    const SizedBox(height: 32),
                  ],
                ),
              ),
            );
          },
        ),
      ),
    );
  }

  Widget _buildPatientDoctorSelectors(AppStrings s) {
    return Wrap(
      spacing: 10,
      runSpacing: 10,
      children: [
        if (_patientName != null)
          SizedBox(
            width: 320,
            child: _infoCard(
              s.prescriptionsPatientLabel,
              _patientName!,
              Icons.person,
            ),
          ),
        if (_doctorName != null)
          SizedBox(
            width: 320,
            child: _infoCard(
              s.prescriptionsDoctorLabel,
              _doctorName!,
              Icons.medical_services,
            ),
          ),
        if (_patientId == null)
          SizedBox(
            width: 360,
            child: _PatientSearchField(
              onSelected: (id, name) {
                setState(() {
                  _patientId = id;
                  _patientName = name;
                });
              },
            ),
          ),
        if (_doctorId == null)
          SizedBox(
            width: 360,
            child: _DoctorSearchField(
              onSelected: (id, name) {
                setState(() {
                  _doctorId = id;
                  _doctorName = name;
                });
              },
            ),
          ),
      ],
    );
  }

  Widget _buildClinicalContextCard(AppStrings s, {required bool desktop}) {
    final fields = <Widget>[
      Expanded(
        flex: 3,
        child: TextFormField(
          controller: _diagnosisCtrl,
          decoration: InputDecoration(
            labelText: s.prescriptionsDiagnosisLabel,
            prefixIcon: const ExcludeSemantics(
              child: Icon(Icons.local_hospital_outlined),
            ),
            alignLabelWithHint: true,
          ),
          maxLines: desktop ? 2 : 3,
          validator: (v) => (v == null || v.trim().isEmpty)
              ? s.prescriptionsDiagnosisRequired
              : null,
        ),
      ),
      Expanded(
        flex: 4,
        child: TextFormField(
          controller: _clinicalNotesCtrl,
          decoration: InputDecoration(
            labelText: s.prescriptionsClinicalNotes,
            hintText: s.prescriptionsClinicalNotesHint,
            prefixIcon: const ExcludeSemantics(
              child: Icon(Icons.notes_outlined),
            ),
            alignLabelWithHint: true,
          ),
          maxLines: desktop ? 2 : 3,
        ),
      ),
    ];
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.assignment_outlined, color: Color(0xFF00838F)),
                const SizedBox(width: 8),
                AppText(
                  's4.lib.prescriptions.op_consultation_context',
                  style: TextStyle(
                    color: AppTheme.textPrimary,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const Spacer(),
                TextButton.icon(
                  onPressed: () => setState(() => _showVitals = !_showVitals),
                  icon: Icon(
                    _showVitals
                        ? Icons.keyboard_arrow_up
                        : Icons.keyboard_arrow_down,
                  ),
                  label: Text(s.prescriptionsVitalsCollapse),
                ),
              ],
            ),
            const SizedBox(height: 10),
            if (desktop)
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [fields[0], const SizedBox(width: 12), fields[1]],
              )
            else
              Column(
                children: [fields[0], const SizedBox(height: 10), fields[1]],
              ),
            if (_showVitals) ...[
              const SizedBox(height: 12),
              _buildVitalsPanel(s),
            ],
            if (_loadingAppointmentPrescription ||
                _appointmentPrescriptionId != null) ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  Icon(
                    _appointmentPrescriptionLocked
                        ? Icons.lock_outline
                        : Icons.receipt_long_outlined,
                    size: 18,
                    color: _appointmentPrescriptionLocked
                        ? AppTheme.warningOnSurface
                        : AppTheme.successOnSurface,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _loadingAppointmentPrescription
                          ? 'Checking whether this OP visit already has a prescription...'
                          : _appointmentPrescriptionLocked
                          ? 'This visit prescription is signed and locked.'
                          : 'Editing the existing prescription for this OP visit.',
                      style: TextStyle(color: AppTheme.textSecondary),
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildVitalsPanel(AppStrings s) {
    return Column(
      children: [
        Row(
          children: [
            Expanded(
              child: _miniField(
                _bpSysCtrl,
                s.prescriptionsBpSystolic,
                VitalUnit.bp,
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: _miniField(
                _bpDiaCtrl,
                s.prescriptionsBpDiastolic,
                VitalUnit.bp,
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: _miniField(
                _pulseCtrl,
                s.prescriptionsPulse,
                VitalUnit.pulse,
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: _miniField(
                _tempCtrl,
                s.prescriptionsTemp,
                VitalUnit.temperature,
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: _miniField(_spo2Ctrl, s.prescriptionsSpo2, VitalUnit.spo2),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: _miniField(
                _weightCtrl,
                s.prescriptionsWeight,
                VitalUnit.weight,
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: _miniField(
                _heightCtrl,
                s.lookup('s4.lib.prescriptions.height'),
                'cm',
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: _miniField(
                _respRateCtrl,
                s.lookup('s4.lib.prescriptions.resp_rate'),
                VitalUnit.respiratoryRate,
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: _miniField(
                _bsCtrl,
                s.prescriptionsBloodSugar,
                VitalUnit.cbg,
              ),
            ),
          ],
        ),
      ],
    );
  }

  Widget _buildRxWorkspace(AppStrings s, {required bool desktop}) {
    return _buildSelectedMedicationPanel(s, desktop: desktop);
  }

  Widget _buildSelectedMedicationPanel(AppStrings s, {required bool desktop}) {
    final pharmacyPicker = SizedBox(
      width: desktop ? 260 : double.infinity,
      child: DropdownButtonFormField<String>(
        isExpanded: true,
        initialValue: _preferredPharmacy,
        decoration: InputDecoration(
          labelText: AppStrings.of(context).lookup('dashboard.action.pharmacy'),
          isDense: true,
          prefixIcon: const Icon(Icons.local_pharmacy_outlined),
        ),
        items: _pharmacyOptions
            .map(
              (value) => DropdownMenuItem(
                value: value,
                child: Text(_pharmacyLabels(s)[value] ?? value),
              ),
            )
            .toList(),
        onChanged: (value) {
          if (value == null) return;
          setState(() {
            _preferredPharmacy = value;
            for (final med in _medications) {
              if (med.pharmacy.isEmpty ||
                  _pharmacyOptions.contains(med.pharmacy)) {
                med.pharmacy = value;
              }
            }
          });
        },
      ),
    );
    final addButton = TextButton.icon(
      onPressed: _addBlankMedication,
      icon: const Icon(Icons.add),
      label: Text(s.prescriptionsAddButton),
    );
    final clearButton = TextButton.icon(
      onPressed: _submitting ? null : _clearPrescriptionDraft,
      icon: const Icon(Icons.delete_outline),
      label: const AppText('s4.lib.prescriptions.clear_draft'),
      style: TextButton.styleFrom(foregroundColor: AppTheme.errorOnSurface),
    );
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (desktop)
              Row(
                children: [
                  const Icon(Icons.medication_liquid, color: Color(0xFF00838F)),
                  const SizedBox(width: 8),
                  Expanded(
                    child: AppText(
                      's4.lib.prescriptions.add_drug',
                      style: TextStyle(
                        color: AppTheme.textPrimary,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                  pharmacyPicker,
                  const SizedBox(width: 8),
                  clearButton,
                  const SizedBox(width: 4),
                  addButton,
                ],
              )
            else
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(
                        Icons.medication_liquid,
                        color: Color(0xFF00838F),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: AppText(
                          's4.lib.prescriptions.add_drug',
                          style: TextStyle(
                            color: AppTheme.textPrimary,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                      ),
                      clearButton,
                      const SizedBox(width: 6),
                      addButton,
                    ],
                  ),
                  const SizedBox(height: 8),
                  pharmacyPicker,
                ],
              ),
            if (_favorites.isNotEmpty) ...[
              const SizedBox(height: 8),
              _buildFavoritesStrip(),
            ],
            const SizedBox(height: 8),
            _buildMedicationTable(),
            _buildCompositionAlternativesSection(),
          ],
        ),
      ),
    );
  }

  Widget _buildCompositionAlternativesSection() {
    final panels = _medications
        .where(
          (med) => shouldShowCompositionAlternativesPanel(
            catalogId: med.catalogId,
            compositionConfidence: med.compositionConfidence,
          ),
        )
        .toList(growable: false);
    if (panels.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 8),
        for (final med in panels)
          CompositionAlternativesPanel(
            key: ValueKey(
              'composition-alternatives-${identityHashCode(med)}-${med.catalogId}',
            ),
            catalogId: med.catalogId,
            visible: true,
            doNotSubstitute: med.daw,
            selectedLabel: med.displayName.trim().isNotEmpty
                ? med.displayName.trim()
                : med.name.trim(),
            onSwap: (item) => _applyCompositionAlternative(med, item),
          ),
      ],
    );
  }

  Widget _buildFavoritesStrip() {
    return SizedBox(
      height: 42,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: _favorites.length,
        separatorBuilder: (context, index) => const SizedBox(width: 8),
        itemBuilder: (context, index) {
          final med = _favorites[index];
          final drugName = med.displayName.trim().isNotEmpty
              ? med.displayName.trim()
              : med.name.trim();
          final subtitle = [
            if (med.strength.trim().isNotEmpty) med.strength.trim(),
            med.frequency,
          ].where((value) => value.trim().isNotEmpty).join(' • ');
          return InputChip(
            avatar: const Icon(Icons.star, size: 16),
            label: Text(
              subtitle.isEmpty ? drugName : '$drugName ($subtitle)',
              overflow: TextOverflow.ellipsis,
            ),
            tooltip: AppStrings.of(
              context,
            ).lookup('s4.lib.prescriptions.use_favorite'),
            onPressed: () => _applyFavorite(med),
            onDeleted: () => _removeFavorite(med),
          );
        },
      ),
    );
  }

  Widget _buildMedicationTable() {
    return LayoutBuilder(
      builder: (context, constraints) {
        final compact = constraints.maxWidth < 980;
        final tableWidth = math.max(
          constraints.maxWidth,
          compact ? 1180.0 : 1320.0,
        );
        final drugWidth = compact ? 250.0 : 300.0;
        final notesWidth = compact ? 210.0 : 280.0;
        return Scrollbar(
          controller: _medicationTableHorizontalCtrl,
          thumbVisibility: true,
          trackVisibility: true,
          interactive: true,
          child: SingleChildScrollView(
            controller: _medicationTableHorizontalCtrl,
            scrollDirection: Axis.horizontal,
            primary: false,
            child: SizedBox(
              width: tableWidth,
              child: DataTable(
                headingRowHeight: 38,
                dataRowMinHeight: 86,
                dataRowMaxHeight: 116,
                columnSpacing: compact ? 6 : 8,
                horizontalMargin: compact ? 8 : 12,
                columns: const [
                  DataColumn(label: AppText('s4.lib.prescriptions.drug_form')),
                  DataColumn(label: AppText('drug_chart.column.dose')),
                  DataColumn(label: AppText('drug_chart.column.route')),
                  DataColumn(
                    label: AppText(
                      's4.lib.prescriptions.dose_slot_morning_short',
                    ),
                  ),
                  DataColumn(
                    label: AppText(
                      's4.lib.prescriptions.dose_slot_afternoon_short',
                    ),
                  ),
                  DataColumn(
                    label: AppText(
                      's4.lib.prescriptions.dose_slot_evening_short',
                    ),
                  ),
                  DataColumn(
                    label: AppText(
                      's4.lib.prescriptions.dose_slot_night_short',
                    ),
                  ),
                  DataColumn(label: AppText('drug_chart.column.food')),
                  DataColumn(label: AppText('s4.lib.prescriptions.days')),
                  DataColumn(
                    label: AppText('s4.lib.prescriptions.notes_safety'),
                  ),
                  DataColumn(label: Text('')),
                ],
                rows: _medications.asMap().entries.map((entry) {
                  final index = entry.key;
                  final med = entry.value;
                  return DataRow(
                    cells: [
                      DataCell(
                        _drugAutocompleteField(
                          width: drugWidth,
                          medication: med,
                        ),
                      ),
                      DataCell(
                        _strengthDropdown(
                          width: compact ? 112 : 130,
                          medication: med,
                        ),
                      ),
                      DataCell(
                        _tableDropdown(
                          width: compact ? 104 : 118,
                          value: med.route.isEmpty ? 'Oral' : med.route,
                          options: _routes,
                          labels: _routeLabels(AppStrings.of(context)),
                          onChanged: (value) {
                            setState(() {
                              med.route = value;
                              _syncMedicationDerivedFields(med);
                              if (med.catalogId != null) {
                                _updateDrugControllerText(med);
                              }
                            });
                          },
                        ),
                      ),
                      ..._doseSlotLabels.keys.map(
                        (slot) => DataCell(
                          _doseTickCell(slot: slot, medication: med),
                        ),
                      ),
                      DataCell(
                        _foodTimingDropdown(
                          width: compact ? 118 : 132,
                          medication: med,
                        ),
                      ),
                      DataCell(
                        _tableNumberField(
                          width: compact ? 56 : 64,
                          value: med.days,
                          onChanged: (value) {
                            setState(() {
                              med.days = value;
                              med.duration = _durationForDays(value);
                              _syncMedicationDerivedFields(med);
                            });
                          },
                        ),
                      ),
                      DataCell(
                        _tableTextField(
                          width: notesWidth,
                          value: med.instructions,
                          hint: AppStrings.of(
                            context,
                          ).lookup('s4.lib.prescriptions.instructions_hint'),
                          onChanged: (value) => med.instructions = value,
                        ),
                      ),
                      DataCell(_rowActionCell(index, med)),
                    ],
                  );
                }).toList(),
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _strengthDropdown({
    required double width,
    required _MedicationEntry medication,
  }) {
    final options = _uniqueStrengths([
      medication.strength,
      ...medication.strengthOptions,
    ]);
    if (options.isEmpty) {
      return _tableTextField(
        width: width,
        value: medication.strength,
        hint: AppStrings.of(context).lookup('s4.lib.prescriptions.auto_filled'),
        onChanged: (value) {
          medication
            ..strength = value
            ..dosage = value;
        },
      );
    }
    final safeValue = options.contains(medication.strength)
        ? medication.strength
        : options.first;
    return SizedBox(
      width: width,
      child: DropdownButtonFormField<String>(
        isExpanded: true,
        initialValue: safeValue,
        decoration: const InputDecoration(isDense: true),
        items: options
            .map((value) => DropdownMenuItem(value: value, child: Text(value)))
            .toList(growable: false),
        onChanged: (value) {
          if (value == null) return;
          setState(() {
            medication
              ..strength = value
              ..dosage = value;
            _syncCatalogIdForStrength(medication);
            _syncMedicationDerivedFields(medication);
            if (medication.catalogId != null) {
              _updateDrugControllerText(medication);
            }
          });
        },
      ),
    );
  }

  Widget _foodTimingDropdown({
    required double width,
    required _MedicationEntry medication,
  }) {
    return _tableDropdown(
      width: width,
      value: _foodTimingOptions.contains(medication.foodTiming)
          ? medication.foodTiming
          : '',
      options: _foodTimingOptions,
      labels: _foodTimingLabels(AppStrings.of(context)),
      onChanged: (value) {
        setState(() => medication.foodTiming = value);
      },
    );
  }

  Widget _doseTickCell({
    required String slot,
    required _MedicationEntry medication,
  }) {
    final selected = medication.doseTimes.contains(slot);
    return SizedBox(
      width: 42,
      child: Center(
        child: Checkbox(
          value: selected,
          visualDensity: VisualDensity.compact,
          onChanged: (value) {
            setState(() {
              if (value == true) {
                medication.doseTimes.add(slot);
              } else {
                medication.doseTimes.remove(slot);
              }
              _syncMedicationDerivedFields(medication);
            });
          },
        ),
      ),
    );
  }

  Widget _rowActionCell(int index, _MedicationEntry med) {
    return SizedBox(
      width: 148,
      child: Wrap(
        spacing: 2,
        runSpacing: 2,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          _flagChip('PRN', med.prn, (value) {
            setState(() => med.prn = value);
          }),
          _flagChip('DAW', med.daw, (value) {
            setState(() => med.daw = value);
          }),
          IconButton(
            tooltip: AppStrings.of(
              context,
            ).lookup('s4.lib.prescriptions.save_favorite'),
            visualDensity: VisualDensity.compact,
            onPressed: med.name.trim().isEmpty
                ? null
                : () => _saveFavorite(med),
            icon: const Icon(Icons.star_border, size: 18),
          ),
          IconButton(
            tooltip: AppStrings.of(
              context,
            ).lookup('s4.lib.prescriptions.delete_row'),
            visualDensity: VisualDensity.compact,
            onPressed: _medications.length <= 1
                ? null
                : () => _removeMedicationAt(index),
            icon: const Icon(Icons.delete_outline, size: 18),
          ),
        ],
      ),
    );
  }

  Widget _drugAutocompleteField({
    required double width,
    required _MedicationEntry medication,
  }) {
    final loading = _drugSuggestionLoading.contains(medication);
    final controller = _drugControllerFor(medication);
    final focusNode = _drugFocusFor(medication);
    return SizedBox(
      width: width,
      child: RawAutocomplete<Map<String, dynamic>>(
        key: ValueKey('drug-${identityHashCode(medication)}'),
        textEditingController: controller,
        focusNode: focusNode,
        displayStringForOption: _catalogDrugLabel,
        optionsBuilder: (textEditingValue) {
          final q = textEditingValue.text.trim();
          if (q.isEmpty) return const <Map<String, dynamic>>[];
          return (_drugSuggestions[medication] ??
                  const <Map<String, dynamic>>[])
              .where((row) => _catalogRowMatchesQuery(row, q));
        },
        onSelected: (row) => _applyCatalogRowToMedication(medication, row),
        fieldViewBuilder:
            (context, textController, fieldFocusNode, onFieldSubmitted) {
              return TextFormField(
                controller: textController,
                focusNode: fieldFocusNode,
                decoration: InputDecoration(
                  hintText: AppStrings.of(
                    context,
                  ).lookup('s4.lib.prescriptions.type_drug_name'),
                  isDense: true,
                  prefixIcon: const Icon(Icons.search, size: 18),
                  suffixIcon: loading
                      ? const Padding(
                          padding: EdgeInsets.all(12),
                          child: SizedBox(
                            width: 14,
                            height: 14,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          ),
                        )
                      : medication.catalogId != null
                      ? const Icon(Icons.check_circle, size: 18)
                      : null,
                ),
                validator: (value) => value == null || value.trim().isEmpty
                    ? AppStrings.of(context).labelRequired
                    : null,
                onChanged: (value) {
                  final cleanName = _stripDrugDisplayPrefix(value);
                  medication
                    ..name = cleanName
                    ..displayName = ''
                    ..strength = ''
                    ..strengthOptions = []
                    ..dosage = ''
                    ..type = '';
                  _clearCatalogIdentity(medication);
                  _searchDrugSuggestions(medication, value);
                },
                onFieldSubmitted: (_) => onFieldSubmitted(),
              );
            },
        optionsViewBuilder: (context, onSelected, options) {
          final s = AppStrings.of(context);
          final rows = options.toList(growable: false);
          if (rows.isEmpty) return const SizedBox.shrink();
          return Align(
            alignment: Alignment.topLeft,
            child: Material(
              elevation: 6,
              borderRadius: BorderRadius.circular(8),
              color: AppTheme.cardSurface,
              child: ConstrainedBox(
                constraints: const BoxConstraints(
                  maxHeight: 260,
                  maxWidth: 420,
                  minWidth: 340,
                ),
                child: ListView.separated(
                  padding: EdgeInsets.zero,
                  shrinkWrap: true,
                  itemCount: rows.length,
                  separatorBuilder: (context, index) =>
                      Divider(height: 1, color: AppTheme.divider),
                  itemBuilder: (context, index) {
                    final row = rows[index];
                    final label = _catalogDrugLabel(row);
                    final generic = _rowText(row, const [
                      'generic_name',
                      'generic',
                    ]);
                    final strength = _extractStrengthFromCatalog(row);
                    final strengths = row['strength_options'] is List
                        ? (row['strength_options'] as List)
                              .map((value) => value.toString())
                              .where((value) => value.trim().isNotEmpty)
                              .take(4)
                              .join(', ')
                        : strength;
                    final pack = _rowText(row, const [
                      'pack_size',
                      'unit',
                      'form',
                      'dosage_form',
                    ]);
                    final stockColor = _isCatalogRowInStock(row)
                        ? AppTheme.successOnSurface
                        : AppTheme.errorOnSurface;
                    return ListTile(
                      dense: true,
                      title: Text(
                        label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: AppTheme.textPrimary,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      subtitle: Text(
                        [
                          if (generic.isNotEmpty) generic,
                          if (strengths.isNotEmpty) strengths,
                          if (pack.isNotEmpty && pack != strength) pack,
                        ].join(' • '),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: AppTheme.textSecondary),
                      ),
                      trailing: Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 8,
                          vertical: 4,
                        ),
                        decoration: BoxDecoration(
                          color: stockColor.withValues(alpha: 0.12),
                          borderRadius: BorderRadius.circular(999),
                          border: Border.all(
                            color: stockColor.withValues(alpha: 0.35),
                          ),
                        ),
                        child: Text(
                          _stockLabel(s, row),
                          style: TextStyle(
                            color: stockColor,
                            fontWeight: FontWeight.w800,
                            fontSize: 11,
                          ),
                        ),
                      ),
                      onTap: () => onSelected(row),
                    );
                  },
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _tableTextField({
    required double width,
    required String value,
    required ValueChanged<String> onChanged,
    String? hint,
    bool isRequired = false,
  }) {
    return SizedBox(
      width: width,
      child: TextFormField(
        key: ValueKey('$width-$value-$hint'),
        initialValue: value,
        decoration: InputDecoration(hintText: hint, isDense: true),
        validator: isRequired
            ? (value) => value == null || value.trim().isEmpty
                  ? AppStrings.of(context).labelRequired
                  : null
            : null,
        onChanged: onChanged,
      ),
    );
  }

  Widget _tableNumberField({
    required double width,
    required int value,
    required ValueChanged<int> onChanged,
    int min = 1,
  }) {
    return SizedBox(
      width: width,
      child: TextFormField(
        key: ValueKey('$width-$value-$min'),
        initialValue: '$value',
        keyboardType: TextInputType.number,
        decoration: const InputDecoration(isDense: true),
        onChanged: (text) => onChanged(int.tryParse(text) ?? min),
      ),
    );
  }

  Widget _tableDropdown({
    required double width,
    required String value,
    required List<String> options,
    required ValueChanged<String> onChanged,
    Map<String, String> labels = const {},
  }) {
    final safeValue = options.contains(value) ? value : options.first;
    return SizedBox(
      width: width,
      child: DropdownButtonFormField<String>(
        isExpanded: true,
        initialValue: safeValue,
        decoration: const InputDecoration(isDense: true),
        items: options
            .map(
              (option) => DropdownMenuItem(
                value: option,
                child: Text(labels[option] ?? option),
              ),
            )
            .toList(),
        onChanged: (value) {
          if (value != null) onChanged(value);
        },
      ),
    );
  }

  Widget _flagChip(String label, bool selected, ValueChanged<bool> onSelected) {
    return FilterChip(
      label: Text(label, style: const TextStyle(fontSize: 11)),
      selected: selected,
      onSelected: onSelected,
      visualDensity: VisualDensity.compact,
    );
  }

  Widget _buildFollowupAndSubmit(AppStrings s, {required bool desktop}) {
    final followUpButton = OutlinedButton.icon(
      onPressed: () async {
        final picked = await showDatePicker(
          context: context,
          initialDate: DateTime.now().add(const Duration(days: 7)),
          firstDate: DateTime.now(),
          lastDate: DateTime.now().add(const Duration(days: 365)),
        );
        if (picked != null) setState(() => _followUpDate = picked);
      },
      icon: const Icon(Icons.calendar_today, size: 18),
      label: Text(
        _followUpDate != null
            ? s.prescriptionsFollowUpPrefix(
                DateFormat('dd MMM yyyy').format(_followUpDate!),
              )
            : s.prescriptionsSetFollowUp,
      ),
    );
    final photoButton = OutlinedButton.icon(
      onPressed: _pickPhoto,
      icon: const Icon(Icons.camera_alt, size: 18),
      label: Text(
        _handwrittenPhoto != null
            ? s.prescriptionsPhotoAttached
            : s.prescriptionsAttachHandwritten,
      ),
    );
    final submitLabel = _appointmentPrescriptionLocked
        ? s.lookup('s4.lib.prescriptions.prescription_locked')
        : _appointmentPrescriptionId != null
        ? s.lookup('s4.lib.prescriptions.update_prescription')
        : s.prescriptionsCreate;
    final submitButton = PrescriptionSubmitButton(
      submitting: _submitting,
      locked: _appointmentPrescriptionLocked,
      submitLabel: submitLabel,
      onSubmit: _submit,
    );
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Wrap(
              spacing: 10,
              runSpacing: 10,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                followUpButton,
                if (_followUpDate != null)
                  IconButton(
                    icon: const Icon(Icons.clear, size: 18),
                    tooltip: s.prescriptionsClearFollowUp,
                    onPressed: () => setState(() => _followUpDate = null),
                  ),
                photoButton,
                if (_lastCreatedPrescriptionPdfUrl != null)
                  OutlinedButton.icon(
                    onPressed: () =>
                        _openPrescriptionPdf(_lastCreatedPrescriptionPdfUrl),
                    icon: const Icon(Icons.picture_as_pdf_outlined, size: 18),
                    label: Text(
                      _lastCreatedPrescriptionId == null
                          ? s.lookup('s4.lib.prescriptions.open_last_pdf')
                          : s.format('s4.dynamic.prescriptions.open_rx_pdf', {
                              'id': _lastCreatedPrescriptionId,
                            }),
                    ),
                  ),
                if (_lastCreatedPrescriptionId != null)
                  OutlinedButton.icon(
                    onPressed:
                        _signingLastPrescription ||
                            _lastCreatedPrescriptionSigned
                        ? null
                        : _signLastPrescription,
                    icon: _signingLastPrescription
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.verified_outlined, size: 18),
                    label: Text(
                      _lastCreatedPrescriptionSigned
                          ? s.lookup('s4.lib.prescriptions.rx_signed')
                          : s.lookup('s4.lib.prescriptions.sign_lock_rx'),
                    ),
                  ),
                ClinicalPrintPdfAction(
                  key: const Key('last-prescription-print-share-pdf'),
                  visible:
                      _lastCreatedPrescriptionId != null &&
                      _lastCreatedPrescriptionSigned,
                  busy: _printingLastPrescription,
                  onPressed: _printLastPrescriptionPdf,
                ),
                submitButton,
              ],
            ),
            if (_lastPharmacyOrderMessage != null &&
                _lastPharmacyOrderMessage!.trim().isNotEmpty) ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  Icon(
                    _lastPharmacyOrderMessage!.contains('needs formulary match')
                        ? Icons.warning_amber_outlined
                        : Icons.local_pharmacy_outlined,
                    size: 18,
                    color:
                        _lastPharmacyOrderMessage!.contains(
                          'needs formulary match',
                        )
                        ? Colors.orange.shade800
                        : const Color(0xFF00838F),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _lastPharmacyOrderMessage!,
                      style: TextStyle(color: AppTheme.textSecondary),
                    ),
                  ),
                ],
              ),
            ],
            if (_followUpDate != null) ...[
              const SizedBox(height: 10),
              SizedBox(
                width: desktop ? 520 : double.infinity,
                child: TextFormField(
                  controller: _followUpNotesCtrl,
                  decoration: InputDecoration(
                    labelText: s.prescriptionsFollowUpNotes,
                    hintText: s.prescriptionsFollowUpNotesHint,
                    isDense: true,
                  ),
                ),
              ),
            ],
            if (_handwrittenPhoto != null) ...[
              const SizedBox(height: 10),
              ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: Image.file(
                  _handwrittenPhoto!,
                  height: 120,
                  fit: BoxFit.cover,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _infoCard(String label, String value, IconData icon) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: const Color(0xFF00838F).withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Icon(icon, size: 18, color: const Color(0xFF00838F)),
          const SizedBox(width: 8),
          Text(
            '$label: ',
            style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
          ),
          Expanded(child: Text(value, style: const TextStyle(fontSize: 13))),
        ],
      ),
    );
  }

  Widget _miniField(TextEditingController ctrl, String label, String suffix) {
    return TextFormField(
      controller: ctrl,
      keyboardType: const TextInputType.numberWithOptions(decimal: true),
      decoration: InputDecoration(
        labelText: label,
        suffixText: suffix,
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 10,
          vertical: 10,
        ),
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PATIENT SEARCH FIELD
// ═══════════════════════════════════════════════════════════════════════════════

class _PatientSearchField extends StatefulWidget {
  final void Function(int id, String name) onSelected;
  const _PatientSearchField({required this.onSelected});

  @override
  State<_PatientSearchField> createState() => _PatientSearchFieldState();
}

class _PatientSearchFieldState extends State<_PatientSearchField> {
  final _ctrl = TextEditingController();
  List<dynamic> _results = [];
  // ignore: unused_field
  bool _searching = false;

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _search(String query) async {
    if (query.length < 3) {
      if (mounted) setState(() => _results = []);
      return;
    }
    if (mounted) setState(() => _searching = true);
    try {
      final resp = await ApiClient.get(
        '/users/lookup',
        queryParameters: {'search': query},
      );
      if (!mounted) return;
      if (resp.isSuccess && resp.raw is Map) {
        final raw = resp.raw as Map<String, dynamic>;
        if (raw['success'] == true) {
          setState(() => _results = raw['data'] ?? []);
        }
      }
    } catch (e) {
      debugPrint('PatientSearch error: $e');
    }
    if (mounted) setState(() => _searching = false);
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        TextFormField(
          controller: _ctrl,
          decoration: InputDecoration(
            labelText: AppStrings.of(context).prescriptionsSearchPatient,
            prefixIcon: const ExcludeSemantics(child: Icon(Icons.search)),
            isDense: true,
          ),
          onChanged: _search,
        ),
        if (_results.isNotEmpty)
          Container(
            constraints: const BoxConstraints(maxHeight: 150),
            child: ListView.builder(
              shrinkWrap: true,
              itemCount: _results.length,
              itemBuilder: (_, i) {
                final u = _results[i];
                return ListTile(
                  dense: true,
                  title: Text(u['name'] ?? u['phone'] ?? ''),
                  subtitle: Text(u['phone'] ?? ''),
                  onTap: () {
                    widget.onSelected(
                      u['id'] as int,
                      u['name']?.toString() ?? '',
                    );
                    setState(() => _results = []);
                    _ctrl.text = u['name']?.toString() ?? '';
                  },
                );
              },
            ),
          ),
      ],
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOCTOR SEARCH FIELD
// ═══════════════════════════════════════════════════════════════════════════════

class _DoctorSearchField extends StatefulWidget {
  final void Function(int id, String name) onSelected;
  const _DoctorSearchField({required this.onSelected});

  @override
  State<_DoctorSearchField> createState() => _DoctorSearchFieldState();
}

class _DoctorSearchFieldState extends State<_DoctorSearchField> {
  final _ctrl = TextEditingController();
  List<dynamic> _results = [];

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _search(String query) async {
    if (query.length < 2) {
      if (mounted) setState(() => _results = []);
      return;
    }
    try {
      final resp = await ApiClient.get(
        '/doctors',
        queryParameters: {'search': query},
      );
      if (!mounted) return;
      if (resp.isSuccess && resp.raw is Map) {
        final raw = resp.raw as Map<String, dynamic>;
        if (raw['success'] == true) {
          setState(() => _results = raw['data'] ?? []);
        }
      }
    } catch (e) {
      debugPrint('DoctorSearch error: $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        TextFormField(
          controller: _ctrl,
          decoration: InputDecoration(
            labelText: AppStrings.of(context).prescriptionsSearchDoctor,
            prefixIcon: const ExcludeSemantics(
              child: Icon(Icons.medical_services),
            ),
            isDense: true,
          ),
          onChanged: _search,
        ),
        if (_results.isNotEmpty)
          Container(
            constraints: const BoxConstraints(maxHeight: 150),
            child: ListView.builder(
              shrinkWrap: true,
              itemCount: _results.length,
              itemBuilder: (_, i) {
                final d = _results[i];
                return ListTile(
                  dense: true,
                  title: Text(d['name'] ?? ''),
                  subtitle: Text(d['specialization'] ?? ''),
                  onTap: () {
                    widget.onSelected(
                      (d['user_id'] ?? d['id']) as int,
                      d['name']?.toString() ?? '',
                    );
                    setState(() => _results = []);
                    _ctrl.text = d['name']?.toString() ?? '';
                  },
                );
              },
            ),
          ),
      ],
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MEDICATION CARD with type-ahead medicine search
// ═══════════════════════════════════════════════════════════════════════════════

class _MedicationCard extends StatefulWidget {
  final int index;
  final _MedicationEntry medication;
  final List<String> frequencies;
  final Map<String, String> freqLabels;
  final List<String> routes;
  final VoidCallback? onRemove;
  final VoidCallback onChanged;

  const _MedicationCard({
    required this.index,
    required this.medication,
    required this.frequencies,
    required this.freqLabels,
    required this.routes,
    this.onRemove,
    required this.onChanged,
  });

  @override
  State<_MedicationCard> createState() => _MedicationCardState();
}

class _MedicationCardState extends State<_MedicationCard> {
  final _nameCtrl = TextEditingController();
  List<dynamic> _suggestions = [];
  bool _showSuggestions = false;

  @override
  void initState() {
    super.initState();
    _nameCtrl.text = widget.medication.name;
  }

  Future<void> _searchMedicine(String query) async {
    if (query.length < 2) {
      setState(() {
        _suggestions = [];
        _showSuggestions = false;
      });
      return;
    }
    try {
      final resp = await ApiClient.get(
        '/pharmacy-orders/catalog',
        queryParameters: {'search': query},
      );
      if (resp.isSuccess && resp.raw is Map) {
        final raw = resp.raw as Map<String, dynamic>;
        if (raw['success'] == true) {
          setState(() {
            _suggestions = (raw['data'] as List?) ?? [];
            _showSuggestions = _suggestions.isNotEmpty;
          });
        }
      }
    } catch (e) {
      debugPrint('MedicineSearch error: $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final med = widget.medication;
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: const Color(0xFF00838F).withValues(alpha: 0.3),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                s.prescriptionsMedicineIndex(widget.index + 1),
                style: const TextStyle(
                  fontWeight: FontWeight.bold,
                  color: Color(0xFF00838F),
                  fontSize: 13,
                ),
              ),
              if (widget.onRemove != null)
                IconButton(
                  icon: const Icon(
                    Icons.remove_circle_outline,
                    color: AppTheme.errorRed,
                    size: 20,
                  ),
                  tooltip: s.prescriptionsRemoveMedication,
                  onPressed: widget.onRemove,
                  visualDensity: VisualDensity.compact,
                ),
            ],
          ),
          const SizedBox(height: 8),

          // Medicine name with type-ahead
          TextFormField(
            controller: _nameCtrl,
            decoration: InputDecoration(
              labelText: s.prescriptionsMedicineName,
              hintText: s.prescriptionsMedicineNameHint,
              isDense: true,
              prefixIcon: const ExcludeSemantics(
                child: Icon(Icons.medication, size: 18),
              ),
            ),
            onChanged: (v) {
              med.name = v;
              widget.onChanged();
              _searchMedicine(v);
            },
          ),

          // Suggestions dropdown
          if (_showSuggestions)
            Container(
              constraints: const BoxConstraints(maxHeight: 160),
              margin: const EdgeInsets.only(top: 2),
              decoration: BoxDecoration(
                color: AppTheme.cardSurface,
                border: Border.all(color: Colors.grey.shade300),
                borderRadius: BorderRadius.circular(6),
                boxShadow: [
                  const BoxShadow(
                    color: Colors.black12,
                    blurRadius: 4,
                    offset: Offset(0, 2),
                  ),
                ],
              ),
              child: ListView.builder(
                shrinkWrap: true,
                itemCount: _suggestions.length,
                itemBuilder: (_, i) {
                  final s = _suggestions[i];
                  return ListTile(
                    dense: true,
                    title: Text(
                      s['name'] ?? '',
                      style: const TextStyle(fontSize: 13),
                    ),
                    subtitle: Text(
                      '${s['generic_name'] ?? ''} • ₹${s['unit_price'] ?? 0} / ${s['pack_size'] ?? ''}',
                      style: const TextStyle(fontSize: 11),
                    ),
                    onTap: () {
                      setState(() {
                        _nameCtrl.text = s['name'] ?? '';
                        med.name = s['name'] ?? '';
                        med.genericName = s['generic_name'];
                        med.catalogId = s['id'] as int?;
                        _showSuggestions = false;
                        _suggestions = [];
                      });
                      widget.onChanged();
                    },
                  );
                },
              ),
            ),

          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: TextFormField(
                  initialValue: med.dosage,
                  decoration: InputDecoration(
                    labelText: s.prescriptionsDosage,
                    hintText: s.prescriptionsDosageHint,
                    isDense: true,
                  ),
                  onChanged: (v) {
                    med.dosage = v;
                    widget.onChanged();
                  },
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: DropdownButtonFormField<String>(
                  isExpanded: true,
                  initialValue: med.frequency.isEmpty ? null : med.frequency,
                  decoration: InputDecoration(
                    labelText: s.prescriptionsFrequency,
                    isDense: true,
                  ),
                  items: widget.frequencies
                      .map(
                        (f) => DropdownMenuItem(
                          value: f,
                          child: Text(
                            widget.freqLabels[f] ?? f,
                            style: const TextStyle(fontSize: 11),
                          ),
                        ),
                      )
                      .toList(),
                  onChanged: (v) {
                    med.frequency = v ?? '';
                    widget.onChanged();
                  },
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: TextFormField(
                  initialValue: med.duration,
                  decoration: InputDecoration(
                    labelText: s.prescriptionsDuration,
                    hintText: s.prescriptionsDurationHint,
                    isDense: true,
                  ),
                  onChanged: (v) {
                    med.duration = v;
                    widget.onChanged();
                  },
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: DropdownButtonFormField<String>(
                  isExpanded: true,
                  initialValue: med.route.isEmpty ? null : med.route,
                  decoration: InputDecoration(
                    labelText: s.prescriptionsRoute,
                    isDense: true,
                  ),
                  items: widget.routes
                      .map(
                        (r) => DropdownMenuItem(
                          value: r,
                          child: Text(r, style: const TextStyle(fontSize: 12)),
                        ),
                      )
                      .toList(),
                  onChanged: (v) {
                    med.route = v ?? 'Oral';
                    widget.onChanged();
                  },
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                flex: 3,
                child: TextFormField(
                  initialValue: med.instructions,
                  decoration: InputDecoration(
                    labelText: s.prescriptionsInstructions,
                    hintText: s.prescriptionsInstructionsHint,
                    isDense: true,
                  ),
                  onChanged: (v) {
                    med.instructions = v;
                    widget.onChanged();
                  },
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                flex: 1,
                child: TextFormField(
                  initialValue: med.quantity.toString(),
                  keyboardType: TextInputType.number,
                  decoration: InputDecoration(
                    labelText: s.prescriptionsQty,
                    isDense: true,
                  ),
                  onChanged: (v) {
                    med.quantity = int.tryParse(v) ?? 1;
                    widget.onChanged();
                  },
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECENT E-PRESCRIPTIONS TAB
// ═══════════════════════════════════════════════════════════════════════════════

class _RecentEPrescriptionsTab extends StatefulWidget {
  const _RecentEPrescriptionsTab();

  @override
  State<_RecentEPrescriptionsTab> createState() =>
      _RecentEPrescriptionsTabState();
}

class _RecentEPrescriptionsTabState extends State<_RecentEPrescriptionsTab> {
  List<dynamic> _prescriptions = [];
  bool _loading = true;
  String? _error;
  final Set<int> _signing = {};
  final Set<int> _printing = {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (!mounted) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final resp = await ApiClient.get('/prescriptions/all');
      if (!mounted) return;
      if (resp.isSuccess && resp.raw is Map) {
        final raw = resp.raw as Map<String, dynamic>;
        if (raw['success'] == true) {
          setState(() => _prescriptions = raw['data'] ?? []);
        } else {
          setState(
            () => _error = raw['message']?.toString() ?? 'Failed to load',
          );
        }
      } else {
        setState(() => _error = resp.message ?? 'Failed to load');
      }
    } catch (e) {
      if (!mounted) return;
      setState(
        () => _error = localizedApiErrorFromRaw(AppStrings.of(context), e),
      );
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const SkeletonList();
    if (_error != null) {
      return ErrorState(message: _error!, onRetry: _load);
    }
    if (_prescriptions.isEmpty) {
      return EmptyState(
        icon: Icons.receipt_long_outlined,
        title: AppStrings.of(context).prescriptionsNoneYet,
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _prescriptions.length,
        itemBuilder: (_, i) {
          final p = _prescriptions[i];
          final meds = p['medications'] as List? ?? [];
          final createdAt = p['created_at'] != null
              ? DateFormat(
                  'dd MMM yyyy, hh:mm a',
                ).format(DateTime.parse(p['created_at']).toLocal())
              : '';
          return Card(
            margin: const EdgeInsets.only(bottom: 10),
            child: ListTile(
              leading: CircleAvatar(
                backgroundColor: const Color(0xFF00838F),
                child: Text(
                  (p['prescription_number'] ?? '').toString().replaceAll(
                    'RX-2026-',
                    '',
                  ),
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 11,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
              title: Text(
                '${p['prescription_number']} • ${p['patient_name'] ?? ''}',
              ),
              subtitle: Text(
                'Dr. ${p['doctor_name'] ?? ''} • ${meds.length} medicines\n$createdAt',
                style: const TextStyle(fontSize: 12),
              ),
              isThreeLine: true,
              trailing: p['pharmacy_opted'] == true
                  ? Chip(
                      label: Text(
                        p['pharmacy_order_status']?.toString().isNotEmpty ==
                                true
                            ? p['pharmacy_order_status'].toString()
                            : AppStrings.of(context).prescriptionsOrderedChip,
                        style: TextStyle(
                          fontSize: 10,
                          color: AppTheme.successOnSurface,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      backgroundColor: AppTheme.successOnSurface.withValues(
                        alpha: 0.12,
                      ),
                    )
                  : _isSigned(p)
                  ? Chip(
                      label: const AppText(
                        's4.lib.prescriptions.signed',
                        style: TextStyle(
                          fontSize: 10,
                          color: AppTheme.primaryBlue,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      backgroundColor: AppTheme.primaryBlue.withValues(
                        alpha: 0.12,
                      ),
                    )
                  : null,
              onTap: () => _showDetail(p),
            ),
          );
        },
      ),
    );
  }

  bool _isSigned(Map<String, dynamic> rx) =>
      rx['signed_at'] != null ||
      rx['locked_at'] != null ||
      rx['lifecycle_status']?.toString().toLowerCase() == 'signed';

  int? _rxId(Map<String, dynamic> rx) {
    final value = rx['id'];
    if (value is int) return value;
    return int.tryParse(value?.toString() ?? '');
  }

  Future<void> _signPrescription(Map<String, dynamic> rx) async {
    final id = _rxId(rx);
    if (id == null || _signing.contains(id)) return;
    setState(() => _signing.add(id));
    try {
      await MedicalApiService.signEPrescription(id);
      if (!mounted) return;
      SuccessToast.show(
        context,
        AppStrings.of(context).lookup('s4.lib.prescriptions.signed_locked'),
      );
      await _load();
    } catch (e) {
      if (mounted) {
        ErrorToast.show(context, e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _signing.remove(id));
    }
  }

  Future<void> _printPrescription(Map<String, dynamic> rx) async {
    final id = _rxId(rx);
    if (id == null || _printing.contains(id)) return;
    setState(() => _printing.add(id));
    try {
      await ClinicalPrintService.printPrescription(prescriptionId: id);
    } catch (e) {
      if (mounted) {
        ErrorToast.show(
          context,
          AppStrings.of(context).format(
            's4.dynamic.prescriptions.pdf_open_failed_detail',
            {'error': e.toString().replaceFirst('Exception: ', '')},
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _printing.remove(id));
    }
  }

  void _showDetail(Map<String, dynamic> rx) {
    final meds = rx['medications'] as List? ?? [];
    final signed = _isSigned(rx);
    final id = _rxId(rx);
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.7,
        maxChildSize: 0.95,
        builder: (_, scrollCtrl) => ListView(
          controller: scrollCtrl,
          padding: const EdgeInsets.all(20),
          children: [
            Center(
              child: Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: AppTheme.divider,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            const SizedBox(height: 12),
            Text(
              rx['prescription_number'] ?? '',
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 4),
            Text(
              AppStrings.of(
                ctx,
              ).format('s4.dynamic.prescriptions.patient_doctor', {
                'patient': rx['patient_name'] ?? '',
                'doctor': rx['doctor_name'] ?? '',
              }),
              style: TextStyle(color: AppTheme.textSecondary),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                Chip(
                  label: Text(
                    signed
                        ? AppStrings.of(
                            ctx,
                          ).lookup('s4.lib.prescriptions.signed_locked')
                        : AppStrings.of(
                            ctx,
                          ).lookup('s4.lib.prescriptions.draft'),
                    style: TextStyle(
                      color: signed
                          ? AppTheme.successOnSurface
                          : AppTheme.warningOnSurface,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  backgroundColor:
                      (signed
                              ? AppTheme.successOnSurface
                              : AppTheme.warningOnSurface)
                          .withValues(alpha: 0.12),
                ),
                if (rx['pharmacy_order_status'] != null)
                  Chip(
                    label: Text(
                      AppStrings.of(ctx).format(
                        's4.dynamic.prescriptions.pharmacy_status',
                        {'status': rx['pharmacy_order_status']},
                      ),
                      style: const TextStyle(
                        color: AppTheme.primaryBlue,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    backgroundColor: AppTheme.primaryBlue.withValues(
                      alpha: 0.12,
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 12),
            if (rx['diagnosis'] != null) ...[
              Text(
                AppStrings.of(context).prescriptionsDetailDiagnosis,
                style: const TextStyle(fontWeight: FontWeight.bold),
              ),
              Text(rx['diagnosis'] ?? ''),
              const SizedBox(height: 12),
            ],
            Text(
              AppStrings.of(context).prescriptionsDetailMedications,
              style: const TextStyle(fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 8),
            ...meds.map(
              (m) => Container(
                margin: const EdgeInsets.only(bottom: 6),
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: AppTheme.backgroundGrey,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: AppTheme.divider),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      m['name'] ?? '',
                      style: TextStyle(
                        color: AppTheme.textPrimary,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    Text(
                      '${m['dosage'] ?? ''} • ${m['frequency'] ?? ''} • ${m['duration'] ?? ''} • ${m['route'] ?? ''}',
                      style: TextStyle(
                        fontSize: 12,
                        color: AppTheme.textSecondary,
                      ),
                    ),
                    if (m['instructions'] != null &&
                        m['instructions'].toString().isNotEmpty)
                      Text(
                        m['instructions'],
                        style: const TextStyle(
                          fontSize: 12,
                          fontStyle: FontStyle.italic,
                        ),
                      ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 12),
            if (rx['follow_up_date'] != null)
              Text(
                AppStrings.of(
                  ctx,
                ).format('s4.dynamic.prescriptions.follow_up_date', {
                  'date': DateFormat(
                    'dd MMM yyyy',
                  ).format(DateTime.parse(rx['follow_up_date'])),
                }),
                style: const TextStyle(fontWeight: FontWeight.w500),
              ),
            const SizedBox(height: 16),
            Wrap(
              spacing: 10,
              runSpacing: 10,
              children: [
                if (id != null)
                  OutlinedButton.icon(
                    onPressed: signed || _signing.contains(id)
                        ? null
                        : () async {
                            Navigator.of(ctx).pop();
                            await _signPrescription(rx);
                          },
                    icon: _signing.contains(id)
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.verified_outlined, size: 18),
                    label: Text(
                      signed
                          ? AppStrings.of(
                              ctx,
                            ).lookup('s4.lib.prescriptions.signed')
                          : AppStrings.of(
                              ctx,
                            ).lookup('s4.lib.prescriptions.sign_lock'),
                    ),
                  ),
                if (rx['pdf_url'] != null || rx['id'] != null)
                  OutlinedButton.icon(
                    onPressed: () async {
                      final url = rx['pdf_url']?.toString();
                      final target = url != null && url.isNotEmpty
                          ? url
                          : await MedicalApiService.getPrescriptionPdfUrl(id!);
                      final uri = Uri.tryParse(target ?? '');
                      if (uri == null) {
                        if (mounted) {
                          ErrorToast.show(
                            context,
                            AppStrings.of(
                              context,
                            ).lookup('s4.lib.prescriptions.pdf_not_available'),
                          );
                        }
                        return;
                      }
                      await launchUrl(
                        uri,
                        mode: LaunchMode.externalApplication,
                      );
                    },
                    icon: const Icon(Icons.picture_as_pdf_outlined, size: 18),
                    label: const AppText('s4.lib.prescriptions.open_pdf'),
                  ),
                ClinicalPrintPdfAction(
                  key: const Key('recent-prescription-print-share-pdf'),
                  visible: signed && id != null,
                  busy: id != null && _printing.contains(id),
                  onPressed: id == null
                      ? null
                      : () async {
                          Navigator.of(ctx).pop();
                          await _printPrescription(rx);
                        },
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
