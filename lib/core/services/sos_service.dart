/// Re-export core's SOS functionality.
///
/// Provides [triggerSOS] and [SosButton] from vhhealth_core.
/// Legacy [SOSService.triggerSOS] is kept as a thin wrapper for
/// backward compatibility with existing call sites.
import 'package:flutter/material.dart';
import 'package:vhhealth_core/widgets/sos_button.dart' as core;

export 'package:vhhealth_core/widgets/sos_button.dart' show triggerSOS, SosButton, kSosEmergencyNumber;

/// Legacy wrapper — existing patient screens call [SOSService.triggerSOS].
class SOSService {
  static const String emergencyNumber = core.kSosEmergencyNumber;

  static Future<void> triggerSOS([BuildContext? ctx]) => core.triggerSOS(ctx);
}
