import 'package:permission_handler/permission_handler.dart';

enum TeleconsultReadinessKind { videoReady, audioOnlyRecommended, unavailable }

class TeleconsultDeviceReadiness {
  const TeleconsultDeviceReadiness({
    required this.kind,
    required this.cameraGranted,
    required this.microphoneGranted,
  });

  final TeleconsultReadinessKind kind;
  final bool cameraGranted;
  final bool microphoneGranted;

  bool get canContinue => microphoneGranted;
}

abstract class TeleconsultDeviceService {
  Future<TeleconsultDeviceReadiness> checkReadiness();
}

class PermissionHandlerTeleconsultDeviceService
    implements TeleconsultDeviceService {
  const PermissionHandlerTeleconsultDeviceService();

  @override
  Future<TeleconsultDeviceReadiness> checkReadiness() async {
    final statuses = await <Permission>[
      Permission.camera,
      Permission.microphone,
    ].request();
    final camera = statuses[Permission.camera]?.isGranted ?? false;
    final mic = statuses[Permission.microphone]?.isGranted ?? false;
    final kind = switch ((camera, mic)) {
      (true, true) => TeleconsultReadinessKind.videoReady,
      (false, true) => TeleconsultReadinessKind.audioOnlyRecommended,
      _ => TeleconsultReadinessKind.unavailable,
    };
    return TeleconsultDeviceReadiness(
      kind: kind,
      cameraGranted: camera,
      microphoneGranted: mic,
    );
  }
}
