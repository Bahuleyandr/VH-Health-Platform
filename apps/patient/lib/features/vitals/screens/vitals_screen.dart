import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:intl/intl.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/services/health_sync_service.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';

class VitalsScreen extends StatefulWidget {
  final String phone;
  const VitalsScreen({super.key, required this.phone});

  @override
  State<VitalsScreen> createState() => _VitalsScreenState();
}

class _VitalsScreenState extends State<VitalsScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FeatureScreenScaffold(
      title: 'Vitals',
      icon: Icons.monitor_heart,
      color: const Color(0xFFEF9A9A),
      child: Column(
        children: [
          TabBar(
            controller: _tabController,
            labelColor: const Color(0xFFE57373),
            unselectedLabelColor: Colors.grey,
            indicatorColor: const Color(0xFFE57373),
            tabs: const [
              Tab(icon: Icon(Icons.edit_note), text: 'Log Vitals'),
              Tab(icon: Icon(Icons.history), text: 'History'),
            ],
          ),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [
                _VitalsFormTab(
                  phone: widget.phone,
                  onSubmitted: () => _tabController.animateTo(1),
                ),
                _VitalsHistoryTab(phone: widget.phone),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ── Log Vitals Tab ──────────────────────────────────────────────────────────

class _VitalsFormTab extends StatefulWidget {
  final String phone;
  final VoidCallback onSubmitted;
  const _VitalsFormTab({required this.phone, required this.onSubmitted});

  @override
  State<_VitalsFormTab> createState() => _VitalsFormTabState();
}

class _VitalsFormTabState extends State<_VitalsFormTab> {
  final _formKey = GlobalKey<FormState>();
  final _systolicCtrl = TextEditingController();
  final _diastolicCtrl = TextEditingController();
  final _heartRateCtrl = TextEditingController();
  final _temperatureCtrl = TextEditingController();
  final _bloodSugarCtrl = TextEditingController();
  final _weightCtrl = TextEditingController();
  final _spo2Ctrl = TextEditingController();
  bool _submitting = false;

  @override
  void dispose() {
    _systolicCtrl.dispose();
    _diastolicCtrl.dispose();
    _heartRateCtrl.dispose();
    _temperatureCtrl.dispose();
    _bloodSugarCtrl.dispose();
    _weightCtrl.dispose();
    _spo2Ctrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() => _submitting = true);
    try {
      final body = <String, dynamic>{};
      if (_systolicCtrl.text.isNotEmpty && _diastolicCtrl.text.isNotEmpty) {
        body['bloodPressure'] = {
          'systolic': int.parse(_systolicCtrl.text),
          'diastolic': int.parse(_diastolicCtrl.text),
        };
      }
      if (_heartRateCtrl.text.isNotEmpty) {
        body['heartRate'] = int.parse(_heartRateCtrl.text);
      }
      if (_temperatureCtrl.text.isNotEmpty) {
        body['temperature'] = double.parse(_temperatureCtrl.text);
      }
      if (_bloodSugarCtrl.text.isNotEmpty) {
        body['bloodSugar'] = int.parse(_bloodSugarCtrl.text);
      }
      if (_weightCtrl.text.isNotEmpty) {
        body['weight'] = double.parse(_weightCtrl.text);
      }
      if (_spo2Ctrl.text.isNotEmpty) {
        body['spO2'] = int.parse(_spo2Ctrl.text);
      }

      if (body.isEmpty) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Please enter at least one vital sign')),
          );
        }
        return;
      }

      final response = await ApiClient.post('/health/patient/vitals', body: body);
      if (!mounted) return;

      if (response.isSuccess) {
        // Mirror into HealthKit / Health Connect so the entry shows up alongside
        // wearable data. Fire-and-forget; backend is the source of truth.
        unawaited(HealthSyncService.instance.writeVitalsToHealthStore(
          heartRate: body['heartRate'] as int?,
          spO2: body['spO2'] as int?,
          weight: body['weight'] as double?,
          temperature: body['temperature'] as double?,
          systolic: body['bloodPressure'] is Map
              ? (body['bloodPressure'] as Map)['systolic'] as int?
              : null,
          diastolic: body['bloodPressure'] is Map
              ? (body['bloodPressure'] as Map)['diastolic'] as int?
              : null,
          bloodGlucose: body['bloodSugar'] as int?,
        ));

        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Vitals recorded successfully')),
        );
        _formKey.currentState!.reset();
        _systolicCtrl.clear();
        _diastolicCtrl.clear();
        _heartRateCtrl.clear();
        _temperatureCtrl.clear();
        _bloodSugarCtrl.clear();
        _weightCtrl.clear();
        _spo2Ctrl.clear();
        widget.onSubmitted();
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(response.message ?? 'Failed to record vitals')),
        );
      }
    } catch (e) {
      if (kDebugMode) debugPrint('VitalsFormTab: submit error: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Failed to record vitals. Please try again.')),
        );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Form(
        key: _formKey,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Log Your Daily Vitals',
              style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 4),
            Text(
              'Fill in any vitals you want to record today.',
              style: theme.textTheme.bodySmall?.copyWith(color: Colors.grey),
            ),
            const SizedBox(height: 16),

            // Blood Pressure
            Text('Blood Pressure', style: theme.textTheme.labelLarge),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: TextFormField(
                    controller: _systolicCtrl,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                      labelText: 'Systolic',
                      suffixText: 'mmHg',
                      border: OutlineInputBorder(),
                    ),
                    validator: (v) {
                      if (v != null && v.isNotEmpty) {
                        final n = int.tryParse(v);
                        if (n == null || n < 50 || n > 300) return 'Invalid';
                      }
                      return null;
                    },
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: TextFormField(
                    controller: _diastolicCtrl,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                      labelText: 'Diastolic',
                      suffixText: 'mmHg',
                      border: OutlineInputBorder(),
                    ),
                    validator: (v) {
                      if (v != null && v.isNotEmpty) {
                        final n = int.tryParse(v);
                        if (n == null || n < 20 || n > 200) return 'Invalid';
                      }
                      return null;
                    },
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),

            // Heart Rate
            TextFormField(
              controller: _heartRateCtrl,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                labelText: 'Heart Rate',
                suffixText: 'bpm',
                prefixIcon: Icon(Icons.favorite_border),
                border: OutlineInputBorder(),
              ),
              validator: (v) {
                if (v != null && v.isNotEmpty) {
                  final n = int.tryParse(v);
                  if (n == null || n < 30 || n > 250) return 'Enter 30-250 bpm';
                }
                return null;
              },
            ),
            const SizedBox(height: 16),

            // Temperature
            TextFormField(
              controller: _temperatureCtrl,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(
                labelText: 'Temperature',
                suffixText: '\u00B0F',
                prefixIcon: Icon(Icons.thermostat),
                border: OutlineInputBorder(),
              ),
              validator: (v) {
                if (v != null && v.isNotEmpty) {
                  final n = double.tryParse(v);
                  if (n == null || n < 90 || n > 110) return 'Enter 90-110 \u00B0F';
                }
                return null;
              },
            ),
            const SizedBox(height: 16),

            // Blood Sugar
            TextFormField(
              controller: _bloodSugarCtrl,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                labelText: 'Blood Sugar',
                suffixText: 'mg/dL',
                prefixIcon: Icon(Icons.water_drop_outlined),
                border: OutlineInputBorder(),
              ),
              validator: (v) {
                if (v != null && v.isNotEmpty) {
                  final n = int.tryParse(v);
                  if (n == null || n < 20 || n > 600) return 'Enter 20-600 mg/dL';
                }
                return null;
              },
            ),
            const SizedBox(height: 16),

            // Weight
            TextFormField(
              controller: _weightCtrl,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(
                labelText: 'Weight',
                suffixText: 'kg',
                prefixIcon: Icon(Icons.monitor_weight_outlined),
                border: OutlineInputBorder(),
              ),
              validator: (v) {
                if (v != null && v.isNotEmpty) {
                  final n = double.tryParse(v);
                  if (n == null || n < 1 || n > 300) return 'Enter 1-300 kg';
                }
                return null;
              },
            ),
            const SizedBox(height: 16),

            // SpO2
            TextFormField(
              controller: _spo2Ctrl,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                labelText: 'SpO2',
                suffixText: '%',
                prefixIcon: Icon(Icons.air),
                border: OutlineInputBorder(),
              ),
              validator: (v) {
                if (v != null && v.isNotEmpty) {
                  final n = int.tryParse(v);
                  if (n == null || n < 50 || n > 100) return 'Enter 50-100%';
                }
                return null;
              },
            ),
            const SizedBox(height: 24),

            // Submit
            FilledButton.icon(
              onPressed: _submitting ? null : _submit,
              icon: _submitting
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.check),
              label: Text(_submitting ? 'Submitting...' : 'Record Vitals'),
              style: FilledButton.styleFrom(
                backgroundColor: const Color(0xFFE57373),
                padding: const EdgeInsets.symmetric(vertical: 14),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ── Vitals History Tab ──────────────────────────────────────────────────────

class _VitalsHistoryTab extends StatefulWidget {
  final String phone;
  const _VitalsHistoryTab({required this.phone});

  @override
  State<_VitalsHistoryTab> createState() => _VitalsHistoryTabState();
}

class _VitalsHistoryTabState extends State<_VitalsHistoryTab> {
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _entries = [];

  @override
  void initState() {
    super.initState();
    _fetchHistory();
  }

  Future<void> _fetchHistory() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      // Resolve patient ID from secure storage (same pattern as HealthSummaryTab).
      // Falls back to firebase_uid, then phone number as last resort.
      const storage = FlutterSecureStorage();
      final patientId = await storage.read(key: 'patient_id') ??
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
          _error = response.message ?? 'Failed to load vitals history';
          _loading = false;
        });
      }
    } catch (e) {
      if (kDebugMode) debugPrint('VitalsHistoryTab: fetch error: $e');
      if (mounted) {
        setState(() {
          _error = 'Failed to load vitals history';
          _loading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.error_outline, size: 48, color: theme.colorScheme.error),
            const SizedBox(height: 12),
            Text(_error!, style: theme.textTheme.bodyMedium),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: _fetchHistory,
              icon: const Icon(Icons.refresh),
              label: const Text('Retry'),
            ),
          ],
        ),
      );
    }
    if (_entries.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.monitor_heart_outlined, size: 48, color: Colors.grey.shade400),
            const SizedBox(height: 12),
            Text('No vitals recorded yet', style: theme.textTheme.bodyMedium),
            const SizedBox(height: 8),
            Text(
              'Log your vitals using the Log Vitals tab.',
              style: theme.textTheme.bodySmall?.copyWith(color: Colors.grey),
            ),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _fetchHistory,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // Trend summary comparing latest vs previous readings
          if (_entries.length >= 2)
            _VitalsTrendSummary(latest: _entries[0], previous: _entries[1]),
          if (_entries.length >= 2) const SizedBox(height: 16),
          Text('History', style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          ...List.generate(_entries.length, (i) => Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: _VitalEntryCard(entry: _entries[i]),
          )),
        ],
      ),
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
    final trends = <_TrendItem>[];

    void addTrend(String label, String unit, String key, {bool higherIsBad = true}) {
      final cur = _toDouble(latest[key]);
      final prev = _toDouble(previous[key]);
      if (cur == null || prev == null) return;
      trends.add(_TrendItem(label, cur, prev, unit, higherIsBad));
    }

    addTrend('HR', 'bpm', 'heartRate');
    addTrend('Temp', '\u00B0F', 'temperature');
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
                const Icon(Icons.trending_up, size: 18, color: Color(0xFFE57373)),
                const SizedBox(width: 8),
                Text(
                  'Trends vs Last Reading',
                  style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.bold),
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
                final isBad = (isUp && t.higherIsBad) || (isDown && !t.higherIsBad);
                final color = diff == 0
                    ? Colors.grey
                    : isBad
                        ? Colors.red.shade400
                        : Colors.green.shade400;
                final arrow = diff == 0 ? '→' : isUp ? '↑' : '↓';

                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(t.label, style: theme.textTheme.labelSmall?.copyWith(color: Colors.grey)),
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          t.current.toStringAsFixed(t.current == t.current.roundToDouble() ? 0 : 1),
                          style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.bold),
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

