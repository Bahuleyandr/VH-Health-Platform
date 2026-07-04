// lib/features/maternity/screens/anc_timeline_screen.dart
//
// Patient ANC timeline: pregnancy overview, trimester-aware safety advice,
// fetal kick logging, visits, packages, and supplement reminder toggles.

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:vhhealth/core/services/notification_scheduler.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/core/widgets/offline_banner.dart';
import 'package:vhhealth/features/maternity/models/anc_timeline.dart';
import 'package:vhhealth/features/maternity/services/maternity_repository.dart';
import 'package:vhhealth/generated/app_localizations.dart';

abstract class AncSupplementReminderScheduler {
  Future<void> schedule(AncSupplement supplement);

  Future<void> cancel(AncSupplement supplement);
}

class LocalAncSupplementReminderScheduler
    implements AncSupplementReminderScheduler {
  const LocalAncSupplementReminderScheduler();

  @override
  Future<void> schedule(AncSupplement supplement) async {
    if (!supplement.reminderEnabled || supplement.doseTimes.isEmpty) return;
    await NotificationScheduler.scheduleReminder(
      id: _projectedReminderId(supplement),
      medicationName: supplement.displayName,
      dosage: supplement.dose ?? '',
      reminderTimes: supplement.doseTimes,
      endDate: supplement.endDate?.split('T').first,
      isActive: true,
    );
  }

  @override
  Future<void> cancel(AncSupplement supplement) {
    return NotificationScheduler.cancelReminder(
      _projectedReminderId(supplement),
    );
  }

  int _projectedReminderId(AncSupplement supplement) =>
      NotificationScheduler.ancSupplementReminderIdOffset + supplement.id;
}

class AncTimelineScreen extends StatefulWidget {
  const AncTimelineScreen({
    super.key,
    MaternityRepository? repository,
    AncSupplementReminderScheduler? reminderScheduler,
  }) : repository = repository ?? const ApiMaternityRepository(),
       reminderScheduler =
           reminderScheduler ?? const LocalAncSupplementReminderScheduler();

  final MaternityRepository repository;
  final AncSupplementReminderScheduler reminderScheduler;

  @override
  State<AncTimelineScreen> createState() => _AncTimelineScreenState();
}

class _AncTimelineScreenState extends State<AncTimelineScreen> {
  bool _loading = true;
  bool _savingKicks = false;
  bool _kickMessageIsSuccess = false;
  String? _error;
  String? _kickMessage;
  String? _languageCode;
  int _loadToken = 0;
  AncTimelineData? _data;
  final Set<int> _togglingSupplementIds = {};

