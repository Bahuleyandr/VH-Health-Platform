import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../core/config/api_config.dart';
import '../../../core/config/role_config.dart';
import '../../../core/services/audit_log_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../core/widgets/states/empty_state.dart';

class AuditLogsScreen extends StatefulWidget {
  const AuditLogsScreen({super.key});

  @override
  State<AuditLogsScreen> createState() => _AuditLogsScreenState();
}

class _AuditLogsScreenState extends State<AuditLogsScreen> {
  final _searchCtrl = TextEditingController();
  final _actionCtrl = TextEditingController();
  final _resourceCtrl = TextEditingController();
  final _roleCtrl = TextEditingController();
  final _dateFmt = DateFormat('dd/MM HH:mm');
  final _dateOnlyFmt = DateFormat('dd/MM/yyyy');

  AuditLogKind _kind = AuditLogKind.audit;
  StaffRole _role = StaffRole.general;
  String _dateRange = 'last_7d';
  DateTime? _from;
  DateTime? _to;
  bool _roleLoaded = false;
  bool _loading = false;
  Object? _error;
  AuditLogResult _result = const AuditLogResult(
    logs: [],
    total: 0,
    page: 1,
    limit: 50,
    totalPages: 1,
  );

  bool get _allowed => _role.isAdminTier;

