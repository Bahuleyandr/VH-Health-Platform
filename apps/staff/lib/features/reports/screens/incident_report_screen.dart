import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../../core/services/hr_api_service.dart';
import '../../../core/widgets/logout_action.dart';

class IncidentReportScreen extends StatefulWidget {
  const IncidentReportScreen({super.key});

  @override
  State<IncidentReportScreen> createState() => _IncidentReportScreenState();
}

class _IncidentReportScreenState extends State<IncidentReportScreen> {
  final _formKey = GlobalKey<FormState>();
  bool _submitting = false;
  bool _submitted = false;
  String? _reportNumber;

  String _incidentType = 'near_miss';
  String _severity = 'moderate';
  final _titleCtrl = TextEditingController();
  final _descCtrl = TextEditingController();
  final _locationCtrl = TextEditingController();
  final _witnessesCtrl = TextEditingController();
  final _actionCtrl = TextEditingController();
  DateTime _incidentDate = DateTime.now();
  TimeOfDay _incidentTime = TimeOfDay.now();
  bool _patientInvolved = false;
  final _patientNameCtrl = TextEditingController();
  bool _isAnonymous = false;

  final _incidentTypes = {
    'near_miss': 'Near Miss',
    'patient_fall': 'Patient Fall',
    'medication_error': 'Medication Error',
    'needle_stick': 'Needle Stick / Sharps Injury',
    'equipment_failure': 'Equipment Failure',
    'infection': 'Infection / Exposure',
    'fire_safety': 'Fire / Safety Hazard',
    'patient_aggression': 'Patient Aggression',
    'security_breach': 'Security Breach',
    'other': 'Other',
  };

  static const _severities = [
    ('low', 'Low', Color(0xFF388E3C), 'Minor, no harm caused'),
    ('moderate', 'Moderate', Color(0xFFF57C00), 'Some impact, managed locally'),
    (
      'severe',
      'Severe',
      Color(0xFFD32F2F),
      'Significant harm, requires investigation',
    ),
    (
      'sentinel',
      'Sentinel',
      Color(0xFF7B0000),
      'Unexpected death or serious harm',
    ),
  ];

