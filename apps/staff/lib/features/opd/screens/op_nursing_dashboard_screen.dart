import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../../core/services/schedule_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';
import '../../../l10n/app_strings.dart';
import '../../appointments/models/staff_appointment.dart';

class OpNursingDashboardScreen extends StatefulWidget {
  const OpNursingDashboardScreen({super.key});

  @override
  State<OpNursingDashboardScreen> createState() =>
      _OpNursingDashboardScreenState();
}

class _OpNursingDashboardScreenState extends State<OpNursingDashboardScreen> {
  final _searchCtrl = TextEditingController();
  final _searchFocus = FocusNode();
  final _scrollCtrl = ScrollController();

  DateTime _selectedDate = _dateOnly(DateTime.now());
  String _statusFilter = 'active';
  String _query = '';
  bool _loading = true;
  String? _error;
  List<StaffAppointment> _appointments = const [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    _searchFocus.dispose();
    _scrollCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await ScheduleApiService.getAppointments(
        date: _dateParam(_selectedDate),
        page: 1,
        limit: 150,
      );
      if (!mounted) return;
      setState(() {
        _appointments = StaffAppointment.listFrom(data);
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString().replaceFirst('Exception: ', '');
        _loading = false;
      });
    }
  }

  List<StaffAppointment> get _filtered {
    return _appointments
        .where((appointment) {
          if (_query.trim().isNotEmpty &&
              !appointment.matchesPatientSearch(_query)) {
            return false;
          }
          return switch (_statusFilter) {
            'active' => _isActiveStatus(appointment.status),
            'overdue' => _isOverdue(appointment),
            'completed' => _isCompletedStatus(appointment.status),
            _ => true,
          };
        })
        .toList(growable: false);
  }

  int get _activeCount =>
      _appointments.where((a) => _isActiveStatus(a.status)).length;
  int get _overdueCount => _appointments.where(_isOverdue).length;
  int get _completedCount =>
      _appointments.where((a) => _isCompletedStatus(a.status)).length;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.keyR, control: true): _load,
        const SingleActivator(LogicalKeyboardKey.keyF, control: true): () {
          _searchFocus.requestFocus();
        },
      },
      child: Focus(
        autofocus: true,
        child: StaffScaffold(
          title: s.opNursingDashboardTitle,
          actions: [
            IconButton(
              tooltip: s.opNursingDashboardRefreshTooltip,
              onPressed: _loading ? null : _load,
              icon: const Icon(Icons.refresh),
            ),
          ],
          body: _buildBody(s),
        ),
      ),
    );
  }

  Widget _buildBody(AppStrings s) {
    return RefreshIndicator(
      onRefresh: _load,
      child: Scrollbar(
        controller: _scrollCtrl,
        thumbVisibility: true,
        child: SingleChildScrollView(
          controller: _scrollCtrl,
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _buildHeader(s),
              const SizedBox(height: 14),
              _buildSearchAndFilters(s),
              const SizedBox(height: 14),
              _buildStats(s),
              const SizedBox(height: 16),
              if (_loading)
                const SkeletonList()
              else if (_error != null)
                ErrorState(message: _error!, onRetry: _load)
              else
                _buildQueueList(s),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildHeader(AppStrings s) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppTheme.divider),
      ),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final narrow = constraints.maxWidth < 760;
          final dateControls = Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _DateChip(
                label: s.opNursingDateToday,
                selected: _isSameDay(_selectedDate, DateTime.now()),
                onTap: () => _setDate(DateTime.now()),
              ),
              _DateChip(
                label: s.opNursingDateTomorrow,
                selected: _isSameDay(
                  _selectedDate,
                  DateTime.now().add(const Duration(days: 1)),
                ),
                onTap: () =>
                    _setDate(DateTime.now().add(const Duration(days: 1))),
              ),
              _DateChip(
                label: s.opNursingDateFollowingDay,
                selected: _isSameDay(
                  _selectedDate,
                  DateTime.now().add(const Duration(days: 2)),
                ),
                onTap: () =>
                    _setDate(DateTime.now().add(const Duration(days: 2))),
              ),
              OutlinedButton.icon(
                onPressed: _pickDate,
                icon: const Icon(Icons.calendar_month_outlined, size: 18),
                label: Text(DateFormat('d MMM').format(_selectedDate)),
                style: OutlinedButton.styleFrom(
                  foregroundColor: AppTheme.primaryBlue,
                  minimumSize: const Size(0, 38),
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                ),
              ),
            ],
          );

          final title = Row(
            children: [
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  color: AppTheme.accentCyan.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: const Icon(
                  Icons.fact_check_outlined,
                  color: AppTheme.accentCyan,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      s.opNursingQueueTitle,
                      style: Theme.of(context).textTheme.titleLarge?.copyWith(
                        color: AppTheme.textPrimary,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      DateFormat('EEEE, d MMMM yyyy').format(_selectedDate),
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: AppTheme.textSecondary,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          );

          if (narrow) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [title, const SizedBox(height: 14), dateControls],
            );
          }
          return Row(
            children: [
              Expanded(child: title),
              dateControls,
            ],
          );
        },
      ),
    );
  }

  Widget _buildSearchAndFilters(AppStrings s) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Column(
        children: [
          TextField(
            controller: _searchCtrl,
            focusNode: _searchFocus,
            decoration: InputDecoration(
              hintText: s.opNursingSearchHint,
              prefixIcon: const Icon(Icons.search),
              suffixIcon: _query.isEmpty
                  ? null
                  : IconButton(
                      tooltip: s.opNursingClearSearchTooltip,
                      onPressed: () {
                        _searchCtrl.clear();
                        setState(() => _query = '');
                      },
                      icon: const Icon(Icons.close),
                    ),
              filled: true,
              fillColor: AppTheme.surfaceWhite,
            ),
            onChanged: (value) => setState(() => _query = value),
          ),
          const SizedBox(height: 12),
          Align(
            alignment: Alignment.centerLeft,
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                _FilterChipButton(
                  label: s.opNursingFilterActive,
                  selected: _statusFilter == 'active',
                  onTap: () => setState(() => _statusFilter = 'active'),
                ),
                _FilterChipButton(
                  label: s.opNursingFilterOverdue,
                  selected: _statusFilter == 'overdue',
                  color: AppTheme.warningOnSurface,
                  onTap: () => setState(() => _statusFilter = 'overdue'),
                ),
                _FilterChipButton(
                  label: s.opNursingFilterCompleted,
                  selected: _statusFilter == 'completed',
                  color: AppTheme.successOnSurface,
                  onTap: () => setState(() => _statusFilter = 'completed'),
                ),
                _FilterChipButton(
                  label: s.opNursingFilterAll,
                  selected: _statusFilter == 'all',
                  onTap: () => setState(() => _statusFilter = 'all'),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildStats(AppStrings s) {
    final stats = [
      _QueueStat(
        label: s.opNursingStatActiveQueue,
        value: _activeCount,
        icon: Icons.queue_outlined,
        color: AppTheme.primaryBlue,
      ),
      _QueueStat(
        label: s.opNursingStatNeedsTriage,
        value: _activeCount,
        icon: Icons.fact_check_outlined,
        color: AppTheme.accentCyan,
      ),
      _QueueStat(
        label: s.opNursingStatOverdueWait,
        value: _overdueCount,
        icon: Icons.timer_outlined,
        color: AppTheme.warningOnSurface,
      ),
      _QueueStat(
        label: s.opNursingStatCompleted,
        value: _completedCount,
        icon: Icons.check_circle_outline,
        color: AppTheme.successOnSurface,
      ),
    ];

    return LayoutBuilder(
      builder: (context, constraints) {
        final count = constraints.maxWidth >= 980 ? 4 : 2;
        final spacing = 10.0;
        final width = (constraints.maxWidth - ((count - 1) * spacing)) / count;
        return Wrap(
          spacing: spacing,
          runSpacing: spacing,
          children: [
            for (final stat in stats) SizedBox(width: width, child: stat),
          ],
        );
      },
    );
  }

  Widget _buildQueueList(AppStrings s) {
    final appointments = _filtered;
    if (appointments.isEmpty) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 48),
        decoration: BoxDecoration(
          color: AppTheme.cardSurface,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: AppTheme.divider),
        ),
        child: Column(
          children: [
            Icon(
              Icons.event_busy_outlined,
              size: 42,
              color: AppTheme.textSecondary,
            ),
            const SizedBox(height: 10),
            Text(
              s.opNursingNoMatchingAppointments,
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                color: AppTheme.textPrimary,
                fontWeight: FontWeight.w800,
              ),
            ),
          ],
        ),
      );
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        final twoColumns = constraints.maxWidth >= 1120;
        final cardWidth = twoColumns
            ? (constraints.maxWidth - 12) / 2
            : constraints.maxWidth;
        return Wrap(
          spacing: 12,
          runSpacing: 12,
          children: [
            for (final appointment in appointments)
              SizedBox(
                width: cardWidth,
                child: _OpQueueCard(
                  appointment: appointment,
                  overdue: _isOverdue(appointment),
                  onOpenRecords: () =>
                      context.push(_patientRecordsRoute(appointment)),
                  onOpenInvestigations: () =>
                      context.push(_investigationsRoute(appointment)),
                  onOpenNursingNotes: appointment.patientUid.isEmpty
                      ? null
                      : () => context.push(_nursingNotesRoute(appointment)),
                  onOpenTimeline: appointment.patientUid.isEmpty
                      ? null
                      : () => context.push(_timelineRoute(appointment)),
                ),
              ),
          ],
        );
      },
    );
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _selectedDate,
      firstDate: DateTime.now().subtract(const Duration(days: 30)),
      lastDate: DateTime.now().add(const Duration(days: 180)),
    );
    if (picked == null) return;
    _setDate(picked);
  }

  void _setDate(DateTime value) {
    setState(() => _selectedDate = _dateOnly(value));
    _load();
  }
}

