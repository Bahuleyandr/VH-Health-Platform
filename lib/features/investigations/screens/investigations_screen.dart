import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
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
    _tabController = TabController(length: 2, vsync: this);
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
                Tab(text: 'Recent Uploads'),
              ],
            ),
          ),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: const [
                _UploadTab(),
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
        result: _resultCtrl.text.trim().isEmpty ? null : _resultCtrl.text.trim(),
        notes: _notesCtrl.text.trim().isEmpty ? null : _notesCtrl.text.trim(),
        date: DateFormat('yyyy-MM-dd').format(DateTime.now()),
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('✅ Investigation result uploaded successfully'),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        _formKey.currentState!.reset();
        setState(() => _testType = null);
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
                  .map((t) =>
                      DropdownMenuItem(value: t, child: Text(t)))
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

            // File upload placeholder
            GestureDetector(
              onTap: () {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(
                      content: Text(
                          'File picker integration requires file_picker package')),
                );
              },
              child: Container(
                height: 80,
                width: double.infinity,
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(
                      color: const Color(0xFFB0BEC5), style: BorderStyle.solid),
                ),
                child: const Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(Icons.upload_file_outlined,
                        color: AppTheme.textSecondary),
                    SizedBox(height: 4),
                    Text('Attach Report File (optional)',
                        style: TextStyle(
                            color: AppTheme.textSecondary, fontSize: 13)),
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

class _RecentUploadsTab extends StatefulWidget {
  const _RecentUploadsTab();

  @override
  State<_RecentUploadsTab> createState() => _RecentUploadsTabState();
}

class _RecentUploadsTabState extends State<_RecentUploadsTab> {
  // In a real implementation, you'd fetch recent uploads from the backend.
  // For now, show an informational empty state.
  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.science_outlined, size: 56, color: AppTheme.textSecondary),
          SizedBox(height: 16),
          Text(
            'Recent Uploads',
            style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.bold,
                color: AppTheme.textPrimary),
          ),
          SizedBox(height: 8),
          Padding(
            padding: EdgeInsets.symmetric(horizontal: 40),
            child: Text(
              'Your recent investigation uploads will appear here.',
              textAlign: TextAlign.center,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ),
        ],
      ),
    );
  }
}
