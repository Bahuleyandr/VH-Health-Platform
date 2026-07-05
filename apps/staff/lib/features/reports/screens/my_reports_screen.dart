import 'package:flutter/material.dart';
import '../../../core/services/hr_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';

class MyReportsScreen extends StatefulWidget {
  const MyReportsScreen({super.key});

  @override
  State<MyReportsScreen> createState() => _MyReportsScreenState();
}

class _MyReportsScreenState extends State<MyReportsScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;
  List<dynamic> _incidents = [];
  List<dynamic> _grievances = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _load();
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final results = await Future.wait([
        HrApiService.getMyIncidents().catchError((_) => <dynamic>[]),
        HrApiService.getMyGrievances().catchError((_) => <dynamic>[]),
      ]);
      if (mounted) {
        setState(() {
          _incidents = results[0];
          _grievances = results[1];
        });
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Color _statusColor(String status) {
    switch (status) {
      case 'submitted':
        return Theme.of(context).colorScheme.primary;
      case 'under_review':
      case 'acknowledged':
        return Colors.orange;
      case 'investigating':
      case 'mediation':
        return Colors.purple;
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

  Color _severityColor(String severity) {
    switch (severity) {
      case 'low':
        return AppTheme.successOnSurface;
      case 'moderate':
        return Colors.orange;
      case 'severe':
        return AppTheme.errorOnSurface;
      case 'sentinel':
        return AppTheme.errorOnSurface;
      default:
        return AppTheme.textSecondary;
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(s.myReportsTitle),
        actions: const [LogoutAction()],
        bottom: TabBar(
          controller: _tabController,
          tabs: [
            Tab(text: '${s.myReportsTabIncidents} (${_incidents.length})'),
            Tab(text: '${s.myReportsTabGrievances} (${_grievances.length})'),
          ],
        ),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : TabBarView(
              controller: _tabController,
              children: [_buildIncidentsList(), _buildGrievancesList()],
            ),
    );
  }

  Widget _buildIncidentsList() {
    final s = AppStrings.of(context);
    if (_incidents.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.check_circle_outline,
              size: 48,
              color: AppTheme.textSecondary,
            ),
            const SizedBox(height: 8),
            Text(
              s.myReportsEmptyIncidents,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.builder(
        padding: const EdgeInsets.all(8),
        itemCount: _incidents.length,
        itemBuilder: (ctx, i) {
          final inc = _incidents[i] as Map<String, dynamic>;
          final severity = inc['severity'] as String? ?? 'moderate';
          final status = inc['status'] as String? ?? 'submitted';
          final type = (inc['incident_type'] as String? ?? '').replaceAll(
            '_',
            ' ',
          );

          return Card(
            color: AppTheme.cardSurface,
            child: ListTile(
              leading: Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: _severityColor(severity).withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Icon(
                  Icons.warning_amber_rounded,
                  color: _severityColor(severity),
                  size: 22,
                ),
              ),
              title: Text(
                inc['title'] as String? ?? '',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: AppTheme.textPrimary,
                  fontWeight: FontWeight.w600,
                  fontSize: 14,
                ),
              ),
              subtitle: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    inc['report_number'] as String? ?? '',
                    style: const TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.bold,
                      letterSpacing: 0.5,
                    ),
                  ),
                  Text(
                    type.toUpperCase(),
                    style: TextStyle(
                      fontSize: 10,
                      color: AppTheme.textSecondary,
                      letterSpacing: 0.5,
                    ),
                  ),
                ],
              ),
              isThreeLine: true,
              trailing: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: _statusColor(status).withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: _statusColor(status)),
                ),
                child: Text(
                  status.replaceAll('_', ' ').toUpperCase(),
                  style: TextStyle(
                    fontSize: 9,
                    color: _statusColor(status),
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
              onTap: () => _showIncidentDetail(inc),
            ),
          );
        },
      ),
    );
  }

  void _showIncidentDetail(Map<String, dynamic> inc) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) => DraggableScrollableSheet(
        initialChildSize: 0.6,
        maxChildSize: 0.95,
        minChildSize: 0.4,
        expand: false,
        builder: (_, ctrl) => Material(
          color: AppTheme.cardSurface,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: ListView(
              controller: ctrl,
              children: [
                Text(
                  inc['report_number'] as String? ?? '',
                  style: TextStyle(
                    fontWeight: FontWeight.bold,
                    fontSize: 16,
                    color: Theme.of(context).colorScheme.primary,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  inc['title'] as String? ?? '',
                  style: TextStyle(
                    color: AppTheme.textPrimary,
                    fontWeight: FontWeight.w600,
                    fontSize: 15,
                  ),
                ),
                const SizedBox(height: 12),
                _detailRow(
                  'Status',
                  (inc['status'] as String? ?? '')
                      .replaceAll('_', ' ')
                      .toUpperCase(),
                ),
                _detailRow(
                  'Severity',
                  (inc['severity'] as String? ?? '').toUpperCase(),
                ),
                _detailRow(
                  'Type',
                  (inc['incident_type'] as String? ?? '').replaceAll('_', ' '),
                ),
                if (inc['location'] != null)
                  _detailRow('Location', inc['location'] as String),
                const Divider(),
                AppText(
                  'my_reports.label.description',
                  style: TextStyle(
                    color: AppTheme.textPrimary,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  inc['description'] as String? ?? '',
                  style: TextStyle(color: AppTheme.textSecondary),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildGrievancesList() {
    final s = AppStrings.of(context);
    if (_grievances.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.handshake_outlined,
              size: 48,
              color: AppTheme.textSecondary,
            ),
            const SizedBox(height: 8),
            Text(
              s.myReportsEmptyGrievances,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.builder(
        padding: const EdgeInsets.all(8),
        itemCount: _grievances.length,
        itemBuilder: (ctx, i) {
          final grv = _grievances[i] as Map<String, dynamic>;
          final status = grv['status'] as String? ?? 'submitted';
          final type = (grv['grievance_type'] as String? ?? '').replaceAll(
            '_',
            ' ',
          );

          return Card(
            color: AppTheme.cardSurface,
            child: ListTile(
              leading: Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: Colors.purple.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: const Icon(
                  Icons.support_agent_outlined,
                  color: Colors.purple,
                  size: 22,
                ),
              ),
              title: Text(
                grv['subject'] as String? ?? '',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: AppTheme.textPrimary,
                  fontWeight: FontWeight.w600,
                  fontSize: 14,
                ),
              ),
              subtitle: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    grv['grievance_number'] as String? ?? '',
                    style: const TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.bold,
                      letterSpacing: 0.5,
                      color: Colors.purple,
                    ),
                  ),
                  Text(
                    type.toUpperCase(),
                    style: TextStyle(
                      fontSize: 10,
                      color: AppTheme.textSecondary,
                      letterSpacing: 0.5,
                    ),
                  ),
                  if (grv['resolution'] != null)
                    Text(
                      '✓ ${grv['resolution']}',
                      style: TextStyle(
                        fontSize: 11,
                        color: AppTheme.successOnSurface,
                      ),
                    ),
                ],
              ),
              isThreeLine: true,
              trailing: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: _statusColor(status).withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: _statusColor(status)),
                ),
                child: Text(
                  status.replaceAll('_', ' ').toUpperCase(),
                  style: TextStyle(
                    fontSize: 9,
                    color: _statusColor(status),
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _detailRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          SizedBox(
            width: 80,
            child: Text(
              label,
              style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: TextStyle(
                color: AppTheme.textPrimary,
                fontWeight: FontWeight.w600,
                fontSize: 13,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
