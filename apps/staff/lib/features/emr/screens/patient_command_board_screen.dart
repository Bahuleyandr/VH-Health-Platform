import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/navigation/ip_command_board_routes.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';
import '../widgets/icu_chart_depth_panel.dart';
import '../widgets/nicu_picu_chart_panel.dart';
import '../widgets/patient_summary_sheet.dart';

@visibleForTesting
String patientCommandBoardScopeLabel(Map<String, dynamic> board) {
  final scope = _patientCommandBoardRoleScope(board);
  final type = _patientCommandBoardText(scope['type']);
  final source = _patientCommandBoardText(scope['source']);
  if (type == 'ward_nursing' &&
      source == 'all_locations_fallback_no_current_roster') {
    return 'All active inpatients';
  }
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

@visibleForTesting
bool patientCommandBoardHasMore({
  required Map<String, dynamic> board,
  required int loadedRows,
}) {
  final counts = _patientCommandBoardMap(board['counts']);
  final total = _patientCommandBoardInt(counts['total']);
  final countedLoaded = _patientCommandBoardInt(counts['loaded']);
  final loaded = countedLoaded > loadedRows ? countedLoaded : loadedRows;
  if (total <= 0) return counts['has_more'] == true;
  if (loaded >= total) return false;
  return counts['has_more'] == true || loaded < total;
}

@visibleForTesting
int patientCommandBoardNextOffset({
  required Map<String, dynamic> board,
  required int loadedRows,
}) {
  final counts = _patientCommandBoardMap(board['counts']);
  final countedLoaded = _patientCommandBoardInt(counts['loaded']);
  return countedLoaded > loadedRows ? countedLoaded : loadedRows;
}

@visibleForTesting
String patientCommandBoardActionDestination({
  required String rawRoute,
  required String actionKey,
  required String patientUid,
  required int admissionId,
  required String patientName,
  required String patientRef,
}) {
  final route = rawRoute.trim();
  if (route.isEmpty || route.startsWith('/patient-command-board')) {
    return ipCommandBoardRoute(
      patientUid: patientUid,
      admissionId: admissionId,
      patientName: patientName,
      action: actionKey,
    );
  }

  if (route == '/handover') {
    return _appendPatientContext(route, {
      'patient_ref': patientRef,
      'patient_uid': patientUid,
      'admission_id': admissionId <= 0 ? '' : '$admissionId',
      'name': patientName,
    });
  }

  return _appendPatientContext(route, {
    'name': patientName,
    'patient_uid': patientUid,
    'admission_id': admissionId <= 0 ? '' : '$admissionId',
  });
}

@visibleForTesting
String patientCommandBoardCarePlanSummary(Map<String, dynamic> plan) {
  final goals = _patientCommandBoardListCount(plan['goals']);
  final activities = _patientCommandBoardListCount(plan['activities']);
  final pieces = <String>[
    '$goals goal${goals == 1 ? '' : 's'}',
    '$activities activit${activities == 1 ? 'y' : 'ies'}',
  ];
  final status = _patientCommandBoardText(plan['status']);
  if (status.isNotEmpty) pieces.add(status.replaceAll('_', ' '));
  return pieces.join(' - ');
}

int _patientCommandBoardListCount(dynamic value) =>
    value is List ? value.length : 0;

String _appendPatientContext(String route, Map<String, String> context) {
  final uri = Uri.parse(route);
  final query = Map<String, String>.from(uri.queryParameters);
  for (final entry in context.entries) {
    if (entry.value.trim().isEmpty || query.containsKey(entry.key)) continue;
    query[entry.key] = entry.value.trim();
  }
  return uri.replace(queryParameters: query.isEmpty ? null : query).toString();
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
  final String? initialPatientUid;
  final int? initialAdmissionId;
  final String? initialAction;
  final String? initialPatientName;

  const PatientCommandBoardScreen({
    super.key,
    this.initialPatientUid,
    this.initialAdmissionId,
    this.initialAction,
    this.initialPatientName,
  });

  @override
  State<PatientCommandBoardScreen> createState() =>
      _PatientCommandBoardScreenState();
}

class _PatientCommandBoardScreenState extends State<PatientCommandBoardScreen> {
  static const int _pageSize = 50;

  bool _loading = true;
  bool _loadingMore = false;
  String? _error;
  String _filter = 'all';
  String? _ward;
  Map<String, dynamic> _board = const {};
  List<Map<String, dynamic>> _rows = const [];
  bool _initialActionConsumed = false;

  bool get _hasFocusedPatient =>
      _text(widget.initialPatientUid).isNotEmpty ||
      (widget.initialAdmissionId ?? 0) > 0;

  String get _focusedPatientLabel {
    final name = _text(widget.initialPatientName);
    if (name.isNotEmpty) return name;
    final uid = _text(widget.initialPatientUid);
    if (uid.isNotEmpty) return uid;
    final id = widget.initialAdmissionId;
    final s = AppStrings.of(context);
    return id == null
        ? s.lookup('s4.lib.patient_command_board.selected_patient')
        : s.format('s4.dynamic.patient_command_board.admission_number', {
            'id': id,
          });
  }

  String _scopeLabel(Map<String, dynamic> board) {
    final s = AppStrings.of(context);
    final scope = _patientCommandBoardRoleScope(board);
    final type = _patientCommandBoardText(scope['type']);
    final source = _patientCommandBoardText(scope['source']);
    if (type == 'ward_nursing' &&
        source == 'all_locations_fallback_no_current_roster') {
      return s.lookup('s4.lib.patient_command_board.scope.all_active');
    }
    return switch (type) {
      'full' => s.lookup('s4.lib.patient_command_board.scope.all_active'),
      'own_patients' => s.lookup(
        's4.lib.patient_command_board.scope.own_patients',
      ),
      'duty_doctor' => s.lookup(
        's4.lib.patient_command_board.scope.duty_doctor',
      ),
      'ward_nursing' => s.lookup(
        's4.lib.patient_command_board.scope.ward_nursing',
      ),
      'op_nursing' => s.lookup('s4.lib.patient_command_board.scope.op_nursing'),
      'housekeeping' => s.lookup(
        's4.lib.patient_command_board.scope.housekeeping',
      ),
      'none' => s.lookup('s4.lib.patient_command_board.scope.none'),
      _ => s.lookup('s4.lib.patient_command_board.scope.role_based'),
    };
  }

  String _scopeDetail(Map<String, dynamic> board) {
    final s = AppStrings.of(context);
    final scope = _patientCommandBoardRoleScope(board);
    if (scope['all_floors'] == true) {
      return s.lookup('s4.lib.patient_command_board.all_floors');
    }

    final wards = _patientCommandBoardTextList(scope['wards']);
    if (wards.isNotEmpty) return wards.join(', ');

    final floors = _patientCommandBoardTextList(scope['floors']);
    if (floors.isNotEmpty) {
      return floors.length == 1
          ? s.format('s4.dynamic.patient_command_board.floor', {
              'floor': floors.first,
            })
          : s.format('s4.dynamic.patient_command_board.floors', {
              'floors': floors.join(', '),
            });
    }

    final source = _patientCommandBoardText(
      scope['source'],
    ).replaceAll('_', ' ');
    final assignmentCount = _patientCommandBoardInt(scope['assignment_count']);
    if (source.isNotEmpty && assignmentCount > 0) {
      return s.format('s4.dynamic.patient_command_board.postings', {
        'source': source,
        'count': assignmentCount,
      });
    }
    return source;
  }

  String _loadedSummary({
    required Map<String, dynamic> board,
    required int loadedRows,
    required int visibleRows,
    required String filter,
  }) {
    final s = AppStrings.of(context);
    final counts = _patientCommandBoardMap(board['counts']);
    final countedTotal = _patientCommandBoardInt(counts['total']);
    final countedLoaded = _patientCommandBoardInt(
      counts['loaded'] ?? counts['returned'],
    );
    final loaded = countedLoaded > 0 ? countedLoaded : loadedRows;
    final total = countedTotal > 0 ? countedTotal : loaded;

    if (filter != 'all') {
      return s.format('s4.dynamic.patient_command_board.loaded_filtered', {
        'visible': visibleRows,
        'loaded': loaded,
        'total': total,
      });
    }
    if (total > loaded) {
      return s.format('s4.dynamic.patient_command_board.loaded_first', {
        'loaded': loaded,
        'total': total,
      });
    }
    return s.format('s4.dynamic.patient_command_board.loaded_current', {
      'loaded': loaded,
      'total': total,
    });
  }

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
      final data = await MedicalApiService.getPatientCommandBoard(
        ward: _ward,
        patientUid: widget.initialPatientUid,
        admissionId: widget.initialAdmissionId,
        limit: _pageSize,
      );
      final rows = _asListOfMaps(data['rows']);
      final board = _asMap(data['board']);
      if (!mounted) return;
      setState(() {
        _rows = rows;
        _board = board;
      });
      _maybeOpenInitialAction();
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _loadMore() async {
    if (_loadingMore || !_hasMoreRows) return;
    setState(() {
      _loadingMore = true;
      _error = null;
    });
    try {
      final data = await MedicalApiService.getPatientCommandBoard(
        ward: _ward,
        patientUid: widget.initialPatientUid,
        admissionId: widget.initialAdmissionId,
        limit: _pageSize,
        offset: patientCommandBoardNextOffset(
          board: _board,
          loadedRows: _rows.length,
        ),
      );
      final nextRows = _asListOfMaps(data['rows']);
      final board = _asMap(data['board']);
      if (!mounted) return;
      setState(() {
        _rows = _mergeRows(_rows, nextRows);
        _board = board;
      });
      _maybeOpenInitialAction();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(e.toString().replaceFirst('Exception: ', ''))),
      );
    } finally {
      if (mounted) setState(() => _loadingMore = false);
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

  List<Map<String, dynamic>> _mergeRows(
    List<Map<String, dynamic>> current,
    List<Map<String, dynamic>> next,
  ) {
    final merged = <Map<String, dynamic>>[];
    final seen = <String>{};
    for (final row in [...current, ...next]) {
      final id = _text(row['admission_id'], row.hashCode.toString());
      if (!seen.add(id)) continue;
      merged.add(row);
    }
    return merged;
  }

  String _text(dynamic value, [String fallback = '']) {
    final text = (value ?? '').toString().trim();
    return text.isEmpty ? fallback : text;
  }

  int _int(dynamic value) => int.tryParse('${value ?? 0}') ?? 0;

  bool get _hasMoreRows =>
      patientCommandBoardHasMore(board: _board, loadedRows: _rows.length);

  int get _loadedAlertCount =>
      _rows.where((row) => _int(_asMap(row['alerts'])['count']) > 0).length;

  int get _loadedTaskCount =>
      _rows.where((row) => _int(_asMap(row['tasks'])['open_count']) > 0).length;

  int get _loadedDischargeCount => _rows
      .where((row) => _asMap(row['discharge'])['initiated'] == true)
      .length;

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
    required String empty,
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
    final s = AppStrings.of(context);
    final allergies = _asListOfMaps(_asMap(row['allergies'])['items']);
    _showListSheet(
      title: s.lookup('s4.lib.patient_command_board.allergies'),
      rows: allergies,
      empty: s.lookup('s4.lib.patient_command_board.no_allergies_documented'),
      itemBuilder: (item) => ListTile(
        contentPadding: EdgeInsets.zero,
        leading: const Icon(Icons.warning_amber_outlined),
        title: Text(
          _text(item['name'], s.lookup('s4.lib.patient_command_board.allergy')),
        ),
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
    final s = AppStrings.of(context);
    final alerts = _asListOfMaps(_asMap(row['alerts'])['items']);
    _showListSheet(
      title: s.lookup('s4.lib.patient_command_board.active_alerts'),
      rows: alerts,
      empty: s.lookup('s4.lib.patient_command_board.no_active_alerts'),
      itemBuilder: (item) => ListTile(
        contentPadding: EdgeInsets.zero,
        leading: Icon(
          Icons.health_and_safety_outlined,
          color: _text(item['severity']).toLowerCase() == 'critical'
              ? AppTheme.errorOnSurface
              : AppTheme.warningOnSurface,
        ),
        title: Text(
          _text(item['title'], s.lookup('s4.lib.patient_command_board.alert')),
        ),
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
    final s = AppStrings.of(context);
    final tasks = _asListOfMaps(_asMap(row['tasks'])['items']);
    _showListSheet(
      title: s.lookup('s4.lib.patient_command_board.open_tasks_referrals'),
      rows: tasks,
      empty: s.lookup('s4.lib.patient_command_board.no_open_tasks'),
      itemBuilder: (item) => ListTile(
        contentPadding: EdgeInsets.zero,
        leading: const Icon(Icons.task_alt_outlined),
        title: Text(
          _text(item['label'], s.lookup('s4.lib.patient_command_board.task')),
        ),
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

  Future<void> _openCarePlans(Map<String, dynamic> row) async {
    final patient = _asMap(row['patient']);
    final patientUid = _text(patient['uid']);
    if (patientUid.isEmpty) return;
    final patientName = _text(
      patient['name'],
      AppStrings.of(context).lookup('s4.lib.patient_command_board.patient'),
    );
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      backgroundColor: Theme.of(context).colorScheme.surface,
      builder: (_) =>
          _CarePlanSheet(patientUid: patientUid, patientName: patientName),
    );
  }

  void _openAction(Map<String, dynamic> row, Map<String, dynamic> action) {
    final rawRoute = _text(action['route']);
    if (rawRoute.isEmpty) return;
    final s = AppStrings.of(context);
    final patient = _asMap(row['patient']);
    final patientName = _text(
      patient['name'],
      s.lookup('s4.lib.patient_command_board.patient'),
    );
    final patientUid = _text(patient['uid']);
    final admissionId = _int(row['admission_id']);
    final patientRef = [
      _text(row['ward']),
      if (_text(row['bed_number']).isNotEmpty)
        s.format('s4.dynamic.patient_command_board.bed', {
          'bed': _text(row['bed_number']),
        }),
      patientName,
    ].where((part) => part.isNotEmpty).join(' - ');
    final route = patientCommandBoardActionDestination(
      rawRoute: rawRoute,
      actionKey: _text(action['key']),
      patientUid: patientUid,
      admissionId: admissionId,
      patientName: patientName,
      patientRef: patientRef,
    );
    context.push(route);
  }

  void _maybeOpenInitialAction() {
    final key = _text(widget.initialAction).toLowerCase();
    if (_initialActionConsumed || key.isEmpty || _rows.isEmpty) return;

    final row = _focusedRow() ?? _rows.first;
    _initialActionConsumed = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _openActionKey(row, key);
    });
  }

  Map<String, dynamic>? _focusedRow() {
    for (final row in _rows) {
      final patient = _asMap(row['patient']);
      if (_text(widget.initialPatientUid).isNotEmpty &&
          _text(patient['uid']) == _text(widget.initialPatientUid)) {
        return row;
      }
      final admissionId = widget.initialAdmissionId;
      if (admissionId != null && _int(row['admission_id']) == admissionId) {
        return row;
      }
    }
    return null;
  }

  void _openActionKey(Map<String, dynamic> row, String key) {
    final actions = _asListOfMaps(row['actions']);
    for (final action in actions) {
      if (_text(action['key']).toLowerCase() == key) {
        _openAction(row, action);
        return;
      }
    }

    final fallback = _fallbackActionRoute(row, key);
    if (fallback == null) return;
    context.push(fallback);
  }

  String? _fallbackActionRoute(Map<String, dynamic> row, String key) {
    final patient = _asMap(row['patient']);
    final uid = _text(patient['uid'], widget.initialPatientUid ?? '');
    final name = Uri.encodeQueryComponent(
      _text(patient['name'], _focusedPatientLabel),
    );
    final admissionId = _int(row['admission_id']);
    return switch (key) {
      'vitals' ||
      'io' ||
      'i/o' => uid.isEmpty ? null : '/emr/vitals/$uid?name=$name',
      'notes' => uid.isEmpty ? null : '/emr/notes/$uid?name=$name',
      'orders' => uid.isEmpty ? null : '/emr/orders/$uid?name=$name',
      'timeline' ||
      'emr' => uid.isEmpty ? null : '/emr/timeline/$uid?name=$name',
      'burn_chart' || 'burns' =>
        uid.isEmpty
            ? null
            : '/emr/burns/$uid?name=$name${admissionId <= 0 ? '' : '&admission_id=$admissionId'}',
      'drug_chart' =>
        admissionId <= 0 ? null : '/drug-chart/$admissionId?name=$name',
      'referral' => admissionId <= 0 ? null : '/referrals/request/$admissionId',
      'handover' =>
        '/handover?patient_ref=${Uri.encodeQueryComponent(_focusedPatientLabel)}&patient_uid=$uid&admission_id=$admissionId',
      'case_sheet' =>
        admissionId <= 0 ? null : '/emr/case-sheet/$admissionId?name=$name',
      'discharge' =>
        admissionId <= 0 ? null : '/emr/discharge-hub/$admissionId?name=$name',
      _ => null,
    };
  }

  void _openBurnChart(Map<String, dynamic> row) {
    final route = _burnChartRoute(row);
    if (route == null) return;
    context.push(route);
  }

  String? _burnChartRoute(Map<String, dynamic> row) {
    final patient = _asMap(row['patient']);
    final uid = _text(patient['uid']);
    if (uid.isEmpty) return null;
    final name = Uri.encodeQueryComponent(
      _text(patient['name'], _focusedPatientLabel),
    );
    final admissionId = _int(row['admission_id']);
    final params = <String>['name=$name'];
    if (admissionId > 0) params.add('admission_id=$admissionId');
    return '/emr/burns/$uid?${params.join('&')}';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: const AppText(
          's4.lib.patient_command_board.patient_command_board',
        ),
        actions: [
          IconButton(
            tooltip: AppStrings.of(context).lookup('action.refresh'),
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
                  if (_hasFocusedPatient) ...[
                    const SizedBox(height: 12),
                    _FocusedPatientBanner(
                      patientLabel: _focusedPatientLabel,
                      actionLabel: _text(widget.initialAction).isEmpty
                          ? null
                          : _text(widget.initialAction).replaceAll('_', ' '),
                    ),
                  ],
                  const SizedBox(height: 12),
                  _buildFilters(theme),
                  const SizedBox(height: 12),
                  if (_visibleRows.isEmpty)
                    _EmptyBoard(filter: _filter)
                  else
                    ..._visibleRows.map((row) => _buildRowCard(theme, row)),
                  if (_hasMoreRows) ...[
                    const SizedBox(height: 8),
                    _buildLoadMoreButton(theme),
                  ],
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
    final s = AppStrings.of(context);
    final scopeLabel = _scopeLabel(_board);
    final scopeDetail = _scopeDetail(_board);
    final loadedSummary = _loadedSummary(
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
                      _text(
                        actor['view_label'],
                        s.lookup(
                          's4.lib.patient_command_board.patient_command_board',
                        ),
                      ),
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
              _metricChip(
                s.lookup('s4.lib.patient_command_board.metric.patients'),
                total,
                Icons.bed,
              ),
              _metricChip(
                s.lookup('s4.lib.patient_command_board.metric.tasks'),
                _loadedTaskCount,
                Icons.task_alt,
              ),
              _metricChip(
                s.lookup('s4.lib.patient_command_board.metric.alerts'),
                _loadedAlertCount,
                Icons.health_and_safety,
              ),
              _metricChip(
                s.lookup('s4.lib.patient_command_board.metric.discharge'),
                _loadedDischargeCount,
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

  Widget _buildLoadMoreButton(ThemeData theme) {
    final counts = _asMap(_board['counts']);
    final total = _int(counts['total']);
    final remaining = total > _rows.length ? total - _rows.length : _pageSize;
    final nextCount = remaining < _pageSize ? remaining : _pageSize;
    final s = AppStrings.of(context);
    final label = nextCount > 0
        ? s.format('s4.dynamic.patient_command_board.load_next_patients', {
            'count': nextCount,
          })
        : s.lookup('s4.lib.patient_command_board.load_more_patients');
    return Center(
      child: FilledButton.tonalIcon(
        onPressed: _loadingMore ? null : _loadMore,
        icon: _loadingMore
            ? SizedBox(
                width: 16,
                height: 16,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: theme.colorScheme.onSecondaryContainer,
                ),
              )
            : const Icon(Icons.expand_more),
        label: Text(
          _loadingMore
              ? s.lookup('s4.lib.patient_command_board.loading_patients')
              : label,
        ),
      ),
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
              _filterChip(
                'all',
                AppStrings.of(
                  context,
                ).lookup('s4.lib.patient_command_board.filter.all'),
              ),
              _filterChip(
                'emergency',
                AppStrings.of(
                  context,
                ).lookup('s4.lib.patient_command_board.filter.emergency'),
              ),
              _filterChip(
                'alerts',
                AppStrings.of(
                  context,
                ).lookup('s4.lib.patient_command_board.filter.alerts'),
              ),
              _filterChip(
                'tasks',
                AppStrings.of(
                  context,
                ).lookup('s4.lib.patient_command_board.filter.tasks'),
              ),
              _filterChip(
                'discharge',
                AppStrings.of(
                  context,
                ).lookup('s4.lib.patient_command_board.filter.discharge'),
              ),
            ],
          ),
        ),
        if (wards.isNotEmpty) ...[
          const SizedBox(height: 10),
          DropdownButtonFormField<String?>(
            initialValue: _ward,
            decoration: InputDecoration(
              labelText: AppStrings.of(
                context,
              ).lookup('s4.lib.patient_command_board.ward_area'),
              prefixIcon: const Icon(Icons.location_on_outlined),
              border: const OutlineInputBorder(),
              isDense: true,
            ),
            items: [
              const DropdownMenuItem<String?>(
                value: null,
                child: AppText('due_meds.filter.all_wards'),
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
    final s = AppStrings.of(context);
    final patient = _asMap(row['patient']);
    final location = _asMap(row['location']);
    final priority = _asMap(row['priority']);
    final age = _asMap(_asMap(row['timers'])['age']);
    final diagnosis = _asMap(row['diagnosis']);
    final allergies = _asMap(row['allergies']);
    final alerts = _asMap(row['alerts']);
    final tasks = _asMap(row['tasks']);
    final discharge = _asMap(row['discharge']);
    final icuChart = _asMap(row['icu_chart']);
    final actions = _asListOfMaps(row['actions']);
    final color = _colorFor(_text(priority['color']));
    final name = _text(
      patient['name'],
      s.lookup('s4.lib.patient_command_board.patient'),
    );
    final hospitalNumber = _text(patient['hospital_number']);
    final ward = _text(location['ward']);
    final bed = _text(location['bed_number']);
    final diagnosisHidden =
        _text(diagnosis['source']).toLowerCase() == 'minimized' ||
        _text(diagnosis['status']).toLowerCase() == 'hidden';
    final diagnosisText = diagnosisHidden
        ? s.lookup('s4.lib.patient_command_board.clinical_details_hidden')
        : _text(
            diagnosis['text'],
            s.lookup('s4.lib.patient_command_board.diagnosis_pending'),
          );
    final diagnosisType = diagnosisHidden
        ? s.lookup('s4.lib.patient_command_board.location_only')
        : _text(
            diagnosis['type'],
            s.lookup('s4.lib.patient_command_board.working'),
          );

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
                                    s.format(
                                      's4.dynamic.patient_command_board.hospital_id',
                                      {'id': hospitalNumber},
                                    ),
                                  if (ward.isNotEmpty) ward,
                                  if (bed.isNotEmpty)
                                    s.format(
                                      's4.dynamic.patient_command_board.bed',
                                      {'bed': bed},
                                    ),
                                  s.format(
                                    's4.dynamic.patient_command_board.admission_number',
                                    {'id': row['admission_id']},
                                  ),
                                ].join(' - '),
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color: theme.colorScheme.onSurfaceVariant,
                                ),
                              ),
                            ],
                          ),
                        ),
                        // One-tap patient summary (roadmap E5).
                        IconButton(
                          tooltip: AppStrings.of(context).summaryTooltip,
                          icon: const Icon(Icons.assignment_ind_outlined),
                          visualDensity: VisualDensity.compact,
                          onPressed: () {
                            final uid = _text(patient['uid']);
                            if (uid.isEmpty) return;
                            PatientSummarySheet.show(
                              context,
                              patientUid: uid,
                              patientName: name,
                            );
                          },
                        ),
                        _statusBadge(
                          _text(
                            priority['label'],
                            s.lookup('s4.lib.patient_command_board.routine'),
                          ),
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
                          _text(
                            age['label'],
                            s.lookup('s4.lib.patient_command_board.no_time'),
                          ),
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
                          label: AppText(
                            's4.dynamic.patient_command_board.allergies_count',
                            values: {'count': _int(allergies['count'])},
                          ),
                          onPressed: () => _openAllergies(row),
                        ),
                        ActionChip(
                          avatar: const Icon(Icons.health_and_safety, size: 16),
                          label: AppText(
                            's4.dynamic.patient_command_board.alerts_count',
                            values: {'count': _int(alerts['count'])},
                          ),
                          onPressed: () => _openAlerts(row),
                        ),
                        ActionChip(
                          avatar: const Icon(Icons.task_alt, size: 16),
                          label: AppText(
                            's4.dynamic.patient_command_board.tasks_count',
                            values: {'count': _int(tasks['open_count'])},
                          ),
                          onPressed: () => _openTasks(row),
                        ),
                        ActionChip(
                          avatar: const Icon(
                            Icons.fact_check_outlined,
                            size: 16,
                          ),
                          label: const AppText(
                            's4.lib.patient_command_board.care_plans',
                          ),
                          onPressed: () => _openCarePlans(row),
                        ),
                        ActionChip(
                          avatar: const Icon(
                            Icons.local_fire_department_outlined,
                            size: 16,
                          ),
                          label: Text(s.burnCareAction),
                          onPressed: _burnChartRoute(row) == null
                              ? null
                              : () => _openBurnChart(row),
                        ),
                        if (discharge['initiated'] == true)
                          _statusBadge(
                            _text(
                              discharge['checklist_state'],
                              s.lookup(
                                's4.lib.patient_command_board.filter.discharge',
                              ),
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
                    if (IcuChartDepthPanel.hasRenderableData(icuChart)) ...[
                      const SizedBox(height: 10),
                      IcuChartDepthPanel(chart: icuChart),
                    ],
                    if (NicuPicuChartPanel.hasRenderableData(
                      _asMap(icuChart['nicu']),
                    )) ...[
                      const SizedBox(height: 10),
                      NicuPicuChartPanel(nicu: _asMap(icuChart['nicu'])),
                    ],
                    const SizedBox(height: 10),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: actions
                          .map(
                            (action) => OutlinedButton.icon(
                              onPressed: () => _openAction(row, action),
                              icon: Icon(_iconForAction(_text(action['key']))),
                              label: Text(
                                _text(
                                  action['label'],
                                  s.lookup('s4.lib.patient_command_board.open'),
                                ),
                              ),
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
      'referral' => Icons.medical_services_outlined,
      'case_sheet' => Icons.assignment,
      'discharge' => Icons.rule_folder,
      'care_plan' || 'care_plans' => Icons.fact_check_outlined,
      'vitals' => Icons.monitor_heart,
      'handover' => Icons.swap_horiz,
      'burn_chart' || 'burns' => Icons.local_fire_department_outlined,
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
              label: const AppText('action.retry'),
            ),
          ],
        ),
      ),
    );
  }
}

class _CarePlanSheet extends StatefulWidget {
  const _CarePlanSheet({required this.patientUid, required this.patientName});

  final String patientUid;
  final String patientName;

  @override
  State<_CarePlanSheet> createState() => _CarePlanSheetState();
}

class _CarePlanSheetState extends State<_CarePlanSheet> {
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _carePlans = const [];
  final Set<String> _busy = <String>{};

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
      final data = await MedicalApiService.getPatientCarePlans(
        widget.patientUid,
      );
      if (!mounted) return;
      setState(() {
        _carePlans = _carePlanList(data['care_plans']);
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _withBusy(String key, Future<void> Function() action) async {
    if (_busy.contains(key)) return;
    setState(() => _busy.add(key));
    try {
      await action();
      await _load();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: AppText('s4.lib.patient_command_board.care_plan_updated'),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(e.toString().replaceFirst('Exception: ', ''))),
      );
    } finally {
      if (mounted) setState(() => _busy.remove(key));
    }
  }

  Future<void> _markGoalAchieved(Map<String, dynamic> goal) async {
    final id = _carePlanInt(goal['id']);
    if (id <= 0) return;
    await _withBusy('goal-$id', () async {
      await MedicalApiService.updateCarePlanGoalProgress(
        id,
        status: 'achieved',
        currentValue: _carePlanText(goal['target_value']).isEmpty
            ? null
            : _carePlanText(goal['target_value']),
      );
    });
  }

  Future<void> _completeActivity(Map<String, dynamic> activity) async {
    final id = _carePlanInt(activity['id']);
    if (id <= 0) return;
    await _withBusy('activity-$id', () async {
      await MedicalApiService.completeCarePlanActivity(id);
    });
  }

  String _localizedCarePlanSummary(Map<String, dynamic> plan) {
    final s = AppStrings.of(context);
    final goals = _patientCommandBoardListCount(plan['goals']);
    final activities = _patientCommandBoardListCount(plan['activities']);
    final pieces = <String>[
      s.format('s4.dynamic.patient_command_board.goals_count', {
        'count': goals,
      }),
      s.format('s4.dynamic.patient_command_board.activities_count', {
        'count': activities,
      }),
    ];
    final status = _carePlanText(plan['status']);
    if (status.isNotEmpty) pieces.add(status.replaceAll('_', ' '));
    return pieces.join(' - ');
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = AppStrings.of(context);
    return SafeArea(
      child: DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.82,
        minChildSize: 0.45,
        maxChildSize: 0.95,
        builder: (context, scrollController) => ListView(
          controller: scrollController,
          padding: const EdgeInsets.fromLTRB(18, 4, 18, 24),
          children: [
            Row(
              children: [
                const Icon(
                  Icons.fact_check_outlined,
                  color: AppTheme.primaryBlue,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      AppText(
                        's4.lib.patient_command_board.care_plans',
                        style: theme.textTheme.titleLarge?.copyWith(
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      Text(
                        widget.patientName,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  tooltip: AppStrings.of(context).lookup('action.refresh'),
                  onPressed: _loading ? null : _load,
                  icon: const Icon(Icons.refresh),
                ),
              ],
            ),
            const SizedBox(height: 12),
            if (_loading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 48),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_error != null)
              _CarePlanMessage(
                icon: Icons.cloud_off_outlined,
                title: s.lookup(
                  's4.lib.patient_command_board.could_not_load_care_plans',
                ),
                body: _error!,
                action: FilledButton.icon(
                  onPressed: _load,
                  icon: const Icon(Icons.refresh),
                  label: const AppText('action.retry'),
                ),
              )
            else if (_carePlans.isEmpty)
              _CarePlanMessage(
                icon: Icons.assignment_outlined,
                title: s.lookup('s4.lib.patient_command_board.no_care_plans'),
                body: s.lookup(
                  's4.lib.patient_command_board.no_active_care_plan',
                ),
              )
            else
              ..._carePlans.map(_buildCarePlanCard),
          ],
        ),
      ),
    );
  }

  Widget _buildCarePlanCard(Map<String, dynamic> plan) {
    final theme = Theme.of(context);
    final s = AppStrings.of(context);
    final goals = _carePlanList(plan['goals']);
    final activities = _carePlanList(plan['activities']);
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              _carePlanText(
                plan['display_name'],
                s.lookup('s4.lib.patient_command_board.care_plan'),
              ),
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              _localizedCarePlanSummary(plan),
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            if (_carePlanText(plan['description']).isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(_carePlanText(plan['description'])),
            ],
            const SizedBox(height: 12),
            _CarePlanSubheading(
              icon: Icons.flag_outlined,
              title: s.lookup('s4.lib.patient_command_board.goals'),
              count: goals.length,
            ),
            const SizedBox(height: 6),
            if (goals.isEmpty)
              const AppText('s4.lib.patient_command_board.no_goals_recorded')
            else
              ...goals.map(_buildGoalTile),
            const SizedBox(height: 12),
            _CarePlanSubheading(
              icon: Icons.playlist_add_check_circle_outlined,
              title: s.lookup('s4.lib.patient_command_board.activities'),
              count: activities.length,
            ),
            const SizedBox(height: 6),
            if (activities.isEmpty)
              const AppText(
                's4.lib.patient_command_board.no_activities_recorded',
              )
            else
              ...activities.map(_buildActivityTile),
          ],
        ),
      ),
    );
  }

  Widget _buildGoalTile(Map<String, dynamic> goal) {
    final id = _carePlanInt(goal['id']);
    final status = _carePlanText(goal['status']);
    final achieved = status == 'achieved' || status == 'cancelled';
    final busy = _busy.contains('goal-$id');
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: const Icon(Icons.flag_outlined),
      title: Text(
        _carePlanText(
          goal['description'],
          AppStrings.of(context).lookup('s4.lib.patient_command_board.goal'),
        ),
      ),
      subtitle: Text(
        [
          _carePlanText(goal['priority']),
          status.replaceAll('_', ' '),
          if (_carePlanText(goal['target_value']).isNotEmpty)
            AppStrings.of(context).format(
              's4.dynamic.patient_command_board.target_value',
              {'value': _carePlanText(goal['target_value'])},
            ),
          if (_carePlanText(goal['current_value']).isNotEmpty)
            AppStrings.of(context).format(
              's4.dynamic.patient_command_board.current_value',
              {'value': _carePlanText(goal['current_value'])},
            ),
        ].where((part) => part.isNotEmpty).join(' - '),
      ),
      trailing: achieved
          ? null
          : TextButton.icon(
              onPressed: busy ? null : () => _markGoalAchieved(goal),
              icon: busy
                  ? const SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.check_circle_outline, size: 18),
              label: const AppText('s4.lib.patient_command_board.achieve'),
            ),
    );
  }

  Widget _buildActivityTile(Map<String, dynamic> activity) {
    final id = _carePlanInt(activity['id']);
    final status = _carePlanText(activity['status']);
    final done = status == 'completed' || status == 'cancelled';
    final busy = _busy.contains('activity-$id');
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: const Icon(Icons.playlist_add_check_outlined),
      title: Text(
        _carePlanText(
          activity['title'],
          AppStrings.of(
            context,
          ).lookup('s4.lib.patient_command_board.activity'),
        ),
      ),
      subtitle: Text(
        [
          _carePlanText(activity['activity_kind']).replaceAll('_', ' '),
          status.replaceAll('_', ' '),
          if (_carePlanDate(activity['next_due_at']).isNotEmpty)
            AppStrings.of(context).format(
              's4.dynamic.patient_command_board.due_date',
              {'date': _carePlanDate(activity['next_due_at'])},
            ),
        ].where((part) => part.isNotEmpty).join(' - '),
      ),
      trailing: done
          ? null
          : TextButton.icon(
              onPressed: busy ? null : () => _completeActivity(activity),
              icon: busy
                  ? const SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.done_all_outlined, size: 18),
              label: const AppText('front_office.appointment_status.completed'),
            ),
    );
  }
}

