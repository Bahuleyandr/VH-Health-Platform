import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/features/auth/widgets/otp_ui_components.dart';
import 'package:vhhealth/generated/app_localizations.dart';

Widget _wrap(Widget child) {
  return MaterialApp(
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    home: Scaffold(body: child),
  );
}

void main() {
  group('OtpResendButton cooldown', () {
    testWidgets('is enabled with the resend label when idle', (tester) async {
      var pressed = false;
      await tester.pumpWidget(
        _wrap(
          OtpResendButton(
            isResending: false,
            isVerifying: false,
            onPressed: () => pressed = true,
          ),
        ),
      );

      expect(find.text("Didn't receive OTP? Resend"), findsOneWidget);
      await tester.tap(find.byType(TextButton));
      expect(pressed, isTrue);
    });

    testWidgets('is disabled and shows the countdown during cooldown', (
      tester,
    ) async {
      var pressed = false;
      await tester.pumpWidget(
        _wrap(
          OtpResendButton(
            isResending: false,
            isVerifying: false,
            cooldownSeconds: 27,
            onPressed: () => pressed = true,
          ),
        ),
      );

      expect(find.text('Resend OTP in 27s'), findsOneWidget);
      final button = tester.widget<TextButton>(find.byType(TextButton));
      expect(button.onPressed, isNull);
      await tester.tap(find.byType(TextButton), warnIfMissed: false);
      expect(pressed, isFalse);
    });

    testWidgets('re-enables once the cooldown reaches zero', (tester) async {
      await tester.pumpWidget(
        _wrap(
          OtpResendButton(
            isResending: false,
            isVerifying: false,
            cooldownSeconds: 1,
            onPressed: () {},
          ),
        ),
      );
      expect(
        tester.widget<TextButton>(find.byType(TextButton)).onPressed,
        isNull,
      );

      await tester.pumpWidget(
        _wrap(
          OtpResendButton(
            isResending: false,
            isVerifying: false,
            cooldownSeconds: 0,
            onPressed: () {},
          ),
        ),
      );
      expect(
        tester.widget<TextButton>(find.byType(TextButton)).onPressed,
        isNotNull,
      );
      expect(find.text("Didn't receive OTP? Resend"), findsOneWidget);
    });

    testWidgets('stays disabled while a resend is in flight', (tester) async {
      await tester.pumpWidget(
        _wrap(
          OtpResendButton(
            isResending: true,
            isVerifying: false,
            onPressed: () {},
          ),
        ),
      );
      expect(
        tester.widget<TextButton>(find.byType(TextButton)).onPressed,
        isNull,
      );
    });
  });

  group('OtpForm cooldown pass-through', () {
    testWidgets('threads resendCooldownSeconds into the resend button', (
      tester,
    ) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        _wrap(
          SingleChildScrollView(
            child: OtpForm(
              phoneNumber: '+919876543210',
              controller: controller,
              otpSent: true,
              isVerifying: false,
              isResending: false,
              resendCooldownSeconds: 12,
              onVerifyPressed: () {},
              onResendPressed: () {},
              onOtpChanged: (_) {},
              onOtpCompleted: (_) {},
            ),
          ),
        ),
      );

      expect(find.text('Resend OTP in 12s'), findsOneWidget);
      final resendButton = tester.widget<OtpResendButton>(
        find.byType(OtpResendButton),
      );
      expect(resendButton.cooldownSeconds, 12);
    });
  });
}
