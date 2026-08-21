import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../core/config/api_config.dart';
import '../../../core/config/role_config.dart';
import '../../../core/services/hr_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';

import 'package:vhhealth_staff/l10n/app_strings.dart';

class ReportsAdminQueueScreen extends StatefulWidget {
  const ReportsAdminQueueScreen({super.key});

  @override
  State<ReportsAdminQueueScreen> createState() =>
      _ReportsAdminQueueScreenState();
}

class _ReportsAdminQueueScreenState extends State<ReportsAdminQueueScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;
  StaffRole _role = StaffRole.general;
  bool _roleLoaded = false;
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _incidents = const [];
  List<Map<String, dynamic>> _grievances = const [];

  bool get _canReview => _role == StaffRole.hr || _role.isAdminTier;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _loadRoleAndReports();
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _loadRoleAndReports() async {
    final role = StaffRole.fromString(await ApiConfig.getRole());
    if (!mounted) return;
    setState(() {
      _role = role;
      _roleLoaded = true;
    });
    if (_canReview) {
      await _loadReports();
    } else if (mounted) {
      setState(() {
        _loading = false;
        _error = null;
      });
    }
  }

  Future<void> _loadReports() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final results = await Future.wait([
        HrApiService.getAllIncidents(limit: 100),
        HrApiService.getAllGrievances(limit: 100),
      ]);
      if (!mounted) return;
      setState(() {
        _incidents = _listFrom(results[0], 'incidents');
        _grievances = _listFrom(results[1], 'grievances');
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  List<Map<String, dynamic>> _listFrom(
    Map<String, dynamic> payload,
    String key,
  ) {
    final raw = payload[key] ?? payload['data'];
    if (raw is List) {
      return raw
          .whereType<Map>()
          .map((row) => Map<String, dynamic>.from(row))
          .toList();
    }
    if (raw is Map<String, dynamic>) {
      return _listFrom(raw, key);
    }
    return const [];
  }

  @override
  Widget build(BuildContext context) {
    if (!_roleLoaded || _loading) {
      return Scaffold(
        backgroundColor: AppTheme.backgroundGrey,
        appBar: AppBar(
          leading: const NavigationBackAction(),
          title: const AppText('s4.lib.reports_admin_queue.reports_review'),
          actions: const [LogoutAction()],
        ),
        body: const Center(child: CircularProgressIndicator()),
      );
    }

    if (!_canReview) {
      return Scaffold(
        backgroundColor: AppTheme.backgroundGrey,
        appBar: AppBar(
          leading: const NavigationBackAction(),
          title: const AppText('s4.lib.reports_admin_queue.reports_review'),
          actions: const [LogoutAction()],
        ),
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: _AccessPanel(role: _role),
          ),
        ),
      );
    }

    final s = AppStrings.of(context);
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: const AppText('s4.lib.reports_admin_queue.reports_review'),
        actions: const [LogoutAction()],
        bottom: TabBar(
          controller: _tabController,
          tabs: [
            Tab(
              text: s.format('s4.dynamic.reports.incidents_count', {
                'count': _incidents.length,
              }),
            ),
            Tab(
              text: s.format('s4.dynamic.reports.grievances_count', {
                'count': _grievances.length,
              }),
            ),
          ],
        ),
      ),
      body: _error != null
          ? _ErrorPanel(message: _error!, onRetry: _loadReports)
          : RefreshIndicator(
              onRefresh: _loadReports,
              child: TabBarView(
                controller: _tabController,
                children: [
                  _ReportList(
                    emptyText: s.myReportsEmptyIncidents,
                    reports: _incidents,
                    type: _ReportType.incident,
                    onTap: _openIncident,
                  ),
                  _ReportList(
                    emptyText: s.myReportsEmptyGrievances,
                    reports: _grievances,
                    type: _ReportType.grievance,
                    onTap: _openGrievance,
                  ),
                ],
              ),
            ),
    );
  }

  Future<void> _openIncident(Map<String, dynamic> row) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => _ReportDetailSheet(
        type: _ReportType.incident,
        initial: row,
        statuses: const [
          'submitted',
          'under_review',
          'investigating',
          'resolved',
          'closed',
        ],
        loadDetail: () =>
            HrApiService.getAdminIncidentDetail(_intValue(row['id'])),
        saveUpdate:
            ({
              required String? status,
              required String? internalNote,
              required String? publicUpdate,
            }) => HrApiService.updateIncidentReport(
              id: _intValue(row['id']),
              status: status,
              internalNote: internalNote,
              publicUpdate: publicUpdate,
            ),
        onChanged: _loadReports,
      ),
    );
  }

  Future<void> _openGrievance(Map<String, dynamic> row) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => _ReportDetailSheet(
        type: _ReportType.grievance,
        initial: row,
        statuses: const [
          'submitted',
          'acknowledged',
          'under_review',
          'mediation',
          'resolved',
          'closed',
          'escalated',
        ],
        loadDetail: () =>
            HrApiService.getAdminGrievanceDetail(_intValue(row['id'])),
        saveUpdate:
            ({
              required String? status,
              required String? internalNote,
              required String? publicUpdate,
            }) => HrApiService.updateGrievanceReport(
              id: _intValue(row['id']),
              status: status,
              internalNote: internalNote,
              publicUpdate: publicUpdate,
            ),
        onChanged: _loadReports,
      ),
    );
  }
}

