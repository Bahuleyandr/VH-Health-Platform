import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../../core/services/medical_api_service.dart';
import '../../../core/services/recent_patients_service.dart';
import '../../../core/services/schedule_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';
import '../../../core/widgets/states/success_toast.dart';

class OpDoctorWorkspaceScreen extends StatefulWidget {
  final String patientUid;
  final String? patientName;
  final int? appointmentId;
  final int? patientId;
  final int? doctorId;
  final String? doctorName;
  final String? department;
  final String? reason;
  final String? appointmentDate;
  final String? appointmentTime;
  final String? status;

  const OpDoctorWorkspaceScreen({
    super.key,
    required this.patientUid,
    this.patientName,
    this.appointmentId,
    this.patientId,
    this.doctorId,
    this.doctorName,
    this.department,
    this.reason,
    this.appointmentDate,
    this.appointmentTime,
    this.status,
  });

  @override
  State<OpDoctorWorkspaceScreen> createState() =>
      _OpDoctorWorkspaceScreenState();
}

class _OpDoctorWorkspaceScreenState extends State<OpDoctorWorkspaceScreen> {
  List<Map<String, dynamic>> _events = const [];
  bool _loading = true;
  bool _completing = false;
  String? _error;
  late String _status;

  @override
  void initState() {
    super.initState();
    _status = _clean(widget.status).isEmpty
        ? 'CONFIRMED'
        : _clean(widget.status).toUpperCase();
    _loadTimeline();
    RecentPatientsService.add(widget.patientUid, widget.patientName);
  }

