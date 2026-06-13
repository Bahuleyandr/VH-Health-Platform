// lib/features/maternity/screens/partograph_view_screen.dart
//
// Read-only partograph view for an active labour admission.
// Companion to partograph_entry_screen.dart — that's the form for
// recording, this is the chart.

import 'package:flutter/material.dart';
import 'package:vhhealth_staff/core/services/api_client.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';
import '../widgets/partograph_chart.dart';

class PartographViewScreen extends StatefulWidget {
  const PartographViewScreen({super.key, required this.laborAdmissionId});
  final int laborAdmissionId;

  @override
  State<PartographViewScreen> createState() => _PartographViewScreenState();
}

class _PartographViewScreenState extends State<PartographViewScreen> {
  bool _loading = true;
  String? _error;
  List<PartographPoint> _points = const [];
  DateTime? _activePhaseStart;
  Map<String, dynamic>? _admission;

  @override
  void initState() {
    super.initState();
    _fetch();
  }

  Future<void> _fetch() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      // Fetch the admission to get active phase start anchor.
      final adm = await ApiClient.get(
        '/maternity/labor-admissions/${widget.laborAdmissionId}',
      );
      if (!mounted) return;
      if (!adm.isSuccess) {
        setState(() {
          _error = adm.message ?? 'Failed to load labour admission';
          _loading = false;
        });
        return;
      }
      _admission = adm.dataAsMap();

      // Fetch partograph entries.
      final entries = await ApiClient.get(
        '/maternity/partograph/labor/${widget.laborAdmissionId}',
      );
      if (!mounted) return;
      if (entries.isSuccess) {
        final list = entries.dataAsList();
        final points = list
            .whereType<Map<String, dynamic>>()
            .map(PartographPoint.fromJson)
            .toList();
        // Active phase anchor: labor_started_at first, fallback to admitted_at.
        final startStr =
            (_admission!['labor_started_at'] ?? _admission!['admitted_at'])
                ?.toString();
        final start = startStr != null ? DateTime.tryParse(startStr) : null;
        setState(() {
          _points = points;
          _activePhaseStart = start;
          _loading = false;
        });
      } else {
        setState(() {
          _error = entries.message ?? 'Failed to load partograph';
          _loading = false;
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final actionCount = _points.where((p) => p.onActionLine == true).length;
    final alertCount = _points.where((p) => p.onAlertLine == true).length;
    final actionSuffix = actionCount == 1 ? 'y' : 'ies';
    final alertSuffix = alertCount == 1 ? 'y' : 'ies';

    return Scaffold(
      appBar: AppBar(
        title: Text(s.partographViewTitle),
        actions: [
          IconButton(icon: const Icon(Icons.refresh), onPressed: _fetch),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text(_error!, textAlign: TextAlign.center),
              ),
            )
          : ListView(
              padding: const EdgeInsets.all(12),
              children: [
                if (actionCount > 0)
                  Card(
                    color: Theme.of(context).colorScheme.errorContainer,
                    child: ListTile(
                      leading: const Icon(Icons.warning_amber),
                      title: Text(
                        // pluralisation kept in Dart; key holds the base pattern
                        s.partographViewActionLineCrossed(actionCount)
                            .replaceAll('{suffix}', actionSuffix),
                      ),
                      subtitle: Text(s.partographViewActionLineSubtitle),
                    ),
                  )
                else if (alertCount > 0)
                  Card(
                    color: Colors.amber.shade100,
                    child: ListTile(
                      leading: const Icon(Icons.info_outline),
                      title: Text(
                        s.partographViewAlertLineCrossed(alertCount)
                            .replaceAll('{suffix}', alertSuffix),
                      ),
                      subtitle: Text(s.partographViewAlertLineSubtitle),
                    ),
                  ),
                if (_activePhaseStart != null) ...[
                  PartographChart(
                    points: _points,
                    activePhaseStartedAt: _activePhaseStart!,
                  ),
                  const SizedBox(height: 8),
                  _PointTimeline(
                    points: _points,
                    activePhaseStart: _activePhaseStart!,
                  ),
                ] else
                  Padding(
                    padding: const EdgeInsets.all(16),
                    child: Text(s.partographViewNoAnchor),
                  ),
              ],
            ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () async {
          final added = await Navigator.of(
            context,
          ).pushNamed('/maternity/partograph/${widget.laborAdmissionId}');
          if (added == true) {
            _fetch();
          }
        },
        icon: const Icon(Icons.add),
        label: Text(s.partographViewNewEntry),
      ),
    );
  }
}

class _PointTimeline extends StatelessWidget {
  const _PointTimeline({required this.points, required this.activePhaseStart});
  final List<PartographPoint> points;
  final DateTime activePhaseStart;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    if (points.isEmpty) {
      return Padding(
        padding: const EdgeInsets.all(16),
        child: Text(s.partographViewNoEntries),
      );
    }
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(s.partographViewRecentEntries, style: theme.textTheme.titleSmall),
            const SizedBox(height: 8),
            ...points.reversed.take(8).map((p) {
              final hours =
                  p.recordedAt.difference(activePhaseStart).inSeconds / 3600.0;
              final colour = p.onActionLine == true
                  ? Colors.red
                  : p.onAlertLine == true
                  ? Colors.amber.shade700
                  : Colors.green;
              return Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Row(
                  children: [
                    Container(
                      width: 8,
                      height: 8,
                      decoration: BoxDecoration(
                        color: colour,
                        shape: BoxShape.circle,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        '${hours.toStringAsFixed(1)}h · '
                        '${p.cervixDilationCm?.toStringAsFixed(1) ?? "—"} cm cervix · '
                        'FHR ${p.fhrBpm ?? "—"}',
                        style: theme.textTheme.bodySmall,
                      ),
                    ),
                    Text(
                      '${p.recordedAt.hour.toString().padLeft(2, '0')}:'
                      '${p.recordedAt.minute.toString().padLeft(2, '0')}',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.outline,
                      ),
                    ),
                  ],
                ),
              );
            }),
          ],
        ),
      ),
    );
  }
}
