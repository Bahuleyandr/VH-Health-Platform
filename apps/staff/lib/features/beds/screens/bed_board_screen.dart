import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import '../../../core/config/role_config.dart';
import '../../../core/navigation/ip_command_board_routes.dart';
import '../../../core/services/api_client.dart';
import '../../../core/services/auth_service.dart';
import '../../../core/services/bed_board_print_service.dart';
import '../../../core/services/telemetry_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../core/widgets/online_only_action_state.dart';
import '../../../core/widgets/patient_search_action.dart';
import '../../../core/widgets/states/empty_state.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';
import '../../../core/widgets/states/success_toast.dart';
import '../../../core/widgets/voice_dictate_button.dart';
import '../../../core/widgets/ward_list_filter_bar.dart';
import '../../../core/widgets/workbench_split_view.dart';
import '../../../l10n/app_strings.dart';

String _compactString(dynamic value) {
  if (value == null) return '';
  if (value is String) return value.trim();
  if (value is Iterable) {
    return value
        .map(_compactString)
        .where((item) => item.isNotEmpty)
        .join(', ');
  }
  if (value is Map) {
    return _compactString(
      value['name'] ??
          value['staff_name'] ??
          value['assigned_to_name'] ??
          value['label'],
    );
  }
  return value.toString().trim();
}

String _cleaningAssigneeText(Map<String, dynamic> bed) {
  final staffNames = _compactString(bed['housekeeping_staff_names']);
  if (staffNames.isNotEmpty) return staffNames;

  final allNames = _compactString(bed['housekeeping_assignee_names']);
  if (allNames.isNotEmpty) return allNames;

  final assignees = bed['housekeeping_assignees'];
  if (assignees is Iterable) {
    final staff = assignees
        .where(
          (row) =>
              row is Map &&
              (row['role'] ?? '').toString().toUpperCase() ==
                  'HOUSEKEEPING_STAFF',
        )
        .map(_compactString)
        .where((item) => item.isNotEmpty)
        .join(', ');
    if (staff.isNotEmpty) return staff;
    return assignees
        .map(_compactString)
        .where((item) => item.isNotEmpty)
        .join(', ');
  }

  return _compactString(bed['housekeeping_assigned_to_name']);
}

String _titleCaseDisplayValue(String value) {
  final text = value.trim();
  if (text.isEmpty) return text;
  return text[0].toUpperCase() + text.substring(1).toLowerCase();
}

String _bedStatusDisplayLabel(AppStrings strings, String status) {
  switch (status.toLowerCase()) {
    case 'available':
      return strings.bedBoardLegendAvailable;
    case 'occupied':
      return strings.bedBoardLegendOccupied;
    case 'maintenance':
      return strings.bedBoardLegendMaintenance;
    case 'cleaning':
      return strings.bedBoardFilterCleaning;
    default:
      return _titleCaseDisplayValue(status);
  }
}

const String bedBoardAllStatuses = 'all';
const String bedBoardCleaningStatus = 'cleaning';

List<WardListFilterOption> bedBoardWardFilterOptions(
  List<Map<String, dynamic>> wards,
  AppStrings strings,
) {
  final options = <WardListFilterOption>[];
  final seen = <String>{};
  for (var index = 0; index < wards.length; index += 1) {
    final ward = wards[index];
    final value = (ward['id'] ?? ward['_id'] ?? ward['wardId'] ?? '')
        .toString()
        .trim();
    if (value.isEmpty || !seen.add(value)) continue;
    final name =
        (ward['name'] ??
                ward['wardName'] ??
                '${strings.bedBoardWardFallback} ${index + 1}')
            .toString()
            .trim();
    options.add(WardListFilterOption(value: value, label: name));
  }
  options.sort(
    (a, b) => a.label.toLowerCase().compareTo(b.label.toLowerCase()),
  );
  return options;
}

List<WardListFilterOption> bedBoardStatusFilterOptions({
  required bool housekeepingOnly,
  required AppStrings strings,
}) {
  if (housekeepingOnly) {
    return [
      WardListFilterOption(
        value: bedBoardCleaningStatus,
        label: strings.bedBoardFilterCleaning,
      ),
    ];
  }
  return [
    WardListFilterOption(
      value: bedBoardAllStatuses,
      label: strings.bedBoardFilterAllStatuses,
    ),
    WardListFilterOption(
      value: 'available',
      label: strings.bedBoardFilterAvailable,
    ),
    WardListFilterOption(
      value: 'occupied',
      label: strings.bedBoardFilterOccupied,
    ),
    WardListFilterOption(
      value: 'maintenance',
      label: strings.bedBoardFilterMaintenance,
    ),
    WardListFilterOption(
      value: bedBoardCleaningStatus,
      label: strings.bedBoardFilterCleaning,
    ),
  ];
}

List<Map<String, dynamic>> filterBedBoardBeds(
  List<Map<String, dynamic>> beds, {
  String statusValue = bedBoardAllStatuses,
  String query = '',
  bool housekeepingOnly = false,
}) {
  Iterable<Map<String, dynamic>> rows = beds;
  if (housekeepingOnly) {
    rows = rows.where(
      (b) => (b['status'] ?? '').toString().toLowerCase() == 'cleaning',
    );
  }
  final status = statusValue.trim().toLowerCase();
  if (status.isNotEmpty && status != bedBoardAllStatuses) {
    rows = rows.where(
      (b) => (b['status'] ?? '').toString().toLowerCase() == status,
    );
  }
  final q = query.trim().toLowerCase();
  if (q.isNotEmpty) {
    rows = rows.where((b) {
      final num = (b['bedNumber'] ?? b['bed_number'] ?? b['number'] ?? '')
          .toString()
          .toLowerCase();
      final patient =
          (b['patient_full_name'] ??
                  b['patientName'] ??
                  b['patient_name'] ??
                  '')
              .toString()
              .toLowerCase();
      final hospitalNumber =
          (b['patient_hospital_number'] ?? b['hospital_number'] ?? '')
              .toString()
              .toLowerCase();
      return num.contains(q) ||
          patient.contains(q) ||
          hospitalNumber.contains(q);
    });
  }
  return rows.toList();
}

class BedBoardScreen extends StatefulWidget {
  const BedBoardScreen({super.key});

  @override
  State<BedBoardScreen> createState() => _BedBoardScreenState();
}

class _BedBoardScreenState extends State<BedBoardScreen> {
  List<Map<String, dynamic>> _wards = [];
  List<Map<String, dynamic>> _beds = [];
  String? _selectedWardId;
  String? _selectedWardName;
  Map<String, dynamic>? _selectedBed;
  String _searchQuery = '';
  bool _loadingWards = true;
  bool _loadingBeds = false;
  String? _error;
  StaffRole _role = StaffRole.general;
  bool _didFetchInitialWards = false;

  StreamSubscription<RealtimeEvent>? _bedEventSub;
  Timer? _refreshDebounce;

  // Bed-grid filters. `_bedQuery` matches against bed_number; `_bedStatusFilter`
  // is one of "all" / "available" / "occupied" / "maintenance" / "cleaning".
  String _bedQuery = '';
  String _bedStatusFilter = bedBoardAllStatuses;
  bool get _isHousekeepingRole =>
      _role == StaffRole.housekeeping ||
      _role == StaffRole.housekeepingIncharge;

  List<Map<String, dynamic>> get _filteredBeds {
    return filterBedBoardBeds(
      _beds,
      statusValue: _bedStatusFilter,
      query: _bedQuery,
      housekeepingOnly: _isHousekeepingRole,
    );
  }

  String _bedIdentity(Map<String, dynamic>? bed) {
    if (bed == null) return '';
    return (bed['id'] ??
            bed['_id'] ??
            bed['bed_id'] ??
            bed['bedId'] ??
            bed['bed_number'] ??
            bed['bedNumber'] ??
            '')
        .toString();
  }

  bool _isSelectedBed(Map<String, dynamic> bed) {
    final selectedId = _bedIdentity(_selectedBed);
    return selectedId.isNotEmpty && selectedId == _bedIdentity(bed);
  }

  void _syncSelectedBedWithLatestRows() {
    final selectedId = _bedIdentity(_selectedBed);
    if (selectedId.isEmpty) {
      _selectedBed = null;
      return;
    }
    for (final bed in _beds) {
      if (_bedIdentity(bed) == selectedId) {
        _selectedBed = bed;
        return;
      }
    }
    _selectedBed = null;
  }

