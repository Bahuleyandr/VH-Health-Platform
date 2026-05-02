import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';

/// EMR Admissions screen — list active admissions, admit patients, view details.
class AdmissionScreen extends StatefulWidget {
  const AdmissionScreen({super.key});

  @override
  State<AdmissionScreen> createState() => _AdmissionScreenState();
}

class _AdmissionScreenState extends State<AdmissionScreen> {
  List<Map<String, dynamic>> _admissions = [];
  bool _loading = true;
  String? _error;
  final int _page = 1;

  @override
  void initState() {
    super.initState();
    _loadAdmissions();
  }

  Future<void> _loadAdmissions() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await MedicalApiService.getActiveAdmissions(page: _page);
      final list = data['admissions'];
      setState(() {
        _admissions = list is List
            ? list.map((e) => Map<String, dynamic>.from(e as Map)).toList()
            : [];
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  Color _priorityColor(String? priority) {
    switch (priority?.toLowerCase()) {
      case 'critical':
      case 'emergency':
        return AppTheme.errorRed;
      case 'urgent':
        return AppTheme.warningAmber;
      case 'routine':
        return AppTheme.successGreen;
      default:
        return AppTheme.textSecondary;
    }
  }

  Widget _statusBadge(String? status) {
    Color bg;
    Color fg;
    switch (status?.toLowerCase()) {
      case 'admitted':
        bg = AppTheme.primaryBlue.withValues(alpha: 0.12);
        fg = AppTheme.primaryBlue;
        break;
      case 'discharged':
        bg = AppTheme.successGreen.withValues(alpha: 0.12);
        fg = AppTheme.successGreen;
        break;
      case 'transferred':
        bg = AppTheme.warningAmber.withValues(alpha: 0.12);
        fg = AppTheme.warningAmber;
        break;
      default:
        bg = AppTheme.textSecondary.withValues(alpha: 0.12);
        fg = AppTheme.textSecondary;
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        status?.toUpperCase() ?? 'UNKNOWN',
        style: TextStyle(color: fg, fontSize: 11, fontWeight: FontWeight.w600),
      ),
    );
  }

  void _showAdmitPatientSheet() {
    final formKey = GlobalKey<FormState>();
    final patientSearch = TextEditingController();
    final chiefComplaint = TextEditingController();
    final diagnosis = TextEditingController();
    final ward = TextEditingController();
    final bed = TextEditingController();
    String priority = 'Routine';
    String codeStatus = 'Full Code';

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheetState) => Container(
          padding: EdgeInsets.only(
            bottom: MediaQuery.of(ctx).viewInsets.bottom,
          ),
          decoration: const BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
          ),
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Form(
              key: formKey,
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
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
                    SizedBox(height: 16),
                    Text(
                      'Admit Patient',
                      style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.w600,
                        color: AppTheme.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 20),
                    TextFormField(
                      controller: patientSearch,
                      decoration: const InputDecoration(
                        labelText: 'Patient (name, UID, or phone)',
                        prefixIcon: ExcludeSemantics(child: Icon(Icons.search)),
                        border: OutlineInputBorder(),
                      ),
                      validator: (v) =>
                          (v == null || v.isEmpty) ? 'Required' : null,
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: chiefComplaint,
                      decoration: const InputDecoration(
                        labelText: 'Chief Complaint',
                        border: OutlineInputBorder(),
                      ),
                      maxLines: 2,
                      validator: (v) =>
                          (v == null || v.isEmpty) ? 'Required' : null,
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: diagnosis,
                      decoration: const InputDecoration(
                        labelText: 'Provisional Diagnosis',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: TextFormField(
                            controller: ward,
                            decoration: const InputDecoration(
                              labelText: 'Ward',
                              border: OutlineInputBorder(),
                            ),
                            validator: (v) =>
                                (v == null || v.isEmpty) ? 'Required' : null,
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: TextFormField(
                            controller: bed,
                            decoration: const InputDecoration(
                              labelText: 'Bed Number',
                              border: OutlineInputBorder(),
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    DropdownButtonFormField<String>(
                      initialValue: priority,
                      decoration: const InputDecoration(
                        labelText: 'Priority',
                        border: OutlineInputBorder(),
                      ),
                      items: const [
                        DropdownMenuItem(
                          value: 'Routine',
                          child: Text('Routine'),
                        ),
                        DropdownMenuItem(
                          value: 'Urgent',
                          child: Text('Urgent'),
                        ),
                        DropdownMenuItem(
                          value: 'Emergency',
                          child: Text('Emergency'),
                        ),
                        DropdownMenuItem(
                          value: 'Critical',
                          child: Text('Critical'),
                        ),
                      ],
                      onChanged: (v) =>
                          setSheetState(() => priority = v ?? priority),
                    ),
                    const SizedBox(height: 12),
                    DropdownButtonFormField<String>(
                      initialValue: codeStatus,
                      decoration: const InputDecoration(
                        labelText: 'Code Status',
                        border: OutlineInputBorder(),
                      ),
                      items: const [
                        DropdownMenuItem(
                          value: 'Full Code',
                          child: Text('Full Code'),
                        ),
                        DropdownMenuItem(value: 'DNR', child: Text('DNR')),
                        DropdownMenuItem(
                          value: 'DNR/DNI',
                          child: Text('DNR/DNI'),
                        ),
                        DropdownMenuItem(
                          value: 'Comfort Care',
                          child: Text('Comfort Care'),
                        ),
                      ],
                      onChanged: (v) =>
                          setSheetState(() => codeStatus = v ?? codeStatus),
                    ),
                    const SizedBox(height: 20),
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton.icon(
                        onPressed: () => _submitAdmission(
                          formKey: formKey,
                          patientSearch: patientSearch.text,
                          chiefComplaint: chiefComplaint.text,
                          diagnosis: diagnosis.text,
                          ward: ward.text,
                          bed: bed.text,
                          priority: priority,
                          codeStatus: codeStatus,
                        ),
                        icon: const Icon(Icons.local_hospital),
                        label: const Text('Admit Patient'),
                      ),
                    ),
                    const SizedBox(height: 12),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _submitAdmission({
    required GlobalKey<FormState> formKey,
    required String patientSearch,
    required String chiefComplaint,
    required String diagnosis,
    required String ward,
    required String bed,
    required String priority,
    required String codeStatus,
  }) async {
    if (!formKey.currentState!.validate()) return;
    Navigator.of(context).pop();

    try {
      await MedicalApiService.admitPatient({
        'patient_query': patientSearch,
        'chief_complaint': chiefComplaint,
        'provisional_diagnosis': diagnosis,
        'ward': ward,
        'bed': bed,
        'priority': priority.toLowerCase(),
        'code_status': codeStatus,
      });
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Patient admitted successfully'),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        _loadAdmissions();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Admission failed: $e'),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    }
  }

  void _showAdmissionDetail(Map<String, dynamic> admission) {
    final id = admission['id'];
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => _AdmissionDetailSheet(admissionId: id is int ? id : 0),
    );
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'Admissions',
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _showAdmitPatientSheet,
        backgroundColor: AppTheme.primaryBlue,
        foregroundColor: Colors.white,
        icon: const Icon(Icons.person_add),
        label: const Text('Admit'),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
          ? Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(
                    Icons.error_outline,
                    size: 48,
                    color: AppTheme.errorRed,
                  ),
                  const SizedBox(height: 12),
                  Text(_error!, textAlign: TextAlign.center),
                  const SizedBox(height: 12),
                  OutlinedButton(
                    onPressed: _loadAdmissions,
                    child: const Text('Retry'),
                  ),
                ],
              ),
            )
          : _admissions.isEmpty
          ? Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(Icons.bed, size: 64, color: AppTheme.divider),
                  SizedBox(height: 12),
                  Text(
                    'No active admissions',
                    style: TextStyle(color: AppTheme.textSecondary),
                  ),
                ],
              ),
            )
          : RefreshIndicator(
              onRefresh: _loadAdmissions,
              child: ListView.builder(
                padding: const EdgeInsets.all(12),
                itemCount: _admissions.length,
                itemBuilder: (ctx, i) {
                  final a = _admissions[i];
                  return Card(
                    margin: const EdgeInsets.only(bottom: 10),
                    child: ListTile(
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 16,
                        vertical: 8,
                      ),
                      leading: CircleAvatar(
                        backgroundColor: _priorityColor(
                          a['priority'] as String?,
                        ).withValues(alpha: 0.15),
                        child: Icon(
                          Icons.local_hospital,
                          color: _priorityColor(a['priority'] as String?),
                        ),
                      ),
                      title: Text(
                        a['patient_name'] as String? ?? 'Patient',
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                      subtitle: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            '${a['ward'] ?? ''} ${a['bed'] != null ? '- Bed ${a['bed']}' : ''}',
                            style: const TextStyle(fontSize: 13),
                          ),
                          if (a['chief_complaint'] != null)
                            Text(
                              a['chief_complaint'] as String,
                              style: TextStyle(
                                fontSize: 12,
                                color: AppTheme.textSecondary,
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                        ],
                      ),
                      trailing: _statusBadge(a['status'] as String?),
                      onTap: () => _showAdmissionDetail(a),
                    ),
                  );
                },
              ),
            ),
    );
  }
}

