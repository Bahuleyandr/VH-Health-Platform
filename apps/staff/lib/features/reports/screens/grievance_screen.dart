import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../../core/services/hr_api_service.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';

class GrievanceScreen extends StatefulWidget {
  const GrievanceScreen({super.key});

  @override
  State<GrievanceScreen> createState() => _GrievanceScreenState();
}

class _GrievanceScreenState extends State<GrievanceScreen> {
  final _formKey = GlobalKey<FormState>();
  bool _submitting = false;
  bool _submitted = false;
  String? _grievanceNumber;

  String _grievanceType = 'unfair_treatment';
  final _subjectCtrl = TextEditingController();
  final _descCtrl = TextEditingController();
  final _againstCtrl = TextEditingController();
  final _deptCtrl = TextEditingController();
  DateTime? _incidentDate;
  bool _isAnonymous = false;

  Map<String, String> _typesFor(AppStrings s) => {
    'harassment': s.grievanceTypeHarassment,
    'discrimination': s.grievanceTypeDiscrimination,
    'unfair_treatment': s.grievanceTypeUnfairTreatment,
    'unsafe_conditions': s.grievanceTypeUnsafeConditions,
    'workload': s.grievanceTypeWorkload,
    'pay_dispute': s.grievanceTypePayDispute,
    'schedule_conflict': s.grievanceTypeScheduleConflict,
    'policy_violation': s.grievanceTypePolicyViolation,
    'other': s.grievanceTypeOther,
  };

  @override
  void dispose() {
    _subjectCtrl.dispose();
    _descCtrl.dispose();
    _againstCtrl.dispose();
    _deptCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _submitting = true);
    try {
      final result = await HrApiService.submitGrievance(
        grievanceType: _grievanceType,
        subject: _subjectCtrl.text.trim(),
        description: _descCtrl.text.trim(),
        againstWhom: _againstCtrl.text.trim().isNotEmpty
            ? _againstCtrl.text.trim()
            : null,
        department: _deptCtrl.text.trim().isNotEmpty
            ? _deptCtrl.text.trim()
            : null,
        incidentDate: _incidentDate != null
            ? DateFormat('yyyy-MM-dd').format(_incidentDate!)
            : null,
        isAnonymous: _isAnonymous,
      );
      final data = result['data'] as Map<String, dynamic>? ?? result;
      if (mounted) {
        setState(() {
          _submitted = true;
          _grievanceNumber = data['grievance_number'] as String?;
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
    final s = AppStrings.of(context);
    if (_submitted) {
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
                    color: Colors.purple,
                    shape: BoxShape.circle,
                  ),
                  child: const Icon(
                    Icons.lock_outline,
                    color: Colors.white,
                    size: 40,
                  ),
                ),
                const SizedBox(height: 20),
                Text(
                  s.grievanceSubmittedTitle,
                  style: const TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                if (_grievanceNumber != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    _grievanceNumber!,
                    style: const TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                      color: Colors.purple,
                      letterSpacing: 1,
                    ),
                  ),
                ],
                const SizedBox(height: 12),
                Text(
                  _isAnonymous
                      ? s.grievanceAcknowledgementAnonymous
                      : s.grievanceAcknowledgementNote,
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.grey.shade600),
                ),
                const SizedBox(height: 32),
                ElevatedButton(
                  onPressed: () => Navigator.pop(context),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.purple,
                    minimumSize: const Size(200, 46),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                  ),
                  child: Text(
                    s.incidentReportDoneButton,
                    style: const TextStyle(
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

    return Scaffold(
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(s.grievanceTitle),
        actions: const [LogoutAction()],
        backgroundColor: Colors.purple,
        foregroundColor: Colors.white,
      ),
      body: Form(
        key: _formKey,
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.purple.shade50,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: Colors.purple.shade200),
                ),
                child: Row(
                  children: [
                    const Icon(
                      Icons.lock_outline,
                      color: Colors.purple,
                      size: 18,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        s.grievancePrivacyNote,
                        style: const TextStyle(
                          fontSize: 12,
                          color: Colors.purple,
                        ),
                      ),
                    ),
                  ],
                ),
              ),

