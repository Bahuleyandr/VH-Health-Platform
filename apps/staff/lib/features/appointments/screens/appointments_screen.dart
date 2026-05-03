import 'dart:async';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import '../../../core/services/schedule_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/states/empty_state.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';
import '../../../l10n/app_strings.dart';
import '../../../core/widgets/states/success_toast.dart';

class AppointmentsScreen extends StatefulWidget {
  const AppointmentsScreen({super.key});

  @override
  State<AppointmentsScreen> createState() => _AppointmentsScreenState();
}

class _AppointmentsScreenState extends State<AppointmentsScreen> {
  List<dynamic> _appointments = [];
  bool _loading = true;
  String? _error;
  String _selectedStatus = 'all';
  String _searchQuery = '';

  List<dynamic> get _filtered {
    final q = _searchQuery.trim().toLowerCase();
    if (q.isEmpty) return _appointments;
    return _appointments.where((a) {
      final name =
          (a['patientName']?.toString() ??
                  a['patient']?['name']?.toString() ??
                  a['patient_name']?.toString() ??
                  '')
              .toLowerCase();
      return name.contains(q);
    }).toList();
  }

  static const _statuses = [
    'all',
    'scheduled',
    'confirmed',
    'completed',
    'cancelled',
  ];

  StreamSubscription<RealtimeEvent>? _appointmentsSub;
  Timer? _refreshDebounce;

  @override
  void initState() {
    super.initState();
    _load();
    _attachRealtime();
  }

  Future<void> _attachRealtime() async {
    final rt = RealtimeClient.instance;
    await rt.connect();
    // Backend `appointmentStatusController.broadcast('staff:appointments', …)`
    // fires whenever any appointment status changes. Debounce so a burst
    // of status flips (queue marshalling) doesn't refetch N times.
    _appointmentsSub = rt.events('staff:appointments').listen((_) {
      _refreshDebounce?.cancel();
      _refreshDebounce = Timer(const Duration(milliseconds: 400), () {
        if (mounted) _load();
      });
    });
  }

  @override
  void dispose() {
    _appointmentsSub?.cancel();
    _refreshDebounce?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final today = DateFormat('yyyy-MM-dd').format(DateTime.now());
      final data = await ScheduleApiService.getAppointments(
        date: today,
        status: _selectedStatus == 'all' ? null : _selectedStatus,
      );
      final list = data['appointments'] as List? ?? data['data'] as List? ?? [];
      if (mounted) setState(() => _appointments = list);
    } catch (e) {
      if (mounted) {
        setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _updateStatus(String id, String status) async {
    try {
      await ScheduleApiService.updateAppointmentStatus(id, status);
      if (!mounted) return;
      SuccessToast.show(context, 'Appointment $status successfully');
      _load();
    } catch (e) {
      if (!mounted) return;
      ErrorToast.show(context, e.toString().replaceFirst('Exception: ', ''));
    }
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'Appointments',
      body: Column(
        children: [
          // Filter chips
          Container(
            color: Colors.white,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: _statuses.map((s) {
                  final selected = s == _selectedStatus;
                  return Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: FilterChip(
                      label: Text(s.toUpperCase()),
                      selected: selected,
                      onSelected: (_) {
                        setState(() => _selectedStatus = s);
                        _load();
                      },
                      selectedColor: AppTheme.primaryBlue.withValues(
                        alpha: 0.15,
                      ),
                      checkmarkColor: AppTheme.primaryBlue,
                      labelStyle: TextStyle(
                        color: selected
                            ? AppTheme.primaryBlue
                            : AppTheme.textSecondary,
                        fontSize: 11,
                        fontWeight: selected
                            ? FontWeight.bold
                            : FontWeight.normal,
                      ),
                    ),
                  );
                }).toList(),
              ),
            ),
          ),

          Padding(
            padding: const EdgeInsets.all(16),
            child: TextField(
              decoration: InputDecoration(
                hintText: 'Search by patient name…',
                prefixIcon: const ExcludeSemantics(child: Icon(Icons.search)),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
                filled: true,
                fillColor: Colors.white,
              ),
              onChanged: (v) => setState(() => _searchQuery = v),
            ),
          ),

          Expanded(
            child: RefreshIndicator(
              onRefresh: _load,
              child: _loading
                  ? const SkeletonList()
                  : _error != null
                  ? ErrorState(
                      message: _error!.replaceFirst('Exception: ', ''),
                      onRetry: _load,
                    )
                  : _filtered.isEmpty
                  ? (_searchQuery.trim().isNotEmpty
                        ? Center(
                            child: Text(
                              AppStrings.of(context).noMatchesFor(_searchQuery),
                              style: TextStyle(color: AppTheme.textSecondary),
                            ),
                          )
                        : EmptyState(
                            icon: Icons.event_available_outlined,
                            title: AppStrings.of(context).appointmentsNoToday,
                            body: 'New appointments will show up here.',
                          ))
                  : ListView.builder(
                      padding: const EdgeInsets.all(16),
                      itemCount: _filtered.length,
                      itemBuilder: (ctx, i) => _AppointmentCard(
                        appointment: _filtered[i],
                        onConfirm: (id) => _updateStatus(id, 'confirmed'),
                        onCancel: (id) => _updateStatus(id, 'cancelled'),
                      ),
                    ),
            ),
          ),
        ],
      ),
    );
  }
}

