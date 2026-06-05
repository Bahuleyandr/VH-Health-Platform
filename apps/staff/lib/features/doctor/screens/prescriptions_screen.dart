// ignore_for_file: unused_element_parameter
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
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
  String strength;
  String dosage;
  String frequency;
  String duration;
  String route;
  String instructions;
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
    this.strength = '',
    this.dosage = '',
    this.frequency = 'BD',
    this.duration = '',
    this.route = 'Oral',
    this.instructions = '',
    this.quantity = 1,
    this.days = 5,
    this.refills = 0,
    this.prn = false,
    this.nte = false,
    this.daw = false,
    this.type = '',
    this.category = '',
    this.pharmacy = '',
  });

  Map<String, dynamic> toJson() => {
    'name': name,
    if (genericName != null) 'generic_name': genericName,
    if (catalogId != null) 'catalog_id': catalogId,
    if (strength.trim().isNotEmpty) 'strength': strength.trim(),
    'dosage': dosage.trim().isNotEmpty ? dosage.trim() : strength.trim(),
    'frequency': frequency,
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

  // Follow-up
  DateTime? _followUpDate;

  // Photo
  File? _handwrittenPhoto;

  bool _submitting = false;

  static const _frequencies = ['OD', 'BD', 'TDS', 'QID', 'SOS', 'HS', 'STAT'];
  static const _freqLabels = {
    'OD': 'OD (Once daily)',
    'BD': 'BD (Twice daily)',
    'TDS': 'TDS (Thrice daily)',
    'QID': 'QID (Four times)',
    'SOS': 'SOS (As needed)',
    'HS': 'HS (At bedtime)',
    'STAT': 'STAT (Immediately)',
  };
  static const _routes = [
    'Oral',
    'IV',
    'IM',
    'Topical',
    'Inhalation',
    'Sublingual',
  ];
  static const _medicineTypes = [
    'Tablet',
    'Capsule',
    'Syrup',
    'Injection',
    'Drops',
    'Inhaler',
    'Cream',
    'Sachet',
  ];
  static const _pharmacyOptions = [
    'In House Dispensary',
    'Patient choice',
    'External pharmacy',
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
  }

  @override
  void dispose() {
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
    if (_medications.any((m) => m.days < 1 || m.quantity < 1)) {
      ErrorToast.show(context, 'Days and quantity must be at least 1');
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
      final rxNum =
          result['prescription_number'] ??
          result['data']?['prescription_number'] ??
          '';

      if (mounted) {
        SuccessToast.show(
          context,
          AppStrings.of(context).prescriptionsCreated('$rxNum'),
        );
        // Reset form
        _formKey.currentState!.reset();
        setState(() {
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

  String _defaultSig(_MedicationEntry med) {
    final freq = med.frequency.trim();
    final freqText = _freqLabels[freq] ?? freq;
    final route = med.route.trim().isEmpty ? 'Oral' : med.route.trim();
    final dose = med.dosage.trim().isEmpty
        ? med.strength.trim()
        : med.dosage.trim();
    final parts = <String>[
      if (dose.isNotEmpty) 'Take $dose',
      if (route.isNotEmpty) route.toLowerCase(),
      if (freqText.isNotEmpty) freqText.toLowerCase(),
      if (med.prn) 'as needed',
    ];
    return parts.where((part) => part.trim().isNotEmpty).join(' ');
  }

  String _durationForDays(int days) => days <= 1 ? '$days day' : '$days days';

  void _syncMedicationDerivedFields(_MedicationEntry med) {
    if (med.dosage.trim().isEmpty && med.strength.trim().isNotEmpty) {
      med.dosage = med.strength.trim();
    }
    med.duration = _durationForDays(med.days);
    final hasDrugContext =
        med.name.trim().isNotEmpty ||
        med.strength.trim().isNotEmpty ||
        med.dosage.trim().isNotEmpty;
    if (hasDrugContext && med.instructions.trim().isEmpty) {
      med.instructions = _defaultSig(med);
    }
    if (med.pharmacy.trim().isEmpty) {
      med.pharmacy = _preferredPharmacy;
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
  }

  String _rowText(Map<String, dynamic> row, List<String> keys) {
    for (final key in keys) {
      final value = row[key]?.toString().trim() ?? '';
      if (value.isNotEmpty && value.toLowerCase() != 'null') return value;
    }
    return '';
  }

  String _extractStrengthFromCatalog(Map<String, dynamic> row) {
    final explicit = _rowText(row, const [
      'strength',
      'dosage',
      'dose',
      'pack_size',
    ]);
    if (explicit.isNotEmpty) return explicit;
    final name = _rowText(row, const ['name', 'drug_name', 'medicine_name']);
    final match = RegExp(
      r'(\d+(?:\.\d+)?\s?(?:mg|mcg|g|ml|iu|%))',
      caseSensitive: false,
    ).firstMatch(name);
    return match?.group(1) ?? '';
  }

  int? _rowInt(Map<String, dynamic> row, String key) {
    final value = row[key];
    if (value is int) return value;
    if (value is num) return value.toInt();
    return int.tryParse(value?.toString() ?? '');
  }

  _MedicationEntry _medicationFromCatalogRow(Map<String, dynamic> row) {
    final name = _rowText(row, const ['name', 'drug_name', 'medicine_name']);
    final strength = _extractStrengthFromCatalog(row);
    final type = _rowText(row, const ['form', 'dosage_form', 'type']);
    final category = _rowText(row, const ['category', 'drug_class']);
    final med = _MedicationEntry(
      name: name,
      genericName: _rowText(row, const ['generic_name', 'generic']).isEmpty
          ? null
          : _rowText(row, const ['generic_name', 'generic']),
      catalogId: _rowInt(row, 'id'),
      strength: strength,
      dosage: strength,
      frequency: 'BD',
      days: 5,
      duration: _durationForDays(5),
      route: 'Oral',
      quantity: 10,
      type: type.isEmpty ? 'Tablet' : type,
      category: category,
      pharmacy: _preferredPharmacy,
    );
    _syncMedicationDerivedFields(med);
    return med;
  }

  String _catalogDrugLabel(Map<String, dynamic> row) {
    final name = _rowText(row, const ['name', 'drug_name', 'medicine_name']);
    final strength = _extractStrengthFromCatalog(row);
    if (name.isEmpty) return strength;
    if (strength.isEmpty ||
        name.toLowerCase().contains(strength.toLowerCase())) {
      return name;
    }
    return '$name $strength';
  }

  void _applyCatalogRowToMedication(
    _MedicationEntry target,
    Map<String, dynamic> row,
  ) {
    final selected = _medicationFromCatalogRow(row);
    setState(() {
      target
        ..name = _catalogDrugLabel(row)
        ..genericName = selected.genericName
        ..catalogId = selected.catalogId
        ..strength = selected.strength
        ..dosage = selected.dosage
        ..frequency = selected.frequency
        ..duration = selected.duration
        ..route = selected.route
        ..instructions = selected.instructions
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
        _drugSuggestions[med] = rows.take(12).toList(growable: false);
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
    return LayoutBuilder(
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
            const SizedBox(height: 8),
            _buildMedicationTable(),
          ],
        ),
      ),
    );
  }

  Widget _buildMedicationTable() {
    return Scrollbar(
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: DataTable(
          headingRowHeight: 38,
          dataRowMinHeight: 62,
          dataRowMaxHeight: 76,
          columnSpacing: 10,
          columns: const [
            DataColumn(label: Text('Drug*')),
            DataColumn(label: Text('Strength')),
            DataColumn(label: Text('SIG')),
            DataColumn(label: Text('Freq')),
            DataColumn(label: Text('Days')),
            DataColumn(label: Text('Qty')),
            DataColumn(label: Text('Refill')),
            DataColumn(label: Text('Route')),
            DataColumn(label: Text('Type')),
            DataColumn(label: Text('Flags')),
            DataColumn(label: Text('Note')),
            DataColumn(label: Text('')),
          ],
          rows: _medications.asMap().entries.map((entry) {
            final index = entry.key;
            final med = entry.value;
            return DataRow(
              cells: [
                DataCell(_drugAutocompleteField(width: 255, medication: med)),
                DataCell(
                  _tableTextField(
                    width: 120,
                    value: med.strength,
                    hint: '650 mg',
                    onChanged: (value) {
                      med.strength = value;
                      if (med.dosage.trim().isEmpty) med.dosage = value;
                    },
                  ),
                ),
                DataCell(
                  _tableTextField(
                    width: 260,
                    value: med.instructions,
                    hint: _defaultSig(med),
                    onChanged: (value) => med.instructions = value,
                  ),
                ),
                DataCell(
                  _tableDropdown(
                    width: 100,
                    value: _frequencies.contains(med.frequency)
                        ? med.frequency
                        : _frequencies.first,
                    options: _frequencies,
                    onChanged: (value) {
                      med.frequency = value;
                      if (med.instructions.trim().isEmpty) {
                        med.instructions = _defaultSig(med);
                      }
                    },
                  ),
                ),
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
                  _tableNumberField(
                    width: 78,
                    value: med.quantity,
                    onChanged: (value) => med.quantity = value,
                  ),
                ),
                DataCell(
                  _tableNumberField(
                    width: 70,
                    value: med.refills,
                    min: 0,
                    onChanged: (value) => med.refills = value,
                  ),
                ),
                DataCell(
                  _tableDropdown(
                    width: 120,
                    value: med.route.isEmpty ? 'Oral' : med.route,
                    options: _routes,
                    onChanged: (value) => med.route = value,
                  ),
                ),
                DataCell(
                  _tableDropdown(
                    width: 130,
                    value: _medicineTypes.contains(med.type)
                        ? med.type
                        : 'Tablet',
                    options: _medicineTypes,
                    onChanged: (value) => med.type = value,
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
                    width: 180,
                    value: med.dosage,
                    hint: 'Dose override',
                    onChanged: (value) => med.dosage = value,
                  ),
                ),
                DataCell(
                  IconButton(
                    tooltip: 'Delete row',
                    onPressed: _medications.length <= 1
                        ? null
                        : () => _removeMedicationAt(index),
                    icon: const Icon(Icons.delete_outline),
                  ),
                ),
              ],
            );
          }).toList(),
        ),
      ),
    );
  }

  Widget _drugAutocompleteField({
    required double width,
    required _MedicationEntry medication,
  }) {
    final loading = _drugSuggestionLoading.contains(medication);
    return SizedBox(
      width: width,
      child: RawAutocomplete<Map<String, dynamic>>(
        key: ValueKey('drug-${identityHashCode(medication)}'),
        initialValue: TextEditingValue(text: medication.name),
        displayStringForOption: _catalogDrugLabel,
        optionsBuilder: (textEditingValue) {
          final q = textEditingValue.text.trim();
          if (q.isEmpty) return const <Map<String, dynamic>>[];
          return _drugSuggestions[medication] ?? const <Map<String, dynamic>>[];
        },
        onSelected: (row) => _applyCatalogRowToMedication(medication, row),
        fieldViewBuilder:
            (context, textController, focusNode, onFieldSubmitted) {
              return TextFormField(
                controller: textController,
                focusNode: focusNode,
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
                    ..catalogId = null;
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
                    final pack = _rowText(row, const [
                      'pack_size',
                      'unit',
                      'form',
                      'dosage_form',
                    ]);
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
                          if (strength.isNotEmpty) strength,
                          if (pack.isNotEmpty && pack != strength) pack,
                        ].join(' • '),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: AppTheme.textSecondary),
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
  }) {
    final safeValue = options.contains(value) ? value : options.first;
    return SizedBox(
      width: width,
      child: DropdownButtonFormField<String>(
        initialValue: safeValue,
        decoration: const InputDecoration(isDense: true),
        items: options
            .map(
              (option) => DropdownMenuItem(value: option, child: Text(option)),
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
                submitButton,
              ],
            ),
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
                        AppStrings.of(context).prescriptionsOrderedChip,
                        style: const TextStyle(fontSize: 10),
                      ),
                      backgroundColor: const Color(0xFFE8F5E9),
                    )
                  : null,
              onTap: () => _showDetail(p),
            ),
          );
        },
      ),
    );
  }

  void _showDetail(Map<String, dynamic> rx) {
    final meds = rx['medications'] as List? ?? [];
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
                  color: Colors.grey[300],
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
              style: const TextStyle(color: Colors.grey),
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
                  color: Colors.grey[50],
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      m['name'] ?? '',
                      style: const TextStyle(fontWeight: FontWeight.w600),
                    ),
                    Text(
                      '${m['dosage'] ?? ''} • ${m['frequency'] ?? ''} • ${m['duration'] ?? ''} • ${m['route'] ?? ''}',
                      style: const TextStyle(fontSize: 12, color: Colors.grey),
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
          ],
        ),
      ),
    );
  }
}