enum _ReportType { incident, grievance }

String _statusLabel(AppStrings s, String status) => switch (status) {
  'submitted' => s.lookup('reports.status.submitted'),
  'acknowledged' => s.lookup('reports.status.acknowledged'),
  'under_review' => s.lookup('reports.status.under_review'),
  'investigating' => s.lookup('reports.status.investigating'),
  'in_review' => s.lookup('reports.status.in_review'),
  'mediation' => s.lookup('reports.status.mediation'),
  'resolved' => s.lookup('reports.status.resolved'),
  'closed' => s.lookup('reports.status.closed'),
  'rejected' => s.lookup('reports.status.rejected'),
  'escalated' => s.lookup('reports.status.escalated'),
  _ => _titleCase(status.replaceAll('_', ' ')),
};

String _incidentTypeLabel(AppStrings s, String type) => switch (type) {
  'near_miss' => s.incidentReportTypeNearMiss,
  'patient_fall' => s.incidentReportTypePatientFall,
  'medication_error' => s.incidentReportTypeMedicationError,
  'needle_stick' => s.incidentReportTypeNeedleStick,
  'equipment_failure' => s.incidentReportTypeEquipmentFailure,
  'infection' => s.incidentReportTypeInfection,
  'fire_safety' => s.incidentReportTypeFireSafety,
  'patient_aggression' => s.incidentReportTypePatientAggression,
  'security_breach' => s.incidentReportTypeSecurityBreach,
  'other' => s.incidentReportTypeOther,
  _ => _titleCase(type.replaceAll('_', ' ')),
};

String _grievanceTypeLabel(AppStrings s, String type) => switch (type) {
  'harassment' => s.grievanceTypeHarassment,
  'discrimination' => s.grievanceTypeDiscrimination,
  'unfair_treatment' => s.grievanceTypeUnfairTreatment,
  'unsafe_conditions' => s.grievanceTypeUnsafeConditions,
  'workload' => s.grievanceTypeWorkload,
  'pay_dispute' => s.grievanceTypePayDispute,
  'schedule_conflict' => s.grievanceTypeScheduleConflict,
  'policy_violation' => s.grievanceTypePolicyViolation,
  'other' => s.grievanceTypeOther,
  _ => _titleCase(type.replaceAll('_', ' ')),
};

String _reportTypeLabel(AppStrings s, _ReportType reportType, String type) =>
    reportType == _ReportType.incident
    ? _incidentTypeLabel(s, type)
    : _grievanceTypeLabel(s, type);

String _severityLabel(AppStrings s, String severity) => switch (severity) {
  'low' => s.incidentReportSeverityLow,
  'moderate' => s.incidentReportSeverityModerate,
  'severe' => s.incidentReportSeveritySevere,
  'sentinel' => s.incidentReportSeveritySentinel,
  _ => _titleCase(severity.replaceAll('_', ' ')),
};

String _priorityLabel(AppStrings s, String priority) => switch (priority) {
  'low' => s.lookup('reports.priority.low'),
  'medium' => s.lookup('reports.priority.medium'),
  'moderate' => s.lookup('reports.priority.medium'),
  'high' => s.lookup('reports.priority.high'),
  'urgent' => s.lookup('reports.priority.urgent'),
  'escalated' => s.lookup('reports.status.escalated'),
  _ => _titleCase(priority.replaceAll('_', ' ')),
};

typedef _LoadDetail = Future<Map<String, dynamic>> Function();
typedef _SaveUpdate = Future<Map<String, dynamic>> Function({
  required String? status,
  required String? internalNote,
  required String? publicUpdate,
});