  @override
  void initState() {
    super.initState();
    _loadRoleAndLogs();
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    _actionCtrl.dispose();
    _resourceCtrl.dispose();
    _roleCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadRoleAndLogs() async {
    final role = StaffRole.fromString(await ApiConfig.getRole());
    if (!mounted) return;
    setState(() {
      _role = role;
      _roleLoaded = true;
    });
    if (role.isAdminTier) await _loadLogs(page: 1);
  }

  Future<void> _loadLogs({int? page}) async {
    if (!_allowed) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final result = await AuditLogApiService.fetchLogs(
        AuditLogQuery(
          kind: _kind,
          search: _searchCtrl.text,
          action: _actionCtrl.text,
          resource: _kind == AuditLogKind.audit ? _resourceCtrl.text : null,
          role: _kind == AuditLogKind.audit ? _roleCtrl.text : null,
          dateRange: _dateRange == 'custom' ? null : _dateRange,
          from: _from,
          to: _to,
          page: page ?? _result.page,
          limit: _result.limit,
        ),
      );
      if (mounted) setState(() => _result = result);
    } catch (e) {
      if (mounted) setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _resetFilters() {
    _searchCtrl.clear();
    _actionCtrl.clear();
    _resourceCtrl.clear();
    _roleCtrl.clear();
    setState(() {
      _dateRange = 'last_7d';
      _from = null;
      _to = null;
    });
    _loadLogs(page: 1);
  }

  Future<void> _pickDate({required bool isFrom}) async {
    final initial = isFrom ? _from : _to;
    final picked = await showDatePicker(
      context: context,
      initialDate: initial ?? DateTime.now(),
      firstDate: DateTime.now().subtract(const Duration(days: 365)),
      lastDate: DateTime.now().add(const Duration(days: 1)),
    );
    if (picked == null || !mounted) return;
    setState(() {
      _dateRange = 'custom';
      if (isFrom) {
        _from = picked;
      } else {
        _to = picked;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: const Text('Audit Logs'),
        actions: [
          IconButton(
            tooltip: 'Refresh logs',
            onPressed: _allowed && !_loading ? () => _loadLogs() : null,
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
                  'Audit logs are available only to Admin and Super Admin roles.',
            )
          : Column(
              children: [
                _SummaryStrip(
                  kind: _kind,
                  total: _result.total,
                  page: _result.page,
                  totalPages: _result.totalPages,
                  loading: _loading,
                ),
                _filters(),
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                    child: _ErrorBanner(
                      message: _error.toString().replaceFirst(
                        'Exception: ',
                        '',
                      ),
                    ),
                  ),
                Expanded(child: _logList()),
                _pagination(),
              ],
            ),
    );
  }

  Widget _filters() {
    final outline = AppTheme.divider;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: AppTheme.cardSurface,
          border: Border.all(color: outline),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Wrap(
                spacing: 8,
                runSpacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  _TypeChip(
                    label: 'Change audit',
                    icon: Icons.manage_search,
                    selected: _kind == AuditLogKind.audit,
                    onSelected: () {
                      setState(() => _kind = AuditLogKind.audit);
                      _loadLogs(page: 1);
                    },
                  ),
                  _TypeChip(
                    label: 'Admin activity',
                    icon: Icons.admin_panel_settings_outlined,
                    selected: _kind == AuditLogKind.system,
                    onSelected: () {
                      setState(() => _kind = AuditLogKind.system);
                      _loadLogs(page: 1);
                    },
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Wrap(
                spacing: 10,
                runSpacing: 10,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  SizedBox(
                    width: 280,
                    child: TextField(
                      controller: _searchCtrl,
                      onSubmitted: (_) => _loadLogs(page: 1),
                      decoration: const InputDecoration(
                        labelText: 'Search',
                        hintText: 'Action, resource, IP, user',
                        prefixIcon: Icon(Icons.search),
                      ),
                    ),
                  ),
                  SizedBox(
                    width: 180,
                    child: DropdownButtonFormField<String>(
                      key: ValueKey(_dateRange),
                      initialValue: _dateRange,
                      decoration: const InputDecoration(
                        labelText: 'Date',
                        prefixIcon: Icon(Icons.date_range),
                      ),
                      items: const [
                        DropdownMenuItem(value: '', child: Text('All dates')),
                        DropdownMenuItem(value: 'today', child: Text('Today')),
                        DropdownMenuItem(
                          value: 'yesterday',
                          child: Text('Yesterday'),
                        ),
                        DropdownMenuItem(
                          value: 'last_24h',
                          child: Text('Last 24h'),
                        ),
                        DropdownMenuItem(
                          value: 'last_7d',
                          child: Text('Last 7 days'),
                        ),
                        DropdownMenuItem(
                          value: 'last_30d',
                          child: Text('Last 30 days'),
                        ),
                        DropdownMenuItem(
                          value: 'custom',
                          child: Text('Custom'),
                        ),
                      ],
                      onChanged: (value) {
                        setState(() {
                          _dateRange = value ?? '';
                          if (_dateRange != 'custom') {
                            _from = null;
                            _to = null;
                          }
                        });
                        _loadLogs(page: 1);
                      },
                    ),
                  ),
                  _DateButton(
                    label: 'From',
                    value: _from == null ? null : _dateOnlyFmt.format(_from!),
                    onPressed: () => _pickDate(isFrom: true),
                  ),
                  _DateButton(
                    label: 'To',
                    value: _to == null ? null : _dateOnlyFmt.format(_to!),
                    onPressed: () => _pickDate(isFrom: false),
                  ),
                  SizedBox(
                    width: 190,
                    child: TextField(
                      controller: _actionCtrl,
                      onSubmitted: (_) => _loadLogs(page: 1),
                      decoration: const InputDecoration(
                        labelText: 'Action',
                        prefixIcon: Icon(Icons.bolt_outlined),
                      ),
                    ),
                  ),
                  if (_kind == AuditLogKind.audit) ...[
                    SizedBox(
                      width: 190,
                      child: TextField(
                        controller: _resourceCtrl,
                        onSubmitted: (_) => _loadLogs(page: 1),
                        decoration: const InputDecoration(
                          labelText: 'Resource',
                          prefixIcon: Icon(Icons.folder_copy_outlined),
                        ),
                      ),
                    ),
                    SizedBox(
                      width: 170,
                      child: TextField(
                        controller: _roleCtrl,
                        onSubmitted: (_) => _loadLogs(page: 1),
                        decoration: const InputDecoration(
                          labelText: 'Actor role',
                          prefixIcon: Icon(Icons.badge_outlined),
                        ),
                      ),
                    ),
                  ],
                  SizedBox(
                    width: 118,
                    child: FilledButton.icon(
                      onPressed: _loading ? null : () => _loadLogs(page: 1),
                      icon: const Icon(Icons.filter_alt),
                      label: const Text('Apply'),
                    ),
                  ),
                  SizedBox(
                    width: 118,
                    child: OutlinedButton.icon(
                      onPressed: _loading ? null : _resetFilters,
                      icon: const Icon(Icons.restart_alt),
                      label: const Text('Reset'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _logList() {
    if (_loading && _result.logs.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_result.logs.isEmpty) {
      return const EmptyState(
        icon: Icons.manage_search,
        title: 'No matching logs',
        body: 'Adjust the filters or date range.',
      );
    }
    return RefreshIndicator(
      onRefresh: () => _loadLogs(),
      child: ListView.separated(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
        itemCount: _result.logs.length,
        separatorBuilder: (context, index) => const SizedBox(height: 8),
        itemBuilder: (context, index) {
          final row = _result.logs[index];
          return _LogRow(
            row: row,
            kind: _kind,
            formatter: _dateFmt,
            onTap: () => _showDetails(row),
          );
        },
      ),
    );
  }

  Widget _pagination() {
    if (_result.total <= _result.limit) return const SizedBox.shrink();
    final start = ((_result.page - 1) * _result.limit) + 1;
    final end = (start + _result.logs.length - 1).clamp(0, _result.total);
    return SafeArea(
      top: false,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: AppTheme.cardSurface,
          border: Border(top: BorderSide(color: AppTheme.divider)),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          child: Row(
            children: [
              Text(
                '$start-$end of ${_result.total}',
                style: TextStyle(color: AppTheme.textSecondary),
              ),
              const Spacer(),
              IconButton(
                tooltip: 'Previous page',
                onPressed: _result.page > 1 && !_loading
                    ? () => _loadLogs(page: _result.page - 1)
                    : null,
                icon: const Icon(Icons.chevron_left),
              ),
              Text(
                'Page ${_result.page} / ${_result.totalPages}',
                style: TextStyle(color: AppTheme.textPrimary),
              ),
              IconButton(
                tooltip: 'Next page',
                onPressed: _result.page < _result.totalPages && !_loading
                    ? () => _loadLogs(page: _result.page + 1)
                    : null,
                icon: const Icon(Icons.chevron_right),
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _showDetails(Map<String, dynamic> row) {
    final title = _text(row['action']).isNotEmpty
        ? _text(row['action'])
        : 'Log detail';
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (context) {
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          title,
                          style: Theme.of(context).textTheme.titleLarge
                              ?.copyWith(fontWeight: FontWeight.w700),
                        ),
                      ),
                      IconButton(
                        tooltip: 'Close',
                        onPressed: () => Navigator.of(context).pop(),
                        icon: const Icon(Icons.close),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  for (final entry in row.entries)
                    _DetailLine(
                      label: entry.key,
                      value: _formatValue(entry.value),
                    ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  String _formatValue(Object? value) {
    if (value == null) return '-';
    if (value is Map || value is List) {
      return const JsonEncoder.withIndent('  ').convert(value);
    }
    return value.toString();
  }
}

class _SummaryStrip extends StatelessWidget {
  final AuditLogKind kind;
  final int total;
  final int page;
  final int totalPages;
  final bool loading;

  const _SummaryStrip({
    required this.kind,
    required this.total,
    required this.page,
    required this.totalPages,
    required this.loading,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      color: AppTheme.cardSurface,
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
      child: Row(
        children: [
          Icon(
            kind == AuditLogKind.audit
                ? Icons.manage_search
                : Icons.admin_panel_settings_outlined,
            color: AppTheme.primaryBlue,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              kind == AuditLogKind.audit
                  ? 'Change audit trail'
                  : 'Admin activity log',
              style: TextStyle(
                color: AppTheme.textPrimary,
                fontWeight: FontWeight.w700,
                fontSize: 16,
              ),
            ),
          ),
          if (loading)
            const SizedBox(
              width: 20,
              height: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          else
            Text(
              '$total entries',
              style: TextStyle(
                color: AppTheme.textSecondary,
                fontWeight: FontWeight.w600,
              ),
            ),
          const SizedBox(width: 14),
          Text(
            'Page $page/$totalPages',
            style: TextStyle(color: AppTheme.textSecondary),
          ),
        ],
      ),
    );
  }
}

class _TypeChip extends StatelessWidget {
  final String label;
  final IconData icon;
  final bool selected;
  final VoidCallback onSelected;

  const _TypeChip({
    required this.label,
    required this.icon,
    required this.selected,
    required this.onSelected,
  });

  @override
  Widget build(BuildContext context) {
    return FilterChip(
      selected: selected,
      avatar: Icon(icon, size: 18),
      label: Text(label),
      onSelected: (_) => onSelected(),
      selectedColor: AppTheme.primaryBlue.withValues(alpha: 0.16),
      labelStyle: TextStyle(
        color: selected ? AppTheme.primaryBlue : AppTheme.textPrimary,
        fontWeight: FontWeight.w700,
      ),
    );
  }
}

class _DateButton extends StatelessWidget {
  final String label;
  final String? value;
  final VoidCallback onPressed;

  const _DateButton({
    required this.label,
    required this.value,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 142,
      child: OutlinedButton.icon(
        onPressed: onPressed,
        icon: const Icon(Icons.calendar_today, size: 18),
        label: Text(value ?? label, overflow: TextOverflow.ellipsis),
      ),
    );
  }
}

class _LogRow extends StatelessWidget {
  final Map<String, dynamic> row;
  final AuditLogKind kind;
  final DateFormat formatter;
  final VoidCallback onTap;

  const _LogRow({
    required this.row,
    required this.kind,
    required this.formatter,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final action = _text(row['action']);
    final title = action.isEmpty ? 'Log entry' : action;
    final time = _parseTime(row['created_at']);
    final resource = kind == AuditLogKind.audit
        ? _text(row['resource'])
        : _text(row['description']);
    final actor = kind == AuditLogKind.audit
        ? _text(row['role'])
        : _text(row['admin_uid']);
    final subject = [
      if (resource.isNotEmpty) resource,
      if (_text(row['resource_id']).isNotEmpty) '#${_text(row['resource_id'])}',
      if (actor.isNotEmpty) actor,
      if (_text(row['ip_address']).isNotEmpty) _text(row['ip_address']),
    ].join('  |  ');

    return Material(
      color: AppTheme.cardSurface,
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            border: Border.all(color: AppTheme.divider),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 42,
                height: 42,
                decoration: BoxDecoration(
                  color: _colorFor(row, kind).withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Icon(_iconFor(row, kind), color: _colorFor(row, kind)),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: Text(
                            title,
                            style: TextStyle(
                              color: AppTheme.textPrimary,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
                        Text(
                          time == null ? '-' : formatter.format(time.toLocal()),
                          style: TextStyle(
                            color: AppTheme.textSecondary,
                            fontSize: 12,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      subject.isEmpty ? 'No extra details' : subject,
                      style: TextStyle(color: AppTheme.textSecondary),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Icon(Icons.chevron_right, color: AppTheme.textSecondary),
            ],
          ),
        ),
      ),
    );
  }

  IconData _iconFor(Map<String, dynamic> row, AuditLogKind kind) {
    final value = _text(row['resource']).toLowerCase();
    if (kind == AuditLogKind.system) return Icons.admin_panel_settings_outlined;
    if (value.contains('bed')) return Icons.local_hotel_outlined;
    if (value.contains('appointment')) return Icons.calendar_month_outlined;
    if (value.contains('patient')) return Icons.folder_shared_outlined;
    if (value.contains('staff')) return Icons.badge_outlined;
    if (value.contains('notification')) return Icons.notifications_outlined;
    return Icons.manage_search;
  }

  Color _colorFor(Map<String, dynamic> row, AuditLogKind kind) {
    final value = _text(row['resource']).toLowerCase();
    if (kind == AuditLogKind.system) return AppTheme.warningOnSurface;
    if (value.contains('bed')) return AppTheme.primaryTeal;
    if (value.contains('appointment')) return const Color(0xFF6A1B9A);
    if (value.contains('patient')) return AppTheme.primaryBlue;
    if (value.contains('staff')) return const Color(0xFF455A64);
    if (value.contains('notification')) return AppTheme.warningOnSurface;
    return AppTheme.primaryBlue;
  }
}

class _DetailLine extends StatelessWidget {
  final String label;
  final String value;

  const _DetailLine({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label.replaceAll('_', ' ').toUpperCase(),
            style: TextStyle(
              color: AppTheme.textSecondary,
              fontSize: 11,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 2),
          SelectableText(value, style: TextStyle(color: AppTheme.textPrimary)),
        ],
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
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppTheme.errorRed.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppTheme.errorOnSurface),
      ),
      child: Row(
        children: [
          Icon(Icons.error_outline, color: AppTheme.errorOnSurface),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              message,
              style: TextStyle(color: AppTheme.errorOnSurface),
            ),
          ),
        ],
      ),
    );
  }
}

DateTime? _parseTime(Object? value) {
  if (value is DateTime) return value;
  return DateTime.tryParse(value?.toString() ?? '');
}

String _text(Object? value) => value?.toString().trim() ?? '';
