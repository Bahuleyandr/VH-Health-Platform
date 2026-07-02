import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth_core/services/mar_offline_cache.dart';

import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/states/empty_state.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';
import '../../../l10n/app_strings.dart';
import '../../../core/widgets/ward_list_filter_bar.dart';

const String _dueMedsAllWards = '';
const String _dueMedsAllRoutes = 'all';

List<WardListFilterOption> dueMedsWardFilterOptions(
  List<Map<String, dynamic>> rows,
) {
  final byValue = <String, String>{};
  for (final row in rows) {
    final value = _filterText(row['ward_id']);
    if (value.isEmpty) continue;
    byValue.putIfAbsent(value, () {
      final label = _filterText(row['ward_name']);
      return label.isEmpty ? 'Ward $value' : label;
    });
  }
  final options = byValue.entries.toList()
    ..sort((a, b) => a.value.toLowerCase().compareTo(b.value.toLowerCase()));
  return [
    const WardListFilterOption(value: _dueMedsAllWards, label: 'All wards'),
    for (final entry in options)
      WardListFilterOption(value: entry.key, label: entry.value),
  ];
}

List<WardListFilterOption> dueMedsRouteFilterOptions(
  List<Map<String, dynamic>> rows,
) {
  final routes =
      rows
          .map((row) => _filterText(row['route']))
          .where((route) => route.isNotEmpty)
          .toSet()
          .toList()
        ..sort((a, b) => a.toLowerCase().compareTo(b.toLowerCase()));
  return [
    const WardListFilterOption(value: _dueMedsAllRoutes, label: 'All routes'),
    for (final route in routes)
      WardListFilterOption(value: route, label: route),
  ];
}

List<Map<String, dynamic>> filterDueMedicationRows(
  List<Map<String, dynamic>> rows, {
  String wardValue = _dueMedsAllWards,
  String routeValue = _dueMedsAllRoutes,
  String searchQuery = '',
}) {
  final q = searchQuery.trim().toLowerCase();
  final ward = wardValue.trim();
  final route = routeValue.trim().toLowerCase();

  return rows.where((r) {
    if (ward.isNotEmpty && _filterText(r['ward_id']) != ward) return false;
    if (route.isNotEmpty &&
        route != _dueMedsAllRoutes &&
        _filterText(r['route']).toLowerCase() != route) {
      return false;
    }
    if (q.isEmpty) return true;
    final patient = _filterText(r['patient_name']).toLowerCase();
    final med =
        (_filterText(r['medication_name']).isNotEmpty
                ? _filterText(r['medication_name'])
                : _filterText(r['medication']).isNotEmpty
                ? _filterText(r['medication'])
                : _filterText(r['drug_name']))
            .toLowerCase();
    return patient.contains(q) || med.contains(q);
  }).toList();
}

String _filterText(Object? value) => (value ?? '').toString().trim();

/// Nurse-facing "due meds" list. Calls `GET /clinical/mar/due` and renders
/// one row per scheduled/held dose in a ±window around now. Tapping a row
/// pushes [MarScanScreen] with the `ma_id` — this is the entry point that
/// the MAR 5-rights scanner was missing (the scanner has always required a
/// `ma_id` in its constructor, but nothing upstream fed it one).
class DueMedsScreen extends StatefulWidget {
  const DueMedsScreen({super.key});

  @override
  State<DueMedsScreen> createState() => _DueMedsScreenState();
}

class _DueMedsScreenState extends State<DueMedsScreen> {
  List<Map<String, dynamic>> _rows = const [];
  bool _loading = true;
  String? _error;
  String _searchQuery = '';
  String _selectedWardValue = _dueMedsAllWards;
  String _selectedRouteValue = _dueMedsAllRoutes;
  List<WardListFilterOption> _wardOptions = const [
    WardListFilterOption(value: _dueMedsAllWards, label: 'All wards'),
  ];