class _TrendItem {
  final String label;
  final double current;
  final double previous;
  final String unit;
  final bool higherIsBad;
  _TrendItem(this.label, this.current, this.previous, this.unit, this.higherIsBad);
}

class _VitalEntryCard extends StatelessWidget {
  final Map<String, dynamic> entry;
  const _VitalEntryCard({required this.entry});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dateStr = entry['createdAt'] as String? ?? entry['date'] as String? ?? '';
    String formattedDate = dateStr;
    try {
      final dt = DateTime.parse(dateStr);
      formattedDate = DateFormat('MMM dd, yyyy - hh:mm a').format(dt);
    } catch (e) { debugPrint('Vitals date parse: $e'); }

    final bp = entry['bloodPressure'] as Map<String, dynamic>?;
    final items = <_VitalItem>[];
    if (bp != null) {
      items.add(_VitalItem('BP', '${bp['systolic']}/${bp['diastolic']}', 'mmHg'));
    }
    if (entry['heartRate'] != null) {
      items.add(_VitalItem('HR', '${entry['heartRate']}', 'bpm'));
    }
    if (entry['temperature'] != null) {
      items.add(_VitalItem('Temp', '${entry['temperature']}', '\u00B0F'));
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
                Icon(Icons.calendar_today, size: 14, color: Colors.grey.shade600),
                const SizedBox(width: 6),
                Text(
                  formattedDate,
                  style: theme.textTheme.bodySmall?.copyWith(color: Colors.grey.shade600),
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
                      style: theme.textTheme.labelSmall?.copyWith(color: Colors.grey),
                    ),
                    RichText(
                      text: TextSpan(
                        style: theme.textTheme.titleMedium?.copyWith(
                          fontWeight: FontWeight.bold,
                          color: const Color(0xFFE57373),
                        ),
                        children: [
                          TextSpan(text: item.value),
                          TextSpan(
                            text: ' ${item.unit}',
                            style: theme.textTheme.bodySmall?.copyWith(color: Colors.grey),
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
