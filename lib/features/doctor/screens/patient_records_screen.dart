import 'package:flutter/material.dart';
import '../../../core/services/staff_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';

/// Patient Records screen — Doctors/Nurses/Admin view patient records.
class PatientRecordsScreen extends StatefulWidget {
  const PatientRecordsScreen({super.key});

  @override
  State<PatientRecordsScreen> createState() => _PatientRecordsScreenState();
}

class _PatientRecordsScreenState extends State<PatientRecordsScreen> {
  List<dynamic> _appointments = [];
  bool _loading = true;
  String? _error;
  final _searchCtrl = TextEditingController();
  String _searchQuery = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await StaffApiService.getMedicalRecords(limit: 50);
      final list = data['records'] as List? ?? data['data'] as List? ?? [];
      if (mounted) setState(() => _appointments = list);
    } catch (e) {
      if (mounted) {
        setState(
            () => _error = e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _searchByPhone(String phone) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await StaffApiService.getHealthRecordsByPhone(phone);
      final list = data['records'] as List? ?? data['data'] as List? ?? [];
      if (mounted) setState(() => _appointments = list);
    } catch (e) {
      if (mounted) {
        setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  List<dynamic> get _filtered {
    if (_searchQuery.isEmpty) return _appointments;
    final q = _searchQuery.toLowerCase();
    return _appointments.where((a) {
      final name = (a['patientName'] ?? a['patient']?['name'] ?? a['title'] ?? '')
          .toString()
          .toLowerCase();
      final type = (a['record_type'] ?? a['type'] ?? a['appointmentType'] ?? '')
          .toString()
          .toLowerCase();
      return name.contains(q) || type.contains(q);
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'Patient Records',
      body: Column(
        children: [
          // Search
          Container(
            color: Colors.white,
            padding: const EdgeInsets.all(12),
            child: TextField(
              controller: _searchCtrl,
              decoration: InputDecoration(
                hintText: 'Search by patient name or type...',
                prefixIcon: const Icon(Icons.search),
                suffixIcon: _searchQuery.isNotEmpty
                    ? IconButton(
                        icon: const Icon(Icons.clear),
                        onPressed: () {
                          _searchCtrl.clear();
                          setState(() => _searchQuery = '');
                        },
                      )
                    : null,
                filled: true,
                fillColor: AppTheme.backgroundGrey,
              ),
              onChanged: (v) => setState(() => _searchQuery = v),
              onSubmitted: (v) {
                final digits = v.replaceAll(RegExp(r'\D'), '');
                if (digits.length == 10) _searchByPhone(digits);
              },
            ),
          ),

          Expanded(
            child: RefreshIndicator(
              onRefresh: _load,
              child: _loading
                  ? const Center(child: CircularProgressIndicator())
                  : _error != null
                      ? _ErrorState(error: _error!, onRetry: _load)
                      : _filtered.isEmpty
                          ? _EmptyState(hasSearch: _searchQuery.isNotEmpty)
                          : ListView.builder(
                              padding: const EdgeInsets.all(12),
                              itemCount: _filtered.length,
                              itemBuilder: (ctx, i) =>
                                  _PatientCard(record: _filtered[i]),
                            ),
            ),
          ),
        ],
      ),
    );
  }
}

class _PatientCard extends StatelessWidget {
  final dynamic record;
  const _PatientCard({required this.record});

  @override
  Widget build(BuildContext context) {
    final patientName = record['title']?.toString() ??
        record['patientName']?.toString() ??
        record['patient']?['name']?.toString() ??
        'Unknown Patient';
    final type = record['record_type']?.toString() ??
        record['type']?.toString() ??
        record['appointmentType']?.toString() ??
        '—';
    final department = record['department']?.toString() ?? '';
    final dateTime = record['created_at']?.toString() ??
        record['dateTime']?.toString() ??
        record['date']?.toString() ??
        '';
    final status =
        record['status']?.toString().toLowerCase() ?? 'active';
    final doctor = record['doctorName']?.toString() ??
        record['doctor']?.toString() ??
        '';

    Color statusColor = switch (status) {
      'confirmed' => AppTheme.successGreen,
      'completed' => AppTheme.primaryTeal,
      'cancelled' => AppTheme.errorRed,
      _ => AppTheme.warningAmber,
    };

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () => _showDetails(context),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  CircleAvatar(
                    backgroundColor: AppTheme.primaryBlue.withOpacity(0.1),
                    child: Text(
                      patientName.isNotEmpty
                          ? patientName[0].toUpperCase()
                          : '?',
                      style: const TextStyle(
                          color: AppTheme.primaryBlue,
                          fontWeight: FontWeight.bold),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          patientName,
                          style: const TextStyle(
                              fontWeight: FontWeight.bold,
                              color: AppTheme.textPrimary,
                              fontSize: 15),
                        ),
                        Text(
                          type,
                          style: const TextStyle(
                              fontSize: 12, color: AppTheme.textSecondary),
                        ),
                      ],
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: statusColor.withOpacity(0.1),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(
                      status.toUpperCase(),
                      style: TextStyle(
                          fontSize: 10,
                          color: statusColor,
                          fontWeight: FontWeight.bold),
                    ),
                  ),
                ],
              ),
              if (department.isNotEmpty || doctor.isNotEmpty ||
                  dateTime.isNotEmpty) ...[
                const SizedBox(height: 8),
                const Divider(height: 1),
                const SizedBox(height: 8),
                if (department.isNotEmpty)
                  _InfoRow(Icons.business_outlined, department),
                if (doctor.isNotEmpty)
                  _InfoRow(Icons.person_outlined, 'Dr. $doctor'),
                if (dateTime.isNotEmpty)
                  _InfoRow(Icons.schedule_outlined, dateTime),
              ],
            ],
          ),
        ),
      ),
    );
  }

  void _showDetails(BuildContext context) {
    showModalBottomSheet(
      context: context,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => _PatientDetailsSheet(record: record),
    );
  }
}