  @override
  void initState() {
    super.initState();
    _loadRole();
    _attachRealtime();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_didFetchInitialWards) return;
    _didFetchInitialWards = true;
    _fetchWards();
  }

  Future<void> _loadRole() async {
    final roleStr = await AuthService.getRole();
    if (!mounted) return;
    final role = StaffRole.fromString(roleStr);
    setState(() {
      _role = role;
      if (role == StaffRole.housekeeping ||
          role == StaffRole.housekeepingIncharge) {
        _bedStatusFilter = bedBoardCleaningStatus;
      }
    });
  }

  Future<void> _attachRealtime() async {
    final rt = RealtimeClient.instance;
    await rt.connect();
    _bedEventSub = rt.events('staff:beds').listen((_) => _debouncedRefresh());
  }

  void _debouncedRefresh() {
    _refreshDebounce?.cancel();
    _refreshDebounce = Timer(const Duration(milliseconds: 400), () {
      if (!mounted) return;
      _fetchWards(showLoading: false);
      if (_selectedWardId != null) {
        _fetchBeds(_selectedWardId!);
      }
    });
  }

  @override
  void dispose() {
    _bedEventSub?.cancel();
    _refreshDebounce?.cancel();
    super.dispose();
  }

  Future<void> _fetchWards({bool showLoading = true}) async {
    final s = AppStrings.of(context);
    if (showLoading) {
      setState(() {
        _loadingWards = true;
        _error = null;
      });
    }
    try {
      final response = await ApiClient.get('/wards');
      if (response.isSuccess) {
        final data = response.data;
        final list = data is List
            ? data
            : (data is Map ? data['wards'] ?? [] : []);
        _wards = List<Map<String, dynamic>>.from(
          (list as List).map(
            (w) => w is Map<String, dynamic> ? w : <String, dynamic>{},
          ),
        );
      } else {
        if (showLoading) {
          _error = response.failureMessage(s.bedBoardLoadWardsFailed);
        }
      }
    } catch (e) {
      if (showLoading) {
        _error = s.bedBoardServerUnreachable;
      }
    } finally {
      if (mounted) setState(() => _loadingWards = false);
    }
  }

  Future<void> _fetchBeds(String wardId, {bool clearBeds = false}) async {
    setState(() {
      _loadingBeds = true;
      if (clearBeds) _beds = [];
    });
    try {
      final response = await ApiClient.get('/beds/ward/$wardId');
      if (response.isSuccess) {
        final data = response.data;
        final list = data is List
            ? data
            : (data is Map ? data['beds'] ?? [] : []);
        _beds = List<Map<String, dynamic>>.from(
          (list as List).map(
            (b) => b is Map<String, dynamic> ? b : <String, dynamic>{},
          ),
        );
        _syncSelectedBedWithLatestRows();
      }
    } catch (e) {
      debugPrint('bed_board_screen.dart: $e');
    } finally {
      if (mounted) setState(() => _loadingBeds = false);
    }
  }

  Color _statusColor(String? status) {
    switch (status?.toLowerCase()) {
      case 'available':
        return AppTheme.successGreen;
      case 'occupied':
        return AppTheme.errorRed;
      case 'maintenance':
        return const Color(0xFFF9A825);
      case 'cleaning':
        return const Color(0xFF007A64);
      default:
        return Colors.grey;
    }
  }

  IconData _statusIcon(String? status) {
    switch (status?.toLowerCase()) {
      case 'available':
        return Icons.check_circle_outline;
      case 'occupied':
        return Icons.person;
      case 'maintenance':
        return Icons.build_circle_outlined;
      case 'cleaning':
        return Icons.cleaning_services_outlined;
      default:
        return Icons.bed;
    }
  }

  List<Map<String, dynamic>> get _filteredWards {
    if (_searchQuery.isEmpty) return _wards;
    final q = _searchQuery.toLowerCase();
    return _wards.where((w) {
      final name = (w['name'] ?? w['wardName'] ?? '').toString().toLowerCase();
      return name.contains(q);
    }).toList();
  }

  bool _bedAllowsNotes(Map<String, dynamic> bed) {
    final status = (bed['status'] ?? '').toString().toLowerCase();
    return status == 'occupied' || status == 'reserved';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(AppStrings.of(context).bedBoardTitle),
        backgroundColor: AppTheme.primaryBlue,
        foregroundColor: Colors.white,
        actions: [
          // Print button — only meaningful with a ward selected (otherwise
          // there's nothing to print). Generates an A4 PDF occupancy
          // sheet via BedBoardPrintService and shows the system print
          // dialog.
          if (_selectedWardId != null && _beds.isNotEmpty)
            IconButton(
              icon: const Icon(Icons.print_outlined),
              tooltip: AppStrings.of(context).bedBoardPrintTooltip,
              onPressed: _printCurrentWard,
            ),
          IconButton(
            icon: const Icon(Icons.refresh),
            tooltip: AppStrings.of(context).bedBoardRefreshTooltip,
            onPressed: () {
              _fetchWards();
              if (_selectedWardId != null) _fetchBeds(_selectedWardId!);
            },
          ),
          if (!_isHousekeepingRole) const PatientSearchAction(),
          const LogoutAction(),
        ],
      ),
      body: Column(
        children: [
          // Persistent legend — used to be tucked inside `_buildWardList()`
          // so it disappeared as soon as the user drilled into a ward, which
          // was the moment its dots actually started showing up on cards.
          // Pinned beneath the app bar so it's visible from both views.
          if (!_loadingWards && _error == null) _buildLegendStrip(),
          Expanded(
            child: _loadingWards
                ? const SkeletonList()
                : _error != null
                ? _buildError()
                : LayoutBuilder(
                    builder: (context, constraints) {
                      // Desktop / tablet two-pane: ≥1024px wide gets a
                      // fixed 320px wards rail on the left + the bed grid
                      // taking the rest. Tapping a ward swaps the right
                      // pane in place rather than navigating "into" the
                      // ward, so the user keeps both lists visible.
                      if (constraints.maxWidth >= 1100 &&
                          _selectedWardId != null) {
                        return _buildBedMasterDetail();
                      }
                      if (constraints.maxWidth >= 1024) {
                        return _buildTwoPane();
                      }
                      // Phone-width: existing drill-in flow.
                      return _selectedWardId == null
                          ? _buildWardList()
                          : _buildBedGrid();
                    },
                  ),
          ),
        ],
      ),
    );
  }

  Widget _buildTwoPane() {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SizedBox(width: 320, child: _buildWardList()),
        const VerticalDivider(width: 1),
        Expanded(
          child: _selectedWardId == null
              ? _buildSelectWardPlaceholder()
              : _buildBedGrid(forceHideBack: true),
        ),
      ],
    );
  }

  Widget _buildBedMasterDetail() {
    return WorkbenchSplitView(
      leading: _buildBedGrid(forceHideBack: true, selectInPane: true),
      trailing: _buildBedDetailPane(),
    );
  }

  Widget _buildBedDetailPane() {
    final bed = _selectedBed;
    if (bed == null) {
      return Container(
        color: AppTheme.cardSurface,
        padding: const EdgeInsets.all(24),
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.bed_outlined, size: 48, color: AppTheme.textSecondary),
              const SizedBox(height: 12),
              Text(
                AppStrings.of(context).bedBoardSelectBedPrompt,
                textAlign: TextAlign.center,
                style: TextStyle(color: AppTheme.textSecondary, fontSize: 14),
              ),
            ],
          ),
        ),
      );
    }

    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.escape): () {
          setState(() => _selectedBed = null);
        },
      },
      child: Focus(
        autofocus: true,
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: AppTheme.cardSurface,
            border: Border(
              left: BorderSide(color: AppTheme.divider.withValues(alpha: 0.35)),
            ),
          ),
          child: _BedDetailSheet(
            bed: bed,
            wardName: _selectedWardName ?? '',
            role: _role,
            embedded: true,
            onClose: () => setState(() => _selectedBed = null),
            onChanged: () async {
              await _fetchWards(showLoading: false);
              final wardId = _selectedWardId;
              if (wardId != null) await _fetchBeds(wardId);
            },
          ),
        ),
      ),
    );
  }

  Widget _buildSelectWardPlaceholder() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.local_hospital_outlined,
              size: 48,
              color: AppTheme.textSecondary,
            ),
            const SizedBox(height: 12),
            Text(
              AppStrings.of(context).bedBoardSelectWardPrompt,
              style: TextStyle(color: AppTheme.textSecondary, fontSize: 14),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _printCurrentWard() async {
    unawaited(
      Telemetry.event('bed_board.print', {
        'bed_count': _beds.length.toString(),
      }),
    );
    try {
      await BedBoardPrintService.print(
        wardName: _selectedWardName ?? '',
        beds: _beds,
        generatedBy: AppStrings.of(context).printGeneratedBy,
      );
    } catch (e) {
      if (!mounted) return;
      ErrorToast.show(
        context,
        AppStrings.of(
          context,
        ).bedBoardPrintFailed(e.toString().replaceFirst('Exception: ', '')),
      );
    }
  }

  Widget _buildLegendStrip() {
    final s = AppStrings.of(context);
    return Container(
      width: double.infinity,
      color: AppTheme.cardSurface,
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      child: Row(
        children: [
          _legendDot(AppTheme.successGreen, s.bedBoardLegendAvailable),
          const SizedBox(width: 16),
          _legendDot(AppTheme.errorRed, s.bedBoardLegendOccupied),
          const SizedBox(width: 16),
          _legendDot(const Color(0xFFF9A825), s.bedBoardLegendMaintenance),
          const SizedBox(width: 16),
          _legendDot(const Color(0xFF007A64), s.bedBoardFilterCleaning),
        ],
      ),
    );
  }

  Widget _buildError() {
    return ErrorState(
      message: (_error ?? '').replaceFirst('Exception: ', ''),
      onRetry: _fetchWards,
    );
  }

  Widget _buildWardList() {
    final s = AppStrings.of(context);
    return Column(
      children: [
        // Search bar
        Padding(
          padding: const EdgeInsets.all(16),
          child: TextField(
            decoration: InputDecoration(
              hintText: s.bedBoardSearchWardsHint,
              prefixIcon: const ExcludeSemantics(child: Icon(Icons.search)),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
              ),
              filled: true,
              fillColor: AppTheme.cardSurface,
            ),
            onChanged: (v) => setState(() => _searchQuery = v),
          ),
        ),

        // Ward list
        Expanded(
          child: _filteredWards.isEmpty
              ? (_searchQuery.isNotEmpty
                    ? Center(
                        child: Text(
                          s.noMatchesFor(_searchQuery),
                          style: TextStyle(color: AppTheme.textSecondary),
                        ),
                      )
                    : EmptyState(
                        icon: Icons.local_hospital_outlined,
                        title: s.bedBoardNoWardsYet,
                      ))
              : RefreshIndicator(
                  onRefresh: _fetchWards,
                  child: ListView.builder(
                    padding: const EdgeInsets.all(16),
                    itemCount: _filteredWards.length,
                    itemBuilder: (context, index) {
                      final ward = _filteredWards[index];
                      final name =
                          ward['name'] ??
                          ward['wardName'] ??
                          '${s.bedBoardWardFallback} ${index + 1}';
                      // Backend `/wards` returns snake_case (`bed_count`,
                      // `occupied_count`, `total_beds`); older mocks used
                      // the camelCase aliases. Read both shapes so the
                      // outer ward list stops showing 0/0/0 when the
                      // detail view (which counts beds directly) shows
                      // real numbers.
                      final totalBeds =
                          ward['totalBeds'] ??
                          ward['total'] ??
                          ward['bed_count'] ??
                          ward['total_beds'] ??
                          0;
                      final occupied =
                          ward['occupiedBeds'] ??
                          ward['occupied'] ??
                          ward['occupied_count'] ??
                          0;
                      final totalInt = totalBeds is num ? totalBeds.toInt() : 0;
                      final occupiedInt = occupied is num
                          ? occupied.toInt()
                          : 0;
                      final available =
                          ward['availableBeds'] ??
                          ward['available'] ??
                          (totalInt - occupiedInt).clamp(0, totalInt);
                      final wardId =
                          (ward['id'] ?? ward['_id'] ?? ward['wardId'] ?? '')
                              .toString();

                      return Card(
                        margin: const EdgeInsets.only(bottom: 12),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: ListTile(
                          contentPadding: const EdgeInsets.all(16),
                          leading: Container(
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(
                              color: AppTheme.primaryBlue.withValues(
                                alpha: 0.1,
                              ),
                              borderRadius: BorderRadius.circular(10),
                            ),
                            child: const Icon(
                              Icons.local_hotel,
                              color: AppTheme.primaryBlue,
                            ),
                          ),
                          title: Text(
                            name.toString(),
                            style: const TextStyle(fontWeight: FontWeight.w600),
                          ),
                          subtitle: Padding(
                            padding: const EdgeInsets.only(top: 8),
                            child: Wrap(
                              spacing: 12,
                              runSpacing: 8,
                              children: [
                                _miniStat(
                                  s.bedBoardWardStatTotal,
                                  '$totalBeds',
                                  Colors.grey,
                                ),
                                _miniStat(
                                  s.bedBoardWardStatFree,
                                  '$available',
                                  AppTheme.successGreen,
                                ),
                                _miniStat(
                                  s.bedBoardWardStatUsed,
                                  '$occupied',
                                  AppTheme.errorRed,
                                ),
                              ],
                            ),
                          ),
                          trailing: const Icon(Icons.chevron_right),
                          onTap: () => _selectWard(wardId, name.toString()),
                        ),
                      );
                    },
                  ),
                ),
        ),
      ],
    );
  }

  Widget _buildBedGrid({
    bool forceHideBack = false,
    bool selectInPane = false,
  }) {
    final available = _beds
        .where(
          (b) => (b['status'] ?? '').toString().toLowerCase() == 'available',
        )
        .length;

    final s = AppStrings.of(context);
    return Column(
      children: [
        // Header. The back button is only meaningful in single-pane
        // (phone) mode where tapping it returns to the wards list.
        // On the desktop two-pane layout the wards list is always
        // visible on the left, so the back button would flip the
        // right pane to a placeholder for no good reason.
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          color: AppTheme.cardSurface,
          child: Row(
            children: [
              if (!forceHideBack)
                IconButton(
                  icon: const Icon(Icons.arrow_back),
                  tooltip: s.bedBoardBackToWards,
                  onPressed: () => setState(() {
                    _selectedWardId = null;
                    _selectedWardName = null;
                    _selectedBed = null;
                    _beds = [];
                    _bedQuery = '';
                    _bedStatusFilter = _defaultBedStatusFilter;
                  }),
                ),
              if (forceHideBack) const SizedBox(width: 12),
              Text(
                _selectedWardName ?? s.bedBoardWardFallback,
                style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.bold,
                  color: AppTheme.textPrimary,
                ),
              ),
              const Spacer(),
              Text(
                s.bedBoardCountAvailable(available),
                style: const TextStyle(
                  color: AppTheme.successGreen,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(width: 12),
            ],
          ),
        ),

        // Search row
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
          child: TextField(
            decoration: InputDecoration(
              hintText: s.bedBoardSearchBedsHint,
              prefixIcon: const ExcludeSemantics(child: Icon(Icons.search)),
              isDense: true,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
              ),
              filled: true,
              fillColor: AppTheme.cardSurface,
            ),
            onChanged: (v) => setState(() => _bedQuery = v),
          ),
        ),

        WardListFilterBar(
          keyPrefix: 'bed-board',
          wardOptions: _bedBoardWardOptions,
          selectedWardValue: _selectedWardId ?? '',
          onWardChanged: (wardId) {
            final wardName = _wards
                .map(
                  (ward) => {
                    'id': (ward['id'] ?? ward['_id'] ?? ward['wardId'] ?? '')
                        .toString(),
                    'name': (ward['name'] ?? ward['wardName'] ?? '').toString(),
                  },
                )
                .firstWhere(
                  (ward) => ward['id'] == wardId,
                  orElse: () => {
                    'id': wardId,
                    'name': '${s.bedBoardWardFallback} $wardId',
                  },
                )['name']!;
            _selectWard(wardId, wardName);
          },
          filterLabel: s.bedBoardFilterStatusLabel,
          filterOptions: bedBoardStatusFilterOptions(
            housekeepingOnly: _isHousekeepingRole,
            strings: s,
          ),
          selectedFilterValue: _bedStatusFilter,
          onFilterChanged: (value) => setState(() => _bedStatusFilter = value),
          hasActiveFilters: _bedStatusFilter != _defaultBedStatusFilter,
          onClear: () =>
              setState(() => _bedStatusFilter = _defaultBedStatusFilter),
        ),
        const SizedBox(height: 8),

        // Bed grid
        Expanded(
          child: _loadingBeds
              ? const SkeletonGrid()
              : _beds.isEmpty
              ? EmptyState(
                  icon: Icons.local_hotel,
                  title: s.bedBoardEmptyTitle,
                  body: s.bedBoardEmptyBody,
                )
              : _filteredBeds.isEmpty
              ? Center(
                  child: Text(
                    _bedQuery.isNotEmpty
                        ? s.noMatchesFor(_bedQuery)
                        : s.bedBoardNoStatusFiltered(_bedStatusFilter),
                    style: TextStyle(color: AppTheme.textSecondary),
                  ),
                )
              : RefreshIndicator(
                  onRefresh: () => _fetchBeds(_selectedWardId!),
                  child: GridView.builder(
                    padding: const EdgeInsets.all(16),
                    gridDelegate:
                        const SliverGridDelegateWithFixedCrossAxisCount(
                          crossAxisCount: 2,
                          mainAxisSpacing: 12,
                          crossAxisSpacing: 12,
                          childAspectRatio: 1.3,
                        ),
                    itemCount: _filteredBeds.length,
                    itemBuilder: (context, index) {
                      final bed = _filteredBeds[index];
                      return _buildBedCard(bed, selectInPane: selectInPane);
                    },
                  ),
                ),
        ),
      ],
    );
  }

  Widget _buildBedCard(Map<String, dynamic> bed, {bool selectInPane = false}) {
    final status = (bed['status'] ?? 'available').toString();
    final bedNumber =
        bed['bedNumber'] ??
        bed['bed_number'] ??
        bed['number'] ??
        bed['name'] ??
        '';
    final patientName =
        bed['patient_full_name'] ??
        bed['patientName'] ??
        bed['patient_name'] ??
        bed['patient']?['name'] ??
        '';
    final doctorName =
        bed['attending_doctor_name'] ??
        bed['doctorName'] ??
        bed['doctor']?['name'] ??
        '';
    final hospitalNumber =
        (bed['patient_hospital_number'] ?? bed['hospital_number'] ?? '')
            .toString()
            .trim();
    final notesAllowed = _bedAllowsNotes(bed);
    final hasNotes =
        notesAllowed && (bed['notes'] ?? '').toString().trim().isNotEmpty;
    final dischargeInitiated = (bed['discharge_initiated_at'] ?? '')
        .toString()
        .isNotEmpty;
    final cleaningAssigneeText = _cleaningAssigneeText(bed);
    final color = dischargeInitiated
        ? const Color(0xFFEF6C00)
        : _statusColor(status);
    final selected = selectInPane && _isSelectedBed(bed);
    final s = AppStrings.of(context);
    final statusLabel = dischargeInitiated
        ? s.bedSheetDischargeInitiatedShort
        : _bedStatusDisplayLabel(s, status);

    final card = Container(
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: selected ? AppTheme.primaryBlue : color,
          width: selected ? 3 : 2,
        ),
        boxShadow: [
          BoxShadow(
            color: (selected ? AppTheme.primaryBlue : color).withValues(
              alpha: selected ? 0.22 : 0.15,
            ),
            blurRadius: selected ? 12 : 8,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(_statusIcon(status), color: color, size: 20),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  s.bedNumber(bedNumber.toString()),
                  style: TextStyle(
                    fontWeight: FontWeight.bold,
                    color: color,
                    fontSize: 14,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              // A tiny note pip so users see at a glance which beds
              // already have notes recorded — saves opening every sheet
              // to find the one with the handover note.
              if (hasNotes)
                Icon(
                  Icons.sticky_note_2,
                  size: 14,
                  color: AppTheme.textSecondary,
                ),
            ],
          ),
          const Spacer(),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: color.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(
              statusLabel,
              style: TextStyle(
                fontSize: 11,
                color: color,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          if (status.toLowerCase() == 'occupied' &&
              patientName.toString().isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              patientName.toString(),
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w500,
                color: AppTheme.textPrimary,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            if (hospitalNumber.isNotEmpty)
              Text(
                hospitalNumber,
                style: TextStyle(fontSize: 11, color: AppTheme.textSecondary),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            if (doctorName.toString().isNotEmpty)
              Text(
                '${s.bedSheetDoctorPrefix} $doctorName',
                style: TextStyle(fontSize: 11, color: AppTheme.textSecondary),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
          ],
          if (status.toLowerCase() == 'cleaning' &&
              cleaningAssigneeText.isNotEmpty) ...[
            const SizedBox(height: 6),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  Icons.person_pin_circle_outlined,
                  size: 14,
                  color: AppTheme.textSecondary,
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: Text(
                    s.bedBoardCleaningAssignee(cleaningAssigneeText),
                    style: TextStyle(
                      fontSize: 11,
                      color: AppTheme.textSecondary,
                      fontWeight: FontWeight.w600,
                    ),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );

    // Build the screen-reader label so colour-blind / blind users get
    // the same information sighted users get from the coloured border.
    // Format: "Bed A-101, Occupied, Demo Patient Ravi" — empty/maintenance
    // beds simply skip the patient segment.
    final semanticParts = <String>[
      s.bedNumber(bedNumber.toString()),
      _bedStatusDisplayLabel(s, status),
      if (dischargeInitiated) s.bedSheetDischargeInitiatedShort,
      if (status.toLowerCase() == 'occupied' &&
          patientName.toString().isNotEmpty)
        s.bedBoardSemanticPatient(patientName.toString()),
      if (status.toLowerCase() == 'cleaning' && cleaningAssigneeText.isNotEmpty)
        s.bedBoardSemanticCleaningAssignedTo(cleaningAssigneeText),
      if (hospitalNumber.isNotEmpty)
        s.bedBoardSemanticHospitalId(hospitalNumber),
      if (hasNotes) s.bedBoardSemanticHasNotes,
    ];

    return Semantics(
      button: true,
      label: semanticParts.join(', '),
      hint: notesAllowed
          ? s.bedBoardSemanticViewDetailsEditNotes
          : s.bedBoardSemanticViewDetails,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: () {
            if (selectInPane) {
              setState(() => _selectedBed = bed);
            } else {
              _openBedSheet(bed);
            }
          },
          // Long-press → inline quick notes dialog. Skips the full sheet for
          // when a nurse just wants to scribble a one-line update during
          // rounds. Shorter path: 1 long-press → 1 dialog → Save.
          onLongPress: notesAllowed ? () => _openQuickNotesDialog(bed) : null,
          child: card,
        ),
      ),
    );
  }

  Future<void> _openQuickNotesDialog(Map<String, dynamic> bed) async {
    if (!_bedAllowsNotes(bed)) return;
    final id = (bed['id'] ?? '').toString();
    if (id.isEmpty) return;
    final initial = (bed['notes'] ?? '').toString();
    final controller = TextEditingController(text: initial);
    bool saving = false;
    String? errorMsg;

    final s = AppStrings.of(context);
    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => AlertDialog(
          title: Text(
            '${s.bedSheetSectionNotes} — ${s.bedNumber((bed['bed_number'] ?? bed['bedNumber'] ?? '').toString())}',
          ),
          content: SizedBox(
            width: 380,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextField(
                  controller: controller,
                  minLines: 3,
                  maxLines: 6,
                  textCapitalization: TextCapitalization.sentences,
                  decoration: InputDecoration(
                    hintText: s.bedSheetQuickNoteHint,
                    border: const OutlineInputBorder(),
                  ),
                ),
                Align(
                  alignment: Alignment.centerRight,
                  child: VoiceDictateButton(
                    controller: controller,
                    patientUid: (bed['patient_uid'] ?? '').toString().isNotEmpty
                        ? bed['patient_uid'].toString()
                        : null,
                    tooltip: s.bedSheetDictateQuickNote,
                  ),
                ),
                if (errorMsg != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    errorMsg!,
                    style: const TextStyle(
                      color: AppTheme.errorRed,
                      fontSize: 12,
                    ),
                  ),
                ],
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: saving ? null : () => Navigator.of(ctx).pop(false),
              child: Text(s.actionCancel),
            ),
            FilledButton(
              onPressed: saving
                  ? null
                  : () async {
                      setLocal(() {
                        saving = true;
                        errorMsg = null;
                      });
                      try {
                        final response = await ApiClient.patch(
                          '/beds/$id/notes',
                          body: {'notes': controller.text},
                        );
                        if (response.isSuccess) {
                          if (ctx.mounted) Navigator.of(ctx).pop(true);
                        } else {
                          setLocal(() {
                            errorMsg = response.failureMessage(
                              s.bedSheetSaveFailed,
                            );
                            saving = false;
                          });
                        }
                      } catch (e) {
                        setLocal(() {
                          errorMsg = s.bedBoardServerUnreachable;
                          saving = false;
                        });
                      }
                    },
              child: Text(saving ? s.bedSheetSavingLabel : s.actionSave),
            ),
          ],
        ),
      ),
    );
    controller.dispose();
    if (saved == true && _selectedWardId != null) {
      await _fetchWards(showLoading: false);
      await _fetchBeds(_selectedWardId!);
    }
  }

  // Opens a modal bottom sheet with the bed's full context (patient +
  // admission details from the augmented `/beds/ward/:id` join) and a
  // notes textarea wired to PATCH /beds/:id/notes. After save, the
  // bed list is refreshed so the new note's pip indicator and any
  // realtime change shows up immediately.
  Future<void> _openBedSheet(Map<String, dynamic> bed) async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppTheme.cardSurface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (sheetCtx) => _BedDetailSheet(
        bed: bed,
        wardName: _selectedWardName ?? '',
        role: _role,
      ),
    );
    if (saved == true && _selectedWardId != null) {
      await _fetchWards(showLoading: false);
      await _fetchBeds(_selectedWardId!);
    }
  }

  String get _defaultBedStatusFilter =>
      _isHousekeepingRole ? bedBoardCleaningStatus : bedBoardAllStatuses;

  List<WardListFilterOption> get _bedBoardWardOptions {
    final s = AppStrings.of(context);
    final options = bedBoardWardFilterOptions(_wards, s);
    final selectedId = _selectedWardId;
    if (selectedId == null || selectedId.isEmpty) return options;
    if (options.any((option) => option.value == selectedId)) return options;
    return [
      WardListFilterOption(
        value: selectedId,
        label: _selectedWardName ?? '${s.bedBoardWardFallback} $selectedId',
      ),
      ...options,
    ];
  }

  void _selectWard(String wardId, String wardName) {
    setState(() {
      _selectedWardId = wardId;
      _selectedWardName = wardName;
      _selectedBed = null;
      _bedStatusFilter = _defaultBedStatusFilter;
    });
    _fetchBeds(wardId, clearBeds: true);
  }

  Widget _legendDot(Color color, String label) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 10,
          height: 10,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: 4),
        Text(
          label,
          style: TextStyle(fontSize: 12, color: AppTheme.textSecondary),
        ),
      ],
    );
  }

  Widget _miniStat(String label, String value, Color color) {
    return SizedBox(
      width: 42,
      child: Column(
        children: [
          Text(
            value,
            style: TextStyle(
              fontWeight: FontWeight.bold,
              color: color,
              fontSize: 14,
            ),
          ),
          Text(
            label,
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 10, color: AppTheme.textSecondary),
          ),
        ],
      ),
    );
  }
}

