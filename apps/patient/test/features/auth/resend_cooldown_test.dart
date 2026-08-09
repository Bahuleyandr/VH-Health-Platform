import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/features/auth/services/resend_cooldown.dart';

void main() {
  // testWidgets runs timers under FakeAsync, so tester.pump(duration)
  // deterministically advances the cooldown's periodic timer.
  group('ResendCooldown', () {
    testWidgets('starts inactive with zero seconds remaining', (tester) async {
      final cooldown = ResendCooldown();
      addTearDown(cooldown.dispose);

      expect(cooldown.isActive, isFalse);
      expect(cooldown.remainingSeconds, 0);
    });

    testWidgets('counts down to zero after start', (tester) async {
      final cooldown = ResendCooldown(duration: const Duration(seconds: 3));
      addTearDown(cooldown.dispose);

      cooldown.start();
      expect(cooldown.isActive, isTrue);
      expect(cooldown.remainingSeconds, 3);

      await tester.pump(const Duration(seconds: 1));
      expect(cooldown.remainingSeconds, 2);

      await tester.pump(const Duration(seconds: 2));
      expect(cooldown.remainingSeconds, 0);
      expect(cooldown.isActive, isFalse);

      // No stray timer keeps ticking below zero.
      await tester.pump(const Duration(seconds: 5));
      expect(cooldown.remainingSeconds, 0);
    });

    testWidgets('notifies listeners on start and every tick', (tester) async {
      final cooldown = ResendCooldown(duration: const Duration(seconds: 2));
      addTearDown(cooldown.dispose);
      var notifications = 0;
      cooldown.addListener(() => notifications++);

      cooldown.start();
      await tester.pump(const Duration(seconds: 2));

      // 1 for start + 1 per elapsed second.
      expect(notifications, 3);
    });

    testWidgets('restart resets the countdown', (tester) async {
      final cooldown = ResendCooldown(duration: const Duration(seconds: 30));
      addTearDown(cooldown.dispose);

      cooldown.start();
      await tester.pump(const Duration(seconds: 10));
      expect(cooldown.remainingSeconds, 20);

      cooldown.start();
      expect(cooldown.remainingSeconds, 30);
      await tester.pump(const Duration(seconds: 30));
      expect(cooldown.isActive, isFalse);
    });

    testWidgets('dispose cancels the pending timer', (tester) async {
      final cooldown = ResendCooldown(duration: const Duration(seconds: 30));
      cooldown.start();
      cooldown.dispose();
      // Would throw a pending-timer error at test teardown if the periodic
      // timer survived dispose.
      await tester.pump(const Duration(seconds: 1));
    });
  });
}
