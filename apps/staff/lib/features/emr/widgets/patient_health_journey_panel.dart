import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../core/theme/app_theme.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

const double _timelineSegmentWidth = 212.0;
const double _timelineSidePad = 108.0;
const double _timelineMinWidth = 920.0;

class PatientHealthJourneyPanel extends StatefulWidget {
  const PatientHealthJourneyPanel({
    super.key,
    required this.events,
    this.onEventTap,
  });

  final List<Map<String, dynamic>> events;
  final ValueChanged<Map<String, dynamic>>? onEventTap;

  @override
  State<PatientHealthJourneyPanel> createState() =>
      _PatientHealthJourneyPanelState();
}

class _PatientHealthJourneyPanelState extends State<PatientHealthJourneyPanel> {
  final _activityScrollController = ScrollController();
  final _vitalsScrollController = ScrollController();
  final _markerScrollController = ScrollController();

  @override
  void dispose() {
    _activityScrollController.dispose();
    _vitalsScrollController.dispose();
    _markerScrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final model = _HealthJourneyModel.fromEvents(widget.events);
    if (!model.hasAnyData) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        children: [_emptyState()],
      );
    }

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
      children: [
        _summaryHeader(model),
        const SizedBox(height: 12),
        if (model.timelineEvents.isNotEmpty) ...[
          _clinicalMarkersCard(model),
          const SizedBox(height: 12),
        ],
        if (model.hasVitals) ...[
          _vitalsCard(model),
          const SizedBox(height: 12),
        ],
        if (model.hasActivity) ...[
          _activityCard(model),
          const SizedBox(height: 12),
        ],
        if (!model.hasVitals && !model.hasActivity) _wellnessPlaceholder(),
      ],
    );
  }

  Widget _summaryHeader(_HealthJourneyModel model) {
    final colors = _JourneyColors.of(context);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: colors.card,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: colors.divider),
      ),
      child: Row(
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: AppTheme.primaryTeal.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(8),
            ),
            child: const Icon(
              Icons.timeline_outlined,
              color: AppTheme.primaryTeal,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                AppText(
                  's4.lib.patient_health_journey_panel.patient_health_journey',
                  style: TextStyle(
                    color: colors.textPrimary,
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 4),
                AppText(
                  's4.lib.patient_health_journey_panel.canonical_timeline_of_notes_prescriptions_invest',
                  style: TextStyle(color: colors.textSecondary, fontSize: 12),
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Flexible(
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              alignment: WrapAlignment.end,
              children: [
                _metricPill(
                  icon: Icons.timeline_outlined,
                  label: '${model.timelineEvents.length} events',
                  color: AppTheme.primaryBlue,
                ),
                _metricPill(
                  icon: Icons.date_range_outlined,
                  label: model.dateRangeLabel,
                  color: AppTheme.primaryTeal,
                ),
                if (model.latestEventLabel != null)
                  _metricPill(
                    icon: Icons.history_outlined,
                    label: model.latestEventLabel!,
                    color: AppTheme.warningOnSurface,
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _activityCard(_HealthJourneyModel model) {
    final colors = _JourneyColors.of(context);
    return _sectionCard(
      icon: Icons.directions_walk_outlined,
      title: 'Walking, steps, and sleep',
      subtitle: 'Daily patient-app summaries',
      trailing: _sourceChip('Patient generated'),
      child: model.activityByDay.isEmpty
          ? _smallEmpty('No patient-app activity synced yet')
          : _horizontal(
              controller: _activityScrollController,
              minWidth: model.chartWidth,
              child: _ActivityBars(
                days: model.days,
                activityByDay: model.activityByDay,
                colors: colors,
              ),
            ),
    );
  }

  Widget _vitalsCard(_HealthJourneyModel model) {
    final colors = _JourneyColors.of(context);
    final hasVitals = model.weightByDay.isNotEmpty || model.bpByDay.isNotEmpty;
    return _sectionCard(
      icon: Icons.monitor_heart_outlined,
      title: 'Vitals trends',
      subtitle: 'Weight and BP over time',
      trailing: Wrap(
        spacing: 6,
        runSpacing: 6,
        alignment: WrapAlignment.end,
        children: [
          _legendDot('Weight', AppTheme.primaryTeal),
          _legendDot('SBP', AppTheme.errorOnSurface),
          _legendDot('DBP', AppTheme.primaryBlue),
        ],
      ),
      child: !hasVitals
          ? _smallEmpty('No weight or BP trend data in this timeline yet')
          : _horizontal(
              controller: _vitalsScrollController,
              minWidth: model.chartWidth,
              child: Column(
                children: [
                  SizedBox(
                    height: 170,
                    child: CustomPaint(
                      painter: _BpLinePainter(
                        days: model.days,
                        bpByDay: model.bpByDay,
                        colors: colors,
                      ),
                      child: const SizedBox.expand(),
                    ),
                  ),
                  const SizedBox(height: 10),
                  SizedBox(
                    height: 150,
                    child: CustomPaint(
                      painter: _WeightLinePainter(
                        days: model.days,
                        weightByDay: model.weightByDay,
                        colors: colors,
                      ),
                      child: const SizedBox.expand(),
                    ),
                  ),
                ],
              ),
            ),
    );
  }

  Widget _clinicalMarkersCard(_HealthJourneyModel model) {
    final colors = _JourneyColors.of(context);
    return _sectionCard(
      icon: Icons.timeline_outlined,
      title: 'Clinical story',
      subtitle:
          'Time runs left to right. Tap any card to open the source detail.',
      trailing: _metricPill(
        icon: Icons.touch_app_outlined,
        label: 'Tap to inspect',
        color: AppTheme.primaryBlue,
      ),
      child: model.timelineEvents.isEmpty
          ? _smallEmpty('No clinical events in this date range')
          : _horizontal(
              controller: _markerScrollController,
              minWidth: model.timelineWidth,
              child: _HorizontalClinicalTimeline(
                events: model.timelineEvents,
                colors: colors,
                onEventTap: widget.onEventTap,
              ),
            ),
    );
  }

  Widget _wellnessPlaceholder() {
    return _sectionCard(
      icon: Icons.insights_outlined,
      title: 'Patient-generated trends',
      subtitle: 'Steps, walking distance, sleep, weight, and BP sync here',
      trailing: _sourceChip('Optional'),
      child: _smallEmpty(
        'No patient-app activity or trend vitals synced yet. Clinical events remain available above.',
      ),
    );
  }

  Widget _sectionCard({
    required IconData icon,
    required String title,
    required String subtitle,
    required Widget child,
    Widget? trailing,
  }) {
    final colors = _JourneyColors.of(context);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: colors.card,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: colors.divider),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, color: AppTheme.primaryBlue, size: 22),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: TextStyle(
                        color: colors.textPrimary,
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    Text(
                      subtitle,
                      style: TextStyle(
                        color: colors.textSecondary,
                        fontSize: 12,
                      ),
                    ),
                  ],
                ),
              ),
              ?trailing,
            ],
          ),
          const SizedBox(height: 12),
          child,
        ],
      ),
    );
  }

  Widget _horizontal({
    required ScrollController controller,
    required double minWidth,
    required Widget child,
  }) {
    return Scrollbar(
      controller: controller,
      thumbVisibility: true,
      trackVisibility: true,
      child: SingleChildScrollView(
        controller: controller,
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.only(bottom: 12),
        child: SizedBox(width: minWidth, child: child),
      ),
    );
  }

  Widget _sourceChip(String label) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      decoration: BoxDecoration(
        color: AppTheme.warningOnSurface.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(
          color: AppTheme.warningOnSurface.withValues(alpha: 0.35),
        ),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: AppTheme.warningOnSurface,
          fontSize: 11,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }

  Widget _metricPill({
    required IconData icon,
    required String label,
    required Color color,
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, color: color, size: 15),
          const SizedBox(width: 5),
          Text(
            label,
            style: TextStyle(
              color: color,
              fontSize: 12,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }

  Widget _legendDot(String label, Color color) {
    final colors = _JourneyColors.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 9,
          height: 9,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: 4),
        Text(
          label,
          style: TextStyle(color: colors.textSecondary, fontSize: 11),
        ),
      ],
    );
  }

  Widget _smallEmpty(String text) {
    final colors = _JourneyColors.of(context);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 12),
      decoration: BoxDecoration(
        color: colors.subtle,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: colors.divider),
      ),
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: TextStyle(color: colors.textSecondary),
      ),
    );
  }

  Widget _emptyState() {
    final colors = _JourneyColors.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 56, horizontal: 16),
      decoration: BoxDecoration(
        color: colors.card,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: colors.divider),
      ),
      child: Column(
        children: [
          Icon(Icons.timeline_outlined, size: 54, color: colors.divider),
          const SizedBox(height: 12),
          AppText(
            's4.lib.patient_health_journey_panel.no_timeline_data_yet',
            style: TextStyle(
              color: colors.textPrimary,
              fontSize: 16,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 4),
          AppText(
            's4.lib.patient_health_journey_panel.clinical_events_and_patient_app_activity_will_ap',
            textAlign: TextAlign.center,
            style: TextStyle(color: colors.textSecondary),
          ),
        ],
      ),
    );
  }
}

