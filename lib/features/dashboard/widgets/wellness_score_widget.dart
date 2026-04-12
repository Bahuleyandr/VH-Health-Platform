// lib/features/dashboard/widgets/wellness_score_widget.dart
//
// Animated 0-100 wellness ring shown at the top of the dashboard. Data is
// served by GET /gamification/wellness-score (see wellnessService.js).
//
// The widget:
//   • fetches the score once on mount (cache-first via ApiClient.cachedGet)
//   • animates the ring from 0 to the current value on load
//   • expands to reveal a per-dimension breakdown when tapped

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/widgets/health_charts.dart';

class WellnessScoreWidget extends StatefulWidget {
  const WellnessScoreWidget({super.key});

  @override
  State<WellnessScoreWidget> createState() => _WellnessScoreWidgetState();
}

class _WellnessScoreWidgetState extends State<WellnessScoreWidget>
    with SingleTickerProviderStateMixin {
  late final AnimationController _anim;
  bool _expanded = false;
  bool _loading = true;
  Map<String, dynamic>? _data;

  @override
  void initState() {
    super.initState();
    _anim = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1200),
    );
    _load();
  }

  @override
  void dispose() {
    _anim.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final res = await ApiClient.get('/gamification/wellness-score');
      if (!mounted) return;
      if (res.isSuccess) {
        setState(() {
          _data = res.dataAsMap();
          _loading = false;
        });
        _anim.forward(from: 0);
      } else {
        setState(() => _loading = false);
      }
    } catch (e) {
      if (kDebugMode) debugPrint('WellnessScoreWidget: load error: $e');
      if (mounted) setState(() => _loading = false);
    }
  }

  Color _bandColor(ThemeData theme, String band) {
    switch (band) {
      case 'excellent':
        return Colors.green.shade600;
      case 'good':
        return Colors.amber.shade700;
      default:
        return Colors.red.shade600;
    }
  }

  String _bandLabel(String band) {
    switch (band) {
      case 'excellent':
        return "You're doing great";
      case 'good':
        return 'Keep it up';
      default:
        return 'Some attention needed';
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    if (_loading) {
      return _skeleton(theme);
    }
    if (_data == null) {
      return const SizedBox.shrink();
    }

    final score = (_data!['score'] as num?)?.toInt() ?? 0;
    final band = (_data!['band'] as String?) ?? 'needs_attention';
    final dims = (_data!['dimensions'] as List?) ?? const [];
    final color = _bandColor(theme, band);

    return GestureDetector(
      onTap: () => setState(() => _expanded = !_expanded),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 250),
        margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: theme.cardColor,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: color.withOpacity(0.3), width: 1.2),
          boxShadow: [
            BoxShadow(
              color: color.withOpacity(0.08),
              blurRadius: 12,
              offset: const Offset(0, 4),
            ),
          ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                AnimatedBuilder(
                  animation: _anim,
                  builder: (context, _) {
                    final progress = (score / 100) * _anim.value;
                    return SizedBox(
                      width: 84,
                      height: 84,
                      child: CustomPaint(
                        painter: RingProgressPainter(
                          progress: progress,
                          color: color,
                          backgroundColor: color.withOpacity(0.12),
                          strokeWidth: 8,
                        ),
                        child: Center(
                          child: Text(
                            '${(score * _anim.value).round()}',
                            style: theme.textTheme.headlineSmall?.copyWith(
                              fontWeight: FontWeight.bold,
                              color: color,
                            ),
                          ),
                        ),
                      ),
                    );
                  },
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Wellness Score',
                        style: theme.textTheme.titleMedium?.copyWith(
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        _bandLabel(band),
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: theme.hintColor,
                        ),
                      ),
                      const SizedBox(height: 6),
                      Row(
                        children: [
                          Icon(
                            _expanded ? Icons.expand_less : Icons.expand_more,
                            size: 16,
                            color: theme.hintColor,
                          ),
                          const SizedBox(width: 4),
                          Text(
                            _expanded ? 'Hide breakdown' : 'Show breakdown',
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: theme.hintColor,
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),
            if (_expanded) ...[
              const Divider(height: 24),
              for (final dim in dims) _dimensionBar(theme, dim as Map),
            ],
          ],
        ),
      ),
    );
  }

  Widget _dimensionBar(ThemeData theme, Map dim) {
    final label = dim['label'] ?? '';
    final s = (dim['score'] as num?)?.toInt() ?? 0;
    final m = (dim['max'] as num?)?.toInt() ?? 20;
    final ratio = m > 0 ? (s / m).clamp(0.0, 1.0) : 0.0;
    final color = ratio >= 0.8
        ? Colors.green.shade600
        : ratio >= 0.5
            ? Colors.amber.shade700
            : Colors.red.shade600;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(label, style: theme.textTheme.bodyMedium),
              Text('$s / $m',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.hintColor,
                    fontWeight: FontWeight.w600,
                  )),
            ],
          ),
          const SizedBox(height: 4),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: ratio,
              minHeight: 6,
              backgroundColor: color.withOpacity(0.12),
              valueColor: AlwaysStoppedAnimation(color),
            ),
          ),
        ],
      ),
    );
  }

  Widget _skeleton(ThemeData theme) {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: theme.cardColor,
        borderRadius: BorderRadius.circular(18),
      ),
      child: Row(
        children: [
          Container(
            width: 84,
            height: 84,
            decoration: BoxDecoration(
              color: theme.hintColor.withOpacity(0.12),
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  height: 14,
                  width: 120,
                  color: theme.hintColor.withOpacity(0.12),
                ),
                const SizedBox(height: 8),
                Container(
                  height: 10,
                  width: 160,
                  color: theme.hintColor.withOpacity(0.08),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
