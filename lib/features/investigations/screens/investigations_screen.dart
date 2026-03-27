import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../../core/config/api_config.dart';
import '../../../core/services/staff_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';

class InvestigationsScreen extends StatefulWidget {
  const InvestigationsScreen({super.key});

  @override
  State<InvestigationsScreen> createState() => _InvestigationsScreenState();
}

class _InvestigationsScreenState extends State<InvestigationsScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'Investigations',
      body: Column(
        children: [
          Container(
            color: Colors.white,
            child: TabBar(
              controller: _tabController,
              labelColor: AppTheme.primaryBlue,
              unselectedLabelColor: AppTheme.textSecondary,
              indicatorColor: AppTheme.primaryBlue,
              tabs: const [
                Tab(text: 'Upload Result'),
                Tab(text: 'Pending'),
                Tab(text: 'Recent'),
              ],
            ),
          ),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: const [
                _UploadTab(),
                _PendingTab(),
                _RecentUploadsTab(),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _UploadTab extends StatefulWidget {
  const _UploadTab();

  @override
  State<_UploadTab> createState() => _UploadTabState();
}

class _UploadTabState extends State<_UploadTab> {
  final _formKey = GlobalKey<FormState>();
  final _phoneCtrl = TextEditingController();
  final _notesCtrl = TextEditingController();
  final _resultCtrl = TextEditingController();
  String? _testType;
  bool _submitting = false;
  File? _file;
  String? _fileName;

  static const _testTypes = [
    'Blood Test - CBC',
    'Blood Test - Lipid Panel',
    'Blood Test - HBA1C',
    'Blood Test - Thyroid',
    'Urine Analysis',
    'X-Ray',
    'CT Scan',
    'MRI',
    'Ultrasound',
    'ECG',
    'Echocardiogram',
    'Biopsy',
    'Culture & Sensitivity',
    'COVID-19 PCR',
    'Other',
  ];

  @override
  void dispose() {
    _phoneCtrl.dispose();
    _notesCtrl.dispose();
    _resultCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _submitting = true);
    try {
      await StaffApiService.uploadInvestigation(
        phone: _phoneCtrl.text.trim(),
        testType: _testType!,
        result:
            _resultCtrl.text.trim().isEmpty ? null : _resultCtrl.text.trim(),
        notes: _notesCtrl.text.trim().isEmpty ? null : _notesCtrl.text.trim(),
        date: DateFormat('yyyy-MM-dd').format(DateTime.now()),
        filePath: _file?.path,
        fileName: _fileName,
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('✅ Investigation result uploaded successfully'),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        _formKey.currentState!.reset();
        setState(() {
          _testType = null;
          _file = null;
          _fileName = null;
        });
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(e.toString().replaceFirst('Exception: ', '')),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Form(
        key: _formKey,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppTheme.accentCyan.withOpacity(0.08),
                borderRadius: BorderRadius.circular(8),
                border:
                    Border.all(color: AppTheme.accentCyan.withOpacity(0.3)),
              ),
              child: const Row(
                children: [
                  Icon(Icons.info_outline,
                      color: AppTheme.accentCyan, size: 18),
                  SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Search patient by phone number and upload their investigation results.',
                      style:
                          TextStyle(color: AppTheme.accentCyan, fontSize: 13),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: _phoneCtrl,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(
                labelText: 'Patient Phone Number',
                hintText: '+91 XXXXX XXXXX',
                prefixIcon: Icon(Icons.phone_outlined),
              ),
              validator: (v) {
                if (v == null || v.trim().isEmpty) return 'Phone is required';
                if (v.trim().length < 10) return 'Enter valid phone number';
                return null;
              },
            ),
            const SizedBox(height: 16),
            DropdownButtonFormField<String>(
              value: _testType,
              decoration: const InputDecoration(
                labelText: 'Test Type',
                prefixIcon: Icon(Icons.biotech_outlined),
              ),
              items: _testTypes
                  .map(
                      (t) => DropdownMenuItem(value: t, child: Text(t)))
                  .toList(),
              onChanged: (v) => setState(() => _testType = v),
              validator: (v) => v == null ? 'Select test type' : null,
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: _resultCtrl,
              decoration: const InputDecoration(
                labelText: 'Result / Summary',
                hintText: 'Enter test results or summary...',
                prefixIcon: Icon(Icons.assignment_outlined),
                alignLabelWithHint: true,
              ),
              maxLines: 3,
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: _notesCtrl,
              decoration: const InputDecoration(
                labelText: 'Clinical Notes (optional)',
                hintText: 'Additional observations...',
                prefixIcon: Icon(Icons.notes_outlined),
                alignLabelWithHint: true,
              ),
              maxLines: 2,
            ),
            const SizedBox(height: 16),
            GestureDetector(
              onTap: _submitting ? null : () async {
                try {
                  final result = await FilePicker.platform.pickFiles(
                    type: FileType.custom,
                    allowedExtensions: ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png'],
                  );
                  if (result?.files.single.path != null) {
                    setState(() {
                      _file = File(result!.files.single.path!);
                      _fileName = result.files.single.name;
                    });
                  }
                } catch (e) {
                  if (mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('Failed to pick file'),
                        backgroundColor: AppTheme.errorRed,
                      ),
                    );
                  }
                }
              },
              child: Container(
                height: 80,
                width: double.infinity,
                decoration: BoxDecoration(
                  color: _file != null ? AppTheme.accentCyan.withOpacity(0.08) : Colors.white,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(
                      color: _file != null ? AppTheme.accentCyan : const Color(0xFFB0BEC5),
                      style: BorderStyle.solid),
                ),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      _file != null ? Icons.check_circle_outline : Icons.upload_file_outlined,
                      color: _file != null ? AppTheme.accentCyan : AppTheme.textSecondary,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      _fileName ?? 'Attach Report File (optional)',
                      style: TextStyle(
                        color: _file != null ? AppTheme.accentCyan : AppTheme.textSecondary,
                        fontSize: 13,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                    if (_file != null)
                      GestureDetector(
                        onTap: () => setState(() { _file = null; _fileName = null; }),
                        child: const Padding(
                          padding: EdgeInsets.only(top: 2),
                          child: Text('Clear', style: TextStyle(color: AppTheme.errorRed, fontSize: 11)),
                        ),
                      ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 24),
            ElevatedButton.icon(
              onPressed: _submitting ? null : _submit,
              icon: _submitting
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                          color: Colors.white, strokeWidth: 2))
                  : const Icon(Icons.upload, color: Colors.white),
              label:
                  Text(_submitting ? 'Uploading...' : 'Upload Investigation'),
              style: ElevatedButton.styleFrom(
                  backgroundColor: AppTheme.accentCyan),
            ),
          ],
        ),
      ),
    );
  }
}

