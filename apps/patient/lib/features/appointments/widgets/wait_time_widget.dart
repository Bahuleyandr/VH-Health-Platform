import 'package:flutter/material.dart';
import 'package:vhhealth/core/services/api_client.dart';

class WaitTimeWidget extends StatefulWidget {
  final int appointmentId;
  const WaitTimeWidget({super.key, required this.appointmentId});
  @override
  State<WaitTimeWidget> createState() => _WaitTimeWidgetState();
}

class _WaitTimeWidgetState extends State<WaitTimeWidget> {
  Map<String, dynamic>? _waitData;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _fetchWaitTime();
  }

  Future<void> _fetchWaitTime() async {
    try {
      final resp = await ApiClient.get(
        '/appointments/${widget.appointmentId}/wait-time',
      );
      if (mounted && resp.isSuccess) {
        setState(() {
          _waitData = resp.dataAsMap();
          _loading = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const SizedBox(
        height: 60,
        child: Center(child: CircularProgressIndicator()),
      );
    }
    if (_waitData == null) return const SizedBox.shrink();

    final ahead = _waitData!['patientsAhead'] ?? 0;
    final waitMin = _waitData!['estimatedWaitMinutes'] ?? 0;
    final theme = Theme.of(context);

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            Icon(
              Icons.timer_outlined,
              color: theme.colorScheme.primary,
              size: 32,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '$ahead patients ahead',
                    style: theme.textTheme.titleSmall,
                  ),
                  Text(
                    'Estimated wait: ~$waitMin minutes',
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
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
}
