import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../core/theme/app_theme.dart';

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
        _activityCard(model),
        const SizedBox(height: 12),
        _vitalsCard(model),
        const SizedBox(height: 12),
        _clinicalMarkersCard(model),
      ],
    );
  }

  Widget _summaryHeader(_HealthJourneyModel model) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppTheme.divider),
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
                Text(
                  'Patient health journey',
                  style: TextStyle(
                    color: AppTheme.textPrimary,
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  'Patient app activity is shown as unverified until a clinician reviews it.',
                  style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
                ),
              ],
            ),
          ),
          _metricPill(
            icon: Icons.event_note_outlined,
            label: '${model.days.length} days',
            color: AppTheme.primaryBlue,
          ),
        ],
      ),
    );
  }

  Widget _activityCard(_HealthJourneyModel model) {
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
              ),
            ),
    );
  }

  Widget _vitalsCard(_HealthJourneyModel model) {
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
    return _sectionCard(
      icon: Icons.medical_information_outlined,
      title: 'Clinical event markers',
      subtitle: 'Tap an event to open the source detail',
      child: model.eventsByDay.isEmpty
          ? _smallEmpty('No clinical events in this date range')
          : _horizontal(
              controller: _markerScrollController,
              minWidth: model.chartWidth,
              child: _ClinicalMarkerRail(
                days: model.days,
                eventsByDay: model.eventsByDay,
                onEventTap: widget.onEventTap,
              ),
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
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppTheme.divider),
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
                        color: AppTheme.textPrimary,
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    Text(
                      subtitle,
                      style: TextStyle(
                        color: AppTheme.textSecondary,
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
          style: TextStyle(color: AppTheme.textSecondary, fontSize: 11),
        ),
      ],
    );
  }

  Widget _smallEmpty(String text) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 12),
      decoration: BoxDecoration(
        color: AppTheme.backgroundGrey,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: TextStyle(color: AppTheme.textSecondary),
      ),
    );
  }

  Widget _emptyState() {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 56, horizontal: 16),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Column(
        children: [
          Icon(Icons.timeline_outlined, size: 54, color: AppTheme.divider),
          const SizedBox(height: 12),
          Text(
            'No timeline data yet',
            style: TextStyle(
              color: AppTheme.textPrimary,
              fontSize: 16,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            'Clinical events and patient-app activity will appear here once available.',
            textAlign: TextAlign.center,
            style: TextStyle(color: AppTheme.textSecondary),
          ),
        ],
      ),
    );
  }
}

class _ActivityBars extends StatelessWidget {
  const _ActivityBars({required this.days, required this.activityByDay});

  final List<DateTime> days;
  final Map<String, _ActivityPoint> activityByDay;

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
                      color: AppTheme.textPrimary,
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
                      color: AppTheme.textSecondary,
                      fontSize: 10,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    _shortDate(day),
                    style: TextStyle(
                      color: AppTheme.textSecondary,
                      fontSize: 10,
                    ),
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
            color: AppTheme.textSecondary,
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

class _ClinicalMarkerRail extends StatelessWidget {
  const _ClinicalMarkerRail({
    required this.days,
    required this.eventsByDay,
    this.onEventTap,
  });

  final List<DateTime> days;
  final Map<String, List<Map<String, dynamic>>> eventsByDay;
  final ValueChanged<Map<String, dynamic>>? onEventTap;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: days.map((day) {
        final events =
            eventsByDay[_dayKey(day)] ?? const <Map<String, dynamic>>[];
        return SizedBox(
          width: 96,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                _shortDate(day),
                style: TextStyle(
                  color: AppTheme.textSecondary,
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 8),
              Container(height: 2, color: AppTheme.divider),
              const SizedBox(height: 8),
              if (events.isEmpty)
                Text(
                  '-',
                  style: TextStyle(color: AppTheme.textSecondary, fontSize: 11),
                )
              else
                ...events.take(4).map((event) {
                  final color = _eventColor(event);
                  return Padding(
                    padding: const EdgeInsets.only(bottom: 6, right: 8),
                    child: InkWell(
                      borderRadius: BorderRadius.circular(6),
                      onTap: onEventTap == null
                          ? null
                          : () => onEventTap!(event),
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 7,
                          vertical: 5,
                        ),
                        decoration: BoxDecoration(
                          color: color.withValues(alpha: 0.10),
                          borderRadius: BorderRadius.circular(6),
                          border: Border.all(
                            color: color.withValues(alpha: 0.20),
                          ),
                        ),
                        child: Text(
                          _shortEventTitle(event),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: color,
                            fontSize: 10,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                    ),
                  );
                }),
              if (events.length > 4)
                Text(
                  '+${events.length - 4} more',
                  style: TextStyle(
                    color: AppTheme.textSecondary,
                    fontSize: 10,
                    fontWeight: FontWeight.w600,
                  ),
                ),
            ],
          ),
        );
      }).toList(),
    );
  }
}