class _PendingTab extends StatefulWidget {
  const _PendingTab();

  @override
  State<_PendingTab> createState() => _PendingTabState();
}

class _PendingTabState extends State<_PendingTab> {
  List<dynamic> _pending = [];
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
      // Try doctor-specific first, fall back to all pending
      final staffId = await ApiConfig.getStaffId();
      Map<String, dynamic> data;
      if (staffId != null) {
        try {
          data = await StaffApiService.getDoctorInvestigations(staffId);
        } catch (e) {
          data = await StaffApiService.getPendingInvestigations();
        }
      } else {
        data = await StaffApiService.getPendingInvestigations();
      }
      final list = data['investigations'] as List? ??
          data['records'] as List? ??
          data['data'] as List? ??
          [];
      if (mounted) setState(() => _pending = list);
    } catch (e) {
      if (mounted) {
        setState(
            () => _error = e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _updateStatus(String id, String status) async {
    try {
      await StaffApiService.updateInvestigationStatus(id, status);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('✅ Investigation marked as $status'),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        _load();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(e.toString().replaceFirst('Exception: ', '')),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.error_outline,
                color: AppTheme.errorRed, size: 40),
            const SizedBox(height: 8),
            Text(_error!,
                style: const TextStyle(color: AppTheme.textSecondary)),
            TextButton(onPressed: _load, child: const Text('Retry')),
          ],
        ),
      );
    }
    if (_pending.isEmpty) {
      return const Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.check_circle_outline,
                size: 56, color: AppTheme.successGreen),
            SizedBox(height: 16),
            Text('No pending investigations',
                style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.bold,
                    color: AppTheme.textPrimary)),
            SizedBox(height: 8),
            Text('All caught up!',
                style: TextStyle(color: AppTheme.textSecondary)),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _pending.length,
        itemBuilder: (_, i) {
          final inv = _pending[i] as Map<String, dynamic>;
          final id = inv['_id']?.toString() ?? inv['id']?.toString() ?? '';
          final testType =
              inv['test_type']?.toString() ?? inv['testType']?.toString() ?? 'Unknown';
          final patientName = inv['patient_name']?.toString() ??
              inv['patient']?['name']?.toString() ??
              inv['phone']?.toString() ??
              'Unknown';
          final date = inv['created_at']?.toString() ??
              inv['date']?.toString() ??
              '';
          final status = inv['status']?.toString() ?? 'pending';

          return Card(
            margin: const EdgeInsets.only(bottom: 10),
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      CircleAvatar(
                        backgroundColor:
                            AppTheme.warningAmber.withOpacity(0.15),
                        child: const Icon(Icons.science_outlined,
                            color: AppTheme.warningAmber, size: 20),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(testType,
                                style: const TextStyle(
                                    fontWeight: FontWeight.bold,
                                    color: AppTheme.textPrimary)),
                            Text(patientName,
                                style: const TextStyle(
                                    fontSize: 12,
                                    color: AppTheme.textSecondary)),
                          ],
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 8, vertical: 4),
                        decoration: BoxDecoration(
                          color: AppTheme.warningAmber.withOpacity(0.1),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Text(status.toUpperCase(),
                            style: const TextStyle(
                                fontSize: 10,
                                color: AppTheme.warningAmber,
                                fontWeight: FontWeight.bold)),
                      ),
                    ],
                  ),
                  if (date.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Text(date,
                        style: const TextStyle(
                            fontSize: 11, color: AppTheme.textSecondary)),
                  ],
                  const SizedBox(height: 10),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      TextButton(
                        onPressed: () =>
                            _updateStatus(id, 'in_progress'),
                        child: const Text('Start'),
                      ),
                      const SizedBox(width: 8),
                      ElevatedButton(
                        onPressed: () =>
                            _updateStatus(id, 'completed'),
                        style: ElevatedButton.styleFrom(
                            backgroundColor: AppTheme.successGreen),
                        child: const Text('Complete',
                            style: TextStyle(color: Colors.white)),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

class _RecentUploadsTab extends StatefulWidget {
  const _RecentUploadsTab();

  @override
  State<_RecentUploadsTab> createState() => _RecentUploadsTabState();
}

class _RecentUploadsTabState extends State<_RecentUploadsTab> {
  List<dynamic> _investigations = [];
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
      final data = await StaffApiService.listInvestigations();
      final list = data['investigations'] as List? ??
          data['records'] as List? ??
          data['data'] as List? ??
          [];
      if (mounted) setState(() => _investigations = list);
    } catch (e) {
      if (mounted) {
        setState(
            () => _error = e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.error_outline,
                color: AppTheme.errorRed, size: 40),
            const SizedBox(height: 8),
            Text(_error!,
                style: const TextStyle(color: AppTheme.textSecondary)),
            TextButton(onPressed: _load, child: const Text('Retry')),
          ],
        ),
      );
    }
    if (_investigations.isEmpty) {
      return const Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.science_outlined,
                size: 56, color: AppTheme.textSecondary),
            SizedBox(height: 16),
            Text('No recent investigations',
                style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.bold,
                    color: AppTheme.textPrimary)),
            SizedBox(height: 8),
            Text('Your investigation uploads will appear here',
                style: TextStyle(color: AppTheme.textSecondary)),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _investigations.length,
        itemBuilder: (_, i) {
          final inv = _investigations[i] as Map<String, dynamic>;
          final testType =
              inv['test_type']?.toString() ?? inv['testType']?.toString() ?? 'Unknown';
          final patientName = inv['patient_name']?.toString() ??
              inv['patient']?['name']?.toString() ??
              inv['phone']?.toString() ??
              'Unknown';
          final date = inv['created_at']?.toString() ??
              inv['date']?.toString() ??
              '';
          final status = inv['status']?.toString().toLowerCase() ?? '';

          Color statusColor = switch (status) {
            'completed' => AppTheme.successGreen,
            'in_progress' => AppTheme.primaryBlue,
            'pending' => AppTheme.warningAmber,
            _ => AppTheme.textSecondary,
          };

          return Card(
            margin: const EdgeInsets.only(bottom: 10),
            child: ListTile(
              leading: CircleAvatar(
                backgroundColor: AppTheme.accentCyan.withOpacity(0.1),
                child: const Icon(Icons.biotech,
                    color: AppTheme.accentCyan, size: 20),
              ),
              title: Text(testType),
              subtitle: Text('$patientName${date.isNotEmpty ? ' • $date' : ''}',
                  style: const TextStyle(fontSize: 12)),
              trailing: status.isNotEmpty
                  ? Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 8, vertical: 4),
                      decoration: BoxDecoration(
                        color: statusColor.withOpacity(0.1),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(status.toUpperCase(),
                          style: TextStyle(
                              fontSize: 10,
                              color: statusColor,
                              fontWeight: FontWeight.bold)),
                    )
                  : const Icon(Icons.chevron_right),
            ),
          );
        },
      ),
    );
  }
}
