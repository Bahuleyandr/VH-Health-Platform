import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';

@visibleForTesting
String patientCommandBoardScopeLabel(Map<String, dynamic> board) {
  final scope = _patientCommandBoardRoleScope(board);
  final type = _patientCommandBoardText(scope['type']);
  return switch (type) {
    'full' => 'All active inpatients',
    'own_patients' => 'Patients assigned to you',
    'duty_doctor' => 'Current duty floor coverage',
    'ward_nursing' => 'Current nursing floor',
    'op_nursing' => 'OP nursing coverage',
    'housekeeping' => 'Current housekeeping area',
    'none' => 'No inpatient scope for this role',
    _ => 'Role-based inpatient scope',
  };
}

@visibleForTesting
String patientCommandBoardScopeDetail(Map<String, dynamic> board) {
  final scope = _patientCommandBoardRoleScope(board);
  if (scope['all_floors'] == true) return 'All floors';

  final wards = _patientCommandBoardTextList(scope['wards']);
  if (wards.isNotEmpty) return wards.join(', ');

  final floors = _patientCommandBoardTextList(scope['floors']);
  if (floors.isNotEmpty) {
    return floors.length == 1
        ? 'Floor ${floors.first}'
        : 'Floors ${floors.join(', ')}';
  }

  final source = _patientCommandBoardText(scope['source']).replaceAll('_', ' ');
  final assignmentCount = _patientCommandBoardInt(scope['assignment_count']);
  if (source.isNotEmpty && assignmentCount > 0) {
    return '$source - $assignmentCount posting${assignmentCount == 1 ? '' : 's'}';
  }
  return source;
}

@visibleForTesting
String patientCommandBoardLoadedSummary({
  required Map<String, dynamic> board,
  required int loadedRows,
  required int visibleRows,
  String filter = 'all',
}) {
  final counts = _patientCommandBoardMap(board['counts']);
  final countedTotal = _patientCommandBoardInt(counts['total']);
  final countedLoaded = _patientCommandBoardInt(
    counts['loaded'] ?? counts['returned'],
  );
  final loaded = countedLoaded > 0 ? countedLoaded : loadedRows;
  final total = countedTotal > 0 ? countedTotal : loaded;

  if (filter != 'all') {
    return 'Showing $visibleRows filtered rows from $loaded loaded; scoped total $total.';
  }
  if (total > loaded) {
    return 'Showing first $loaded of $total patients in your current scope.';
  }
  return 'Showing $loaded of $total patients in your current scope.';
}

Map<String, dynamic> _patientCommandBoardRoleScope(Map<String, dynamic> board) {
  return _patientCommandBoardMap(
    _patientCommandBoardMap(board['scope'])['role_scope'],
  );
}

Map<String, dynamic> _patientCommandBoardMap(dynamic value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return Map<String, dynamic>.from(value);
  return <String, dynamic>{};
}

String _patientCommandBoardText(dynamic value, [String fallback = '']) {
  final text = (value ?? '').toString().trim();
  return text.isEmpty ? fallback : text;
}

int _patientCommandBoardInt(dynamic value) =>
    int.tryParse('${value ?? 0}') ?? 0;

List<String> _patientCommandBoardTextList(dynamic value) {
  if (value is! List) return const [];
  return value
      .map((item) => _patientCommandBoardText(item))
      .where((item) => item.isNotEmpty)
      .toList();
}

class PatientCommandBoardScreen extends StatefulWidget {
  const PatientCommandBoardScreen({super.key});

  @override
  State<PatientCommandBoardScreen> createState() =>
      _PatientCommandBoardScreenState();
}