class _ReportList extends StatelessWidget {
  const _ReportList({
    required this.emptyText,
    required this.reports,
    required this.type,
    required this.onTap,
  });

  final String emptyText;
  final List<Map<String, dynamic>> reports;
  final _ReportType type;
  final ValueChanged<Map<String, dynamic>> onTap;

  @override
  Widget build(BuildContext context) {
    if (reports.isEmpty) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          SizedBox(height: MediaQuery.sizeOf(context).height * 0.25),
          Icon(
            type == _ReportType.incident
                ? Icons.warning_amber_rounded
                : Icons.support_agent_outlined,
            size: 48,
            color: AppTheme.textSecondary,
          ),
          const SizedBox(height: 10),
          Text(
            emptyText,
            textAlign: TextAlign.center,
            style: TextStyle(color: AppTheme.textSecondary),
          ),
        ],
      );
    }

    return ListView.separated(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(12),
      itemCount: reports.length,
      separatorBuilder: (context, index) => const SizedBox(height: 8),
      itemBuilder: (context, index) {
        final report = reports[index];
        return _ReportTile(
          report: report,
          type: type,
          onTap: () => onTap(report),
        );
      },
    );
  }
}

class _ReportTile extends StatelessWidget {
  const _ReportTile({
    required this.report,
    required this.type,
    required this.onTap,
  });

  final Map<String, dynamic> report;
  final _ReportType type;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final isIncident = type == _ReportType.incident;
    final color = isIncident ? AppTheme.warningOnSurface : Colors.purpleAccent;
    final title = isIncident
        ? _text(
            report['title'],
            fallback: s.lookup('s4.lib.reports_admin_queue.untitled_incident'),
          )
        : _text(
            report['subject'],
            fallback: s.lookup('s4.lib.reports_admin_queue.untitled_grievance'),
          );
    final number = isIncident
        ? _text(report['report_number'], fallback: 'INC-${report['id'] ?? ''}')
        : _text(
            report['grievance_number'],
            fallback: 'GRV-${report['id'] ?? ''}',
          );
    final status = _text(report['status'], fallback: 'submitted');
    final typeLabel = isIncident
        ? _incidentTypeLabel(s, _text(report['incident_type']))
        : _grievanceTypeLabel(s, _text(report['grievance_type']));
    final reporter = _reporterLabel(report, s);
    final created = _formatDate(report['created_at']);

    return Card(
      color: AppTheme.cardSurface,
      child: ListTile(
        onTap: onTap,
        leading: Container(
          width: 42,
          height: 42,
          decoration: BoxDecoration(
            color: color.withValues(alpha: 0.14),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Icon(
            isIncident
                ? Icons.warning_amber_rounded
                : Icons.support_agent_outlined,
            color: color,
          ),
        ),
        title: Text(
          title,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            color: AppTheme.textPrimary,
            fontWeight: FontWeight.w700,
          ),
        ),
        subtitle: Padding(
          padding: const EdgeInsets.only(top: 3),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                number,
                style: TextStyle(
                  color: AppTheme.textSecondary,
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                ),
              ),
              Text(
                [
                  if (typeLabel.isNotEmpty) typeLabel,
                  reporter,
                  if (created.isNotEmpty) created,
                ].join(' | '),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: AppTheme.textSecondary, fontSize: 11),
              ),
            ],
          ),
        ),
        trailing: _StatusChip(status: status),
      ),
    );
  }
}

class _ReportDetailSheet extends StatefulWidget {
  const _ReportDetailSheet({
    required this.type,
    required this.initial,
    required this.statuses,
    required this.loadDetail,
    required this.saveUpdate,
    required this.onChanged,
  });

  final _ReportType type;
  final Map<String, dynamic> initial;
  final List<String> statuses;
  final _LoadDetail loadDetail;
  final _SaveUpdate saveUpdate;
  final Future<void> Function() onChanged;

  @override
  State<_ReportDetailSheet> createState() => _ReportDetailSheetState();
}

class _ReportDetailSheetState extends State<_ReportDetailSheet> {
  final _internalNoteCtrl = TextEditingController();
  final _publicUpdateCtrl = TextEditingController();
  Map<String, dynamic>? _detail;
  String? _status;
  bool _loading = true;
  bool _saving = false;
  String? _error;

  bool get _isIncident => widget.type == _ReportType.incident;

  @override
  void initState() {
    super.initState();
    _status = _text(widget.initial['status'], fallback: widget.statuses.first);
    _load();
  }

