import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../../core/services/schedule_api_service.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';

@visibleForTesting
const queueInProgressFilterStatus = 'IN_PROGRESS';

@visibleForTesting
const queueInProgressUpdateStatus = 'IN_PROGRESS';

typedef QueueAppointmentsLoader = Future<Map<String, dynamic>> Function({
  required String date,
  required String status,
  required int limit,
});

String? _queueText(dynamic value) {
  final text = value?.toString().trim() ?? '';
  return text.isEmpty ? null : text;
}

@visibleForTesting
String queuePatientName(Map<String, dynamic> appointment, String fallback) =>
    _queueText(appointment['patient_name']) ??
    _queueText(appointment['patientName']) ??
    _queueText(appointment['patient']?['name']) ??
    fallback;

@visibleForTesting
String queuePatientPhone(Map<String, dynamic> appointment) =>
    _queueText(appointment['patient_phone']) ??
    _queueText(appointment['phone']) ??
    _queueText(appointment['patientPhone']) ??
    _queueText(appointment['patient']?['phone']) ??
    '';

@visibleForTesting
String queueAppointmentType(Map<String, dynamic> appointment) =>
    _queueText(appointment['visit_type']) ??
    _queueText(appointment['type']) ??
    _queueText(appointment['appointmentType']) ??
    '';

@visibleForTesting
DateTime? queueAppointmentDateTime(Map<String, dynamic> appointment) {
  final canonicalDate = _queueText(appointment['appointment_date']);
  final canonicalTime = _queueText(appointment['appointment_time']);
  if (canonicalDate != null && canonicalTime != null) {
    final date = canonicalDate.length >= 10
        ? canonicalDate.substring(0, 10)
        : canonicalDate;
    final parsed = DateTime.tryParse('${date}T$canonicalTime');
    if (parsed != null) return parsed;
  }
  final legacy =
      _queueText(appointment['dateTime']) ?? _queueText(appointment['date']);
  return legacy == null ? null : DateTime.tryParse(legacy);
}

class QueueScreen extends StatefulWidget {
  const QueueScreen({
    super.key,
    this.loadAppointments,
    this.autoRefresh = true,
  });

  final QueueAppointmentsLoader? loadAppointments;
  final bool autoRefresh;

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
  int _loadGeneration = 0;
  bool _hasLoadedQueue = false;
  bool _isStale = false;

  @override
  void initState() {
    super.initState();
    _load();
    if (widget.autoRefresh) {
      _refreshTimer = Timer.periodic(
        const Duration(seconds: 30),
        (_) => _load(),
      );
    }
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
    final generation = ++_loadGeneration;
    try {
      final today = DateFormat('yyyy-MM-dd').format(DateTime.now());

      Future<Map<String, dynamic>> loadStatus(String status) {
        final loader = widget.loadAppointments;
        if (loader != null) {
          return loader(date: today, status: status, limit: 50);
        }
        return ScheduleApiService.getAppointments(
          date: today,
          status: status,
          limit: 50,
        );
      }

      // Fetch all relevant statuses
      final results = await Future.wait([
        loadStatus('scheduled'),
        loadStatus('confirmed'),
        loadStatus(queueInProgressFilterStatus),
        loadStatus('completed'),
      ]);
      if (!mounted || generation != _loadGeneration) return;
      final [scheduled, confirmed, inProgress, completed] = results;

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
        final aTime = queueAppointmentDateTime(a);
        final bTime = queueAppointmentDateTime(b);
        if (aTime == null) return bTime == null ? 0 : 1;
        if (bTime == null) return -1;
        return aTime.compareTo(bTime);
      });

      final inProgressList = extractList(inProgress);
      final completedList = extractList(completed);
      completedList.sort((a, b) {
        final aTime = queueAppointmentDateTime(a);
        final bTime = queueAppointmentDateTime(b);
        if (aTime == null) return bTime == null ? 0 : 1;
        if (bTime == null) return -1;
        return bTime.compareTo(aTime); // most recent first
      });

