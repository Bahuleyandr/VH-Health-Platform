import 'package:flutter/material.dart';
import 'package:vhhealth_core/vhhealth_core.dart';

import '../../../l10n/app_strings.dart';

class ContinuityPackView extends StatelessWidget {
  final VerifiedClinicalContinuitySet set;
  final ClinicalContinuityPack pack;

  const ContinuityPackView({super.key, required this.set, required this.pack});

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final generated = formatClinicalContinuityFacilityTime(
      pack.generatedAt,
      set.facilityTimezone,
    );
    final expires = formatClinicalContinuityFacilityTime(
      pack.expiresAt,
      set.facilityTimezone,
    );
    final statusKey = pack.freshness == ClinicalContinuityFreshness.current
        ? 'continuity.status.current'
        : 'continuity.status.aged';
    final status = strings.lookup(statusKey);
    final age = _age(pack.generatedAt, set.evaluatedAt);
    final patients = (pack.content['patients'] as List).cast<Object?>();
    return FocusTraversalGroup(
      child: ListView(
        key: const Key('continuity-pack-list'),
        padding: const EdgeInsets.all(16),
        children: [
          Semantics(
            header: true,
            label: strings.lookup('continuity.read_only_banner'),
            child: Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: const Color(0xff7f1d1d),
                border: Border.all(color: Colors.white, width: 2),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                strings.lookup('continuity.read_only_banner'),
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.titleLarge?.copyWith(
                  color: Colors.white,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ),
          ),
          const SizedBox(height: 12),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _metadata(
                    context,
                    'continuity.field.facility',
                    set.facilityName,
                  ),
                  _metadata(
                    context,
                    'continuity.field.location',
                    pack.locationLabel,
                  ),
                  _metadata(context, 'continuity.field.generated', generated),
                  _metadata(context, 'continuity.field.status', status),
                  Semantics(
                    excludeSemantics: true,
                    label: strings.format('continuity.status.age_badge', {
                      'status': status,
                      'age': age,
                    }),
                    child: Chip(
                      backgroundColor:
                          pack.freshness == ClinicalContinuityFreshness.current
                          ? const Color(0xffdcfce7)
                          : const Color(0xffffe0b2),
                      side: BorderSide(
                        color:
                            pack.freshness ==
                                ClinicalContinuityFreshness.current
                            ? const Color(0xff166534)
                            : const Color(0xff7c2d12),
                      ),
                      label: Text(
                        strings.format('continuity.status.age_badge', {
                          'status': status,
                          'age': age,
                        }),
                      ),
                    ),
                  ),
                  _metadata(
                    context,
                    'continuity.field.not_valid_after',
                    expires,
                  ),
                  _metadata(
                    context,
                    'continuity.field.source',
                    '${set.provenance.sourceRevision} / '
                        '${set.provenance.sourceWatermark}',
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          ...patients.indexed.map(
            (entry) => _patientCard(
              context,
              Map<String, Object?>.from(entry.$2! as Map),
              entry.$1,
            ),
          ),
        ],
      ),
    );
  }