class _JourneyColors {
  const _JourneyColors({
    required this.card,
    required this.subtle,
    required this.chip,
    required this.textPrimary,
    required this.textSecondary,
    required this.divider,
    required this.isDark,
  });

  final Color card;
  final Color subtle;
  final Color chip;
  final Color textPrimary;
  final Color textSecondary;
  final Color divider;
  final bool isDark;

  factory _JourneyColors.of(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final isDark = theme.brightness == Brightness.dark;
    final card = theme.cardColor;
    final background = theme.scaffoldBackgroundColor;
    return _JourneyColors(
      card: card,
      subtle: Color.lerp(card, scheme.primary, isDark ? 0.045 : 0.025)!,
      chip: Color.lerp(background, card, isDark ? 0.35 : 0.78)!,
      textPrimary: theme.textTheme.bodyLarge?.color ?? scheme.onSurface,
      textSecondary:
          theme.textTheme.bodySmall?.color ?? scheme.onSurfaceVariant,
      divider: theme.dividerTheme.color ?? scheme.outlineVariant,
      isDark: isDark,
    );
  }
}

class _ActivityBars extends StatelessWidget {
  const _ActivityBars({
    required this.days,
    required this.activityByDay,
    required this.colors,
  });

  final List<DateTime> days;
  final Map<String, _ActivityPoint> activityByDay;
  final _JourneyColors colors;

