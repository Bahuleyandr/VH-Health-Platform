import 'dart:async';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../../core/services/schedule_api_service.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';

class QueueScreen extends StatefulWidget {
  const QueueScreen({super.key});

  @override
  State<QueueScreen> createState() => _QueueScreenState();
}

class _QueueScreenState extends State<QueueScreen> {
  List<Map<String, dynamic>> _waiting = [];
  Map<String, dynamic>? _current; // in-progress appointment
  List<Map<String, dynamic>> _completed = [];
  bool _loading = true;
  String? _error;
  Timer? _refreshTimer;
  Timer? _tickTimer;
  DateTime? _consultationStart;
  Duration _elapsed = Duration.zero;

  @override
  void initState() {
    super.initState();
    _load();
    _refreshTimer = Timer.periodic(const Duration(seconds: 30), (_) => _load());
    _tickTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (_consultationStart != null && mounted) {
        setState(
          () => _elapsed = DateTime.now().difference(_consultationStart!),
        );
      }
    });
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    _tickTimer?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    if (!_loading) setState(() {});
    try {
      final today = DateFormat('yyyy-MM-dd').format(DateTime.now());

      // Fetch all relevant statuses
      final scheduled = await ScheduleApiService.getAppointments(
        date: today,
        status: 'scheduled',
        limit: 50,
      );
      final confirmed = await ScheduleApiService.getAppointments(
        date: today,
        status: 'confirmed',
        limit: 50,
      );
      final inProgress = await ScheduleApiService.getAppointments(
        date: today,
        status: 'in-progress',
        limit: 50,
      );
      final completed = await ScheduleApiService.getAppointments(
        date: today,
        status: 'completed',
        limit: 50,
      );

      List<Map<String, dynamic>> extractList(Map<String, dynamic> data) {
        final raw =
            data['appointments'] as List? ?? data['data'] as List? ?? [];
        return raw.map((e) => Map<String, dynamic>.from(e as Map)).toList();
      }

      final waitingList = [
        ...extractList(scheduled),
        ...extractList(confirmed),
      ];
      // Sort by time
      waitingList.sort((a, b) {
        final aTime = a['dateTime']?.toString() ?? a['date']?.toString() ?? '';
        final bTime = b['dateTime']?.toString() ?? b['date']?.toString() ?? '';
        return aTime.compareTo(bTime);
      });

      final inProgressList = extractList(inProgress);
      final completedList = extractList(completed);
      completedList.sort((a, b) {
        final aTime = a['dateTime']?.toString() ?? a['date']?.toString() ?? '';
        final bTime = b['dateTime']?.toString() ?? b['date']?.toString() ?? '';
        return bTime.compareTo(aTime); // most recent first
      });

      if (mounted) {
        setState(() {
          _waiting = waitingList;
          _current = inProgressList.isNotEmpty ? inProgressList.first : null;
          _completed = completedList;
          _loading = false;
          _error = null;
          // If there's an in-progress appointment and we don't have a start time, start now
          if (_current != null && _consultationStart == null) {
            _consultationStart = DateTime.now();
            _elapsed = Duration.zero;
          } else if (_current == null) {
            _consultationStart = null;
            _elapsed = Duration.zero;
          }
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString().replaceFirst('Exception: ', '');
          _loading = false;
        });
      }
    }
  }

  Future<void> _callNext() async {
    if (_waiting.isEmpty) return;
    final next = _waiting.first;
    final id = next['_id']?.toString() ?? next['id']?.toString() ?? '';
    if (id.isEmpty) return;

    try {
      await ScheduleApiService.updateAppointmentStatus(id, 'in-progress');
      setState(() => _consultationStart = DateTime.now());
      _load();
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

  Future<void> _completeCurrent() async {
    if (_current == null) return;
    final id =
        _current!['_id']?.toString() ?? _current!['id']?.toString() ?? '';
    if (id.isEmpty) return;

    try {
      await ScheduleApiService.updateAppointmentStatus(id, 'completed');
      setState(() {
        _consultationStart = null;
        _elapsed = Duration.zero;
      });
      _load();
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

  void _showPatientDetails(Map<String, dynamic> appointment) async {
    final phone =
        appointment['patientPhone']?.toString() ??
        appointment['patient']?['phone']?.toString() ??
        '';
    final patientName =
        appointment['patientName']?.toString() ??
        appointment['patient']?['name']?.toString() ??
        'Unknown';

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) => _PatientDetailsSheet(
        phone: phone,
        patientName: patientName,
        appointment: appointment,
      ),
    );
  }

  String _formatDuration(Duration d) {
    final h = d.inHours;
    final m = d.inMinutes.remainder(60);
    final s = d.inSeconds.remainder(60);
    if (h > 0) return '${h}h ${m}m ${s}s';
    if (m > 0) return '${m}m ${s}s';
    return '${s}s';
  }

  String _waitTime(Map<String, dynamic> appt) {
    final dt = appt['dateTime']?.toString() ?? appt['date']?.toString();
    if (dt == null) return '';
    try {
      final parsed = DateTime.parse(dt);
      final diff = DateTime.now().difference(parsed);
      if (diff.isNegative) return 'In ${_formatDuration(-diff)}';
      return 'Waiting ${_formatDuration(diff)}';
    } catch (e) {
      return '';
    }
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'Patient Queue',
      actions: [IconButton(icon: const Icon(Icons.refresh), onPressed: _load)],
      body: _loading
          ? Center(child: CircularProgressIndicator())
          : _error != null
          ? Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(
                    Icons.error_outline,
                    color: AppTheme.errorRed,
                    size: 40,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _error!,
                    style: TextStyle(color: AppTheme.textSecondary),
                  ),
                  TextButton(onPressed: _load, child: const Text('Retry')),
                ],
              ),
            )
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  // Current consultation
                  if (_current != null) ...[
                    const _SectionHeader(
                      'In Consultation',
                      AppTheme.primaryBlue,
                    ),
                    _CurrentConsultationCard(
                      appointment: _current!,
                      elapsed: _elapsed,
                      formatDuration: _formatDuration,
                      onComplete: _completeCurrent,
                      onTap: () => _showPatientDetails(_current!),
                    ),
                    const SizedBox(height: 16),
                  ],

                  // Call next button
                  if (_current == null && _waiting.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 16),
                      child: SizedBox(
                        width: double.infinity,
                        height: 48,
                        child: ElevatedButton.icon(
                          onPressed: _callNext,
                          icon: const Icon(Icons.campaign, color: Colors.white),
                          label: const Text(
                            'Call Next Patient',
                            style: TextStyle(fontSize: 16),
                          ),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: AppTheme.primaryBlue,
                            foregroundColor: Colors.white,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(12),
                            ),
                          ),
                        ),
                      ),
                    ),

                  // Waiting list
                  _SectionHeader(
                    'Waiting (${_waiting.length})',
                    AppTheme.warningAmber,
                  ),
                  if (_waiting.isEmpty)
                    Padding(
                      padding: EdgeInsets.symmetric(vertical: 24),
                      child: Center(
                        child: Text(
                          'No patients waiting',
                          style: TextStyle(color: AppTheme.textSecondary),
                        ),
                      ),
                    )
                  else
                    ..._waiting.asMap().entries.map((entry) {
                      final i = entry.key;
                      final appt = entry.value;
                      return _QueueCard(
                        position: i + 1,
                        appointment: appt,
                        waitTime: _waitTime(appt),
                        onTap: () => _showPatientDetails(appt),
                        trailing: _current == null && i == 0
                            ? IconButton(
                                icon: const Icon(
                                  Icons.play_arrow,
                                  color: AppTheme.primaryBlue,
                                ),
                                onPressed: _callNext,
                                tooltip: 'Call',
                              )
                            : null,
                      );
                    }),

                  const SizedBox(height: 16),

                  // Completed
                  _SectionHeader(
                    'Completed (${_completed.length})',
                    AppTheme.successGreen,
                  ),
                  if (_completed.isEmpty)
                    Padding(
                      padding: EdgeInsets.symmetric(vertical: 24),
                      child: Center(
                        child: Text(
                          'No completed consultations',
                          style: TextStyle(color: AppTheme.textSecondary),
                        ),
                      ),
                    )
                  else
                    ..._completed
                        .take(10)
                        .map(
                          (appt) => _QueueCard(
                            appointment: appt,
                            onTap: () => _showPatientDetails(appt),
                            completed: true,
                          ),
                        ),
                ],
              ),
            ),
    );
  }
}