class _OpQueueCard extends StatelessWidget {
  final StaffAppointment appointment;
  final bool overdue;
  final VoidCallback onOpenRecords;
  final VoidCallback onOpenInvestigations;
  final VoidCallback? onOpenNursingNotes;
  final VoidCallback? onOpenTimeline;

  const _OpQueueCard({
    required this.appointment,
    required this.overdue,
    required this.onOpenRecords,
    required this.onOpenInvestigations,
    required this.onOpenNursingNotes,
    required this.onOpenTimeline,
  });

  @override
  Widget build(BuildContext context) {
    final statusColor = _statusColor(appointment.status);
    final hasPatientUid = appointment.patientUid.isNotEmpty;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
          color: overdue
              ? AppTheme.warningOnSurface.withValues(alpha: 0.55)
              : AppTheme.divider,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: statusColor.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Icon(
                  Icons.person_pin_circle_outlined,
                  color: statusColor,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      appointment.patientName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        color: AppTheme.textPrimary,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      [
                        if (appointment.appointmentTime.isNotEmpty)
                          appointment.appointmentTime,
                        if (appointment.patientPhone.isNotEmpty)
                          appointment.patientPhone,
                      ].join(' - '),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: AppTheme.textSecondary,
                      ),
                    ),
                  ],
                ),
              ),
              _StatusPill(label: appointment.status, color: statusColor),
            ],
          ),
          const SizedBox(height: 12),
          Builder(builder: (ctx) {
            final s = AppStrings.of(ctx);
            return Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                if (appointment.doctorName.isNotEmpty)
                  _InfoPill(
                    icon: Icons.medical_services_outlined,
                    label: appointment.doctorName,
                  ),
                if (appointment.department.isNotEmpty)
                  _InfoPill(
                    icon: Icons.business_outlined,
                    label: appointment.department,
                  ),
                if (appointment.reason.isNotEmpty)
                  _InfoPill(
                    icon: Icons.local_hospital_outlined,
                    label: appointment.reason,
                  ),
                if (overdue)
                  _InfoPill(
                    icon: Icons.timer_outlined,
                    label: s.opNursingCardOverdueWait,
                    color: AppTheme.warningOnSurface,
                  ),
              ],
            );
          }),
          const SizedBox(height: 12),
          Builder(builder: (ctx) {
            final s = AppStrings.of(ctx);
            return Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                _ActionChipButton(
                  icon: Icons.folder_shared_outlined,
                  label: s.opNursingCardRecords,
                  onTap: onOpenRecords,
                ),
                _ActionChipButton(
                  icon: Icons.biotech_outlined,
                  label: s.opNursingCardInvestigations,
                  onTap: onOpenInvestigations,
                ),
                _ActionChipButton(
                  icon: Icons.edit_note_outlined,
                  label: s.opNursingCardNursingNote,
                  onTap: onOpenNursingNotes,
                ),
                _ActionChipButton(
                  icon: Icons.timeline_outlined,
                  label: s.opNursingCardTimeline,
                  onTap: onOpenTimeline,
                ),
              ],
            );
          }),
          if (!hasPatientUid) ...[
            const SizedBox(height: 10),
            Builder(builder: (ctx) {
              final s = AppStrings.of(ctx);
              return Text(
                s.opNursingPatientUidMissing,
                style: Theme.of(ctx).textTheme.bodySmall?.copyWith(
                  color: AppTheme.warningOnSurface,
                  fontWeight: FontWeight.w700,
                ),
              );
            }),
          ],
        ],
      ),
    );
  }
}

