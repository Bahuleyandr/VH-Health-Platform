// Health Summary tab — self-contained widget with its own state and data fetching
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:intl/intl.dart';

import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class HealthSummaryTab extends StatefulWidget {
  const HealthSummaryTab({super.key});

  @override
  State<HealthSummaryTab> createState() => _HealthSummaryTabState();
}

class _HealthSummaryTabState extends State<HealthSummaryTab> {
  Map<String, dynamic>? _summary;
  List<dynamic> _allergies = [];
  List<dynamic> _conditions = [];
  bool _isLoading = true;
  String? _error;
  String? _patientId;

  @override
  void initState() {
    super.initState();
    _loadPatientId();
  }

  Future<void> _loadPatientId() async {
    const storage = FlutterSecureStorage();
    final pid = await storage.read(key: 'patient_id');
    final uid = await storage.read(key: 'firebase_uid');
    if (mounted) {
      setState(() => _patientId = pid ?? uid);
      if (_patientId != null) {
        _fetchSummaryData();
      } else {
        setState(() {
          _isLoading = false;
          _error = 'Patient ID not available';
        });
      }
    }
  }

  Future<void> _fetchSummaryData() async {
    if (_patientId == null || !mounted) return;
    setState(() {
      _isLoading = true;
      _error = null;
    });

    try {
      final results = await Future.wait([
        ApiClient.get('/health/patient/$_patientId/summary'),
        ApiClient.get('/health/patient/$_patientId/allergies'),
        ApiClient.get('/health/patient/$_patientId/conditions'),
      ]);

      if (!mounted) return;

      Map<String, dynamic>? summary;
      List<dynamic> allergies = [];
      List<dynamic> conditions = [];

      if (results[0].isSuccess) {
        summary = results[0].dataAsMap();
      }
      if (results[1].isSuccess) {
        final d = results[1].data;
        allergies = d is List ? d : (d is Map ? (d['allergies'] ?? []) : []);
      }
      if (results[2].isSuccess) {
        final d = results[2].data;
        conditions =
            d is List ? d : (d is Map ? (d['conditions'] ?? []) : []);
      }

      setState(() {
        _summary = summary;
        _allergies = allergies;
        _conditions = conditions;
        _isLoading = false;
      });
    } catch (e) {
      debugPrint('Health summary fetch failed: $e');
      if (!mounted) return;
      setState(() {
        _isLoading = false;
        _error = 'Failed to load health summary';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final l10n = AppLocalizations.of(context)!;

    if (_isLoading) {
      return Center(
        child: CircularProgressIndicator(
            valueColor: AlwaysStoppedAnimation(cs.primary)),
      );
    }

    if (_error != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.info_outline,
                size: 48, color: cs.onSurface.withAlpha(100)),
            const SizedBox(height: 12),
            Text(_error!,
                style: theme.textTheme.bodyLarge
                    ?.copyWith(color: cs.onSurfaceVariant)),
            if (_patientId != null) ...[
              const SizedBox(height: 16),
              ElevatedButton(
                onPressed: _fetchSummaryData,
                child: const Text('Retry'),
              ),
            ],
          ],
        ),
      );
    }

    final hasSummary = _summary != null;
    final hasAllergies = _allergies.isNotEmpty;
    final hasConditions = _conditions.isNotEmpty;

    if (!hasSummary && !hasAllergies && !hasConditions) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.health_and_safety_outlined,
                size: 48, color: cs.onSurface.withAlpha(100)),
            const SizedBox(height: 12),
            Text(l10n.summaryNoData,
                style: theme.textTheme.bodyLarge
                    ?.copyWith(color: cs.onSurfaceVariant)),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _fetchSummaryData,
      child: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          // Health Overview
          if (hasSummary) ...[
            _sectionHeader(
                l10n.summaryOverview, Icons.monitor_heart_outlined, cs),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (_summary!['total_records'] != null)
                      _summaryRow('Total Records',
                          _summary!['total_records'].toString(), theme),
                    if (_summary!['last_visit'] != null)
                      _summaryRow('Last Visit',
                          _formatDate(_summary!['last_visit']), theme),
                    if (_summary!['record_types'] != null)
                      ..._buildRecordTypeSummary(
                          _summary!['record_types'], theme),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
          ],

          // Allergies
          _sectionHeader(
              l10n.summaryAllergies, Icons.warning_amber_outlined, cs),
          if (!hasAllergies)
            Card(
              child: ListTile(
                leading:
                    Icon(Icons.check_circle_outline, color: cs.tertiary),
                title: Text(l10n.summaryNoAllergies),
              ),
            )
          else
            ...(_allergies.map((a) => Card(
                  child: ListTile(
                    leading: Icon(Icons.warning_amber, color: cs.error),
                    title:
                        Text(a['name'] ?? a['allergen'] ?? 'Unknown'),
                    subtitle: a['severity'] != null
                        ? Text('Severity: ${a['severity']}')
                        : null,
                  ),
                ))),
          const SizedBox(height: 16),

          // Conditions
          _sectionHeader(l10n.summaryConditions,
              Icons.local_hospital_outlined, cs),
          if (!hasConditions)
            Card(
              child: ListTile(
                leading:
                    Icon(Icons.check_circle_outline, color: cs.tertiary),
                title: Text(l10n.summaryNoConditions),
              ),
            )
          else
            ...(_conditions.map((c) => Card(
                  child: ListTile(
                    leading: Icon(Icons.local_hospital_outlined,
                        color: (c['active'] == true ||
                                c['status'] == 'active')
                            ? cs.error
                            : cs.onSurfaceVariant),
                    title: Text(
                        c['name'] ?? c['condition'] ?? 'Unknown'),
                    subtitle: c['diagnosed_date'] != null
                        ? Text(
                            'Since: ${_formatDate(c['diagnosed_date'])}')
                        : null,
                    trailing: (c['active'] == true ||
                            c['status'] == 'active')
                        ? Chip(
                            label: const Text('Active'),
                            backgroundColor: cs.errorContainer,
                            labelStyle: TextStyle(
                                color: cs.onErrorContainer,
                                fontSize: 11),
                            visualDensity: VisualDensity.compact,
                          )
                        : null,
                  ),
                ))),
        ],
      ),
    );
  }

  Widget _sectionHeader(String title, IconData icon, ColorScheme cs) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8, top: 4),
      child: Row(
        children: [
          Icon(icon, size: 20, color: cs.primary),
          const SizedBox(width: 8),
          Text(title,
              style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                  color: cs.onSurface)),
        ],
      ),
    );
  }

  Widget _summaryRow(String label, String value, ThemeData theme) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: theme.textTheme.bodyMedium),
          Text(value,
              style: theme.textTheme.bodyMedium
                  ?.copyWith(fontWeight: FontWeight.w600)),
        ],
      ),
    );
  }

  List<Widget> _buildRecordTypeSummary(dynamic types, ThemeData theme) {
    if (types is Map) {
      return types.entries
          .map((e) =>
              _summaryRow(e.key.toString(), e.value.toString(), theme))
          .toList();
    }
    return [];
  }

  String _formatDate(dynamic dateVal) {
    try {
      final d = DateTime.parse(dateVal.toString()).toLocal();
      return DateFormat.yMMMd().format(d);
    } catch (e) {
      debugPrint('Health summary date format failed: $e');
      return dateVal.toString();
    }
  }
}