class _BpLinePainter extends CustomPainter {
  _BpLinePainter({required this.days, required this.bpByDay});

  final List<DateTime> days;
  final Map<String, _BpPoint> bpByDay;

  @override
  void paint(Canvas canvas, Size size) {
    _drawChartFrame(canvas, size, 'Blood pressure (mmHg)');
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
    );
  }

  @override
  bool shouldRepaint(covariant _BpLinePainter oldDelegate) {
    return oldDelegate.days != days || oldDelegate.bpByDay != bpByDay;
  }
}

class _WeightLinePainter extends CustomPainter {
  _WeightLinePainter({required this.days, required this.weightByDay});

  final List<DateTime> days;
  final Map<String, double> weightByDay;

  @override
  void paint(Canvas canvas, Size size) {
    _drawChartFrame(canvas, size, 'Weight (kg)');
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
    );
  }

  @override
  bool shouldRepaint(covariant _WeightLinePainter oldDelegate) {
    return oldDelegate.days != days || oldDelegate.weightByDay != weightByDay;
  }
}

void _drawChartFrame(Canvas canvas, Size size, String label) {
  final gridPaint = Paint()
    ..color = AppTheme.divider
    ..strokeWidth = 1;
  final labelPainter = TextPainter(
    text: TextSpan(
      text: label,
      style: TextStyle(
        color: AppTheme.textSecondary,
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
          color: AppTheme.textPrimary,
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
  });

  final List<DateTime> days;
  final Map<String, _ActivityPoint> activityByDay;
  final Map<String, double> weightByDay;
  final Map<String, _BpPoint> bpByDay;
  final Map<String, List<Map<String, dynamic>>> eventsByDay;

  bool get hasAnyData =>
      activityByDay.isNotEmpty ||
      weightByDay.isNotEmpty ||
      bpByDay.isNotEmpty ||
      eventsByDay.isNotEmpty;

  double get chartWidth => math.max(680, days.length * 78.0);

  factory _HealthJourneyModel.fromEvents(List<Map<String, dynamic>> events) {
    final daySet = <String, DateTime>{};
    final activityByDay = <String, _ActivityPoint>{};
    final weightByDay = <String, double>{};
    final bpByDay = <String, _BpPoint>{};
    final eventsByDay = <String, List<Map<String, dynamic>>>{};

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

      if (!_isPatientActivity(event)) {
        eventsByDay.putIfAbsent(key, () => []).add(event);
      }
    }

    final days = daySet.values.toList()..sort();
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

String _compactInt(int value) {
  if (value >= 1000) return '${(value / 1000).toStringAsFixed(1)}k';
  return value.toString();
}

String _shortEventTitle(Map<String, dynamic> event) {
  final title = (event['title'] ?? event['summary'] ?? '').toString().trim();
  if (title.isNotEmpty) return title;
  final type = (event['event_type'] ?? event['type'] ?? 'event').toString();
  return type.replaceAll('_', ' ').replaceAll('.', ' ');
}

Color _eventColor(Map<String, dynamic> event) {
  final type = (event['event_type'] ?? event['type'] ?? '').toString();
  if (type.contains('prescription') || type.contains('medication')) {
    return AppTheme.warningOnSurface;
  }
  if (type.contains('investigation') || type.contains('lab')) {
    return AppTheme.successOnSurface;
  }
  if (type.contains('vital')) return AppTheme.primaryTeal;
  if (type.contains('note')) return const Color(0xFF8E24AA);
  if (type.contains('referral')) return AppTheme.warningOnSurface;
  if (type.contains('admission')) return AppTheme.primaryBlue;
  return AppTheme.textSecondary;
}