class _AppointmentCard extends StatelessWidget {
  final dynamic appointment;
  final Function(String) onConfirm;
  final Function(String) onCancel;

  const _AppointmentCard({
    required this.appointment,
    required this.onConfirm,
    required this.onCancel,
  });

  @override
  Widget build(BuildContext context) {
    final id =
        appointment['_id']?.toString() ?? appointment['id']?.toString() ?? '';
    final patientName =
        appointment['patientName']?.toString() ??
        appointment['patient']?['name']?.toString() ??
        'Unknown Patient';
    final type =
        appointment['type']?.toString() ??
        appointment['appointmentType']?.toString() ??
        '—';
    final dateTime =
        appointment['dateTime']?.toString() ??
        appointment['date']?.toString() ??
        '';
    final status = appointment['status']?.toString() ?? 'scheduled';
    final doctor =
        appointment['doctorName']?.toString() ??
        appointment['doctor']?.toString() ??
        '';
    final department = appointment['department']?.toString() ?? '';

    final statusColor = switch (status.toLowerCase()) {
      'confirmed' => AppTheme.successGreen,
      'cancelled' => AppTheme.errorRed,
      'completed' => AppTheme.primaryTeal,
      _ => AppTheme.warningAmber,
    };

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    patientName,
                    style: TextStyle(
                      fontWeight: FontWeight.bold,
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
                    color: statusColor.withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text(
                    status.toUpperCase(),
                    style: TextStyle(
                      color: statusColor,
                      fontSize: 11,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            _InfoRow(Icons.local_hospital_outlined, type),
            if (department.isNotEmpty) _InfoRow(Icons.business, department),
            if (doctor.isNotEmpty)
              _InfoRow(Icons.person_outlined, 'Dr. $doctor'),
            if (dateTime.isNotEmpty)
              _InfoRow(Icons.schedule_outlined, dateTime),

            if (status.toLowerCase() == 'scheduled') ...[
              const SizedBox(height: 10),
              const Divider(height: 1),
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: id.isEmpty ? null : () => onCancel(id),
                      icon: const Icon(Icons.close, size: 16),
                      label: const Text('Cancel'),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: AppTheme.errorRed,
                        side: const BorderSide(color: AppTheme.errorRed),
                        minimumSize: const Size(0, 36),
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: ElevatedButton.icon(
                      onPressed: id.isEmpty ? null : () => onConfirm(id),
                      icon: const Icon(
                        Icons.check,
                        size: 16,
                        color: Colors.white,
                      ),
                      label: const Text('Confirm'),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppTheme.successGreen,
                        minimumSize: const Size(0, 36),
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
}

class _InfoRow extends StatelessWidget {
  final IconData icon;
  final String text;
  const _InfoRow(this.icon, this.text);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Row(
        children: [
          Icon(icon, size: 14, color: AppTheme.textSecondary),
          SizedBox(width: 6),
          Expanded(
            child: Text(
              text,
              style: TextStyle(fontSize: 13, color: AppTheme.textSecondary),
            ),
          ),
        ],
      ),
    );
  }
}
