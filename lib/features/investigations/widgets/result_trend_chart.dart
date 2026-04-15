// lib/features/investigations/widgets/result_trend_chart.dart
//
// A compact sparkline showing how a single lab value has moved across
// repeat tests. Uses `SparklinePainter` from core/widgets/health_charts.dart.

import 'package:flutter/material.dart';

import 'package:vhhealth/core/widgets/health_charts.dart';

class ResultTrendChart extends StatelessWidget {
  /// Values ordered from oldest → newest (left → right on the sparkline).
  final List<double> values;
  final String? unit;
  final double height;
  final Color? color;

  const ResultTrendChart({
    super.key,
    required this.values,
    this.unit,
    this.height = 40,
    this.color,
  });

  @override
  Widget build(BuildContext context) {
    if (values.length < 2) return const SizedBox.shrink();
    final theme = Theme.of(context);
    final c = color ?? theme.colorScheme.primary;

    final latest = values.last;
    final previous = values[values.length - 2];
    final diff = latest - previous;
    final up = diff > 0.001;
    final down = diff < -0.001;
    final arrow = up ? Icons.arrow_upward : (down ? Icons.arrow_downward : Icons.remove);

    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Expanded(
          child: SizedBox(
            height: height,
            child: CustomPaint(
              painter: SparklinePainter(
                values: values,
                color: c,
                fillColor: c.withValues(alpha: 0.10),
              ),
            ),
          ),
        ),
        const SizedBox(width: 8),
        Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Text(
              _fmt(latest) + (unit != null ? ' $unit' : ''),
              style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.bold),
            ),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(arrow, size: 12, color: theme.hintColor),
                Text(
                  '${values.length} results',
                  style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor),
                ),
              ],
            ),
          ],
        ),
      ],
    );
  }

  static String _fmt(double v) {
    if (v == v.roundToDouble()) return v.toStringAsFixed(0);
    return v.toStringAsFixed(1);
  }
}
