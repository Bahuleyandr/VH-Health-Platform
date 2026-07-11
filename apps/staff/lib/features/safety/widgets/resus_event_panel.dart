import 'package:flutter/material.dart';

import '../../../l10n/app_strings.dart';

/// Localised label for a resus enum value (status / outcome / entry type /
/// role / trigger). Falls back to the raw value so unknown server enums stay
/// visible instead of blank.
String resusEnumLabel(AppStrings s, String prefix, String? value) {
  if (value == null || value.isEmpty) return '—';
  final key = 'resus.$prefix.$value';
  final label = s.lookup(key);
  return label == key ? value.replaceAll('_', ' ') : label;
}

/// Display-only panel for a durable resuscitation event: header snapshot,
/// append-only timeline, and team roles/signatures. The parent screen owns
/// all write actions; this widget renders the persisted record (source of
/// truth — never the live WS banner).
class ResusEventPanel extends StatelessWidget {
  final Map<String, dynamic> detail;

  const ResusEventPanel({super.key, required this.detail});

  Map<String, dynamic> get _event => _asMap(detail['event']);
  List<Map<String, dynamic>> get _timeline => _asListOfMaps(detail['timeline']);
  List<Map<String, dynamic>> get _roles => _asListOfMaps(detail['team_roles']);

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = AppStrings.of(context);
    final event = _event;
    final status = _text(event['status']);
    final needsLeader = _text(event['team_leader_uid']).isEmpty;
    final needsRecorder = _text(event['recorder_uid']).isEmpty;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _HeaderCard(event: event, status: status),
        if (status == 'ended' && (needsLeader || needsRecorder)) ...[
          const SizedBox(height: 10),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: theme.colorScheme.errorContainer.withValues(alpha: 0.6),
              borderRadius: BorderRadius.circular(10),
            ),
            child: AppText(
              'resus.finalize_gate_hint',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onErrorContainer,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
        const SizedBox(height: 14),
        AppText(
          'resus.timeline_title',
          style: theme.textTheme.titleSmall?.copyWith(
            fontWeight: FontWeight.w800,
          ),
        ),
        const SizedBox(height: 6),
        if (_timeline.isEmpty)
          AppText(
            'resus.timeline_empty',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.outline,
            ),
          )
        else
          ..._timeline.map((entry) => _TimelineRow(entry: entry)),
        const SizedBox(height: 14),
        AppText(
          'resus.team_title',
          style: theme.textTheme.titleSmall?.copyWith(
            fontWeight: FontWeight.w800,
          ),
        ),
        const SizedBox(height: 6),
        if (_roles.isEmpty)
          AppText(
            'resus.team_empty',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.outline,
            ),
          )
        else
          ..._roles.map(
            (role) => Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(
                children: [
                  Icon(
                    _text(role['signed_at']).isNotEmpty
                        ? Icons.verified
                        : Icons.pending_outlined,
                    size: 16,
                    color: _text(role['signed_at']).isNotEmpty
                        ? Colors.green.shade700
                        : theme.colorScheme.outline,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      '${resusEnumLabel(s, 'role', _text(role['role']))}'
                      '${_text(role['staff_name']).isNotEmpty ? ' · ${_text(role['staff_name'])}' : ''}',
                      style: theme.textTheme.bodyMedium,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  Text(
                    _text(role['signed_at']).isNotEmpty
                        ? s.lookup('resus.signed')
                        : s.lookup('resus.not_signed'),
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: _text(role['signed_at']).isNotEmpty
                          ? Colors.green.shade700
                          : theme.colorScheme.outline,
                    ),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

class _HeaderCard extends StatelessWidget {
  final Map<String, dynamic> event;
  final String status;

  const _HeaderCard({required this.event, required this.status});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = AppStrings.of(context);
    final isActive = status == 'active';

    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: isActive
            ? theme.colorScheme.errorContainer.withValues(alpha: 0.45)
            : theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.5),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: isActive
              ? theme.colorScheme.error.withValues(alpha: 0.6)
              : theme.colorScheme.outlineVariant.withValues(alpha: 0.7),
        ),
      ),
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                Icons.emergency_outlined,
                size: 20,
                color: isActive
                    ? theme.colorScheme.error
                    : theme.colorScheme.primary,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  resusEnumLabel(s, 'event_kind', _text(event['event_kind'])),
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ),
              _Chip(
                label: resusEnumLabel(s, 'status', status),
                tone: isActive ? _ChipTone.critical : _ChipTone.neutral,
              ),
              if (event['is_drill'] == true) ...[
                const SizedBox(width: 6),
                _Chip(label: s.lookup('resus.drill'), tone: _ChipTone.info),
              ],
            ],
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 16,
            runSpacing: 6,
            children: [
              _kv(theme, s.lookup('resus.ward'), _text(event['ward_snapshot'])),
              _kv(theme, s.lookup('resus.bed'), _text(event['bed_snapshot'])),
              _kv(
                theme,
                s.lookup('resus.trigger_label'),
                resusEnumLabel(s, 'trigger', _text(event['trigger_source'])),
              ),
              _kv(
                theme,
                s.lookup('resus.started'),
                _shortTime(_text(event['started_at'])),
              ),
              if (_text(event['ended_at']).isNotEmpty)
                _kv(
                  theme,
                  s.lookup('resus.ended_at'),
                  _shortTime(_text(event['ended_at'])),
                ),
              if (_text(event['outcome']).isNotEmpty)
                _kv(
                  theme,
                  s.lookup('resus.outcome'),
                  resusEnumLabel(s, 'outcome', _text(event['outcome'])),
                ),
            ],
          ),
          if (_text(event['reason']).isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              '${s.lookup('resus.reason')}: ${_text(event['reason'])}',
              style: theme.textTheme.bodyMedium?.copyWith(
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _kv(ThemeData theme, String label, String value) {
    return Text.rich(
      TextSpan(
        children: [
          TextSpan(
            text: '$label: ',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.outline,
            ),
          ),
          TextSpan(
            text: value.isEmpty ? '—' : value,
            style: theme.textTheme.bodySmall?.copyWith(
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }
}

class _TimelineRow extends StatelessWidget {
  final Map<String, dynamic> entry;

  const _TimelineRow({required this.entry});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = AppStrings.of(context);
    final extras = <String>[
      if (_text(entry['rhythm']).isNotEmpty)
        '${s.lookup('resus.rhythm')}: ${_text(entry['rhythm'])}',
      if (entry['energy_joules'] != null) '${_num(entry['energy_joules'])} J',
      if (_text(entry['medication_name']).isNotEmpty)
        [
          _text(entry['medication_name']),
          _text(entry['dose']),
          _text(entry['route']),
        ].where((p) => p.isNotEmpty).join(' · '),
    ];

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 30,
            child: Text(
              '#${entry['seq'] ?? '—'}',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.outline,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          SizedBox(
            width: 52,
            child: Text(
              _shortTime(_text(entry['occurred_at']), timeOnly: true),
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.outline,
              ),
            ),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  resusEnumLabel(s, 'entry', _text(entry['entry_type'])),
                  style: theme.textTheme.bodyMedium?.copyWith(
                    fontWeight: FontWeight.w700,
                  ),
                ),
                for (final extra in extras.where((e) => e.isNotEmpty))
                  Text(
                    extra,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

enum _ChipTone { neutral, critical, info }

class _Chip extends StatelessWidget {
  final String label;
  final _ChipTone tone;

  const _Chip({required this.label, required this.tone});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final (bg, fg) = switch (tone) {
      _ChipTone.critical => (
        theme.colorScheme.error,
        theme.colorScheme.onError,
      ),
      _ChipTone.info => (
        theme.colorScheme.tertiaryContainer,
        theme.colorScheme.onTertiaryContainer,
      ),
      _ChipTone.neutral => (
        theme.colorScheme.surfaceContainerHighest,
        theme.colorScheme.onSurfaceVariant,
      ),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: theme.textTheme.labelSmall?.copyWith(
          color: fg,
          fontWeight: FontWeight.w800,
        ),
      ),
    );
  }
}

Map<String, dynamic> _asMap(dynamic value) =>
    value is Map<String, dynamic> ? value : const <String, dynamic>{};

List<Map<String, dynamic>> _asListOfMaps(dynamic value) => value is List
    ? value.whereType<Map<String, dynamic>>().toList()
    : const <Map<String, dynamic>>[];

String _text(dynamic value) => value == null ? '' : '$value';

String _num(dynamic value) {
  final n = value is num ? value : num.tryParse('$value');
  if (n == null) return '$value';
  return n == n.roundToDouble() ? '${n.round()}' : '$n';
}

String _shortTime(String iso, {bool timeOnly = false}) {
  if (iso.isEmpty) return '—';
  final parsed = DateTime.tryParse(iso)?.toLocal();
  if (parsed == null) return iso;
  final hh = parsed.hour.toString().padLeft(2, '0');
  final mm = parsed.minute.toString().padLeft(2, '0');
  if (timeOnly) return '$hh:$mm';
  final dd = parsed.day.toString().padLeft(2, '0');
  final mo = parsed.month.toString().padLeft(2, '0');
  return '$dd/$mo $hh:$mm';
}
