// lib/features/investigations/widgets/result_gauge_widget.dart
//
// Renders a single lab result as a semicircle gauge showing where the value
// sits inside the reference band:
//   • green  — safely inside the reference range
//   • amber  — borderline (within 10% of either bound)
//   • red    — out of range
//
// Also supports an optional "previous value" indicator with a trend arrow,
// matching the pattern used by `_VitalsTrendSummary`.

import 'package:flutter/material.dart';

import 'package:vhhealth/core/widgets/health_charts.dart';

/// Parsed reference range. Returns `null` if the raw string cannot be parsed
/// into a numeric low/high pair. Accepts formats like:
///   "70-100", "70 - 100", "70 to 100", "<100", ">40".
class LabReferenceRange {
  final double low;
  final double high;
  final String? unit;

  const LabReferenceRange({required this.low, required this.high, this.unit});

  static LabReferenceRange? tryParse(String? raw, {String? unit}) {
    if (raw == null) return null;
    final s = raw.trim().toLowerCase();
    if (s.isEmpty) return null;

    final dash = RegExp(
      r'(-?\d+(?:\.\d+)?)\s*(?:-|to|–|—)\s*(-?\d+(?:\.\d+)?)',
    );
    final m1 = dash.firstMatch(s);
    if (m1 != null) {
      final lo = double.tryParse(m1.group(1)!);
      final hi = double.tryParse(m1.group(2)!);
      if (lo != null && hi != null && hi > lo) {
        return LabReferenceRange(low: lo, high: hi, unit: unit);
      }
    }
    final lt = RegExp(r'^<\s*(-?\d+(?:\.\d+)?)').firstMatch(s);
    if (lt != null) {
      final hi = double.tryParse(lt.group(1)!);
      if (hi != null) return LabReferenceRange(low: 0, high: hi, unit: unit);
    }
    final gt = RegExp(r'^>\s*(-?\d+(?:\.\d+)?)').firstMatch(s);
    if (gt != null) {
      final lo = double.tryParse(gt.group(1)!);
      if (lo != null) {
        return LabReferenceRange(low: lo, high: lo * 2, unit: unit);
      }
    }
    return null;
  }
}

class ResultGaugeWidget extends StatelessWidget {
  final String testName;
  final double value;
  final double? previousValue;
  final LabReferenceRange range;
  final String? unit;
  final bool higherIsBad;

  const ResultGaugeWidget({
    super.key,
    required this.testName,
    required this.value,
    required this.range,
    this.previousValue,
    this.unit,
    this.higherIsBad = true,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    final status = classifyReference(value, range.low, range.high);
    final statusColor = switch (status) {
      InRange.ok => Colors.green.shade600,
      InRange.borderline => Colors.amber.shade700,
      InRange.outOfRange => Colors.red.shade600,
    };
    final statusLabel = switch (status) {
      InRange.ok => 'In range',
      InRange.borderline => 'Borderline',
      InRange.outOfRange => 'Out of range',
    };

    // Gauge axis: widen the reference band by 30% on each side so the needle
    // has somewhere to go when value falls outside the band.
    final span = range.high - range.low;
    final axisMin = (range.low - span * 0.3);
    final axisMax = (range.high + span * 0.3);

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: theme.cardColor,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: statusColor.withValues(alpha: 0.25)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  testName,
                  style: theme.textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: statusColor.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Text(
                  statusLabel,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: statusColor,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          SizedBox(
            height: 90,
            child: CustomPaint(
              painter: GaugeChartPainter(
                value: value.clamp(axisMin, axisMax),
                min: axisMin,
                max: axisMax,
                refLow: range.low,
                refHigh: range.high,
                lowColor: Colors.red.shade400,
                okColor: Colors.green.shade500,
                highColor: Colors.red.shade400,
                trackColor: scheme.onSurface.withValues(alpha: 0.08),
                needleColor: scheme.onSurface,
              ),
            ),
          ),
          const SizedBox(height: 6),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                '${range.low} ${unit ?? ''}',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.hintColor,
                ),
              ),
              Column(
                children: [
                  Text(
                    _fmt(value) + (unit != null ? ' $unit' : ''),
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.bold,
                      color: statusColor,
                    ),
                  ),
                  if (previousValue != null)
                    _trendChip(theme, previousValue!, value, unit),
                ],
              ),
              Text(
                '${range.high} ${unit ?? ''}',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.hintColor,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _trendChip(ThemeData theme, double prev, double curr, String? unit) {
    final diff = curr - prev;
    if (diff.abs() < 0.01) {
      return Text(
        'unchanged',
        style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor),
      );
    }
    final up = diff > 0;
    // Direction is "bad" if higher-is-bad and value went up, or lower-is-bad and value went down.
    final bad = higherIsBad ? up : !up;
    final color = bad ? Colors.red.shade600 : Colors.green.shade600;
    final arrow = up ? Icons.arrow_upward : Icons.arrow_downward;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(arrow, size: 12, color: color),
        const SizedBox(width: 2),
        Text(
          '${_fmt(diff.abs())} vs last',
          style: theme.textTheme.bodySmall?.copyWith(color: color),
        ),
      ],
    );
  }

  static String _fmt(double v) {
    if (v == v.roundToDouble()) return v.toStringAsFixed(0);
    return v.toStringAsFixed(1);
  }
}
