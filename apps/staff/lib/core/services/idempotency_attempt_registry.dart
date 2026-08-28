import 'package:vhhealth_core/services/idempotency_key.dart';

/// Keeps one replay-safe command identity open per logical write until the
/// caller has received a definitive success response.
class IdempotencyAttemptRegistry {
  final Map<String, IdempotencyAttempt> _attempts = {};

  String keyFor(String scope, Object? payload) {
    return (_attempts[scope] ??= IdempotencyAttempt(scope)).keyFor(payload);
  }

  void complete(String scope) {
    _attempts.remove(scope)?.reset();
  }

  String? current(String scope) => _attempts[scope]?.current;

  void clear() {
    for (final attempt in _attempts.values) {
      attempt.reset();
    }
    _attempts.clear();
  }
}