class _QueueStat extends StatelessWidget {
  final String label;
  final int value;
  final IconData icon;
  final Color color;

  const _QueueStat({
    required this.label,
    required this.value,
    required this.icon,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Row(
        children: [
          Icon(icon, color: color),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: AppTheme.textSecondary,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          Text(
            value.toString(),
            style: Theme.of(context).textTheme.titleLarge?.copyWith(
              color: color,
              fontWeight: FontWeight.w900,
            ),
          ),
        ],
      ),
    );
  }
}

class _FilterChipButton extends StatelessWidget {
  final String label;
  final bool selected;
  final Color? color;
  final VoidCallback onTap;

  const _FilterChipButton({
    required this.label,
    required this.selected,
    required this.onTap,
    this.color,
  });

  @override
  Widget build(BuildContext context) {
    final tint = color ?? AppTheme.primaryBlue;
    return ChoiceChip(
      label: Text(label),
      selected: selected,
      selectedColor: tint.withValues(alpha: 0.16),
      backgroundColor: AppTheme.surfaceWhite,
      side: BorderSide(color: selected ? tint : AppTheme.divider),
      labelStyle: TextStyle(
        color: selected ? tint : AppTheme.textSecondary,
        fontWeight: FontWeight.w800,
      ),
      onSelected: (_) => onTap(),
    );
  }
}

