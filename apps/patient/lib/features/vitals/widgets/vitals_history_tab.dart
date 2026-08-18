// Vitals History tab — the read half of VitalsScreen. Extracted from the
// former god-screen. The trend-summary and entry-card widgets stay private
// to this file since the history tab is their only consumer.
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:vhhealth_core/services/secure_storage.dart';
import 'package:intl/intl.dart';
import 'package:vhhealth/core/providers/dependents_provider.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/widgets/data_state_builder.dart';

class VitalsHistoryTab extends StatefulWidget {
  final String phone;
  const VitalsHistoryTab({super.key, required this.phone});

  @override
  State<VitalsHistoryTab> createState() => _VitalsHistoryTabState();
}

class _VitalsHistoryTabState extends State<VitalsHistoryTab> {
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _entries = [];
  bool _didLoad = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_didLoad) return;
    _didLoad = true;
    _fetchHistory();
  }

  Future<void> _fetchHistory() async {
    final l = AppLocalizations.of(context)!;
    // When acting as a dependent the backend rewrites req.user to it, so query
    // with the dependent's id; the guardian's stored id would 403 / be empty.
    // Read the live provider statically (context-free, null-safe) — mirrors
    // how the acting-as HTTP header resolver is registered.
    final dependentId =
        DependentsProvider.instance?.activeDependent?.id.toString();
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      // Resolve patient ID from secure storage (same pattern as HealthSummaryTab).
      // Falls back to firebase_uid, then phone number as last resort.
      final storage = VHSecureStorage.instance;
      final patientId =
          dependentId ??
          await storage.read(key: 'patient_id') ??
          await storage.read(key: 'firebase_uid') ??
          widget.phone;
      final response = await ApiClient.get('/health/patient/$patientId/vitals');
      if (!mounted) return;
      if (response.isSuccess) {
        final list = response.dataAsList();
        setState(() {
          _entries = list.cast<Map<String, dynamic>>();
          _loading = false;
        });
      } else {
        setState(() {
          _error = response.failureMessage(l.vitalsHistoryFailed);
          _loading = false;
        });
      }
    } catch (e) {
      if (kDebugMode) debugPrint('VitalsHistoryTab: fetch error: $e');
      if (mounted) {
        setState(() {
          _error = l.vitalsHistoryFailed;
          _loading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l = AppLocalizations.of(context)!;
    return DataStateBuilder<Map<String, dynamic>>(
      isLoading: _loading,
      error: _error,
      data: _entries,
      onRetry: _fetchHistory,
      emptyIcon: Icons.monitor_heart_outlined,
      emptyTitle: l.vitalsNoHistory,
      emptySubtitle: l.vitalsNoHistoryHint,
      errorTitle: l.genericError,
      errorActionLabel: l.commonRetry,
      emptyActionLabel: l.commonRefreshButton,
      builder: (context, entries) {
        return RefreshIndicator(
          onRefresh: _fetchHistory,
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              // Trend summary comparing latest vs previous readings
              if (entries.length >= 2)
                _VitalsTrendSummary(latest: entries[0], previous: entries[1]),
              if (entries.length >= 2) const SizedBox(height: 16),
              Text(
                l.vitalsHistoryHeading,
                style: theme.textTheme.titleSmall?.copyWith(
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 8),
              ...List.generate(
                entries.length,
                (i) => Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: _VitalEntryCard(entry: entries[i]),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// Shows a summary row comparing latest vs previous vital readings with
/// trend arrows (up/down/unchanged).
class _VitalsTrendSummary extends StatelessWidget {
  final Map<String, dynamic> latest;
  final Map<String, dynamic> previous;

  const _VitalsTrendSummary({required this.latest, required this.previous});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final trends = <_TrendItem>[];

    void addTrend(
      String label,
      String unit,
      String key, {
      bool higherIsBad = true,
      double Function(double)? transform,
    }) {
      var cur = _toDouble(latest[key]);
      var prev = _toDouble(previous[key]);
      if (cur == null || prev == null) return;
      if (transform != null) {
        cur = transform(cur);
        prev = transform(prev);
      }
      trends.add(_TrendItem(label, cur, prev, unit, higherIsBad));
    }

    addTrend('HR', 'bpm', 'heartRate');
    // Stored °C → °F so the value and unit label are consistent.
    addTrend('Temp', '°F', 'temperature', transform: _celsiusToFahrenheit);
    addTrend('Sugar', 'mg/dL', 'bloodSugar');
    addTrend('Weight', 'kg', 'weight', higherIsBad: false);
    addTrend('SpO2', '%', 'spO2', higherIsBad: false);

    // Blood pressure (systolic)
    final latestBp = latest['bloodPressure'] as Map<String, dynamic>?;
    final prevBp = previous['bloodPressure'] as Map<String, dynamic>?;
    if (latestBp != null && prevBp != null) {
      final cur = _toDouble(latestBp['systolic']);
      final prev = _toDouble(prevBp['systolic']);
      if (cur != null && prev != null) {
        trends.insert(0, _TrendItem('BP Sys', cur, prev, 'mmHg', true));
      }
    }

    if (trends.isEmpty) return const SizedBox.shrink();

    return Card(
      elevation: 2,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      color: theme.colorScheme.surface,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.trending_up, size: 18, color: colors.error),
                const SizedBox(width: 8),
                Text(
                  AppLocalizations.of(context)!.vitalsTrendsHeading,
                  style: theme.textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 20,
              runSpacing: 12,
              children: trends.map((t) {
                final diff = t.current - t.previous;
                final isUp = diff > 0;
                final isDown = diff < 0;
                final isBad =
                    (isUp && t.higherIsBad) || (isDown && !t.higherIsBad);
                final color = diff == 0
                    ? colors.onSurfaceVariant
                    : isBad
                    ? colors.error
                    : colors.tertiary;
                final arrow = diff == 0
                    ? '→'
                    : isUp
                    ? '↑'
                    : '↓';

                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      t.label,
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          t.current.toStringAsFixed(
                            t.current == t.current.roundToDouble() ? 0 : 1,
                          ),
                          style: theme.textTheme.titleSmall?.copyWith(
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        const SizedBox(width: 4),
                        Text(
                          '$arrow${diff.abs().toStringAsFixed(1)}',
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: color,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ],
                    ),
                  ],
                );
              }).toList(),
            ),
          ],
        ),
      ),
    );
  }

  static double? _toDouble(dynamic v) {
    if (v == null) return null;
    if (v is num) return v.toDouble();
    return double.tryParse(v.toString());
  }
}

/// Stored temperatures are canonical °C — the backend converts the °F the
/// patient enters on the log form. Convert back to °F for display so the unit
/// label matches what the patient typed. Mirrors the staff vitals-chart read
/// path.
double _celsiusToFahrenheit(double celsius) => celsius * 9 / 5 + 32;

double? _celsiusToFahrenheitOrNull(dynamic celsius) {
  final c = celsius is num ? celsius.toDouble() : double.tryParse('$celsius');
  return c == null ? null : _celsiusToFahrenheit(c);
}

class _TrendItem {
  final String label;
  final double current;
  final double previous;
  final String unit;
  final bool higherIsBad;
  _TrendItem(
    this.label,
    this.current,
    this.previous,
    this.unit,
    this.higherIsBad,
  );
}

class _VitalEntryCard extends StatelessWidget {
  final Map<String, dynamic> entry;
  const _VitalEntryCard({required this.entry});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dateStr =
        entry['createdAt'] as String? ?? entry['date'] as String? ?? '';
    String formattedDate = dateStr;
    try {
      final dt = DateTime.parse(dateStr);
      formattedDate = DateFormat('MMM dd, yyyy - hh:mm a').format(dt);
    } catch (e) {
      debugPrint('Vitals date parse: $e');
    }

    final bp = entry['bloodPressure'] as Map<String, dynamic>?;
    final items = <_VitalItem>[];
    if (bp != null) {
      items.add(
        _VitalItem('BP', '${bp['systolic']}/${bp['diastolic']}', 'mmHg'),
      );
    }
    if (entry['heartRate'] != null) {
      items.add(_VitalItem('HR', '${entry['heartRate']}', 'bpm'));
    }
    if (entry['temperature'] != null) {
      // Stored value is canonical °C; convert back to °F for display.
      final tempF = _celsiusToFahrenheitOrNull(entry['temperature']);
      if (tempF != null) {
        items.add(_VitalItem('Temp', tempF.toStringAsFixed(1), '°F'));
      }
    }
    if (entry['bloodSugar'] != null) {
      items.add(_VitalItem('Sugar', '${entry['bloodSugar']}', 'mg/dL'));
    }
    if (entry['weight'] != null) {
      items.add(_VitalItem('Weight', '${entry['weight']}', 'kg'));
    }
    if (entry['spO2'] != null) {
      items.add(_VitalItem('SpO2', '${entry['spO2']}', '%'));
    }

    return Card(
      elevation: 1,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  Icons.calendar_today,
                  size: 14,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: 6),
                Text(
                  formattedDate,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 16,
              runSpacing: 8,
              children: items.map((item) {
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      item.label,
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                    RichText(
                      text: TextSpan(
                        style: theme.textTheme.titleMedium?.copyWith(
                          fontWeight: FontWeight.bold,
                          color: theme.colorScheme.error,
                        ),
                        children: [
                          TextSpan(text: item.value),
                          TextSpan(
                            text: ' ${item.unit}',
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: theme.colorScheme.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                );
              }).toList(),
            ),
          ],
        ),
      ),
    );
  }
}

class _VitalItem {
  final String label;
  final String value;
  final String unit;
  _VitalItem(this.label, this.value, this.unit);
}
