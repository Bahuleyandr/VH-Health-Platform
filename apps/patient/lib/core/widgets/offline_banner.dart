// lib/core/widgets/offline_banner.dart
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:vhhealth/core/services/connectivity_service.dart';

/// A banner that appears at the top of the screen when the device is offline.
///
/// Listens to [ConnectivityService.onChange] and shows/hides automatically.
/// Can also display a "last updated X min ago" label for stale data.
class OfflineBanner extends StatefulWidget {
  /// Optional label shown alongside the offline indicator (e.g., "Updated 5 min ago").
  final String? staleLabel;

  const OfflineBanner({super.key, this.staleLabel});

  @override
  State<OfflineBanner> createState() => _OfflineBannerState();
}

class _OfflineBannerState extends State<OfflineBanner> {
  late bool _isOffline;
  StreamSubscription<bool>? _sub;

  @override
  void initState() {
    super.initState();
    _isOffline = !ConnectivityService.isOnline;
    _sub = ConnectivityService.onChange.listen((isOnline) {
      if (mounted) {
        setState(() => _isOffline = !isOnline);
      }
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!_isOffline && widget.staleLabel == null) {
      return const SizedBox.shrink();
    }

    final theme = Theme.of(context);

    if (_isOffline) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        color: theme.colorScheme.errorContainer,
        child: Row(
          children: [
            Icon(Icons.cloud_off, size: 16, color: theme.colorScheme.onErrorContainer),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                widget.staleLabel != null
                    ? 'You\'re offline · Showing cached data (${widget.staleLabel})'
                    : 'You\'re offline',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onErrorContainer,
                ),
              ),
            ),
          ],
        ),
      );
    }

    // Online but showing stale label (data is from cache, network refresh pending)
    if (widget.staleLabel != null) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
        color: theme.colorScheme.surfaceContainerHighest,
        child: Text(
          'Last updated ${widget.staleLabel}',
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      );
    }

    return const SizedBox.shrink();
  }
}