class _DateChip extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback onTap;

  const _DateChip({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return FilledButton.tonalIcon(
      onPressed: onTap,
      icon: Icon(selected ? Icons.check : Icons.calendar_today_outlined),
      label: Text(label),
      style: FilledButton.styleFrom(
        minimumSize: const Size(0, 38),
        backgroundColor: selected
            ? AppTheme.primaryBlue.withValues(alpha: 0.16)
            : AppTheme.surfaceWhite,
        foregroundColor: selected ? AppTheme.primaryBlue : AppTheme.textPrimary,
        side: BorderSide(
          color: selected ? AppTheme.primaryBlue : AppTheme.divider,
        ),
        padding: const EdgeInsets.symmetric(horizontal: 12),
      ),
    );
  }
}

class _StatusPill extends StatelessWidget {
  final String label;
  final Color color;

  const _StatusPill({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        _sentence(label),
        style: TextStyle(
          color: color,
          fontSize: 12,
          fontWeight: FontWeight.w900,
        ),
      ),
    );
  }
}

class _InfoPill extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color? color;

  const _InfoPill({required this.icon, required this.label, this.color});

  @override
  Widget build(BuildContext context) {
    final tint = color ?? AppTheme.textSecondary;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: tint.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 15, color: tint),
          const SizedBox(width: 6),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 220),
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: tint,
                fontSize: 12,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ActionChipButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback? onTap;

  const _ActionChipButton({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final enabled = onTap != null;
    return ActionChip(
      avatar: Icon(
        icon,
        size: 18,
        color: enabled ? AppTheme.primaryBlue : AppTheme.textSecondary,
      ),
      label: Text(label),
      labelStyle: TextStyle(
        color: enabled ? AppTheme.primaryBlue : AppTheme.textSecondary,
        fontWeight: FontWeight.w800,
      ),
      backgroundColor: enabled
          ? AppTheme.primaryBlue.withValues(alpha: 0.10)
          : AppTheme.surfaceWhite,
      side: BorderSide(
        color: enabled ? AppTheme.primaryBlue : AppTheme.divider,
      ),
      onPressed: onTap,
    );
  }
}

