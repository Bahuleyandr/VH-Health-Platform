import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../../core/services/staff_api_service.dart';

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

  final _types = {
    'harassment': 'Harassment',
    'discrimination': 'Discrimination',
    'unfair_treatment': 'Unfair Treatment',
    'unsafe_conditions': 'Unsafe Working Conditions',
    'workload': 'Excessive Workload',
    'pay_dispute': 'Pay / Compensation Dispute',
    'schedule_conflict': 'Schedule / Roster Conflict',
    'policy_violation': 'Policy Violation',
    'other': 'Other',
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
      final result = await StaffApiService.submitGrievance(
        grievanceType: _grievanceType,
        subject: _subjectCtrl.text.trim(),
        description: _descCtrl.text.trim(),
        againstWhom: _againstCtrl.text.trim().isNotEmpty ? _againstCtrl.text.trim() : null,
        department: _deptCtrl.text.trim().isNotEmpty ? _deptCtrl.text.trim() : null,
        incidentDate: _incidentDate != null ? DateFormat('yyyy-MM-dd').format(_incidentDate!) : null,
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
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(e.toString().replaceFirst('Exception: ', '')),
          backgroundColor: Colors.red,
        ));
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
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
                  width: 80, height: 80,
                  decoration: const BoxDecoration(color: Colors.purple, shape: BoxShape.circle),
                  child: const Icon(Icons.lock_outline, color: Colors.white, size: 40),
                ),
                const SizedBox(height: 20),
                const Text('Grievance Submitted',
                    style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
                if (_grievanceNumber != null) ...[
                  const SizedBox(height: 8),
                  Text(_grievanceNumber!,
                      style: const TextStyle(
                        fontSize: 18, fontWeight: FontWeight.bold,
                        color: Colors.purple, letterSpacing: 1,
                      )),
                ],
                const SizedBox(height: 12),
                Text(
                  _isAnonymous
                      ? 'Submitted anonymously. HR will acknowledge within 2 working days.'
                      : 'Your grievance has been received. HR will acknowledge within 2 working days.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.grey.shade600),
                ),
                const SizedBox(height: 32),
                ElevatedButton(
                  onPressed: () => Navigator.pop(context),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.purple,
                    minimumSize: const Size(200, 46),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                  ),
                  child: const Text('Done',
                      style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
                ),
              ],
            ),
          ),
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('Staff Grievance'),
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
                child: const Row(children: [
                  Icon(Icons.lock_outline, color: Colors.purple, size: 18),
                  SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'This form is seen only by HR and senior management. You may submit anonymously.',
                      style: TextStyle(fontSize: 12, color: Colors.purple),
                    ),
                  ),
                ]),
              ),

              const SizedBox(height: 16),
              const Text('Grievance Type *', style: TextStyle(fontWeight: FontWeight.w600)),
              const SizedBox(height: 8),
              DropdownButtonFormField<String>(
                initialValue: _grievanceType,
                decoration: const InputDecoration(border: OutlineInputBorder()),
                items: _types.entries
                    .map((e) => DropdownMenuItem(value: e.key, child: Text(e.value)))
                    .toList(),
                onChanged: (v) => setState(() => _grievanceType = v!),
              ),

              const SizedBox(height: 16),
              const Text('Subject *', style: TextStyle(fontWeight: FontWeight.w600)),
              const SizedBox(height: 8),
              TextFormField(
                controller: _subjectCtrl,
                decoration: const InputDecoration(
                  hintText: 'Brief summary of your concern',
                  border: OutlineInputBorder(),
                ),
                validator: (v) => (v?.trim().isEmpty ?? true) ? 'Subject is required' : null,
                maxLength: 200,
              ),

              const SizedBox(height: 8),
              const Text('Describe your grievance *', style: TextStyle(fontWeight: FontWeight.w600)),
              const SizedBox(height: 8),
              TextFormField(
                controller: _descCtrl,
                decoration: const InputDecoration(
                  hintText: 'Please provide as much detail as you feel comfortable sharing...',
                  border: OutlineInputBorder(),
                ),
                maxLines: 6,
                validator: (v) => (v?.trim().isEmpty ?? true) ? 'Description is required' : null,
              ),

              const SizedBox(height: 16),
              TextFormField(
                controller: _againstCtrl,
                decoration: const InputDecoration(
                  labelText: 'Against whom (optional)',
                  hintText: 'Name or role, if applicable',
                  border: OutlineInputBorder(),
                  prefixIcon: Icon(Icons.person_outline),
                ),
              ),

              const SizedBox(height: 12),
              TextFormField(
                controller: _deptCtrl,
                decoration: const InputDecoration(
                  labelText: 'Department (optional)',
                  border: OutlineInputBorder(),
                  prefixIcon: Icon(Icons.business_outlined),
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
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
                  decoration: BoxDecoration(
                    border: Border.all(color: Colors.grey.shade400),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Row(children: [
                    const Icon(Icons.calendar_today, size: 16, color: Colors.grey),
                    const SizedBox(width: 8),
                    Text(
                      _incidentDate != null
                          ? 'When did this occur: ${DateFormat('d MMMM yyyy').format(_incidentDate!)}'
                          : 'When did this occur? (optional)',
                      style: TextStyle(
                        color: _incidentDate != null ? Colors.black : Colors.grey.shade600,
                        fontSize: 13,
                      ),
                    ),
                    if (_incidentDate != null) ...[
                      const Spacer(),
                      GestureDetector(
                        onTap: () => setState(() => _incidentDate = null),
                        child: const Icon(Icons.clear, size: 16, color: Colors.grey),
                      ),
                    ],
                  ]),
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
                child: Row(children: [
                  Checkbox(
                    value: _isAnonymous,
                    onChanged: (v) => setState(() => _isAnonymous = v!),
                    activeColor: Colors.purple,
                  ),
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    const Text('Submit Anonymously',
                        style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                    Text('Your identity will not be disclosed',
                        style: TextStyle(fontSize: 11, color: Colors.grey.shade600)),
                  ])),
                ]),
              ),

              const SizedBox(height: 24),
              SizedBox(
                width: double.infinity,
                height: 52,
                child: ElevatedButton(
                  onPressed: _submitting ? null : _submit,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.purple,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                  child: _submitting
                      ? const CircularProgressIndicator(color: Colors.white, strokeWidth: 2)
                      : const Text('Submit Grievance',
                          style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: Colors.white)),
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
