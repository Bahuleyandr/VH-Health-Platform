import 'package:flutter/material.dart';

import '../../../l10n/app_strings.dart';

/// NL-14 P3: dense NICU/PICU rows over the ICU chart substrate.
///
/// Renders the `nicu` section of the extended ICU chart payload
/// (`GET /icu/admissions/:id/nicu-chart`): weight-adjusted feed/fluid
/// balance, apnea/brady/desat events, phototherapy, thermal care,
/// newborn-record link with APGAR, NL-5 growth reference output, and
/// owner-governed score outputs with version/reference/reviewer.
/// Device-sourced rows surface an unverified badge until clinician review.
class NicuPicuChartPanel extends StatelessWidget {
  final Map<String, dynamic> nicu;

  const NicuPicuChartPanel({super.key, required this.nicu});

  static bool hasRenderableData(Map<String, dynamic> nicu) {
    if (nicu.isEmpty) return false;
    final summary = _asMap(nicu['summary']);
    return _int(summary['feed_fluid_entry_count']) > 0 ||
        _int(summary['respiratory_support_count']) > 0 ||
        _int(summary['cardiorespiratory_event_count']) > 0 ||
        _int(summary['jaundice_phototherapy_count']) > 0 ||
        _int(summary['thermal_observation_count']) > 0 ||
        _int(summary['score_output_count']) > 0 ||
        _asMap(nicu['newborn'])['linked'] == true ||
        _asList(_asMap(nicu['feed_fluid'])['entries']).isNotEmpty;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final summary = _asMap(nicu['summary']);
    final feedFluid = _asMap(nicu['feed_fluid']);
    final balance = _asMap(feedFluid['balance']);
    final perKg = _asMap(balance['per_kg']);
    final respiratory = _asList(nicu['respiratory_support']);
    final jaundice = _asList(nicu['jaundice_phototherapy']);
    final thermal = _asList(nicu['thermal_observations']);
    final scoring = _asMap(nicu['scoring']);
    final scores = _asList(scoring['outputs']);
    final newborn = _asMap(nicu['newborn']);
    final growth = _asMap(nicu['growth']);
    final unverifiedCount = _int(summary['unverified_nicu_observation_count']);
    final latestResp = respiratory.firstOrNull;
    final latestThermal = thermal.firstOrNull;
    final latestJaundice = jaundice.firstOrNull;
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
                Icons.child_care_outlined,
                size: 18,
                color: theme.colorScheme.primary,
              ),
              const SizedBox(width: 8),
              AppText(
                's4.lib.patient_command_board.nicu_chart',
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
                labelKey: 's4.lib.patient_command_board.nicu_feeds',
                value: _int(summary['feed_fluid_entry_count']),
                icon: Icons.baby_changing_station_outlined,
              ),
              _MetricPill(
                labelKey: 's4.lib.patient_command_board.nicu_abd_events',
                value: _int(summary['cardiorespiratory_event_count']),
                icon: Icons.monitor_heart_outlined,
                tone: _int(summary['cardiorespiratory_event_count']) > 0
                    ? _MetricTone.warning
                    : _MetricTone.neutral,
              ),
              _MetricPill(
                labelKey: 's4.lib.patient_command_board.nicu_phototherapy',
                value: _int(summary['jaundice_phototherapy_count']),
                icon: Icons.light_mode_outlined,
              ),
              _MetricPill(
                labelKey: 's4.lib.patient_command_board.unverified',
                value: unverifiedCount,
                icon: Icons.verified_outlined,
                tone: unverifiedCount > 0
                    ? _MetricTone.warning
                    : _MetricTone.neutral,
              ),
            ],
          ),
          const SizedBox(height: 10),
          _DetailLine(
            labelKey: 's4.lib.patient_command_board.nicu_fluid_balance',
            value: balance.isEmpty
                ? _valueOrFallback(
                    context,
                    's4.lib.patient_command_board.nicu_not_charted',
                  )
                : _balanceLine(balance, perKg),
          ),
          _DetailLine(
            labelKey: 's4.lib.patient_command_board.nicu_respiratory',
            value: latestResp == null
                ? _valueOrFallback(
                    context,
                    's4.lib.patient_command_board.nicu_not_charted',
                  )
                : _compactJoin([
                    _text(latestResp['support_mode']).replaceAll('_', ' '),
                    if (_text(latestResp['fio2_pct']).isNotEmpty)
                      'FiO2 ${_text(latestResp['fio2_pct'])}%',
                    if (_text(latestResp['peep_cm_h2o']).isNotEmpty)
                      'PEEP ${_text(latestResp['peep_cm_h2o'])}',
                  ]),
          ),
          _DetailLine(
            labelKey: 's4.lib.patient_command_board.nicu_thermal',
            value: latestThermal == null
                ? _valueOrFallback(
                    context,
                    's4.lib.patient_command_board.nicu_not_charted',
                  )
                : _compactJoin([
                    _text(latestThermal['care_environment']).replaceAll(
                      '_',
                      ' ',
                    ),
                    if (_text(latestThermal['skin_temperature_c']).isNotEmpty)
                      'skin ${_text(latestThermal['skin_temperature_c'])}°C',
                    if (_text(latestThermal['humidity_pct']).isNotEmpty)
                      'RH ${_text(latestThermal['humidity_pct'])}%',
                  ]),
          ),
          _DetailLine(
            labelKey: 's4.lib.patient_command_board.nicu_jaundice',
            value: latestJaundice == null
                ? _valueOrFallback(
                    context,
                    's4.lib.patient_command_board.nicu_not_charted',
                  )
                : _compactJoin([
                    _text(latestJaundice['event_kind']).replaceAll('_', ' '),
                    if (_text(
                      latestJaundice['bilirubin_total_mgdl'],
                    ).isNotEmpty)
                      'TSB ${_text(latestJaundice['bilirubin_total_mgdl'])} mg/dL',
                    if (_text(latestJaundice['phototherapy_type']).isNotEmpty)
                      _text(
                        latestJaundice['phototherapy_type'],
                      ).replaceAll('_', ' '),
                  ]),
          ),
          _DetailLine(
            labelKey: 's4.lib.patient_command_board.nicu_newborn',
            value: newborn['linked'] == true
                ? _newbornLine(context, newborn)
                : _valueOrFallback(
                    context,
                    's4.lib.patient_command_board.nicu_no_newborn_link',
                  ),
          ),
          _DetailLine(
            labelKey: 's4.lib.patient_command_board.nicu_growth',
            value: growth['available'] == true
                ? _compactJoin([
                    if (_text(growth['value_kg']).isNotEmpty)
                      '${_text(growth['value_kg'])} kg',
                    if (_text(growth['percentile']).isNotEmpty)
                      'P${_text(growth['percentile'])}',
                    _text(growth['source']),
                  ])
                : _valueOrFallback(
                    context,
                    's4.lib.patient_command_board.nicu_not_charted',
                  ),
          ),
          _DetailLine(
            labelKey: 's4.lib.patient_command_board.latest_score',
            value: latestScore == null
                ? _valueOrFallback(
                    context,
                    's4.lib.patient_command_board.no_score_output',
                  )
                : latestScore['score_available'] == false
                ? _compactJoin([
                    _text(latestScore['score_kind']).toUpperCase(),
                    _valueOrFallback(
                      context,
                      's4.lib.patient_command_board.nicu_score_unavailable',
                    ),
                  ])
                : _compactJoin([
                    _text(latestScore['score_kind']).toUpperCase(),
                    _text(
                      latestScore['score_value'],
                      _text(latestScore['score_label']),
                    ),
                    _text(latestScore['reference_version']),
                    _text(latestScore['review_status']).replaceAll('_', ' '),
                    _valueOrFallback(
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

String _balanceLine(Map<String, dynamic> balance, Map<String, dynamic> perKg) {
  final intake = _asMap(balance['intake']);
  final output = _asMap(balance['output']);
  return _compactJoin([
    if (_text(intake['total_ml']).isNotEmpty)
      'in ${_text(intake['total_ml'])} mL',
    if (_text(output['total_ml']).isNotEmpty)
      'out ${_text(output['total_ml'])} mL',
    if (_text(balance['net_ml']).isNotEmpty)
      'net ${_text(balance['net_ml'])} mL',
    if (_text(perKg['net_ml_per_kg']).isNotEmpty)
      '${_text(perKg['net_ml_per_kg'])} mL/kg',
  ]);
}

String _newbornLine(BuildContext context, Map<String, dynamic> newborn) {
  final record = _asMap(newborn['record']);
  final apgars = _asList(newborn['apgar_scores']);
  final apgarText = apgars
      .map(
        (apgar) =>
            '${_text(apgar['time_minute'])}m ${_text(apgar['total_score'])}',
      )
      .join(', ');
  return _compactJoin([
    if (_text(record['gestational_age_weeks']).isNotEmpty)
      '${_text(record['gestational_age_weeks'])}w',
    if (_text(record['birth_weight_g']).isNotEmpty)
      '${_text(record['birth_weight_g'])} g',
    if (_text(record['resuscitation_type']).isNotEmpty)
      _text(record['resuscitation_type']).replaceAll('_', ' '),
    if (apgarText.isNotEmpty)
      '${_valueOrFallback(context, 's4.lib.patient_command_board.nicu_apgar')} $apgarText',
  ]);
}