      if (mounted) {
        setState(() {
          _waiting = waitingList;
          _current = inProgressList.isNotEmpty ? inProgressList.first : null;
          _completed = completedList;
          _hasLoadedQueue = true;
          _isStale = false;
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
      if (mounted && generation == _loadGeneration) {
        setState(() {
          if (!_hasLoadedQueue) {
            _error = e.toString().replaceFirst('Exception: ', '');
          } else {
            _isStale = true;
          }
          _loading = false;
        });
      }
    }
  }

  Future<void> _callNext() async {
    if (_isStale || _waiting.isEmpty) return;
    final next = _waiting.first;
    final id = next['_id']?.toString() ?? next['id']?.toString() ?? '';
    if (id.isEmpty) return;

    try {
      await ScheduleApiService.updateAppointmentStatus(
        id,
        queueInProgressUpdateStatus,
      );
      setState(() => _consultationStart = DateTime.now());
      unawaited(_load());
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
    if (_isStale || _current == null) return;
    final id =
        _current!['_id']?.toString() ?? _current!['id']?.toString() ?? '';
    if (id.isEmpty) return;

    try {
      await ScheduleApiService.updateAppointmentStatus(id, 'completed');
      setState(() {
        _consultationStart = null;
        _elapsed = Duration.zero;
      });
      unawaited(_load());
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
    final phone = queuePatientPhone(appointment);
    final patientName = queuePatientName(
      appointment,
      AppStrings.of(context).queueUnknownPatient,
    );

    unawaited(
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

  String _waitTime(Map<String, dynamic> appt, BuildContext context) {
    final parsed = queueAppointmentDateTime(appt);
    if (parsed == null) return '';
    final s = AppStrings.of(context);
    final diff = DateTime.now().difference(parsed);
    if (diff.isNegative) {
      return '${s.queueInPrefix} ${_formatDuration(-diff)}';
    }
    return '${s.queueWaitingPrefix} ${_formatDuration(diff)}';
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return StaffScaffold(
      title: s.queueTitle,
      actions: [
        IconButton(
          icon: const Icon(Icons.refresh),
          tooltip: s.queueRefreshTooltip,
          onPressed: _load,
        ),
      ],
      body: _loading
          ? const Center(child: CircularProgressIndicator())
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
                  TextButton(onPressed: _load, child: Text(s.actionRetry)),
                ],
              ),
            )
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  if (_isStale) ...[
                    Card(
                      key: const Key('queue-stale-data-banner'),
                      color: AppTheme.warningAmber.withValues(alpha: 0.12),
                      child: Padding(
                        padding: const EdgeInsets.all(12),
                        child: Row(
                          children: [
                            const Icon(Icons.cloud_off),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                s.lookup('s4.lib.realtime_status.stale'),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),
                  ],
                  // Current consultation
                  if (_current != null) ...[
                    _SectionHeader(
                      s.queueSectionInConsultation,
                      AppTheme.primaryBlue,
                    ),
                    _CurrentConsultationCard(
                      appointment: _current!,
                      elapsed: _elapsed,
                      formatDuration: _formatDuration,
                      onComplete: _isStale ? null : _completeCurrent,
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
                          onPressed: _isStale ? null : _callNext,
                          icon: const Icon(Icons.campaign, color: Colors.white),
                          label: Text(
                            s.queueCallNextPatient,
                            style: const TextStyle(fontSize: 16),
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
                    s.queueSectionWaiting(_waiting.length),
                    AppTheme.warningAmber,
                  ),
                  if (_waiting.isEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 24),
                      child: Center(
                        child: Text(
                          s.queueNoPatientsWaiting,
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
                        waitTime: _waitTime(appt, context),
                        onTap: () => _showPatientDetails(appt),
                        trailing: _current == null && i == 0
                            ? IconButton(
                                icon: const Icon(
                                  Icons.play_arrow,
                                  color: AppTheme.primaryBlue,
                                ),
                                onPressed: _isStale ? null : _callNext,
                                tooltip: s.queueCallTooltip,
                              )
                            : null,
                      );
                    }),

                  const SizedBox(height: 16),

                  // Completed
                  _SectionHeader(
                    s.queueSectionCompleted(_completed.length),
                    AppTheme.successGreen,
                  ),
                  if (_completed.isEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 24),
                      child: Center(
                        child: Text(
                          s.queueNoCompletedConsultations,
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
  final VoidCallback? onComplete;
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
    final name = queuePatientName(
      appointment,
      AppStrings.of(context).queueUnknownPatient,
    );
    final type = queueAppointmentType(appointment);

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
                  label: Text(AppStrings.of(context).queueCompleteConsultation),
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
    final name = queuePatientName(
      appointment,
      AppStrings.of(context).queueUnknownPatient,
    );
    final type = queueAppointmentType(appointment);
    final dateTime = queueAppointmentDateTime(appointment);

    final displayTime = dateTime == null
        ? (_queueText(appointment['appointment_time']) ?? '')
        : DateFormat('hh:mm a').format(dateTime);

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
      // Set loading false; defer string lookup to build via _error sentinel.
      setState(() {
        _loading = false;
        _error = '__no_phone__';
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
                    tooltip: AppStrings.of(context).actionClose,
                    onPressed: () => Navigator.pop(context),
                  ),
                ],
              ),
            ),
            const Divider(height: 1),
            // Content
            Expanded(
              child: _loading
                  ? const Center(child: CircularProgressIndicator())
                  : _error != null
                  ? Center(
                      child: Text(
                        _error == '__no_phone__'
                            ? AppStrings.of(context).queueNoPhoneNumber
                            : _error!,
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
    final s = AppStrings.of(context);
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
            Text(
              s.queuePatientInfo,
              style: const TextStyle(
                fontWeight: FontWeight.bold,
                fontSize: 14,
                color: AppTheme.primaryBlue,
              ),
            ),
            const SizedBox(height: 8),
            if (age.isNotEmpty || gender.isNotEmpty)
              Text(
                '${gender.isNotEmpty ? gender : ''} ${age.isNotEmpty ? '${s.queueAgePrefix} $age' : ''}'
                    .trim(),
                style: TextStyle(fontSize: 13, color: AppTheme.textSecondary),
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
                      s.queueAllergiesPrefix(allergies.toString()),
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
    final s = AppStrings.of(context);
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        _ActionChip(
          Icons.medication,
          s.queueWritePrescription,
          AppTheme.primaryTeal,
          () {
            final router = GoRouter.of(context);
            Navigator.pop(context);
            router.push('/prescriptions', extra: widget.appointment);
          },
        ),
        _ActionChip(
          Icons.biotech,
          s.queueOrderInvestigation,
          AppTheme.accentCyan,
          () {
            Navigator.pop(context);
          },
        ),
        _ActionChip(Icons.note_add, s.queueAddNotes, AppTheme.warningAmber, () {
          Navigator.pop(context);
        }),
      ],
    );
  }

  Widget _buildRecentRecords() {
    final s = AppStrings.of(context);
    final records =
        _records!['records'] as List? ??
        _records!['healthRecords'] as List? ??
        [];

    if (records.isEmpty) {
      return Center(
        child: Text(
          s.queueNoHealthRecordsFound,
          style: TextStyle(color: AppTheme.textSecondary),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          s.queueRecentRecords,
          style: const TextStyle(
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
              s.queueRecordFallback;
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
