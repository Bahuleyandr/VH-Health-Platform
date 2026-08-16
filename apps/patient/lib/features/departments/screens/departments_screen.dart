import 'dart:async';

import 'package:go_router/go_router.dart';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/utils/safe_url_launcher.dart';
import 'package:vhhealth/core/services/sos_service.dart';
import 'package:vhhealth/core/widgets/data_state_builder.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/features/departments/widgets/departments_empty_state.dart';
import 'package:vhhealth/features/departments/widgets/doctor_card.dart';
import 'package:vhhealth/features/departments/widgets/doctor_detail_sheet.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class DepartmentsScreen extends StatefulWidget {
  const DepartmentsScreen({super.key});

  @override
  State<DepartmentsScreen> createState() => _DepartmentsScreenState();
}

class _DepartmentsScreenState extends State<DepartmentsScreen> {
  List<dynamic> departments = [];
  bool _isLoading = true;
  String? _error;
  final Set<int> _expandedIndices = {};
  String _searchQuery = '';
  final TextEditingController _searchController = TextEditingController();
  Timer? _debounce;

  late ThemeData _theme;
  late AppLocalizations _loc;

  @override
  void initState() {
    super.initState();
    _fetchDepartmentsData();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _searchController.dispose();
    super.dispose();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _theme = Theme.of(context);
    _loc = AppLocalizations.of(context)!;
  }

  String _getTodayName() {
    return DateFormat('EEEE').format(DateTime.now());
  }

  bool _isDoctorAvailableToday(Map<String, dynamic> doctor) {
    final days = doctor['available_days'] as List<dynamic>?;
    if (days == null || days.isEmpty) return false;
    return days.contains(_getTodayName());
  }

  List<dynamic> get _filteredDepartments {
    if (_searchQuery.isEmpty) return departments;
    final q = _searchQuery.toLowerCase();
    return departments.where((dept) {
      final deptName = (dept['name'] ?? dept['department'] ?? '')
          .toString()
          .toLowerCase();
      if (deptName.contains(q)) return true;
      final doctors = dept['doctors'] as List<dynamic>? ?? [];
      return doctors.any((d) {
        final name = (d['name'] ?? '').toString().toLowerCase();
        final spec = (d['specialization'] ?? '').toString().toLowerCase();
        return name.contains(q) || spec.contains(q);
      });
    }).toList();
  }

  Future<void> _fetchDepartmentsData() async {
    if (!mounted) return;
    setState(() {
      _isLoading = true;
      _error = null;
    });

    try {
      final response = await ApiClient.get(
        '/departments/departments-with-doctors',
      );

      if (!mounted) return;

      if (response.isSuccess) {
        // Backend wraps in { success, data: { departments, count } }
        final data = response.data;
        List<dynamic>? list;
        if (data is Map && data['departments'] is List) {
          list = data['departments'] as List<dynamic>;
        } else if (data is List) {
          list = data;
        }

        if (list != null) {
          setState(() {
            departments = list!;
            _isLoading = false;
          });
        } else {
          setState(() {
            _error = _loc.departmentsLoadFailed;
            _isLoading = false;
          });
        }
      } else {
        setState(() {
          _error = response.failureMessage(_loc.departmentsLoadFailed);
          _isLoading = false;
        });
      }
    } catch (e) {
      debugPrint('Departments fetch failed: $e');
      if (!mounted) return;
      setState(() {
        _error = _loc.networkError;
        _isLoading = false;
      });
    }
  }

  void _bookDoctor(String dept, String doctor) {
    context.push(
      '/appointments',
      extra: {'department': dept, 'doctor': doctor},
    );
  }

  Future<void> _callNumber(String number) async {
    await SafeUrlLauncher.launchPhone(number);
  }