/// Bottom sheet that opens when a bed card is tapped. Shows the bed
/// number, patient demographics, admission summary, and a notes
/// textarea. Save → PATCH /beds/:id/notes. Returns `true` from
/// `Navigator.pop` when notes were saved so the parent can refresh.
class _BedDetailSheet extends StatefulWidget {
  final Map<String, dynamic> bed;
  final String wardName;
  final StaffRole role;
  final bool embedded;
  final FutureOr<void> Function()? onChanged;
  final VoidCallback? onClose;
  const _BedDetailSheet({
    required this.bed,
    required this.wardName,
    required this.role,
    this.embedded = false,
    this.onChanged,
    this.onClose,
  });

  @override
  State<_BedDetailSheet> createState() => _BedDetailSheetState();
}

class _BedDetailSheetState extends State<_BedDetailSheet> {
  late final TextEditingController _notesCtrl;
  bool _saving = false;
  String? _saveError;

  @override
  void initState() {
    super.initState();
    _notesCtrl = TextEditingController(
      text: (widget.bed['notes'] ?? '').toString(),
    );
  }

  @override
  void dispose() {
    _notesCtrl.dispose();
    super.dispose();
  }

  String _bedId() => (widget.bed['id'] ?? widget.bed['_id'] ?? '').toString();

