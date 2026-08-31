import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/idempotency_attempt_registry.dart';

void main() {
  test('ambiguous retry reuses the open command key', () {
    final attempts = IdempotencyAttemptRegistry();
    final payload = {'reason': 'Prescriber reviewed the held dose'};

    final first = attempts.keyFor('mar-release-hold:42', payload);
    final retry = attempts.keyFor('mar-release-hold:42', payload);

    expect(retry, first);
    expect(attempts.current('mar-release-hold:42'), first);
  });

  test('success completion makes the next command a new attempt', () {
    final attempts = IdempotencyAttemptRegistry();
    final first = attempts.keyFor('billing-credit-note:9:apply', const {});

    attempts.complete('billing-credit-note:9:apply');
    final next = attempts.keyFor('billing-credit-note:9:apply', const {});

    expect(next, isNot(first));
  });

  test('changed payload cannot reuse a stale command key', () {
    final attempts = IdempotencyAttemptRegistry();
    final first = attempts.keyFor('billing-refund:7:pay', {
      'reference': 'CASH-1',
    });
    final changed = attempts.keyFor('billing-refund:7:pay', {
      'reference': 'CASH-2',
    });

    expect(changed, isNot(first));
  });
}