DateTime _dateOnly(DateTime value) =>
    DateTime(value.year, value.month, value.day);

String _dateParam(DateTime value) => DateFormat('yyyy-MM-dd').format(value);

bool _isSameDay(DateTime a, DateTime b) =>
    a.year == b.year && a.month == b.month && a.day == b.day;

bool _isActiveStatus(String status) {
  final s = status.trim().toUpperCase();
  return const {
    'SCHEDULED',
    'CONFIRMED',
    'ARRIVED',
    'WAITING',
    'CHECKED_IN',
    'IN_PROGRESS',
    'REQUESTED',
  }.contains(s);
}

bool _isCompletedStatus(String status) {
  final s = status.trim().toUpperCase();
  return const {'COMPLETED', 'DONE', 'CLOSED'}.contains(s);
}

bool _isOverdue(StaffAppointment appointment) {
  return _isActiveStatus(appointment.status) &&
      (appointment.slaBreached || appointment.minutesSinceBooking >= 45);
}

Color _statusColor(String status) {
  return switch (status.trim().toLowerCase()) {
    'confirmed' || 'arrived' || 'checked_in' => AppTheme.successOnSurface,
    'completed' || 'done' || 'closed' => AppTheme.primaryTeal,
    'cancelled' => AppTheme.errorOnSurface,
    'no_show' => AppTheme.textSecondary,
    _ => AppTheme.warningOnSurface,
  };
}

String _sentence(String value) {
  final cleaned = value.replaceAll('_', ' ').trim().toLowerCase();
  if (cleaned.isEmpty) return '-';
  return cleaned[0].toUpperCase() + cleaned.substring(1);
}

String _queryFor(StaffAppointment appointment) {
  final params = <String, String>{'context': 'op'};
  void add(String key, Object? value) {
    final text = value?.toString().trim() ?? '';
    if (text.isNotEmpty) params[key] = text;
  }

  add('patient_uid', appointment.patientUid);
  add('patient_id', appointment.patientId);
  add('phone', appointment.patientPhone);
  add('name', appointment.patientName);
  add('appointment_id', appointment.id);
  add('doctor_id', appointment.doctorId);
  add('doctor_name', appointment.doctorName);
  add('department', appointment.department);
  add('appointment_date', appointment.appointmentDate);
  add('appointment_time', appointment.appointmentTime);
  add('status', appointment.status);
  add('reason', appointment.reason);
  return Uri(queryParameters: params).query;
}

String _patientRecordsRoute(StaffAppointment appointment) =>
    '/patient-records?${_queryFor(appointment)}';

String _investigationsRoute(StaffAppointment appointment) =>
    '/investigations?${_queryFor(appointment)}';

String _nursingNotesRoute(StaffAppointment appointment) =>
    '/nursing-notes?${_queryFor(appointment)}';

String _timelineRoute(StaffAppointment appointment) {
  final params = {'name': appointment.patientName};
  return Uri(
    path: '/emr/timeline/${Uri.encodeComponent(appointment.patientUid)}',
    queryParameters: params,
  ).toString();
}
