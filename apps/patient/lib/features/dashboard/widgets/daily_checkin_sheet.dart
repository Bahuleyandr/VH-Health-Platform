// lib/features/dashboard/widgets/daily_checkin_sheet.dart
//
// Modal bottom sheet shown once per day on the dashboard to collect a quick
// mood check-in plus optional quick vitals (BP, blood sugar, weight).
//
// Flow:
//   1. Dashboard calls [maybeShowDailyCheckIn] on load.
//   2. It asks /gamification/checkin/status — if already done, no-op.
//   3. Otherwise presents the sheet. Submission:
//        • POSTs the mood to /gamification/checkin (awards 10 points)
//        • POSTs any provided vitals to /health/patient/vitals with the mood
//   4. Returns the new streak count from the check-in endpoint.

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'package:vhhealth/core/services/api_client.dart';

/// Entry point used by the dashboard. Returns silently if the user has
/// already checked in today or the status call fails.
Future<void> maybeShowDailyCheckIn(BuildContext context) async {
  try {
    final res = await ApiClient.get('/gamification/checkin/status');
    if (!context.mounted || !res.isSuccess) return;
    final data = res.dataAsMap();
    final already = data['checkedInToday'] == true;
    if (already) return;

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Theme.of(context).cardColor,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (ctx) => const DailyCheckInSheet(),
    );
  } catch (e) {
    if (kDebugMode) debugPrint('maybeShowDailyCheckIn: $e');
  }
}

class DailyCheckInSheet extends StatefulWidget {
  const DailyCheckInSheet({super.key});

  @override
  State<DailyCheckInSheet> createState() => _DailyCheckInSheetState();
}

class _DailyCheckInSheetState extends State<DailyCheckInSheet> {
  static const _moods = <_MoodOption>[
    _MoodOption('great', '😄', 'Great'),
    _MoodOption('good', '🙂', 'Good'),
    _MoodOption('okay', '😐', 'Okay'),
    _MoodOption('poor', '😕', 'Poor'),
    _MoodOption('bad', '😞', 'Bad'),
  ];

  String? _selectedMood;
  bool _submitting = false;
  int? _streak;
  bool _done = false;

  final _systolicCtrl = TextEditingController();
  final _diastolicCtrl = TextEditingController();
  final _bloodSugarCtrl = TextEditingController();
  final _weightCtrl = TextEditingController();