  @override
  void dispose() {
    _internalNoteCtrl.dispose();
    _publicUpdateCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final detail = await widget.loadDetail();
      if (!mounted) return;
      setState(() {
        _detail = detail;
        _status = _text(detail['status'], fallback: _status ?? '');
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _save() async {
    final internalNote = _internalNoteCtrl.text.trim();
    final publicUpdate = _publicUpdateCtrl.text.trim();
    if ((_status ?? '').isEmpty &&
        internalNote.isEmpty &&
        publicUpdate.isEmpty) {
      return;
    }
    setState(() => _saving = true);
    try {
      await widget.saveUpdate(
        status: _status,
        internalNote: internalNote.isEmpty ? null : internalNote,
        publicUpdate: publicUpdate.isEmpty ? null : publicUpdate,
      );
      _internalNoteCtrl.clear();
      _publicUpdateCtrl.clear();
      await _load();
      await widget.onChanged();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: AppText('s4.lib.reports_admin_queue.report_update_saved'),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(e.toString().replaceFirst('Exception: ', '')),
          backgroundColor: AppTheme.errorOnSurface,
        ),
      );
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final detail = _detail ?? widget.initial;
    final title = _isIncident
        ? _text(
            detail['title'],
            fallback: s.lookup('s4.lib.reports_admin_queue.incident_report'),
          )
        : _text(
            detail['subject'],
            fallback: s.lookup('s4.lib.reports_admin_queue.staff_grievance'),
          );
    final number = _isIncident
        ? _text(detail['report_number'])
        : _text(detail['grievance_number']);
    final updates = _updatesFrom(detail);

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.9,
      minChildSize: 0.45,
      maxChildSize: 0.98,
      builder: (context, controller) {
        return Material(
          color: AppTheme.cardSurface,
          child: ListView(
            controller: controller,
            padding: EdgeInsets.fromLTRB(
              16,
              12,
              16,
              16 + MediaQuery.viewInsetsOf(context).bottom,
            ),
            children: [
              Center(
                child: Container(
                  width: 44,
                  height: 4,
                  decoration: BoxDecoration(
                    color: AppTheme.divider,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              const SizedBox(height: 14),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (number.isNotEmpty)
                          Text(
                            number,
                            style: TextStyle(
                              color: Theme.of(context).colorScheme.primary,
                              fontSize: 12,
                              fontWeight: FontWeight.w800,
                              letterSpacing: 0.4,
                            ),
                          ),
                        Text(
                          title,
                          style: TextStyle(
                            color: AppTheme.textPrimary,
                            fontSize: 18,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: AppStrings.of(context).lookup('action.close'),
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              if (_loading)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 32),
                  child: Center(child: CircularProgressIndicator()),
                )
              else if (_error != null)
                _ErrorPanel(message: _error!, onRetry: _load)
              else ...[
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    _StatusChip(status: _text(detail['status'])),
                    _MetaChip(
                      icon: Icons.person_outline,
                      label: _reporterLabel(detail, s),
                    ),
                    _MetaChip(
                      icon: Icons.schedule_outlined,
                      label: _formatDate(detail['created_at']),
                    ),
                    if (_text(detail['priority']).isNotEmpty)
                      _MetaChip(
                        icon: Icons.flag_outlined,
                        label: _priorityLabel(s, _text(detail['priority'])),
                      ),
                  ],
                ),
                const SizedBox(height: 16),
                _SectionTitle(s.lookup('s4.lib.reports_admin_queue.details')),
                _DetailRow(
                  label: _isIncident
                      ? s.lookup('s4.lib.reports_admin_queue.incident_type')
                      : s.lookup('s4.lib.reports_admin_queue.grievance_type'),
                  value: _reportTypeLabel(
                    s,
                    widget.type,
                    _text(
                      _isIncident
                          ? detail['incident_type']
                          : detail['grievance_type'],
                    ),
                  ),
                ),
                if (_isIncident)
                  _DetailRow(
                    label: s.lookup('s4.lib.reports_admin_queue.severity'),
                    value: _severityLabel(s, _text(detail['severity'])),
                  ),
                if (_text(detail['department']).isNotEmpty)
                  _DetailRow(
                    label: s.lookup('s4.lib.reports_admin_queue.department'),
                    value: _text(detail['department']),
                  ),
                if (_text(detail['location']).isNotEmpty)
                  _DetailRow(
                    label: s.lookup('s4.lib.reports_admin_queue.location'),
                    value: _text(detail['location']),
                  ),
                if (_text(detail['against_whom']).isNotEmpty)
                  _DetailRow(
                    label: s.lookup('s4.lib.reports_admin_queue.against_whom'),
                    value: _text(detail['against_whom']),
                  ),
                const SizedBox(height: 8),
                _BodyBlock(
                  title: _isIncident
                      ? s.lookup('s4.lib.reports_admin_queue.description')
                      : s.lookup('s4.lib.reports_admin_queue.concern'),
                  body: _text(
                    detail['description'],
                    fallback: s.lookup(
                      's4.lib.reports_admin_queue.no_details_recorded',
                    ),
                  ),
                ),
                if (_text(detail['resolution']).isNotEmpty)
                  _BodyBlock(
                    title: s.lookup('s4.lib.reports_admin_queue.resolution'),
                    body: _text(detail['resolution']),
                  ),
                const SizedBox(height: 16),
                _SectionTitle(s.lookup('s4.lib.reports_admin_queue.action')),
                DropdownButtonFormField<String>(
                  initialValue: widget.statuses.contains(_status)
                      ? _status
                      : widget.statuses.first,
                  decoration: InputDecoration(
                    labelText: AppStrings.of(context)
                        .lookup('clinical_inbox.status'),
                  ),
                  items: widget.statuses
                      .map(
                        (status) => DropdownMenuItem(
                          value: status,
                          child: Text(_statusLabel(s, status)),
                        ),
                      )
                      .toList(),
                  onChanged: (value) => setState(() => _status = value),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: _publicUpdateCtrl,
                  maxLines: 2,
                  decoration: InputDecoration(
                    labelText: AppStrings.of(context)
                        .lookup('s4.lib.reports_admin_queue.public_update'),
                    hintText: AppStrings.of(context).lookup('label.optional'),
                  ),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: _internalNoteCtrl,
                  maxLines: 2,
                  decoration: InputDecoration(
                    labelText: AppStrings.of(context).lookup(
                      's4.lib.reports_admin_queue.internal_hr_admin_note',
                    ),
                    hintText: AppStrings.of(context).lookup('label.optional'),
                  ),
                ),
                const SizedBox(height: 12),
                FilledButton.icon(
                  onPressed: _saving ? null : _save,
                  icon: _saving
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.save_outlined),
                  label: const AppText(
                    's4.lib.reports_admin_queue.save_update',
                  ),
                ),
                const SizedBox(height: 20),
                _SectionTitle(
                  s.lookup('s4.lib.reports_admin_queue.activity_log'),
                ),
                if (updates.isEmpty)
                  AppText(
                    's4.lib.reports_admin_queue.no_activity_recorded',
                    style: TextStyle(color: AppTheme.textSecondary),
                  )
                else
                  ...updates.map(_LogRow.new),
              ],
            ],
          ),
        );
      },
    );
  }

  List<Map<String, dynamic>> _updatesFrom(Map<String, dynamic> detail) {
    final raw = detail['updates'] ?? detail['audit_trail'];
    if (raw is List) {
      return raw
          .whereType<Map>()
          .map((row) => Map<String, dynamic>.from(row))
          .toList();
    }
    return const [];
  }
}

class _AccessPanel extends StatelessWidget {
  const _AccessPanel({required this.role});