  @override
  void dispose() {
    _titleCtrl.dispose();
    _descCtrl.dispose();
    _locationCtrl.dispose();
    _witnessesCtrl.dispose();
    _actionCtrl.dispose();
    _patientNameCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;

    final dt = DateTime(
      _incidentDate.year,
      _incidentDate.month,
      _incidentDate.day,
      _incidentTime.hour,
      _incidentTime.minute,
    );

    setState(() => _submitting = true);
    try {
      final result = await HrApiService.submitIncidentReport(
        incidentType: _incidentType,
        severity: _severity,
        title: _titleCtrl.text.trim(),
        description: _descCtrl.text.trim(),
        incidentDate: dt.toIso8601String(),
        location: _locationCtrl.text.trim().isNotEmpty
            ? _locationCtrl.text.trim()
            : null,
        patientInvolved: _patientInvolved,
        patientName: _patientInvolved && _patientNameCtrl.text.trim().isNotEmpty
            ? _patientNameCtrl.text.trim()
            : null,
        witnesses: _witnessesCtrl.text.trim().isNotEmpty
            ? _witnessesCtrl.text.trim()
            : null,
        immediateActionTaken: _actionCtrl.text.trim().isNotEmpty
            ? _actionCtrl.text.trim()
            : null,
        isAnonymous: _isAnonymous,
      );
      final data = result['data'] as Map<String, dynamic>? ?? result;
      if (mounted) {
        setState(() {
          _submitted = true;
          _reportNumber = data['report_number'] as String?;
        });
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(e.toString().replaceFirst('Exception: ', '')),
            backgroundColor: Colors.red,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_submitted) return _buildSuccessScreen();

    return Scaffold(
      appBar: AppBar(
        title: const Text('Incident Report'),
        actions: const [LogoutAction()],
        backgroundColor: const Color(0xFF007A64),
        foregroundColor: Colors.white,
      ),
      body: Form(
        key: _formKey,
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Severity *',
                style: TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
              ),
              const SizedBox(height: 8),
              ..._severities.map((entry) {
                final (key, label, color, desc) = entry;
                final selected = _severity == key;
                return Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: InkWell(
                    onTap: () => setState(() => _severity = key),
                    borderRadius: BorderRadius.circular(10),
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 14,
                        vertical: 10,
                      ),
                      decoration: BoxDecoration(
                        border: Border.all(
                          color: selected ? color : Colors.grey.shade300,
                          width: selected ? 2 : 1,
                        ),
                        borderRadius: BorderRadius.circular(10),
                        color: selected
                            ? color.withValues(alpha: 0.08)
                            : Colors.white,
                      ),
                      child: Row(
                        children: [
                          Container(
                            width: 12,
                            height: 12,
                            decoration: BoxDecoration(
                              color: color,
                              shape: BoxShape.circle,
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  label,
                                  style: TextStyle(
                                    fontWeight: FontWeight.bold,
                                    color: selected ? color : Colors.black87,
                                  ),
                                ),
                                Text(
                                  desc,
                                  style: TextStyle(
                                    fontSize: 11,
                                    color: Colors.grey.shade600,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          if (selected)
                            Icon(Icons.check_circle, color: color, size: 20),
                        ],
                      ),
                    ),
                  ),
                );
              }),

              const SizedBox(height: 16),
              const Text(
                'Incident Type *',
                style: TextStyle(fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 8),
              DropdownButtonFormField<String>(
                initialValue: _incidentType,
                decoration: const InputDecoration(border: OutlineInputBorder()),
                items: _incidentTypes.entries
                    .map(
                      (e) =>
                          DropdownMenuItem(value: e.key, child: Text(e.value)),
                    )
                    .toList(),
                onChanged: (v) => setState(() => _incidentType = v!),
              ),

              const SizedBox(height: 16),
              const Text(
                'Brief Title *',
                style: TextStyle(fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 8),
              TextFormField(
                controller: _titleCtrl,
                decoration: const InputDecoration(
                  hintText: 'e.g. Patient fell near bed 12B',
                  border: OutlineInputBorder(),
                ),
                validator: (v) =>
                    (v?.trim().isEmpty ?? true) ? 'Title is required' : null,
                maxLength: 200,
              ),

              const SizedBox(height: 8),
              const Text(
                'What happened? *',
                style: TextStyle(fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 8),
              TextFormField(
                controller: _descCtrl,
                decoration: const InputDecoration(
                  hintText:
                      'Describe the incident in detail — what happened, who was involved, what the conditions were...',
                  border: OutlineInputBorder(),
                ),
                maxLines: 5,
                validator: (v) => (v?.trim().isEmpty ?? true)
                    ? 'Description is required'
                    : null,
              ),

              const SizedBox(height: 16),
              Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'Date *',
                          style: TextStyle(fontWeight: FontWeight.w600),
                        ),
                        const SizedBox(height: 6),
                        InkWell(
                          onTap: () async {
                            final d = await showDatePicker(
                              context: context,
                              initialDate: _incidentDate,
                              firstDate: DateTime.now().subtract(
                                const Duration(days: 30),
                              ),
                              lastDate: DateTime.now(),
                            );
                            if (d != null) setState(() => _incidentDate = d);
                          },
                          child: Container(
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(
                              border: Border.all(color: Colors.grey.shade400),
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: Row(
                              children: [
                                const Icon(
                                  Icons.calendar_today,
                                  size: 16,
                                  color: Colors.grey,
                                ),
                                const SizedBox(width: 6),
                                Text(
                                  DateFormat(
                                    'd MMM yyyy',
                                  ).format(_incidentDate),
                                  style: const TextStyle(fontSize: 13),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'Time *',
                          style: TextStyle(fontWeight: FontWeight.w600),
                        ),
                        const SizedBox(height: 6),
                        InkWell(
                          onTap: () async {
                            final t = await showTimePicker(
                              context: context,
                              initialTime: _incidentTime,
                            );
                            if (t != null) setState(() => _incidentTime = t);
                          },
                          child: Container(
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(
                              border: Border.all(color: Colors.grey.shade400),
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: Row(
                              children: [
                                const Icon(
                                  Icons.access_time,
                                  size: 16,
                                  color: Colors.grey,
                                ),
                                const SizedBox(width: 6),
                                Text(
                                  _incidentTime.format(context),
                                  style: const TextStyle(fontSize: 13),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),

              const SizedBox(height: 16),
              TextFormField(
                controller: _locationCtrl,
                decoration: const InputDecoration(
                  labelText: 'Location (optional)',
                  hintText: 'Ward, room, or area',
                  border: OutlineInputBorder(),
                  prefixIcon: Icon(Icons.location_on_outlined),
                ),
              ),

              const SizedBox(height: 16),
              Row(
                children: [
                  const Text(
                    'Patient Involved',
                    style: TextStyle(fontWeight: FontWeight.w600),
                  ),
                  const Spacer(),
                  Switch(
                    value: _patientInvolved,
                    onChanged: (v) => setState(() => _patientInvolved = v),
                    activeThumbColor: const Color(0xFF007A64),
                  ),
                ],
              ),
              if (_patientInvolved) ...[
                const SizedBox(height: 8),
                TextFormField(
                  controller: _patientNameCtrl,
                  decoration: const InputDecoration(
                    labelText: 'Patient Name / ID (optional)',
                    border: OutlineInputBorder(),
                  ),
                ),
              ],

              const SizedBox(height: 16),
              TextFormField(
                controller: _witnessesCtrl,
                decoration: const InputDecoration(
                  labelText: 'Witnesses (optional)',
                  hintText: 'Names of anyone who saw the incident',
                  border: OutlineInputBorder(),
                  prefixIcon: Icon(Icons.people_outline),
                ),
              ),

              const SizedBox(height: 16),
              TextFormField(
                controller: _actionCtrl,
                decoration: const InputDecoration(
                  labelText: 'Immediate Action Taken (optional)',
                  hintText: 'What was done right after the incident?',
                  border: OutlineInputBorder(),
                ),
                maxLines: 3,
              ),

              const SizedBox(height: 16),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.grey.shade50,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: Colors.grey.shade300),
                ),
                child: Row(
                  children: [
                    Checkbox(
                      value: _isAnonymous,
                      onChanged: (v) => setState(() => _isAnonymous = v!),
                      activeColor: const Color(0xFF007A64),
                    ),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                            'Submit Anonymously',
                            style: TextStyle(
                              fontWeight: FontWeight.w600,
                              fontSize: 13,
                            ),
                          ),
                          Text(
                            'Your name will not be attached to this report',
                            style: TextStyle(
                              fontSize: 11,
                              color: Colors.grey.shade600,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),

              const SizedBox(height: 24),
              SizedBox(
                width: double.infinity,
                height: 52,
                child: ElevatedButton(
                  onPressed: _submitting ? null : _submit,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF007A64),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                  child: _submitting
                      ? const CircularProgressIndicator(
                          color: Colors.white,
                          strokeWidth: 2,
                        )
                      : const Text(
                          'Submit Incident Report',
                          style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.bold,
                            color: Colors.white,
                          ),
                        ),
                ),
              ),
              const SizedBox(height: 16),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildSuccessScreen() {
    return Scaffold(
      backgroundColor: const Color(0xFFE0F5F6),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                width: 80,
                height: 80,
                decoration: const BoxDecoration(
                  color: Color(0xFF007A64),
                  shape: BoxShape.circle,
                ),
                child: const Icon(Icons.check, color: Colors.white, size: 44),
              ),
              const SizedBox(height: 20),
              const Text(
                'Report Submitted',
                style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
              ),
              if (_reportNumber != null) ...[
                const SizedBox(height: 8),
                Text(
                  _reportNumber!,
                  style: const TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.bold,
                    color: Color(0xFF007A64),
                    letterSpacing: 1,
                  ),
                ),
              ],
              const SizedBox(height: 12),
              Text(
                _severity == 'sentinel' || _severity == 'severe'
                    ? 'This has been escalated as HIGH PRIORITY. Management has been notified.'
                    : 'Your report has been received and will be reviewed within 24 hours.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.grey.shade600),
              ),
              const SizedBox(height: 32),
              ElevatedButton(
                onPressed: () => Navigator.pop(context),
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF007A64),
                  minimumSize: const Size(200, 46),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(10),
                  ),
                ),
                child: const Text(
                  'Done',
                  style: TextStyle(
                    color: Colors.white,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
