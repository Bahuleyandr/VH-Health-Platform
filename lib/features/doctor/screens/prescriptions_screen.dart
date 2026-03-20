import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../../core/services/staff_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';

/// Prescriptions screen — Doctors write and view prescriptions.
class PrescriptionsScreen extends StatefulWidget {
  const PrescriptionsScreen({super.key});

  @override
  State<PrescriptionsScreen> createState() => _PrescriptionsScreenState();
}

class _PrescriptionsScreenState extends State<PrescriptionsScreen>
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
      title: 'Prescriptions',
      body: Column(
        children: [
          Container(
            color: Colors.white,
            child: TabBar(
              controller: _tabController,
              labelColor: const Color(0xFF00838F),
              unselectedLabelColor: AppTheme.textSecondary,
              indicatorColor: const Color(0xFF00838F),
              tabs: const [
                Tab(text: 'New Prescription'),
                Tab(text: 'Recent'),
              ],
            ),
          ),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: const [
                _NewPrescriptionTab(),
                _RecentPrescriptionsTab(),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Medication {
  String name;
  String dosage;
  String frequency;
  String duration;
  String instructions;

  _Medication({
    this.name = '',
    this.dosage = '',
    this.frequency = '',
    this.duration = '',
    this.instructions = '',
  });
}

class _NewPrescriptionTab extends StatefulWidget {
  const _NewPrescriptionTab();

  @override
  State<_NewPrescriptionTab> createState() => _NewPrescriptionTabState();
}

class _NewPrescriptionTabState extends State<_NewPrescriptionTab> {
  final _formKey = GlobalKey<FormState>();
  final _phoneCtrl = TextEditingController();
  final _diagnosisCtrl = TextEditingController();
  final _notesCtrl = TextEditingController();
  final List<_Medication> _medications = [_Medication()];
  bool _submitting = false;

  static const _frequencies = [
    'Once daily',
    'Twice daily',
    'Three times daily',
    'Four times daily',
    'Every 6 hours',
    'Every 8 hours',
    'Every 12 hours',
    'As needed',
    'Before meals',
    'After meals',
    'At bedtime',
  ];

  static const _durations = [
    '3 days',
    '5 days',
    '7 days',
    '10 days',
    '14 days',
    '1 month',
    '2 months',
    '3 months',
    '6 months',
    'Ongoing',
  ];

  @override
  void dispose() {
    _phoneCtrl.dispose();
    _diagnosisCtrl.dispose();
    _notesCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    // Validate medications
    if (_medications.any((m) => m.name.trim().isEmpty)) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Please fill in all medication names'),
          backgroundColor: AppTheme.errorRed,
        ),
      );
      return;
    }

    setState(() => _submitting = true);
    try {
      // Using the consultation endpoint as a proxy for prescriptions.
      // TODO: Replace with dedicated POST /staff/prescriptions endpoint.
      await StaffApiService.uploadConsultation(
        phone: _phoneCtrl.text.trim(),
        consultationType: 'Prescription',
        notes: _diagnosisCtrl.text.trim(),
        date: DateFormat('yyyy-MM-dd').format(DateTime.now()),
        additionalData: {
          'medications': _medications
              .map((m) => {
                    'name': m.name,
                    'dosage': m.dosage,
                    'frequency': m.frequency,
                    'duration': m.duration,
                    'instructions': m.instructions,
                  })
              .toList(),
          'additionalNotes': _notesCtrl.text.trim(),
        },
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('✅ Prescription saved successfully'),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        _formKey.currentState!.reset();
        setState(() {
          _medications.clear();
          _medications.add(_Medication());
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
            // Patient phone
            TextFormField(
              controller: _phoneCtrl,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(
                labelText: 'Patient Phone Number',
                hintText: '+91 XXXXX XXXXX',
                prefixIcon: Icon(Icons.phone_outlined),
              ),
              validator: (v) {
                if (v == null || v.trim().isEmpty)
                  return 'Phone is required';
                if (v.trim().length < 10)
                  return 'Enter valid phone number';
                return null;
              },
            ),
            const SizedBox(height: 14),

            // Diagnosis
            TextFormField(
              controller: _diagnosisCtrl,
              decoration: const InputDecoration(
                labelText: 'Diagnosis / Chief Complaint',
                hintText: 'e.g. Hypertension, Type 2 Diabetes...',
                prefixIcon: Icon(Icons.local_hospital_outlined),
                alignLabelWithHint: true,
              ),
              maxLines: 2,
              validator: (v) => (v == null || v.trim().isEmpty)
                  ? 'Diagnosis is required'
                  : null,
            ),
            const SizedBox(height: 20),

            // Medications
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text(
                  'Medications',
                  style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.bold,
                      color: AppTheme.textPrimary),
                ),
                TextButton.icon(
                  onPressed: () =>
                      setState(() => _medications.add(_Medication())),
                  icon: const Icon(Icons.add, size: 18),
                  label: const Text('Add'),
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
                durations: _durations,
                onRemove: _medications.length > 1
                    ? () => setState(() => _medications.removeAt(i))
                    : null,
                onChanged: () => setState(() {}),
              );
            }),

            const SizedBox(height: 14),

            // Additional notes
            TextFormField(
              controller: _notesCtrl,
              decoration: const InputDecoration(
                labelText: 'Additional Notes / Advice',
                hintText: 'Rest, diet, follow-up instructions...',
                prefixIcon: Icon(Icons.notes_outlined),
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
                          color: Colors.white, strokeWidth: 2))
                  : const Icon(Icons.save, color: Colors.white),
              label: Text(_submitting ? 'Saving...' : 'Save Prescription'),
              style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF00838F)),
            ),
          ],
        ),
      ),
    );
  }
}

