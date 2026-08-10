import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../l10n/app_strings.dart';
import '../providers/session_timeout_provider.dart';
import '../theme/app_theme.dart';
import 'logout_flow.dart';

class SessionTimeoutWarningLayer extends StatefulWidget {
  const SessionTimeoutWarningLayer({super.key, required this.child});

  final Widget child;

  @override
  State<SessionTimeoutWarningLayer> createState() =>
      _SessionTimeoutWarningLayerState();
}

class _SessionTimeoutWarningLayerState
    extends State<SessionTimeoutWarningLayer> {
  bool _navigatedForExpiry = false;

  @override
  Widget build(BuildContext context) {
    return Consumer<SessionTimeoutProvider>(
      builder: (context, timeout, _) {
        if (timeout.isSessionExpired) {
          if (!_navigatedForExpiry) {
            _navigatedForExpiry = true;
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (!mounted) return;
              // Idle timeout is a logout path: stop the realtime poll
              // providers (the timeout cleanup itself already revoked the
              // session and closed the WebSocket) before landing on /login.
              stopStaffRealtimePollers(context);
              context.go('/login');
            });
          }
        } else {
          _navigatedForExpiry = false;
        }

        return Stack(
          children: [
            widget.child,
            if (timeout.isWarningVisible && !timeout.isSessionExpired)
              _SessionTimeoutBanner(timeout: timeout),
          ],
        );
      },
    );
  }
}

class _SessionTimeoutBanner extends StatelessWidget {
  const _SessionTimeoutBanner({required this.timeout});

  final SessionTimeoutProvider timeout;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Positioned(
      left: 16,
      right: 16,
      top: 12,
      child: SafeArea(
        child: Material(
          elevation: 8,
          borderRadius: BorderRadius.circular(8),
          color: Colors.orange.shade50,
          child: Container(
            constraints: const BoxConstraints(minHeight: 64),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: AppTheme.warningAmber),
            ),
            child: Row(
              children: [
                Icon(Icons.timer_outlined, color: AppTheme.warningOnSurface),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    s.sessionTimeoutWarning(timeout.warningSecondsRemaining),
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: AppTheme.textPrimary,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                TextButton.icon(
                  onPressed: timeout.extendSession,
                  icon: const Icon(Icons.touch_app_outlined),
                  label: Text(s.sessionTimeoutStillHere),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
