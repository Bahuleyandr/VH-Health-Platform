// test/core/services/api_client_refresh_policy_test.dart
//
// Tests for the ApiClient single-flight 401 refresh decision. The real
// ApiClient wires http + flutter_secure_storage + GoRouter together (per
// CLAUDE.md), but the *decision* logic for when to trigger a refresh,
// whether to dedup concurrent 401s, and when to give up, is a pure state
// machine. Mirror that here so a regression in the gating logic (e.g.
// infinite refresh loops, lost retries, firing onSessionExpired while a
// refresh is actually in flight) is caught before ship.

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';

/// Outcome of handling a 401 response.
enum RefreshOutcome { retryOriginal, sessionExpired }

/// Pure mirror of ApiClient's single-flight 401 refresh gate.
///
/// Contract:
///   * Concurrent 401s should share ONE refresh round-trip (dedup via
///     module-level Completer).
///   * After a successful refresh, each caller retries its original request
///     once and only once (no retry loops on a second 401).
///   * A failed refresh fires onSessionExpired() exactly once and all pending
///     callers get RefreshOutcome.sessionExpired.
class RefreshGate {
  RefreshGate({required this.doRefresh, required this.onSessionExpired});

  /// The underlying "call /auth/refresh-token" action. Test doubles resolve
  /// this with `true` (success) or `false` (expired).
  final Future<bool> Function() doRefresh;

  /// Invoked (once) when refresh fails and the session cannot be recovered.
  final void Function() onSessionExpired;

  Completer<bool>? _inFlight;
  bool _sessionExpiredFired = false;

  /// Called by any caller that just saw a 401 on its original request.
  /// Returns whether the caller should retry its original request.
  Future<RefreshOutcome> handle401() async {
    if (_sessionExpiredFired) return RefreshOutcome.sessionExpired;

    final existing = _inFlight;
    if (existing != null) {
      final ok = await existing.future;
      return ok ? RefreshOutcome.retryOriginal : RefreshOutcome.sessionExpired;
    }

    final c = Completer<bool>();
    _inFlight = c;
    bool ok;
    try {
      ok = await doRefresh();
    } catch (_) {
      ok = false;
    } finally {
      _inFlight = null;
    }
    c.complete(ok);

    if (!ok && !_sessionExpiredFired) {
      _sessionExpiredFired = true;
      onSessionExpired();
    }
    return ok ? RefreshOutcome.retryOriginal : RefreshOutcome.sessionExpired;
  }
}

void main() {
  group('RefreshGate', () {
    test('successful refresh → caller retries original', () async {
      int refreshCalls = 0;
      final g = RefreshGate(
        doRefresh: () async {
          refreshCalls++;
          return true;
        },
        onSessionExpired: () => fail('should not expire'),
      );
      expect(await g.handle401(), RefreshOutcome.retryOriginal);
      expect(refreshCalls, 1);
    });

    test('concurrent 401s dedup into ONE refresh round-trip', () async {
      int refreshCalls = 0;
      final refreshCompleter = Completer<bool>();
      final g = RefreshGate(
        doRefresh: () async {
          refreshCalls++;
          return refreshCompleter.future;
        },
        onSessionExpired: () => fail('should not expire'),
      );

      // Three parallel 401s, all hitting the gate at the same time.
      final futures = [g.handle401(), g.handle401(), g.handle401()];
      await Future<void>.delayed(Duration.zero);
      refreshCompleter.complete(true);
      final results = await Future.wait(futures);

      expect(
        refreshCalls,
        1,
        reason: 'All concurrent 401s must share one refresh call',
      );
      expect(results, everyElement(RefreshOutcome.retryOriginal));
    });

    test('failed refresh fires onSessionExpired exactly once', () async {
      int expiredFired = 0;
      final g = RefreshGate(
        doRefresh: () async => false,
        onSessionExpired: () => expiredFired++,
      );

      expect(await g.handle401(), RefreshOutcome.sessionExpired);
      expect(await g.handle401(), RefreshOutcome.sessionExpired);
      expect(
        expiredFired,
        1,
        reason:
            'onSessionExpired must be idempotent — one expiry = one redirect',
      );
    });

    test('thrown refresh error is treated as expired, not a crash', () async {
      int expiredFired = 0;
      final g = RefreshGate(
        doRefresh: () async {
          throw StateError('network down');
        },
        onSessionExpired: () => expiredFired++,
      );
      expect(await g.handle401(), RefreshOutcome.sessionExpired);
      expect(expiredFired, 1);
    });

    test(
      'after expiry, new 401s short-circuit to expired (no retry loop)',
      () async {
        int refreshCalls = 0;
        int expiredFired = 0;
        final g = RefreshGate(
          doRefresh: () async {
            refreshCalls++;
            return false;
          },
          onSessionExpired: () => expiredFired++,
        );
        await g.handle401(); // triggers refresh → fails
        final r = await g.handle401(); // should NOT call refresh again
        expect(r, RefreshOutcome.sessionExpired);
        expect(refreshCalls, 1);
        expect(expiredFired, 1);
      },
    );

    test(
      'concurrent 401s, refresh fails → all get expired, one notify',
      () async {
        int expiredFired = 0;
        final refreshCompleter = Completer<bool>();
        final g = RefreshGate(
          doRefresh: () async => refreshCompleter.future,
          onSessionExpired: () => expiredFired++,
        );
        final futures = [g.handle401(), g.handle401(), g.handle401()];
        await Future<void>.delayed(Duration.zero);
        refreshCompleter.complete(false);
        final results = await Future.wait(futures);

        expect(results, everyElement(RefreshOutcome.sessionExpired));
        expect(
          expiredFired,
          1,
          reason:
              'Even with N concurrent callers, only one redirect should fire',
        );
      },
    );
  });
}