  @override
  Widget build(BuildContext context) {
    final maxSteps = math.max(
      1,
      activityByDay.values.fold<int>(
        0,
        (max, item) => math.max(max, item.steps),
      ),
    );
    final maxDistance = math.max(
      1,
      activityByDay.values.fold<double>(
        0,
        (max, item) => math.max(max, item.distanceMeters),
      ),
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _axisHeader('Steps', AppTheme.primaryBlue),
        const SizedBox(height: 8),
        Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: days.map((day) {
            final point = activityByDay[_dayKey(day)];
            final stepsHeight = point == null
                ? 2.0
                : 70 * point.steps / maxSteps;
            final distanceHeight = point == null
                ? 2.0
                : 48 * point.distanceMeters / maxDistance;
            return SizedBox(
              width: 74,
              child: Column(
                children: [
                  SizedBox(
                    height: 82,
                    child: Align(
                      alignment: Alignment.bottomCenter,
                      child: _bar(
                        height: stepsHeight.clamp(2, 76),
                        color: AppTheme.primaryBlue,
                      ),
                    ),
                  ),
                  const SizedBox(height: 5),
                  Text(
                    point == null || point.steps == 0
                        ? '-'
                        : _compactInt(point.steps),
                    style: TextStyle(
                      color: colors.textPrimary,
                      fontSize: 11,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 10),
                  SizedBox(
                    height: 54,
                    child: Align(
                      alignment: Alignment.bottomCenter,
                      child: _bar(
                        height: distanceHeight.clamp(2, 48),
                        color: AppTheme.primaryTeal,
                      ),
                    ),
                  ),
                  const SizedBox(height: 5),
                  Text(
                    point == null || point.distanceMeters == 0
                        ? '-'
                        : '${(point.distanceMeters / 1000).toStringAsFixed(1)} km',
                    style: TextStyle(
                      color: colors.textSecondary,
                      fontSize: 10,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    _shortDate(day),
                    style: TextStyle(color: colors.textSecondary, fontSize: 10),
                  ),
                ],
              ),
            );
          }).toList(),
        ),
        const SizedBox(height: 8),
        _axisHeader('Distance', AppTheme.primaryTeal),
      ],
    );
  }

  Widget _axisHeader(String label, Color color) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: 5),
        Text(
          label,
          style: TextStyle(
            color: colors.textSecondary,
            fontSize: 11,
            fontWeight: FontWeight.w700,
          ),
        ),
      ],
    );
  }

  Widget _bar({required double height, required Color color}) {
    return Container(
      width: 18,
      height: height,
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.82),
        borderRadius: BorderRadius.circular(6),
      ),
    );
  }
}

class _HorizontalClinicalTimeline extends StatelessWidget {
  const _HorizontalClinicalTimeline({
    required this.events,
    required this.colors,
    this.onEventTap,
  });

  final List<Map<String, dynamic>> events;
  final _JourneyColors colors;
  final ValueChanged<Map<String, dynamic>>? onEventTap;

