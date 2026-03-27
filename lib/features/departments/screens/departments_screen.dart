import 'dart:async';

import 'package:go_router/go_router.dart';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';

import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/services/sos_service.dart';
import 'package:vhhealth/core/widgets/data_state_builder.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class DepartmentsScreen extends StatefulWidget {
  final String phone;
  final String? name;
  const DepartmentsScreen({
    super.key,
    required this.phone,
    this.name,
  });

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

  late ScaffoldMessengerState _messenger;
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
    _messenger = ScaffoldMessenger.of(context);
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
      final deptName = (dept['name'] ?? dept['department'] ?? '').toString().toLowerCase();
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
      final response = await ApiClient.get('/departments/departments-with-doctors');

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
          _error = response.message ?? _loc.departmentsLoadFailed;
          _isLoading = false;
        });
      }
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = _loc.networkError;
        _isLoading = false;
      });
    }
  }

  void _bookDoctor(String dept, String doctor) {
    context.push('/appointments', extra: {
      'department': dept,
      'doctor': doctor,
    });
  }

  Future<void> _callNumber(String number) async {
    final uri = Uri.parse('tel:${number.replaceAll(' ', '').replaceAll('-', '')}');
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri);
    }
  }

  void _showDoctorDetail(Map<String, dynamic> doctor, String deptName) {
    final cs = _theme.colorScheme;
    final qualifications = doctor['qualifications'] as List<dynamic>? ?? [];
    final availDays = doctor['available_days'] as List<dynamic>? ?? [];
    final availHours = doctor['available_hours'] as Map<String, dynamic>? ?? {};
    final fee = doctor['consultation_fee'];
    final exp = doctor['experience_years'];
    final bio = doctor['bio'] as String? ?? '';
    final education = doctor['education'] as String? ?? '';
    final docName = (doctor['name'] ?? _loc.departmentsDoctor).toString();

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => DraggableScrollableSheet(
        initialChildSize: 0.75,
        minChildSize: 0.5,
        maxChildSize: 0.95,
        builder: (_, controller) => Container(
          decoration: BoxDecoration(
            color: _theme.scaffoldBackgroundColor,
            borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
          ),
          child: ListView(
            controller: controller,
            padding: const EdgeInsets.all(20),
            children: [
              // Handle
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  margin: const EdgeInsets.only(bottom: 16),
                  decoration: BoxDecoration(
                    color: cs.onSurface.withAlpha(51),
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              // Avatar + Name
              Row(
                children: [
                  CircleAvatar(
                    radius: 36,
                    backgroundColor: cs.primaryContainer,
                    child: Icon(Icons.person, size: 36, color: cs.onPrimaryContainer),
                  ),
                  const SizedBox(width: 16),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(docName, style: _theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold)),
                        const SizedBox(height: 4),
                        Text(
                          doctor['specialization']?.toString() ?? '',
                          style: _theme.textTheme.bodyMedium?.copyWith(color: cs.primary),
                        ),
                        Text(deptName, style: _theme.textTheme.bodySmall?.copyWith(color: cs.onSurfaceVariant)),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 16),

              // Quick stats
              Row(
                children: [
                  if (exp != null) _StatChip(icon: Icons.work_outline, label: '$exp yrs', theme: _theme),
                  if (fee != null) _StatChip(icon: Icons.currency_rupee, label: '₹$fee', theme: _theme),
                  if (_isDoctorAvailableToday(doctor))
                    _StatChip(icon: Icons.check_circle, label: 'Available Today', theme: _theme, isGreen: true),
                ],
              ),
              const SizedBox(height: 16),

              // Bio
              if (bio.isNotEmpty) ...[
                Text('About', style: _theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.bold)),
                const SizedBox(height: 6),
                Text(bio, style: _theme.textTheme.bodyMedium),
                const SizedBox(height: 16),
              ],

              // Education
              if (education.isNotEmpty) ...[
                Text('Education', style: _theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.bold)),
                const SizedBox(height: 6),
                Text(education, style: _theme.textTheme.bodyMedium),
                const SizedBox(height: 16),
              ],

              // Qualifications
              if (qualifications.isNotEmpty) ...[
                Text('Qualifications', style: _theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.bold)),
                const SizedBox(height: 6),
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: qualifications.map((q) => Chip(
                    label: Text(q.toString(), style: const TextStyle(fontSize: 12)),
                    materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    visualDensity: VisualDensity.compact,
                    backgroundColor: cs.secondaryContainer,
                    labelStyle: TextStyle(color: cs.onSecondaryContainer),
                  )).toList(),
                ),
                const SizedBox(height: 16),
              ],

              // Schedule
              if (availDays.isNotEmpty) ...[
                Text('Schedule', style: _theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.bold)),
                const SizedBox(height: 6),
                ...availDays.map((day) {
                  final dayStr = day.toString();
                  final h = availHours[dayStr] as Map<String, dynamic>?;
                  final timeStr = h != null ? '${h['start']} – ${h['end']}' : '';
                  final isToday = dayStr == _getTodayName();
                  return Padding(
                    padding: const EdgeInsets.symmetric(vertical: 2),
                    child: Row(
                      children: [
                        SizedBox(
                          width: 90,
                          child: Text(
                            dayStr,
                            style: _theme.textTheme.bodySmall?.copyWith(
                              fontWeight: isToday ? FontWeight.bold : FontWeight.normal,
                              color: isToday ? cs.primary : cs.onSurface,
                            ),
                          ),
                        ),
                        Text(
                          timeStr,
                          style: _theme.textTheme.bodySmall?.copyWith(
                            color: isToday ? cs.primary : cs.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  );
                }),
                const SizedBox(height: 16),
              ],

              // Consultation fee
              if (fee != null)
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: cs.primaryContainer.withAlpha(51),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text('Consultation Fee', style: _theme.textTheme.bodyMedium),
                      Text('₹$fee', style: _theme.textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.bold,
                        color: cs.primary,
                      )),
                    ],
                  ),
                ),
              const SizedBox(height: 20),

              // Book button
              SizedBox(
                width: double.infinity,
                child: ElevatedButton.icon(
                  onPressed: () {
                    Navigator.of(ctx).pop();
                    _bookDoctor(deptName, docName);
                  },
                  icon: const Icon(Icons.calendar_today),
                  label: Text(_loc.departmentsBook),
                  style: ElevatedButton.styleFrom(
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _triggerSOS() async {
    _messenger.showSnackBar(SnackBar(
      content: Text(_loc.authSosTriggered),
      backgroundColor: _theme.colorScheme.error,
      behavior: SnackBarBehavior.floating,
    ));
    await SOSService.triggerSOS();
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
                      contentPadding: const EdgeInsets.symmetric(vertical: 10, horizontal: 12),
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
                        ? _EmptyState(loc: _loc, colorScheme: cs, theme: _theme)
                        : ListView.builder(
                            padding: const EdgeInsets.only(bottom: 80),
                            itemCount: filtered.length,
                            itemBuilder: (_, i) {
                              final dept = filtered[i];
                              final deptName = (dept['name'] ?? dept['department'] ?? _loc.departmentsUnknown).toString();
                              final doctors = dept['doctors'] as List<dynamic>? ?? [];
                              final location = dept['location'] as String?;
                              final contactNumber = dept['contact_number'] as String?;
                              final doctorCount = doctors.length;

                              return Card(
                                margin: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                                elevation: 1,
                                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                                child: ExpansionTile(
                                  tilePadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                                  title: Row(
                                    children: [
                                      Expanded(
                                        child: Column(
                                          crossAxisAlignment: CrossAxisAlignment.start,
                                          children: [
                                            Text(deptName, style: _theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
                                            if (location != null && location.isNotEmpty)
                                              Padding(
                                                padding: const EdgeInsets.only(top: 2),
                                                child: Row(
                                                  children: [
                                                    Icon(Icons.location_on_outlined, size: 13, color: cs.onSurfaceVariant),
                                                    const SizedBox(width: 3),
                                                    Text(location, style: _theme.textTheme.bodySmall?.copyWith(color: cs.onSurfaceVariant)),
                                                  ],
                                                ),
                                              ),
                                          ],
                                        ),
                                      ),
                                      // Doctor count badge
                                      Container(
                                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                                        decoration: BoxDecoration(
                                          color: cs.primaryContainer,
                                          borderRadius: BorderRadius.circular(12),
                                        ),
                                        child: Text(
                                          '$doctorCount',
                                          style: _theme.textTheme.labelSmall?.copyWith(
                                            color: cs.onPrimaryContainer,
                                            fontWeight: FontWeight.bold,
                                          ),
                                        ),
                                      ),
                                      // Call button
                                      if (contactNumber != null && contactNumber.isNotEmpty)
                                        IconButton(
                                          icon: Icon(Icons.phone_outlined, size: 18, color: cs.primary),
                                          onPressed: () => _callNumber(contactNumber),
                                          tooltip: contactNumber,
                                          constraints: const BoxConstraints(minWidth: 36, minHeight: 36),
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
                                              'No doctors available in this department',
                                              style: _theme.textTheme.bodySmall?.copyWith(color: cs.onSurfaceVariant),
                                            ),
                                          ),
                                        ]
                                      : doctors.map((d) => _DoctorCard(
                                          doctor: d as Map<String, dynamic>,
                                          deptName: deptName,
                                          theme: _theme,
                                          loc: _loc,
                                          isAvailableToday: _isDoctorAvailableToday(d as Map<String, dynamic>),
                                          onTap: () => _showDoctorDetail(d as Map<String, dynamic>, deptName),
                                          onBook: () => _bookDoctor(deptName, (d['name'] ?? '').toString()),
                                        )).toList(),
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
      floatingActionButton: FloatingActionButton(
        onPressed: _triggerSOS,
        tooltip: _loc.authSosTooltip,
        backgroundColor: Colors.red,
        child: const Icon(Icons.favorite_border_outlined),
      ),
    );
  }
}

class _DoctorCard extends StatelessWidget {
  final Map<String, dynamic> doctor;
  final String deptName;
  final ThemeData theme;
  final AppLocalizations loc;
  final bool isAvailableToday;
  final VoidCallback onTap;
  final VoidCallback onBook;

  const _DoctorCard({
    required this.doctor,
    required this.deptName,
    required this.theme,
    required this.loc,
    required this.isAvailableToday,
    required this.onTap,
    required this.onBook,
  });

  @override
  Widget build(BuildContext context) {
    final cs = theme.colorScheme;
    final docName = (doctor['name'] ?? loc.departmentsDoctor).toString();
    final specialization = (doctor['specialization'] ?? '').toString();
    final exp = doctor['experience_years'];
    final fee = doctor['consultation_fee'];
    final qualifications = doctor['qualifications'] as List<dynamic>? ?? [];

    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Avatar
            CircleAvatar(
              radius: 24,
              backgroundColor: cs.secondaryContainer,
              foregroundColor: cs.onSecondaryContainer,
              child: const Icon(Icons.person_outline, size: 24),
            ),
            const SizedBox(width: 12),
            // Info
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Name + availability badge
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          docName,
                          style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      if (isAvailableToday) ...[
                        const SizedBox(width: 6),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                          decoration: BoxDecoration(
                            color: Colors.green.withAlpha(25),
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(color: Colors.green.withAlpha(100)),
                          ),
                          child: const Text(
                            'Available',
                            style: TextStyle(fontSize: 10, color: Colors.green, fontWeight: FontWeight.w600),
                          ),
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 2),
                  // Specialization
                  if (specialization.isNotEmpty)
                    Text(
                      specialization,
                      style: theme.textTheme.bodySmall?.copyWith(color: cs.primary),
                    ),
                  const SizedBox(height: 4),
                  // Experience + fee
                  Row(
                    children: [
                      if (exp != null) ...[
                        Icon(Icons.work_outline, size: 12, color: cs.onSurfaceVariant),
                        const SizedBox(width: 3),
                        Text('$exp yrs', style: theme.textTheme.bodySmall?.copyWith(color: cs.onSurfaceVariant, fontSize: 11)),
                        const SizedBox(width: 12),
                      ],
                      if (fee != null) ...[
                        Icon(Icons.currency_rupee, size: 12, color: cs.onSurfaceVariant),
                        const SizedBox(width: 2),
                        Text('₹$fee', style: theme.textTheme.bodySmall?.copyWith(color: cs.onSurfaceVariant, fontSize: 11, fontWeight: FontWeight.w600)),
                      ],
                    ],
                  ),
                  // Qualification chips
                  if (qualifications.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Wrap(
                        spacing: 4,
                        runSpacing: 4,
                        children: qualifications.take(4).map((q) => Container(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                          decoration: BoxDecoration(
                            color: cs.surfaceContainerHighest,
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Text(
                            q.toString(),
                            style: TextStyle(fontSize: 10, color: cs.onSurfaceVariant),
                          ),
                        )).toList(),
                      ),
                    ),
                ],
              ),
            ),
            // Book button
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: SizedBox(
                height: 32,
                child: ElevatedButton(
                  onPressed: onBook,
                  style: ElevatedButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    textStyle: const TextStyle(fontSize: 12),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                  ),
                  child: Text(loc.departmentsBook),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _StatChip extends StatelessWidget {
  final IconData icon;
  final String label;
  final ThemeData theme;
  final bool isGreen;

  const _StatChip({
    required this.icon,
    required this.label,
    required this.theme,
    this.isGreen = false,
  });

  @override
  Widget build(BuildContext context) {
    final color = isGreen ? Colors.green : theme.colorScheme.primary;
    return Container(
      margin: const EdgeInsets.only(right: 8),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: color.withAlpha(20),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14, color: color),
          const SizedBox(width: 4),
          Text(label, style: TextStyle(fontSize: 12, color: color, fontWeight: FontWeight.w600)),
        ],
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  final AppLocalizations loc;
  final ColorScheme colorScheme;
  final ThemeData theme;

  const _EmptyState({
    required this.loc,
    required this.colorScheme,
    required this.theme,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.list_alt_outlined, size: 60, color: colorScheme.onSurface.withAlpha(127)),
            const SizedBox(height: 16),
            Text(
              loc.departmentsNoneFound,
              textAlign: TextAlign.center,
              style: theme.textTheme.titleMedium?.copyWith(color: colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
    );
  }
}