  void _showDoctorDetail(Map<String, dynamic> doctor, String deptName) {
    final docName = (doctor['name'] ?? _loc.departmentsDoctor).toString();
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => DoctorDetailSheet(
        doctor: doctor,
        deptName: deptName,
        isAvailableToday: _isDoctorAvailableToday(doctor),
        onBook: () {
          Navigator.of(ctx).pop();
          _bookDoctor(deptName, docName);
        },
      ),
    );
  }

  Future<void> _triggerSOS() async {
    // Sending → real outcome (success / honest failure / guest skip); the
    // pre-await success toast used to fire even when nothing was sent.
    await SOSService.triggerWithFeedback(context);
  }

  @override
  Widget build(BuildContext context) {
    final cs = _theme.colorScheme;
    final color = FeatureScreenScaffold.featureColors['departments']!;
    final filtered = _filteredDepartments;

    return FeatureScreenScaffold(
      title: _loc.departmentsTitle,
      icon: Icons.local_hospital_outlined,
      color: color,
      heroTag: 'departments',
      floatingActionButton: FloatingActionButton(
        onPressed: _triggerSOS,
        tooltip: _loc.authSosTooltip,
        backgroundColor: Colors.red,
        child: const Icon(Icons.favorite_border_outlined),
      ),
      child: DataStateBuilder<dynamic>(
        isLoading: _isLoading,
        error: _error,
        data: departments,
        onRetry: _fetchDepartmentsData,
        emptyIcon: Icons.local_hospital_outlined,
        emptyTitle: _loc.departmentsNoneFound,
        emptySubtitle: '',
        builder: (context, depts) {
          return Column(
            children: [
              // Search bar
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
                child: TextField(
                  controller: _searchController,
                  onChanged: (v) {
                    _debounce?.cancel();
                    _debounce = Timer(const Duration(milliseconds: 300), () {
                      if (mounted) setState(() => _searchQuery = v);
                    });
                  },
                  decoration: InputDecoration(
                    hintText: 'Search departments or doctors...',
                    prefixIcon: const Icon(Icons.search, size: 20),
                    suffixIcon: _searchQuery.isNotEmpty
                        ? IconButton(
                            icon: const Icon(Icons.clear, size: 18),
                            onPressed: () {
                              _searchController.clear();
                              setState(() => _searchQuery = '');
                            },
                          )
                        : null,
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(
                      vertical: 10,
                      horizontal: 12,
                    ),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: BorderSide(color: cs.outline),
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: BorderSide(color: cs.outline.withAlpha(102)),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: BorderSide(color: cs.primary, width: 1.5),
                    ),
                    filled: true,
                    fillColor: cs.surface,
                  ),
                ),
              ),
              // Department list
              Expanded(
                child: RefreshIndicator(
                  onRefresh: _fetchDepartmentsData,
                  color: cs.primary,
                  backgroundColor: _theme.scaffoldBackgroundColor,
                  child: filtered.isEmpty
                      ? DepartmentsEmptyState(
                          loc: _loc,
                          colorScheme: cs,
                          theme: _theme,
                        )
                      : ListView.builder(
                          padding: const EdgeInsets.only(bottom: 80),
                          itemCount: filtered.length,
                          itemBuilder: (_, i) {
                            final dept = filtered[i];
                            final deptName =
                                (dept['name'] ??
                                        dept['department'] ??
                                        _loc.departmentsUnknown)
                                    .toString();
                            final doctors =
                                dept['doctors'] as List<dynamic>? ?? [];
                            final location = dept['location'] as String?;
                            final contactNumber =
                                dept['contact_number'] as String?;
                            final doctorCount = doctors.length;

                            return Card(
                              margin: const EdgeInsets.symmetric(
                                horizontal: 10,
                                vertical: 5,
                              ),
                              elevation: 1,
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(12),
                              ),
                              child: ExpansionTile(
                                tilePadding: const EdgeInsets.symmetric(
                                  horizontal: 16,
                                  vertical: 4,
                                ),
                                title: Row(
                                  children: [
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          Text(
                                            deptName,
                                            style: _theme.textTheme.titleMedium
                                                ?.copyWith(
                                                  fontWeight: FontWeight.w600,
                                                ),
                                          ),
                                          if (location != null &&
                                              location.isNotEmpty)
                                            Padding(
                                              padding: const EdgeInsets.only(
                                                top: 2,
                                              ),
                                              child: Row(
                                                children: [
                                                  Icon(
                                                    Icons.location_on_outlined,
                                                    size: 13,
                                                    color: cs.onSurfaceVariant,
                                                  ),
                                                  const SizedBox(width: 3),
                                                  Text(
                                                    location,
                                                    style: _theme
                                                        .textTheme
                                                        .bodySmall
                                                        ?.copyWith(
                                                          color: cs
                                                              .onSurfaceVariant,
                                                        ),
                                                  ),
                                                ],
                                              ),
                                            ),
                                        ],
                                      ),
                                    ),
                                    // Doctor count badge
                                    Container(
                                      padding: const EdgeInsets.symmetric(
                                        horizontal: 8,
                                        vertical: 3,
                                      ),
                                      decoration: BoxDecoration(
                                        color: cs.primaryContainer,
                                        borderRadius: BorderRadius.circular(12),
                                      ),
                                      child: Text(
                                        '$doctorCount',
                                        style: _theme.textTheme.labelSmall
                                            ?.copyWith(
                                              color: cs.onPrimaryContainer,
                                              fontWeight: FontWeight.bold,
                                            ),
                                      ),
                                    ),
                                    // Call button
                                    if (contactNumber != null &&
                                        contactNumber.isNotEmpty)
                                      IconButton(
                                        icon: Icon(
                                          Icons.phone_outlined,
                                          size: 18,
                                          color: cs.primary,
                                        ),
                                        onPressed: () =>
                                            _callNumber(contactNumber),
                                        tooltip: contactNumber,
                                        constraints: const BoxConstraints(
                                          minWidth: 36,
                                          minHeight: 36,
                                        ),
                                        padding: const EdgeInsets.all(4),
                                      ),
                                  ],
                                ),
                                iconColor: cs.primary,
                                collapsedIconColor: cs.onSurfaceVariant,
                                initiallyExpanded: _expandedIndices.contains(i),
                                onExpansionChanged: (expanded) {
                                  setState(() {
                                    if (expanded) {
                                      _expandedIndices
                                        ..clear()
                                        ..add(i);
                                    } else {
                                      _expandedIndices.remove(i);
                                    }
                                  });
                                },
                                children: doctors.isEmpty
                                    ? [
                                        Padding(
                                          padding: const EdgeInsets.all(16),
                                          child: Text(
                                            AppLocalizations.of(context)!
                                                .departmentsNoDoctors,
                                            style: _theme.textTheme.bodySmall
                                                ?.copyWith(
                                                  color: cs.onSurfaceVariant,
                                                ),
                                          ),
                                        ),
                                      ]
                                    : doctors
                                          .map(
                                            (d) => DoctorCard(
                                              doctor: d as Map<String, dynamic>,
                                              deptName: deptName,
                                              theme: _theme,
                                              loc: _loc,
                                              isAvailableToday:
                                                  _isDoctorAvailableToday(d),
                                              onTap: () => _showDoctorDetail(
                                                d,
                                                deptName,
                                              ),
                                              onBook: () => _bookDoctor(
                                                deptName,
                                                (d['name'] ?? '').toString(),
                                              ),
                                            ),
                                          )
                                          .toList(),
                              ),
                            );
                          },
                        ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}