class _PatientCommandBoardScreenState extends State<PatientCommandBoardScreen> {
  bool _loading = true;
  String? _error;
  String _filter = 'all';
  String? _ward;
  Map<String, dynamic> _board = const {};
  List<Map<String, dynamic>> _rows = const [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await MedicalApiService.getPatientCommandBoard(ward: _ward);
      final rows = _asListOfMaps(data['rows']);
      final board = _asMap(data['board']);
      if (!mounted) return;
      setState(() {
        _rows = rows;
        _board = board;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Map<String, dynamic> _asMap(dynamic value) {
    if (value is Map<String, dynamic>) return value;
    if (value is Map) return Map<String, dynamic>.from(value);
    return <String, dynamic>{};
  }

  List<Map<String, dynamic>> _asListOfMaps(dynamic value) {
    if (value is! List) return const [];
    return value
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
  }

  String _text(dynamic value, [String fallback = '']) {
    final text = (value ?? '').toString().trim();
    return text.isEmpty ? fallback : text;
  }

  int _int(dynamic value) => int.tryParse('${value ?? 0}') ?? 0;

  List<Map<String, dynamic>> get _visibleRows {
    Iterable<Map<String, dynamic>> rows = _rows;
    switch (_filter) {
      case 'alerts':
        rows = rows.where((row) => _int(_asMap(row['alerts'])['count']) > 0);
        break;
      case 'tasks':
        rows = rows.where(
          (row) => _int(_asMap(row['tasks'])['open_count']) > 0,
        );
        break;
      case 'discharge':
        rows = rows.where(
          (row) => _asMap(row['discharge'])['initiated'] == true,
        );
        break;
      case 'emergency':
        rows = rows.where(
          (row) => _text(_asMap(row['priority'])['band']) == 'critical',
        );
        break;
    }
    return rows.toList();
  }

  List<String> get _wardOptions {
    final wards =
        _rows
            .map((row) => _text(_asMap(row['location'])['ward']))
            .where((ward) => ward.isNotEmpty)
            .toSet()
            .toList()
          ..sort();
    return wards;
  }

  Color _colorFor(String? color) {
    switch ((color ?? '').toLowerCase()) {
      case 'red':
        return AppTheme.errorOnSurface;
      case 'orange':
        return AppTheme.warningOnSurface;
      case 'green':
        return AppTheme.successOnSurface;
      case 'blue':
        return AppTheme.primaryBlue;
      default:
        return AppTheme.textSecondary;
    }
  }

  Future<void> _showListSheet({
    required String title,
    required List<Map<String, dynamic>> rows,
    required Widget Function(Map<String, dynamic>) itemBuilder,
    String empty = 'Nothing to show.',
  }) async {
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      backgroundColor: Theme.of(context).colorScheme.surface,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 4, 18, 18),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 12),
              if (rows.isEmpty)
                Text(empty)
              else
                Flexible(
                  child: ListView.separated(
                    shrinkWrap: true,
                    itemCount: rows.length,
                    separatorBuilder: (context, index) =>
                        const Divider(height: 16),
                    itemBuilder: (_, index) => itemBuilder(rows[index]),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  void _openAllergies(Map<String, dynamic> row) {
    final allergies = _asListOfMaps(_asMap(row['allergies'])['items']);
    _showListSheet(
      title: 'Allergies',
      rows: allergies,
      empty: 'No allergies documented.',
      itemBuilder: (item) => ListTile(
        contentPadding: EdgeInsets.zero,
        leading: const Icon(Icons.warning_amber_outlined),
        title: Text(_text(item['name'], 'Allergy')),
        subtitle: Text(
          [
            if (_text(item['severity']).isNotEmpty) _text(item['severity']),
            if (_text(item['reaction']).isNotEmpty) _text(item['reaction']),
            if (_text(item['source']).isNotEmpty) _text(item['source']),
          ].join(' - '),
        ),
      ),
    );
  }

  void _openAlerts(Map<String, dynamic> row) {
    final alerts = _asListOfMaps(_asMap(row['alerts'])['items']);
    _showListSheet(
      title: 'Active alerts',
      rows: alerts,
      empty: 'No active alerts.',
      itemBuilder: (item) => ListTile(
        contentPadding: EdgeInsets.zero,
        leading: Icon(
          Icons.health_and_safety_outlined,
          color: _text(item['severity']).toLowerCase() == 'critical'
              ? AppTheme.errorOnSurface
              : AppTheme.warningOnSurface,
        ),
        title: Text(_text(item['title'], 'Alert')),
        subtitle: Text(
          [
            _text(item['severity']).toUpperCase(),
            _text(item['description']),
          ].where((part) => part.isNotEmpty).join(' - '),
        ),
      ),
    );
  }

  void _openTasks(Map<String, dynamic> row) {
    final tasks = _asListOfMaps(_asMap(row['tasks'])['items']);
    _showListSheet(
      title: 'Open tasks and referrals',
      rows: tasks,
      empty: 'No open tasks.',
      itemBuilder: (item) => ListTile(
        contentPadding: EdgeInsets.zero,
        leading: const Icon(Icons.task_alt_outlined),
        title: Text(_text(item['label'], 'Task')),
        subtitle: Text(
          [
            _text(item['kind']).replaceAll('_', ' '),
            _text(item['status']),
            _text(item['priority']),
          ].where((part) => part.isNotEmpty).join(' - '),
        ),
      ),
    );
  }

  void _openAction(Map<String, dynamic> row, Map<String, dynamic> action) {
    final rawRoute = _text(action['route']);
    if (rawRoute.isEmpty) return;
    final patientName = _text(_asMap(row['patient'])['name'], 'Patient');
    final route = rawRoute.contains('?')
        ? rawRoute
        : '$rawRoute?name=${Uri.encodeQueryComponent(patientName)}';
    context.push(route);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: const Text('Patient Command Board'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh),
          ),
          const LogoutAction(),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
          ? _ErrorView(message: _error!, onRetry: _load)
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(14, 14, 14, 96),
                children: [
                  _buildHeader(theme),
                  const SizedBox(height: 12),
                  _buildFilters(theme),
                  const SizedBox(height: 12),
                  if (_visibleRows.isEmpty)
                    _EmptyBoard(filter: _filter)
                  else
                    ..._visibleRows.map((row) => _buildRowCard(theme, row)),
                ],
              ),
            ),
    );
  }