  String _capitalize(String s) =>
      s.isEmpty ? s : s[0].toUpperCase() + s.substring(1).toLowerCase();

  Color _statusColor(String? status) {
    switch (status?.toLowerCase()) {
      case 'available':
        return AppTheme.successGreen;
      case 'occupied':
        return AppTheme.errorRed;
      case 'maintenance':
        return const Color(0xFFF9A825);
      case 'cleaning':
        return const Color(0xFF007A64);
      default:
        return Colors.grey;
    }
  }

  Future<void> _notifyChanged() async {
    if (widget.embedded) {
      await widget.onChanged?.call();
      return;
    }
    if (mounted && Navigator.of(context).canPop()) {
      Navigator.of(context).pop(true);
    }
  }

  void _close() {
    if (widget.embedded) {
      widget.onClose?.call();
      return;
    }
    Navigator.of(context).pop(false);
  }

  Future<void> _save() async {
    final status = (widget.bed['status'] ?? '').toString().toLowerCase();
    final notesAllowed = status == 'occupied' || status == 'reserved';
    if (!notesAllowed) return;
    final id = _bedId();
    if (id.isEmpty) {
      setState(
        () => _saveError = AppStrings.of(
          context,
        ).bedSheetMissingBedIdCannotSaveNotes,
      );
      return;
    }
    setState(() {
      _saving = true;
      _saveError = null;
    });
    try {
      final response = await ApiClient.patch(
        '/beds/$id/notes',
        body: {'notes': _notesCtrl.text},
      );
      if (!mounted) return;
      if (response.isSuccess) {
        final s = AppStrings.of(context);
        if (widget.embedded) {
          await _notifyChanged();
          if (!mounted) return;
          SuccessToast.show(context, s.bedSheetNotesSaved);
        } else {
          SuccessToast.show(context, s.bedSheetNotesSaved);
          Navigator.of(context).pop(true);
        }
      } else {
        setState(() {
          _saveError = response.failureMessage(
            AppStrings.of(context).bedSheetSaveNotesFailed,
          );
        });
      }
    } catch (e) {
      if (mounted) {
        setState(
          () => _saveError = AppStrings.of(context).bedBoardServerUnreachable,
        );
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final bed = widget.bed;
    final status = (bed['status'] ?? 'available').toString();
    final bedNumber =
        bed['bedNumber'] ??
        bed['bed_number'] ??
        bed['number'] ??
        bed['name'] ??
        '';
    final bedType = (bed['bed_type'] ?? bed['bedType'] ?? '').toString();
    final color = _statusColor(status);
    final isOccupied = status.toLowerCase() == 'occupied';
    final notesAllowed = isOccupied || status.toLowerCase() == 'reserved';
    final dischargeInitiated = (bed['discharge_initiated_at'] ?? '')
        .toString()
        .isNotEmpty;
    final statusLabel = dischargeInitiated
        ? AppStrings.of(context).bedSheetDischargeInitiatedShort
        : _bedStatusDisplayLabel(AppStrings.of(context), status);

    final patientName =
        (bed['patient_full_name'] ??
                bed['patientName'] ??
                bed['patient_name'] ??
                bed['patient']?['name'] ??
                '')
            .toString();
    final patientUid = (bed['patient_uid'] ?? '').toString();
    final patientAge = bed['patient_age'];
    final patientGender = (bed['patient_gender'] ?? '').toString();
    final patientPhone = (bed['patient_phone'] ?? '').toString();
    final patientHospitalNumber =
        (bed['patient_hospital_number'] ?? bed['hospital_number'] ?? '')
            .toString()
            .trim();
    final admissionId =
        (bed['admission_id'] ?? bed['admissionId'])?.toString() ?? '';
    final chiefComplaint = (bed['chief_complaint'] ?? '').toString();
    final admittingDx = (bed['admitting_diagnosis'] ?? '').toString();
    final admissionType = (bed['admission_type'] ?? '').toString();
    final priority = (bed['admission_priority'] ?? '').toString();
    final attendingDoctor =
        (bed['attending_doctor_name'] ?? bed['doctorName'] ?? '').toString();
    final admittedAt =
        (bed['admission_admitted_at'] ?? bed['admitted_at'] ?? '').toString();
    final cleaningAssigneeText = _cleaningAssigneeText(bed);

    final viewInsets = MediaQuery.of(context).viewInsets.bottom;

    return Padding(
      padding: EdgeInsets.only(bottom: viewInsets),
      child: SafeArea(
        top: false,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              // Drag handle
              if (!widget.embedded)
                Center(
                  child: Container(
                    width: 40,
                    height: 4,
                    margin: const EdgeInsets.only(bottom: 12),
                    decoration: BoxDecoration(
                      color: Colors.grey.shade300,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),

              // Header — bed + status
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: color.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Icon(Icons.local_hotel, color: color),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          AppStrings.of(
                            context,
                          ).bedNumber(bedNumber.toString()),
                          style: const TextStyle(
                            fontSize: 20,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        Text(
                          [
                            widget.wardName,
                            if (bedType.isNotEmpty) _capitalize(bedType),
                          ].where((s) => s.isNotEmpty).join(' · '),
                          style: TextStyle(
                            fontSize: 13,
                            color: AppTheme.textSecondary,
                          ),
                        ),
                      ],
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 5,
                    ),
                    decoration: BoxDecoration(
                      color: color.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: Text(
                      statusLabel,
                      style: TextStyle(
                        color: dischargeInitiated
                            ? const Color(0xFFEF6C00)
                            : color,
                        fontWeight: FontWeight.w600,
                        fontSize: 12,
                      ),
                    ),
                  ),
                ],
              ),

              const SizedBox(height: 20),

              // Quick-action row — only meaningful when there's a patient
              // identity to pass through to the EMR / nursing screens. Pops
              // the sheet first so the user lands cleanly on the next screen
              // and the back button takes them back to the bed grid (not
              // back to a half-open sheet).
              if (isOccupied && patientUid.isNotEmpty) ...[
                _BedQuickActions(
                  admissionId: admissionId,
                  patientUid: patientUid,
                  patientId: bed['patient_id']?.toString() ?? '',
                  patientName: patientName,
                  patientGender: patientGender,
                  patientPhone: patientPhone,
                  bedNumber: bedNumber.toString(),
                  wardName: widget.wardName,
                  embedded: widget.embedded,
                ),
                const SizedBox(height: 16),
              ],

              // Bed-status actions — admit / discharge / maintenance.
              // Wires `POST /beds/:id/{admit,discharge}` and `PUT /beds/:id`
              // for status flips. Surfaces the buttons appropriate to the
              // current state so a nurse / admin can manage occupancy
              // without leaving the bed sheet.
              _BedStatusActions(
                bed: bed,
                role: widget.role,
                embedded: widget.embedded,
                onChanged: _notifyChanged,
              ),
              const SizedBox(height: 16),

              if (status.toLowerCase() == 'cleaning' &&
                  cleaningAssigneeText.isNotEmpty) ...[
                _SectionHeader(
                  label: AppStrings.of(context).bedSheetSectionHousekeeping,
                ),
                _DetailRow(
                  label: AppStrings.of(context).bedSheetFieldAssignedCleaning,
                  value: cleaningAssigneeText,
                  icon: Icons.person_pin_circle_outlined,
                  multiline: true,
                ),
                const SizedBox(height: 16),
              ],

              // Patient block (only when occupied)
              if (isOccupied && patientName.isNotEmpty) ...[
                _SectionHeader(
                  label: AppStrings.of(context).bedSheetSectionPatient,
                ),
                _DetailRow(
                  label: AppStrings.of(context).bedSheetFieldName,
                  value: patientName,
                  icon: Icons.person_outline,
                  // Tap the patient name itself to jump straight to their
                  // timeline — same destination as "Open EMR" above, but
                  // this is the gesture nurses naturally try first.
                  onTap: patientUid.isNotEmpty
                      ? () {
                          if (!widget.embedded) {
                            Navigator.of(context).pop(false);
                          }
                          context.push(
                            ipCommandBoardRoute(
                              patientUid: patientUid,
                              admissionId: admissionId,
                              patientName: patientName,
                            ),
                          );
                        }
                      : null,
                ),
                if (patientHospitalNumber.isNotEmpty)
                  _DetailRow(
                    label: AppStrings.of(context).bedSheetFieldHospitalId,
                    value: patientHospitalNumber,
                    icon: Icons.badge_outlined,
                  ),
                if (patientAge != null && patientAge.toString().isNotEmpty)
                  _DetailRow(
                    label: AppStrings.of(context).bedSheetFieldAge,
                    value:
                        '${patientAge.toString()} ${AppStrings.of(context).bedSheetYearSuffix}'
                        '${patientGender.isNotEmpty ? ' · ${_capitalize(patientGender)}' : ''}',
                    icon: Icons.cake_outlined,
                  )
                else if (patientGender.isNotEmpty)
                  _DetailRow(
                    label: AppStrings.of(context).bedSheetFieldGender,
                    value: _capitalize(patientGender),
                    icon: Icons.cake_outlined,
                  ),
                if (patientPhone.isNotEmpty)
                  _DetailRow(
                    label: AppStrings.of(context).bedSheetFieldPhone,
                    value: patientPhone,
                    icon: Icons.phone_outlined,
                  ),
                const SizedBox(height: 16),

                // Admission block
                if (chiefComplaint.isNotEmpty ||
                    admittingDx.isNotEmpty ||
                    attendingDoctor.isNotEmpty ||
                    admissionType.isNotEmpty) ...[
                  _SectionHeader(
                    label: AppStrings.of(context).bedSheetSectionAdmission,
                  ),
                  if (chiefComplaint.isNotEmpty)
                    _DetailRow(
                      label: AppStrings.of(context).bedSheetFieldChiefComplaint,
                      value: chiefComplaint,
                      icon: Icons.warning_amber_outlined,
                      multiline: true,
                    ),
                  if (admittingDx.isNotEmpty)
                    _DetailRow(
                      label: AppStrings.of(context).bedSheetFieldDiagnosis,
                      value: admittingDx,
                      icon: Icons.medical_information_outlined,
                      multiline: true,
                    ),
                  if (admissionType.isNotEmpty || priority.isNotEmpty)
                    _DetailRow(
                      label: AppStrings.of(context).bedSheetFieldType,
                      value: [
                        if (admissionType.isNotEmpty)
                          _capitalize(admissionType),
                        if (priority.isNotEmpty) _capitalize(priority),
                      ].join(' · '),
                      icon: Icons.label_outline,
                    ),
                  if (attendingDoctor.isNotEmpty)
                    _DetailRow(
                      label: AppStrings.of(context).bedSheetFieldAttending,
                      value:
                          '${AppStrings.of(context).bedSheetDoctorPrefix} $attendingDoctor',
                      icon: Icons.medical_services_outlined,
                    ),
                  if (admittedAt.isNotEmpty)
                    _DetailRow(
                      label: AppStrings.of(context).bedSheetFieldAdmitted,
                      value: admittedAt.replaceFirst('T', ' ').split('.').first,
                      icon: Icons.schedule_outlined,
                    ),
                  const SizedBox(height: 16),
                ],
              ] else ...[
                _SectionHeader(
                  label: AppStrings.of(context).bedSheetSectionPatient,
                ),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: AppTheme.backgroundGrey,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Row(
                    children: [
                      Icon(Icons.info_outline, color: AppTheme.textSecondary),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          isOccupied
                              ? AppStrings.of(
                                  context,
                                ).bedSheetPatientDetailsUnavailable
                              : AppStrings.of(
                                  context,
                                ).bedSheetNoPatientAssigned,
                          style: TextStyle(color: AppTheme.textSecondary),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 16),
              ],

              if (dischargeInitiated && isOccupied) ...[
                _DetailRow(
                  label: AppStrings.of(context).bedSheetDischarge,
                  value: AppStrings.of(context).bedSheetDischargeInitiated,
                  icon: Icons.pending_actions_outlined,
                ),
                const SizedBox(height: 16),
              ],

              // Notes block — bed notes are clinical/operational context,
              // so show them only when the bed is occupied or reserved.
              if (notesAllowed) ...[
                Row(
                  children: [
                    Expanded(
                      child: _SectionHeader(
                        label: AppStrings.of(context).bedSheetSectionNotes,
                      ),
                    ),
                    // Voice-dictation button — records via mic and appends
                    // the transcript to the notes textarea. Threads patient
                    // context through to the backend so the saved voice
                    // note links to the patient automatically.
                    VoiceDictateButton(
                      controller: _notesCtrl,
                      patientUid:
                          (widget.bed['patient_uid'] ?? '')
                              .toString()
                              .isNotEmpty
                          ? widget.bed['patient_uid'].toString()
                          : null,
                    ),
                  ],
                ),
                TextField(
                  controller: _notesCtrl,
                  minLines: 4,
                  maxLines: 8,
                  textCapitalization: TextCapitalization.sentences,
                  decoration: InputDecoration(
                    hintText: AppStrings.of(context).bedSheetNotesHint,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                    filled: true,
                    fillColor: AppTheme.backgroundGrey,
                  ),
                ),
              ],

              if (_saveError != null) ...[
                const SizedBox(height: 8),
                Text(
                  _saveError!,
                  style: const TextStyle(
                    color: AppTheme.errorRed,
                    fontSize: 12,
                  ),
                ),
              ],

              const SizedBox(height: 16),

              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: _saving ? null : _close,
                      child: Text(AppStrings.of(context).actionClose),
                    ),
                  ),
                  if (notesAllowed) ...[
                    const SizedBox(width: 12),
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: _saving ? null : _save,
                        icon: _saving
                            ? const SizedBox(
                                width: 16,
                                height: 16,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: Colors.white,
                                ),
                              )
                            : const Icon(Icons.save_outlined),
                        label: Text(
                          _saving
                              ? AppStrings.of(context).bedSheetSavingLabel
                              : AppStrings.of(context).bedSheetSaveNotes,
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  final String label;
  const _SectionHeader({required this.label});
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text(
        label.toUpperCase(),
        style: TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w700,
          color: AppTheme.textSecondary,
          letterSpacing: 0.6,
        ),
      ),
    );
  }
}

class _DetailRow extends StatelessWidget {
  final String label;
  final String value;
  final IconData icon;
  final bool multiline;
  // Optional tap handler — when set, the value text is rendered with a
  // primary-blue tint + chevron icon to telegraph it's actionable. Used
  // for the "patient name" row in the bed sheet, which jumps to the
  // patient's timeline on tap.
  final VoidCallback? onTap;
  const _DetailRow({
    required this.label,
    required this.value,
    required this.icon,
    this.multiline = false,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final valueText = Text(
      value,
      style: TextStyle(
        fontSize: 14,
        fontWeight: FontWeight.w500,
        color: onTap != null ? AppTheme.primaryBlue : null,
        decoration: onTap != null ? TextDecoration.underline : null,
        decorationColor: onTap != null
            ? AppTheme.primaryBlue.withValues(alpha: 0.5)
            : null,
      ),
    );

    final row = Row(
      crossAxisAlignment: multiline
          ? CrossAxisAlignment.start
          : CrossAxisAlignment.center,
      children: [
        Icon(icon, size: 18, color: AppTheme.textSecondary),
        const SizedBox(width: 10),
        SizedBox(
          width: 110,
          child: Text(
            label,
            style: TextStyle(fontSize: 12, color: AppTheme.textSecondary),
          ),
        ),
        Expanded(child: valueText),
        if (onTap != null)
          const Icon(
            Icons.chevron_right,
            size: 18,
            color: AppTheme.primaryBlue,
          ),
      ],
    );

    if (onTap == null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: row,
      );
    }
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: row,
      ),
    );
  }
}

