import 'dart:async';

import 'package:flutter/material.dart';

import '../../../core/services/transplant_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/constrained_content.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';

class TransplantProgramScreen extends StatefulWidget {
  const TransplantProgramScreen({super.key});

  @override
  State<TransplantProgramScreen> createState() =>
      _TransplantProgramScreenState();
}

class _TransplantProgramScreenState extends State<TransplantProgramScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;
  Map<String, dynamic>? _dashboard;
  bool _loading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
    unawaited(_load());
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await TransplantApiService.getDashboard();
      if (!mounted) return;
      setState(() {
        _dashboard = Map<String, dynamic>.from(data['dashboard'] as Map);
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '';
        _loading = false;
      });
    }
  }

  List<Map<String, dynamic>> _rows(String key) {
    final raw = _dashboard?[key];
    if (raw is! List) return const [];
    return raw
        .whereType<Map>()
        .map((row) => Map<String, dynamic>.from(row))
        .toList(growable: false);
  }

  int _count(String key) {
    final counts = _dashboard?['counts'];
    if (counts is Map && counts[key] != null) {
      return int.tryParse('${counts[key]}') ?? 0;
    }
    return 0;
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(s.lookup('transplant.title')),
        actions: [
          IconButton(
            tooltip: s.actionRefresh,
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh),
          ),
          const LogoutAction(),
        ],
        bottom: TabBar(
          controller: _tabController,
          indicatorColor: Colors.white,
          labelColor: Colors.white,
          unselectedLabelColor: Colors.white70,
          tabs: [
            Tab(text: s.lookup('transplant.candidates')),
            Tab(text: s.lookup('transplant.waitlist')),
            Tab(text: s.lookup('transplant.committee')),
          ],
        ),
      ),
      body: ConstrainedContent(
        child: _loading && _dashboard == null
            ? _StatePanel(
                icon: Icons.sync,
                title: s.lookup('transplant.loading'),
                detail: '',
              )
            : _error != null
            ? _StatePanel(
                icon: Icons.error_outline,
                title: s.lookup('transplant.load_failed'),
                detail: _error!,
                actionLabel: s.actionRetry,
                onAction: _load,
              )
            : Column(
                children: [
                  _SummaryStrip(
                    programs: _count('programs'),
                    candidates: _count('candidates'),
                    listed: _count('listed'),
                    nottoExports: _count('notto_exports'),
                    enabled: _dashboard?['enabled'] == true,
                  ),
                  Expanded(
                    child: TabBarView(
                      controller: _tabController,
                      children: [
                        _CandidateList(rows: _rows('candidates')),
                        _WaitlistList(rows: _rows('waitlist')),
                        _CommitteeList(rows: _rows('committee_reviews')),
                      ],
                    ),
                  ),
                ],
              ),
      ),
    );
  }
}

class _SummaryStrip extends StatelessWidget {
  const _SummaryStrip({
    required this.programs,
    required this.candidates,
    required this.listed,
    required this.nottoExports,
    required this.enabled,
  });

