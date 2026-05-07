// lib/features/maternity/widgets/partograph_chart.dart
//
// WHO modified-partograph chart. Plots cervical dilation (cm) on the
// y-axis vs hours since active phase started on the x-axis, with the
// alert and action lines overlaid. The alert line starts at (0, 4cm)
// and slopes 1cm/hr; the action line is parallel, four hours to the
// right (i.e., for any dilation D, action line time = (D - 4) + 4 hr).
//
// Data points outside the alert line render in amber, outside the
// action line in red, on-track in green.
//
// The "active phase" reference time is derived from labor_started_at
// or admitted_at. Caller passes:
//   - List<PartographPoint> (already fetched)
//   - DateTime activePhaseStartedAt
//
// Pure widget — caller orchestrates fetching.

import 'package:flutter/material.dart';

class PartographPoint {
  const PartographPoint({
    required this.recordedAt,
    required this.cervixDilationCm,
    this.fhrBpm,
    this.onAlertLine,
    this.onActionLine,
  });

  factory PartographPoint.fromJson(Map<String, dynamic> j) {
    return PartographPoint(
      recordedAt: DateTime.parse(j['recorded_at'] as String),
      cervixDilationCm: j['cervix_dilation_cm'] == null
          ? null
          : double.tryParse(j['cervix_dilation_cm'].toString()),
      fhrBpm: (j['fetal_heart_rate_bpm'] as num?)?.toInt(),
      onAlertLine: j['on_alert_line'] as bool?,
      onActionLine: j['on_action_line'] as bool?,
    );
  }

  final DateTime recordedAt;
  final double? cervixDilationCm;
  final int? fhrBpm;
  final bool? onAlertLine;
  final bool? onActionLine;
}

class PartographChart extends StatelessWidget {
  const PartographChart({
    super.key,
    required this.points,
    required this.activePhaseStartedAt,
    this.maxHours = 12,
    this.height = 320,
  });

  final List<PartographPoint> points;
  final DateTime activePhaseStartedAt;
  final double maxHours;
  final double height;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(8, 16, 16, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(left: 8, bottom: 8),
              child: Text(
                'Cervical dilation (cm) vs hours in active phase',
                style: theme.textTheme.labelMedium,
              ),
            ),
            SizedBox(
              height: height,
              child: CustomPaint(
                size: Size.infinite,
                painter: _PartographPainter(
                  points: points,
                  activePhaseStartedAt: activePhaseStartedAt,
                  maxHours: maxHours,
                  axisColour: theme.colorScheme.outlineVariant,
                  textColour: theme.colorScheme.outline,
                ),
              ),
            ),
            const SizedBox(height: 8),
            const Wrap(
              spacing: 16,
              runSpacing: 4,
              children: [
                _LegendDot(colour: Color(0xFF10B981), label: 'On track'),
                _LegendDot(colour: Color(0xFFF59E0B), label: 'Past alert line'),
                _LegendDot(colour: Color(0xFFEF4444), label: 'Past action line'),
                _LegendLine(
                  colour: Color(0xFFF59E0B),
                  label: 'Alert line (1 cm/hr)',
                ),
                _LegendLine(
                  colour: Color(0xFFEF4444),
                  label: 'Action line (alert + 4h)',
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _LegendDot extends StatelessWidget {
  const _LegendDot({required this.colour, required this.label});
  final Color colour;
  final String label;
  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(color: colour, shape: BoxShape.circle),
        ),
        const SizedBox(width: 4),
        Text(label, style: Theme.of(context).textTheme.labelSmall),
      ],
    );
  }
}

class _LegendLine extends StatelessWidget {
  const _LegendLine({required this.colour, required this.label});
  final Color colour;
  final String label;
  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(width: 14, height: 2, color: colour),
        const SizedBox(width: 4),
        Text(label, style: Theme.of(context).textTheme.labelSmall),
      ],
    );
  }
}

class _PartographPainter extends CustomPainter {
  _PartographPainter({
    required this.points,
    required this.activePhaseStartedAt,
    required this.maxHours,
    required this.axisColour,
    required this.textColour,
  });

  final List<PartographPoint> points;
  final DateTime activePhaseStartedAt;
  final double maxHours;
  final Color axisColour;
  final Color textColour;

  static const double minDilation = 0;
  static const double maxDilation = 10;

