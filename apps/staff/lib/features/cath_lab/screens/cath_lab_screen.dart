import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../core/widgets/states/empty_state.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';
import '../../../l10n/app_strings.dart';
import '../services/cath_lab_api_service.dart';

typedef CathLabCaseLoader =
    Future<List<CathLabCaseSummary>> Function(DateTime date);

class CathLabScreen extends StatefulWidget {
  const CathLabScreen({super.key, this.loadCases});

  final CathLabCaseLoader? loadCases;

  @override
  State<CathLabScreen> createState() => _CathLabScreenState();
}

class _CathLabScreenState extends State<CathLabScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;
  DateTime _selectedDate = DateTime.now();
  bool _loading = true;
  String? _error;
  List<CathLabCaseSummary> _cases = const [];

  String get _dateLabel => DateFormat('dd MMM yyyy').format(_selectedDate);

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 5, vsync: this);
    _loadCases();
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _loadCases({bool showLoading = true}) async {
    if (mounted && showLoading) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final loader = widget.loadCases ?? CathLabApiService.fetchCasesForDate;
      final cases = await loader(_selectedDate);
      if (!mounted) return;
      setState(() {
        _cases = cases;
        _loading = false;
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _selectedDate,
      firstDate: DateTime.now().subtract(const Duration(days: 90)),
      lastDate: DateTime.now().add(const Duration(days: 180)),
    );
    if (picked == null || picked == _selectedDate) return;
    setState(() => _selectedDate = picked);
    await _loadCases();
  }

  Future<void> _refreshCases() => _loadCases(showLoading: false);

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(s.lookup('s4.lib.cath_lab.cath_lab')),
        actions: [
          IconButton(
            tooltip: s.lookup('theatre.pick_date'),
            icon: const Icon(Icons.calendar_today),
            onPressed: _pickDate,
          ),
          IconButton(
            tooltip: s.actionRefresh,
            icon: const Icon(Icons.refresh),
            onPressed: _refreshCases,
          ),
          const LogoutAction(),
        ],
        bottom: TabBar(
          controller: _tabController,
          isScrollable: true,
          indicatorColor: Colors.white,
          labelColor: Colors.white,
          unselectedLabelColor: Colors.white70,
          tabs: [
            Tab(text: s.lookup('s4.lib.cath_lab.tab.schedule')),
            Tab(text: s.lookup('s4.lib.cath_lab.readiness')),
            Tab(text: s.lookup('s4.lib.cath_lab.tab.procedure')),
            Tab(text: s.lookup('s4.lib.cath_lab.tab.dose')),
            Tab(text: s.lookup('s4.lib.cath_lab.tab.post_orders')),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: [
          _buildBody(_buildScheduleTab),
          _buildBody(_buildReadinessTab),
          _buildBody(_buildProcedureTab),
          _buildBody(_buildDoseTab),
          _buildBody(_buildPostOrdersTab),
        ],
      ),
    );
  }

  Widget _buildBody(Widget Function(List<CathLabCaseSummary> cases) builder) {
    if (_error != null) {
      return ErrorState(message: _error!, onRetry: () => _loadCases());
    }
    if (_loading) return const SkeletonList();
    return RefreshIndicator(onRefresh: _refreshCases, child: builder(_cases));
  }

  Widget _buildScheduleTab(List<CathLabCaseSummary> cases) {
    if (cases.isEmpty) return _emptyState(Icons.event_busy_outlined);
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: cases.length,
      itemBuilder: (context, index) =>
          _CathLabCaseCard(cathCase: cases[index], dateLabel: _dateLabel),
    );
  }

  Widget _buildReadinessTab(List<CathLabCaseSummary> cases) {
    if (cases.isEmpty) return _emptyState(Icons.checklist_rtl_outlined);
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: cases.length,
      itemBuilder: (context, index) => _ReadinessCard(cathCase: cases[index]),
    );
  }

  Widget _buildProcedureTab(List<CathLabCaseSummary> cases) {
    if (cases.isEmpty) return _emptyState(Icons.monitor_heart_outlined);
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: cases.length,
      itemBuilder: (context, index) => _StageCard(
        cathCase: cases[index],
        icon: Icons.monitor_heart_outlined,
        title: 's4.lib.cath_lab.procedure_logs',
        countKey: 's4.lib.cath_lab.procedure_logs_count',
        count: cases[index].procedureCount,
        emptyKey: 's4.lib.cath_lab.procedure_pending',
        extraKey: 's4.lib.cath_lab.device_links_count',
        extraCount: cases[index].deviceLinkCount,
      ),
    );
  }

  Widget _buildDoseTab(List<CathLabCaseSummary> cases) {
    if (cases.isEmpty) return _emptyState(Icons.science_outlined);
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: cases.length,
      itemBuilder: (context, index) => _StageCard(
        cathCase: cases[index],
        icon: Icons.science_outlined,
        title: 's4.lib.cath_lab.dose_records',
        countKey: 's4.lib.cath_lab.dose_records_count',
        count: cases[index].doseRecordCount,
        emptyKey: 's4.lib.cath_lab.dose_pending',
      ),
    );
  }

  Widget _buildPostOrdersTab(List<CathLabCaseSummary> cases) {
    if (cases.isEmpty) return _emptyState(Icons.assignment_turned_in_outlined);
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: cases.length,
      itemBuilder: (context, index) => _StageCard(
        cathCase: cases[index],
        icon: Icons.assignment_turned_in_outlined,
        title: 's4.lib.cath_lab.post_orders',
        countKey: 's4.lib.cath_lab.post_orders_count',
        count: cases[index].activePostOrderCount,
        emptyKey: 's4.lib.cath_lab.post_orders_pending',
      ),
    );
  }

  Widget _emptyState(IconData icon) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        SizedBox(
          height: MediaQuery.sizeOf(context).height * 0.55,
          child: EmptyState(
            icon: icon,
            title: AppStrings.of(context).lookup('s4.lib.cath_lab.no_cases'),
            body: _dateLabel,
          ),
        ),
      ],
    );
  }
}

