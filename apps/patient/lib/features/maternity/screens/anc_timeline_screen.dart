// lib/features/maternity/screens/anc_timeline_screen.dart
//
// Patient ANC timeline — gestational age, visits to date, supplements,
// and the next scheduled visit so a primigravida like Mrs. Lakshmi
// Devi can plan against her husband's leave instead of relying on a
// generic appointments list.
//
// Backend: GET /api/v1/portal/maternity/timeline
// (maternityService.getAncTimelineForPatient). Returns null when the
// patient has no active pregnancy.

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';

class AncTimelineScreen extends StatefulWidget {
  const AncTimelineScreen({super.key});

  @override
  State<AncTimelineScreen> createState() => _AncTimelineScreenState();
}

class _AncTimelineScreenState extends State<AncTimelineScreen> {
  bool _loading = true;
  String? _error;
  Map<String, dynamic>? _timeline;

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
      final response = await ApiClient.get('/portal/maternity/timeline');
      if (!mounted) return;
      if (response.isSuccess) {
        // Backend returns null when there's no active pregnancy. ApiResponse
        // unwraps the envelope so we may get either a Map or a flat null.
        final data = response.data;
        setState(() {
          _timeline = data is Map<String, dynamic> ? data : null;
          _loading = false;
        });
      } else {
        setState(() {
          _error = response.message ?? 'Failed to load ANC timeline';
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
    return FeatureScreenScaffold(
      title: 'ANC Timeline',
      icon: Icons.pregnant_woman,
      color: const Color(0xFFF8BBD0),
      scrollable: true,
      child: RefreshIndicator(onRefresh: _fetch, child: _body(context)),
    );
  }

  Widget _body(BuildContext context) {
    final theme = Theme.of(context);
    if (_loading) {
      return const Padding(
        padding: EdgeInsets.all(32),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    if (_error != null) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              children: [
                Icon(
                  Icons.error_outline,
                  size: 48,
                  color: theme.colorScheme.error,
                ),
                const SizedBox(height: 12),
                Text(_error!, textAlign: TextAlign.center),
                const SizedBox(height: 12),
                ElevatedButton(onPressed: _fetch, child: const Text('Retry')),
              ],
            ),
          ),
        ],
      );
    }
    if (_timeline == null) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              children: [
                Icon(
                  Icons.pregnant_woman,
                  size: 48,
                  color: theme.colorScheme.outline,
                ),
                const SizedBox(height: 12),
                Text(
                  'No active pregnancy on record',
                  style: theme.textTheme.titleMedium,
                ),
                const SizedBox(height: 8),
                Text(
                  'If you have started antenatal care, your doctor will register your pregnancy at your next visit.',
                  textAlign: TextAlign.center,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: theme.colorScheme.outline,
                  ),
                ),
              ],
            ),
          ),
        ],
      );
    }

    final pregnancy =
        _timeline!['pregnancy'] as Map<String, dynamic>? ?? const {};
    final visits = (_timeline!['visits'] as List? ?? [])
        .whereType<Map<String, dynamic>>()
        .toList();
    final supplements = (_timeline!['supplements'] as List? ?? [])
        .whereType<Map<String, dynamic>>()
        .toList();

    // Visits come back newest-first. Render in chronological order for
    // the timeline view so the patient reads bottom-up like a story.
    final visitsAsc = [...visits].reversed.toList();
    final nextVisit = _resolveNextVisit(visits);

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(16),
      children: [
        _pregnancyHeader(theme, pregnancy),
        const SizedBox(height: 16),
        if (nextVisit != null) _nextVisitCard(theme, nextVisit),
        if (nextVisit != null) const SizedBox(height: 16),
        if (visitsAsc.isNotEmpty) ...[
          Text('Visits so far', style: theme.textTheme.titleMedium),
          const SizedBox(height: 8),
          ...visitsAsc.map((v) => _visitCard(theme, v)),
          const SizedBox(height: 16),
        ],
        if (supplements.isNotEmpty) ...[
          Text('Supplements', style: theme.textTheme.titleMedium),
          const SizedBox(height: 8),
          Card(
            child: Column(
              children: supplements
                  .map((s) => _supplementTile(theme, s))
                  .toList(),
            ),
          ),
        ],
      ],
    );
  }

  Widget _pregnancyHeader(ThemeData theme, Map<String, dynamic> p) {
    final ga = p['gestational_age'] as Map<String, dynamic>?;
    final gaLabel =
        ga?['label']?.toString() ??
        (ga?['weeks'] != null ? 'GA ${ga!['weeks']}+${ga['days'] ?? 0}' : '—');
    final edd = p['edd_date']?.toString();
    final highRisk = p['high_risk'] == true;
    final reasons = (p['high_risk_reasons'] as List? ?? [])
        .whereType<String>()
        .toList();
    return Card(
      color: theme.colorScheme.primaryContainer.withValues(alpha: 0.5),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              gaLabel,
              style: theme.textTheme.headlineSmall?.copyWith(
                fontWeight: FontWeight.w700,
              ),
            ),
            if (edd != null && edd.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text('Due ${_fmtDate(edd)}', style: theme.textTheme.bodyMedium),
            ],
            if (highRisk) ...[
              const SizedBox(height: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: theme.colorScheme.errorContainer,
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  reasons.isEmpty
                      ? 'High-risk pregnancy'
                      : 'High-risk: ${reasons.join(', ')}',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onErrorContainer,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Map<String, dynamic>? _resolveNextVisit(List<Map<String, dynamic>> visits) {
    // The latest visit's next_visit_date is the canonical "what's next"
    // for the patient. Visits arrive newest-first.
    for (final v in visits) {
      final nv = v['next_visit_date']?.toString();
      if (nv != null && nv.isNotEmpty) {
        return {
          'date': nv,
          'after_visit_number': v['visit_number'],
          'gestational_age_weeks': v['gestational_age_weeks'],
        };
      }
    }
    return null;
  }

  Widget _nextVisitCard(ThemeData theme, Map<String, dynamic> nv) {
    final cs = theme.colorScheme;
    final dateStr = nv['date']?.toString();
    return Card(
      color: cs.tertiaryContainer,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            Icon(Icons.event_available, color: cs.onTertiaryContainer),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Next visit',
                    style: theme.textTheme.titleSmall?.copyWith(
                      color: cs.onTertiaryContainer,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    dateStr != null ? _fmtDate(dateStr) : 'To be scheduled',
                    style: theme.textTheme.titleMedium?.copyWith(
                      color: cs.onTertiaryContainer,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _visitCard(ThemeData theme, Map<String, dynamic> v) {
    final visitNumber = v['visit_number'];
    final date = v['visit_date']?.toString();
    final ga = v['gestational_age_weeks'];
    final bpSys = v['bp_systolic'];
    final bpDia = v['bp_diastolic'];
    final weight = v['weight_kg'];
    final fhr = v['fetal_heart_rate_bpm'];
    final fundalHeight = v['fundal_height_cm'];
    final hb = v['hb_gm_dl'];
    final urineAlbumin = v['urine_albumin']?.toString();
    final notes = v['notes']?.toString();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    visitNumber != null ? 'Visit #$visitNumber' : 'Visit',
                    style: theme.textTheme.titleSmall,
                  ),
                ),
                if (date != null)
                  Text(_fmtDate(date), style: theme.textTheme.bodySmall),
              ],
            ),
            if (ga != null) ...[
              const SizedBox(height: 4),
              Text(
                'GA $ga weeks',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.outline,
                ),
              ),
            ],
            const SizedBox(height: 8),
            Wrap(
              spacing: 16,
              runSpacing: 8,
              children: [
                if (bpSys != null && bpDia != null)
                  _stat(theme, 'BP', '$bpSys/$bpDia'),
                if (weight != null) _stat(theme, 'Weight', '$weight kg'),
                if (fhr != null) _stat(theme, 'FHR', '$fhr bpm'),
                if (fundalHeight != null)
                  _stat(theme, 'Fundal ht.', '$fundalHeight cm'),
                if (hb != null) _stat(theme, 'Hb', '$hb g/dL'),
                if (urineAlbumin != null && urineAlbumin.isNotEmpty)
                  _stat(theme, 'Urine albumin', urineAlbumin),
              ],
            ),
            if (notes != null && notes.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(notes, style: theme.textTheme.bodySmall),
            ],
          ],
        ),
      ),
    );
  }

  Widget _stat(ThemeData theme, String label, String value) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.outline,
          ),
        ),
        Text(
          value,
          style: theme.textTheme.bodyMedium?.copyWith(
            fontWeight: FontWeight.w600,
          ),
        ),
      ],
    );
  }

  Widget _supplementTile(ThemeData theme, Map<String, dynamic> s) {
    final name = s['supplement']?.toString().replaceAll('_', ' ') ?? '—';
    final dose = s['dose']?.toString();
    final freq = s['frequency']?.toString().replaceAll('_', ' ');
    final start = s['start_date']?.toString();
    return ListTile(
      leading: const Icon(Icons.medication_outlined),
      title: Text(name[0].toUpperCase() + name.substring(1)),
      subtitle: Text(
        [
          if (dose != null && dose.isNotEmpty) dose,
          if (freq != null && freq.isNotEmpty) freq,
          if (start != null && start.isNotEmpty) 'since ${_fmtDate(start)}',
        ].join(' • '),
      ),
    );
  }

  String _fmtDate(String iso) {
    final d = DateTime.tryParse(iso);
    if (d == null) return iso;
    return DateFormat.yMMMd().format(d.toLocal());
  }
}
