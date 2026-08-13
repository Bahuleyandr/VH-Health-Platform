import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/idempotency_key.dart';

void main() {
  // Backend contract: 1–200 chars of [A-Za-z0-9_-:.]
  final accepted = RegExp(r'^[A-Za-z0-9_\-:.]{1,200}$');

  group('IdempotencyKey.generate', () {
    test('mints distinct keys inside the backend charset', () {
      final keys = <String>{};
      for (var i = 0; i < 50; i++) {
        final key = IdempotencyKey.generate();
        expect(accepted.hasMatch(key), isTrue, reason: key);
        keys.add(key);
      }
      expect(keys.length, 50);
    });
  });

  group('IdempotencyAttempt', () {
    test('returns the SAME key while the payload is unchanged', () {
      final attempt = IdempotencyAttempt('staff-message-send');
      final payload = {'recipient': 'u1', 'body': 'hello'};

      final first = attempt.keyFor(payload);
      // A double-tap and a transport retry must carry one key so the backend
      // replays instead of sending the message twice.
      expect(attempt.keyFor(payload), first);
      expect(attempt.keyFor({'recipient': 'u1', 'body': 'hello'}), first);
    });

    test('mints a NEW key when the payload changes', () {
      final attempt = IdempotencyAttempt('staff-message-send');
      final first = attempt.keyFor({'body': 'hello'});
      // A changed body would 422 against the old key (the server hashes it),
      // so a changed payload must start a new attempt.
      expect(attempt.keyFor({'body': 'goodbye'}), isNot(first));
    });

    test('mints a NEW key after reset — the next send is not a replay', () {
      final attempt = IdempotencyAttempt('staff-message-send');
      final payload = {'body': 'hello'};
      final first = attempt.keyFor(payload);
      attempt.reset();
      expect(attempt.keyFor(payload), isNot(first));
    });

    test('prefixes with the scope and stays inside the accepted charset', () {
      final attempt = IdempotencyAttempt('billing/payment collection');
      final key = attempt.keyFor({'invoice_id': 1});
      expect(accepted.hasMatch(key), isTrue, reason: key);
      expect(key, startsWith('billing-payment-collection:'));
    });

    test('exposes the open attempt through current', () {
      final attempt = IdempotencyAttempt('scope');
      expect(attempt.current, isNull);
      final key = attempt.keyFor({'a': 1});
      expect(attempt.current, key);
      attempt.reset();
      expect(attempt.current, isNull);
    });
  });
}