  List<Map<String, dynamic>> get _filtered {
    return filterDueMedicationRows(
      _rows,
      wardValue: _selectedWardValue,
      routeValue: _selectedRouteValue,
      searchQuery: _searchQuery,
    );
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
      final wardId = int.tryParse(_selectedWardValue);
      final rows = await MedicalApiService.getDueMedications(wardId: wardId);
      if (!mounted) return;
      setState(() {
        _rows = rows;
        if (_selectedWardValue == _dueMedsAllWards ||
            _wardOptions.length <= 1) {
          _wardOptions = dueMedsWardFilterOptions(rows);
        }
        final routeValues = dueMedsRouteFilterOptions(
          rows,
        ).map((option) => option.value).toSet();
        if (!routeValues.contains(_selectedRouteValue)) {
          _selectedRouteValue = _dueMedsAllRoutes;
        }
      });
      // Prime the offline MAR cache: a successful fetch means we are online, so
      // snapshot each patient's due doses now. Without this the bedside flow has
      // nothing to verify against when connectivity later drops (offline MAR is
      // inert without a populated cache). Best-effort — never blocks the list.
      await _primeOfflineCache(rows);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// Group the due-meds rows by patient and cache each patient's doses so the
  /// MAR scan flow can run the 5-rights check offline (MarOfflineCache).
  Future<void> _primeOfflineCache(List<Map<String, dynamic>> rows) async {
    final byPatient = <String, List<Map<String, dynamic>>>{};
    for (final r in rows) {
      final uid = r['patient_uid'] as String?;
      if (uid == null || uid.isEmpty) continue;
      (byPatient[uid] ??= []).add(r);
    }
    for (final entry in byPatient.entries) {
      try {
        await MarOfflineCache.cacheDueDoses(entry.key, entry.value);
      } catch (_) {
        // best-effort priming; a cache-write failure must never block the UI.
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final routeOptions = dueMedsRouteFilterOptions(_rows);
    return StaffScaffold(
      title: s.dueMedsTitle,
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: TextField(
              decoration: InputDecoration(
                hintText: s.dueMedsSearchHint,
                prefixIcon: const ExcludeSemantics(child: Icon(Icons.search)),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
                filled: true,
                fillColor: AppTheme.surfaceWhite,
              ),
              onChanged: (v) => setState(() => _searchQuery = v),
            ),
          ),
          WardListFilterBar(
            keyPrefix: 'due-meds',
            wardOptions: _wardOptions,
            selectedWardValue: _selectedWardValue,
            onWardChanged: (value) {
              setState(() => _selectedWardValue = value);
              _load();
            },
            filterLabel: 'Route',
            filterOptions: routeOptions,
            selectedFilterValue: _selectedRouteValue,
            onFilterChanged: (value) =>
                setState(() => _selectedRouteValue = value),
            hasActiveFilters:
                _selectedWardValue != _dueMedsAllWards ||
                _selectedRouteValue != _dueMedsAllRoutes,
            onClear: () {
              setState(() {
                _selectedWardValue = _dueMedsAllWards;
                _selectedRouteValue = _dueMedsAllRoutes;
              });
              _load();
            },
          ),
          Expanded(
            child: RefreshIndicator(onRefresh: _load, child: _buildBody()),
          ),
        ],
      ),
    );
  }