  Future<void> _loadTimeline() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await MedicalApiService.getPatientTimeline(
        widget.patientUid,
      );
      final list = data['events'] ?? data['timeline'];
      final events = list is List
          ? list
                .whereType<Map>()
                .map((item) => Map<String, dynamic>.from(item))
                .toList()
          : <Map<String, dynamic>>[];
      if (!mounted) return;
      setState(() {
        _events = events;
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

  String get _patientTitle {
    final name = _clean(widget.patientName);
    return name.isEmpty ? 'Patient' : name;
  }

  String get _patientQuery {
    final params = <String>[
      if (_clean(widget.patientName).isNotEmpty)
        'name=${Uri.encodeQueryComponent(_clean(widget.patientName))}',
      if (widget.patientId != null) 'patient_id=${widget.patientId}',
      if (widget.appointmentId != null)
        'appointment_id=${widget.appointmentId}',
      'context=op',
    ];
    return params.isEmpty ? '' : '?${params.join('&')}';
  }

  String get _timelineRoute =>
      '/emr/timeline/${widget.patientUid}$_patientQuery';

  bool get _canComplete =>
      widget.appointmentId != null &&
      !_completing &&
      !_isTerminalStatus(_status);

  String get _scheduledLabel {
    final parts = [
      _clean(widget.appointmentDate),
      _clean(widget.appointmentTime),
    ].where((part) => part.isNotEmpty).toList();
    return parts.isEmpty ? 'OP appointment' : parts.join(' at ');
  }

  Future<void> _completeAppointment() async {
    final id = widget.appointmentId;
    if (id == null || !_canComplete) return;
    setState(() => _completing = true);
    try {
      await ScheduleApiService.updateAppointmentStatus(
        id.toString(),
        'completed',
      );
      if (!mounted) return;
      setState(() {
        _status = 'COMPLETED';
        _completing = false;
      });
      SuccessToast.show(context, 'OP consultation marked complete');
    } catch (e) {
      if (!mounted) return;
      setState(() => _completing = false);
      ErrorToast.show(context, e.toString().replaceFirst('Exception: ', ''));
    }
  }

  void _openPrescription() {
    context.push(
      '/prescriptions',
      extra: {
        if (widget.appointmentId != null) 'id': widget.appointmentId,
        if (widget.patientId != null) 'patient_id': widget.patientId,
        if (widget.doctorId != null) 'doctor_id': widget.doctorId,
        'patient_uid': widget.patientUid,
        'patient_name': _patientTitle,
        if (_clean(widget.doctorName).isNotEmpty)
          'doctor_name': _clean(widget.doctorName),
        if (_clean(widget.department).isNotEmpty)
          'department': _clean(widget.department),
        if (_clean(widget.reason).isNotEmpty) 'reason': _clean(widget.reason),
        if (_clean(widget.appointmentDate).isNotEmpty)
          'appointment_date': _clean(widget.appointmentDate),
        if (_clean(widget.appointmentTime).isNotEmpty)
          'appointment_time': _clean(widget.appointmentTime),
      },
    );
  }

  void _openPatientRecords() {
    final query = <String>[
      if (widget.patientId != null) 'patient_id=${widget.patientId}',
      if (_clean(widget.patientName).isNotEmpty)
        'name=${Uri.encodeQueryComponent(_clean(widget.patientName))}',
      'context=op',
    ].join('&');
    context.push('/patient-records?$query');
  }

  Widget _buildVisitHeader() {
    final reason = _clean(widget.reason);
    final department = _clean(widget.department);
    final doctor = _clean(widget.doctorName);
    final statusColor = _statusColor(_status);

    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 52,
              height: 52,
              decoration: BoxDecoration(
                color: AppTheme.primaryBlue.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(14),
              ),
              child: const Icon(
                Icons.medical_services_outlined,
                color: AppTheme.primaryBlue,
                size: 28,
              ),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Wrap(
                    spacing: 10,
                    runSpacing: 8,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      Text(
                        _patientTitle,
                        style: Theme.of(context).textTheme.headlineSmall
                            ?.copyWith(
                              color: AppTheme.textPrimary,
                              fontWeight: FontWeight.w900,
                            ),
                      ),
                      _StatusPill(label: _status, color: statusColor),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 12,
                    runSpacing: 6,
                    children: [
                      _MetaChip(Icons.event_outlined, _scheduledLabel),
                      if (department.isNotEmpty)
                        _MetaChip(Icons.business_outlined, department),
                      if (doctor.isNotEmpty)
                        _MetaChip(Icons.person_outline, doctor),
                    ],
                  ),
                  if (reason.isNotEmpty) ...[
                    const SizedBox(height: 12),
                    Text(
                      reason,
                      style: TextStyle(
                        color: AppTheme.textSecondary,
                        fontSize: 14,
                        height: 1.35,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildClinicalActions() {
    final actions = [
      _WorkspaceAction(
        icon: Icons.note_add_outlined,
        label: 'Doctor notes',
        detail: 'Write OP consultation notes',
        onTap: () =>
            context.push('/emr/notes/${widget.patientUid}$_patientQuery'),
      ),
      _WorkspaceAction(
        icon: Icons.medication_outlined,
        label: 'Prescription',
        detail: 'Create e-prescription from this appointment',
        onTap: _openPrescription,
      ),
      _WorkspaceAction(
        icon: Icons.receipt_long_outlined,
        label: 'Orders',
        detail: 'Medication, nursing, or investigation orders',
        onTap: () =>
            context.push('/emr/orders/${widget.patientUid}$_patientQuery'),
      ),
      _WorkspaceAction(
        icon: Icons.biotech_outlined,
        label: 'Investigations',
        detail: 'Review or request investigations',
        onTap: () => context.push(
          '/investigations?patient_uid=${Uri.encodeQueryComponent(widget.patientUid)}',
        ),
      ),
      _WorkspaceAction(
        icon: Icons.folder_shared_outlined,
        label: 'Prior records',
        detail: 'Open patient records with this patient selected',
        onTap: _openPatientRecords,
      ),
      _WorkspaceAction(
        icon: Icons.timeline_outlined,
        label: 'Full timeline',
        detail: 'Notes, drug chart, orders, vitals and reports',
        onTap: () => context.push(_timelineRoute),
      ),
    ];

    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const _SectionTitle(
              icon: Icons.medical_information_outlined,
              title: 'Consultation actions',
              subtitle: 'Use one patient context for OP documentation',
            ),
            const SizedBox(height: 12),
            ...actions.map(
              (action) => Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: _ActionTile(action: action),
              ),
            ),
            const SizedBox(height: 4),
            FilledButton.icon(
              onPressed: _canComplete ? _completeAppointment : null,
              icon: _completing
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.check_circle_outline, size: 18),
              label: Text(
                _isTerminalStatus(_status)
                    ? 'Consultation ${_status.toLowerCase()}'
                    : 'Complete consultation',
              ),
              style: FilledButton.styleFrom(
                minimumSize: const Size.fromHeight(44),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildTimelineSummary() {
    final latest = _events.take(8).toList();
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Expanded(
                  child: _SectionTitle(
                    icon: Icons.history_outlined,
                    title: 'Clinical timeline',
                    subtitle:
                        'Recent notes, prescriptions, drug chart and reports',
                  ),
                ),
                TextButton.icon(
                  onPressed: () => context.push(_timelineRoute),
                  icon: const Icon(Icons.open_in_new, size: 16),
                  label: const Text('Open full'),
                ),
              ],
            ),
            const SizedBox(height: 8),
            if (latest.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 28),
                child: Center(
                  child: Text(
                    'No clinical timeline entries yet',
                    style: TextStyle(color: AppTheme.textSecondary),
                  ),
                ),
              )
            else
              ...latest.asMap().entries.map(
                (entry) => _TimelineSummaryItem(
                  event: entry.value,
                  isLast: entry.key == latest.length - 1,
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildVisitChecklist() {
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const _SectionTitle(
              icon: Icons.fact_check_outlined,
              title: 'OP visit checklist',
              subtitle: 'Keeps the consultation from scattering across pages',
            ),
            const SizedBox(height: 12),
            _ChecklistRow(
              complete: _hasEventType({'note', 'clinical_note', 'doctor_note'}),
              label: 'Clinical note entered',
            ),
            _ChecklistRow(
              complete: _hasEventType({
                'order',
                'clinical_order',
                'investigation',
              }),
              label: 'Orders or investigations reviewed',
            ),
            _ChecklistRow(
              complete: _hasEventType({'medication', 'prescription'}),
              label: 'Prescription reviewed if needed',
            ),
            _ChecklistRow(
              complete: _isTerminalStatus(_status),
              label: 'Appointment completed',
            ),
          ],
        ),
      ),
    );
  }

  bool _hasEventType(Set<String> types) {
    return _events.any((event) {
      final type = _clean(event['event_type']).toLowerCase();
      return types.contains(type);
    });
  }

  Widget _buildContent() {
    return LayoutBuilder(
      builder: (context, constraints) {
        final wide = constraints.maxWidth >= 1080;
        final actionPanel = Column(
          children: [
            _buildClinicalActions(),
            const SizedBox(height: 14),
            _buildVisitChecklist(),
          ],
        );
        final timelinePanel = _buildTimelineSummary();

        return RefreshIndicator(
          onRefresh: _loadTimeline,
          child: SingleChildScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _buildVisitHeader(),
                const SizedBox(height: 16),
                if (wide)
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(flex: 3, child: timelinePanel),
                      const SizedBox(width: 16),
                      SizedBox(width: 360, child: actionPanel),
                    ],
                  )
                else
                  Column(
                    children: [
                      actionPanel,
                      const SizedBox(height: 16),
                      timelinePanel,
                    ],
                  ),
                const SizedBox(height: 24),
              ],
            ),
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'OP Workspace - $_patientTitle',
      body: _loading
          ? const SkeletonList()
          : _error != null
          ? ErrorState(message: _error!, onRetry: _loadTimeline)
          : _buildContent(),
    );
  }
}

class _WorkspaceAction {
  final IconData icon;
  final String label;
  final String detail;
  final VoidCallback onTap;

