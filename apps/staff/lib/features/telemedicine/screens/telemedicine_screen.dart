import 'package:flutter/material.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';

/// Telemedicine video consultation screen.
///
/// **Integration status**: Stub — requires a WebRTC or video SDK before
/// real-time video calls can work.
///
/// **Recommended next steps**:
/// 1. Add `agora_rtc_engine` or `flutter_webrtc` dependency to pubspec.yaml
/// 2. Create a backend endpoint to provision room/token
///    (e.g., POST /api/v1/consultations/:id/video-session)
/// 3. Implement the join/leave flow in this screen
/// 4. Add push notification trigger to alert the patient when the doctor starts
class TelemedicineScreen extends StatefulWidget {
  final String consultationId;
  final String patientName;

  const TelemedicineScreen({
    super.key,
    required this.consultationId,
    required this.patientName,
  });

  @override
  State<TelemedicineScreen> createState() => _TelemedicineScreenState();
}

class _TelemedicineScreenState extends State<TelemedicineScreen> {
  bool _cameraOn = true;
  bool _micOn = true;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = AppStrings.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text('${s.telemedicineTitlePrefix} ${widget.patientName}'),
        actions: const [LogoutAction()],
        backgroundColor: theme.colorScheme.primary,
        foregroundColor: theme.colorScheme.onPrimary,
      ),
      body: Column(
        children: [
          // Remote video placeholder
          Expanded(
            flex: 3,
            child: Container(
              color: Colors.black87,
              child: Center(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      Icons.videocam_off,
                      size: 64,
                      color: Colors.grey.shade600,
                    ),
                    const SizedBox(height: 16),
                    Text(
                      s.telemedicineSdkMissingTitle,
                      style: theme.textTheme.titleMedium?.copyWith(
                        color: Colors.grey.shade400,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      s.telemedicineSdkMissingBody,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: Colors.grey.shade500,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          // Local video preview placeholder
          Expanded(
            flex: 1,
            child: Container(
              color: Colors.black54,
              child: Center(
                child: Icon(
                  _cameraOn ? Icons.person : Icons.videocam_off,
                  size: 48,
                  color: Colors.grey.shade500,
                ),
              ),
            ),
          ),
          // Controls
          Container(
            padding: const EdgeInsets.symmetric(vertical: 16),
            color: theme.colorScheme.surface,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceEvenly,
              children: [
                _ControlButton(
                  icon: _micOn ? Icons.mic : Icons.mic_off,
                  label: _micOn ? s.telemedicineMute : s.telemedicineUnmute,
                  onTap: () => setState(() => _micOn = !_micOn),
                ),
                _ControlButton(
                  icon: _cameraOn ? Icons.videocam : Icons.videocam_off,
                  label: _cameraOn
                      ? s.telemedicineCameraOff
                      : s.telemedicineCameraOn,
                  onTap: () => setState(() => _cameraOn = !_cameraOn),
                ),
                _ControlButton(
                  icon: Icons.call_end,
                  label: s.telemedicineEndCall,
                  color: Colors.red,
                  onTap: () => Navigator.of(context).pop(),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ControlButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final Color? color;

  const _ControlButton({
    required this.icon,
    required this.label,
    required this.onTap,
    this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        IconButton(
          onPressed: onTap,
          icon: Icon(icon, size: 28),
          color: color ?? Theme.of(context).colorScheme.primary,
          style: IconButton.styleFrom(
            backgroundColor: (color ?? Theme.of(context).colorScheme.primary)
                .withAlpha(25),
            padding: const EdgeInsets.all(12),
          ),
        ),
        const SizedBox(height: 4),
        Text(label, style: Theme.of(context).textTheme.labelSmall),
      ],
    );
  }
}
