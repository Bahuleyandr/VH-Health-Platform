import 'dart:async';

import 'package:flutter/material.dart';

import '../../../core/services/physio_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';
import '../models/physio_models.dart';
import '../widgets/physio_worklist_card.dart';

class PhysioScreen extends StatefulWidget {
  final String? initialPatientUid;
  final int? initialFollowUpPlanId;

  const PhysioScreen({
    super.key,
    this.initialPatientUid,
    this.initialFollowUpPlanId,
  });

  @override
  State<PhysioScreen> createState() => _PhysioScreenState();
}

class _PhysioScreenState extends State<PhysioScreen> {
  final _patientUid = TextEditingController();
  final _painScore = TextEditingController();
  final _notes = TextEditingController();
  final _planName = TextEditingController();
  final _duration = TextEditingController();
  final _painAfter = TextEditingController();
  final _outcomeScore = TextEditingController();
  final _exercise = TextEditingController();

  List<PhysioWorklistItem> _worklist = const [];
  PhysioWorklistItem? _selected;
  int? _assessmentId;
  int? _carePlanId;
  bool _loading = false;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final initialUid = widget.initialPatientUid?.trim();
    if (initialUid != null && initialUid.isNotEmpty) {
      _patientUid.text = initialUid;
    }
    unawaited(_loadWorklist());
  }

  @override
  void dispose() {
    _patientUid.dispose();
    _painScore.dispose();
    _notes.dispose();
    _planName.dispose();
    _duration.dispose();
    _painAfter.dispose();
    _outcomeScore.dispose();
    _exercise.dispose();
    super.dispose();
  }

  Future<void> _loadWorklist() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await PhysioApiService.getWorklist();
      final rows = (data['worklist'] as List? ?? const [])
          .whereType<Map>()
          .map(
            (row) =>
                PhysioWorklistItem.fromJson(Map<String, dynamic>.from(row)),
          )
          .toList(growable: false);
      if (!mounted) return;
      setState(() {
        _worklist = rows;
        _loading = false;
      });
      if (_selected == null && rows.isNotEmpty) _select(rows.first);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString().replaceFirst('Exception: ', '');
        _loading = false;
      });
    }
  }

  void _select(PhysioWorklistItem item) {
    setState(() {
      _selected = item;
      _patientUid.text = item.patientUid;
      _assessmentId = item.latestAssessmentId;
      _carePlanId = item.carePlanId;
      _planName.text = item.carePlanName ?? '';
    });
  }

  Future<void> _saveAssessment() async {
    final s = AppStrings.of(context);
    final uid = _patientUid.text.trim();
    if (uid.isEmpty) {
      _show(s.lookup('physio.patient_required'));
      return;
    }
    setState(() => _saving = true);
    try {
      final data = await PhysioApiService.recordAssessment({
        'patient_uid': uid,
        'follow_up_plan_id':
            _selected?.followUpPlanId ?? widget.initialFollowUpPlanId,
        'care_plan_id': _carePlanId,
        'assessment_kind': 'initial',
        'mobility_status': 'assisted_transfer',
        'pain_score': int.tryParse(_painScore.text.trim()),
        'rom_measures': [
          {'label': 'active_range', 'degrees': 90},
        ],
        'functional_limitations': [
          if (_notes.text.trim().isNotEmpty) _notes.text.trim(),
        ],
        'baseline_outcome_score': double.tryParse(_outcomeScore.text.trim()),
        'notes': _notes.text.trim(),
      });
      final assessment = data['assessment'] as Map<String, dynamic>?;
      if (!mounted) return;
      setState(() {
        _assessmentId = int.tryParse('${assessment?['id'] ?? ''}');
      });
      _show(s.lookup('physio.assessment_recorded'));
      await _loadWorklist();
    } catch (e) {
      if (mounted) _show(s.lookup('physio.submit_failed'));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _startPlan() async {
    final s = AppStrings.of(context);
    final uid = _patientUid.text.trim();
    if (uid.isEmpty) {
      _show(s.lookup('physio.patient_required'));
      return;
    }
    setState(() => _saving = true);
    try {
      final data = await PhysioApiService.startTherapyPlan({
        'patient_uid': uid,
        'follow_up_plan_id':
            _selected?.followUpPlanId ?? widget.initialFollowUpPlanId,
        'assessment_id': _assessmentId,
        'display_name': _planName.text.trim().isEmpty
            ? s.lookup('physio.default_plan_name')
            : _planName.text.trim(),
        'goal_summary': _notes.text.trim(),
      });
      final plan = data['care_plan'] as Map<String, dynamic>?;
      if (!mounted) return;
      setState(() {
        _carePlanId = int.tryParse('${plan?['id'] ?? ''}');
      });
      _show(s.lookup('physio.plan_started'));
      await _loadWorklist();
    } catch (e) {
      if (mounted) _show(s.lookup('physio.submit_failed'));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _recordSession() async {
    final s = AppStrings.of(context);
    if (_carePlanId == null) {
      _show(s.lookup('physio.plan_required'));
      return;
    }
    setState(() => _saving = true);
    try {
      await PhysioApiService.recordSession({
        'patient_uid': _patientUid.text.trim(),
        'care_plan_id': _carePlanId,
        'assessment_id': _assessmentId,
        'follow_up_plan_id':
            _selected?.followUpPlanId ?? widget.initialFollowUpPlanId,
        'session_status': 'completed',
        'duration_minutes': int.tryParse(_duration.text.trim()),
        'pain_score_before': int.tryParse(_painScore.text.trim()),
        'pain_score_after': int.tryParse(_painAfter.text.trim()),
        'exercise_entries': [
          if (_exercise.text.trim().isNotEmpty)
            {'label': _exercise.text.trim(), 'sets': 1, 'reps': 10},
        ],
        'outcome_score': double.tryParse(_outcomeScore.text.trim()),
        'notes': _notes.text.trim(),
      });
      if (!mounted) return;
      _show(s.lookup('physio.session_recorded'));
      await _loadWorklist();
    } catch (e) {
      if (mounted) _show(s.lookup('physio.submit_failed'));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  void _show(String message) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(s.lookup('physio.title')),
        actions: [
          IconButton(
            tooltip: s.actionRefresh,
            onPressed: _loading ? null : _loadWorklist,
            icon: const Icon(Icons.refresh),
          ),
          const LogoutAction(),
        ],
      ),
      body: Stack(
        children: [
          ListView(
            padding: const EdgeInsets.all(16),
            children: [
              _WorklistPanel(
                loading: _loading,
                error: _error,
                items: _worklist,
                selected: _selected,
                onSelect: _select,
              ),
              const SizedBox(height: 16),
              _EntryPanel(
                patientUid: _patientUid,
                painScore: _painScore,
                notes: _notes,
                planName: _planName,
                duration: _duration,
                painAfter: _painAfter,
                outcomeScore: _outcomeScore,
                exercise: _exercise,
                saving: _saving,
                carePlanId: _carePlanId,
                assessmentId: _assessmentId,
                onAssessment: _saveAssessment,
                onPlan: _startPlan,
                onSession: _recordSession,
              ),
            ],
          ),
          if (_saving)
            Positioned.fill(
              child: ColoredBox(
                color: Colors.black.withValues(alpha: 0.08),
                child: const Center(child: CircularProgressIndicator()),
              ),
            ),
        ],
      ),
    );
  }
}

class _WorklistPanel extends StatelessWidget {
  final bool loading;
  final String? error;
  final List<PhysioWorklistItem> items;
  final PhysioWorklistItem? selected;
  final ValueChanged<PhysioWorklistItem> onSelect;

  const _WorklistPanel({
    required this.loading,
    required this.error,
    required this.items,
    required this.selected,
    required this.onSelect,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            AppText('physio.worklist', style: theme.textTheme.titleMedium),
            const SizedBox(height: 12),
            if (loading)
              const Center(child: CircularProgressIndicator())
            else if (error != null)
              Text(error!, style: TextStyle(color: AppTheme.errorOnSurface))
            else if (items.isEmpty)
              const AppText('physio.worklist_empty')
            else
              for (final item in items)
                PhysioWorklistCard(
                  item: item,
                  selected:
                      selected?.patientUid == item.patientUid &&
                      selected?.followUpPlanId == item.followUpPlanId,
                  onTap: () => onSelect(item),
                ),
          ],
        ),
      ),
    );
  }
}