  const _WorkspaceAction({
    required this.icon,
    required this.label,
    required this.detail,
    required this.onTap,
  });
}

class _ActionTile extends StatelessWidget {
  final _WorkspaceAction action;

  const _ActionTile({required this.action});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: action.onTap,
      borderRadius: BorderRadius.circular(10),
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: AppTheme.primaryBlue.withValues(alpha: 0.07),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(
            color: AppTheme.primaryBlue.withValues(alpha: 0.18),
          ),
        ),
        child: Row(
          children: [
            Icon(action.icon, color: AppTheme.primaryBlue, size: 22),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    action.label,
                    style: TextStyle(
                      color: AppTheme.textPrimary,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    action.detail,
                    style: TextStyle(
                      color: AppTheme.textSecondary,
                      fontSize: 12,
                    ),
                  ),
                ],
              ),
            ),
            Icon(Icons.chevron_right, color: AppTheme.textSecondary),
          ],
        ),
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;

  const _SectionTitle({
    required this.icon,
    required this.title,
    required this.subtitle,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: AppTheme.primaryBlue, size: 22),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: TextStyle(
                  color: AppTheme.textPrimary,
                  fontWeight: FontWeight.w900,
                  fontSize: 16,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                subtitle,
                style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _MetaChip extends StatelessWidget {
  final IconData icon;
  final String label;

  const _MetaChip(this.icon, this.label);

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 15, color: AppTheme.textSecondary),
          const SizedBox(width: 6),
          Text(
            label,
            style: TextStyle(
              color: AppTheme.textPrimary,
              fontSize: 12,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
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
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontSize: 11,
          fontWeight: FontWeight.w900,
        ),
      ),
    );
  }
}

