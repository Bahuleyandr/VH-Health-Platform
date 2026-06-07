import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../core/config/api_config.dart';
import '../../../core/config/role_config.dart';
import '../../../core/services/diagnostics_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../core/widgets/states/empty_state.dart';

class StaffDiagnosticsScreen extends StatefulWidget {
  const StaffDiagnosticsScreen({super.key});

  @override
  State<StaffDiagnosticsScreen> createState() => _StaffDiagnosticsScreenState();
}

class _StaffDiagnosticsScreenState extends State<StaffDiagnosticsScreen> {
  final _dateFmt = DateFormat('dd/MM/yyyy HH:mm:ss');
  StaffRole _role = StaffRole.general;
  bool _roleLoaded = false;
  bool _loading = false;
  String? _error;
  StaffDiagnosticsSnapshot? _snapshot;

  bool get _allowed => _role.isAdminTier;

  @override
  void initState() {
    super.initState();
    _loadRoleAndDiagnostics();
  }

  Future<void> _loadRoleAndDiagnostics() async {
    final role = StaffRole.fromString(await ApiConfig.getRole());
    if (!mounted) return;
    setState(() {
      _role = role;
      _roleLoaded = true;
    });
    if (role.isAdminTier) await _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final snapshot = await DiagnosticsApiService.load();
      if (mounted) setState(() => _snapshot = snapshot);
    } catch (e) {
      if (mounted) {
        setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: const Text('Staff Diagnostics'),
        actions: [
          IconButton(
            tooltip: 'Refresh diagnostics',
            onPressed: _allowed && !_loading ? _load : null,
            icon: const Icon(Icons.refresh),
          ),
          const LogoutAction(),
        ],
      ),
      body: !_roleLoaded
          ? const Center(child: CircularProgressIndicator())
          : !_allowed
          ? const EmptyState(
              icon: Icons.lock_outline,
              title: 'Admin access required',
              body:
                  'Staff diagnostics are available only to Admin and Super Admin roles.',
            )
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  if (_loading && _snapshot == null)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 36),
                      child: Center(child: CircularProgressIndicator()),
                    )
                  else ...[
                    if (_error != null) _ErrorBanner(message: _error!),
                    if (_snapshot != null) ...[
                      _RuntimeHeader(
                        snapshot: _snapshot!,
                        generatedLabel: _dateFmt.format(_snapshot!.generatedAt),
                      ),
                      const SizedBox(height: 14),
                      _ChecksGrid(checks: _snapshot!.checks),
                      const SizedBox(height: 14),
                      _PolicyPanel(check: _snapshot!.check('role_policy')),
                      const SizedBox(height: 14),
                      _VersionPanel(check: _snapshot!.check('backend_version')),
                      const SizedBox(height: 14),
                      _ProfilePanel(check: _snapshot!.check('staff_profile')),
                    ],
                    if (_loading)
                      const Padding(
                        padding: EdgeInsets.only(top: 16),
                        child: LinearProgressIndicator(),
                      ),
                  ],
                ],
              ),
            ),
    );
  }
}

class _RuntimeHeader extends StatelessWidget {
  final StaffDiagnosticsSnapshot snapshot;
  final String generatedLabel;

  const _RuntimeHeader({required this.snapshot, required this.generatedLabel});

  @override
  Widget build(BuildContext context) {
    final ok = snapshot.allRequiredOk;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                ok ? Icons.verified_outlined : Icons.warning_amber_outlined,
                color: ok
                    ? AppTheme.successOnSurface
                    : AppTheme.warningOnSurface,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  ok
                      ? 'Trial runtime checks are clean'
                      : 'Runtime checks need review',
                  style: TextStyle(
                    color: AppTheme.textPrimary,
                    fontSize: 18,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _MetaChip(label: 'API', value: snapshot.apiBaseUrl),
              _MetaChip(label: 'Role', value: snapshot.role),
              if (snapshot.employeeId != null)
                _MetaChip(label: 'Employee', value: snapshot.employeeId!),
              if (snapshot.staffId != null)
                _MetaChip(label: 'Staff ID', value: snapshot.staffId!),
              if (snapshot.staffUid != null)
                _MetaChip(label: 'UID', value: snapshot.staffUid!),
              _MetaChip(label: 'Generated', value: generatedLabel),
            ],
          ),
        ],
      ),
    );
  }
}

class _ChecksGrid extends StatelessWidget {
  final List<DiagnosticsCheck> checks;

  const _ChecksGrid({required this.checks});

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final columns = constraints.maxWidth >= 1100
            ? 3
            : constraints.maxWidth >= 720
            ? 2
            : 1;
        const gap = 10.0;
        final itemWidth =
            (constraints.maxWidth - ((columns - 1) * gap)) / columns;
        return Wrap(
          spacing: gap,
          runSpacing: gap,
          children: [
            for (final check in checks)
              SizedBox(
                width: itemWidth,
                child: _CheckCard(check: check),
              ),
          ],
        );
      },
    );
  }
}

class _CheckCard extends StatelessWidget {
  final DiagnosticsCheck check;

