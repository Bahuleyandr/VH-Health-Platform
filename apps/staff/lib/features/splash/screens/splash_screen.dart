import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth_core/services/device_integrity_service.dart';

import '../../../core/config/api_config.dart';
import '../../../core/theme/app_theme.dart';
import '../../../l10n/app_strings.dart';

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
    final s = AppStrings.of(context);
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) {
        final ds = AppStrings.of(ctx);
        return AlertDialog(
          title: Text(ds.splashDeviceUnsupportedTitle),
          content: Text(
            s.splashDeviceUnsupportedBody(integrity.reasons.join(', ')),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: Text(ds.actionClose),
            ),
          ],
        );
      },
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
    final s = AppStrings.of(context);
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
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
            Text(
              s.splashAppTitle,
              style: const TextStyle(
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
