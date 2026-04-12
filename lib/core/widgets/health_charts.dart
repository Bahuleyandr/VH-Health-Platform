// lib/core/widgets/health_charts.dart
//
// Shared CustomPaint-based charts used across the patient app.
// Kept dependency-free (matches the existing `_TierRingPainter` pattern from
// `health_points_screen.dart`) so the app doesn't carry a charting library.
//
// Three primitives:
//   - [RingProgressPainter]  — circular progress ring (wellness score, Rx countdown)
//   - [GaugeChartPainter]    — semicircle gauge with colored zones + needle (lab results)
//   - [SparklinePainter]     — tiny line chart over a list of doubles (vitals/lab trends)

import 'dart:math' as math;

import 'package:flutter/material.dart';

/// Circular progress ring. 0.0 = empty, 1.0 = full. Starts at the top and
/// sweeps clockwise. The ring is drawn with a soft background track and a
/// rounded foreground arc. Callers typically stack a [Text]/[Column] child
/// inside the parent [CustomPaint] to show a value at the center.
class RingProgressPainter extends CustomPainter {
  final double progress;
  final Color color;
  final Color backgroundColor;
  final double strokeWidth;
  final double padding;

  const RingProgressPainter({
    required this.progress,
    required this.color,
    required this.backgroundColor,
    this.strokeWidth = 10.0,
    this.padding = 8.0,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = math.min(size.width, size.height) / 2 - padding;

    final bgPaint = Paint()
      ..color = backgroundColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..strokeCap = StrokeCap.round;
    canvas.drawCircle(center, radius, bgPaint);

    if (progress <= 0) return;

    final fgPaint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..strokeCap = StrokeCap.round;

    final sweep = 2 * math.pi * progress.clamp(0.0, 1.0);
    canvas.drawArc(
      Rect.fromCircle(center: center, radius: radius),
      -math.pi / 2,
      sweep,
      false,
      fgPaint,
    );
  }

  @override
  bool shouldRepaint(covariant RingProgressPainter old) {
    return old.progress != progress ||
        old.color != color ||
        old.backgroundColor != backgroundColor ||
        old.strokeWidth != strokeWidth;
  }
}

/// Semicircle gauge chart that visualises a numeric [value] against a
/// [min]..[max] range with three colored zones based on a reference band
/// [refLow]..[refHigh]:
///   * green  — value within reference band
///   * amber  — within 10% of either bound (borderline)
///   * red    — outside reference band
///
/// A needle is drawn at the value position.
class GaugeChartPainter extends CustomPainter {
  final double value;
  final double min;
  final double max;
  final double refLow;
  final double refHigh;
  final Color lowColor;
  final Color okColor;
  final Color highColor;
  final Color trackColor;
  final Color needleColor;
  final double strokeWidth;

  const GaugeChartPainter({
    required this.value,
    required this.min,
    required this.max,
    required this.refLow,
    required this.refHigh,
    required this.lowColor,
    required this.okColor,
    required this.highColor,
    required this.trackColor,
    required this.needleColor,
    this.strokeWidth = 14.0,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height);
    final radius = math.min(size.width / 2, size.height) - strokeWidth;

    final rect = Rect.fromCircle(center: center, radius: radius);

    // Full semicircle track (π to 2π, i.e. left→right across the top).
    final track = Paint()
      ..color = trackColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..strokeCap = StrokeCap.round;
    canvas.drawArc(rect, math.pi, math.pi, false, track);

    // Colored zones. Map value→angle: min→π, max→2π.
    double toAngle(double v) {
      final t = ((v - min) / (max - min)).clamp(0.0, 1.0);
      return math.pi + (t * math.pi);
    }

    final lowPaint = Paint()
      ..color = lowColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..strokeCap = StrokeCap.butt;
    final okPaint = Paint()
      ..color = okColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..strokeCap = StrokeCap.butt;
    final highPaint = Paint()
      ..color = highColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..strokeCap = StrokeCap.butt;

    final aLow = toAngle(refLow);
    final aHigh = toAngle(refHigh);

    // Below reference (red/low).
    canvas.drawArc(rect, math.pi, aLow - math.pi, false, lowPaint);
    // Within reference (green).
    canvas.drawArc(rect, aLow, aHigh - aLow, false, okPaint);
    // Above reference (red/high).
    canvas.drawArc(rect, aHigh, (math.pi * 2) - aHigh, false, highPaint);

    // Needle.
    final valueAngle = toAngle(value);
    final needlePaint = Paint()
      ..color = needleColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3.0
      ..strokeCap = StrokeCap.round;
    final nx = center.dx + (radius - 6) * math.cos(valueAngle);
    final ny = center.dy + (radius - 6) * math.sin(valueAngle);
    canvas.drawLine(center, Offset(nx, ny), needlePaint);

    // Needle hub.
    canvas.drawCircle(
      center,
      4,
      Paint()..color = needleColor,
    );
  }

  @override
  bool shouldRepaint(covariant GaugeChartPainter old) {
    return old.value != value ||
        old.min != min ||
        old.max != max ||
        old.refLow != refLow ||
        old.refHigh != refHigh;
  }
}

/// Simple line-chart sparkline. Renders [values] as a polyline scaled to the
/// widget size, with an optional fill under the line.
class SparklinePainter extends CustomPainter {
  final List<double> values;
  final Color color;
  final Color fillColor;
  final double strokeWidth;

  const SparklinePainter({
    required this.values,
    required this.color,
    required this.fillColor,
    this.strokeWidth = 2.0,
  });

  @override
  void paint(Canvas canvas, Size size) {
    if (values.length < 2) return;

    double minV = values.first;
    double maxV = values.first;
    for (final v in values) {
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    final range = (maxV - minV).abs() < 1e-9 ? 1.0 : (maxV - minV);

    final path = Path();
    final fillPath = Path();
    for (var i = 0; i < values.length; i++) {
      final x = (i / (values.length - 1)) * size.width;
      final y = size.height - ((values[i] - minV) / range) * size.height;
      if (i == 0) {
        path.moveTo(x, y);
        fillPath.moveTo(x, size.height);
        fillPath.lineTo(x, y);
      } else {
        path.lineTo(x, y);
        fillPath.lineTo(x, y);
      }
    }
    fillPath.lineTo(size.width, size.height);
    fillPath.close();

    canvas.drawPath(fillPath, Paint()..color = fillColor);
    canvas.drawPath(
      path,
      Paint()
        ..color = color
        ..style = PaintingStyle.stroke
        ..strokeWidth = strokeWidth
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round,
    );

    // Dot at the last point.
    canvas.drawCircle(
      Offset(size.width, size.height - ((values.last - minV) / range) * size.height),
      strokeWidth + 1,
      Paint()..color = color,
    );
  }

  @override
  bool shouldRepaint(covariant SparklinePainter old) {
    return old.values != values || old.color != color;
  }
}

/// Returns the status zone for [value] given a reference [low]..[high] band.
/// * `InRange.ok`         — comfortably inside
/// * `InRange.borderline` — within 10% of either bound
/// * `InRange.outOfRange` — outside band
InRange classifyReference(double value, double low, double high) {
  if (value < low || value > high) return InRange.outOfRange;
  final margin = (high - low) * 0.10;
  if (value - low < margin || high - value < margin) return InRange.borderline;
  return InRange.ok;
}

enum InRange { ok, borderline, outOfRange }