// ─── Admission Detail Sheet ─────────────────────────────────────────────────

class _AdmissionDetailSheet extends StatefulWidget {
  final int admissionId;

  const _AdmissionDetailSheet({required this.admissionId});

  @override
  State<_AdmissionDetailSheet> createState() => _AdmissionDetailSheetState();
}

class _AdmissionDetailSheetState extends State<_AdmissionDetailSheet> {
  Map<String, dynamic>? _detail;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadDetail();
  }

  Future<void> _loadDetail() async {
    try {
      final data = await MedicalApiService.getAdmissionDetail(
        widget.admissionId,
      );
      setState(() {
        _detail = data;
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  Widget _infoRow(String label, String? value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 120,
            child: Text(
              label,
              style: TextStyle(
                color: AppTheme.textSecondary,
                fontSize: 13,
              ),
            ),
          ),
          Expanded(
            child: Text(
              value ?? '-',
              style: const TextStyle(fontWeight: FontWeight.w500, fontSize: 13),
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.of(context).size.height * 0.85,
      ),
      decoration: const BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      child: _loading
          ? const Center(
              child: Padding(
                padding: EdgeInsets.all(40),
                child: CircularProgressIndicator(),
              ),
            )
          : _error != null
          ? Padding(
              padding: const EdgeInsets.all(40),
              child: Center(child: Text('Error: $_error')),
            )
          : SingleChildScrollView(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
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
                  SizedBox(height: 16),
                  Text(
                    _detail?['patient_name'] as String? ?? 'Patient',
                    style: TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.w600,
                      color: AppTheme.textPrimary,
                    ),
                  ),
                  SizedBox(height: 4),
                  Text(
                    'Admission #${widget.admissionId}',
                    style: TextStyle(
                      color: AppTheme.textSecondary,
                      fontSize: 13,
                    ),
                  ),
                  const Divider(height: 24),

                  // Patient Info
                  const Text(
                    'Patient Information',
                    style: TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
                  ),
                  const SizedBox(height: 8),
                  _infoRow('UID', _detail?['patient_uid'] as String?),
                  _infoRow('Age/Gender', _detail?['age_gender'] as String?),
                  _infoRow('Blood Group', _detail?['blood_group'] as String?),
                  _infoRow('Allergies', _detail?['allergies'] as String?),

                  const SizedBox(height: 16),
                  const Text(
                    'Admission Details',
                    style: TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
                  ),
                  const SizedBox(height: 8),
                  _infoRow('Ward', _detail?['ward'] as String?),
                  _infoRow('Bed', _detail?['bed']?.toString()),
                  _infoRow('Admitted On', _detail?['admitted_at'] as String?),
                  _infoRow(
                    'Chief Complaint',
                    _detail?['chief_complaint'] as String?,
                  ),
                  _infoRow(
                    'Diagnosis',
                    _detail?['provisional_diagnosis'] as String?,
                  ),
                  _infoRow('Priority', _detail?['priority'] as String?),
                  _infoRow('Code Status', _detail?['code_status'] as String?),
                  _infoRow(
                    'Attending',
                    _detail?['attending_doctor'] as String?,
                  ),

                  const SizedBox(height: 16),
                  // Quick action buttons
                  const Text(
                    'Quick Actions',
                    style: TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
                  ),
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      ActionChip(
                        avatar: const Icon(Icons.monitor_heart, size: 18),
                        label: const Text('Vitals'),
                        onPressed: () {
                          Navigator.pop(context);
                          final uid = _detail?['patient_uid'] as String?;
                          final name = _detail?['patient_name'] as String?;
                          if (uid != null) {
                            context.go(
                              '/emr/vitals/$uid${name != null ? '?name=$name' : ''}',
                            );
                          }
                        },
                      ),
                      ActionChip(
                        avatar: const Icon(Icons.note_add, size: 18),
                        label: const Text('Notes'),
                        onPressed: () {
                          Navigator.pop(context);
                          final uid = _detail?['patient_uid'] as String?;
                          final name = _detail?['patient_name'] as String?;
                          if (uid != null) {
                            context.go(
                              '/emr/notes/$uid${name != null ? '?name=$name' : ''}',
                            );
                          }
                        },
                      ),
                      ActionChip(
                        avatar: const Icon(Icons.receipt_long, size: 18),
                        label: const Text('Orders'),
                        onPressed: () {
                          Navigator.pop(context);
                          final uid = _detail?['patient_uid'] as String?;
                          final name = _detail?['patient_name'] as String?;
                          if (uid != null) {
                            context.go(
                              '/emr/orders/$uid${name != null ? '?name=$name' : ''}',
                            );
                          }
                        },
                      ),
                      ActionChip(
                        avatar: const Icon(Icons.timeline, size: 18),
                        label: const Text('Timeline'),
                        onPressed: () {
                          Navigator.pop(context);
                          final uid = _detail?['patient_uid'] as String?;
                          final name = _detail?['patient_name'] as String?;
                          if (uid != null) {
                            context.go(
                              '/emr/timeline/$uid${name != null ? '?name=$name' : ''}',
                            );
                          }
                        },
                      ),
                    ],
                  ),
                  const SizedBox(height: 20),
                ],
              ),
            ),
    );
  }
}