  final int programs;
  final int candidates;
  final int listed;
  final int nottoExports;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Material(
      color: Colors.white,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          children: [
            if (!enabled)
              Container(
                width: double.infinity,
                margin: const EdgeInsets.only(bottom: 10),
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: AppTheme.warningAmber.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(s.lookup('transplant.disabled')),
              ),
            Row(
              children: [
                Expanded(
                  child: _MetricTile(
                    label: s.lookup('transplant.programs'),
                    value: '$programs',
                    icon: Icons.local_hospital_outlined,
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: _MetricTile(
                    label: s.lookup('transplant.candidates'),
                    value: '$candidates',
                    icon: Icons.group_outlined,
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: _MetricTile(
                    label: s.lookup('transplant.listed'),
                    value: '$listed',
                    icon: Icons.assignment_turned_in_outlined,
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: _MetricTile(
                    label: s.lookup('transplant.notto_exports'),
                    value: '$nottoExports',
                    icon: Icons.file_present_outlined,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _MetricTile extends StatelessWidget {
  const _MetricTile({
    required this.label,
    required this.value,
    required this.icon,
  });

  final String label;
  final String value;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        border: Border.all(color: theme.dividerColor),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 20, color: AppTheme.primaryBlue),
          const SizedBox(height: 8),
          Text(
            value,
            style: theme.textTheme.titleLarge?.copyWith(
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.bodySmall,
          ),
        ],
      ),
    );
  }
}

class _CandidateList extends StatelessWidget {
  const _CandidateList({required this.rows});

  final List<Map<String, dynamic>> rows;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    if (rows.isEmpty) {
      return _StatePanel(
        icon: Icons.assignment_ind_outlined,
        title: s.lookup('transplant.empty_candidates'),
        detail: '',
      );
    }
    return ListView.separated(
      padding: const EdgeInsets.all(12),
      itemBuilder: (context, index) {
        final row = rows[index];
        final organs = (row['required_organs'] as List? ?? const [])
            .map((organ) => _titleize('$organ'))
            .join(', ');
        return Card(
          child: ListTile(
            leading: const CircleAvatar(child: Icon(Icons.person_outline)),
            title: Text('${row['patient_name'] ?? row['patient_uid']}'),
            subtitle: Text('${row['diagnosis'] ?? ''}\n$organs'),
            isThreeLine: true,
            trailing: _StatusPill(
              label: _titleize('${row['listing_evaluation_status'] ?? '-'}'),
            ),
          ),
        );
      },
      separatorBuilder: (_, _) => const SizedBox(height: 8),
      itemCount: rows.length,
    );
  }
}

class _WaitlistList extends StatelessWidget {
  const _WaitlistList({required this.rows});

  final List<Map<String, dynamic>> rows;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    if (rows.isEmpty) {
      return _StatePanel(
        icon: Icons.playlist_add_check_outlined,
        title: s.lookup('transplant.empty_waitlist'),
        detail: '',
      );
    }
    return ListView.separated(
      padding: const EdgeInsets.all(12),
      itemBuilder: (context, index) {
        final row = rows[index];
        return Card(
          child: ListTile(
            leading: const CircleAvatar(
              child: Icon(Icons.assignment_turned_in_outlined),
            ),
            title: Text(
              '${s.lookup('transplant.candidate')} #${row['candidate_id']}',
            ),
            subtitle: Text('${row['reason'] ?? ''}'),
            trailing: _StatusPill(label: _titleize('${row['status']}')),
          ),
        );
      },
      separatorBuilder: (_, _) => const SizedBox(height: 8),
      itemCount: rows.length,
    );
  }
}

class _CommitteeList extends StatelessWidget {
  const _CommitteeList({required this.rows});

  final List<Map<String, dynamic>> rows;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    if (rows.isEmpty) {
      return _StatePanel(
        icon: Icons.groups_2_outlined,
        title: s.lookup('transplant.empty_committee'),
        detail: '',
      );
    }
    return ListView.separated(
      padding: const EdgeInsets.all(12),
      itemBuilder: (context, index) {
        final row = rows[index];
        return Card(
          child: ListTile(
            leading: const CircleAvatar(child: Icon(Icons.groups_2_outlined)),
            title: Text('${s.lookup('transplant.committee')} #${row['id']}'),
            subtitle: Text(
              '${s.lookup('transplant.quorum')}: ${row['quorum_policy_reference'] ?? '-'}',
            ),
            trailing: _StatusPill(label: _titleize('${row['decision']}')),
          ),
        );
      },
      separatorBuilder: (_, _) => const SizedBox(height: 8),
      itemCount: rows.length,
    );
  }
}

class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: AppTheme.primaryBlue.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: const TextStyle(
          color: AppTheme.primaryBlue,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

class _StatePanel extends StatelessWidget {
  const _StatePanel({
    required this.icon,
    required this.title,
    required this.detail,
    this.actionLabel,
    this.onAction,
  });

  final IconData icon;
  final String title;
  final String detail;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 56, color: theme.colorScheme.outline),
            const SizedBox(height: 12),
            Text(
              title,
              textAlign: TextAlign.center,
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w800,
              ),
            ),
            if (detail.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(
                detail,
                textAlign: TextAlign.center,
                style: theme.textTheme.bodyMedium,
              ),
            ],
            if (actionLabel != null && onAction != null) ...[
              const SizedBox(height: 16),
              FilledButton(onPressed: onAction, child: Text(actionLabel!)),
            ],
          ],
        ),
      ),
    );
  }
}

String _titleize(String value) {
  return value
      .replaceAll('_', ' ')
      .split(' ')
      .where((part) => part.isNotEmpty)
      .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
      .join(' ');
}
