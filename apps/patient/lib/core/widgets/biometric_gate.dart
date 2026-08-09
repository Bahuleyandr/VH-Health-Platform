// lib/core/widgets/biometric_gate.dart
//
// FL-H1 (2026-08-09 hygiene audit): BiometricGateService.requireAuth existed
// (and was hardened fail-closed by audit M11) but was never invoked anywhere,
// so the "extra lock" a patient enabled in Settings protected nothing. This
// widget is the wiring: wrap a sensitive surface's build output and the
// subtree is not built until the gate grants access.
//
// Fail-closed semantics are inherited from BiometricGateService.requireAuth:
// gate disabled -> allow; sensor unavailable / error / cancelled -> DENY,
// showing a locked pane with a retry button instead of the PHI.

import 'package:flutter/material.dart';
import 'package:vhhealth/core/services/biometric_gate_service.dart';
import 'package:vhhealth/generated/app_localizations.dart';

/// Signature of the auth check — matches [BiometricGateService.requireAuth].
typedef BiometricAuthCheck = Future<bool> Function(String reason);

/// Gates [builder] behind biometric re-authentication.
///
/// The child subtree is only built after [authCheck] returns true, so PHI
/// widgets (and their network fetches) never run behind the lock pane.
///
/// A short static grace window (default 2 minutes) lets hub -> detail
/// navigation inside the same gated area proceed without prompting the
/// patient twice back-to-back.
class BiometricGate extends StatefulWidget {
  const BiometricGate({
    super.key,
    required this.builder,
    this.reason,
    this.authCheck,
  });

  /// Builds the protected subtree once access is granted.
  final WidgetBuilder builder;

  /// OS biometric-prompt reason. Defaults to the localized
  /// "unlock to view your medical records" copy.
  final String? reason;

  /// Injectable for tests; defaults to [debugDefaultAuthCheckOverride] if
  /// set, then [BiometricGateService.requireAuth].
  final BiometricAuthCheck? authCheck;

  /// Test seam for screens that embed a [BiometricGate] internally (so their
  /// widget tests can't pass [authCheck]). Production code must never set
  /// this. When null, the real fail-closed service check runs.
  @visibleForTesting
  static BiometricAuthCheck? debugDefaultAuthCheckOverride;

  /// How long a successful unlock suppresses re-prompting in OTHER gates
  /// (e.g. records hub -> consultation-note detail push).
  @visibleForTesting
  static Duration unlockGraceWindow = const Duration(minutes: 2);

  static DateTime? _lastUnlockAt;

  @visibleForTesting
  static void debugResetUnlockState() => _lastUnlockAt = null;

  @override
  State<BiometricGate> createState() => _BiometricGateState();
}

enum _GateState { checking, granted, denied }

class _BiometricGateState extends State<BiometricGate> {
  _GateState _state = _GateState.checking;

  @override
  void initState() {
    super.initState();
    // Post-frame so localized copy (Localizations of context) is available
    // when the check needs the default reason.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _runCheck();
    });
  }

  Future<void> _runCheck() async {
    final last = BiometricGate._lastUnlockAt;
    if (last != null &&
        DateTime.now().difference(last) < BiometricGate.unlockGraceWindow) {
      setState(() => _state = _GateState.granted);
      return;
    }
    setState(() => _state = _GateState.checking);
    final reason =
        widget.reason ?? AppLocalizations.of(context)!.biometricGateReason;
    final check =
        widget.authCheck ??
        BiometricGate.debugDefaultAuthCheckOverride ??
        BiometricGateService.requireAuth;
    bool granted;
    try {
      granted = await check(reason);
    } catch (_) {
      granted = false; // fail closed, mirroring the service (M11)
    }
    if (!mounted) return;
    if (granted) BiometricGate._lastUnlockAt = DateTime.now();
    setState(() => _state = granted ? _GateState.granted : _GateState.denied);
  }

  @override
  Widget build(BuildContext context) {
    switch (_state) {
      case _GateState.granted:
        return widget.builder(context);
      case _GateState.checking:
        return const Scaffold(body: Center(child: CircularProgressIndicator()));
      case _GateState.denied:
        final l10n = AppLocalizations.of(context)!;
        return Scaffold(
          body: Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.lock_outline, size: 56),
                  const SizedBox(height: 16),
                  Text(
                    l10n.biometricGateLockedTitle,
                    style: Theme.of(context).textTheme.titleMedium,
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    l10n.biometricGateLockedMessage,
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 24),
                  ElevatedButton.icon(
                    onPressed: _runCheck,
                    icon: const Icon(Icons.fingerprint),
                    label: Text(l10n.biometricGateUnlockButton),
                  ),
                ],
              ),
            ),
          ),
        );
    }
  }
}
