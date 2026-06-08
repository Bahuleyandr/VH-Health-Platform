import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:provider/provider.dart';

import 'package:vhhealth/core/providers/dependents_provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/features/period_tracker/models/cycle_tracker.dart';

class PeriodTrackerScreen extends StatefulWidget {
  const PeriodTrackerScreen({super.key});

  @override
  State<PeriodTrackerScreen> createState() => _PeriodTrackerScreenState();
}

class _PeriodTrackerScreenState extends State<PeriodTrackerScreen> {
  static const _accent = Colors.pinkAccent;

  DateTime? _lastPeriodStart;
  int _cycleLength = 28;
  int _periodLength = 5;
  bool _loading = true;
  bool _saving = false;

  String? _ownerKey;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _load();
    });
  }

  Future<void> _load() async {
    final user = context.read<UserProvider>();
    final dependent = context.read<DependentsProvider>().activeDependent;
    final snapshot = await CycleTrackerStore.load(
      userPhone: user.phone,
      dependentUid: dependent?.uid,
    );
    if (!mounted) return;
    setState(() {
      _ownerKey = snapshot.ownerKey;
      _lastPeriodStart = snapshot.lastPeriodStart;
      _cycleLength = snapshot.cycleLength;
      _periodLength = snapshot.periodLength;
      _loading = false;
    });
  }

  Future<void> _save() async {
    final ownerKey = _ownerKey;
    if (ownerKey == null) return;
    setState(() => _saving = true);
    await CycleTrackerStore.save(
      CycleTrackerSnapshot(
        ownerKey: ownerKey,
        lastPeriodStart: _lastPeriodStart,
        cycleLength: _cycleLength,
        periodLength: _periodLength,
      ),
    );
    if (!mounted) return;
    setState(() => _saving = false);
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(const SnackBar(content: Text('Cycle tracker saved')));
  }

  Future<void> _pickLastPeriodStart() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _lastPeriodStart ?? now,
      firstDate: DateTime(now.year - 2),
      lastDate: now,
      helpText: 'Last period start',
    );
    if (picked == null) return;
    setState(() => _lastPeriodStart = picked);
  }

  CycleEstimate? _estimate() {
    final ownerKey = _ownerKey;
    if (ownerKey == null) return null;
    return CycleTrackerSnapshot(
      ownerKey: ownerKey,
      lastPeriodStart: _lastPeriodStart,
      cycleLength: _cycleLength,
      periodLength: _periodLength,
    ).estimate();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final estimate = _estimate();

    return FeatureScreenScaffold(
      title: 'Period Tracker',
      icon: LucideIcons.calendarHeart,
      color: _accent,
      scrollable: true,
      child: _loading
          ? const Padding(
              padding: EdgeInsets.all(32),
              child: Center(child: CircularProgressIndicator()),
            )
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _HeroCyclePanel(
                  estimate: estimate,
                  accent: _accent,
                  onPickDate: _pickLastPeriodStart,
                ),
                const SizedBox(height: 18),
                Text(
                  'Cycle details',
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 10),
                _LengthControl(
                  label: 'Cycle length',
                  value: _cycleLength,
                  suffix: 'days',
                  min: 21,
                  max: 45,
                  accent: _accent,
                  onChanged: (value) => setState(() => _cycleLength = value),
                ),
                const SizedBox(height: 10),
                _LengthControl(
                  label: 'Period length',
                  value: _periodLength,
                  suffix: 'days',
                  min: 2,
                  max: 10,
                  accent: _accent,
                  onChanged: (value) => setState(() => _periodLength = value),
                ),
                const SizedBox(height: 16),
                if (estimate != null) ...[
                  _TimelinePanel(estimate: estimate, accent: _accent),
                  const SizedBox(height: 16),
                ],
                _PrivacyPanel(accent: _accent),
                const SizedBox(height: 18),
                FilledButton.icon(
                  onPressed: _saving ? null : _save,
                  icon: _saving
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(LucideIcons.save, size: 18),
                  label: Text(_saving ? 'Saving' : 'Save tracker'),
                  style: FilledButton.styleFrom(
                    backgroundColor: _accent,
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                  ),
                ),
              ],
            ),
    );
  }
}

class _HeroCyclePanel extends StatelessWidget {
  final CycleEstimate? estimate;
  final Color accent;
  final VoidCallback onPickDate;

