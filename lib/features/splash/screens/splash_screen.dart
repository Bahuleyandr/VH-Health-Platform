import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth_core/services/device_integrity_service.dart';
import '../../../core/config/api_config.dart';

class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen> {
  bool _blocked = false;

  @override
  void initState() {
    super.initState();
    _navigate();
  }

  Future<void> _showIntegrityBlocker(DeviceIntegrityResult integrity) async {
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        title: const Text('Device not supported'),
        content: Text(
          'For patient data safety, VHHealth Staff cannot run on this device. '
          'Reason: ${integrity.reasons.join(', ')}. '
          'Please use a hospital-issued, unmodified device.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Close'),
          ),
        ],
      ),
    );
  }

  Future<void> _navigate() async {
    // Device integrity gate — must run before any auth decision.
    final integrity = await DeviceIntegrityService.check();
    if (integrity.shouldBlock) {
      if (mounted) setState(() => _blocked = true);
      await _showIntegrityBlocker(integrity);
      return;
    }

    // Small delay so it doesn't flash
    await Future.delayed(const Duration(milliseconds: 1500));
    if (!mounted) return;

    final loggedIn = await ApiConfig.isLoggedIn();
    if (!mounted) return;

    if (loggedIn) {
      context.go('/dashboard');
    } else {
      context.go('/login');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(
              Icons.local_hospital,
              size: 80,
              color: Color(0xFF1565C0),
            ),
            const SizedBox(height: 16),
            const Text(
              'VHHealth Staff',
              style: TextStyle(
                fontSize: 24,
                fontWeight: FontWeight.bold,
                color: Color(0xFF1565C0),
              ),
            ),
            const SizedBox(height: 32),
            if (_blocked)
              const Icon(Icons.block, color: Colors.red, size: 36)
            else
              const CircularProgressIndicator(),
          ],
        ),
      ),
    );
  }
}
