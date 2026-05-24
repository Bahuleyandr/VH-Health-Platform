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
  bool _savingKicks = false;
  String? _error;
  String? _kickMessage;
  Map<String, dynamic>? _timeline;
  Map<String, dynamic>? _kickPregnancy;
  List<Map<String, dynamic>> _kickLog = const [];
  List<Map<String, dynamic>> _packages = const [];
  List<Map<String, dynamic>> _advice = const [];
  bool _contentPendingReview = false;

  final _kickCountController = TextEditingController();
  final _kickWindowController = TextEditingController(text: '720');
  final _kickNotesController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _fetch();
  }

  @override
  void dispose() {
    _kickCountController.dispose();
    _kickWindowController.dispose();
    _kickNotesController.dispose();
    super.dispose();
  }

  Future<void> _fetch() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final responses = await Future.wait([
        ApiClient.get('/portal/maternity/timeline'),
        ApiClient.get('/portal/maternity/fetal-kicks'),
        ApiClient.get('/portal/maternity/packages'),
        ApiClient.get('/portal/maternity/anc-advice'),
      ]);
      if (!mounted) return;
      final timelineResponse = responses[0];
      final kicksResponse = responses[1];
      final packagesResponse = responses[2];
      final adviceResponse = responses[3];
      if (timelineResponse.isSuccess) {
        // Backend returns null when there's no active pregnancy. ApiResponse
        // unwraps the envelope so we may get either a Map or a flat null.
        final data = timelineResponse.data;
        final kickData = _asMap(kicksResponse.data);
        final adviceData = _asMap(adviceResponse.data);
        setState(() {
          _timeline = data is Map<String, dynamic> ? data : null;
          _kickPregnancy = _asMap(kickData?['pregnancy']);
          _kickLog = kicksResponse.isSuccess
              ? _listOfMaps(kickData?['fetal_kicks'])
              : const [];
          _packages = packagesResponse.isSuccess
              ? _listOfMaps(packagesResponse.data)
              : const [];
          _advice = adviceResponse.isSuccess
              ? _listOfMaps(adviceData?['advice'])
              : const [];
          _contentPendingReview = adviceData?['content_pending_review'] == true;
          _loading = false;
        });
      } else {
        setState(() {
          _error = timelineResponse.message ?? 'Failed to load ANC timeline';
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

  Future<void> _recordKickCount() async {
    final count = int.tryParse(_kickCountController.text.trim());
    final window = int.tryParse(_kickWindowController.text.trim());
    if (count == null || count < 0 || count > 999) {
      setState(() => _kickMessage = 'Enter a kick count between 0 and 999');
      return;
    }
    if (window == null || window <= 0 || window > 1440) {
      setState(
        () => _kickMessage = 'Observation window must be 1-1440 minutes',
      );
      return;
    }
    setState(() {
      _savingKicks = true;
      _kickMessage = null;
    });
    try {
      final response = await ApiClient.post(
        '/portal/maternity/fetal-kicks',
        body: {
          'kick_count': count,
          'observation_window_minutes': window,
          if (_kickNotesController.text.trim().isNotEmpty)
            'notes': _kickNotesController.text.trim(),
        },
      );
      if (!mounted) return;
      if (response.isSuccess) {
        _kickCountController.clear();
        _kickNotesController.clear();
        setState(() {
          _savingKicks = false;
          _kickMessage = 'Kick count saved';
        });
        await _fetch();
      } else {
        setState(() {
          _savingKicks = false;
          _kickMessage = response.message ?? 'Could not save kick count';
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _savingKicks = false;
        _kickMessage = e.toString();
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
        _kickCounterCard(theme),
        const SizedBox(height: 16),
        if (_advice.isNotEmpty) ...[
          _adviceSection(theme),
          const SizedBox(height: 16),
        ],
        if (_packages.isNotEmpty) ...[
          _packagesSection(theme),
          const SizedBox(height: 16),
        ],
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

  Widget _kickCounterCard(ThemeData theme) {
    final cs = theme.colorScheme;
    final latest = _kickLog.isNotEmpty ? _kickLog.first : null;
    final latestCount = latest?['kick_count'];
    final latestDate = latest?['log_date']?.toString();
    final lowFlag = latest?['low_count_flag'] == true;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.touch_app_outlined, color: cs.primary),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'Fetal kick counter',
                    style: theme.textTheme.titleMedium,
                  ),
                ),
              ],
            ),
            if (_kickPregnancy == null) ...[
              const SizedBox(height: 8),
              Text(
                'No active pregnancy is linked to this account.',
                style: theme.textTheme.bodyMedium,
              ),
            ] else ...[
              const SizedBox(height: 12),
              if (latest != null)
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: lowFlag
                        ? cs.errorContainer
                        : cs.secondaryContainer.withValues(alpha: 0.65),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Text(
                    latestDate != null
                        ? 'Last saved: $latestCount kicks on ${_fmtDate(latestDate)}'
                        : 'Last saved: $latestCount kicks',
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: lowFlag
                          ? cs.onErrorContainer
                          : cs.onSecondaryContainer,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              const SizedBox(height: 12),
              TextField(
                controller: _kickCountController,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(
                  labelText: 'Kick count',
                  prefixIcon: Icon(Icons.add_circle_outline),
                ),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _kickWindowController,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(
                  labelText: 'Observation window (minutes)',
                  prefixIcon: Icon(Icons.timer_outlined),
                ),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _kickNotesController,
                minLines: 1,
                maxLines: 3,
                decoration: const InputDecoration(
                  labelText: 'Notes',
                  prefixIcon: Icon(Icons.notes_outlined),
                ),
              ),
              if (_kickMessage != null) ...[
                const SizedBox(height: 8),
                Text(
                  _kickMessage!,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: _kickMessage == 'Kick count saved'
                        ? cs.primary
                        : cs.error,
                  ),
                ),
              ],
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: _savingKicks ? null : _recordKickCount,
                  icon: _savingKicks
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.save_outlined),
                  label: Text(_savingKicks ? 'Saving...' : 'Save kick count'),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _adviceSection(ThemeData theme) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('ANC self-care', style: theme.textTheme.titleMedium),
        if (_contentPendingReview) ...[
          const SizedBox(height: 6),
          Text(
            'Reviewed local-language guidance is pending clinical sign-off.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.outline,
            ),
          ),
        ],
        const SizedBox(height: 8),
        ..._advice.map((row) => _adviceTile(theme, row)),
      ],
    );
  }

  Widget _adviceTile(ThemeData theme, Map<String, dynamic> row) {
    final title = row['title']?.toString();
    final category = row['category']?.toString().replaceAll('_', ' ');
    final content = row['content']?.toString();
    final pending = row['content_status'] == 'pending_clinical_review';
    return Card(
      child: ListTile(
        leading: Icon(
          pending ? Icons.pending_actions_outlined : Icons.health_and_safety,
        ),
        title: Text(title?.isNotEmpty == true ? title! : _titleCase(category)),
        subtitle: Text(
          pending || content == null || content.isEmpty
              ? 'Clinical content pending review'
              : content,
        ),
      ),
    );
  }

  Widget _packagesSection(ThemeData theme) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Maternity packages', style: theme.textTheme.titleMedium),
        const SizedBox(height: 8),
        ..._packages.map((pkg) => _packageTile(theme, pkg)),
      ],
    );
  }

  Widget _packageTile(ThemeData theme, Map<String, dynamic> pkg) {
    final name = pkg['display_name']?.toString() ?? 'Maternity package';
    final desc = pkg['description']?.toString();
    final days = pkg['duration_days'];
    final price = pkg['fixed_price_minor'];
    final priceValue = price == null ? null : num.tryParse(price.toString());
    final priceLabel = priceValue == null
        ? 'Pricing under review'
        : '₹${NumberFormat.decimalPattern().format((priceValue / 100).round())}';
    return Card(
      child: ListTile(
        leading: const Icon(Icons.local_hospital_outlined),
        title: Text(name),
        subtitle: Text(
          [
            if (desc != null && desc.isNotEmpty) desc,
            if (days != null) '$days days',
            priceLabel,
          ].join(' • '),
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

  String _titleCase(String? value) {
    final text = value?.trim();
    if (text == null || text.isEmpty) return 'Advice';
    return text
        .split(RegExp(r'\s+'))
        .map(
          (word) => word.isEmpty
              ? word
              : '${word[0].toUpperCase()}${word.substring(1)}',
        )
        .join(' ');
  }

  Map<String, dynamic>? _asMap(Object? value) {
    if (value is Map<String, dynamic>) return value;
    if (value is Map) return Map<String, dynamic>.from(value);
    return null;
  }

  List<Map<String, dynamic>> _listOfMaps(Object? value) {
    if (value is! List) return const [];
    return value
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList(growable: false);
  }
}