  final StaffRole role;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Card(
      color: AppTheme.cardSurface,
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.lock_outline, color: AppTheme.textSecondary, size: 42),
            const SizedBox(height: 12),
            AppText(
              's4.lib.reports_admin_queue.hr_admin_access_required',
              style: TextStyle(
                color: AppTheme.textPrimary,
                fontSize: 17,
                fontWeight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              s.format('s4.dynamic.reports_admin_queue.current_role', {
                'role': s.lookup(role.displayNameKey),
              }),
              textAlign: TextAlign.center,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ],
        ),
      ),
    );
  }
}

class _ErrorPanel extends StatelessWidget {
  const _ErrorPanel({required this.message, required this.onRetry});

  final String message;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.error_outline, color: AppTheme.errorOnSurface, size: 42),
            const SizedBox(height: 10),
            Text(
              message,
              textAlign: TextAlign.center,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh),
              label: const AppText('action.retry'),
            ),
          ],
        ),
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.status});

  final String status;

  @override
  Widget build(BuildContext context) {
    final color = _statusColor(status);
    final s = AppStrings.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: color.withValues(alpha: 0.7)),
      ),
      child: Text(
        _statusLabel(s, status),
        style: TextStyle(
          color: color,
          fontSize: 11,
          fontWeight: FontWeight.w800,
        ),
      ),
    );
  }
}