class _PatientDetailsSheet extends StatelessWidget {
  final dynamic record;
  const _PatientDetailsSheet({required this.record});

  @override
  Widget build(BuildContext context) {
    final patientName = record['patientName']?.toString() ??
        record['patient']?['name']?.toString() ??
        'Unknown Patient';
    final phone = record['patient']?['phone']?.toString() ??
        record['phone']?.toString() ??
        '—';

    return DraggableScrollableSheet(
      initialChildSize: 0.6,
      maxChildSize: 0.9,
      minChildSize: 0.4,
      expand: false,
      builder: (_, ctrl) => ListView(
        controller: ctrl,
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
          const SizedBox(height: 16),
          Text(
            patientName,
            style: const TextStyle(
                fontSize: 20,
                fontWeight: FontWeight.bold,
                color: AppTheme.textPrimary),
          ),
          const SizedBox(height: 4),
          if (phone != '—')
            Text('📱 $phone',
                style:
                    const TextStyle(color: AppTheme.textSecondary)),
          const SizedBox(height: 16),
          const Text(
            'Record Details',
            style: TextStyle(
                fontWeight: FontWeight.bold, color: AppTheme.textPrimary),
          ),
          const SizedBox(height: 8),
          ...record.entries
              .where((e) =>
                  e.key != '_id' &&
                  e.key != 'id' &&
                  e.value != null &&
                  e.value.toString().isNotEmpty)
              .map((e) => Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        SizedBox(
                          width: 120,
                          child: Text(
                            e.key
                                .replaceAllMapped(
                                    RegExp(r'([A-Z])'),
                                    (m) => ' ${m[0]}')
                                .trim()
                                .capitalize(),
                            style: const TextStyle(
                                color: AppTheme.textSecondary,
                                fontSize: 12),
                          ),
                        ),
                        Expanded(
                          child: Text(
                            e.value.toString(),
                            style: const TextStyle(
                                color: AppTheme.textPrimary, fontSize: 12),
                          ),
                        ),
                      ],
                    ),
                  )),
        ],
      ),
    );
  }
}

class _InfoRow extends StatelessWidget {
  final IconData icon;
  final String text;
  const _InfoRow(this.icon, this.text);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 3),
      child: Row(
        children: [
          Icon(icon, size: 14, color: AppTheme.textSecondary),
          const SizedBox(width: 6),
          Expanded(
            child: Text(text,
                style: const TextStyle(
                    fontSize: 12, color: AppTheme.textSecondary)),
          ),
        ],
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  final String error;
  final VoidCallback onRetry;
  const _ErrorState({required this.error, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.error_outline, color: AppTheme.errorRed, size: 40),
          const SizedBox(height: 8),
          Text(error,
              style: const TextStyle(color: AppTheme.textSecondary),
              textAlign: TextAlign.center),
          TextButton(onPressed: onRetry, child: const Text('Retry')),
        ],
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  final bool hasSearch;
  const _EmptyState({required this.hasSearch});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.folder_shared_outlined,
              size: 56, color: AppTheme.textSecondary),
          const SizedBox(height: 16),
          Text(
            hasSearch ? 'No records found' : 'No patient records',
            style: const TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.bold,
                color: AppTheme.textPrimary),
          ),
          const SizedBox(height: 8),
          const Text(
            'Patient records will appear here',
            style: TextStyle(color: AppTheme.textSecondary),
          ),
        ],
      ),
    );
  }
}

extension StringExtension on String {
  String capitalize() =>
      isEmpty ? this : '${this[0].toUpperCase()}${substring(1)}';
}