  @override
  Widget build(BuildContext context) {
    if (events.isEmpty) return const SizedBox.shrink();
    const laneHeight = 304.0;
    const axisY = 140.0;
    final width = math.max(
      _timelineMinWidth,
      _timelineSidePad * 2 + events.length * _timelineSegmentWidth,
    );
    final axisStart = _timelineSidePad + (_timelineSegmentWidth / 2);
    final axisEnd =
        _timelineSidePad +
        math.max(0, events.length - 1) * _timelineSegmentWidth +
        (_timelineSegmentWidth / 2);

    return SizedBox(
      width: width,
      height: laneHeight,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Positioned(
            left: axisStart,
            width: math.max(1, axisEnd - axisStart),
            top: axisY,
            child: Container(
              height: 4,
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  colors: [
                    AppTheme.primaryBlue.withValues(alpha: 0.20),
                    AppTheme.primaryBlue.withValues(alpha: 0.72),
                    AppTheme.primaryTeal.withValues(alpha: 0.60),
                  ],
                ),
                borderRadius: BorderRadius.circular(99),
              ),
            ),
          ),
          for (var i = 0; i < events.length; i++)
            _timelineEventNode(
              event: events[i],
              index: i,
              x:
                  _timelineSidePad +
                  i * _timelineSegmentWidth +
                  _timelineSegmentWidth / 2,
              axisY: axisY,
            ),
        ],
      ),
    );
  }

  Widget _timelineEventNode({
    required Map<String, dynamic> event,
    required int index,
    required double x,
    required double axisY,
  }) {
    final color = _eventColor(event, fallback: colors.textSecondary);
    final above = index.isEven;
    final eventDate = _eventDate(event);
    final cardTop = above ? 16.0 : axisY + 40;
    final stemTop = above ? 96.0 : axisY + 15;
    final stemHeight = above ? axisY - stemTop : 28.0;
    return Positioned(
      left: x - 88,
      top: 0,
      width: 176,
      height: 298,
      child: Stack(
        clipBehavior: Clip.none,
        alignment: Alignment.topCenter,
        children: [
          Positioned(
            top: stemTop,
            child: Container(
              width: 2,
              height: stemHeight,
              color: color.withValues(alpha: 0.45),
            ),
          ),
          Positioned(
            top: axisY - 9,
            child: Container(
              width: 22,
              height: 22,
              decoration: BoxDecoration(
                color: colors.card,
                shape: BoxShape.circle,
                border: Border.all(color: color, width: 3.5),
                boxShadow: [
                  BoxShadow(
                    color: color.withValues(alpha: 0.18),
                    blurRadius: 9,
                    spreadRadius: 1,
                  ),
                ],
              ),
              child: Center(
                child: Container(
                  width: 7,
                  height: 7,
                  decoration: BoxDecoration(
                    color: color,
                    shape: BoxShape.circle,
                  ),
                ),
              ),
            ),
          ),
          Positioned(
            top: axisY + 20,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(
                color: colors.chip,
                borderRadius: BorderRadius.circular(999),
                border: Border.all(color: colors.divider),
              ),
              child: Text(
                eventDate == null
                    ? '-'
                    : '${_shortDate(eventDate)}  ${_shortTime(eventDate)}',
                style: TextStyle(
                  color: colors.textSecondary,
                  fontSize: 10,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
          ),
          Positioned(
            top: cardTop,
            left: 0,
            right: 0,
            child: InkWell(
              borderRadius: BorderRadius.circular(8),
              onTap: onEventTap == null ? null : () => onEventTap!(event),
              child: Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: color.withValues(alpha: 0.42)),
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Icon(_eventIcon(event), color: color, size: 15),
                        const SizedBox(width: 5),
                        Expanded(
                          child: Text(
                            _eventKindLabel(event),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              color: color,
                              fontSize: 10,
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(
                      _shortEventTitle(event),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: colors.textPrimary,
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                        height: 1.18,
                      ),
                    ),
                    _eventSubtitleText(event),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _eventSubtitleText(Map<String, dynamic> event) {
    final subtitle = _eventSubtitle(event);
    if (subtitle.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 5),
      child: Text(
        subtitle,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          color: colors.textSecondary,
          fontSize: 10.5,
          height: 1.18,
        ),
      ),
    );
  }
}

class _BpLinePainter extends CustomPainter {
  _BpLinePainter({
    required this.days,
    required this.bpByDay,
    required this.colors,
  });

  final List<DateTime> days;
  final Map<String, _BpPoint> bpByDay;
  final _JourneyColors colors;

  @override
  void paint(Canvas canvas, Size size) {
    _drawChartFrame(canvas, size, 'Blood pressure (mmHg)', colors);
    final points = days
        .map((day) => MapEntry(day, bpByDay[_dayKey(day)]))
        .where((entry) => entry.value != null)
        .toList();
    if (points.isEmpty) return;

    final values = points
        .expand((entry) => [entry.value!.systolic, entry.value!.diastolic])
        .toList();
    final minValue = math.max(0, values.reduce(math.min) - 10).toDouble();
    final maxValue = (values.reduce(math.max) + 10).toDouble();

    _drawLine(
      canvas,
      size,
      days,
      points
          .map((entry) => MapEntry(entry.key, entry.value!.systolic))
          .toList(),
      minValue,
      maxValue,
      AppTheme.errorOnSurface,
      colors,
    );
    _drawLine(
      canvas,
      size,
      days,
      points
          .map((entry) => MapEntry(entry.key, entry.value!.diastolic))
          .toList(),
      minValue,
      maxValue,
      AppTheme.primaryBlue,
      colors,
    );
  }

  @override
  bool shouldRepaint(covariant _BpLinePainter oldDelegate) {
    return oldDelegate.days != days ||
        oldDelegate.bpByDay != bpByDay ||
        oldDelegate.colors != colors;
  }
}

class _WeightLinePainter extends CustomPainter {
  _WeightLinePainter({
    required this.days,
    required this.weightByDay,
    required this.colors,
  });

  final List<DateTime> days;
  final Map<String, double> weightByDay;
  final _JourneyColors colors;

  @override
  void paint(Canvas canvas, Size size) {
    _drawChartFrame(canvas, size, 'Weight (kg)', colors);
    final points = days
        .map((day) => MapEntry(day, weightByDay[_dayKey(day)]))
        .where((entry) => entry.value != null)
        .toList();
    if (points.isEmpty) return;

    final values = points.map((entry) => entry.value!).toList();
    final minValue = math.max(0, values.reduce(math.min) - 2).toDouble();
    final maxValue = (values.reduce(math.max) + 2).toDouble();
    _drawLine(
      canvas,
      size,
      days,
      points.map((entry) => MapEntry(entry.key, entry.value!)).toList(),
      minValue,
      maxValue,
      AppTheme.primaryTeal,
      colors,
    );
  }

  @override
  bool shouldRepaint(covariant _WeightLinePainter oldDelegate) {
    return oldDelegate.days != days ||
        oldDelegate.weightByDay != weightByDay ||
        oldDelegate.colors != colors;
  }
}

void _drawChartFrame(
  Canvas canvas,
  Size size,
  String label,
  _JourneyColors colors,
) {
  final gridPaint = Paint()
    ..color = colors.divider
    ..strokeWidth = 1;
  final labelPainter = TextPainter(
    text: TextSpan(
      text: label,
      style: TextStyle(
        color: colors.textSecondary,
        fontSize: 11,
        fontWeight: FontWeight.w700,
      ),
    ),
    textDirection: TextDirection.ltr,
  )..layout(maxWidth: size.width);
  labelPainter.paint(canvas, const Offset(0, 0));

  final top = 24.0;
  final bottom = size.height - 22;
  for (var i = 0; i < 4; i++) {
    final y = top + (bottom - top) * i / 3;
    canvas.drawLine(Offset(0, y), Offset(size.width, y), gridPaint);
  }
}

void _drawLine(
  Canvas canvas,
  Size size,
  List<DateTime> days,
  List<MapEntry<DateTime, double>> points,
  double minValue,
  double maxValue,
  Color color,
  _JourneyColors colors,
) {
  if (days.isEmpty || points.isEmpty) return;
  final top = 28.0;
  final bottom = size.height - 28;
  final chartHeight = math.max(1.0, bottom - top);
  final span = math.max(1.0, maxValue - minValue);
  final dayIndex = {for (var i = 0; i < days.length; i++) _dayKey(days[i]): i};
  final gap = days.length <= 1 ? 0.0 : size.width / (days.length - 1);

  Offset pointFor(DateTime day, double value) {
    final x = days.length <= 1
        ? size.width / 2
        : gap * (dayIndex[_dayKey(day)] ?? 0);
    final y = bottom - ((value - minValue) / span) * chartHeight;
    return Offset(x.clamp(0, size.width), y.clamp(top, bottom));
  }

  final path = Path();
  for (var i = 0; i < points.length; i++) {
    final offset = pointFor(points[i].key, points[i].value);
    if (i == 0) {
      path.moveTo(offset.dx, offset.dy);
    } else {
      path.lineTo(offset.dx, offset.dy);
    }
  }

  final paint = Paint()
    ..color = color
    ..strokeWidth = 2.5
    ..style = PaintingStyle.stroke
    ..strokeCap = StrokeCap.round;
  canvas.drawPath(path, paint);

  final dotPaint = Paint()..color = color;
  for (final entry in points) {
    final offset = pointFor(entry.key, entry.value);
    canvas.drawCircle(offset, 4, dotPaint);
    final textPainter = TextPainter(
      text: TextSpan(
        text: entry.value.toStringAsFixed(entry.value % 1 == 0 ? 0 : 1),
        style: TextStyle(
          color: colors.textPrimary,
          fontSize: 10,
          fontWeight: FontWeight.w700,
        ),
      ),
      textDirection: TextDirection.ltr,
    )..layout();
    textPainter.paint(canvas, offset.translate(5, -18));
  }
}

class _HealthJourneyModel {
  _HealthJourneyModel({
    required this.days,
    required this.activityByDay,
    required this.weightByDay,
    required this.bpByDay,
    required this.eventsByDay,
    required this.timelineEvents,
  });

  final List<DateTime> days;
  final Map<String, _ActivityPoint> activityByDay;
  final Map<String, double> weightByDay;
  final Map<String, _BpPoint> bpByDay;
  final Map<String, List<Map<String, dynamic>>> eventsByDay;
  final List<Map<String, dynamic>> timelineEvents;

  bool get hasAnyData =>
      activityByDay.isNotEmpty ||
      weightByDay.isNotEmpty ||
      bpByDay.isNotEmpty ||
      timelineEvents.isNotEmpty;

  bool get hasActivity => activityByDay.isNotEmpty;

  bool get hasVitals => weightByDay.isNotEmpty || bpByDay.isNotEmpty;

  String get dateRangeLabel {
    if (days.isEmpty) return '0 days';
    if (days.length == 1) return _shortDate(days.first);
    return '${_shortDate(days.first)}-${_shortDate(days.last)}';
  }

  String? get latestEventLabel {
    if (timelineEvents.isEmpty) return null;
    final latest = _eventDate(timelineEvents.last);
    if (latest == null) return 'Latest event';
    return 'Latest ${_shortTime(latest)}';
  }

  double get chartWidth => math.max(680, days.length * 78.0);

  double get timelineWidth => math.max(920, timelineEvents.length * 212.0);

  factory _HealthJourneyModel.fromEvents(List<Map<String, dynamic>> events) {
    final daySet = <String, DateTime>{};
    final activityByDay = <String, _ActivityPoint>{};
    final weightByDay = <String, double>{};
    final bpByDay = <String, _BpPoint>{};
    final eventsByDay = <String, List<Map<String, dynamic>>>{};
    final timelineEvents = <Map<String, dynamic>>[];

    for (final event in events) {
      final timestamp = _eventDate(event);
      if (timestamp == null) continue;
      final day = DateTime(timestamp.year, timestamp.month, timestamp.day);
      final key = _dayKey(day);
      daySet[key] = day;

      final activity = _activityFrom(event);
      if (activity != null) activityByDay[key] = activity;

      final weight = _weightFrom(event);
      if (weight != null && weight > 0) weightByDay[key] = weight;

      final bp = _bpFrom(event);
      if (bp != null) bpByDay[key] = bp;

      if (_isTimelineClinicalEvent(event)) {
        eventsByDay.putIfAbsent(key, () => []).add(event);
        timelineEvents.add(event);
      }
    }

    final days = daySet.values.toList()..sort();
    timelineEvents.sort((a, b) {
      final at = _eventDate(a) ?? DateTime.fromMillisecondsSinceEpoch(0);
      final bt = _eventDate(b) ?? DateTime.fromMillisecondsSinceEpoch(0);
      return at.compareTo(bt);
    });
    for (final events in eventsByDay.values) {
      events.sort((a, b) {
        final at = _eventDate(a) ?? DateTime.fromMillisecondsSinceEpoch(0);
        final bt = _eventDate(b) ?? DateTime.fromMillisecondsSinceEpoch(0);
        return at.compareTo(bt);
      });
    }

    return _HealthJourneyModel(
      days: days,
      activityByDay: activityByDay,
      weightByDay: weightByDay,
      bpByDay: bpByDay,
      eventsByDay: eventsByDay,
      timelineEvents: timelineEvents,
    );
  }
}

class _ActivityPoint {
  const _ActivityPoint({
    required this.steps,
    required this.distanceMeters,
    required this.sleepMinutes,
  });

  final int steps;
  final double distanceMeters;
  final int sleepMinutes;
}

class _BpPoint {
  const _BpPoint({required this.systolic, required this.diastolic});

  final double systolic;
  final double diastolic;
}

_ActivityPoint? _activityFrom(Map<String, dynamic> event) {
  final payload = _payload(event);
  final steps = _intValue(
    payload['steps'] ?? event['steps'] ?? payload['step_count'],
  );
  final distanceMeters = _doubleValue(
    payload['distance_meters'] ??
        payload['distanceMeters'] ??
        event['distance_meters'] ??
        event['distanceMeters'],
  );
  final sleepMinutes = _intValue(
    payload['sleep_minutes'] ??
        payload['sleepMinutes'] ??
        event['sleep_minutes'] ??
        event['sleepMinutes'],
  );
  if (steps == null && distanceMeters == null && sleepMinutes == null) {
    return null;
  }
  return _ActivityPoint(
    steps: steps ?? 0,
    distanceMeters: distanceMeters ?? 0,
    sleepMinutes: sleepMinutes ?? 0,
  );
}

double? _weightFrom(Map<String, dynamic> event) {
  final payload = _payload(event);
  final measurements = _map(payload['measurements'] ?? event['measurements']);
  return _doubleValue(
    payload['weight_kg'] ??
        payload['weight'] ??
        event['weight_kg'] ??
        event['weight'] ??
        measurements['weight_kg'] ??
        measurements['weight'],
  );
}

_BpPoint? _bpFrom(Map<String, dynamic> event) {
  final payload = _payload(event);
  final measurements = _map(payload['measurements'] ?? event['measurements']);
  final bp = _map(
    payload['blood_pressure'] ??
        event['blood_pressure'] ??
        measurements['blood_pressure'] ??
        measurements['bp'],
  );
  final systolic = _doubleValue(
    bp['systolic'] ??
        bp['systolic_bp'] ??
        payload['systolic_bp'] ??
        payload['sbp'] ??
        event['systolic_bp'] ??
        event['sbp'] ??
        measurements['systolic_bp'] ??
        measurements['sbp'],
  );
  final diastolic = _doubleValue(
    bp['diastolic'] ??
        bp['diastolic_bp'] ??
        payload['diastolic_bp'] ??
        payload['dbp'] ??
        event['diastolic_bp'] ??
        event['dbp'] ??
        measurements['diastolic_bp'] ??
        measurements['dbp'],
  );
  if (systolic == null || diastolic == null) return null;
  return _BpPoint(systolic: systolic, diastolic: diastolic);
}

DateTime? _eventDate(Map<String, dynamic> event) {
  final payload = _payload(event);
  final value =
      event['timestamp'] ??
      event['occurred_at'] ??
      event['created_at'] ??
      payload['source_day'] ??
      payload['date'];
  if (value is DateTime) return value;
  final text = value?.toString();
  if (text == null || text.trim().isEmpty) return null;
  if (RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(text)) {
    return DateTime.tryParse('${text}T12:00:00Z');
  }
  return DateTime.tryParse(text);
}

bool _isPatientActivity(Map<String, dynamic> event) {
  final type = (event['event_type'] ?? event['type'] ?? '').toString();
  final payload = _payload(event);
  return type.contains('patient_activity') ||
      payload['source_kind'] == 'patient_generated';
}

bool _isTimelineClinicalEvent(Map<String, dynamic> event) {
  if (_isPatientActivity(event)) return false;
  final type = (event['event_type'] ?? event['type'] ?? '')
      .toString()
      .toLowerCase();
  if (type.contains('.edited')) return false;
  return type.trim().isNotEmpty;
}

Map<String, dynamic> _payload(Map<String, dynamic> event) {
  final payload = event['payload'];
  if (payload is Map<String, dynamic>) return payload;
  if (payload is Map) return Map<String, dynamic>.from(payload);
  return event;
}

Map<String, dynamic> _map(dynamic value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return Map<String, dynamic>.from(value);
  return const {};
}

double? _doubleValue(dynamic value) {
  if (value is num) return value.toDouble();
  final text = value?.toString().trim();
  if (text == null || text.isEmpty) return null;
  return double.tryParse(text.replaceAll(RegExp(r'[^0-9.\-]'), ''));
}

int? _intValue(dynamic value) {
  if (value is int) return value;
  if (value is num) return value.round();
  final parsed = _doubleValue(value);
  return parsed?.round();
}

String _dayKey(DateTime day) {
  return '${day.year.toString().padLeft(4, '0')}-'
      '${day.month.toString().padLeft(2, '0')}-'
      '${day.day.toString().padLeft(2, '0')}';
}

String _shortDate(DateTime day) {
  return '${day.day.toString().padLeft(2, '0')}/${day.month.toString().padLeft(2, '0')}';
}

String _shortTime(DateTime value) {
  final local = value.toLocal();
  return '${local.hour.toString().padLeft(2, '0')}:${local.minute.toString().padLeft(2, '0')}';
}

String _compactInt(int value) {
  if (value >= 1000) return '${(value / 1000).toStringAsFixed(1)}k';
  return value.toString();
}

String _shortEventTitle(Map<String, dynamic> event) {
  final payload = _payload(event);
  final type = (event['event_type'] ?? event['type'] ?? '')
      .toString()
      .toLowerCase();
  final title =
      (event['title'] ?? event['summary'] ?? event['clinical_summary'] ?? '')
          .toString()
          .trim();
  if (type.contains('prescription') || type.contains('medication')) {
    if (title.contains('signed')) return 'Prescription signed';
    if (title.contains('created')) return 'Prescription created';
    if (title.contains('dispensed')) return 'Medicines dispensed';
    final drug =
        payload['drug_name'] ??
        payload['medication_name'] ??
        payload['name'] ??
        payload['generic_name'];
    if (drug != null && drug.toString().trim().isNotEmpty) {
      return 'Prescription - ${drug.toString().trim()}';
    }
    return title.isEmpty ? 'Prescription' : _humanizeEventText(title);
  }
  if (type.contains('note') || type.contains('consultation')) {
    final noteType =
        payload['note_type'] ?? payload['kind'] ?? payload['visit_type'];
    if (title.startsWith('OP consultation')) return title;
    if (noteType != null && noteType.toString().trim().isNotEmpty) {
      return '${_humanizeEventText(noteType.toString())} note';
    }
    return title.isEmpty ? 'Clinical note' : _humanizeEventText(title);
  }
  if (type.contains('investigation') || type.contains('lab')) {
    final test =
        payload['test_name'] ??
        payload['service_name'] ??
        payload['investigation_name'] ??
        payload['name'];
    final status = (payload['status'] ?? event['status'] ?? '')
        .toString()
        .trim();
    final action = status.isEmpty ? 'requested' : status.toLowerCase();
    if (test != null && test.toString().trim().isNotEmpty) {
      return '${_humanizeEventText(test.toString())} $action';
    }
    if (title.isNotEmpty && title.toLowerCase() != 'lab') {
      return _humanizeEventText(title);
    }
    return 'Investigation $action';
  }
  if (type.contains('referral')) {
    final department =
        payload['department'] ??
        payload['referred_to_department'] ??
        payload['speciality'];
    if (department != null && department.toString().trim().isNotEmpty) {
      return 'Referral - ${_humanizeEventText(department.toString())}';
    }
    return 'Specialist referral';
  }
  if (type.contains('vital')) return 'Vitals recorded';
  if (type.contains('admission')) return 'Admission';
  if (type.contains('discharge')) return 'Discharge';
  if (title.isNotEmpty) return _humanizeEventText(title);
  return _humanizeEventText(type.isEmpty ? 'event' : type);
}

String _eventSubtitle(Map<String, dynamic> event) {
  final payload = _payload(event);
  final type = (event['event_type'] ?? event['type'] ?? '')
      .toString()
      .toLowerCase();
  final status = (payload['status'] ?? event['status'] ?? '').toString().trim();
  final author =
      (payload['doctor_name'] ??
              payload['author_name'] ??
              payload['created_by_name'] ??
              event['author'])
          ?.toString()
          .trim();
  if (type.contains('prescription') || type.contains('medication')) {
    final diagnosis =
        payload['diagnosis'] ??
        payload['chief_complaint'] ??
        payload['clinical_context'];
    final parts = [
      if (status.isNotEmpty) _humanizeEventText(status),
      if (diagnosis != null && diagnosis.toString().trim().isNotEmpty)
        diagnosis.toString().trim(),
    ];
    return parts.join(' - ');
  }
  if (type.contains('note') || type.contains('consultation')) {
    final diagnosis =
        payload['diagnosis'] ??
        payload['chief_complaint'] ??
        payload['chief_complaints'] ??
        payload['assessment'];
    final parts = [
      if (author != null && author.isNotEmpty) author,
      if (diagnosis != null && diagnosis.toString().trim().isNotEmpty)
        diagnosis.toString().trim(),
    ];
    return parts.join(' - ');
  }
  if (type.contains('investigation') || type.contains('lab')) {
    final category =
        payload['category'] ?? payload['department'] ?? payload['modality'];
    final parts = [
      if (status.isNotEmpty) _humanizeEventText(status),
      if (category != null && category.toString().trim().isNotEmpty)
        _humanizeEventText(category.toString()),
    ];
    return parts.join(' - ');
  }
  if (author != null && author.isNotEmpty) return author;
  if (status.isNotEmpty) return _humanizeEventText(status);
  return '';
}

String _humanizeEventText(String value) {
  final text = value
      .replaceAll('_', ' ')
      .replaceAll('.', ' ')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
  if (text.isEmpty) return text;
  final lower = text.toLowerCase();
  return '${lower[0].toUpperCase()}${lower.substring(1)}';
}

String _eventKindLabel(Map<String, dynamic> event) {
  final type = (event['event_type'] ?? event['type'] ?? '')
      .toString()
      .toLowerCase();
  if (type.contains('prescription') || type.contains('medication')) {
    return 'Prescription';
  }
  if (type.contains('investigation') || type.contains('lab')) {
    return 'Investigation';
  }
  if (type.contains('vital')) return 'Vitals';
  if (type.contains('note') || type.contains('consultation')) {
    return 'Clinical note';
  }
  if (type.contains('referral')) return 'Referral';
  if (type.contains('admission')) return 'Admission';
  if (type.contains('discharge')) return 'Discharge';
  return 'Event';
}

IconData _eventIcon(Map<String, dynamic> event) {
  final type = (event['event_type'] ?? event['type'] ?? '')
      .toString()
      .toLowerCase();
  if (type.contains('prescription') || type.contains('medication')) {
    return Icons.medication_outlined;
  }
  if (type.contains('investigation') || type.contains('lab')) {
    return Icons.biotech_outlined;
  }
  if (type.contains('vital')) return Icons.monitor_heart_outlined;
  if (type.contains('note') || type.contains('consultation')) {
    return Icons.note_alt_outlined;
  }
  if (type.contains('referral')) return Icons.call_split_outlined;
  if (type.contains('admission')) return Icons.local_hospital_outlined;
  if (type.contains('discharge')) return Icons.exit_to_app_outlined;
  return Icons.circle_outlined;
}

Color _eventColor(Map<String, dynamic> event, {Color? fallback}) {
  final type = (event['event_type'] ?? event['type'] ?? '')
      .toString()
      .toLowerCase();
  if (type.contains('prescription') || type.contains('medication')) {
    return AppTheme.warningOnSurface;
  }
  if (type.contains('investigation') || type.contains('lab')) {
    return AppTheme.successOnSurface;
  }
  if (type.contains('vital')) return AppTheme.primaryTeal;
  if (type.contains('note') || type.contains('consultation')) {
    return const Color(0xFF8E24AA);
  }
  if (type.contains('referral')) return AppTheme.warningOnSurface;
  if (type.contains('admission')) return AppTheme.primaryBlue;
  return fallback ?? AppTheme.textSecondary;
}
