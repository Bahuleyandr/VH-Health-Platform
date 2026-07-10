import 'package:flutter/material.dart';

import '../../../l10n/app_strings.dart';

class IcuChartDepthPanel extends StatelessWidget {
  final Map<String, dynamic> chart;

  const IcuChartDepthPanel({super.key, required this.chart});

  static bool hasRenderableData(Map<String, dynamic> chart) {
    if (chart.isEmpty) return false;
    final summary = _asMap(chart['summary']);
    return _int(summary['device_vitals_count']) > 0 ||
        _int(summary['active_line_count']) > 0 ||
        _int(summary['ventilation_episode_count']) > 0 ||
        _int(summary['weaning_trial_count']) > 0 ||
        _int(summary['scoring_output_count']) > 0 ||
        _asList(chart['device_vitals']).isNotEmpty ||
        _asList(chart['line_presence']).isNotEmpty ||
        _asList(chart['ventilation_episodes']).isNotEmpty ||
        _asList(chart['scoring_outputs']).isNotEmpty;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final summary = _asMap(chart['summary']);
    final deviceVitals = _asList(chart['device_vitals']);
    final ventilation = _asList(chart['ventilation_episodes']);
    final lines = _asList(chart['line_presence']);
    final weaning = _asList(chart['weaning_trials']);
    final scores = _asList(chart['scoring_outputs']);
    final latestDevice = deviceVitals.isEmpty
        ? const <String, dynamic>{}
        : deviceVitals.last;
    final activeLines = lines.where(
      (line) => _text(line['stopped_at']).isEmpty,
    );
    final activeVent = ventilation
        .where((row) => _text(row['stopped_at']).isEmpty)
        .firstOrNull;
    final latestScore = scores.firstOrNull;

    return Container(
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest.withValues(
          alpha: 0.55,
        ),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: theme.colorScheme.outlineVariant.withValues(alpha: 0.7),
        ),
      ),
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                Icons.monitor_heart_outlined,
                size: 18,
                color: theme.colorScheme.primary,
              ),
              const SizedBox(width: 8),
              AppText(
                's4.lib.patient_command_board.icu_chart',
                style: theme.textTheme.titleSmall?.copyWith(
                  fontWeight: FontWeight.w800,
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _MetricPill(
                labelKey: 's4.lib.patient_command_board.device_vitals',
                value: _int(summary['device_vitals_count']),
                icon: Icons.sensors,
              ),
              _MetricPill(
                labelKey: 's4.lib.patient_command_board.unverified',
                value: _int(summary['unverified_device_vitals_count']),
                icon: Icons.verified_outlined,
                tone: _int(summary['unverified_device_vitals_count']) > 0
                    ? _MetricTone.warning
                    : _MetricTone.neutral,
              ),
              _MetricPill(
                labelKey: 's4.lib.patient_command_board.active_lines',
                value: _int(summary['active_line_count']),
                icon: Icons.device_thermostat,
              ),
              _MetricPill(
                labelKey: 's4.lib.patient_command_board.weaning_trials',
                value: weaning.length,
                icon: Icons.air,
              ),
            ],
          ),
          const SizedBox(height: 10),
          _DetailLine(
            labelKey: 's4.lib.patient_command_board.latest_device_vitals',
            value: latestDevice.isEmpty
                ? _valueOrFallback(
                    context,
                    's4.lib.patient_command_board.no_device_vitals',
                  )
                : _latestDeviceLine(latestDevice),
          ),
          _DetailLine(
            labelKey: 's4.lib.patient_command_board.ventilation',
            value: activeVent == null
                ? _valueOrFallback(
                    context,
                    's4.lib.patient_command_board.no_active_episode',
                  )
                : _compactJoin([
                    _text(activeVent['mode']).replaceAll('_', ' '),
                    _text(activeVent['oxygen_device']),
                    _text(activeVent['airway_type']),
                  ]),
          ),
          _DetailLine(
            labelKey: 's4.lib.patient_command_board.lines_tubes_drains',
            value: activeLines.isEmpty
                ? _valueOrFallback(
                    context,
                    's4.lib.patient_command_board.no_active_lines',
                  )
                : activeLines
                      .take(3)
                      .map(
                        (line) => _compactJoin([
                          _text(line['display_label']).isEmpty
                              ? _text(
                                  line['presence_kind'],
                                ).replaceAll('_', ' ')
                              : _text(line['display_label']),
                          _text(line['denominator_device_type']),
                        ]),
                      )
                      .join(' - '),
          ),
          _DetailLine(
            labelKey: 's4.lib.patient_command_board.latest_score',
            value: latestScore == null
                ? _valueOrFallback(
                    context,
                    's4.lib.patient_command_board.no_score_output',
                  )
                : _compactJoin([
                    _text(latestScore['scoring_kind']).toUpperCase(),
                    _text(
                      latestScore['score_value'],
                      _text(latestScore['score_label']),
                    ),
                    _text(latestScore['review_status']).replaceAll('_', ' '),
                    latestScore['order_mutation_performed'] == true
                        ? _valueOrFallback(
                            context,
                            's4.lib.patient_command_board.order_mutation_flagged',
                          )
                        : _valueOrFallback(
                            context,
                            's4.lib.patient_command_board.decision_support_only',
                          ),
                  ]),
          ),
        ],
      ),
    );
  }
}