  const _CheckCard({required this.check});

  @override
  Widget build(BuildContext context) {
    final color = check.ok
        ? AppTheme.successOnSurface
        : AppTheme.errorOnSurface;
    return Container(
      constraints: const BoxConstraints(minHeight: 112),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                check.ok ? Icons.check_circle_outline : Icons.error_outline,
                color: color,
                size: 20,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  check.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: AppTheme.textPrimary,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ),
              Text(
                check.statusCode?.toString() ?? '-',
                style: TextStyle(color: color, fontWeight: FontWeight.w900),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            check.path,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: AppTheme.textSecondary,
              fontSize: 12,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            check.message,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
          ),
        ],
      ),
    );
  }
}

class _PolicyPanel extends StatelessWidget {
  final DiagnosticsCheck? check;

  const _PolicyPanel({required this.check});

  @override
  Widget build(BuildContext context) {
    final data = check?.data ?? const <String, dynamic>{};
    final roles = data['roles'];
    final roleCount = roles is List ? roles.length : null;
    return _DetailPanel(
      icon: Icons.account_tree_outlined,
      title: 'Role Policy',
      rows: [
        _DetailRow('Version', data['policy_version'] ?? data['version']),
        _DetailRow('Hash', data['policy_hash']),
        _DetailRow('Roles', roleCount),
        _DetailRow('Generated', data['generated_at']),
      ],
    );
  }
}

class _VersionPanel extends StatelessWidget {
  final DiagnosticsCheck? check;

  const _VersionPanel({required this.check});

  @override
  Widget build(BuildContext context) {
    final data = check?.data ?? const <String, dynamic>{};
    return _DetailPanel(
      icon: Icons.commit_outlined,
      title: 'Backend Version',
      rows: [
        _DetailRow('Commit', data['commit']),
        _DetailRow('Branch', data['branch']),
        _DetailRow('Built at', data['built_at']),
        _DetailRow('Node env', data['node_env']),
        _DetailRow('Uptime seconds', data['uptime_seconds']),
      ],
    );
  }
}

class _ProfilePanel extends StatelessWidget {
  final DiagnosticsCheck? check;

  const _ProfilePanel({required this.check});

  @override
  Widget build(BuildContext context) {
    final data = check?.data ?? const <String, dynamic>{};
    final staff = data['staff'] is Map
        ? Map<String, dynamic>.from(data['staff'] as Map)
        : data;
    return _DetailPanel(
      icon: Icons.badge_outlined,
      title: 'Signed-in Staff',
      rows: [
        _DetailRow('Name', staff['name']),
        _DetailRow('Role', staff['role']),
        _DetailRow('Department', staff['department']),
        _DetailRow('UID', staff['uid']),
        _DetailRow('Employee ID', staff['employee_id'] ?? staff['employeeId']),
      ],
    );
  }
}

class _DetailPanel extends StatelessWidget {
  final IconData icon;
  final String title;
  final List<_DetailRow> rows;

  const _DetailPanel({
    required this.icon,
    required this.title,
    required this.rows,
  });

  @override
  Widget build(BuildContext context) {
    final visible = rows
        .where((row) => row.value != null && '${row.value}'.trim().isNotEmpty)
        .toList(growable: false);
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, color: AppTheme.primaryBlue),
              const SizedBox(width: 10),
              Text(
                title,
                style: TextStyle(
                  color: AppTheme.textPrimary,
                  fontWeight: FontWeight.w900,
                  fontSize: 16,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (visible.isEmpty)
            Text(
              'No details returned.',
              style: TextStyle(color: AppTheme.textSecondary),
            )
          else
            for (final row in visible) _DetailLine(row: row),
        ],
      ),
    );
  }
}

class _DetailLine extends StatelessWidget {
  final _DetailRow row;

  const _DetailLine({required this.row});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 130,
            child: Text(
              row.label,
              style: TextStyle(
                color: AppTheme.textSecondary,
                fontSize: 12,
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
          Expanded(
            child: SelectableText(
              '${row.value}',
              style: TextStyle(
                color: AppTheme.textPrimary,
                fontSize: 13,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _DetailRow {
  final String label;
  final Object? value;

  const _DetailRow(this.label, this.value);
}

class _MetaChip extends StatelessWidget {
  final String label;
  final String value;

  const _MetaChip({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(maxWidth: 360),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: AppTheme.primaryBlue.withValues(alpha: 0.10),
        border: Border.all(color: AppTheme.primaryBlue.withValues(alpha: 0.24)),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        '$label: $value',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          color: AppTheme.textPrimary,
          fontSize: 12,
          fontWeight: FontWeight.w800,
        ),
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  final String message;

  const _ErrorBanner({required this.message});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppTheme.errorOnSurface.withValues(alpha: 0.12),
        border: Border.all(
          color: AppTheme.errorOnSurface.withValues(alpha: 0.4),
        ),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        children: [
          Icon(Icons.error_outline, color: AppTheme.errorOnSurface),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              message,
              style: TextStyle(
                color: AppTheme.errorOnSurface,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