class _MetaChip extends StatelessWidget {
  const _MetaChip({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 6),
      decoration: BoxDecoration(
        color: AppTheme.backgroundGrey,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14, color: AppTheme.textSecondary),
          const SizedBox(width: 5),
          Text(
            label.isEmpty ? '-' : label,
            style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
          ),
        ],
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text(
        text,
        style: TextStyle(
          color: AppTheme.textPrimary,
          fontSize: 15,
          fontWeight: FontWeight.w800,
        ),
      ),
    );
  }
}

class _DetailRow extends StatelessWidget {
  const _DetailRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 120,
            child: Text(
              label,
              style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
            ),
          ),
          Expanded(
            child: Text(
              value.isEmpty ? '-' : value,
              style: TextStyle(
                color: AppTheme.textPrimary,
                fontSize: 13,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _BodyBlock extends StatelessWidget {
  const _BodyBlock({required this.title, required this.body});

  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(top: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppTheme.backgroundGrey,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: TextStyle(
              color: AppTheme.textPrimary,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 5),
          Text(body, style: TextStyle(color: AppTheme.textSecondary)),
        ],
      ),
    );
  }
}

class _LogRow extends StatelessWidget {
  const _LogRow(this.update);

  final Map<String, dynamic> update;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final internal = update['is_internal'] == true;
    final role = _text(update['author_role'], fallback: 'system');
    final author = _text(update['author_name']);
    final subtitle = [
      if (author.isNotEmpty) author,
      role.toUpperCase(),
      _formatDate(update['created_at']),
      if (internal) s.lookup('s4.lib.reports_admin_queue.internal'),
    ].where((part) => part.isNotEmpty).join(' | ');

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: AppTheme.backgroundGrey,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            internal ? Icons.lock_outline : Icons.campaign_outlined,
            size: 18,
            color: internal
                ? AppTheme.warningOnSurface
                : AppTheme.textSecondary,
          ),
          const SizedBox(width: 9),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  _text(
                    update['message'],
                    fallback: s.lookup(
                      's4.lib.reports_admin_queue.update_recorded',
                    ),
                  ),
                  style: TextStyle(
                    color: AppTheme.textPrimary,
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  subtitle,
                  style: TextStyle(color: AppTheme.textSecondary, fontSize: 11),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

String _text(dynamic value, {String fallback = ''}) {
  final text = value?.toString().trim() ?? '';
  if (text.isEmpty || text.toLowerCase() == 'null') return fallback;
  return text;
}

String _reporterLabel(Map<String, dynamic> report, AppStrings s) {
  final reporter = _text(report['reporter_name']);
  final anonymous =
      report['is_anonymous'] == true || reporter.toLowerCase() == 'anonymous';
  final visible = reporter.isNotEmpty
      ? reporter
      : (anonymous ? s.lookup('s4.lib.reports_admin_queue.anonymous') : '-');
  final privilegedSender = _text(report['anonymous_reporter_name']);
  if (anonymous && privilegedSender.isNotEmpty) {
    return s.format('s4.dynamic.reports_admin_queue.anonymous_with_sender', {
      'sender': privilegedSender,
    });
  }
  return visible;
}

int _intValue(dynamic value) {
  if (value is int) return value;
  return int.tryParse(value?.toString() ?? '') ?? 0;
}

String _formatDate(dynamic value) {
  final text = _text(value);
  if (text.isEmpty) return '';
  final parsed = DateTime.tryParse(text);
  if (parsed == null) return text;
  return DateFormat('d MMM yyyy, h:mm a').format(parsed.toLocal());
}

String _titleCase(String value) {
  return value
      .split(' ')
      .where((part) => part.isNotEmpty)
      .map((part) => part[0].toUpperCase() + part.substring(1).toLowerCase())
      .join(' ');
}

Color _statusColor(String status) {
  switch (status) {
    case 'submitted':
    case 'acknowledged':
      return ThemeData.estimateBrightnessForColor(AppTheme.cardSurface) ==
              Brightness.dark
          ? const Color(0xFF90CAF9)
          : const Color(0xFF1565C0);
    case 'under_review':
    case 'investigating':
    case 'mediation':
      return AppTheme.warningOnSurface;
    case 'resolved':
      return AppTheme.successOnSurface;
    case 'closed':
      return AppTheme.textSecondary;
    case 'escalated':
      return AppTheme.errorOnSurface;
    default:
      return AppTheme.textSecondary;
  }
}
