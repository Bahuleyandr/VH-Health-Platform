import 'package:flutter/material.dart';
import '../../../core/config/api_config.dart';
import '../../../core/services/connectivity_sync_service.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/patient_context_chip.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/states/success_toast.dart';
import '../../../core/widgets/vital_text_field.dart';
import '../../../l10n/app_strings.dart';

/// Vitals Entry screen — for Nursing Staff to record patient vitals.
///
/// When opened from the bed-board's "Record Vitals" quick action, the
/// route passes `patient_uid` / `patient_id` / `name` / `phone` query
/// params; the form auto-fills the patient ID and shows a context chip
/// so the nurse doesn't re-key identification on every patient round.
class VitalsScreen extends StatefulWidget {
  final String? prefillPatientUid;
  final String? prefillPatientId;
  final String? prefillPatientName;
  final String? prefillPatientPhone;
  const VitalsScreen({
    super.key,
    this.prefillPatientUid,
    this.prefillPatientId,
    this.prefillPatientName,
    this.prefillPatientPhone,
  });

  @override
  State<VitalsScreen> createState() => _VitalsScreenState();
}

class _VitalsScreenState extends State<VitalsScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final hasContext =
        (widget.prefillPatientName ?? '').isNotEmpty ||
        (widget.prefillPatientId ?? '').isNotEmpty;

    return StaffScaffold(
      title: s.vitalsTitle,
      body: Column(
        children: [
          if (hasContext)
            PatientContextChip(
              name: widget.prefillPatientName,
              phone: widget.prefillPatientPhone,
              accent: const Color(0xFFC62828),
            ),
          Container(
            color: AppTheme.cardSurface,
            child: TabBar(
              controller: _tabController,
              labelColor: const Color(0xFFC62828),
              unselectedLabelColor: AppTheme.textSecondary,
              indicatorColor: const Color(0xFFC62828),
              tabs: [
                Tab(text: s.vitalsTabRecord),
                Tab(text: s.vitalsTabRecent),
              ],
            ),
          ),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [
                _RecordVitalsTab(
                  prefillPatientId: widget.prefillPatientId,
                  prefillPatientName: widget.prefillPatientName,
                ),
                const _RecentVitalsTab(),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _RecordVitalsTab extends StatefulWidget {
  final String? prefillPatientId;
  final String? prefillPatientName;
  const _RecordVitalsTab({this.prefillPatientId, this.prefillPatientName});

  @override
  State<_RecordVitalsTab> createState() => _RecordVitalsTabState();
}

class _RecordVitalsTabState extends State<_RecordVitalsTab> {
  final _formKey = GlobalKey<FormState>();
  final _patientIdCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    if ((widget.prefillPatientId ?? '').isNotEmpty) {
      _patientIdCtrl.text = widget.prefillPatientId!;
    }
  }

  final _bpSysCtrl = TextEditingController();
  final _bpDiaCtrl = TextEditingController();
  final _tempCtrl = TextEditingController();
  final _pulseCtrl = TextEditingController();
  final _spo2Ctrl = TextEditingController();
  final _weightCtrl = TextEditingController();
  final _notesCtrl = TextEditingController();
  bool _submitting = false;

  @override
  void dispose() {
    _patientIdCtrl.dispose();
    _bpSysCtrl.dispose();
    _bpDiaCtrl.dispose();
    _tempCtrl.dispose();
    _pulseCtrl.dispose();
    _spo2Ctrl.dispose();
    _weightCtrl.dispose();
    _notesCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _submitting = true);
    try {
      final staffId = await ApiConfig.getStaffId();
      final vitalSigns = <String, dynamic>{};
      final measurements = <String, dynamic>{};

      final bpSys = normalizeVitalValue(_bpSysCtrl.text, VitalUnit.bp);
      final bpDia = normalizeVitalValue(_bpDiaCtrl.text, VitalUnit.bp);
      final temp = normalizeVitalValue(_tempCtrl.text, VitalUnit.temperature);
      final pulse = normalizeVitalValue(_pulseCtrl.text, VitalUnit.pulse);
      final spo2 = normalizeVitalValue(_spo2Ctrl.text, VitalUnit.spo2);
      final weight = normalizeVitalValue(_weightCtrl.text, VitalUnit.weight);

      if (bpSys.isNotEmpty && bpDia.isNotEmpty) {
        vitalSigns['blood_pressure'] = {
          'systolic': int.parse(bpSys),
          'diastolic': int.parse(bpDia),
        };
      }
      if (temp.isNotEmpty) {
        vitalSigns['temperature'] = double.parse(temp);
      }
      if (pulse.isNotEmpty) {
        vitalSigns['pulse'] = int.parse(pulse);
      }
      if (spo2.isNotEmpty) {
        vitalSigns['spo2'] = double.parse(spo2);
      }
      if (weight.isNotEmpty) {
        measurements['weight'] = double.parse(weight);
      }

      final patientId = int.parse(_patientIdCtrl.text.trim());
      final body = <String, dynamic>{
        'patient_id': patientId,
        'record_type': 'VITALS',
        if (vitalSigns.isNotEmpty) 'vital_signs': vitalSigns,
        if (measurements.isNotEmpty) 'measurements': measurements,
        if (_notesCtrl.text.trim().isNotEmpty) 'notes': _notesCtrl.text.trim(),
        if (staffId != null) 'recorded_by': int.tryParse(staffId),
      };

      if (!ConnectivitySyncService.instance.isOnline) {
        await ConnectivitySyncService.instance.enqueue(
          endpoint: '/health/records',
          method: 'POST',
          body: body,
          contextLabel: 'Vitals for patient $patientId',
        );
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(AppStrings.of(context).vitalsOfflineQueued),
              backgroundColor: AppTheme.warningAmber,
            ),
          );
        }
      } else {
        await MedicalApiService.recordVitals(
          patientId: patientId,
          vitalSigns: vitalSigns.isNotEmpty ? vitalSigns : null,
          measurements: measurements.isNotEmpty ? measurements : null,
          notes: _notesCtrl.text.trim().isEmpty ? null : _notesCtrl.text.trim(),
          recordedBy: staffId != null ? int.tryParse(staffId) : null,
        );
        if (mounted) {
          SuccessToast.show(
            context,
            AppStrings.of(context).vitalsRecordedSuccess,
          );
        }
      }

      if (mounted) {
        _formKey.currentState!.reset();
        _patientIdCtrl.clear();
        _bpSysCtrl.clear();
        _bpDiaCtrl.clear();
        _tempCtrl.clear();
        _pulseCtrl.clear();
        _spo2Ctrl.clear();
        _weightCtrl.clear();
        _notesCtrl.clear();
      }
    } catch (e) {
      if (mounted) {
        ErrorToast.show(context, e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              gradient: const LinearGradient(
                colors: [Color(0xFFC62828), Color(0xFFE53935)],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Row(
              children: [
                const Icon(Icons.monitor_heart, color: Colors.white, size: 36),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        s.vitalsHeaderTitle,
                        style: const TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.bold,
                          fontSize: 16,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        s.vitalsHeaderSubtitle,
                        style: const TextStyle(
                          color: Colors.white70,
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),

          Form(
            key: _formKey,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Patient ID
                TextFormField(
                  controller: _patientIdCtrl,
                  keyboardType: TextInputType.number,
                  decoration: InputDecoration(
                    labelText: s.vitalsPatientIdLabel,
                    hintText: s.vitalsPatientIdHint,
                    prefixIcon: const ExcludeSemantics(
                      child: Icon(Icons.person_outlined),
                    ),
                  ),
                  validator: (v) {
                    if (v == null || v.trim().isEmpty) {
                      return s.vitalsPatientIdRequired;
                    }
                    if (int.tryParse(v.trim()) == null) {
                      return s.vitalsPatientIdInvalid;
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 20),

                // Blood Pressure
                _SectionHeader(
                  icon: Icons.favorite,
                  label: s.vitalsBpHeader,
                  color: const Color(0xFFC62828),
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                      child: TextFormField(
                        controller: _bpSysCtrl,
                        keyboardType: TextInputType.number,
                        decoration: InputDecoration(
                          labelText: s.vitalsBpSystolic,
                          hintText: s.vitalsBpSystolicHint,
                          suffixText: VitalUnit.bp,
                        ),
                        validator: (v) {
                          if (v == null || v.isEmpty) return null;
                          final n = int.tryParse(
                            normalizeVitalValue(v, VitalUnit.bp),
                          );
                          if (n == null || n < 60 || n > 300) {
                            return s.vitalsValidationInvalid;
                          }
                          return null;
                        },
                      ),
                    ),
                    const Padding(
                      padding: EdgeInsets.symmetric(horizontal: 10),
                      child: Text('/', style: TextStyle(fontSize: 24)),
                    ),
                    Expanded(
                      child: TextFormField(
                        controller: _bpDiaCtrl,
                        keyboardType: TextInputType.number,
                        decoration: InputDecoration(
                          labelText: s.vitalsBpDiastolic,
                          hintText: s.vitalsBpDiastolicHint,
                          suffixText: VitalUnit.bp,
                        ),
                        validator: (v) {
                          if (v == null || v.isEmpty) return null;
                          final n = int.tryParse(
                            normalizeVitalValue(v, VitalUnit.bp),
                          );
                          if (n == null || n < 30 || n > 200) {
                            return s.vitalsValidationInvalid;
                          }
                          return null;
                        },
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 20),

                // Temperature
                _SectionHeader(
                  icon: Icons.thermostat,
                  label: s.vitalsTemperatureHeader,
                  color: const Color(0xFFE65100),
                ),
                const SizedBox(height: 10),
                TextFormField(
                  controller: _tempCtrl,
                  keyboardType: const TextInputType.numberWithOptions(
                    decimal: true,
                  ),
                  decoration: InputDecoration(
                    labelText: s.vitalsTemperatureHeader,
                    hintText: s.vitalsTemperatureHint,
                    suffixText: VitalUnit.temperature,
                    prefixIcon: const ExcludeSemantics(
                      child: Icon(Icons.thermostat_outlined),
                    ),
                  ),
                  validator: (v) {
                    if (v == null || v.isEmpty) return null;
                    final n = double.tryParse(
                      normalizeVitalValue(v, VitalUnit.temperature),
                    );
                    if (n == null || n < 90 || n > 115) {
                      return s.vitalsValidationInvalid;
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 20),

                // Pulse & SpO2
                _SectionHeader(
                  icon: Icons.speed,
                  label: s.vitalsPulseSpo2Header,
                  color: const Color(0xFF0097A7),
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                      child: TextFormField(
                        controller: _pulseCtrl,
                        keyboardType: TextInputType.number,
                        decoration: InputDecoration(
                          labelText: s.vitalsPulseLabel,
                          hintText: s.vitalsPulseHint,
                          suffixText: VitalUnit.pulse,
                          prefixIcon: const ExcludeSemantics(
                            child: Icon(Icons.speed_outlined),
                          ),
                        ),
                        validator: (v) {
                          if (v == null || v.isEmpty) return null;
                          final n = int.tryParse(
                            normalizeVitalValue(v, VitalUnit.pulse),
                          );
                          if (n == null || n < 20 || n > 250) {
                            return s.vitalsValidationInvalid;
                          }
                          return null;
                        },
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: TextFormField(
                        controller: _spo2Ctrl,
                        keyboardType: const TextInputType.numberWithOptions(
                          decimal: true,
                        ),
                        decoration: InputDecoration(
                          labelText: s.vitalsSpo2Label,
                          hintText: s.vitalsSpo2Hint,
                          suffixText: VitalUnit.spo2,
                          prefixIcon: const ExcludeSemantics(
                            child: Icon(Icons.air_outlined),
                          ),
                        ),
                        validator: (v) {
                          if (v == null || v.isEmpty) return null;
                          final n = double.tryParse(
                            normalizeVitalValue(v, VitalUnit.spo2),
                          );
                          if (n == null || n < 50 || n > 100) {
                            return s.vitalsValidationInvalid;
                          }
                          return null;
                        },
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 20),

                // Weight
                _SectionHeader(
                  icon: Icons.monitor_weight,
                  label: s.vitalsWeightHeader,
                  color: const Color(0xFF2E7D32),
                ),
                const SizedBox(height: 10),
                TextFormField(
                  controller: _weightCtrl,
                  keyboardType: const TextInputType.numberWithOptions(
                    decimal: true,
                  ),
                  decoration: InputDecoration(
                    labelText: s.vitalsWeightHeader,
                    hintText: s.vitalsWeightHint,
                    suffixText: VitalUnit.weight,
                    prefixIcon: const ExcludeSemantics(
                      child: Icon(Icons.monitor_weight_outlined),
                    ),
                  ),
                  validator: (v) {
                    if (v == null || v.isEmpty) return null;
                    final n = double.tryParse(
                      normalizeVitalValue(v, VitalUnit.weight),
                    );
                    if (n == null || n < 1 || n > 500) {
                      return s.vitalsValidationInvalid;
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 20),

                // Notes
                TextFormField(
                  controller: _notesCtrl,
                  decoration: InputDecoration(
                    labelText: s.vitalsNurseNotesLabel,
                    hintText: s.vitalsNurseNotesHint,
                    prefixIcon: const ExcludeSemantics(
                      child: Icon(Icons.notes_outlined),
                    ),
                    alignLabelWithHint: true,
                  ),
                  maxLines: 3,
                ),
                const SizedBox(height: 24),

                ElevatedButton.icon(
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
                    _submitting ? s.bedSheetSavingLabel : s.vitalsSaveButton,
                  ),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFFC62828),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _RecentVitalsTab extends StatefulWidget {
  const _RecentVitalsTab();

  @override
  State<_RecentVitalsTab> createState() => _RecentVitalsTabState();
}

class _RecentVitalsTabState extends State<_RecentVitalsTab> {
  final _patientIdCtrl = TextEditingController();
  Map<String, dynamic>? _trends;
  bool _loading = false;
  String? _error;

  @override
  void dispose() {
    _patientIdCtrl.dispose();
    super.dispose();
  }

  Future<void> _fetchTrends() async {
    final s = AppStrings.of(context);
    final id = int.tryParse(_patientIdCtrl.text.trim());
    if (id == null) {
      setState(() => _error = s.vitalsPatientIdInvalid);
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
      _trends = null;
    });
    try {
      final data = await MedicalApiService.getPatientVitalTrends(id);
      if (mounted) setState(() => _trends = data);
    } catch (e) {
      if (mounted) {
        setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        children: [
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _patientIdCtrl,
                  keyboardType: TextInputType.number,
                  decoration: InputDecoration(
                    labelText: s.vitalsPatientIdLabel,
                    hintText: s.vitalsPatientIdHint,
                    prefixIcon: const ExcludeSemantics(
                      child: Icon(Icons.person_search_outlined),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              ElevatedButton(
                onPressed: _loading ? null : _fetchTrends,
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFFC62828),
                ),
                child: _loading
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(
                          color: Colors.white,
                          strokeWidth: 2,
                        ),
                      )
                    : Text(s.vitalsFetchButton),
              ),
            ],
          ),
          const SizedBox(height: 16),
          if (_error != null)
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppTheme.errorRed.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Row(
                children: [
                  const Icon(
                    Icons.error_outline,
                    color: AppTheme.errorRed,
                    size: 18,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _error!,
                      style: const TextStyle(
                        color: AppTheme.errorRed,
                        fontSize: 13,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          if (_trends != null) Expanded(child: _buildTrendsView(_trends!)),
          if (_trends == null && !_loading && _error == null)
            Expanded(
              child: Center(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      Icons.timeline_outlined,
                      size: 56,
                      color: AppTheme.textSecondary,
                    ),
                    const SizedBox(height: 16),
                    Text(
                      s.vitalsTrendsHint,
                      style: TextStyle(color: AppTheme.textSecondary),
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildTrendsView(Map<String, dynamic> data) {
    final s = AppStrings.of(context);
    final records =
        data['records'] as List? ??
        data['trends'] as List? ??
        data['vital_trends'] as List? ??
        [];

    if (records.isEmpty) {
      return Center(
        child: Text(
          s.vitalsNoRecords,
          style: TextStyle(color: AppTheme.textSecondary),
        ),
      );
    }

    return ListView.builder(
      itemCount: records.length,
      itemBuilder: (_, i) {
        final r = records[i] as Map<String, dynamic>;
        final vitals = r['vital_signs'] as Map<String, dynamic>? ?? {};
        final measurements = r['measurements'] as Map<String, dynamic>? ?? {};
        final date =
            r['created_at']?.toString() ??
            r['recorded_at']?.toString() ??
            r['date']?.toString() ??
            '';

        return Card(
          margin: const EdgeInsets.only(bottom: 10),
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Icon(
                      Icons.monitor_heart,
                      size: 18,
                      color: Color(0xFFC62828),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        date,
                        style: TextStyle(
                          fontSize: 12,
                          color: AppTheme.textSecondary,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 16,
                  runSpacing: 8,
                  children: [
                    if (vitals['blood_pressure'] != null)
                      _VitalChip(
                        'BP',
                        '${vitals['blood_pressure']['systolic']}/${vitals['blood_pressure']['diastolic']}',
                        VitalUnit.bp,
                      ),
                    if (vitals['temperature'] != null)
                      _VitalChip(
                        'Temp',
                        '${vitals['temperature']}',
                        VitalUnit.temperature,
                      ),
                    if (vitals['pulse'] != null)
                      _VitalChip(
                        'Pulse',
                        '${vitals['pulse']}',
                        VitalUnit.pulse,
                      ),
                    if (vitals['spo2'] != null)
                      _VitalChip('SpO2', '${vitals['spo2']}', VitalUnit.spo2),
                    if (measurements['weight'] != null)
                      _VitalChip(
                        'Weight',
                        '${measurements['weight']}',
                        VitalUnit.weight,
                      ),
                  ],
                ),
                if (r['notes'] != null && r['notes'].toString().isNotEmpty) ...[
                  const SizedBox(height: 8),
                  Text(
                    r['notes'].toString(),
                    style: TextStyle(
                      fontSize: 12,
                      color: AppTheme.textSecondary,
                    ),
                  ),
                ],
              ],
            ),
          ),
        );
      },
    );
  }
}

class _VitalChip extends StatelessWidget {
  final String label;
  final String value;
  final String unit;
  const _VitalChip(this.label, this.value, this.unit);

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: TextStyle(
            fontSize: 10,
            color: AppTheme.textSecondary,
            fontWeight: FontWeight.w500,
          ),
        ),
        Text(
          vitalValueWithUnit(value, unit),
          style: TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.bold,
            color: AppTheme.textPrimary,
          ),
        ),
      ],
    );
  }
}

class _SectionHeader extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;

  const _SectionHeader({
    required this.icon,
    required this.label,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, size: 18, color: color),
        const SizedBox(width: 8),
        Text(
          label,
          style: TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.bold,
            color: color,
          ),
        ),
      ],
    );
  }
}