class _CarePlanSubheading extends StatelessWidget {
  const _CarePlanSubheading({
    required this.icon,
    required this.title,
    required this.count,
  });

  final IconData icon;
  final String title;
  final int count;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Row(
      children: [
        Icon(icon, size: 18, color: AppTheme.primaryTeal),
        const SizedBox(width: 6),
        Text(
          s.format('s4.dynamic.patient_command_board.subheading_count', {
            'title': title,
            'count': count,
          }),
          style: Theme.of(
            context,
          ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
        ),
      ],
    );
  }
}

class _CarePlanMessage extends StatelessWidget {
  const _CarePlanMessage({
    required this.icon,
    required this.title,
    required this.body,
    this.action,
  });

  final IconData icon;
  final String title;
  final String body;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 36),
      child: Column(
        children: [
          Icon(icon, size: 44, color: theme.colorScheme.outline),
          const SizedBox(height: 10),
          Text(title, style: theme.textTheme.titleMedium),
          const SizedBox(height: 6),
          Text(
            body,
            textAlign: TextAlign.center,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          if (action != null) ...[const SizedBox(height: 14), action!],
        ],
      ),
    );
  }
}

List<Map<String, dynamic>> _carePlanList(dynamic value) {
  if (value is! List) return const [];
  return value
      .whereType<Map>()
      .map((item) => Map<String, dynamic>.from(item))
      .toList();
}

