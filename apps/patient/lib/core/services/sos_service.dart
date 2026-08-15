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
    show
        triggerSOS,
        SosButton,
        SosBackendOutcome,
        SosTriggerResult,
        kSosEmergencyNumber;

/// Legacy wrapper — existing patient screens call [SOSService.triggerSOS].
class SOSService {
  static const String emergencyNumber = core.kSosEmergencyNumber;
  static SosTrigger? _debugTriggerOverride;

  @visibleForTesting
  static void debugSetTriggerOverride(SosTrigger? trigger) {
    _debugTriggerOverride = trigger;
  }

  /// The backend half of the SOS flow, routed through the THROWING
  /// [SosApiService.triggerAlert] client so a backend failure is observable
  /// (it used to be an unawaited fire-and-forget POST in core, which made
  /// every success toast unconditional).
  static Future<void> _postAlert({
    required String phone,
    double? latitude,
    double? longitude,
  }) => SosApiService.triggerAlert(
    phone: phone,
    latitude: latitude,
    longitude: longitude,
  );

  static Future<core.SosTriggerResult> triggerSOS([BuildContext? ctx]) {
    final trigger = _debugTriggerOverride ?? _coreTrigger;
    return trigger(ctx);
  }

  static Future<core.SosTriggerResult> _coreTrigger([BuildContext? ctx]) =>
      core.triggerSOS(ctx, _postAlert);

  static Future<void> triggerWithFeedback(BuildContext context) async {
    final l10n = AppLocalizations.of(context)!;
    // Progress feedback only — do NOT claim success before the SOS call has
    // actually completed. Confirmation is shown after the await below.
    _showSnackBar(context, l10n.authSosSending);

    try {
      final result = await triggerSOS(context);
      if (!context.mounted) return;
      switch (result.backendOutcome) {
        case core.SosBackendOutcome.reported:
          _showSnackBar(context, l10n.authSosTriggered);
        case core.SosBackendOutcome.skipped:
          // Guest / no stored phone: no alert was sent — never claim
          // "triggered". The dialer call is still the safety net.
          _showSnackBar(context, l10n.authSosGuestSkipped);
        case core.SosBackendOutcome.failed:
          final error = result.error;
          _showSnackBar(
            context,
            error is SosException ? error.message : l10n.authSosBackendFailed,
          );
      }
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

typedef SosTrigger =
    Future<core.SosTriggerResult> Function([BuildContext? ctx]);