              const SizedBox(height: 16),
              Text(
                s.grievanceTypeLabel,
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 8),
              DropdownButtonFormField<String>(
                initialValue: _grievanceType,
                decoration: const InputDecoration(border: OutlineInputBorder()),
                items: _typesFor(s).entries
                    .map(
                      (e) =>
                          DropdownMenuItem(value: e.key, child: Text(e.value)),
                    )
                    .toList(),
                onChanged: (v) => setState(() => _grievanceType = v!),
              ),

              const SizedBox(height: 16),
              Text(
                s.grievanceSubjectLabel,
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 8),
              TextFormField(
                controller: _subjectCtrl,
                decoration: InputDecoration(
                  hintText: s.grievanceSubjectHint,
                  border: const OutlineInputBorder(),
                ),
                validator: (v) => (v?.trim().isEmpty ?? true)
                    ? s.grievanceSubjectRequired
                    : null,
                maxLength: 200,
              ),

              const SizedBox(height: 8),
              Text(
                s.grievanceDescribeLabel,
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 8),
              TextFormField(
                controller: _descCtrl,
                decoration: InputDecoration(
                  hintText: s.grievanceDescribeHint,
                  border: const OutlineInputBorder(),
                ),
                maxLines: 6,
                validator: (v) => (v?.trim().isEmpty ?? true)
                    ? s.grievanceDescriptionRequired
                    : null,
              ),

              const SizedBox(height: 16),
              TextFormField(
                controller: _againstCtrl,
                decoration: InputDecoration(
                  labelText: s.grievanceAgainstWhomLabel,
                  hintText: s.grievanceAgainstWhomHint,
                  border: const OutlineInputBorder(),
                  prefixIcon: const ExcludeSemantics(
                    child: Icon(Icons.person_outline),
                  ),
                ),
              ),

              const SizedBox(height: 12),
              TextFormField(
                controller: _deptCtrl,
                decoration: InputDecoration(
                  labelText: s.grievanceDeptLabel,
                  border: const OutlineInputBorder(),
                  prefixIcon: const ExcludeSemantics(
                    child: Icon(Icons.business_outlined),
                  ),
                ),
              ),

              const SizedBox(height: 12),
              InkWell(
                onTap: () async {
                  final d = await showDatePicker(
                    context: context,
                    initialDate: DateTime.now(),
                    firstDate: DateTime(2024),
                    lastDate: DateTime.now(),
                  );
                  if (d != null) setState(() => _incidentDate = d);
                },
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 14,
                  ),
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
                      const SizedBox(width: 8),
                      Text(
                        _incidentDate != null
                            ? '${s.grievanceDatePrefix} ${DateFormat('d MMMM yyyy').format(_incidentDate!)}'
                            : s.grievanceDateOptional,
                        style: TextStyle(
                          color: _incidentDate != null
                              ? Colors.black
                              : Colors.grey.shade600,
                          fontSize: 13,
                        ),
                      ),
                      if (_incidentDate != null) ...[
                        const Spacer(),
                        GestureDetector(
                          onTap: () => setState(() => _incidentDate = null),
                          child: const Icon(
                            Icons.clear,
                            size: 16,
                            color: Colors.grey,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
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
                      activeColor: Colors.purple,
                    ),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            s.grievanceAnonymous,
                            style: const TextStyle(
                              fontWeight: FontWeight.w600,
                              fontSize: 13,
                            ),
                          ),
                          Text(
                            s.grievanceAnonymousNote,
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
                    backgroundColor: Colors.purple,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                  child: _submitting
                      ? const CircularProgressIndicator(
                          color: Colors.white,
                          strokeWidth: 2,
                        )
                      : Text(
                          s.grievanceSubmitButton,
                          style: const TextStyle(
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
}