  final _kickCountController = TextEditingController();
  final _kickWindowController = TextEditingController(text: '720');
  final _kickNotesController = TextEditingController();

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final nextLanguage = Localizations.localeOf(context).languageCode;
    if (_languageCode != nextLanguage) {
      _languageCode = nextLanguage;
      _fetch();
    }
  }

  @override
  void dispose() {
    _kickCountController.dispose();
    _kickWindowController.dispose();
    _kickNotesController.dispose();
    super.dispose();
  }

  Future<void> _fetch() async {
    final token = ++_loadToken;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await widget.repository.loadTimeline(
        languageCode: _languageCode ?? 'en',
      );
      if (!mounted || token != _loadToken) return;
      setState(() {
        _data = data;
        _loading = false;
      });
    } catch (e) {
      if (kDebugMode) debugPrint('Error loading ANC timeline: $e');
      if (!mounted || token != _loadToken) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  Future<void> _recordKickCount() async {
    final l = AppLocalizations.of(context)!;
    final count = int.tryParse(_kickCountController.text.trim());
    final window = int.tryParse(_kickWindowController.text.trim());
    if (count == null || count < 0 || count > 999) {
      setState(() {
        _kickMessage = l.ancKickCountValidation;
        _kickMessageIsSuccess = false;
      });
      return;
    }
    if (window == null || window <= 0 || window > 1440) {
      setState(() {
        _kickMessage = l.ancWindowValidation;
        _kickMessageIsSuccess = false;
      });
      return;
    }
    setState(() {
      _savingKicks = true;
      _kickMessage = null;
      _kickMessageIsSuccess = false;
    });
    try {
      await widget.repository.recordFetalKicks(
        kickCount: count,
        observationWindowMinutes: window,
        notes: _kickNotesController.text,
      );
      if (!mounted) return;
      _kickCountController.clear();
      _kickNotesController.clear();
      setState(() {
        _savingKicks = false;
        _kickMessage = l.ancKickCountSaved;
        _kickMessageIsSuccess = true;
      });
      await _fetch();
    } catch (e) {
      if (kDebugMode) debugPrint('Error saving fetal kicks: $e');
      if (!mounted) return;
      setState(() {
        _savingKicks = false;
        _kickMessage = l.ancCouldNotSaveKickCount;
        _kickMessageIsSuccess = false;
      });
    }
  }

  Future<void> _toggleSupplementReminder(
    AncSupplement supplement,
    bool enabled,
  ) async {
    final l = AppLocalizations.of(context)!;
    setState(() => _togglingSupplementIds.add(supplement.id));
    try {
      final updated = await widget.repository.setSupplementReminder(
        supplement: supplement,
        enabled: enabled,
      );
      if (!mounted) return;
      _replaceSupplement(updated);

      var scheduleWarning = false;
      try {
        if (enabled) {
          await widget.reminderScheduler.schedule(updated);
          scheduleWarning = updated.doseTimes.isEmpty;
        } else {
          await widget.reminderScheduler.cancel(updated);
        }
      } catch (e) {
        scheduleWarning = true;
        if (kDebugMode) {
          debugPrint('ANC supplement notification sync failed: $e');
        }
      }

      if (!mounted) return;
      final message = scheduleWarning
          ? l.ancReminderScheduleFailed
          : enabled
          ? l.ancReminderOn
          : l.ancReminderOff;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(message)));
    } catch (e) {
      if (kDebugMode) debugPrint('ANC supplement reminder toggle failed: $e');
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(l.ancReminderToggleFailed)));
    } finally {
      if (mounted) {
        setState(() => _togglingSupplementIds.remove(supplement.id));
      }
    }
  }

  void _replaceSupplement(AncSupplement updated) {
    final data = _data;
    if (data == null) return;
    setState(() {
      _data = data.copyWith(
        supplements: data.supplements
            .map((item) => item.id == updated.id ? updated : item)
            .toList(growable: false),
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final colors = Theme.of(context).colorScheme;
    return FeatureScreenScaffold(
      title: l.ancTimelineTitle,
      icon: Icons.pregnant_woman,
      color: colors.tertiary,
      child: RefreshIndicator(onRefresh: _fetch, child: _body(context, l)),
    );
  }

  Widget _body(BuildContext context, AppLocalizations l) {
    final theme = Theme.of(context);
    if (_loading) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: const [
          SizedBox(
            height: 360,
            child: Center(child: CircularProgressIndicator()),
          ),
        ],
      );
    }
    if (_error != null) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          SizedBox(
            height: 360,
            child: _CenteredState(
              icon: Icons.error_outline,
              iconColor: theme.colorScheme.error,
              title: l.ancLoadFailed,
              subtitle: _error!,
              actionLabel: l.familyRetryButton,
              onAction: _fetch,
            ),
          ),
        ],
      );
    }

    final data = _data;
    if (data == null || !data.hasActivePregnancy) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          SizedBox(
            height: 360,
            child: _CenteredState(
              icon: Icons.pregnant_woman,
              iconColor: theme.colorScheme.outline,
              title: l.ancNoActivePregnancyTitle,
              subtitle: l.ancNoActivePregnancySubtitle,
            ),
          ),
        ],
      );
    }

    final visitsAsc = [...data.visits].reversed.toList();
    final nextVisit = _resolveNextVisit(data.visits);

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(16),
      children: [
        OfflineBanner(staleLabel: data.staleLabel),
        _pregnancyHeader(theme, l, data.pregnancy!),
        const SizedBox(height: 16),
        _dangerSignsSection(theme, l, data),
        const SizedBox(height: 16),
        _kickCounterCard(theme, l, data),
        const SizedBox(height: 16),
        if (data.selfCareAdvice.isNotEmpty || data.contentPendingReview) ...[
          _adviceSection(theme, l, data),
          const SizedBox(height: 16),
        ],
        if (data.packages.isNotEmpty) ...[
          _packagesSection(theme, l, data.packages),
          const SizedBox(height: 16),
        ],
        if (nextVisit != null) _nextVisitCard(theme, l, nextVisit),
        if (nextVisit != null) const SizedBox(height: 16),
        if (visitsAsc.isNotEmpty) ...[
          Text(l.ancVisitsSoFar, style: theme.textTheme.titleMedium),
          const SizedBox(height: 8),
          ...visitsAsc.map((v) => _visitCard(theme, l, v)),
          const SizedBox(height: 16),
        ],
        if (data.supplements.isNotEmpty) ...[
          Text(l.ancSupplements, style: theme.textTheme.titleMedium),
          const SizedBox(height: 8),
          Card(
            child: Column(
              children: data.supplements
                  .map((s) => _supplementTile(theme, l, s))
                  .toList(),
            ),
          ),
        ],
      ],
    );
  }

  Widget _pregnancyHeader(
    ThemeData theme,
    AppLocalizations l,
    AncPregnancy pregnancy,
  ) {
    final gaLabel =
        pregnancy.gestationalAgeLabel ??
        (pregnancy.gestationalWeeks != null
            ? 'GA ${pregnancy.gestationalWeeks}+${pregnancy.gestationalDays ?? 0}'
            : l.ancGestationalAgeFallback);
    final edd = pregnancy.eddDate;
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
              Text(
                '${l.ancDuePrefix} ${_fmtDate(context, edd)}',
                style: theme.textTheme.bodyMedium,
              ),
            ],
            if (pregnancy.highRisk) ...[
              const SizedBox(height: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: theme.colorScheme.errorContainer,
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  pregnancy.highRiskReasons.isEmpty
                      ? l.ancHighRiskPregnancy
                      : '${l.ancHighRiskPrefix}: ${pregnancy.highRiskReasons.join(', ')}',
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

  Widget _dangerSignsSection(
    ThemeData theme,
    AppLocalizations l,
    AncTimelineData data,
  ) {
    final cs = theme.colorScheme;
    final rows = data.dangerSigns;
    if (rows.isEmpty && !data.adviceLoadFailed) return const SizedBox.shrink();
    return Card(
      color: cs.errorContainer,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.warning_amber_rounded, color: cs.onErrorContainer),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    l.ancDangerSignsTitle,
                    style: theme.textTheme.titleMedium?.copyWith(
                      color: cs.onErrorContainer,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              data.currentTrimester == null
                  ? l.ancSafetyGuidanceSubtitle
                  : '${l.ancTrimesterPrefix} ${data.currentTrimester}: ${l.ancSafetyGuidanceSubtitle}',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: cs.onErrorContainer,
              ),
            ),
            if (data.adviceLoadFailed) ...[
              const SizedBox(height: 10),
              Text(
                l.ancAdviceLoadFailed,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: cs.onErrorContainer,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
            ...rows.map(
              (row) => Padding(
                padding: const EdgeInsets.only(top: 12),
                child: _adviceBody(theme, l, row, danger: true),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _kickCounterCard(
    ThemeData theme,
    AppLocalizations l,
    AncTimelineData data,
  ) {
    final cs = theme.colorScheme;
    final latest = data.fetalKicks.isNotEmpty ? data.fetalKicks.first : null;
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
                    l.ancFetalKickCounter,
                    style: theme.textTheme.titleMedium,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            if (latest != null)
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: latest.lowCountFlag
                      ? cs.errorContainer
                      : cs.secondaryContainer.withValues(alpha: 0.65),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  latest.logDate != null
                      ? '${l.ancLastSavedPrefix}: ${latest.kickCount ?? 0} ${l.ancKicksUnit} ${l.ancOnDatePrefix} ${_fmtDate(context, latest.logDate!)}'
                      : '${l.ancLastSavedPrefix}: ${latest.kickCount ?? 0} ${l.ancKicksUnit}',
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: latest.lowCountFlag
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
              decoration: InputDecoration(
                labelText: l.ancKickCountLabel,
                prefixIcon: const Icon(Icons.add_circle_outline),
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _kickWindowController,
              keyboardType: TextInputType.number,
              decoration: InputDecoration(
                labelText: l.ancObservationWindowLabel,
                prefixIcon: const Icon(Icons.timer_outlined),
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _kickNotesController,
              minLines: 1,
              maxLines: 3,
              decoration: InputDecoration(
                labelText: l.ancNotesLabel,
                prefixIcon: const Icon(Icons.notes_outlined),
              ),
            ),
            if (_kickMessage != null) ...[
              const SizedBox(height: 8),
              Text(
                _kickMessage!,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: _kickMessageIsSuccess ? cs.primary : cs.error,
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
                label: Text(_savingKicks ? l.ancSaving : l.ancSaveKickCount),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _adviceSection(
    ThemeData theme,
    AppLocalizations l,
    AncTimelineData data,
  ) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(l.ancSafetyGuidanceTitle, style: theme.textTheme.titleMedium),
        if (data.contentPendingReview) ...[
          const SizedBox(height: 6),
          Text(
            l.ancContentPendingReview,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.outline,
            ),
          ),
        ],
        const SizedBox(height: 8),
        ...data.selfCareAdvice.map(
          (row) => Card(
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: _adviceBody(theme, l, row),
            ),
          ),
        ),
      ],
    );
  }

  Widget _adviceBody(
    ThemeData theme,
    AppLocalizations l,
    AncAdvice row, {
    bool danger = false,
  }) {
    final cs = theme.colorScheme;
    final foreground = danger ? cs.onErrorContainer : null;
    final title = row.title?.trim().isNotEmpty == true
        ? row.title!.trim()
        : _categoryLabel(l, row.category);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: theme.textTheme.titleSmall?.copyWith(
            color: foreground,
            fontWeight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: 6),
        Text(
          row.isPendingClinicalReview
              ? l.ancClinicalContentPending
              : row.content!.trim(),
          style: theme.textTheme.bodyMedium?.copyWith(color: foreground),
        ),
      ],
    );
  }

  Widget _packagesSection(
    ThemeData theme,
    AppLocalizations l,
    List<MaternityPackage> packages,
  ) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(l.ancMaternityPackages, style: theme.textTheme.titleMedium),
        const SizedBox(height: 8),
        ...packages.map((pkg) => _packageTile(theme, l, pkg)),
      ],
    );
  }

  Widget _packageTile(
    ThemeData theme,
    AppLocalizations l,
    MaternityPackage package,
  ) {
    final name = package.displayName?.isNotEmpty == true
        ? package.displayName!
        : l.ancPackageFallback;
    final price = package.fixedPriceMinor;
    final priceLabel = price == null
        ? l.ancPricingUnderReview
        : '₹${NumberFormat.decimalPattern().format((price / 100).round())}';
    return Card(
      child: ListTile(
        leading: const Icon(Icons.local_hospital_outlined),
        title: Text(name),
        subtitle: Text(
          [
            if (package.description?.isNotEmpty == true) package.description!,
            if (package.durationDays != null)
              '${package.durationDays} ${l.ancDaysSuffix}',
            priceLabel,
          ].join(' • '),
        ),
      ),
    );
  }

  AncVisit? _resolveNextVisit(List<AncVisit> visits) {
    for (final visit in visits) {
      final date = visit.nextVisitDate;
      if (date != null && date.isNotEmpty) return visit;
    }
    return null;
  }

  Widget _nextVisitCard(ThemeData theme, AppLocalizations l, AncVisit visit) {
    final cs = theme.colorScheme;
    final dateStr = visit.nextVisitDate;
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
                    l.ancNextVisit,
                    style: theme.textTheme.titleSmall?.copyWith(
                      color: cs.onTertiaryContainer,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    dateStr != null
                        ? _fmtDate(context, dateStr)
                        : l.ancToBeScheduled,
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

  Widget _visitCard(ThemeData theme, AppLocalizations l, AncVisit visit) {
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
                    visit.visitNumber != null
                        ? '${l.ancVisitNumberPrefix} ${visit.visitNumber}'
                        : l.ancVisit,
                    style: theme.textTheme.titleSmall,
                  ),
                ),
                if (visit.visitDate != null)
                  Text(
                    _fmtDate(context, visit.visitDate!),
                    style: theme.textTheme.bodySmall,
                  ),
              ],
            ),
            if (visit.gestationalAgeWeeks != null) ...[
              const SizedBox(height: 4),
              Text(
                '${visit.gestationalAgeWeeks} ${l.ancGaWeeksSuffix}',
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
                if (visit.bpSystolic != null && visit.bpDiastolic != null)
                  _stat(
                    theme,
                    l.ancBpLabel,
                    '${visit.bpSystolic}/${visit.bpDiastolic}',
                  ),
                if (visit.weightKg != null)
                  _stat(theme, l.ancWeightLabel, '${visit.weightKg} kg'),
                if (visit.fetalHeartRateBpm != null)
                  _stat(theme, l.ancFhrLabel, '${visit.fetalHeartRateBpm} bpm'),
                if (visit.fundalHeightCm != null)
                  _stat(
                    theme,
                    l.ancFundalHeightLabel,
                    '${visit.fundalHeightCm} cm',
                  ),
                if (visit.hbGmDl != null)
                  _stat(theme, l.ancHbLabel, '${visit.hbGmDl} g/dL'),
                if (visit.urineAlbumin != null &&
                    visit.urineAlbumin!.isNotEmpty)
                  _stat(theme, l.ancUrineAlbuminLabel, visit.urineAlbumin!),
              ],
            ),
            if (visit.notes != null && visit.notes!.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(visit.notes!, style: theme.textTheme.bodySmall),
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

  Widget _supplementTile(
    ThemeData theme,
    AppLocalizations l,
    AncSupplement supplement,
  ) {
    final toggling = _togglingSupplementIds.contains(supplement.id);
    final details = [
      if (supplement.dose?.isNotEmpty == true)
        '${l.ancDosePrefix}: ${supplement.dose}',
      if (supplement.frequency?.isNotEmpty == true)
        '${l.ancFrequencyPrefix}: ${_frequencyLabel(l, supplement.frequency!)}',
      if (supplement.startDate?.isNotEmpty == true)
        '${l.ancSincePrefix} ${_fmtDate(context, supplement.startDate!)}',
      if (supplement.doseTimes.isNotEmpty)
        '${l.ancReminderTimesPrefix}: ${supplement.doseTimes.join(', ')}'
      else
        l.ancNoFixedReminderTime,
    ];
    return Padding(
      padding: const EdgeInsets.all(14),
      child: Row(
        children: [
          Icon(Icons.medication_outlined, color: theme.colorScheme.primary),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(supplement.displayName, style: theme.textTheme.titleSmall),
                const SizedBox(height: 4),
                Text(
                  details.join(' • '),
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
                if (supplement.notes?.isNotEmpty == true) ...[
                  const SizedBox(height: 4),
                  Text(
                    supplement.notes!,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(width: 8),
          Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (toggling)
                const SizedBox(
                  width: 24,
                  height: 24,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              else
                Switch.adaptive(
                  key: ValueKey('anc_supplement_reminder_${supplement.id}'),
                  value: supplement.reminderEnabled,
                  onChanged: (value) =>
                      _toggleSupplementReminder(supplement, value),
                ),
              const SizedBox(height: 2),
              Text(
                supplement.reminderEnabled
                    ? l.ancReminderEnabledLabel
                    : l.ancReminderDisabledLabel,
                style: theme.textTheme.labelSmall,
              ),
            ],
          ),
        ],
      ),
    );
  }

  String _categoryLabel(AppLocalizations l, String category) {
    return switch (category) {
      'danger_signs' => l.ancAdviceCategoryDangerSigns,
      'fetal_movement' => l.ancAdviceCategoryFetalMovement,
      'foods_to_avoid' => l.ancAdviceCategoryFoodsToAvoid,
      'when_to_contact' => l.ancAdviceCategoryWhenToContact,
      _ => titleCase(category.replaceAll('_', ' ')),
    };
  }

  String _frequencyLabel(AppLocalizations l, String frequency) {
    return switch (frequency) {
      'once_daily' => l.ancFrequencyOnceDaily,
      'twice_daily' => l.ancFrequencyTwiceDaily,
      'thrice_daily' => l.ancFrequencyThriceDaily,
      'weekly' => l.ancFrequencyWeekly,
      'as_needed' => l.ancFrequencyAsNeeded,
      _ => titleCase(frequency.replaceAll('_', ' ')),
    };
  }

  String _fmtDate(BuildContext context, String iso) {
    final d = DateTime.tryParse(iso);
    if (d == null) return iso;
    return DateFormat.yMMMd(
      Localizations.localeOf(context).toLanguageTag(),
    ).format(d.toLocal());
  }
}

class _CenteredState extends StatelessWidget {
  const _CenteredState({
    required this.icon,
    required this.iconColor,
    required this.title,
    required this.subtitle,
    this.actionLabel,
    this.onAction,
  });

  final IconData icon;
  final Color iconColor;
  final String title;
  final String subtitle;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 56, color: iconColor),
            const SizedBox(height: 12),
            Text(
              title,
              textAlign: TextAlign.center,
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              subtitle,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            if (actionLabel != null && onAction != null) ...[
              const SizedBox(height: 16),
              FilledButton.tonal(
                onPressed: onAction,
                child: Text(actionLabel!),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