// ─── Widgets ─────────────────────────────────────────────────────────────────

class _SectionHeader extends StatelessWidget {
  final String title;
  final Color color;
  const _SectionHeader(this.title, this.color);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        children: [
          Container(
            width: 4,
            height: 20,
            decoration: BoxDecoration(
              color: color,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          const SizedBox(width: 8),
          Text(
            title,
            style: TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.bold,
              color: color,
            ),
          ),
        ],
      ),
    );
  }
}

class _CurrentConsultationCard extends StatelessWidget {
  final Map<String, dynamic> appointment;
  final Duration elapsed;
  final String Function(Duration) formatDuration;
  final VoidCallback onComplete;
  final VoidCallback onTap;

  const _CurrentConsultationCard({
    required this.appointment,
    required this.elapsed,
    required this.formatDuration,
    required this.onComplete,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    // ignore: unused_local_variable
    final name =
        appointment['patientName']?.toString() ??
        appointment['patient']?['name']?.toString() ??
        'Unknown';
    final type =
        appointment['type']?.toString() ??
        appointment['appointmentType']?.toString() ??
        '';

    return Card(
      color: AppTheme.primaryBlue.withValues(alpha: 0.05),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: AppTheme.primaryBlue.withValues(alpha: 0.3)),
      ),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const CircleAvatar(
                    backgroundColor: AppTheme.primaryBlue,
                    child: Icon(Icons.person, color: Colors.white),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          name,
                          style: TextStyle(
                            fontWeight: FontWeight.bold,
                            fontSize: 16,
                            color: AppTheme.textPrimary,
                          ),
                        ),
                        if (type.isNotEmpty)
                          Text(
                            type,
                            style: TextStyle(
                              fontSize: 13,
                              color: AppTheme.textSecondary,
                            ),
                          ),
                      ],
                    ),
                  ),
                  // Timer
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 6,
                    ),
                    decoration: BoxDecoration(
                      color: AppTheme.primaryBlue,
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(Icons.timer, color: Colors.white, size: 16),
                        const SizedBox(width: 4),
                        Text(
                          formatDuration(elapsed),
                          style: const TextStyle(
                            color: Colors.white,
                            fontWeight: FontWeight.bold,
                            fontSize: 13,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton.icon(
                  onPressed: onComplete,
                  icon: const Icon(
                    Icons.check_circle,
                    color: Colors.white,
                    size: 18,
                  ),
                  label: const Text('Complete Consultation'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppTheme.successGreen,
                    foregroundColor: Colors.white,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(8),
                    ),
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

class _QueueCard extends StatelessWidget {
  final int? position;
  final Map<String, dynamic> appointment;
  final String? waitTime;
  final VoidCallback? onTap;
  final Widget? trailing;
  final bool completed;

  const _QueueCard({
    this.position,
    required this.appointment,
    this.waitTime,
    this.onTap,
    this.trailing,
    this.completed = false,
  });

  @override
  Widget build(BuildContext context) {
    final name =
        appointment['patientName']?.toString() ??
        appointment['patient']?['name']?.toString() ??
        'Unknown';
    final type =
        appointment['type']?.toString() ??
        appointment['appointmentType']?.toString() ??
        '';
    final time =
        appointment['dateTime']?.toString() ??
        appointment['date']?.toString() ??
        '';

    String displayTime = '';
    try {
      if (time.isNotEmpty) {
        final dt = DateTime.parse(time);
        displayTime = DateFormat('hh:mm a').format(dt);
      }
    } catch (e) {
      displayTime = time;
    }

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          child: Row(
            children: [
              if (position != null)
                Container(
                  width: 32,
                  height: 32,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: completed
                        ? AppTheme.successGreen.withValues(alpha: 0.1)
                        : AppTheme.warningAmber.withValues(alpha: 0.1),
                    shape: BoxShape.circle,
                  ),
                  child: Text(
                    '$position',
                    style: TextStyle(
                      fontWeight: FontWeight.bold,
                      color: completed
                          ? AppTheme.successGreen
                          : AppTheme.warningAmber,
                    ),
                  ),
                )
              else if (completed)
                const Icon(
                  Icons.check_circle,
                  color: AppTheme.successGreen,
                  size: 28,
                ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      name,
                      style: TextStyle(
                        fontWeight: FontWeight.w600,
                        fontSize: 14,
                        color: AppTheme.textPrimary,
                      ),
                    ),
                    Row(
                      children: [
                        if (displayTime.isNotEmpty) ...[
                          Text(
                            displayTime,
                            style: TextStyle(
                              fontSize: 12,
                              color: AppTheme.textSecondary,
                            ),
                          ),
                          if (type.isNotEmpty)
                            Text(
                              ' · ',
                              style: TextStyle(color: AppTheme.textSecondary),
                            ),
                        ],
                        if (type.isNotEmpty)
                          Text(
                            type,
                            style: TextStyle(
                              fontSize: 12,
                              color: AppTheme.textSecondary,
                            ),
                          ),
                      ],
                    ),
                  ],
                ),
              ),
              if (waitTime != null && waitTime!.isNotEmpty)
                Text(
                  waitTime!,
                  style: TextStyle(
                    fontSize: 11,
                    color: completed
                        ? AppTheme.successGreen
                        : AppTheme.warningAmber,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ?trailing,
              if (!completed && trailing == null)
                Icon(
                  Icons.chevron_right,
                  color: AppTheme.textSecondary,
                  size: 20,
                ),
            ],
          ),
        ),
      ),
    );
  }
}