/// Horizontal row of quick-action chips shown at the top of the bed
/// detail sheet for occupied beds. Each chip closes the sheet and
/// navigates to the relevant screen with the patient context
/// pre-populated via query params:
///
///   - Open EMR        → /patient-command-board?patient_uid=&admission_id=
///   - Record Vitals   → /patient-command-board?...&action=vitals
///   - Add Note        → /patient-command-board?...&action=notes
///   - Handover        → /patient-command-board?...&action=handover
///   - IP lab/pharmacy/dietary worklists carry patient context as query params
///
/// Closes the sheet first so back-navigation lands on the bed grid,
/// not on a half-rendered sheet.
class _BedQuickActions extends StatelessWidget {
  final String admissionId;
  final String patientUid;
  final String patientId; // numeric users.id — what /vitals form uses
  final String patientName;
  final String patientGender;
  final String patientPhone;
  final String bedNumber;
  final String wardName;
  final bool embedded;
  const _BedQuickActions({
    required this.admissionId,
    required this.patientUid,
    required this.patientId,
    required this.patientName,
    required this.patientGender,
    required this.patientPhone,
    required this.bedNumber,
    required this.wardName,
    this.embedded = false,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final nameQ = Uri.encodeQueryComponent(patientName);
    final phoneQ = Uri.encodeQueryComponent(patientPhone);
    final pidQ = Uri.encodeQueryComponent(patientId);

    final actions = <_QuickAction>[
      _QuickAction(
        icon: Icons.timeline,
        label: s.bedSheetActionOpenEmr,
        color: AppTheme.primaryBlue,
        route: ipCommandBoardRoute(
          patientUid: patientUid,
          admissionId: admissionId,
          patientName: patientName,
        ),
      ),
      if (admissionId.isNotEmpty)
        _QuickAction(
          icon: Icons.assignment_outlined,
          label: s.bedSheetActionCaseSheet,
          color: const Color(0xFF5D4037),
          route: ipCommandBoardRoute(
            patientUid: patientUid,
            admissionId: admissionId,
            patientName: patientName,
            action: 'case_sheet',
          ),
        ),
      _QuickAction(
        icon: Icons.monitor_heart_outlined,
        label: s.bedSheetActionRecordVitals,
        color: const Color(0xFFC62828),
        route: ipCommandBoardRoute(
          patientUid: patientUid,
          admissionId: admissionId,
          patientName: patientName,
          action: 'vitals',
        ),
      ),
      _QuickAction(
        icon: Icons.note_add_outlined,
        label: s.bedSheetActionAddNote,
        color: const Color(0xFF00695C),
        route: ipCommandBoardRoute(
          patientUid: patientUid,
          admissionId: admissionId,
          patientName: patientName,
          action: 'notes',
        ),
      ),
      if (admissionId.isNotEmpty)
        _QuickAction(
          icon: Icons.medication_liquid_outlined,
          label: s.bedSheetActionDrugChart,
          color: const Color(0xFFE65100),
          route: ipCommandBoardRoute(
            patientUid: patientUid,
            admissionId: admissionId,
            patientName: patientName,
            action: 'drug_chart',
          ),
        ),
      _QuickAction(
        icon: Icons.swap_horiz,
        label: s.bedSheetActionHandover,
        color: const Color(0xFF6A1B9A),
        route: ipCommandBoardRoute(
          patientUid: patientUid,
          admissionId: admissionId,
          patientName: patientName,
          action: 'handover',
        ),
      ),
      _QuickAction(
        icon: Icons.science_outlined,
        label: s.dashboardIpLabBookings,
        color: const Color(0xFF00838F),
        route:
            '/lab-bookings?context=ip&patient_uid=$patientUid&patient_id=$pidQ&name=$nameQ&phone=$phoneQ',
      ),
      _QuickAction(
        icon: Icons.biotech_outlined,
        label: s.dashboardIpLabResults,
        color: const Color(0xFF0097A7),
        route:
            '/investigations?context=ip&patient_uid=$patientUid&patient_id=$pidQ&name=$nameQ&phone=$phoneQ',
      ),
      _QuickAction(
        icon: Icons.medication_outlined,
        label: s.dashboardIpPharmacy,
        color: const Color(0xFFE65100),
        route:
            '/pharmacy?context=ip&patient_uid=$patientUid&patient_id=$pidQ&name=$nameQ&phone=$phoneQ',
      ),
      _QuickAction(
        icon: Icons.restaurant_menu_outlined,
        label: s.dietaryTitle,
        color: const Color(0xFF00796B),
        route:
            '/dietary?context=ip&patient_uid=$patientUid&patient_id=$pidQ&name=$nameQ&phone=$phoneQ',
      ),
      if (admissionId.isNotEmpty)
        _QuickAction(
          icon: Icons.rule_folder_outlined,
          label: s.bedSheetActionDischarge,
          color: const Color(0xFF3949AB),
          route: ipCommandBoardRoute(
            patientUid: patientUid,
            admissionId: admissionId,
            patientName: patientName,
            action: 'discharge',
          ),
        ),
    ];

    return SizedBox(
      height: 88,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: actions.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (context, i) {
          final a = actions[i];
          return SizedBox(
            width: 96,
            child: Semantics(
              button: true,
              label: s.bedSheetQuickActionForPatient(a.label, patientName),
              hint: s.bedSheetQuickActionHint(a.label),
              child: Material(
                color: a.color.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(12),
                child: InkWell(
                  borderRadius: BorderRadius.circular(12),
                  onTap: () async {
                    final route = await a.route();
                    if (!context.mounted) return;
                    if (!embedded) Navigator.of(context).pop(false);
                    unawaited(context.push(route));
                  },
                  child: Padding(
                    padding: const EdgeInsets.all(10),
                    // Icon is decorative — the Semantics wrapper above
                    // already conveys the action. Without ExcludeSemantics
                    // the icon emits its own node and screen readers
                    // double-announce.
                    child: ExcludeSemantics(
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(a.icon, color: a.color, size: 26),
                          const SizedBox(height: 6),
                          Text(
                            a.label,
                            textAlign: TextAlign.center,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.w600,
                              color: a.color,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

class _QuickAction {
  final IconData icon;
  final String label;
  final Color color;
  final String? routePath;
  final FutureOr<String> Function()? resolveRoute;
  const _QuickAction({
    required this.icon,
    required this.label,
    required this.color,
    String? route,
    this.resolveRoute,
  }) : routePath = route,
       assert(route != null || resolveRoute != null);

  FutureOr<String> route() {
    final resolver = resolveRoute;
    if (resolver != null) return resolver();
    return routePath!;
  }
}

/// Bed-status actions row inside the bed sheet. Shows the buttons
/// appropriate to the current bed status:
///
///   occupied    → [Discharge Patient]   [Mark Maintenance]
///   available   → [Admit Patient]       [Mark Maintenance]
///   maintenance → [Mark Available]
///
/// All call backend `/beds/:id/admit | /discharge | PUT status=`.
/// On success calls [onChanged] (the parent typically pops the sheet
/// with `true` so the bed grid refreshes via the `_openBedSheet`
/// `await … && _fetchBeds()` path).
class _BedStatusActions extends StatefulWidget {
  final Map<String, dynamic> bed;
  final StaffRole role;
  final bool embedded;
  final FutureOr<void> Function() onChanged;
  const _BedStatusActions({
    required this.bed,
    required this.role,
    required this.embedded,
    required this.onChanged,
  });

  @override
  State<_BedStatusActions> createState() => _BedStatusActionsState();
}

class _BedStatusActionsState extends State<_BedStatusActions> {
  bool _busy = false;

  String _bedId() => (widget.bed['id'] ?? '').toString();
  String _admissionId() =>
      (widget.bed['admission_id'] ?? widget.bed['admissionId'] ?? '')
          .toString();
  String _status() =>
      (widget.bed['status'] ?? 'available').toString().toLowerCase();

  Future<bool> _confirm(
    String title,
    String body,
    String confirmLabel, {
    Color? confirmColor,
  }) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: Text(body),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text(AppStrings.of(ctx).actionCancel),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            style: confirmColor != null
                ? FilledButton.styleFrom(backgroundColor: confirmColor)
                : null,
            child: Text(confirmLabel),
          ),
        ],
      ),
    );
    return ok == true;
  }

  Future<void> _setStatus(String newStatus) async {
    final id = _bedId();
    if (id.isEmpty) return;
    setState(() => _busy = true);
    try {
      final response = await ApiClient.put(
        '/beds/$id',
        body: {'status': newStatus},
      );
      if (!mounted) return;
      final s = AppStrings.of(context);
      if (response.isSuccess) {
        SuccessToast.show(
          context,
          s.bedSheetMarkedAs(_bedStatusDisplayLabel(s, newStatus)),
        );
        await widget.onChanged();
      } else {
        ErrorToast.show(
          context,
          response.failureMessage(s.bedSheetStatusChangeFailed),
        );
      }
    } catch (e) {
      if (mounted) {
        ErrorToast.show(
          context,
          AppStrings.of(context).bedBoardServerUnreachable,
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _markReady() async {
    final id = _bedId();
    if (id.isEmpty) return;
    final s = AppStrings.of(context);
    final ok = await _confirm(
      s.bedBoardMarkReadyTitle,
      s.bedBoardMarkReadyBody,
      s.bedBoardMarkReady,
      confirmColor: AppTheme.successGreen,
    );
    if (!ok || !mounted) return;
    setState(() => _busy = true);
    try {
      final response = await ApiClient.post(
        '/beds/$id/ready',
        body: {'notes': 'Housekeeping cleaning complete'},
      );
      if (!mounted) return;
      if (response.isSuccess) {
        SuccessToast.show(context, s.bedSheetBedMarkedAvailable);
        await widget.onChanged();
      } else {
        ErrorToast.show(
          context,
          response.failureMessage(s.bedSheetMarkReadyFailed),
        );
      }
    } catch (e) {
      if (mounted) {
        ErrorToast.show(context, s.bedBoardServerUnreachable);
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _discharge() async {
    if (!OnlineOnlyActionGuard.require(context)) return;
    final id = _bedId();
    if (id.isEmpty) return;
    final s = AppStrings.of(context);
    final patientName =
        (widget.bed['patient_full_name'] ??
                widget.bed['patient_name'] ??
                s.bedSheetThisPatient)
            .toString();
    final ok = await _confirm(
      s.dischargeConfirmTitle(patientName),
      s.dischargeConfirmBody,
      s.bedSheetDischarge,
      confirmColor: AppTheme.errorRed,
    );
    if (!ok) return;
    setState(() => _busy = true);
    try {
      final response = await ApiClient.post('/beds/$id/discharge', body: {});
      if (!mounted) return;
      if (response.isSuccess) {
        SuccessToast.show(
          context,
          AppStrings.of(context).bedSheetDischargeInitiated,
        );
        await widget.onChanged();
      } else {
        ErrorToast.show(
          context,
          response.failureMessage(s.bedSheetDischargeFailed),
        );
      }
    } catch (e) {
      if (mounted) {
        ErrorToast.show(context, s.bedBoardServerUnreachable);
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _openDischargeHub() {
    final admissionId = _admissionId();
    if (admissionId.isEmpty) return;
    final patientName =
        (widget.bed['patient_full_name'] ?? widget.bed['patient_name'] ?? '')
            .toString();
    final patientUid = (widget.bed['patient_uid'] ?? '').toString();
    final route = ipCommandBoardRoute(
      patientUid: patientUid,
      admissionId: admissionId,
      patientName: patientName,
      action: 'discharge',
    );
    if (!widget.embedded) Navigator.of(context).pop(false);
    context.push(route);
  }

  Future<void> _transfer() async {
    final admissionId = _admissionId();
    if (admissionId.isEmpty) {
      ErrorToast.show(context, AppStrings.of(context).bedSheetTransferFailed);
      return;
    }

    final picked = await showModalBottomSheet<Map<String, dynamic>>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppTheme.cardSurface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) => _TransferBedPicker(currentBedId: _bedId()),
    );
    if (picked == null || !mounted) return;

    final target = picked['bed'];
    if (target is! Map<String, dynamic>) return;
    final targetId = target['id'];
    if (targetId == null) {
      ErrorToast.show(context, AppStrings.of(context).bedSheetTargetBedMissing);
      return;
    }

    final s = AppStrings.of(context);
    final targetLabel = _targetBedLabel(target);
    final ok = await _confirm(
      s.bedSheetTransfer,
      s.bedSheetTransferConfirmBody(targetLabel),
      s.bedSheetTransfer,
      confirmColor: AppTheme.primaryBlue,
    );
    if (!ok || !mounted) return;

    setState(() => _busy = true);
    try {
      final response = await ApiClient.post(
        '/beds/transfer',
        body: {
          'admission_id': admissionId,
          'to_bed_id': targetId,
          'reason': (picked['reason'] ?? '').toString().trim().isEmpty
              ? 'Bed transfer'
              : picked['reason'].toString().trim(),
          'acknowledge_class_change':
              picked['acknowledge_class_change'] == true,
        },
      );
      if (!mounted) return;
      if (response.isSuccess) {
        SuccessToast.show(context, s.bedSheetTransferSucceeded);
        await widget.onChanged();
      } else {
        ErrorToast.show(
          context,
          response.failureMessage(s.bedSheetTransferFailed),
        );
      }
    } catch (e) {
      if (mounted) {
        ErrorToast.show(context, s.bedBoardServerUnreachable);
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _targetBedLabel(Map<String, dynamic> bed) {
    final bedNumber = (bed['bed_number'] ?? bed['bedNumber'] ?? '').toString();
    final ward = (bed['ward_name'] ?? bed['wardName'] ?? '').toString();
    final type = (bed['bed_type'] ?? bed['bedType'] ?? '').toString();
    return [
      if (ward.isNotEmpty) ward,
      if (bedNumber.isNotEmpty) AppStrings.of(context).bedNumber(bedNumber),
      if (type.isNotEmpty) type.replaceAll('_', ' '),
    ].join(' · ');
  }

  Future<void> _admit() async {
    if (!widget.embedded) Navigator.of(context).pop(false);
    if (mounted) unawaited(context.push('/emr/admissions'));
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final status = _status();
    final canMovePatients =
        widget.role == StaffRole.doctor ||
        widget.role == StaffRole.nurse ||
        widget.role.isAdminTier;
    final canClearCleaning =
        widget.role == StaffRole.housekeeping ||
        widget.role == StaffRole.housekeepingIncharge ||
        widget.role.isAdminTier;
    final dischargeInitiated = (widget.bed['discharge_initiated_at'] ?? '')
        .toString()
        .isNotEmpty;
    final actions = <Widget>[];

    if (status == 'cleaning' && canClearCleaning) {
      actions.add(
        FilledButton.icon(
          onPressed: _busy ? null : _markReady,
          icon: const Icon(Icons.cleaning_services_outlined, size: 16),
          label: Text(s.bedBoardMarkReady),
          style: FilledButton.styleFrom(
            backgroundColor: const Color(0xFF007A64),
          ),
        ),
      );
    } else if (status == 'occupied' && canMovePatients) {
      actions.add(
        FilledButton.icon(
          onPressed: _busy ? null : _transfer,
          icon: const Icon(Icons.swap_horiz, size: 16),
          label: Text(s.bedSheetTransfer),
        ),
      );
      actions.add(
        OnlineOnlyActionState(
          builder: (context, isOnline, offlineMessage) => Tooltip(
            message: isOnline ? '' : offlineMessage,
            child: OutlinedButton.icon(
              onPressed: _busy || dischargeInitiated || !isOnline
                  ? null
                  : _discharge,
              icon: Icon(
                dischargeInitiated
                    ? Icons.pending_actions_outlined
                    : Icons.logout,
                size: 16,
              ),
              label: Text(
                dischargeInitiated
                    ? s.bedSheetDischargeInitiatedShort
                    : s.bedSheetDischarge,
              ),
              style: OutlinedButton.styleFrom(
                foregroundColor: AppTheme.errorRed,
                side: BorderSide(
                  color: AppTheme.errorRed.withValues(alpha: 0.4),
                ),
              ),
            ),
          ),
        ),
      );
      if (dischargeInitiated && _admissionId().isNotEmpty) {
        actions.add(
          FilledButton.icon(
            onPressed: _busy ? null : _openDischargeHub,
            icon: const Icon(Icons.rule_folder_outlined, size: 16),
            label: Text(s.bedBoardDischargeHub),
          ),
        );
      }
    } else if (status == 'available' && canMovePatients) {
      actions.add(
        FilledButton.icon(
          onPressed: _busy ? null : _admit,
          icon: const Icon(Icons.person_add, size: 16),
          label: Text(s.bedSheetAdmitPatient),
        ),
      );
      actions.add(
        OutlinedButton.icon(
          onPressed: _busy ? null : () => _setStatus('maintenance'),
          icon: const Icon(Icons.build, size: 16),
          label: Text(s.bedBoardLegendMaintenance),
        ),
      );
    } else if (status == 'maintenance' && canMovePatients) {
      actions.add(
        FilledButton.icon(
          onPressed: _busy ? null : () => _setStatus('available'),
          icon: const Icon(Icons.check_circle_outline, size: 16),
          label: Text(s.bedSheetMarkAvailable),
        ),
      );
    }

    if (actions.isEmpty) return const SizedBox.shrink();

    return Wrap(spacing: 8, runSpacing: 8, children: actions);
  }
}

class _TransferBedPicker extends StatefulWidget {
  final String currentBedId;
  const _TransferBedPicker({required this.currentBedId});

  @override
  State<_TransferBedPicker> createState() => _TransferBedPickerState();
}

class _TransferBedPickerState extends State<_TransferBedPicker> {
  final _searchCtrl = TextEditingController();
  final _reasonCtrl = TextEditingController();
  bool _loading = true;
  bool _acknowledgeClassChange = false;
  String? _error;
  Map<String, dynamic>? _selectedBed;
  List<Map<String, dynamic>> _beds = [];

  @override
  void initState() {
    super.initState();
    _loadBeds();
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    _reasonCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadBeds() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final response = await ApiClient.get('/beds/available');
      if (!mounted) return;
      if (response.isSuccess) {
        final data = response.data;
        final list = data is List
            ? data
            : (data is Map ? data['beds'] ?? [] : []);
        _beds = List<Map<String, dynamic>>.from(
          (list as List)
              .whereType<Map<String, dynamic>>()
              .where(
                (bed) => (bed['id'] ?? '').toString() != widget.currentBedId,
              )
              .map((bed) => Map<String, dynamic>.from(bed)),
        );
        setState(() => _loading = false);
      } else {
        setState(() {
          _error = response.failureMessage(
            AppStrings.of(context).bedSheetLoadAvailableBedsFailed,
          );
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = AppStrings.of(context).bedBoardServerUnreachable;
          _loading = false;
        });
      }
    }
  }

  List<Map<String, dynamic>> get _filteredBeds {
    final q = _searchCtrl.text.trim().toLowerCase();
    if (q.isEmpty) return _beds;
    return _beds.where((bed) {
      final haystack = [
        bed['bed_number'],
        bed['bedNumber'],
        bed['ward_name'],
        bed['wardName'],
        bed['bed_type'],
        bed['bedType'],
        bed['floor'],
      ].where((v) => v != null).join(' ').toLowerCase();
      return haystack.contains(q);
    }).toList();
  }

  String _bedLabel(Map<String, dynamic> bed) {
    final bedNumber = (bed['bed_number'] ?? bed['bedNumber'] ?? '').toString();
    final ward = (bed['ward_name'] ?? bed['wardName'] ?? '').toString();
    final type = (bed['bed_type'] ?? bed['bedType'] ?? '').toString();
    return [
      if (ward.isNotEmpty) ward,
      if (bedNumber.isNotEmpty) AppStrings.of(context).bedNumber(bedNumber),
      if (type.isNotEmpty) type.replaceAll('_', ' '),
    ].join(' · ');
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final viewInsets = MediaQuery.of(context).viewInsets.bottom;
    return Padding(
      padding: EdgeInsets.only(bottom: viewInsets),
      child: SafeArea(
        top: false,
        child: SizedBox(
          height: MediaQuery.of(context).size.height * 0.78,
          child: Column(
            children: [
              Container(
                width: 40,
                height: 4,
                margin: const EdgeInsets.only(top: 8, bottom: 12),
                decoration: BoxDecoration(
                  color: Colors.grey.shade300,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      s.bedSheetTransferDestination,
                      style: const TextStyle(
                        fontWeight: FontWeight.bold,
                        fontSize: 16,
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _searchCtrl,
                      decoration: InputDecoration(
                        hintText: s.bedSheetTransferSearchHint,
                        prefixIcon: const Icon(Icons.search),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                        filled: true,
                        fillColor: AppTheme.backgroundGrey,
                      ),
                      onChanged: (_) => setState(() {}),
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      controller: _reasonCtrl,
                      minLines: 1,
                      maxLines: 2,
                      decoration: InputDecoration(
                        hintText: s.bedSheetTransferReasonHint,
                        prefixIcon: const Icon(Icons.notes_outlined),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                        filled: true,
                        fillColor: AppTheme.backgroundGrey,
                      ),
                    ),
                    CheckboxListTile(
                      value: _acknowledgeClassChange,
                      onChanged: (value) => setState(
                        () => _acknowledgeClassChange = value ?? false,
                      ),
                      dense: true,
                      controlAffinity: ListTileControlAffinity.leading,
                      contentPadding: EdgeInsets.zero,
                      title: Text(
                        s.bedSheetTransferConsent,
                        style: const TextStyle(fontSize: 13),
                      ),
                    ),
                  ],
                ),
              ),
              const Divider(height: 1),
              Expanded(child: _buildBody()),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
                child: Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: () => Navigator.of(context).pop(),
                        child: Text(s.actionCancel),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: _selectedBed == null
                            ? null
                            : () => Navigator.of(context).pop({
                                'bed': _selectedBed,
                                'reason': _reasonCtrl.text,
                                'acknowledge_class_change':
                                    _acknowledgeClassChange,
                              }),
                        icon: const Icon(Icons.swap_horiz),
                        label: Text(s.bedSheetTransferPatient),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildBody() {
    final s = AppStrings.of(context);
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            _error!,
            style: const TextStyle(color: AppTheme.errorRed),
          ),
        ),
      );
    }
    final rows = _filteredBeds;
    if (rows.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            s.bedSheetTransferEmpty,
            style: TextStyle(color: AppTheme.textSecondary),
          ),
        ),
      );
    }
    return ListView.separated(
      itemCount: rows.length,
      separatorBuilder: (_, _) => const Divider(height: 1),
      itemBuilder: (ctx, i) {
        final bed = rows[i];
        final selected =
            identical(_selectedBed, bed) ||
            (_selectedBed?['id']?.toString() == bed['id']?.toString());
        final floor = (bed['floor'] ?? '').toString();
        return ListTile(
          leading: Icon(
            selected ? Icons.check_circle : Icons.local_hotel_outlined,
            color: selected ? AppTheme.primaryBlue : AppTheme.textSecondary,
          ),
          title: Text(
            _bedLabel(bed),
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          subtitle: floor.isEmpty ? null : Text(s.bedBoardFloorLabel(floor)),
          selected: selected,
          onTap: () => setState(() => _selectedBed = bed),
        );
      },
    );
  }
}