  Widget _buildBody() {
    if (_loading && _rows.isEmpty) {
      return const SkeletonList();
    }
    if (_error != null && _rows.isEmpty) {
      return _errorView(_error!);
    }
    final rows = _filtered;
    final s = AppStrings.of(context);
    if (rows.isEmpty) {
      if (_searchQuery.trim().isNotEmpty) {
        return ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            const SizedBox(height: 120),
            Center(
              child: Text(
                s.noMatchesFor(_searchQuery),
                style: const TextStyle(color: Colors.black54),
              ),
            ),
          ],
        );
      }
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          const SizedBox(height: 80),
          EmptyState(
            icon: Icons.medication_outlined,
            title: s.dueMedsEmptyTitle,
            body: s.dueMedsEmptyBody,
          ),
        ],
      );
    }

    return ListView.separated(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.symmetric(vertical: 8),
      itemCount: rows.length,
      separatorBuilder: (_, _) => const Divider(height: 1),
      itemBuilder: (context, i) =>
          _DueMedTile(row: rows[i], onTap: () => _openScanner(rows[i])),
    );
  }

  void _openScanner(Map<String, dynamic> row) {
    final idRaw = row['id'];
    final maId = idRaw is int ? idRaw : int.tryParse(idRaw?.toString() ?? '');
    if (maId == null) return;
    context.push('/mar/scan/$maId').then((_) {
      if (mounted) _load();
    });
  }

  Widget _errorView(String msg) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        const SizedBox(height: 60),
        ErrorState(
          message: msg.replaceFirst('Exception: ', ''),
          onRetry: _load,
        ),
      ],
    );
  }
}

class _DueMedTile extends StatelessWidget {
  const _DueMedTile({required this.row, required this.onTap});

  final Map<String, dynamic> row;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheduled = _parseTime(row['scheduled_time']);
    final minutesDelta = scheduled == null
        ? null
        : DateTime.now().difference(scheduled).inMinutes;

    final overdue = minutesDelta != null && minutesDelta > 0;
    final color = overdue ? AppTheme.errorRed : AppTheme.successGreen;
    final timeLabel = scheduled == null
        ? 'unscheduled'
        : _relativeLabel(minutesDelta!);

    final patientName = (row['patient_name'] as String?)?.trim();
    final bedNumber = (row['bed_number'] as String?)?.trim();
    final wardName = (row['ward_name'] as String?)?.trim();
    final med =
        (row['medication_name'] as String?)?.trim() ?? '(unnamed medication)';
    final dose = (row['dose'] as String?) ?? (row['dosage'] as String?) ?? '';
    final route = (row['route'] as String?) ?? '';
    final status = (row['status'] as String?) ?? '';

    final subtitle = <String>[
      if (dose.isNotEmpty) dose,
      if (route.isNotEmpty) route,
      if (status == 'held') 'HELD',
    ].join(' · ');

    final whoLine = <String>[
      patientName == null || patientName.isEmpty
          ? 'Unknown patient'
          : patientName,
      if (bedNumber != null && bedNumber.isNotEmpty) 'Bed $bedNumber',
      if (wardName != null && wardName.isNotEmpty) wardName,
    ].join(' · ');

    return ListTile(
      onTap: onTap,
      leading: CircleAvatar(
        backgroundColor: color.withValues(alpha: 0.15),
        child: Icon(overdue ? Icons.schedule : Icons.medication, color: color),
      ),
      title: Text(
        med,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(fontWeight: FontWeight.w600),
      ),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (subtitle.isNotEmpty)
            Text(subtitle, style: const TextStyle(fontSize: 13)),
          Text(
            whoLine,
            style: const TextStyle(fontSize: 12, color: Colors.black54),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
      trailing: Text(
        timeLabel,
        style: TextStyle(
          color: color,
          fontWeight: FontWeight.w600,
          fontSize: 13,
        ),
      ),
    );
  }

  static DateTime? _parseTime(Object? v) {
    if (v == null) return null;
    try {
      return DateTime.parse(v.toString()).toLocal();
    } catch (_) {
      return null;
    }
  }

  static String _relativeLabel(int minutesDelta) {
    if (minutesDelta == 0) return 'now';
    final abs = minutesDelta.abs();
    final suffix = minutesDelta > 0 ? 'late' : 'in';
    final value = abs < 60
        ? '${abs}m'
        : '${(abs / 60).toStringAsFixed(abs % 60 == 0 ? 0 : 1)}h';
    return suffix == 'late' ? '$value late' : 'in $value';
  }
}
