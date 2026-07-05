import 'package:flutter/material.dart';

import '../../../core/services/medical_api_service.dart';
import '../../../core/widgets/clinical_autocomplete_field.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../core/widgets/vital_text_field.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

class AdmissionCaseSheetScreen extends StatefulWidget {
  final int admissionId;
  final String patientName;
  final String patientGender;

  const AdmissionCaseSheetScreen({
    super.key,
    required this.admissionId,
    required this.patientName,
    this.patientGender = '',
  });

  @override
  State<AdmissionCaseSheetScreen> createState() =>
      _AdmissionCaseSheetScreenState();
}

class _AdmissionCaseSheetScreenState extends State<AdmissionCaseSheetScreen> {
  bool _loading = true;
  bool _saving = false;
  String? _error;
  String _gender = '';

  final _chiefComplaintsCtrl = TextEditingController();
  final _hpiCtrl = TextEditingController();
  final _pastHistoryCtrl = TextEditingController();
  final _pastMedicalSurgicalCtrl = TextEditingController();
  final _personalHistoryCtrl = TextEditingController();
  final _menstrualPregnancyCtrl = TextEditingController();
  final _familyHistoryCtrl = TextEditingController();
  final _allergiesCtrl = TextEditingController();
  final _pulseCtrl = TextEditingController();
  final _bpCtrl = TextEditingController();
  final _spo2Ctrl = TextEditingController();
  final _cbgCtrl = TextEditingController();
  final _weightCtrl = TextEditingController();
  final _temperatureCtrl = TextEditingController();
  final _cvsCtrl = TextEditingController();
  final _rsCtrl = TextEditingController();
  final _paCtrl = TextEditingController();
  final _cnsCtrl = TextEditingController();
  final _provisionalDiagnosisCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    _gender = widget.patientGender;
    _load();
  }

  @override
  void dispose() {
    _chiefComplaintsCtrl.dispose();
    _hpiCtrl.dispose();
    _pastHistoryCtrl.dispose();
    _pastMedicalSurgicalCtrl.dispose();
    _personalHistoryCtrl.dispose();
    _menstrualPregnancyCtrl.dispose();
    _familyHistoryCtrl.dispose();
    _allergiesCtrl.dispose();
    _pulseCtrl.dispose();
    _bpCtrl.dispose();
    _spo2Ctrl.dispose();
    _cbgCtrl.dispose();
    _weightCtrl.dispose();
    _temperatureCtrl.dispose();
    _cvsCtrl.dispose();
    _rsCtrl.dispose();
    _paCtrl.dispose();
    _cnsCtrl.dispose();
    _provisionalDiagnosisCtrl.dispose();
    super.dispose();
  }

  Map<String, dynamic> _map(dynamic value) {
    if (value is Map<String, dynamic>) return value;
    if (value is Map) return Map<String, dynamic>.from(value);
    return <String, dynamic>{};
  }

  void _setText(TextEditingController controller, dynamic value) {
    controller.text = (value ?? '').toString();
  }

  void _setVitalText(
    TextEditingController controller,
    dynamic value,
    String unit,
  ) {
    controller.text = normalizeVitalValue((value ?? '').toString(), unit);
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await MedicalApiService.getAdmissionCaseSheet(
        widget.admissionId,
      );
      final admission = _map(data['admission']);
      final wrapper = _map(data['case_sheet']);
      final content = _map(wrapper['content']);
      final vitals = _map(content['vitals']);

      _setText(
        _chiefComplaintsCtrl,
        content['chief_complaints'] ?? admission['chief_complaint'],
      );
      _setText(_hpiCtrl, content['history_of_presenting_illness']);
      _setText(_pastHistoryCtrl, content['past_history']);
      _setText(
        _pastMedicalSurgicalCtrl,
        content['past_medical_surgical_history'],
      );
      _setText(_personalHistoryCtrl, content['personal_history']);
      _setText(_menstrualPregnancyCtrl, content['menstrual_pregnancy_history']);
      _setText(_familyHistoryCtrl, content['family_history']);
      _setText(_allergiesCtrl, content['allergies']);
      _setVitalText(_pulseCtrl, vitals['pulse_rate'], VitalUnit.pulse);
      _setVitalText(_bpCtrl, vitals['bp'], VitalUnit.bp);
      _setVitalText(_spo2Ctrl, vitals['spo2'], VitalUnit.spo2);
      _setVitalText(_cbgCtrl, vitals['cbg'], VitalUnit.cbg);
      _setVitalText(_weightCtrl, vitals['weight'], VitalUnit.weight);
      _setVitalText(
        _temperatureCtrl,
        vitals['temperature'],
        VitalUnit.temperature,
      );
      _setText(_cvsCtrl, content['cvs']);
      _setText(_rsCtrl, content['rs']);
      _setText(_paCtrl, content['pa']);
      _setText(_cnsCtrl, content['cns']);
      _setText(
        _provisionalDiagnosisCtrl,
        content['provisional_diagnosis'] ?? admission['admitting_diagnosis'],
      );

      if (!mounted) return;
      setState(() {
        _gender = (admission['patient_gender'] ?? widget.patientGender)
            .toString();
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Map<String, dynamic> _payload() {
    return {
      'chief_complaints': _chiefComplaintsCtrl.text.trim(),
      'history_of_presenting_illness': _hpiCtrl.text.trim(),
      'past_history': _pastHistoryCtrl.text.trim(),
      'past_medical_surgical_history': _pastMedicalSurgicalCtrl.text.trim(),
      'personal_history': _personalHistoryCtrl.text.trim(),
      'menstrual_pregnancy_history': _menstrualPregnancyCtrl.text.trim(),
      'family_history': _familyHistoryCtrl.text.trim(),
      'allergies': _allergiesCtrl.text.trim(),
      'vitals': {
        'pulse_rate': normalizeVitalValue(_pulseCtrl.text, VitalUnit.pulse),
        'bp': normalizeVitalValue(_bpCtrl.text, VitalUnit.bp),
        'spo2': normalizeVitalValue(_spo2Ctrl.text, VitalUnit.spo2),
        'cbg': normalizeVitalValue(_cbgCtrl.text, VitalUnit.cbg),
        'weight': normalizeVitalValue(_weightCtrl.text, VitalUnit.weight),
        'temperature': normalizeVitalValue(
          _temperatureCtrl.text,
          VitalUnit.temperature,
        ),
      },
      'cvs': _cvsCtrl.text.trim(),
      'rs': _rsCtrl.text.trim(),
      'pa': _paCtrl.text.trim(),
      'cns': _cnsCtrl.text.trim(),
      'provisional_diagnosis': _provisionalDiagnosisCtrl.text.trim(),
    };
  }

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await MedicalApiService.saveAdmissionCaseSheet(
        widget.admissionId,
        _payload(),
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: AppText('s4.lib.admission_case_sheet.case_sheet_saved'),
          backgroundColor: Colors.green,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  bool get _showMenstrualPregnancy {
    final normalized = _gender.trim().toLowerCase();
    return normalized.startsWith('f') || normalized == 'female';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = AppStrings.of(context);
    return Scaffold(
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: AppText(
          's4.dynamic.admission_case_sheet.title_for_patient',
          values: {'patient': widget.patientName},
        ),
        actions: [
          TextButton.icon(
            onPressed: _loading || _saving ? null : _save,
            icon: _saving
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.save_outlined),
            label: const AppText('action.save'),
          ),
          const LogoutAction(),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
                children: [
                  if (_error != null) _errorBox(theme),
                  _sectionTitle(
                    theme,
                    s.lookup('s4.lib.admission_case_sheet.section.history'),
                  ),
                  _field(
                    s.lookup('s4.lib.admission_case_sheet.chief_complaints'),
                    _chiefComplaintsCtrl,
                    lines: 2,
                  ),
                  _field(
                    s.lookup('s4.lib.admission_case_sheet.hpi'),
                    _hpiCtrl,
                    lines: 5,
                  ),
                  _field(
                    s.lookup('s4.lib.admission_case_sheet.past_history'),
                    _pastHistoryCtrl,
                    lines: 3,
                  ),
                  _field(
                    s.lookup(
                      's4.lib.admission_case_sheet.past_medical_surgical_history',
                    ),
                    _pastMedicalSurgicalCtrl,
                    lines: 3,
                  ),
                  _field(
                    s.lookup('s4.lib.admission_case_sheet.personal_history'),
                    _personalHistoryCtrl,
                    lines: 3,
                  ),
                  if (_showMenstrualPregnancy)
                    _field(
                      s.lookup(
                        's4.lib.admission_case_sheet.menstrual_pregnancy_history',
                      ),
                      _menstrualPregnancyCtrl,
                      lines: 3,
                    ),
                  _field(
                    s.lookup('s4.lib.admission_case_sheet.family_history'),
                    _familyHistoryCtrl,
                    lines: 3,
                  ),
                  _field(
                    s.lookup('s4.lib.admission_case_sheet.allergies'),
                    _allergiesCtrl,
                    lines: 2,
                  ),
                  const SizedBox(height: 12),
                  _sectionTitle(
                    theme,
                    s.lookup('s4.lib.admission_case_sheet.section.examination'),
                  ),
                  Wrap(
                    spacing: 12,
                    runSpacing: 12,
                    children: [
                      _smallField(
                        s.lookup('s4.lib.admission_case_sheet.pulse_rate'),
                        _pulseCtrl,
                        VitalUnit.pulse,
                      ),
                      _smallField(
                        s.lookup('s4.lib.admission_case_sheet.bp'),
                        _bpCtrl,
                        VitalUnit.bp,
                        keyboardType: TextInputType.text,
                      ),
                      _smallField(
                        s.lookup('s4.lib.admission_case_sheet.spo2'),
                        _spo2Ctrl,
                        VitalUnit.spo2,
                      ),
                      _smallField(
                        s.lookup('s4.lib.admission_case_sheet.cbg'),
                        _cbgCtrl,
                        VitalUnit.cbg,
                      ),
                      _smallField(
                        s.lookup('s4.lib.admission_case_sheet.weight'),
                        _weightCtrl,
                        VitalUnit.weight,
                      ),
                      _smallField(
                        s.lookup('s4.lib.admission_case_sheet.temperature'),
                        _temperatureCtrl,
                        VitalUnit.temperature,
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  _field(
                    s.lookup('s4.lib.admission_case_sheet.cvs'),
                    _cvsCtrl,
                    lines: 2,
                  ),
                  _field(
                    s.lookup('s4.lib.admission_case_sheet.rs'),
                    _rsCtrl,
                    lines: 2,
                  ),
                  _field(
                    s.lookup('s4.lib.admission_case_sheet.pa'),
                    _paCtrl,
                    lines: 2,
                  ),
                  _field(
                    s.lookup('s4.lib.admission_case_sheet.cns'),
                    _cnsCtrl,
                    lines: 2,
                  ),
                  const SizedBox(height: 12),
                  _sectionTitle(
                    theme,
                    s.lookup('s4.lib.admission_case_sheet.section.assessment'),
                  ),
                  _field(
                    s.lookup(
                      's4.lib.admission_case_sheet.provisional_diagnosis',
                    ),
                    _provisionalDiagnosisCtrl,
                    lines: 3,
                  ),
                ],
              ),
            ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: FilledButton.icon(
            onPressed: _loading || _saving ? null : _save,
            icon: _saving
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.save),
            label: Text(
              _saving
                  ? s.lookup('s4.lib.admission_case_sheet.saving')
                  : s.lookup('s4.lib.admission_case_sheet.save_case_sheet'),
            ),
          ),
        ),
      ),
    );
  }

  Widget _errorBox(ThemeData theme) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: theme.colorScheme.errorContainer,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        _error!,
        style: TextStyle(color: theme.colorScheme.onErrorContainer),
      ),
    );
  }

  Widget _sectionTitle(ThemeData theme, String title) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Text(title, style: theme.textTheme.titleMedium),
    );
  }

  Widget _field(
    String label,
    TextEditingController controller, {
    int lines = 1,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: ClinicalAutocompleteField(
        controller: controller,
        minLines: lines,
        maxLines: lines + 3,
        label: label,
      ),
    );
  }

  Widget _smallField(
    String label,
    TextEditingController controller,
    String unit, {
    TextInputType keyboardType = const TextInputType.numberWithOptions(
      decimal: true,
    ),
  }) {
    return SizedBox(
      width: 180,
      child: VitalTextField(
        controller: controller,
        label: label,
        unit: unit,
        keyboardType: keyboardType,
      ),
    );
  }
}
