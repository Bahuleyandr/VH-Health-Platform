// lib/features/dashboard/widgets/health_insight_card.dart
//
// Smart insight cards shown on the dashboard. Backed by
// GET /gamification/insights which returns a prioritised list of cards the
// backend derived from vitals trends, appointment adherence, prescription
// countdowns, etc.

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'package:vhhealth/core/services/api_client.dart';

class HealthInsightsStrip extends StatefulWidget {
  const HealthInsightsStrip({super.key});

  @override
  State<HealthInsightsStrip> createState() => _HealthInsightsStripState();
}

class _HealthInsightsStripState extends State<HealthInsightsStrip> {
  List<Map<String, dynamic>>? _insights;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final res = await ApiClient.get(
        '/gamification/insights',
        queryParameters: const {'limit': '2'},
      );
      if (!mounted) return;
      if (res.isSuccess) {
        final list = (res.dataAsMap()['insights'] as List?) ?? const [];
        setState(() {
          _insights = list
              .whereType<Map>()
              .map((m) => Map<String, dynamic>.from(m))
              .toList();
          _loading = false;
        });
      } else {
        setState(() => _loading = false);
      }
    } catch (e) {
      if (kDebugMode) debugPrint('HealthInsightsStrip: $e');
      if (mounted) setState(() => _loading = false);
    }
  }

  IconData _iconFor(String type) {
    switch (type) {
      case 'refill_reminder':
        return Icons.medication_outlined;
      case 'vitals_nudge':
      case 'log_first_vitals':
        return Icons.favorite_outline;
      case 'appointment_adherence':
        return Icons.event_available_outlined;
      case 'checkin_streak':
        return Icons.local_fire_department_outlined;
      case 'sugar_stable':
      case 'sugar_improving':
        return Icons.trending_up;
      default:
        return Icons.lightbulb_outline;
    }
  }

  Color _accentFor(String type, ColorScheme scheme) {
    switch (type) {
      case 'refill_reminder':
        return Colors.orange.shade700;
      case 'vitals_nudge':
      case 'log_first_vitals':
        return scheme.primary;
      case 'checkin_streak':
      case 'sugar_improving':
        return Colors.green.shade600;
      default:
        return scheme.primary;
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading || _insights == null || _insights!.isEmpty) {
      return const SizedBox.shrink();
    }
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
      child: Column(
        children: [
          for (final i in _insights!) _card(context, i),
        ],
      ),
    );
  }

  Widget _card(BuildContext context, Map<String, dynamic> insight) {
    final theme = Theme.of(context);
    final type = insight['type'] as String? ?? '';
    final title = insight['title'] as String? ?? '';
    final message = insight['message'] as String? ?? '';
    final route = insight['actionRoute'] as String?;
    final accent = _accentFor(type, theme.colorScheme);

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(
        color: theme.cardColor,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: accent.withValues(alpha: 0.25)),
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: route == null || route.isEmpty
              ? null
              : () => context.push(route),
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: accent.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Icon(_iconFor(type), color: accent, size: 22),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(title,
                          style: theme.textTheme.titleSmall?.copyWith(
                            fontWeight: FontWeight.w600,
                          )),
                      const SizedBox(height: 2),
                      Text(message,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: theme.hintColor,
                          )),
                    ],
                  ),
                ),
                if (route != null && route.isNotEmpty)
                  Icon(Icons.chevron_right, color: theme.hintColor),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
