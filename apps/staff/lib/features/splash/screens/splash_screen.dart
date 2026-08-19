import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:vhhealth_core/services/device_integrity_service.dart';
import 'package:vhhealth_core/utils/safe_url_launcher.dart';

import '../../../core/config/api_config.dart';
import '../../../core/services/minimum_version_gate_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../l10n/app_strings.dart';

class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen> {
  bool _blocked = false;
  MinimumVersionGateResult? _minimumVersionBlock;

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

    // Minimum-version gate — a retired build must never reach clinical
    // surfaces. Fails OPEN when `/config` is unreachable (see
    // MinimumVersionGateService for the posture rationale).
    final version = await MinimumVersionGateService.check();
    if (version.updateRequired) {
      if (mounted) setState(() => _minimumVersionBlock = version);
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

  Future<void> _openReleaseForUpdate() async {
    final block = _minimumVersionBlock;
    // No configured release URL (e.g. no iOS distribution channel exists) —
    // there is nothing to open; the update screen hides its CTA instead.
    if (block == null || !block.hasReleaseUrl) return;
    await SafeUrlLauncher.launch(
      block.releaseUrl,
      mode: LaunchMode.externalApplication,
    );
  }

  @override
  Widget build(BuildContext context) {
    final minimumVersionBlock = _minimumVersionBlock;
    if (minimumVersionBlock != null) {
      return _UpdateRequiredScreen(
        onUpdate: _openReleaseForUpdate,
        hasReleaseUrl: minimumVersionBlock.hasReleaseUrl,
      );
    }

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

class _UpdateRequiredScreen extends StatelessWidget {
  const _UpdateRequiredScreen({
    required this.onUpdate,
    required this.hasReleaseUrl,
  });

  final VoidCallback onUpdate;

  /// False when no release URL is configured for this platform. The block
  /// still stands — only the CTA changes: a button that silently does nothing
  /// must never be shown to a hard-blocked staff member, so static copy
  /// points at the hospital's IT distribution channel instead.
  final bool hasReleaseUrl;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final theme = Theme.of(context);
    return PopScope(
      canPop: false,
      child: Scaffold(
        backgroundColor: AppTheme.backgroundGrey,
        body: SafeArea(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 28),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 420),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(
                      Icons.system_update_alt,
                      size: 72,
                      color: Color(0xFF1565C0),
                    ),
                    const SizedBox(height: 28),
                    Text(
                      s.splashUpdateRequiredTitle,
                      textAlign: TextAlign.center,
                      style: theme.textTheme.headlineSmall?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      s.splashUpdateRequiredBody,
                      textAlign: TextAlign.center,
                      style: theme.textTheme.bodyLarge,
                    ),
                    const SizedBox(height: 28),
                    if (hasReleaseUrl)
                      SizedBox(
                        width: double.infinity,
                        child: ElevatedButton.icon(
                          onPressed: onUpdate,
                          icon: const Icon(Icons.open_in_new),
                          label: Text(s.splashUpdateRequiredButton),
                          style: ElevatedButton.styleFrom(
                            minimumSize: const Size.fromHeight(52),
                          ),
                        ),
                      )
                    else
                      Text(
                        s.splashUpdateRequiredNoUrlBody,
                        textAlign: TextAlign.center,
                        style: theme.textTheme.bodyMedium,
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