  Widget _patientCard(
    BuildContext context,
    Map<String, Object?> patient,
    int index,
  ) {
    final strings = AppStrings.of(context);
    final identity = _field(patient['identity']);
    final identityName = _identityName(identity?.value);
    const orderedFields = <(String, String)>[
      ('identity', 'continuity.patient.identity'),
      ('allergies', 'continuity.patient.allergies'),
      ('code_status', 'continuity.patient.code_status'),
      ('isolation', 'continuity.patient.isolation'),
      ('medications_due', 'continuity.patient.medications_due'),
      (
        'active_medication_orders',
        'continuity.patient.active_medication_orders',
      ),
      (
        'recently_administered_medications',
        'continuity.patient.recently_administered',
      ),
      ('unresolved_critical_results', 'continuity.patient.critical_results'),
      ('location', 'continuity.patient.location'),
      ('attending', 'continuity.patient.attending'),
      ('diagnosis', 'continuity.patient.diagnosis'),
      ('latest_vitals', 'continuity.patient.vitals'),
      ('news2', 'continuity.patient.news2'),
      ('recent_released_results', 'continuity.patient.recent_results'),
      ('care_team', 'continuity.patient.care_team'),
      ('latest_weight', 'continuity.patient.latest_weight'),
      ('arrival_at', 'continuity.patient.arrival'),
      ('triage', 'continuity.patient.triage'),
      ('time_in_department', 'continuity.patient.time_in_department'),
      ('appointment_time', 'continuity.patient.appointment_time'),
      ('appointment_status', 'continuity.patient.appointment_status'),
      ('phone', 'continuity.patient.phone'),
    ];
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Semantics(
              header: true,
              child: Text(
                identityName ??
                    strings.format('continuity.patient.number', {
                      'number': index + 1,
                    }),
                style: Theme.of(
                  context,
                ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold),
              ),
            ),
            const Divider(),
            ...orderedFields
                .where((entry) => patient.containsKey(entry.$1))
                .map(
                  (entry) => _clinicalField(
                    context,
                    label: strings.lookup(entry.$2),
                    fieldName: entry.$1,
                    raw: patient[entry.$1],
                  ),
                ),
          ],
        ),
      ),
    );
  }

  Widget _clinicalField(
    BuildContext context, {
    required String label,
    required String fieldName,
    required Object? raw,
  }) {
    final strings = AppStrings.of(context);
    final field = _field(raw);
    final unknown = field == null || field.state != 'known';
    final exactUnknown = switch (fieldName) {
      'allergies' => strings.lookup('continuity.unknown.allergy'),
      'code_status' => strings.lookup('continuity.unknown.code_status'),
      _ => strings.lookup('continuity.unknown.generic'),
    };
    final value = unknown ? exactUnknown : _displayValue(field.value);
    final recordedAt = field?.recordedAt;
    final recorded = recordedAt == null
        ? strings.lookup('continuity.recorded_at.unavailable')
        : strings.format('continuity.recorded_at.value', {
            'time': formatClinicalContinuityFacilityTime(
              recordedAt,
              set.facilityTimezone,
            ),
            'age': _age(recordedAt, pack.generatedAt),
          });
    final content = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: Theme.of(
            context,
          ).textTheme.labelLarge?.copyWith(fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: 2),
        SelectableText(value),
        Text(recorded, style: Theme.of(context).textTheme.bodySmall),
      ],
    );
    if (!unknown) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: content,
      );
    }
    return Semantics(
      label: value,
      liveRegion: true,
      child: Container(
        width: double.infinity,
        margin: const EdgeInsets.symmetric(vertical: 8),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: const Color(0xffffe0b2),
          border: Border.all(color: const Color(0xff7c2d12), width: 2),
          borderRadius: BorderRadius.circular(6),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const ExcludeSemantics(
              child: Icon(Icons.warning_amber, color: Color(0xff7c2d12)),
            ),
            const SizedBox(width: 8),
            Expanded(child: content),
          ],
        ),
      ),
    );
  }

  Widget _metadata(BuildContext context, String key, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Text(
        AppStrings.of(context).format('continuity.metadata', {
          'label': AppStrings.of(context).lookup(key),
          'value': value,
        }),
      ),
    );
  }
}

class _ClinicalField {
  final String state;
  final Object? value;
  final DateTime? recordedAt;

  const _ClinicalField({
    required this.state,
    required this.value,
    required this.recordedAt,
  });
}

_ClinicalField? _field(Object? raw) {
  if (raw is! Map) return null;
  final map = Map<String, Object?>.from(raw);
  final state = map['state'];
  if (state is! String) return null;
  return _ClinicalField(
    state: state,
    value: map['value'],
    recordedAt: map['recorded_at'] is String
        ? DateTime.tryParse(map['recorded_at']! as String)
        : null,
  );
}

String? _identityName(Object? raw) {
  if (raw is! Map) return null;
  final name = _field(Map<String, Object?>.from(raw)['name']);
  return name?.value?.toString();
}

String _displayValue(Object? value) {
  if (value == null) return '';
  if (value is List) {
    if (value.isEmpty) return '—';
    return value.map(_displayValue).join('\n');
  }
  if (value is Map) {
    return value.entries
        .map((entry) {
          final nested = _field(entry.value);
          final display = nested == null
              ? _displayValue(entry.value)
              : _displayValue(nested.value);
          return '${_humanize(entry.key.toString())}: $display';
        })
        .join('\n');
  }
  return value.toString();
}

String _humanize(String value) => value
    .split('_')
    .map(
      (part) => part.isEmpty
          ? part
          : '${part.substring(0, 1).toUpperCase()}${part.substring(1)}',
    )
    .join(' ');

String _age(DateTime recordedAt, DateTime generatedAt) {
  final duration = generatedAt.difference(recordedAt);
  if (duration.isNegative) return '0m';
  if (duration.inHours > 0) return '${duration.inHours}h';
  return '${duration.inMinutes}m';
}
