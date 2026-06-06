// ignore_for_file: unused_element_parameter
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../../core/services/api_client.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/states/empty_state.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';
import '../../../core/widgets/states/success_toast.dart';
import '../../../core/widgets/vital_text_field.dart';
import '../../../l10n/app_strings.dart';
import '../widgets/cds_blocker_modal.dart';

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
      body: Column(
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
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Medication model
// ═══════════════════════════════════════════════════════════════════════════════

class _MedicationEntry {
  String name;
  String? genericName;
  int? catalogId;
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
    this.genericName,
    this.catalogId,
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

  Map<String, dynamic> toJson() => {
    'name': name,
    if (genericName != null) 'generic_name': genericName,
    if (catalogId != null) 'catalog_id': catalogId,
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

  factory _MedicationEntry.fromJson(Map<String, dynamic> json) {
    final doseTimes = json['dose_times'] ?? json['doseTimes'];
    return _MedicationEntry(
      name: json['name']?.toString() ?? '',
      genericName: json['generic_name']?.toString(),
      catalogId: json['catalog_id'] is int
          ? json['catalog_id'] as int
          : int.tryParse(json['catalog_id']?.toString() ?? ''),
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
  final List<_MedicationEntry> _favorites = [];

  // Follow-up
  DateTime? _followUpDate;
  int? _lastCreatedPrescriptionId;
  String? _lastCreatedPrescriptionPdfUrl;
  String? _lastPharmacyOrderMessage;
  bool _signingLastPrescription = false;
  bool _lastCreatedPrescriptionSigned = false;

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
      _patientName = a['patient_name']?.toString();
      _doctorName = a['doctor_name']?.toString();
      _setControllerIfEmpty(_diagnosisCtrl, a['diagnosis']);
      _setControllerIfEmpty(
        _clinicalNotesCtrl,
        a['clinical_notes'] ?? a['clinicalNotes'],
      );
      _prefillLatestVitals();
    }
    _loadFavorites();
  }

  @override
  void dispose() {
    _disposeMedicationEditors();
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
      () => TextEditingController(text: med.name),
    );
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
    if (mounted) SuccessToast.show(context, 'Saved as favorite');
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
        ..genericName = favorite.genericName
        ..catalogId = favorite.catalogId
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
      _drugControllerFor(target).text = target.name;
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
    try {
      final order = await MedicalApiService.orderPrescriptionToPharmacy(
        prescriptionId,
        deliveryType: 'counter',
        medications: medications,
      );
      final orderNumber =
          order['order_number'] ?? order['data']?['order_number'] ?? '';
      return orderNumber.toString().trim().isEmpty
          ? 'Pharmacy order sent'
          : 'Pharmacy order $orderNumber sent';
    } catch (e) {
      return 'Prescription saved; pharmacy handoff needs formulary match: ${e.toString().replaceFirst('Exception: ', '')}';
    }
  }

  Future<void> _openPrescriptionPdf(String? url) async {
    final parsed = Uri.tryParse(url ?? '');
    if (parsed == null) {
      ErrorToast.show(context, 'Prescription PDF is not available yet');
      return;
    }
    final launched = await launchUrl(
      parsed,
      mode: LaunchMode.externalApplication,
    );
    if (!launched && mounted) {
      ErrorToast.show(context, 'Could not open prescription PDF');
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
      SuccessToast.show(context, 'Prescription signed and locked');
    } catch (e) {
      if (!mounted) return;
      setState(() => _signingLastPrescription = false);
      ErrorToast.show(context, e.toString().replaceFirst('Exception: ', ''));
    }
  }

  Future<void> _submit() async {
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
      ErrorToast.show(context, 'Days must be at least 1');
      return;
    }

    setState(() => _submitting = true);
    try {
      final meds = _medications.map((m) => m.toJson()).toList();

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
      }

      final body = <String, dynamic>{
        'patient_id': _patientId,
        'doctor_id': _doctorId,
        if (_appointmentId != null) 'appointment_id': _appointmentId,
        'diagnosis': _diagnosisCtrl.text.trim(),
        'clinical_notes': _clinicalNotesCtrl.text.trim().isEmpty
            ? null
            : _clinicalNotesCtrl.text.trim(),
        'medications': meds,
        if (_followUpDate != null)
          'follow_up_date': DateFormat('yyyy-MM-dd').format(_followUpDate!),
        if (_followUpNotesCtrl.text.trim().isNotEmpty)
          'follow_up_notes': _followUpNotesCtrl.text.trim(),
        if (overrideReason != null) 'override': {'reason': overrideReason},
      };
      final vitals = _buildVitals();
      if (vitals != null) body['vitals'] = vitals;

      final result = await MedicalApiService.createEPrescription(
        body,
        photo: _handwrittenPhoto,
      );
      final createdId = _createdPrescriptionId(result);
      String? pdfUrl;
      String? pharmacyMessage;
      if (createdId != null) {
        pharmacyMessage = await _orderInHousePharmacyIfNeeded(
          prescriptionId: createdId,
          medications: meds,
        );
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
              content: const Text('Prescription PDF is ready'),
              action: SnackBarAction(
                label: 'Open',
                onPressed: () => _openPrescriptionPdf(pdfUrl),
              ),
            ),
          );
        }
        // Reset form
        _formKey.currentState!.reset();
        for (final med in _medications) {
          _disposeMedicationEditor(med);
        }
        setState(() {
          _lastCreatedPrescriptionId = createdId;
          _lastCreatedPrescriptionPdfUrl = pdfUrl;
          _lastPharmacyOrderMessage = pharmacyMessage;
          _lastCreatedPrescriptionSigned = false;
          _medications.clear();
          _medications.add(_MedicationEntry());
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
          if (widget.prefilledAppointment == null) {
            _patientId = null;
            _doctorId = null;
            _appointmentId = null;
            _patientName = null;
            _doctorName = null;
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

  void _syncMedicationDerivedFields(_MedicationEntry med) {
    final strength = med.strength.trim();
    if (strength.isNotEmpty && !med.strengthOptions.contains(strength)) {
      med.strengthOptions = [strength, ...med.strengthOptions];
    }
    if (med.dosage.trim().isEmpty && med.strength.trim().isNotEmpty) {
      med.dosage = med.strength.trim();
    }
    med.frequency = _frequencyForDoseTimes(med.doseTimes);
    med.duration = _durationForDays(med.days);
    med.quantity =
        med.days * (med.doseTimes.isEmpty ? 1 : med.doseTimes.length);
    if (med.pharmacy.trim().isEmpty) {
      med.pharmacy = _preferredPharmacy;
    }
  }

  void _syncCatalogIdForStrength(_MedicationEntry med) {
    if (med.catalogRows.isEmpty || med.strength.trim().isEmpty) return;
    final selected = med.strength.trim().toLowerCase();
    for (final row in med.catalogRows) {
      if (_extractStrengthFromCatalog(row).toLowerCase() == selected) {
        med.catalogId = _rowInt(row, 'id') ?? med.catalogId;
        med.type = _extractMedicineTypeFromCatalog(row);
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

  String _stockLabel(Map<String, dynamic> row) {
    final count = _stockCount(row);
    if (!_isCatalogRowInStock(row)) return 'Out';
    if (count <= 0) return 'Stocked';
    return '$count in stock';
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
        'name': _extractDrugNameFromCatalog(first),
        'generic_name': _rowText(first, const ['generic_name', 'generic']),
        'category': _rowText(first, const ['category', 'drug_class']),
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

  _MedicationEntry _medicationFromCatalogRow(Map<String, dynamic> row) {
    final name = _extractDrugNameFromCatalog(row);
    final strength = _extractStrengthFromCatalog(row);
    final type = _extractMedicineTypeFromCatalog(row);
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
      catalogId: _rowInt(row, 'id'),
      catalogRows: catalogRows,
      strength: strength,
      strengthOptions: _strengthOptionsForCatalogRow(row, [row]),
      dosage: strength,
      frequency: 'BD',
      days: 5,
      duration: _durationForDays(5),
      route: 'Oral',
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
    if (name.isNotEmpty) return name;
    return _rowText(row, const ['name', 'drug_name', 'medicine_name']);
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
        ..genericName = selected.genericName
        ..catalogId = selected.catalogId
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
      final controller = _drugControllerFor(target);
      controller.value = TextEditingValue(
        text: target.name,
        selection: TextSelection.collapsed(offset: target.name.length),
      );
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
      setState(() {
        _drugSuggestions[med] = _groupCatalogRows(rows);
      });
    } catch (e) {
      if (!mounted) return;
      ErrorToast.show(context, e.toString().replaceFirst('Exception: ', ''));
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
                Text(
                  'OP consultation context',
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
            Expanded(child: _miniField(_heightCtrl, 'Height', 'cm')),
            const SizedBox(width: 8),
            Expanded(
              child: _miniField(
                _respRateCtrl,
                'Resp. rate',
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
        initialValue: _preferredPharmacy,
        decoration: const InputDecoration(
          labelText: 'Pharmacy',
          isDense: true,
          prefixIcon: Icon(Icons.local_pharmacy_outlined),
        ),
        items: _pharmacyOptions
            .map((value) => DropdownMenuItem(value: value, child: Text(value)))
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
                    child: Text(
                      'Add Drug',
                      style: TextStyle(
                        color: AppTheme.textPrimary,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                  pharmacyPicker,
                  const SizedBox(width: 8),
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
                        child: Text(
                          'Add Drug',
                          style: TextStyle(
                            color: AppTheme.textPrimary,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                      ),
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
          ],
        ),
      ),
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
          final subtitle = [
            if (med.strength.trim().isNotEmpty) med.strength.trim(),
            med.frequency,
          ].where((value) => value.trim().isNotEmpty).join(' • ');
          return InputChip(
            avatar: const Icon(Icons.star, size: 16),
            label: Text(
              subtitle.isEmpty ? med.name : '${med.name} ($subtitle)',
              overflow: TextOverflow.ellipsis,
            ),
            tooltip: 'Use favorite',
            onPressed: () => _applyFavorite(med),
            onDeleted: () => _removeFavorite(med),
          );
        },
      ),
    );
  }

  Widget _buildMedicationTable() {
    return Scrollbar(
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: DataTable(
          headingRowHeight: 38,
          dataRowMinHeight: 78,
          dataRowMaxHeight: 96,
          columnSpacing: 10,
          columns: const [
            DataColumn(label: Text('Drug*')),
            DataColumn(label: Text('Strength')),
            DataColumn(label: Text('Route & frequency')),
            DataColumn(label: Text('Food timing')),
            DataColumn(label: Text('Days')),
            DataColumn(label: Text('Type')),
            DataColumn(label: Text('Flags')),
            DataColumn(label: Text('Special Instruction')),
            DataColumn(label: Text('')),
          ],
          rows: _medications.asMap().entries.map((entry) {
            final index = entry.key;
            final med = entry.value;
            return DataRow(
              cells: [
                DataCell(_drugAutocompleteField(width: 255, medication: med)),
                DataCell(_strengthDropdown(width: 120, medication: med)),
                DataCell(_routeFrequencyCell(width: 300, medication: med)),
                DataCell(_foodTimingDropdown(width: 140, medication: med)),
                DataCell(
                  _tableNumberField(
                    width: 70,
                    value: med.days,
                    onChanged: (value) {
                      med.days = value;
                      med.duration = _durationForDays(value);
                    },
                  ),
                ),
                DataCell(
                  _readOnlyPill(
                    width: 130,
                    text: med.type.trim().isEmpty ? 'Auto' : med.type.trim(),
                  ),
                ),
                DataCell(
                  Wrap(
                    spacing: 4,
                    children: [
                      _flagChip('PRN', med.prn, (value) {
                        setState(() => med.prn = value);
                      }),
                      _flagChip('NTE', med.nte, (value) {
                        setState(() => med.nte = value);
                      }),
                      _flagChip('DAW', med.daw, (value) {
                        setState(() => med.daw = value);
                      }),
                    ],
                  ),
                ),
                DataCell(
                  _tableTextField(
                    width: 260,
                    value: med.instructions,
                    hint: 'e.g. after food, avoid driving',
                    onChanged: (value) => med.instructions = value,
                  ),
                ),
                DataCell(
                  SizedBox(
                    width: 84,
                    child: Row(
                      children: [
                        IconButton(
                          tooltip: 'Save favorite',
                          onPressed: med.name.trim().isEmpty
                              ? null
                              : () => _saveFavorite(med),
                          icon: const Icon(Icons.star_border),
                        ),
                        IconButton(
                          tooltip: 'Delete row',
                          onPressed: _medications.length <= 1
                              ? null
                              : () => _removeMedicationAt(index),
                          icon: const Icon(Icons.delete_outline),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            );
          }).toList(),
        ),
      ),
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
        hint: 'Select drug',
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
          });
        },
      ),
    );
  }

  Widget _routeFrequencyCell({
    required double width,
    required _MedicationEntry medication,
  }) {
    return SizedBox(
      width: width,
      child: Row(
        children: [
          _tableDropdown(
            width: 112,
            value: medication.route.isEmpty ? 'Oral' : medication.route,
            options: _routes,
            onChanged: (value) {
              setState(() => medication.route = value);
            },
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Wrap(
              spacing: 4,
              runSpacing: 4,
              children: _doseSlotLabels.entries
                  .map((entry) {
                    final selected = medication.doseTimes.contains(entry.key);
                    return FilterChip(
                      label: Text(
                        entry.value,
                        style: const TextStyle(fontSize: 11),
                      ),
                      tooltip: _doseSlotNames[entry.key],
                      selected: selected,
                      onSelected: (value) {
                        setState(() {
                          if (value) {
                            medication.doseTimes.add(entry.key);
                          } else {
                            medication.doseTimes.remove(entry.key);
                          }
                          _syncMedicationDerivedFields(medication);
                        });
                      },
                      visualDensity: VisualDensity.compact,
                      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    );
                  })
                  .toList(growable: false),
            ),
          ),
        ],
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
      labels: const {'': 'Any time'},
      onChanged: (value) {
        setState(() => medication.foodTiming = value);
      },
    );
  }

  Widget _readOnlyPill({required double width, required String text}) {
    return SizedBox(
      width: width,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
        decoration: BoxDecoration(
          color: AppTheme.backgroundGrey,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: AppTheme.divider),
        ),
        child: Text(
          text,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            color: AppTheme.textPrimary,
            fontWeight: FontWeight.w700,
          ),
        ),
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
          return _drugSuggestions[medication] ?? const <Map<String, dynamic>>[];
        },
        onSelected: (row) => _applyCatalogRowToMedication(medication, row),
        fieldViewBuilder:
            (context, textController, fieldFocusNode, onFieldSubmitted) {
              return TextFormField(
                controller: textController,
                focusNode: fieldFocusNode,
                decoration: InputDecoration(
                  hintText: 'Type drug name',
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
                validator: (value) =>
                    value == null || value.trim().isEmpty ? 'Required' : null,
                onChanged: (value) {
                  medication
                    ..name = value
                    ..catalogId = null
                    ..catalogRows = const []
                    ..strength = ''
                    ..strengthOptions = []
                    ..dosage = ''
                    ..type = '';
                  _searchDrugSuggestions(medication, value);
                },
                onFieldSubmitted: (_) => onFieldSubmitted(),
              );
            },
        optionsViewBuilder: (context, onSelected, options) {
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
                          _stockLabel(row),
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
            ? (value) =>
                  value == null || value.trim().isEmpty ? 'Required' : null
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
    final submitButton = ElevatedButton.icon(
      onPressed: _submitting ? null : _submit,
      icon: _submitting
          ? const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(
                color: Colors.white,
                strokeWidth: 2,
              ),
            )
          : const Icon(Icons.save, color: Colors.white),
      label: Text(
        _submitting ? s.prescriptionsCreating : s.prescriptionsCreate,
      ),
      style: ElevatedButton.styleFrom(
        backgroundColor: const Color(0xFF00838F),
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
      ),
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
                          ? 'Open last PDF'
                          : 'Open Rx #$_lastCreatedPrescriptionId PDF',
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
                          ? 'Rx signed'
                          : 'Sign & lock Rx',
                    ),
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
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const SkeletonList();
    if (_error != null) {
      return ErrorState(
        message: _error!.replaceFirst('Exception: ', ''),
        onRetry: _load,
      );
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
                      label: const Text(
                        'Signed',
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
      SuccessToast.show(context, 'Prescription signed and locked');
      await _load();
    } catch (e) {
      if (mounted) {
        ErrorToast.show(context, e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _signing.remove(id));
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
              'Patient: ${rx['patient_name'] ?? ''} • Dr. ${rx['doctor_name'] ?? ''}',
              style: TextStyle(color: AppTheme.textSecondary),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                Chip(
                  label: Text(
                    signed ? 'Signed and locked' : 'Draft',
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
                      'Pharmacy: ${rx['pharmacy_order_status']}',
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
                'Follow-up: ${DateFormat('dd MMM yyyy').format(DateTime.parse(rx['follow_up_date']))}',
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
                    label: Text(signed ? 'Signed' : 'Sign & lock'),
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
                          ErrorToast.show(context, 'PDF is not available');
                        }
                        return;
                      }
                      await launchUrl(
                        uri,
                        mode: LaunchMode.externalApplication,
                      );
                    },
                    icon: const Icon(Icons.picture_as_pdf_outlined, size: 18),
                    label: const Text('Open PDF'),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
