import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../../core/services/theatre_api_service.dart';
import '../../../core/theme/app_theme.dart';

class TheatreScreen extends StatefulWidget {
  const TheatreScreen({super.key});

  @override
  State<TheatreScreen> createState() => _TheatreScreenState();
}

class _TheatreScreenState extends State<TheatreScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;
  DateTime _selectedDate = DateTime.now();
  bool _loading = true;
  String? _error;
  List<dynamic> _schedule = [];
  List<dynamic> _availability = [];

  String get _dateStr => DateFormat('yyyy-MM-dd').format(_selectedDate);

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _tabController.addListener(() {
      if (!_tabController.indexIsChanging) {
        _loadCurrentTab();
      }
    });
    _loadCurrentTab();
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _loadCurrentTab() async {
    if (_tabController.index == 0) {
      await _fetchSchedule();
    } else {
      await _fetchAvailability();
    }
  }

  Future<void> _fetchSchedule() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final data = await TheatreApiService.getTodaySchedule(date: _dateStr);
      if (mounted) {
        setState(() {
          _schedule = data;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _loading = false;
        });
      }
    }
  }

  Future<void> _fetchAvailability() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final data = await TheatreApiService.getAvailability(_dateStr);
      if (mounted) {
        setState(() {
          _availability = data;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _loading = false;
        });
      }
    }
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _selectedDate,
      firstDate: DateTime.now().subtract(const Duration(days: 90)),
      lastDate: DateTime.now().add(const Duration(days: 90)),
    );
    if (picked != null && picked != _selectedDate) {
      _selectedDate = picked;
      _loadCurrentTab();
    }
  }

  Color _statusColor(String? status) {
    return switch (status?.toLowerCase()) {
      'scheduled' => AppTheme.primaryBlue,
      'in_progress' => AppTheme.warningAmber,
      'completed' => AppTheme.successGreen,
      'cancelled' => Colors.grey,
      _ => Colors.grey,
    };
  }

  String _statusLabel(String? status) {
    return switch (status?.toLowerCase()) {
      'scheduled' => 'Scheduled',
      'in_progress' => 'In Progress',
      'completed' => 'Completed',
      'cancelled' => 'Cancelled',
      _ => status ?? 'Unknown',
    };
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        title: const Text('Operating Theatre'),
        actions: [
          IconButton(
            icon: const Icon(Icons.calendar_today),
            onPressed: _pickDate,
            tooltip: 'Pick date',
          ),
        ],
        bottom: TabBar(
          controller: _tabController,
          indicatorColor: Colors.white,
          labelColor: Colors.white,
          unselectedLabelColor: Colors.white70,
          tabs: const [
            Tab(text: 'Schedule'),
            Tab(text: 'Availability'),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: [_buildScheduleTab(), _buildAvailabilityTab()],
      ),
    );
  }

  Widget _buildScheduleTab() {
    if (_error != null) return _buildError(_fetchSchedule);
    if (_loading) return const Center(child: CircularProgressIndicator());

    return RefreshIndicator(
      onRefresh: _fetchSchedule,
      child: _schedule.isEmpty
          ? ListView(
              children: const [
                SizedBox(height: 120),
                Center(
                  child: Column(
                    children: [
                      Icon(Icons.event_busy, size: 64, color: Colors.grey),
                      SizedBox(height: 12),
                      Text(
                        'No surgeries scheduled',
                        style: TextStyle(color: Colors.grey, fontSize: 16),
                      ),
                    ],
                  ),
                ),
              ],
            )
          : ListView.builder(
              padding: const EdgeInsets.all(16),
              itemCount: _schedule.length,
              itemBuilder: (context, i) {
                final s = _schedule[i] as Map<String, dynamic>;
                return _buildSurgeryCard(s);
              },
            ),
    );
  }

  Widget _buildSurgeryCard(Map<String, dynamic> s) {
    final status = s['status']?.toString();
    final patientUid = s['patient_uid']?.toString() ?? '';
    final displayUid = patientUid.length > 8
        ? '${patientUid.substring(0, 8)}...'
        : patientUid;

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () => _showDetailSheet(s),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      s['procedure_name']?.toString() ?? 'Procedure',
                      style: const TextStyle(
                        fontWeight: FontWeight.w600,
                        fontSize: 15,
                        color: AppTheme.textPrimary,
                      ),
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 4,
                    ),
                    decoration: BoxDecoration(
                      color: _statusColor(status).withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: Text(
                      _statusLabel(status),
                      style: TextStyle(
                        color: _statusColor(status),
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  _infoChip(Icons.person, displayUid),
                  const SizedBox(width: 12),
                  _infoChip(
                    Icons.meeting_room,
                    'OT ${s['ot_room']?.toString() ?? '-'}',
                  ),
                  const SizedBox(width: 12),
                  _infoChip(
                    Icons.access_time,
                    s['scheduled_time']?.toString() ?? '-',
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                'Surgeon: ${s['surgeon']?.toString() ?? '-'}',
                style: const TextStyle(
                  fontSize: 13,
                  color: AppTheme.textSecondary,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _infoChip(IconData icon, String text) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 14, color: AppTheme.textSecondary),
        const SizedBox(width: 4),
        Text(
          text,
          style: const TextStyle(fontSize: 12, color: AppTheme.textSecondary),
        ),
      ],
    );
  }

  void _showDetailSheet(Map<String, dynamic> s) {
    final status = s['status']?.toString().toLowerCase();
    final id = s['id'] as int?;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        return DraggableScrollableSheet(
          expand: false,
          initialChildSize: 0.55,
          maxChildSize: 0.85,
          builder: (_, scrollController) {
            return SingleChildScrollView(
              controller: scrollController,
              padding: const EdgeInsets.all(24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
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
                  const SizedBox(height: 20),
                  Text(
                    s['procedure_name']?.toString() ?? 'Procedure',
                    style: const TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.bold,
                      color: AppTheme.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 16),
                  _detailRow(
                    'Patient UID',
                    s['patient_uid']?.toString() ?? '-',
                  ),
                  _detailRow(
                    'Procedure Code',
                    s['procedure_code']?.toString() ?? '-',
                  ),
                  _detailRow('OT Room', s['ot_room']?.toString() ?? '-'),
                  _detailRow('Date', s['scheduled_date']?.toString() ?? '-'),
                  _detailRow('Time', s['scheduled_time']?.toString() ?? '-'),
                  _detailRow(
                    'Duration',
                    '${s['estimated_duration'] ?? '-'} min',
                  ),
                  _detailRow('Surgeon', s['surgeon']?.toString() ?? '-'),
                  _detailRow(
                    'Anesthetist',
                    s['anesthetist']?.toString() ?? '-',
                  ),
                  _detailRow('Status', _statusLabel(status)),
                  _detailRow(
                    'Blood Arranged',
                    s['blood_arranged'] == true ? 'Yes' : 'No',
                  ),
                  _detailRow(
                    'Consent',
                    s['consent_obtained'] == true ? 'Yes' : 'No',
                  ),
                  if (s['equipment_needed'] != null)
                    _detailRow('Equipment', s['equipment_needed'].toString()),
                  const SizedBox(height: 24),
                  if (id != null) ...[
                    if (status == 'scheduled')
                      SizedBox(
                        width: double.infinity,
                        child: ElevatedButton.icon(
                          onPressed: () =>
                              _updateStatus(ctx, id, 'in_progress'),
                          icon: const Icon(Icons.play_arrow),
                          label: const Text('Start Surgery'),
                        ),
                      ),
                    if (status == 'in_progress') ...[
                      SizedBox(
                        width: double.infinity,
                        child: ElevatedButton.icon(
                          onPressed: () => _updateStatus(ctx, id, 'completed'),
                          icon: const Icon(Icons.check_circle),
                          label: const Text('Mark Complete'),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: AppTheme.successGreen,
                          ),
                        ),
                      ),
                    ],
                    if (status != 'completed' && status != 'cancelled') ...[
                      const SizedBox(height: 10),
                      SizedBox(
                        width: double.infinity,
                        child: OutlinedButton.icon(
                          onPressed: () => _updateStatus(ctx, id, 'cancelled'),
                          icon: const Icon(Icons.cancel),
                          label: const Text('Cancel'),
                          style: OutlinedButton.styleFrom(
                            foregroundColor: AppTheme.errorRed,
                            side: const BorderSide(color: AppTheme.errorRed),
                          ),
                        ),
                      ),
                    ],
                    const SizedBox(height: 10),
                    SizedBox(
                      width: double.infinity,
                      child: OutlinedButton.icon(
                        onPressed: () {
                          Navigator.pop(ctx);
                          _showChecklistSheet(id, s);
                        },
                        icon: const Icon(Icons.checklist),
                        label: const Text('Pre-op Checklist'),
                      ),
                    ),
                  ],
                ],
              ),
            );
          },
        );
      },
    );
  }

  Widget _detailRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 130,
            child: Text(
              label,
              style: const TextStyle(
                color: AppTheme.textSecondary,
                fontSize: 13,
              ),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: const TextStyle(fontWeight: FontWeight.w500, fontSize: 13),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _updateStatus(
    BuildContext sheetCtx,
    int id,
    String status,
  ) async {
    Navigator.pop(sheetCtx);
    try {
      await TheatreApiService.updateStatus(id, status);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Status updated to ${_statusLabel(status)}')),
        );
      }
      _fetchSchedule();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed to update: $e'),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    }
  }

  void _showChecklistSheet(int id, Map<String, dynamic> surgery) {
    final existing = surgery['checklist'] as Map<String, dynamic>? ?? {};
    bool consentObtained = existing['consent_obtained'] == true;
    bool bloodArranged = existing['blood_arranged'] == true;
    bool equipmentChecked = existing['equipment_checked'] == true;
    bool patientIdentified = existing['patient_identified'] == true;

    showModalBottomSheet(
      context: context,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        return StatefulBuilder(
          builder: (_, setSheetState) {
            return Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
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
                  const Text(
                    'Pre-op Checklist',
                    style: TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                      color: AppTheme.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 12),
                  SwitchListTile(
                    title: const Text('Consent Obtained'),
                    value: consentObtained,
                    onChanged: (v) => setSheetState(() => consentObtained = v),
                  ),
                  SwitchListTile(
                    title: const Text('Blood Arranged'),
                    value: bloodArranged,
                    onChanged: (v) => setSheetState(() => bloodArranged = v),
                  ),
                  SwitchListTile(
                    title: const Text('Equipment Checked'),
                    value: equipmentChecked,
                    onChanged: (v) => setSheetState(() => equipmentChecked = v),
                  ),
                  SwitchListTile(
                    title: const Text('Patient Identified'),
                    value: patientIdentified,
                    onChanged: (v) =>
                        setSheetState(() => patientIdentified = v),
                  ),
                  const SizedBox(height: 16),
                  SizedBox(
                    width: double.infinity,
                    child: ElevatedButton(
                      onPressed: () async {
                        Navigator.pop(ctx);
                        try {
                          await TheatreApiService.updateChecklist(id, {
                            'consent_obtained': consentObtained,
                            'blood_arranged': bloodArranged,
                            'equipment_checked': equipmentChecked,
                            'patient_identified': patientIdentified,
                          });
                          if (mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              const SnackBar(
                                content: Text('Checklist updated'),
                              ),
                            );
                          }
                          _fetchSchedule();
                        } catch (e) {
                          if (mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              SnackBar(
                                content: Text('Failed to update: $e'),
                                backgroundColor: AppTheme.errorRed,
                              ),
                            );
                          }
                        }
                      },
                      child: const Text('Submit Checklist'),
                    ),
                  ),
                ],
              ),
            );
          },
        );
      },
    );
  }

  Widget _buildAvailabilityTab() {
    if (_error != null) return _buildError(_fetchAvailability);
    if (_loading) return const Center(child: CircularProgressIndicator());

    return RefreshIndicator(
      onRefresh: _fetchAvailability,
      child: _availability.isEmpty
          ? ListView(
              children: const [
                SizedBox(height: 120),
                Center(
                  child: Column(
                    children: [
                      Icon(Icons.meeting_room, size: 64, color: Colors.grey),
                      SizedBox(height: 12),
                      Text(
                        'No room data available',
                        style: TextStyle(color: Colors.grey, fontSize: 16),
                      ),
                    ],
                  ),
                ),
              ],
            )
          : GridView.builder(
              padding: const EdgeInsets.all(16),
              gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: 2,
                mainAxisSpacing: 12,
                crossAxisSpacing: 12,
                childAspectRatio: 1.4,
              ),
              itemCount: _availability.length,
              itemBuilder: (context, i) {
                final room = _availability[i] as Map<String, dynamic>;
                final available =
                    room['available'] == true ||
                    room['status']?.toString().toLowerCase() == 'available';
                final name =
                    room['name']?.toString() ?? 'OT ${room['id'] ?? i + 1}';

                return Card(
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(
                          Icons.meeting_room,
                          size: 32,
                          color: available
                              ? AppTheme.successGreen
                              : AppTheme.errorRed,
                        ),
                        const SizedBox(height: 8),
                        Text(
                          name,
                          style: const TextStyle(
                            fontWeight: FontWeight.w600,
                            fontSize: 14,
                            color: AppTheme.textPrimary,
                          ),
                          textAlign: TextAlign.center,
                        ),
                        const SizedBox(height: 4),
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 10,
                            vertical: 3,
                          ),
                          decoration: BoxDecoration(
                            color:
                                (available
                                        ? AppTheme.successGreen
                                        : AppTheme.errorRed)
                                    .withValues(alpha: 0.12),
                            borderRadius: BorderRadius.circular(20),
                          ),
                          child: Text(
                            available ? 'Available' : 'Occupied',
                            style: TextStyle(
                              color: available
                                  ? AppTheme.successGreen
                                  : AppTheme.errorRed,
                              fontSize: 12,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                );
              },
            ),
    );
  }

  Widget _buildError(VoidCallback retry) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.error_outline, size: 48, color: AppTheme.errorRed),
            const SizedBox(height: 16),
            Text(
              _error ?? 'Something went wrong',
              textAlign: TextAlign.center,
              style: const TextStyle(color: AppTheme.textSecondary),
            ),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: retry,
              icon: const Icon(Icons.refresh),
              label: const Text('Retry'),
            ),
          ],
        ),
      ),
    );
  }
}