class _MedicationCard extends StatelessWidget {
  final int index;
  final _Medication medication;
  final List<String> frequencies;
  final List<String> durations;
  final VoidCallback? onRemove;
  final VoidCallback onChanged;

  const _MedicationCard({
    required this.index,
    required this.medication,
    required this.frequencies,
    required this.durations,
    this.onRemove,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFF00838F).withOpacity(0.3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                'Medication ${index + 1}',
                style: const TextStyle(
                    fontWeight: FontWeight.bold,
                    color: Color(0xFF00838F),
                    fontSize: 13),
              ),
              if (onRemove != null)
                IconButton(
                  icon: const Icon(Icons.remove_circle_outline,
                      color: AppTheme.errorRed, size: 20),
                  onPressed: onRemove,
                  visualDensity: VisualDensity.compact,
                ),
            ],
          ),
          const SizedBox(height: 8),
          TextFormField(
            initialValue: medication.name,
            decoration: const InputDecoration(
              labelText: 'Medicine Name',
              hintText: 'e.g. Metformin',
              isDense: true,
            ),
            onChanged: (v) {
              medication.name = v;
              onChanged();
            },
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: TextFormField(
                  initialValue: medication.dosage,
                  decoration: const InputDecoration(
                    labelText: 'Dosage',
                    hintText: 'e.g. 500mg',
                    isDense: true,
                  ),
                  onChanged: (v) {
                    medication.dosage = v;
                    onChanged();
                  },
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: DropdownButtonFormField<String>(
                  value: medication.frequency.isEmpty
                      ? null
                      : medication.frequency,
                  decoration: const InputDecoration(
                    labelText: 'Frequency',
                    isDense: true,
                  ),
                  items: frequencies
                      .map((f) =>
                          DropdownMenuItem(value: f, child: Text(f, style: const TextStyle(fontSize: 12))))
                      .toList(),
                  onChanged: (v) {
                    medication.frequency = v ?? '';
                    onChanged();
                  },
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: DropdownButtonFormField<String>(
                  value: medication.duration.isEmpty
                      ? null
                      : medication.duration,
                  decoration: const InputDecoration(
                    labelText: 'Duration',
                    isDense: true,
                  ),
                  items: durations
                      .map((d) =>
                          DropdownMenuItem(value: d, child: Text(d, style: const TextStyle(fontSize: 12))))
                      .toList(),
                  onChanged: (v) {
                    medication.duration = v ?? '';
                    onChanged();
                  },
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: TextFormField(
                  initialValue: medication.instructions,
                  decoration: const InputDecoration(
                    labelText: 'Instructions',
                    hintText: 'After meals',
                    isDense: true,
                  ),
                  onChanged: (v) {
                    medication.instructions = v;
                    onChanged();
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

class _RecentPrescriptionsTab extends StatefulWidget {
  const _RecentPrescriptionsTab();

  @override
  State<_RecentPrescriptionsTab> createState() =>
      _RecentPrescriptionsTabState();
}

class _RecentPrescriptionsTabState extends State<_RecentPrescriptionsTab> {
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
      // TODO: Fetch from /staff/prescriptions when endpoint is available.
      // Using consultations as proxy.
      final data = await StaffApiService.getAppointments(
        status: 'completed',
        limit: 30,
      );
      final list = data['appointments'] as List? ?? data['data'] as List? ?? [];
      if (mounted) setState(() => _prescriptions = list);
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
    if (_prescriptions.isEmpty) {
      return const Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.medication_liquid_outlined,
                size: 56, color: AppTheme.textSecondary),
            SizedBox(height: 16),
            Text(
              'No recent prescriptions',
              style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.bold,
                  color: AppTheme.textPrimary),
            ),
            SizedBox(height: 8),
            Text(
              'Saved prescriptions will appear here',
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ],
        ),
      );
    }
    return ListView.builder(
      padding: const EdgeInsets.all(12),
      itemCount: _prescriptions.length,
      itemBuilder: (_, i) {
        final p = _prescriptions[i];
        return Card(
          margin: const EdgeInsets.only(bottom: 10),
          child: ListTile(
            leading: const CircleAvatar(
              backgroundColor: Color(0xFF00838F),
              child: Icon(Icons.medication_liquid,
                  color: Colors.white, size: 20),
            ),
            title: Text(p['patientName'] ?? p['patient']?['name'] ?? 'Unknown'),
            subtitle: Text(p['dateTime'] ?? p['date'] ?? ''),
            trailing: const Icon(Icons.chevron_right),
          ),
        );
      },
    );
  }
}