class _EntryPanel extends StatelessWidget {
  final TextEditingController patientUid;
  final TextEditingController painScore;
  final TextEditingController notes;
  final TextEditingController planName;
  final TextEditingController duration;
  final TextEditingController painAfter;
  final TextEditingController outcomeScore;
  final TextEditingController exercise;
  final bool saving;
  final int? carePlanId;
  final int? assessmentId;
  final VoidCallback onAssessment;
  final VoidCallback onPlan;
  final VoidCallback onSession;

  const _EntryPanel({
    required this.patientUid,
    required this.painScore,
    required this.notes,
    required this.planName,
    required this.duration,
    required this.painAfter,
    required this.outcomeScore,
    required this.exercise,
    required this.saving,
    required this.carePlanId,
    required this.assessmentId,
    required this.onAssessment,
    required this.onPlan,
    required this.onSession,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final theme = Theme.of(context);
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            AppText('physio.entry', style: theme.textTheme.titleMedium),
            const SizedBox(height: 12),
            TextField(
              key: const Key('physio_patient_uid'),
              controller: patientUid,
              decoration: InputDecoration(
                labelText: s.lookup('physio.patient_uid'),
                border: const OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              key: const Key('physio_pain_score'),
              controller: painScore,
              keyboardType: TextInputType.number,
              decoration: InputDecoration(
                labelText: s.lookup('physio.pain_score'),
                border: const OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              key: const Key('physio_outcome_score'),
              controller: outcomeScore,
              keyboardType: TextInputType.number,
              decoration: InputDecoration(
                labelText: s.lookup('physio.outcome_score'),
                border: const OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              key: const Key('physio_notes'),
              controller: notes,
              maxLines: 3,
              decoration: InputDecoration(
                labelText: s.lookup('physio.notes'),
                border: const OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 14),
            FilledButton.icon(
              key: const Key('physio_record_assessment'),
              onPressed: saving ? null : onAssessment,
              icon: const Icon(Icons.assignment_turned_in_outlined),
              label: Text(s.lookup('physio.record_assessment')),
            ),
            const Divider(height: 28),
            TextField(
              key: const Key('physio_plan_name'),
              controller: planName,
              decoration: InputDecoration(
                labelText: s.lookup('physio.plan_name'),
                border: const OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            FilledButton.icon(
              key: const Key('physio_start_plan'),
              onPressed: saving ? null : onPlan,
              icon: const Icon(Icons.playlist_add_check_circle_outlined),
              label: Text(s.lookup('physio.start_plan')),
            ),
            if (carePlanId != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(s.format('physio.plan_linked', {'id': carePlanId})),
              ),
            const Divider(height: 28),
            TextField(
              key: const Key('physio_duration'),
              controller: duration,
              keyboardType: TextInputType.number,
              decoration: InputDecoration(
                labelText: s.lookup('physio.duration_minutes'),
                border: const OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              key: const Key('physio_pain_after'),
              controller: painAfter,
              keyboardType: TextInputType.number,
              decoration: InputDecoration(
                labelText: s.lookup('physio.pain_after'),
                border: const OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              key: const Key('physio_exercise'),
              controller: exercise,
              decoration: InputDecoration(
                labelText: s.lookup('physio.exercise'),
                border: const OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            FilledButton.icon(
              key: const Key('physio_record_session'),
              onPressed: saving ? null : onSession,
              icon: const Icon(Icons.fitness_center_outlined),
              label: Text(s.lookup('physio.record_session')),
            ),
            if (assessmentId != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  s.format('physio.assessment_linked', {'id': assessmentId}),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