  // Plot area inset so axis labels have room.
  static const double leftPadding = 36;
  static const double bottomPadding = 24;
  static const double rightPadding = 8;
  static const double topPadding = 8;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final plot = Rect.fromLTRB(
      leftPadding,
      topPadding,
      w - rightPadding,
      h - bottomPadding,
    );

    // Background grid + axes.
    final gridPaint = Paint()
      ..color = axisColour.withValues(alpha: 0.4)
      ..strokeWidth = 0.5;
    final axisPaint = Paint()
      ..color = axisColour
      ..strokeWidth = 1;

    // Y-axis ticks (cm 0-10 in 2-cm steps).
    final textStyle = TextStyle(color: textColour, fontSize: 10);
    for (var cm = 0.0; cm <= maxDilation; cm += 2) {
      final y = _yFor(cm, plot);
      canvas.drawLine(Offset(plot.left, y), Offset(plot.right, y), gridPaint);
      _drawText(canvas, '${cm.toInt()}', Offset(2, y - 5), textStyle);
    }

    // X-axis ticks (hours in 2-hour steps).
    for (var hr = 0.0; hr <= maxHours; hr += 2) {
      final x = _xFor(hr, plot);
      canvas.drawLine(
        Offset(x, plot.top),
        Offset(x, plot.bottom),
        gridPaint,
      );
      _drawText(
        canvas,
        '${hr.toInt()}h',
        Offset(x - 8, plot.bottom + 4),
        textStyle,
      );
    }

    // Outer frame.
    canvas.drawRect(plot, axisPaint..style = PaintingStyle.stroke);

    // Alert line: from (0, 4cm) to (6, 10cm) at 1cm/hr.
    final alertPaint = Paint()
      ..color = const Color(0xFFF59E0B)
      ..strokeWidth = 2;
    canvas.drawLine(
      Offset(_xFor(0, plot), _yFor(4, plot)),
      Offset(_xFor(6, plot), _yFor(10, plot)),
      alertPaint,
    );

    // Action line: shifted right by 4 hours.
    final actionPaint = Paint()
      ..color = const Color(0xFFEF4444)
      ..strokeWidth = 2;
    canvas.drawLine(
      Offset(_xFor(4, plot), _yFor(4, plot)),
      Offset(_xFor(10, plot), _yFor(10, plot)),
      actionPaint,
    );

    // Plot cervix dilation line.
    final pointPaint = Paint()..style = PaintingStyle.fill;
    final linePaint = Paint()
      ..color = const Color(0xFF1E293B)
      ..strokeWidth = 1.2
      ..style = PaintingStyle.stroke;

    Offset? prev;
    for (final p in points) {
      if (p.cervixDilationCm == null) continue;
      final hours = p.recordedAt.difference(activePhaseStartedAt).inSeconds /
          3600.0;
      if (hours < 0 || hours > maxHours) continue;
      final dot = Offset(_xFor(hours, plot), _yFor(p.cervixDilationCm!, plot));
      if (prev != null) canvas.drawLine(prev, dot, linePaint);
      prev = dot;

      // Dot colour: red if past action, amber if past alert, else green.
      pointPaint.color = p.onActionLine == true
          ? const Color(0xFFEF4444)
          : p.onAlertLine == true
              ? const Color(0xFFF59E0B)
              : const Color(0xFF10B981);
      canvas.drawCircle(dot, 4, pointPaint);
    }

    // Y-axis label.
    _drawText(
      canvas,
      'cm',
      Offset(2, plot.top - 2),
      TextStyle(
        color: textColour,
        fontSize: 9,
        fontWeight: FontWeight.w600,
      ),
    );
  }

  double _yFor(double cm, Rect plot) {
    final norm = (cm - minDilation) / (maxDilation - minDilation);
    // Inverted because canvas y grows downward.
    return plot.bottom - norm * plot.height;
  }

  double _xFor(double hr, Rect plot) {
    final norm = hr / maxHours;
    return plot.left + norm * plot.width;
  }

  void _drawText(Canvas canvas, String s, Offset pos, TextStyle style) {
    final tp = TextPainter(
      text: TextSpan(text: s, style: style),
      textDirection: TextDirection.ltr,
    )..layout();
    tp.paint(canvas, pos);
  }

  @override
  bool shouldRepaint(_PartographPainter old) =>
      old.points != points ||
      old.activePhaseStartedAt != activePhaseStartedAt ||
      old.maxHours != maxHours;
}