  const _HeroCyclePanel({
    required this.estimate,
    required this.accent,
    required this.onPickDate,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final estimate = this.estimate;
    final title = estimate == null
        ? 'Start tracking'
        : estimate.daysToNextPeriod <= 0
        ? 'Period expected'
        : '${estimate.daysToNextPeriod} days to next period';
    final subtitle = estimate == null
        ? 'Add the first day of your last period.'
        : 'Cycle day ${estimate.cycleDay}';

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: accent.withValues(alpha: 0.32)),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            accent.withValues(alpha: 0.22),
            cs.surfaceContainerHighest.withValues(alpha: 0.45),
          ],
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Container(
                width: 54,
                height: 54,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: accent.withValues(alpha: 0.16),
                  shape: BoxShape.circle,
                ),
                child: Icon(LucideIcons.droplets, size: 28, color: accent),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: theme.textTheme.titleLarge?.copyWith(
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      subtitle,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: cs.onSurface.withValues(alpha: 0.68),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          OutlinedButton.icon(
            onPressed: onPickDate,
            icon: const Icon(LucideIcons.calendarPlus, size: 18),
            label: Text(
              estimate == null ? 'Add last period date' : 'Change start date',
            ),
            style: OutlinedButton.styleFrom(
              foregroundColor: accent,
              side: BorderSide(color: accent.withValues(alpha: 0.55)),
              padding: const EdgeInsets.symmetric(vertical: 12),
            ),
          ),
        ],
      ),
    );
  }
}

class _LengthControl extends StatelessWidget {
  final String label;
  final int value;
  final String suffix;
  final int min;
  final int max;
  final Color accent;
  final ValueChanged<int> onChanged;

  const _LengthControl({
    required this.label,
    required this.value,
    required this.suffix,
    required this.min,
    required this.max,
    required this.accent,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 8),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: cs.outlineVariant.withValues(alpha: 0.75)),
      ),
      child: Column(
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  label,
                  style: theme.textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              IconButton.filledTonal(
                visualDensity: VisualDensity.compact,
                onPressed: value <= min ? null : () => onChanged(value - 1),
                icon: const Icon(LucideIcons.minus, size: 16),
              ),
              SizedBox(
                width: 74,
                child: Text(
                  '$value $suffix',
                  textAlign: TextAlign.center,
                  maxLines: 1,
                  style: theme.textTheme.labelLarge?.copyWith(
                    fontWeight: FontWeight.w800,
                    color: accent,
                  ),
                ),
              ),
              IconButton.filledTonal(
                visualDensity: VisualDensity.compact,
                onPressed: value >= max ? null : () => onChanged(value + 1),
                icon: const Icon(LucideIcons.plus, size: 16),
              ),
            ],
          ),
          Slider(
            value: value.toDouble(),
            min: min.toDouble(),
            max: max.toDouble(),
            divisions: max - min,
            activeColor: accent,
            onChanged: (next) => onChanged(next.round()),
          ),
        ],
      ),
    );
  }
}

class _TimelinePanel extends StatelessWidget {
  final CycleEstimate estimate;
  final Color accent;

  const _TimelinePanel({required this.estimate, required this.accent});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _DateRow(
          icon: LucideIcons.droplet,
          label: 'Current period window',
          value:
              '${_dateLabel(estimate.cycleStart)} - ${_dateLabel(estimate.periodEnd)}',
          accent: accent,
        ),
        const SizedBox(height: 8),
        _DateRow(
          icon: LucideIcons.flower2,
          label: 'Estimated fertile window',
          value:
              '${_dateLabel(estimate.fertileStart)} - ${_dateLabel(estimate.fertileEnd)}',
          accent: Colors.tealAccent,
        ),
        const SizedBox(height: 8),
        _DateRow(
          icon: LucideIcons.calendarClock,
          label: 'Next period estimate',
          value: _dateLabel(estimate.nextPeriod),
          accent: Colors.amber,
        ),
      ],
    );
  }

  String _dateLabel(DateTime date) => DateFormat.MMMd().format(date);
}

class _DateRow extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  final Color accent;

  const _DateRow({
    required this.icon,
    required this.label,
    required this.value,
    required this.accent,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return Row(
      children: [
        Container(
          width: 36,
          height: 36,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: accent.withValues(alpha: 0.14),
            shape: BoxShape.circle,
          ),
          child: Icon(icon, size: 18, color: accent),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                label,
                style: theme.textTheme.labelMedium?.copyWith(
                  color: cs.onSurface.withValues(alpha: 0.62),
                ),
              ),
              Text(
                value,
                style: theme.textTheme.titleSmall?.copyWith(
                  fontWeight: FontWeight.w800,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _PrivacyPanel extends StatelessWidget {
  final Color accent;

  const _PrivacyPanel({required this.accent});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(LucideIcons.shieldCheck, color: accent, size: 20),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            'Saved locally on this device for now. Hospital sync can be added after we finalize consent, retention, and clinical review rules.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: cs.onSurface.withValues(alpha: 0.68),
            ),
          ),
        ),
      ],
    );
  }
}
