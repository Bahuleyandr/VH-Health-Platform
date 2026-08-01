// lib/core/widgets/offline_banner.dart
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:vhhealth/core/outage/patient_outage_controller.dart';
import 'package:vhhealth/generated/app_localizations.dart';

/// A banner that appears at the top of the screen when the device is offline.
///
/// Listens to [ConnectivityService.onChange] and shows/hides automatically.
/// Can also display a "last updated X min ago" label for stale data.
class OfflineBanner extends StatefulWidget {
  /// Optional label shown alongside the offline indicator (e.g., "Updated 5 min ago").
  final String? staleLabel;
  final DateTime? cachedAt;

  const OfflineBanner({super.key, this.staleLabel, this.cachedAt});

  @override
  State<OfflineBanner> createState() => _OfflineBannerState();
}

class _OfflineBannerState extends State<OfflineBanner> {
  late final PatientOutageController _controller;

  @override
  void initState() {
    super.initState();
    _controller = PatientOutageController.instance..addListener(_onChange);
  }

  @override
  void dispose() {
    _controller.removeListener(_onChange);
    super.dispose();
  }

  void _onChange() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final isUnavailable = _controller.isOutage || _controller.isChecking;
    if (!isUnavailable &&
        widget.cachedAt == null &&
        widget.staleLabel == null) {
      return const SizedBox.shrink();
    }

    final theme = Theme.of(context);
    final l = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).toLanguageTag();
    final timestamp = widget.cachedAt == null
        ? null
        : DateFormat.yMMMd(locale).add_jm().format(widget.cachedAt!.toLocal());
    final label = timestamp == null
        ? (isUnavailable ? l.patientOutageCacheUnavailable : widget.staleLabel)
        : l.patientOutageCachedAt(timestamp);

    if (isUnavailable) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        color: theme.colorScheme.errorContainer,
        child: Row(
          children: [
            Icon(
              Icons.cloud_off,
              size: 16,
              color: theme.colorScheme.onErrorContainer,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                label ?? l.patientOutageCacheUnavailable,
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
    if (label != null) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
        color: theme.colorScheme.surfaceContainerHighest,
        child: Text(
          label,
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      );
    }

    return const SizedBox.shrink();
  }
}
