import 'dart:async';

import 'package:flutter/material.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';

import '../../l10n/app_strings.dart';

typedef OnlineOnlyActionWidgetBuilder =
    Widget Function(BuildContext context, bool isOnline, String offlineMessage);

class OnlineOnlyActionState extends StatelessWidget {
  const OnlineOnlyActionState({super.key, required this.builder});

  final OnlineOnlyActionWidgetBuilder builder;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: ConnectivitySyncService.instance,
      builder: (context, _) {
        final isOnline = ConnectivitySyncService.instance.isOnline;
        return builder(
          context,
          isOnline,
          AppStrings.of(context).onlineOnlyActionMessage,
        );
      },
    );
  }
}

abstract final class OnlineOnlyActionGuard {
  static bool get isOnline => ConnectivitySyncService.instance.isOnline;

  static bool require(BuildContext context, {String? message}) {
    if (isOnline) return true;
    final strings = AppStrings.of(context);
    if (!context.mounted) return false;
    unawaited(
      showDialog<void>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          icon: const Icon(Icons.cloud_off_outlined),
          title: Text(strings.onlineOnlyActionTitle),
          content: Text(message ?? strings.onlineOnlyActionMessage),
          actions: [
            FilledButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: Text(strings.actionClose),
            ),
          ],
        ),
      ),
    );
    return false;
  }
}
