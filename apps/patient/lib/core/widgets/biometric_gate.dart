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

import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
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
    this.graceScopeKey,
    this.onGranted,
  });

  /// Builds the protected subtree once access is granted.
  final WidgetBuilder builder;

  /// OS biometric-prompt reason. Defaults to the localized
  /// "unlock to view your medical records" copy.
  final String? reason;

  /// Injectable for tests; defaults to [debugDefaultAuthCheckOverride] if
  /// set, then [BiometricGateService.requireAuth].
  final BiometricAuthCheck? authCheck;

  /// Explicit account scope for grace-window tests using an injected check.
  /// Production gates derive this from the signed-in Firebase user instead.
  @visibleForTesting
  final String? graceScopeKey;

  /// Runs after access is granted and before [builder] is exposed.
  /// Sensitive screens use this to defer their first data fetch until the
  /// biometric decision has completed.
  final VoidCallback? onGranted;

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
  static String? _lastUnlockScope;
  static Future<bool>? _inFlightCheck;
  static String? _inFlightCheckScope;
  static int _unlockGeneration = 0;
  static int _promptsInFlight = 0;

  /// True while any gate is awaiting its auth check — i.e. while the OS
  /// biometric prompt may be on screen. The prompt itself pushes the app to
  /// [AppLifecycleState.inactive], which must not be treated as the user
  /// backgrounding the app (see [didChangeAppLifecycleState]): clearing the
  /// unlock state mid-prompt bumps [_unlockGeneration], which discards the
  /// grant the prompt is about to return and wedges the gate in a
  /// prompt → inactive → cleared → re-prompt loop.
  static bool get _promptInFlight => _promptsInFlight > 0;

  /// Clears every in-memory biometric grant for this process.
  static void clearUnlockState() {
    _lastUnlockAt = null;
    _lastUnlockScope = null;
    _inFlightCheck = null;
    _inFlightCheckScope = null;
    _unlockGeneration++;
  }

  /// Invalidates process-wide unlock state when the app leaves the foreground,
  /// even if no biometric-gated route is currently mounted.
  static void handleAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.inactive:
        if (_promptInFlight) return;
        clearUnlockState();
      case AppLifecycleState.hidden:
      case AppLifecycleState.paused:
      case AppLifecycleState.detached:
        clearUnlockState();
      case AppLifecycleState.resumed:
        return;
    }
  }

  @visibleForTesting
  static void debugResetUnlockState() {
    clearUnlockState();
    // Test isolation only: a production clear must NOT zero the prompt
    // counter — an OS prompt may genuinely still be on screen, and its
    // paired decrement runs in _runCoordinatedCheck's finally.
    _promptsInFlight = 0;
  }

  @override
  State<BiometricGate> createState() => _BiometricGateState();
}

enum _GateState { checking, granted, denied }

class _BiometricGateState extends State<BiometricGate>
    with WidgetsBindingObserver {
  _GateState _state = _GateState.checking;
  bool _checkOnResume = false;
  bool _checkInFlight = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // Post-frame so localized copy (Localizations of context) is available
    // when the check needs the default reason.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _runCheck();
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.inactive:
        // The OS biometric prompt itself raises `inactive` (an overlay takes
        // focus; the app is still visible). Re-arming on that transition
        // discards the very grant the prompt is producing and can loop the
        // gate — so while a check is in flight, `inactive` is ignored. True
        // backgrounding during a prompt still reaches `hidden`/`paused`
        // below, which always re-arm.
        if (BiometricGate._promptInFlight) return;
        _clearGrantAndRearm();
      case AppLifecycleState.hidden:
      case AppLifecycleState.paused:
      case AppLifecycleState.detached:
        _clearGrantAndRearm();
      case AppLifecycleState.resumed:
        if (_checkOnResume && !_checkInFlight) {
          _checkOnResume = false;
          _runCheck();
        }
    }
  }

  void _clearGrantAndRearm() {
    if (_state == _GateState.granted || _checkInFlight) {
      BiometricGate.clearUnlockState();
      _checkOnResume = true;
      if (_state != _GateState.checking) {
        setState(() => _state = _GateState.checking);
      }
    }
  }

  Future<void> _runCheck() async {
    if (_checkInFlight) return;
    _checkInFlight = true;
    final generation = BiometricGate._unlockGeneration;
    var rerunAfterInvalidation = false;
    try {
      final graceScope = await _activeGraceScope();
      if (!mounted) return;
      if (generation != BiometricGate._unlockGeneration) {
        rerunAfterInvalidation =
            _checkOnResume &&
            WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
        return;
      }
      final last = BiometricGate._lastUnlockAt;
      final elapsed = last == null ? null : DateTime.now().difference(last);
      if (graceScope != null &&
          BiometricGate._lastUnlockScope == graceScope &&
          elapsed != null &&
          !elapsed.isNegative &&
          elapsed < BiometricGate.unlockGraceWindow) {
        widget.onGranted?.call();
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
        granted = await _runCoordinatedCheck(check, reason, graceScope);
      } catch (_) {
        granted = false; // fail closed, mirroring the service (M11)
      }
      if (!mounted) return;
      if (generation != BiometricGate._unlockGeneration) {
        granted = false;
        rerunAfterInvalidation =
            _checkOnResume &&
            WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
        if (rerunAfterInvalidation) return;
      }
      if (granted && graceScope != null) {
        BiometricGate._lastUnlockAt = DateTime.now();
        BiometricGate._lastUnlockScope = graceScope;
      }
      if (granted) widget.onGranted?.call();
      setState(() => _state = granted ? _GateState.granted : _GateState.denied);
    } finally {
      _checkInFlight = false;
      if (rerunAfterInvalidation && mounted) {
        _checkOnResume = false;
        unawaited(_runCheck());
      }
    }
  }

  Future<String?> _activeGraceScope() async {
    final injectedCheck =
        widget.authCheck ?? BiometricGate.debugDefaultAuthCheckOverride;
    if (injectedCheck != null) {
      final scope = widget.graceScopeKey?.trim();
      return scope == null || scope.isEmpty ? null : scope;
    }

    final uid = FirebaseAuth.instance.currentUser?.uid.trim();
    if (uid == null || uid.isEmpty) return null;

    try {
      if (!await BiometricGateService.isBiometricEnabled) return null;
    } catch (_) {
      return null;
    }
    return uid;
  }

  Future<bool> _runCoordinatedCheck(
    BiometricAuthCheck check,
    String reason,
    String? graceScope,
  ) async {
    final active = BiometricGate._inFlightCheck;
    if (graceScope != null &&
        active != null &&
        BiometricGate._inFlightCheckScope == graceScope) {
      return active;
    }

    BiometricGate._promptsInFlight++;
    final pending = Future<bool>.sync(() => check(reason));
    if (graceScope != null) {
      BiometricGate._inFlightCheck = pending;
      BiometricGate._inFlightCheckScope = graceScope;
    }
    try {
      return await pending;
    } finally {
      if (BiometricGate._promptsInFlight > 0) {
        BiometricGate._promptsInFlight--;
      }
      if (identical(BiometricGate._inFlightCheck, pending)) {
        BiometricGate._inFlightCheck = null;
        BiometricGate._inFlightCheckScope = null;
      }
    }
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
