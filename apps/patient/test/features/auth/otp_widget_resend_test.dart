import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/features/auth/services/otp_service.dart';
import 'package:vhhealth/features/auth/widgets/otp_ui_components.dart';
import 'package:vhhealth/features/auth/widgets/otp_widget.dart';
import 'package:vhhealth/generated/app_localizations.dart';

void main() {
  testWidgets('a failed resend keeps the previously delivered OTP usable', (
    tester,
  ) async {
    var sendCount = 0;
    late PhoneCodeSent initialCodeSent;
    late PhoneVerificationFailed resendFailed;
    final service = OtpService(
      verifyPhoneNumber:
          ({
            required phoneNumber,
            required verificationCompleted,
            required verificationFailed,
            required codeSent,
            required codeAutoRetrievalTimeout,
            forceResendingToken,
          }) async {
            sendCount += 1;
            if (sendCount == 1) {
              initialCodeSent = codeSent;
            } else {
              expect(forceResendingToken, 41);
              resendFailed = verificationFailed;
            }
          },
    );

    await tester.pumpWidget(
      MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: Scaffold(
          body: SingleChildScrollView(
            child: OtpWidget(
              phoneNumber: '+919876543210',
              onSuccess: () {},
              otpService: service,
            ),
          ),
        ),
      ),
    );
    expect(sendCount, 1);
    initialCodeSent('verification-1', 41);
    await tester.pump();
    expect(
      tester.widget<OtpVerifyButton>(find.byType(OtpVerifyButton)).otpSent,
      isTrue,
    );

    await tester.pump(const Duration(seconds: 30));
    await tester.tap(find.text("Didn't receive OTP? Resend"));
    await tester.pump();

    expect(sendCount, 2);
    resendFailed(FirebaseAuthException(code: 'network-request-failed'));
    await tester.pump();
    expect(
      tester.widget<OtpVerifyButton>(find.byType(OtpVerifyButton)).otpSent,
      isTrue,
    );
  });
}