class _CathLabCaseCard extends StatelessWidget {
  const _CathLabCaseCard({required this.cathCase, required this.dateLabel});

  final CathLabCaseSummary cathCase;
  final String dateLabel;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final time = cathCase.plannedStartAt == null
        ? s.lookup('s4.lib.cath_lab.time_not_set')
        : DateFormat('hh:mm a').format(cathCase.plannedStartAt!);
    final room = cathCase.labRoom.isEmpty
        ? s.lookup('s4.lib.cath_lab.room_unassigned')
        : cathCase.labRoom;
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Text(
                    cathCase.requestedProcedure.isEmpty
                        ? s.lookup('s4.lib.cath_lab.procedure_not_set')
                        : cathCase.requestedProcedure,
                    style: TextStyle(
                      color: AppTheme.textPrimary,
                      fontSize: 16,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                _StatusChip(
                  label: _statusLabel(s, cathCase.status),
                  color: _statusColor(cathCase.status),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 12,
              runSpacing: 8,
              children: [
                _InfoPill(
                  icon: Icons.person_outline,
                  label: _patientLabel(s, cathCase),
                ),
                _InfoPill(icon: Icons.access_time, label: '$time - $dateLabel'),
                _InfoPill(icon: Icons.meeting_room_outlined, label: room),
                _InfoPill(
                  icon: Icons.priority_high_outlined,
                  label: _urgencyLabel(s, cathCase.urgency),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _ReadinessCard extends StatelessWidget {
  const _ReadinessCard({required this.cathCase});

  final CathLabCaseSummary cathCase;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final color = cathCase.readinessComplete
        ? AppTheme.successGreen
        : AppTheme.warningAmber;
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _CaseHeader(cathCase: cathCase),
            const SizedBox(height: 14),
            ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: LinearProgressIndicator(
                value: cathCase.readinessProgress,
                minHeight: 8,
                color: color,
                backgroundColor: color.withValues(alpha: 0.16),
              ),
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Icon(
                  cathCase.readinessComplete
                      ? Icons.verified_outlined
                      : Icons.pending_actions_outlined,
                  color: color,
                  size: 18,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    cathCase.readinessComplete
                        ? s.lookup('s4.lib.cath_lab.ready_for_procedure')
                        : s.lookup('s4.lib.cath_lab.readiness_blocking'),
                    style: TextStyle(
                      color: AppTheme.textPrimary,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                Text(
                  s.format('s4.lib.cath_lab.readiness_clear', {
                    'cleared': cathCase.readinessCleared,
                    'total': cathCase.readinessTotal,
                  }),
                  style: TextStyle(color: AppTheme.textSecondary),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _StageCard extends StatelessWidget {
  const _StageCard({
    required this.cathCase,
    required this.icon,
    required this.title,
    required this.countKey,
    required this.count,
    required this.emptyKey,
    this.extraKey,
    this.extraCount,
  });

  final CathLabCaseSummary cathCase;
  final IconData icon;
  final String title;
  final String countKey;
  final int count;
  final String emptyKey;
  final String? extraKey;
  final int? extraCount;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final hasEvidence = count > 0;
    final color = hasEvidence ? AppTheme.successGreen : AppTheme.warningAmber;
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _CaseHeader(cathCase: cathCase),
            const SizedBox(height: 14),
            Row(
              children: [
                CircleAvatar(
                  backgroundColor: color.withValues(alpha: 0.15),
                  foregroundColor: color,
                  child: Icon(icon),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        s.lookup(title),
                        style: const TextStyle(fontWeight: FontWeight.w700),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        hasEvidence
                            ? s.format(countKey, {'count': count})
                            : s.lookup(emptyKey),
                        style: TextStyle(color: AppTheme.textSecondary),
                      ),
                    ],
                  ),
                ),
                if (extraKey != null && extraCount != null)
                  _StatusChip(
                    label: s.format(extraKey!, {'count': extraCount}),
                    color: AppTheme.primaryBlue,
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _CaseHeader extends StatelessWidget {
  const _CaseHeader({required this.cathCase});

  final CathLabCaseSummary cathCase;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                cathCase.requestedProcedure.isEmpty
                    ? s.lookup('s4.lib.cath_lab.procedure_not_set')
                    : cathCase.requestedProcedure,
                style: TextStyle(
                  color: AppTheme.textPrimary,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                _patientLabel(s, cathCase),
                style: TextStyle(color: AppTheme.textSecondary),
              ),
            ],
          ),
        ),
        const SizedBox(width: 10),
        _StatusChip(
          label: _statusLabel(s, cathCase.status),
          color: _statusColor(cathCase.status),
        ),
      ],
    );
  }
}

class _InfoPill extends StatelessWidget {
  const _InfoPill({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 16, color: AppTheme.textSecondary),
        const SizedBox(width: 5),
        Text(label, style: TextStyle(color: AppTheme.textSecondary)),
      ],
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontSize: 12,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

Color _statusColor(String status) {
  return switch (status.toLowerCase()) {
    'ready' || 'completed' => AppTheme.successGreen,
    'in_progress' => AppTheme.primaryBlue,
    'readiness_pending' || 'scheduled' => AppTheme.warningAmber,
    'cancelled' => AppTheme.errorRed,
    _ => Colors.grey,
  };
}

String _patientLabel(AppStrings s, CathLabCaseSummary cathCase) {
  if (cathCase.patientName.isNotEmpty) return cathCase.patientName;
  if (cathCase.patientUid.isEmpty) {
    return s.lookup('s4.lib.cath_lab.unknown_patient');
  }
  final uid = cathCase.patientUid;
  return uid.length > 8 ? '${uid.substring(0, 8)}...' : uid;
}

String _statusLabel(AppStrings s, String status) {
  final key = 's4.lib.cath_lab.status.${status.toLowerCase()}';
  final label = s.lookup(key);
  return label == key ? _titleize(status) : label;
}

String _urgencyLabel(AppStrings s, String urgency) {
  final key = 's4.lib.cath_lab.urgency.${urgency.toLowerCase()}';
  final label = s.lookup(key);
  return label == key ? _titleize(urgency) : label;
}

String _titleize(String value) {
  final text = value.replaceAll('_', ' ').trim();
  if (text.isEmpty) return '-';
  return text
      .split(' ')
      .map((part) {
        if (part.isEmpty) return part;
        return '${part[0].toUpperCase()}${part.substring(1)}';
      })
      .join(' ');
}