String _carePlanText(dynamic value, [String fallback = '']) {
  final text = (value ?? '').toString().trim();
  return text.isEmpty ? fallback : text;
}

String _carePlanDate(dynamic value) {
  final text = _carePlanText(value);
  if (text.isEmpty) return '';
  return text.length >= 10 ? text.substring(0, 10) : text;
}

int _carePlanInt(dynamic value) => int.tryParse('${value ?? 0}') ?? 0;

class _FocusedPatientBanner extends StatelessWidget {
  final String patientLabel;
  final String? actionLabel;

  const _FocusedPatientBanner({
    required this.patientLabel,
    required this.actionLabel,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = AppStrings.of(context);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppTheme.primaryBlue.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppTheme.primaryBlue.withValues(alpha: 0.24)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.my_location_outlined, color: AppTheme.primaryBlue),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  s.format('s4.dynamic.patient_command_board.focused_patient', {
                    'patient': patientLabel,
                  }),
                  style: theme.textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  actionLabel == null
                      ? s.lookup(
                          's4.lib.patient_command_board.only_this_patient_loaded',
                        )
                      : s.format(
                          's4.dynamic.patient_command_board.opening_action',
                          {'action': actionLabel!.toLowerCase()},
                        ),
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
}

class _EmptyBoard extends StatelessWidget {
  final String filter;

  const _EmptyBoard({required this.filter});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = AppStrings.of(context);
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
            filter == 'all'
                ? s.lookup('s4.lib.patient_command_board.no_active_patients')
                : s.lookup('s4.lib.patient_command_board.no_matching_patients'),
            style: theme.textTheme.titleMedium,
          ),
        ],
      ),
    );
  }
}