enum _MetricTone { neutral, warning }

class _MetricPill extends StatelessWidget {
  final String labelKey;
  final int value;
  final IconData icon;
  final _MetricTone tone;

  const _MetricPill({
    required this.labelKey,
    required this.value,
    required this.icon,
    this.tone = _MetricTone.neutral,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = tone == _MetricTone.warning
        ? Colors.orange.shade700
        : theme.colorScheme.primary;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: color.withValues(alpha: 0.28)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 15, color: color),
          const SizedBox(width: 5),
          Text(
            '$value',
            style: TextStyle(color: color, fontWeight: FontWeight.w800),
          ),
          const SizedBox(width: 4),
          AppText(
            labelKey,
            style: theme.textTheme.labelMedium?.copyWith(color: color),
          ),
        ],
      ),
    );
  }
}

class _DetailLine extends StatelessWidget {
  final String labelKey;
  final String value;

  const _DetailLine({required this.labelKey, required this.value});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 118,
            child: AppText(
              labelKey,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              value,
              style: theme.textTheme.bodySmall?.copyWith(
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

Map<String, dynamic> _asMap(dynamic value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return Map<String, dynamic>.from(value);
  return const {};
}

List<Map<String, dynamic>> _asList(dynamic value) {
  if (value is! List) return const [];
  return value.map(_asMap).where((item) => item.isNotEmpty).toList();
}

String _text(dynamic value, [String fallback = '']) {
  final text = (value ?? '').toString().trim();
  return text.isEmpty ? fallback : text;
}

int _int(dynamic value) => int.tryParse('${value ?? 0}') ?? 0;

String _compactJoin(Iterable<String> values) =>
    values.where((value) => value.trim().isNotEmpty).join(' - ');

String _valueOrFallback(BuildContext context, String key) =>
    AppStrings.of(context).lookup(key);

String _latestDeviceLine(Map<String, dynamic> latestDevice) {
  return _compactJoin([
    _text(latestDevice['source_device']),
    if (_text(latestDevice['heart_rate']).isNotEmpty)
      'HR ${_text(latestDevice['heart_rate'])}',
    if (_text(latestDevice['spo2']).isNotEmpty)
      'SpO2 ${_text(latestDevice['spo2'])}',
    if (_text(latestDevice['systolic_bp']).isNotEmpty &&
        _text(latestDevice['diastolic_bp']).isNotEmpty)
      'BP ${_text(latestDevice['systolic_bp'])}/${_text(latestDevice['diastolic_bp'])}',
  ]);
}