// ─── Patient Details Bottom Sheet ────────────────────────────────────────────

class _PatientDetailsSheet extends StatefulWidget {
  final String phone;
  final String patientName;
  final Map<String, dynamic> appointment;

  const _PatientDetailsSheet({
    required this.phone,
    required this.patientName,
    required this.appointment,
  });

  @override
  State<_PatientDetailsSheet> createState() => _PatientDetailsSheetState();
}

class _PatientDetailsSheetState extends State<_PatientDetailsSheet> {
  bool _loading = true;
  String? _error;
  Map<String, dynamic>? _records;

  @override
  void initState() {
    super.initState();
    if (widget.phone.isNotEmpty) {
      _fetchRecords();
    } else {
      setState(() {
        _loading = false;
        _error = 'No phone number available';
      });
    }
  }

  Future<void> _fetchRecords() async {
    try {
      final data = await MedicalApiService.getHealthRecords(widget.phone);
      if (mounted) {
        setState(() {
          _records = data;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString().replaceFirst('Exception: ', '');
          _loading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return DraggableScrollableSheet(
      initialChildSize: 0.7,
      minChildSize: 0.4,
      maxChildSize: 0.95,
      expand: false,
      builder: (ctx, scrollController) => Container(
        decoration: const BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
        ),
        child: Column(
          children: [
            // Handle
            Container(
              margin: const EdgeInsets.only(top: 8),
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                color: Colors.grey[300],
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            // Header
            Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  const CircleAvatar(
                    backgroundColor: AppTheme.primaryBlue,
                    child: Icon(Icons.person, color: Colors.white),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          widget.patientName,
                          style: const TextStyle(
                            fontWeight: FontWeight.bold,
                            fontSize: 18,
                          ),
                        ),
                        if (widget.phone.isNotEmpty)
                          Text(
                            widget.phone,
                            style: TextStyle(
                              color: AppTheme.textSecondary,
                              fontSize: 13,
                            ),
                          ),
                      ],
                    ),
                  ),
                  IconButton(
                    icon: const Icon(Icons.close),
                    onPressed: () => Navigator.pop(context),
                  ),
                ],
              ),
            ),
            const Divider(height: 1),
            // Content
            Expanded(
              child: _loading
                  ? Center(child: CircularProgressIndicator())
                  : _error != null
                  ? Center(
                      child: Text(
                        _error!,
                        style: TextStyle(color: AppTheme.textSecondary),
                      ),
                    )
                  : ListView(
                      controller: scrollController,
                      padding: const EdgeInsets.all(16),
                      children: [
                        // Patient info from records
                        if (_records != null) ...[
                          _buildInfoSection(),
                          const SizedBox(height: 16),
                        ],
                        // Quick actions
                        _buildQuickActions(),
                        const SizedBox(height: 16),
                        // Recent records
                        if (_records != null) _buildRecentRecords(),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildInfoSection() {
    final patient = _records!['patient'] as Map<String, dynamic>? ?? _records!;
    // ignore: unused_local_variable
    final name = patient['name']?.toString() ?? widget.patientName;
    final age = patient['age']?.toString() ?? '';
    final gender = patient['gender']?.toString() ?? '';
    final allergies = patient['allergies'];

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Patient Info',
              style: TextStyle(
                fontWeight: FontWeight.bold,
                fontSize: 14,
                color: AppTheme.primaryBlue,
              ),
            ),
            const SizedBox(height: 8),
            if (age.isNotEmpty || gender.isNotEmpty)
              Text(
                '${gender.isNotEmpty ? gender : ''} ${age.isNotEmpty ? '• Age: $age' : ''}'
                    .trim(),
                style: TextStyle(
                  fontSize: 13,
                  color: AppTheme.textSecondary,
                ),
              ),
            if (allergies != null && allergies.toString().isNotEmpty) ...[
              const SizedBox(height: 6),
              Row(
                children: [
                  const Icon(
                    Icons.warning_amber,
                    color: AppTheme.errorRed,
                    size: 16,
                  ),
                  const SizedBox(width: 4),
                  Expanded(
                    child: Text(
                      'Allergies: $allergies',
                      style: const TextStyle(
                        color: AppTheme.errorRed,
                        fontSize: 13,
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildQuickActions() {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        _ActionChip(
          Icons.medication,
          'Write Prescription',
          AppTheme.primaryTeal,
          () {
            Navigator.pop(context);
            // Navigate to prescriptions - could pass patient info
          },
        ),
        _ActionChip(
          Icons.biotech,
          'Order Investigation',
          AppTheme.accentCyan,
          () {
            Navigator.pop(context);
          },
        ),
        _ActionChip(Icons.note_add, 'Add Notes', AppTheme.warningAmber, () {
          Navigator.pop(context);
        }),
      ],
    );
  }

  Widget _buildRecentRecords() {
    final records =
        _records!['records'] as List? ??
        _records!['healthRecords'] as List? ??
        [];

    if (records.isEmpty) {
      return Center(
        child: Text(
          'No health records found',
          style: TextStyle(color: AppTheme.textSecondary),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'Recent Records',
          style: TextStyle(
            fontWeight: FontWeight.bold,
            fontSize: 14,
            color: AppTheme.primaryBlue,
          ),
        ),
        const SizedBox(height: 8),
        ...records.take(5).map((r) {
          final record = r as Map<String, dynamic>;
          final type =
              record['type']?.toString() ??
              record['recordType']?.toString() ??
              'Record';
          final date =
              record['date']?.toString() ??
              record['createdAt']?.toString() ??
              '';
          final notes =
              record['notes']?.toString() ??
              record['description']?.toString() ??
              '';
          return Card(
            margin: const EdgeInsets.only(bottom: 6),
            child: ListTile(
              dense: true,
              leading: const Icon(
                Icons.description,
                color: AppTheme.primaryBlue,
                size: 20,
              ),
              title: Text(
                type,
                style: const TextStyle(
                  fontWeight: FontWeight.w500,
                  fontSize: 13,
                ),
              ),
              subtitle: Text(
                notes.isNotEmpty ? notes : date,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12),
              ),
              trailing: date.isNotEmpty
                  ? Text(
                      date.length > 10 ? date.substring(0, 10) : date,
                      style: TextStyle(
                        fontSize: 11,
                        color: AppTheme.textSecondary,
                      ),
                    )
                  : null,
            ),
          );
        }),
      ],
    );
  }
}

class _ActionChip extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;
  final VoidCallback onTap;
  const _ActionChip(this.icon, this.label, this.color, this.onTap);

  @override
  Widget build(BuildContext context) {
    return ActionChip(
      avatar: Icon(icon, color: color, size: 18),
      label: Text(label, style: TextStyle(color: color, fontSize: 13)),
      onPressed: onTap,
      backgroundColor: color.withValues(alpha: 0.08),
      side: BorderSide(color: color.withValues(alpha: 0.2)),
    );
  }
}
