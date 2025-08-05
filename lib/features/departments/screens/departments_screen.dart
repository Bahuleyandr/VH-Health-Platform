import 'package:go_router/go_router.dart';

import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import 'package:vhhealth/core/services/shared_prefs_service.dart';
import 'package:vhhealth/core/services/sos_service.dart';
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
  final Set<int> _expandedIndices = {};

  late ScaffoldMessengerState _messenger;
  late ThemeData _theme;
  late AppLocalizations _loc;

  @override
  void initState() {
    super.initState();
    _fetchDepartmentsData();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _messenger = ScaffoldMessenger.of(context);
    _theme = Theme.of(context);
    _loc = AppLocalizations.of(context)!;
  }

  Future<void> _fetchDepartmentsData() async {
  if (!mounted) return;
  setState(() => _isLoading = true);

  try {
    final token = await SharedPrefsService.getToken();

    final headers = {
      'Content-Type': 'application/json',
      'x-api-key': 'vhhealth123',
      if (token != null && token.trim().isNotEmpty)
        'Authorization': 'Bearer $token',
    };

    final res = await http.get(
      Uri.parse('https://vh-health-backend.onrender.com/api/v1/departments-with-doctors'),
      headers: headers,
    );

    if (!mounted) return;

    if (res.statusCode == 200) {
      final decoded = jsonDecode(res.body);
      final list = decoded is List
          ? decoded
          : (decoded is Map && decoded['data'] is List ? decoded['data'] : null);

      if (list != null) {
        setState(() {
          departments = list;
          _isLoading = false;
        });
      } else {
        _handleError(_loc.departmentsLoadFailed);
      }
    } else {
      _handleError(_loc.departmentsLoadFailed);
    }
  } catch (_) {
    if (!mounted) return;
    _handleError(_loc.networkError);
  }
}
  void _handleError(String msg) {
    setState(() => _isLoading = false);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        _messenger.showSnackBar(SnackBar(
          content: Text(msg),
          backgroundColor: _theme.colorScheme.error,
          behavior: SnackBarBehavior.floating,
        ));
      }
    });
  }

  void _bookDoctor(String dept, String doctor) {
    context.push('/appointments', extra: {
  'department': dept,
  'doctor': doctor,
});
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

    return FeatureScreenScaffold(
      title: _loc.departmentsTitle,
      icon: Icons.local_hospital_outlined,
      color: color,
      heroTag: 'departments',
      child: _isLoading
          ? Center(
              child: CircularProgressIndicator(
                  valueColor: AlwaysStoppedAnimation(cs.primary)))
          : RefreshIndicator(
              onRefresh: _fetchDepartmentsData,
              color: cs.primary,
              backgroundColor: _theme.scaffoldBackgroundColor,
              child: departments.isEmpty
                  ? _EmptyState(loc: _loc, colorScheme: cs, theme: _theme)
                  : ListView.builder(
                      padding: const EdgeInsets.only(bottom: 16),
                      itemCount: departments.length,
                      itemBuilder: (_, i) {
                        final dept = departments[i];
                        final deptName = (dept['department'] ?? _loc.departmentsUnknown).toString();
                        final doctors = dept['doctors'] as List<dynamic>? ?? [];

                        return Card(
                          margin: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                          elevation: 2,
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                          child: ExpansionTile(
                            title: Text(deptName, style: _theme.textTheme.titleMedium),
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
                            children: doctors.map((d) {
                              final docName = (d['name'] ?? _loc.departmentsDoctor).toString();
                              final intro = (d['intro'] ?? _loc.notAvailable).toString();
                              final img = d['image_url'] as String?;

                              return ListTile(
                                leading: CircleAvatar(
                                  backgroundColor: cs.secondaryContainer,
                                  foregroundColor: cs.onSecondaryContainer,
                                  backgroundImage: (img?.isNotEmpty ?? false) ? NetworkImage(img!) : null,
                                  child: (img?.isEmpty ?? true)
                                      ? const Icon(Icons.person_outline)
                                      : null,
                                ),
                                title: Text(docName, style: _theme.textTheme.titleSmall),
                                subtitle: Text(
                                  intro,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: _theme.textTheme.bodySmall?.copyWith(color: cs.onSurfaceVariant),
                                ),
                                trailing: ElevatedButton(
                                  onPressed: () => _bookDoctor(deptName, docName),
                                  child: Text(_loc.departmentsBook),
                                ),
                              );
                            }).toList(),
                          ),
                        );
                      },
                    ),
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