  Widget _buildHeader(ThemeData theme) {
    final actor = _asMap(_board['actor']);
    final governance = _asMap(_board['governance']);
    final counts = _asMap(_board['counts']);
    final total = _int(counts['total']);
    final visibleRows = _visibleRows.length;
    final scopeLabel = patientCommandBoardScopeLabel(_board);
    final scopeDetail = patientCommandBoardScopeDetail(_board);
    final loadedSummary = patientCommandBoardLoadedSummary(
      board: _board,
      loadedRows: _rows.length,
      visibleRows: visibleRows,
      filter: _filter,
    );
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: AppTheme.primaryBlue.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: const Icon(
                  Icons.view_timeline_outlined,
                  color: AppTheme.primaryBlue,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      _text(actor['view_label'], 'Patient command board'),
                      style: theme.textTheme.titleLarge?.copyWith(
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    Text(
                      _text(governance['label']),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          _buildScopeBanner(
            theme,
            label: scopeLabel,
            detail: scopeDetail,
            summary: loadedSummary,
          ),
          const SizedBox(height: 14),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _metricChip('Patients', total, Icons.bed),
              _metricChip(
                'Tasks',
                _int(counts['with_open_tasks']),
                Icons.task_alt,
              ),
              _metricChip(
                'Alerts',
                _int(counts['alerted']),
                Icons.health_and_safety,
              ),
              _metricChip(
                'Discharge',
                _int(counts['discharge_initiated']),
                Icons.rule_folder,
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildScopeBanner(
    ThemeData theme, {
    required String label,
    required String detail,
    required String summary,
  }) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppTheme.primaryTeal.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppTheme.primaryTeal.withValues(alpha: 0.22)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.security_outlined, color: AppTheme.primaryTeal),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  style: theme.textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
                if (detail.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(
                    detail,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
                const SizedBox(height: 4),
                Text(
                  summary,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _metricChip(String label, int value, IconData icon) {
    return Chip(
      avatar: Icon(icon, size: 16, color: AppTheme.primaryBlue),
      label: Text('$value $label'),
      side: BorderSide(color: AppTheme.primaryBlue.withValues(alpha: 0.25)),
      backgroundColor: AppTheme.primaryBlue.withValues(alpha: 0.08),
    );
  }

  Widget _buildFilters(ThemeData theme) {
    final wards = _wardOptions;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              _filterChip('all', 'All'),
              _filterChip('emergency', 'Emergency'),
              _filterChip('alerts', 'Alerts'),
              _filterChip('tasks', 'Tasks'),
              _filterChip('discharge', 'Discharge'),
            ],
          ),
        ),
        if (wards.isNotEmpty) ...[
          const SizedBox(height: 10),
          DropdownButtonFormField<String?>(
            initialValue: _ward,
            decoration: const InputDecoration(
              labelText: 'Ward / area',
              prefixIcon: Icon(Icons.location_on_outlined),
              border: OutlineInputBorder(),
              isDense: true,
            ),
            items: [
              const DropdownMenuItem<String?>(
                value: null,
                child: Text('All wards'),
              ),
              ...wards.map(
                (ward) =>
                    DropdownMenuItem<String?>(value: ward, child: Text(ward)),
              ),
            ],
            onChanged: (value) {
              setState(() => _ward = value);
              _load();
            },
          ),
        ],
      ],
    );
  }

  Widget _filterChip(String key, String label) {
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: ChoiceChip(
        label: Text(label),
        selected: _filter == key,
        onSelected: (_) => setState(() => _filter = key),
      ),
    );
  }

  Widget _buildRowCard(ThemeData theme, Map<String, dynamic> row) {
    final patient = _asMap(row['patient']);
    final location = _asMap(row['location']);
    final priority = _asMap(row['priority']);
    final age = _asMap(_asMap(row['timers'])['age']);
    final diagnosis = _asMap(row['diagnosis']);
    final allergies = _asMap(row['allergies']);
    final alerts = _asMap(row['alerts']);
    final tasks = _asMap(row['tasks']);
    final discharge = _asMap(row['discharge']);
    final actions = _asListOfMaps(row['actions']);
    final color = _colorFor(_text(priority['color']));
    final name = _text(patient['name'], 'Patient');
    final hospitalNumber = _text(patient['hospital_number']);
    final ward = _text(location['ward']);
    final bed = _text(location['bed_number']);
    final diagnosisHidden =
        _text(diagnosis['source']).toLowerCase() == 'minimized' ||
        _text(diagnosis['status']).toLowerCase() == 'hidden';
    final diagnosisText = diagnosisHidden
        ? 'Clinical details hidden for this role'
        : _text(diagnosis['text'], 'Diagnosis pending');
    final diagnosisType = diagnosisHidden
        ? 'Location only'
        : _text(diagnosis['type'], 'working');

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      clipBehavior: Clip.antiAlias,
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(width: 5, color: color),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                name,
                                style: theme.textTheme.titleMedium?.copyWith(
                                  fontWeight: FontWeight.w800,
                                ),
                              ),
                              const SizedBox(height: 3),
                              Text(
                                [
                                  if (hospitalNumber.isNotEmpty)
                                    'Hospital ID $hospitalNumber',
                                  if (ward.isNotEmpty) ward,
                                  if (bed.isNotEmpty) 'Bed $bed',
                                  'Admission #${row['admission_id']}',
                                ].join(' - '),
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color: theme.colorScheme.onSurfaceVariant,
                                ),
                              ),
                            ],
                          ),
                        ),
                        _statusBadge(
                          _text(priority['label'], 'Routine'),
                          color,
                          Icons.priority_high,
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        _statusBadge(
                          _text(age['label'], 'No time'),
                          _colorFor(_text(age['color'])),
                          Icons.schedule,
                        ),
                        _statusBadge(
                          diagnosisType.replaceAll('_', ' '),
                          AppTheme.primaryBlue,
                          Icons.assignment_outlined,
                        ),
                        ActionChip(
                          avatar: const Icon(Icons.warning_amber, size: 16),
                          label: Text('${_int(allergies['count'])} allergies'),
                          onPressed: () => _openAllergies(row),
                        ),
                        ActionChip(
                          avatar: const Icon(Icons.health_and_safety, size: 16),
                          label: Text('${_int(alerts['count'])} alerts'),
                          onPressed: () => _openAlerts(row),
                        ),
                        ActionChip(
                          avatar: const Icon(Icons.task_alt, size: 16),
                          label: Text('${_int(tasks['open_count'])} tasks'),
                          onPressed: () => _openTasks(row),
                        ),
                        if (discharge['initiated'] == true)
                          _statusBadge(
                            _text(
                              discharge['checklist_state'],
                              'discharge',
                            ).replaceAll('_', ' '),
                            discharge['checklist_state'] == 'ready'
                                ? AppTheme.successOnSurface
                                : AppTheme.warningOnSurface,
                            Icons.rule_folder,
                          ),
                      ],
                    ),
                    const SizedBox(height: 10),
                    Text(
                      diagnosisText,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodyMedium,
                    ),
                    const SizedBox(height: 10),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: actions
                          .map(
                            (action) => OutlinedButton.icon(
                              onPressed: () => _openAction(row, action),
                              icon: Icon(_iconForAction(_text(action['key']))),
                              label: Text(_text(action['label'], 'Open')),
                            ),
                          )
                          .toList(),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _statusBadge(String label, Color color, IconData icon) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 15, color: color),
          const SizedBox(width: 5),
          Text(
            label,
            style: TextStyle(color: color, fontWeight: FontWeight.w700),
          ),
        ],
      ),
    );
  }

  IconData _iconForAction(String key) {
    return switch (key) {
      'notes' => Icons.edit_note,
      'orders' => Icons.receipt_long,
      'drug_chart' => Icons.medication,
      'case_sheet' => Icons.assignment,
      'discharge' => Icons.rule_folder,
      'vitals' => Icons.monitor_heart,
      'handover' => Icons.swap_horiz,
      _ => Icons.open_in_new,
    };
  }
}

class _ErrorView extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;

  const _ErrorView({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.cloud_off, size: 48, color: theme.colorScheme.error),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh),
              label: const Text('Retry'),
            ),
          ],
        ),
      ),
    );
  }
}

class _EmptyBoard extends StatelessWidget {
  final String filter;

  const _EmptyBoard({required this.filter});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 72),
      child: Column(
        children: [
          Icon(
            Icons.view_timeline_outlined,
            size: 56,
            color: theme.colorScheme.outline,
          ),
          const SizedBox(height: 12),
          Text(
            filter == 'all' ? 'No active patients' : 'No matching patients',
            style: theme.textTheme.titleMedium,
          ),
        ],
      ),
    );
  }
}