class _ChecklistRow extends StatelessWidget {
  final bool complete;
  final String label;

  const _ChecklistRow({required this.complete, required this.label});

  @override
  Widget build(BuildContext context) {
    final color = complete ? AppTheme.successOnSurface : AppTheme.textSecondary;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          Icon(
            complete ? Icons.check_circle : Icons.radio_button_unchecked,
            size: 18,
            color: color,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              label,
              style: TextStyle(
                color: AppTheme.textPrimary,
                fontWeight: complete ? FontWeight.w700 : FontWeight.w500,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _TimelineSummaryItem extends StatelessWidget {
  final Map<String, dynamic> event;
  final bool isLast;

  const _TimelineSummaryItem({required this.event, required this.isLast});

  @override
  Widget build(BuildContext context) {
    final type = _normalizedEventType(event['event_type']);
    final color = _eventColor(type);
    final description = _eventDescription(event);
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 40,
            child: Column(
              children: [
                Container(
                  width: 28,
                  height: 28,
                  decoration: BoxDecoration(
                    color: color.withValues(alpha: 0.14),
                    shape: BoxShape.circle,
                  ),
                  child: Icon(_eventIcon(type), color: color, size: 15),
                ),
                if (!isLast)
                  Expanded(child: Container(width: 2, color: AppTheme.divider)),
              ],
            ),
          ),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: AppTheme.backgroundGrey.withValues(alpha: 0.7),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: AppTheme.divider),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        _StatusPill(label: type.toUpperCase(), color: color),
                        const Spacer(),
                        Text(
                          _formatTimestamp(event['timestamp']),
                          style: TextStyle(
                            color: AppTheme.textSecondary,
                            fontSize: 11,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Text(
                      _eventTitle(event),
                      style: TextStyle(
                        color: AppTheme.textPrimary,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    if (description.isNotEmpty) ...[
                      const SizedBox(height: 4),
                      Text(
                        description,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: AppTheme.textSecondary,
                          fontSize: 13,
                          height: 1.35,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

String _eventTitle(Map<String, dynamic> event) {
  final explicit = _clean(event['title']);
  if (explicit.isNotEmpty) return explicit;
  final type = _normalizedEventType(event['event_type']);
  final payload = _asMap(event['payload']);
  if (type == 'note') {
    final noteType = _clean(payload['note_type']);
    return noteType.isEmpty ? 'Clinical note' : '${_formatKey(noteType)} note';
  }
  if (type == 'drug_chart') {
    final details = _asMap(payload['details']);
    final medication = _clean(
      details['medication_name'] ??
          details['name'] ??
          details['medication'] ??
          payload['medication_name'],
    );
    return medication.isEmpty ? 'Drug chart' : 'Drug chart - $medication';
  }
  return _formatKey(type);
}

String _eventDescription(Map<String, dynamic> event) {
  final explicit = _clean(event['description']);
  if (explicit.isNotEmpty) return explicit;
  final summary = _clean(event['summary']);
  if (summary.isNotEmpty) return summary;
  final payload = _asMap(event['payload']);
  final content = payload['content'];
  if (content is Map) {
    final parts = [
      content['subjective'],
      content['objective'],
      content['assessment'],
      content['plan'],
      content['notes'],
    ].map(_clean).where((value) => value.isNotEmpty).toList();
    if (parts.isNotEmpty) return parts.join(' ');
  }
  return _clean(content);
}

String _formatTimestamp(dynamic value) {
  final text = _clean(value);
  if (text.isEmpty) return '-';
  try {
    final dt = DateTime.parse(text).toLocal();
    return DateFormat('dd/MM HH:mm').format(dt);
  } catch (_) {
    return text;
  }
}

String _normalizedEventType(dynamic value) {
  final text = _clean(value).toLowerCase();
  switch (text) {
    case 'clinical_note':
    case 'doctor_note':
    case 'nursing_note':
      return 'note';
    case 'clinical_order':
      return 'order';
    case 'medication_order':
      return 'drug_chart';
    default:
      return text.isEmpty ? 'event' : text;
  }
}

IconData _eventIcon(String type) {
  switch (type) {
    case 'vitals':
      return Icons.monitor_heart_outlined;
    case 'note':
      return Icons.note_alt_outlined;
    case 'order':
      return Icons.receipt_long_outlined;
    case 'drug_chart':
    case 'medication':
    case 'prescription':
      return Icons.medication_outlined;
    case 'investigation':
      return Icons.biotech_outlined;
    case 'admission':
      return Icons.local_hospital_outlined;
    case 'discharge':
      return Icons.exit_to_app_outlined;
    default:
      return Icons.circle_outlined;
  }
}

Color _eventColor(String type) {
  switch (type) {
    case 'vitals':
      return AppTheme.primaryTeal;
    case 'note':
      return const Color(0xFF8E24AA);
    case 'order':
      return AppTheme.accentCyan;
    case 'drug_chart':
    case 'medication':
    case 'prescription':
      return AppTheme.warningOnSurface;
    case 'investigation':
      return AppTheme.successOnSurface;
    case 'admission':
      return AppTheme.primaryBlue;
    case 'discharge':
      return AppTheme.successOnSurface;
    default:
      return AppTheme.textSecondary;
  }
}

Color _statusColor(String status) {
  final normalized = status.toUpperCase();
  if (_isTerminalStatus(normalized)) return AppTheme.successOnSurface;
  if (normalized == 'NO_SHOW' || normalized == 'CANCELLED') {
    return AppTheme.errorOnSurface;
  }
  if (normalized == 'ARRIVED' || normalized == 'IN_PROGRESS') {
    return AppTheme.warningOnSurface;
  }
  return AppTheme.primaryBlue;
}

bool _isTerminalStatus(String status) {
  final normalized = status.toUpperCase();
  return normalized == 'COMPLETED' ||
      normalized == 'COMPLETE' ||
      normalized == 'CANCELLED' ||
      normalized == 'CANCELED' ||
      normalized == 'NO_SHOW';
}

Map<String, dynamic> _asMap(dynamic value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return Map<String, dynamic>.from(value);
  return const {};
}

String _formatKey(String key) {
  return key
      .replaceAll('_', ' ')
      .split(' ')
      .map((word) {
        if (word.isEmpty) return word;
        return '${word[0].toUpperCase()}${word.substring(1)}';
      })
      .join(' ');
}

String _clean(Object? value) => value?.toString().trim() ?? '';