  @override
  void dispose() {
    _systolicCtrl.dispose();
    _diastolicCtrl.dispose();
    _bloodSugarCtrl.dispose();
    _weightCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final mood = _selectedMood;
    if (mood == null) return;
    setState(() => _submitting = true);

    try {
      final checkInRes = await ApiClient.post(
        '/gamification/checkin',
        body: {'mood': mood},
      );
      if (!mounted) return;

      int? newStreak;
      if (checkInRes.isSuccess) {
        newStreak = (checkInRes.dataAsMap()['streak'] as num?)?.toInt();
      }

      // Optional quick vitals.
      final vitalsBody = <String, dynamic>{'mood': mood};
      if (_systolicCtrl.text.isNotEmpty && _diastolicCtrl.text.isNotEmpty) {
        final sys = int.tryParse(_systolicCtrl.text);
        final dia = int.tryParse(_diastolicCtrl.text);
        if (sys != null && dia != null) {
          vitalsBody['bloodPressure'] = {'systolic': sys, 'diastolic': dia};
        }
      }
      if (_bloodSugarCtrl.text.isNotEmpty) {
        final bs = int.tryParse(_bloodSugarCtrl.text);
        if (bs != null) vitalsBody['bloodSugar'] = bs;
      }
      if (_weightCtrl.text.isNotEmpty) {
        final w = double.tryParse(_weightCtrl.text);
        if (w != null) vitalsBody['weight'] = w;
      }

      // Always fire-and-forget; vitals failure shouldn't block the check-in UX.
      if (vitalsBody.length > 1) {
        // Only send if at least one vital beyond 'mood' was provided.
        // ignore: unawaited_futures
        ApiClient.post('/health/patient/vitals', body: vitalsBody).catchError((e) {
          if (kDebugMode) debugPrint('DailyCheckInSheet: vitals post error: $e');
          // Return an ApiResponse-shaped value so the future completes.
          return checkInRes;
        });
      }

      if (!mounted) return;
      setState(() {
        _streak = newStreak;
        _done = true;
        _submitting = false;
      });
    } catch (e) {
      if (kDebugMode) debugPrint('DailyCheckInSheet: submit error: $e');
      if (mounted) {
        setState(() => _submitting = false);
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Could not save check-in. Please try again.')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final insets = MediaQuery.of(context).viewInsets;

    return Padding(
      padding: EdgeInsets.only(bottom: insets.bottom),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 42,
                height: 4,
                margin: const EdgeInsets.only(bottom: 12),
                decoration: BoxDecoration(
                  color: theme.hintColor.withValues(alpha: 0.3),
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            if (_done)
              _celebration(theme)
            else ...[
              Text('Daily Check-In',
                  style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold)),
              const SizedBox(height: 4),
              Text('How are you feeling today?',
                  style: theme.textTheme.bodyMedium?.copyWith(color: theme.hintColor)),
              const SizedBox(height: 16),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [for (final m in _moods) _moodChip(theme, m)],
              ),
              const SizedBox(height: 20),
              Text('Quick vitals (optional)',
                  style: theme.textTheme.labelLarge?.copyWith(fontWeight: FontWeight.w600)),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(child: _numField(_systolicCtrl, 'Sys', 'mmHg')),
                  const SizedBox(width: 8),
                  Expanded(child: _numField(_diastolicCtrl, 'Dia', 'mmHg')),
                ],
              ),
              const SizedBox(height: 10),
              _numField(_bloodSugarCtrl, 'Blood sugar', 'mg/dL'),
              const SizedBox(height: 10),
              _numField(_weightCtrl, 'Weight', 'kg', allowDecimal: true),
              const SizedBox(height: 20),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _selectedMood == null || _submitting ? null : _submit,
                  child: _submitting
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                        )
                      : const Text('Save check-in  ·  +10 points'),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _moodChip(ThemeData theme, _MoodOption m) {
    final selected = _selectedMood == m.value;
    return InkWell(
      borderRadius: BorderRadius.circular(14),
      onTap: () => setState(() => _selectedMood = m.value),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 8),
        decoration: BoxDecoration(
          color: selected
              ? theme.colorScheme.primary.withValues(alpha: 0.10)
              : Colors.transparent,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            color: selected ? theme.colorScheme.primary : theme.dividerColor,
            width: selected ? 2 : 1,
          ),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(m.emoji, style: const TextStyle(fontSize: 26)),
            const SizedBox(height: 4),
            Text(m.label, style: theme.textTheme.bodySmall),
          ],
        ),
      ),
    );
  }

  Widget _numField(TextEditingController c, String label, String suffix, {bool allowDecimal = false}) {
    return TextField(
      controller: c,
      keyboardType: TextInputType.numberWithOptions(decimal: allowDecimal),
      decoration: InputDecoration(
        labelText: label,
        suffixText: suffix,
        isDense: true,
        border: const OutlineInputBorder(),
      ),
    );
  }

  Widget _celebration(ThemeData theme) {
    final streak = _streak ?? 0;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Center(
          child: Icon(Icons.check_circle, color: Colors.green.shade600, size: 56),
        ),
        const SizedBox(height: 12),
        Text(
          streak > 1 ? 'Day $streak of your streak!' : 'Check-in saved',
          textAlign: TextAlign.center,
          style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 8),
        Text(
          '+10 health points added. See you tomorrow!',
          textAlign: TextAlign.center,
          style: theme.textTheme.bodyMedium?.copyWith(color: theme.hintColor),
        ),
        const SizedBox(height: 20),
        SizedBox(
          width: double.infinity,
          child: FilledButton.tonal(
            onPressed: () => Navigator.of(context).maybePop(),
            child: const Text('Done'),
          ),
        ),
      ],
    );
  }
}

class _MoodOption {
  final String value;
  final String emoji;
  final String label;
  const _MoodOption(this.value, this.emoji, this.label);
}
