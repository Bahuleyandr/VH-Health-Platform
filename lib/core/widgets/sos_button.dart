import 'package:flutter/material.dart';
import 'package:vhhealth_core/widgets/sos_button.dart' as core;
import '../theme/app_theme.dart';

/// Staff-specific SOS button — animated AppBar icon that triggers
/// the shared SOS flow from vhhealth_core after a confirmation dialog.
class SosButton extends StatefulWidget {
  const SosButton({super.key});

  @override
  State<SosButton> createState() => _SosButtonState();
}

class _SosButtonState extends State<SosButton>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _scaleAnim;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      duration: const Duration(milliseconds: 800),
      vsync: this,
    )..repeat(reverse: true);
    _scaleAnim = Tween<double>(begin: 1.0, end: 1.15).animate(
      CurvedAnimation(parent: _controller, curve: Curves.easeInOut),
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _triggerSos(BuildContext context) {
    showDialog(
      context: context,
      builder: (_) => AlertDialog(
        title: const Row(
          children: [
            Icon(Icons.emergency, color: AppTheme.errorRed),
            SizedBox(width: 8),
            Text('Emergency SOS'),
          ],
        ),
        content: const Text(
          'This will alert the emergency response team immediately.\n\nProceed?',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AppTheme.errorRed),
            onPressed: () {
              Navigator.pop(context);
              // Trigger core SOS flow (location + backend + dialer)
              core.triggerSOS(context);
            },
            child: const Text('Send Alert'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: ScaleTransition(
        scale: _scaleAnim,
        child: IconButton(
          onPressed: () => _triggerSos(context),
          icon: const Icon(Icons.emergency, color: Colors.red),
          tooltip: 'Emergency SOS',
          style: IconButton.styleFrom(
            backgroundColor: Colors.red.withOpacity(0.15),
          ),
        ),
      ),
    );
  }
}
