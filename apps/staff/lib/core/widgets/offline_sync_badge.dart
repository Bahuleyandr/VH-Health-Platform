import 'package:flutter/material.dart';
import 'package:vhhealth_core/widgets/offline_sync_badge.dart' as core;

import '../config/api_config.dart';
import '../../l10n/app_strings.dart';

export 'package:vhhealth_core/widgets/offline_sync_badge.dart'
    hide OfflineSyncBadge;

core.OfflineSyncTextResolver _staffTextResolver(BuildContext context) {
  final strings = AppStrings.of(context);
  return (key, values) => strings.format(key, values);
}

/// Staff-localized wrapper around the shared offline reconciliation badge.
class OfflineSyncBadge extends StatelessWidget {
  const OfflineSyncBadge({super.key});

  @override
  Widget build(BuildContext context) {
    return core.OfflineSyncBadge(
      textResolver: _staffTextResolver(context),
      actorUidResolver: ApiConfig.getStaffUid,
    );
  }
}

/// Opens the same localized review sheet as the Staff app-bar badge.
Future<void> showStaffSyncStatusSheet(BuildContext context) {
  return core.showSyncStatusSheet(
    context,
    textResolver: _staffTextResolver(context),
    actorUidResolver: ApiConfig.getStaffUid,
  );
}
