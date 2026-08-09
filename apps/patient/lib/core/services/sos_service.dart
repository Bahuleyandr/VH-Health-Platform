/// Re-export core's SOS functionality.
///
/// Provides [triggerSOS] and [SosButton] from vhhealth_core.
/// Legacy [SOSService.triggerSOS] is kept as a thin wrapper for
/// backward compatibility with existing call sites.
library;

import 'package:flutter/material.dart';
import 'package:vhhealth/core/services/sos_api_service.dart';
import 'package:vhhealth/core/widgets/live_region_snack_bar.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth_core/widgets/sos_button.dart' as core;

export 'package:vhhealth_core/widgets/sos_button.dart'
    show triggerSOS, SosButton, kSosEmergencyNumber;

/// Legacy wrapper — existing patient screens call [SOSService.triggerSOS].
class SOSService {
  static const String emergencyNumber = core.kSosEmergencyNumber;
  static SosTrigger? _debugTriggerOverride;

  @visibleForTesting
  static void debugSetTriggerOverride(SosTrigger? trigger) {
    _debugTriggerOverride = trigger;
  }

  static Future<void> triggerSOS([BuildContext? ctx]) {
    final trigger = _debugTriggerOverride ?? core.triggerSOS;
    return trigger(ctx);
  }

  static Future<void> triggerWithFeedback(BuildContext context) async {
    final l10n = AppLocalizations.of(context)!;
    // Progress feedback only — do NOT claim success before the SOS call has
    // actually completed. Confirmation is shown after the await below.
    _showSnackBar(context, l10n.authSosSending);

    try {
      await triggerSOS(context);
      if (!context.mounted) return;
      _showSnackBar(context, l10n.authSosTriggered);
    } on SosException catch (e) {
      if (!context.mounted) return;
      _showSnackBar(context, e.message);
    } catch (_) {
      if (!context.mounted) return;
      _showSnackBar(context, l10n.networkError);
    }
  }

  static void _showSnackBar(BuildContext context, String message) {
    if (!context.mounted) return;
    final colorScheme = Theme.of(context).colorScheme;
    final messenger = ScaffoldMessenger.of(context);
    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(
      LiveRegionSnackBar.build(
        message: message,
        announcementPrefix: 'SOS',
        backgroundColor: colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ),
    );
  }
}

typedef SosTrigger = Future<void> Function([BuildContext? ctx]);
