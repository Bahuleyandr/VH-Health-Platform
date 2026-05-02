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
            color: Colors.white,
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
  String dosage;
  String frequency;
  String duration;
  String route;
  String instructions;
  int quantity;

  _MedicationEntry({
    this.name = '',
    this.genericName,
    this.catalogId,
    this.dosage = '',
    this.frequency = '',
    this.duration = '',
    this.route = '',
    this.instructions = '',
    this.quantity = 1,
  });

  Map<String, dynamic> toJson() => {
    'name': name,
    if (genericName != null) 'generic_name': genericName,
    if (catalogId != null) 'catalog_id': catalogId,
    'dosage': dosage,
    'frequency': frequency,
    'duration': duration,
    'route': route,
    'instructions': instructions,
    'quantity': quantity,
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
  final _spo2Ctrl = TextEditingController();
  final _weightCtrl = TextEditingController();
  final _bsCtrl = TextEditingController();

  // Medications
  final List<_MedicationEntry> _medications = [_MedicationEntry()];

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
    _spo2Ctrl.dispose();
    _weightCtrl.dispose();
    _bsCtrl.dispose();
    super.dispose();
  }

  Map<String, dynamic>? _buildVitals() {
    final v = <String, dynamic>{};
    if (_bpSysCtrl.text.isNotEmpty) {
      v['bp_systolic'] = int.tryParse(_bpSysCtrl.text);
    }
    if (_bpDiaCtrl.text.isNotEmpty) {
      v['bp_diastolic'] = int.tryParse(_bpDiaCtrl.text);
    }
    if (_pulseCtrl.text.isNotEmpty) {
      v['pulse'] = int.tryParse(_pulseCtrl.text);
    }
    if (_tempCtrl.text.isNotEmpty) {
      v['temperature'] = double.tryParse(_tempCtrl.text);
    }
    if (_spo2Ctrl.text.isNotEmpty) {
      v['spo2'] = int.tryParse(_spo2Ctrl.text);
    }
    if (_weightCtrl.text.isNotEmpty) {
      v['weight'] = double.tryParse(_weightCtrl.text);
    }
    if (_bsCtrl.text.isNotEmpty) {
      v['blood_sugar'] = int.tryParse(_bsCtrl.text);
    }
    return v.isEmpty ? null : v;
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    if (_patientId == null || _doctorId == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
              AppStrings.of(context).prescriptionsErrorSelectPatientDoctor),
          backgroundColor: AppTheme.errorRed,
        ),
      );
      return;
    }
    if (_medications.any((m) => m.name.trim().isEmpty)) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
              AppStrings.of(context).prescriptionsErrorFillMedicationNames),
          backgroundColor: AppTheme.errorRed,
        ),
      );
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
            context, AppStrings.of(context).prescriptionsCreated('$rxNum'));
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

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Form(
        key: _formKey,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // ─── Patient & Doctor Info ─────────────────────────────────
            if (_patientName != null)
              _infoCard(s.prescriptionsPatientLabel, _patientName!,
                  Icons.person),
            if (_doctorName != null)
              _infoCard(s.prescriptionsDoctorLabel, _doctorName!,
                  Icons.medical_services),
            if (_patientId == null) ...[
              _PatientSearchField(
                onSelected: (id, name) {
                  setState(() {
                    _patientId = id;
                    _patientName = name;
                  });
                },
              ),
              const SizedBox(height: 10),
            ],
            if (_doctorId == null) ...[
              _DoctorSearchField(
                onSelected: (id, name) {
                  setState(() {
                    _doctorId = id;
                    _doctorName = name;
                  });
                },
              ),
              const SizedBox(height: 10),
            ],

            // ─── Vitals (collapsible) ──────────────────────────────────
            const SizedBox(height: 12),
            InkWell(
              onTap: () => setState(() => _showVitals = !_showVitals),
              child: Row(
                children: [
                  Icon(
                    _showVitals
                        ? Icons.keyboard_arrow_down
                        : Icons.keyboard_arrow_right,
                    color: const Color(0xFF00838F),
                  ),
                  Text(
                    s.prescriptionsVitalsCollapse,
                    style: const TextStyle(
                      fontWeight: FontWeight.bold,
                      color: Color(0xFF00838F),
                    ),
                  ),
                ],
              ),
            ),
            if (_showVitals) ...[
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: _miniField(
                        _bpSysCtrl, s.prescriptionsBpSystolic, 'mmHg'),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: _miniField(
                        _bpDiaCtrl, s.prescriptionsBpDiastolic, 'mmHg'),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                      child: _miniField(
                          _pulseCtrl, s.prescriptionsPulse, 'bpm')),
                  const SizedBox(width: 8),
                  Expanded(
                      child: _miniField(_tempCtrl, s.prescriptionsTemp, '°F')),
                ],
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                      child: _miniField(_spo2Ctrl, s.prescriptionsSpo2, '%')),
                  const SizedBox(width: 8),
                  Expanded(
                      child: _miniField(
                          _weightCtrl, s.prescriptionsWeight, 'kg')),
                  const SizedBox(width: 8),
                  Expanded(
                      child: _miniField(
                          _bsCtrl, s.prescriptionsBloodSugar, 'mg/dL')),
                ],
              ),
            ],

            // ─── Diagnosis ─────────────────────────────────────────────
            const SizedBox(height: 16),
            TextFormField(
              controller: _diagnosisCtrl,
              decoration: InputDecoration(
                labelText: s.prescriptionsDiagnosisLabel,
                prefixIcon: const ExcludeSemantics(
                    child: Icon(Icons.local_hospital_outlined)),
                alignLabelWithHint: true,
              ),
              maxLines: 2,
              validator: (v) => (v == null || v.trim().isEmpty)
                  ? s.prescriptionsDiagnosisRequired
                  : null,
            ),

            // ─── Medications ───────────────────────────────────────────
            const SizedBox(height: 20),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  s.prescriptionsMedicationsHeader,
                  style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.bold,
                    color: AppTheme.textPrimary,
                  ),
                ),
                TextButton.icon(
                  onPressed: () =>
                      setState(() => _medications.add(_MedicationEntry())),
                  icon: const Icon(Icons.add, size: 18),
                  label: Text(s.prescriptionsAddButton),
                ),
              ],
            ),
            const SizedBox(height: 8),
            ..._medications.asMap().entries.map((entry) {
              final i = entry.key;
              final med = entry.value;
              return _MedicationCard(
                index: i,
                medication: med,
                frequencies: _frequencies,
                freqLabels: _freqLabels,
                routes: _routes,
                onRemove: _medications.length > 1
                    ? () => setState(() => _medications.removeAt(i))
                    : null,
                onChanged: () => setState(() {}),
              );
            }),

            // ─── Follow-up ─────────────────────────────────────────────
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: () async {
                      final picked = await showDatePicker(
                        context: context,
                        initialDate: DateTime.now().add(
                          const Duration(days: 7),
                        ),
                        firstDate: DateTime.now(),
                        lastDate: DateTime.now().add(const Duration(days: 365)),
                      );
                      if (picked != null) {
                        setState(() => _followUpDate = picked);
                      }
                    },
                    icon: const Icon(Icons.calendar_today, size: 18),
                    label: Text(
                      _followUpDate != null
                          ? s.prescriptionsFollowUpPrefix(
                              DateFormat('dd MMM yyyy').format(_followUpDate!))
                          : s.prescriptionsSetFollowUp,
                    ),
                  ),
                ),
                if (_followUpDate != null)
                  IconButton(
                    icon: const Icon(Icons.clear, size: 18),
                    tooltip: s.prescriptionsClearFollowUp,
                    onPressed: () => setState(() => _followUpDate = null),
                  ),
              ],
            ),
            if (_followUpDate != null) ...[
              const SizedBox(height: 8),
              TextFormField(
                controller: _followUpNotesCtrl,
                decoration: InputDecoration(
                  labelText: s.prescriptionsFollowUpNotes,
                  hintText: s.prescriptionsFollowUpNotesHint,
                  isDense: true,
                ),
              ),
            ],

            // ─── Clinical Notes ────────────────────────────────────────
            const SizedBox(height: 16),
            TextFormField(
              controller: _clinicalNotesCtrl,
              decoration: InputDecoration(
                labelText: s.prescriptionsClinicalNotes,
                hintText: s.prescriptionsClinicalNotesHint,
                prefixIcon: const ExcludeSemantics(
                    child: Icon(Icons.notes_outlined)),
                alignLabelWithHint: true,
              ),
              maxLines: 3,
            ),

            // ─── Handwritten Photo ─────────────────────────────────────
            const SizedBox(height: 16),
            OutlinedButton.icon(
              onPressed: _pickPhoto,
              icon: const Icon(Icons.camera_alt, size: 18),
              label: Text(
                _handwrittenPhoto != null
                    ? s.prescriptionsPhotoAttached
                    : s.prescriptionsAttachHandwritten,
              ),
            ),
            if (_handwrittenPhoto != null) ...[
              const SizedBox(height: 8),
              ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: Image.file(
                  _handwrittenPhoto!,
                  height: 120,
                  fit: BoxFit.cover,
                ),
              ),
            ],

            // ─── Submit ────────────────────────────────────────────────
            const SizedBox(height: 24),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton.icon(
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
                  padding: const EdgeInsets.symmetric(vertical: 14),
                ),
              ),
            ),
            const SizedBox(height: 40),
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

  Future<void> _search(String query) async {
    if (query.length < 3) {
      setState(() => _results = []);
      return;
    }
    setState(() => _searching = true);
    try {
      final resp = await ApiClient.get(
        '/users/lookup',
        queryParameters: {'search': query},
      );
      if (resp.isSuccess && resp.raw is Map) {
        final raw = resp.raw as Map<String, dynamic>;
        if (raw['success'] == true) {
          setState(() => _results = raw['data'] ?? []);
        }
      }
    } catch (e) {
      debugPrint('PatientSearch error: $e');
    }
    setState(() => _searching = false);
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        TextFormField(
          controller: _ctrl,
          decoration: InputDecoration(
            labelText: AppStrings.of(context).prescriptionsSearchPatient,
            prefixIcon:
                const ExcludeSemantics(child: Icon(Icons.search)),
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

  Future<void> _search(String query) async {
    if (query.length < 2) {
      setState(() => _results = []);
      return;
    }
    try {
      final resp = await ApiClient.get(
        '/doctors',
        queryParameters: {'search': query},
      );
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
                child: Icon(Icons.medical_services)),
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
        color: Colors.white,
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
                  child: Icon(Icons.medication, size: 18)),
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
                color: Colors.white,
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
                  initialValue: med.route,
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
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final resp = await ApiClient.get('/prescriptions/all');
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
                          style: const TextStyle(fontSize: 10)),
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
