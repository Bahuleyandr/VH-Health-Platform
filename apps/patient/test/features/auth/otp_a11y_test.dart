// Accessibility regression tests for the OTP entry step (audit PR 2).
//
// Covers audit blocker B3 (unlabeled OTP field, no role, no oneTimeCode
// autofill), H9 (inline error announced via live region), H10 (auto-submit
// "Verifying..." announcement), M18 (OTP step transition announced), and
// L5 (phone field autofill hint).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/widgets/phone_input_field.dart';
import 'package:vhhealth/features/auth/widgets/otp_ui_components.dart';
import 'package:vhhealth/features/auth/widgets/otp_widget.dart';
import 'package:vhhealth/generated/app_localizations.dart';

void main() {
  Widget harness(Widget child) {
    return MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: Scaffold(body: SingleChildScrollView(child: child)),
    );
  }

  Widget otpForm({
    String? errorText,
    bool isVerifying = false,
    ValueChanged<String>? onChanged,
    ValueChanged<String>? onCompleted,
  }) {
    return harness(
      OtpForm(
        phoneNumber: '+919876543210',
        controller: TextEditingController(),
        otpSent: true,
        isVerifying: isVerifying,
        isResending: false,
        errorText: errorText,
        onVerifyPressed: () {},
        onResendPressed: () {},
        onOtpChanged: onChanged ?? (_) {},
        onOtpCompleted: onCompleted ?? (_) {},
      ),
    );
  }

  Finder pinSemantics() {
    return find.byWidgetPredicate(
      (widget) =>
          widget is Semantics &&
          widget.properties.label == '6-digit OTP code' &&
          widget.properties.textField == true,
    );
  }

  group('OTP field semantics (audit B3)', () {
    testWidgets('exposes localized accessible name and text-field role', (
      tester,
    ) async {
      final semanticsHandle = tester.ensureSemantics();
      await tester.pumpWidget(otpForm());
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));

      expect(pinSemantics(), findsOneWidget);
      final node = tester.getSemantics(pinSemantics());
      final data = node.getSemanticsData();
      expect(data.flagsCollection.isTextField, isTrue);
      expect(data.label, '6-digit OTP code');
      semanticsHandle.dispose();
    });

    testWidgets('hint tracks remaining digits with localized strings', (
      tester,
    ) async {
      final semanticsHandle = tester.ensureSemantics();
      await tester.pumpWidget(otpForm());
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));

      expect(
        tester.getSemantics(pinSemantics()).getSemanticsData().hint,
        'Enter 6 more digits',
      );

      await tester.enterText(find.byType(EditableText), '12345');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      expect(
        tester.getSemantics(pinSemantics()).getSemanticsData().hint,
        'Enter 1 more digit',
      );

      await tester.enterText(find.byType(EditableText), '123456');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      final data = tester.getSemantics(pinSemantics()).getSemanticsData();
      expect(data.hint, 'All 6 digits entered');
      expect(data.value, '123456');
      semanticsHandle.dispose();
    });

    testWidgets('declares oneTimeCode autofill on the underlying field', (
      tester,
    ) async {
      await tester.pumpWidget(otpForm());
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));

      expect(find.byType(AutofillGroup), findsOneWidget);
      final editable = tester.widget<EditableText>(find.byType(EditableText));
      expect(editable.autofillHints, contains(AutofillHints.oneTimeCode));
    });

    testWidgets('keyboard entry still reaches onChanged/onCompleted', (
      tester,
    ) async {
      String? completed;
      final changes = <String>[];
      await tester.pumpWidget(
        otpForm(onChanged: changes.add, onCompleted: (v) => completed = v),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));

      await tester.enterText(find.byType(EditableText), '123456');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));

      expect(completed, '123456');
      expect(changes, isNotEmpty);
      expect(changes.last, '123456');
    });
  });

  group('OTP inline error (audit H9)', () {
    testWidgets('error text renders inline inside a live region', (
      tester,
    ) async {
      final semanticsHandle = tester.ensureSemantics();
      await tester.pumpWidget(otpForm());
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.text('Invalid OTP. Please try again.'), findsNothing);

      await tester.pumpWidget(
        otpForm(errorText: 'Invalid OTP. Please try again.'),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));

      final errorFinder = find.text('Invalid OTP. Please try again.');
      expect(errorFinder, findsOneWidget);
      final node = tester.getSemantics(errorFinder);
      expect(node.getSemanticsData().flagsCollection.isLiveRegion, isTrue);
      semanticsHandle.dispose();
    });

    testWidgets('clearing errorText hides the inline error', (tester) async {
      await tester.pumpWidget(
        otpForm(errorText: 'Invalid OTP. Please try again.'),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.text('Invalid OTP. Please try again.'), findsOneWidget);

      await tester.pumpWidget(otpForm());
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.text('Invalid OTP. Please try again.'), findsNothing);
    });

    testWidgets(
      'OtpWidget surfaces a persistent inline error and clears it on edit',
      (tester) async {
        // No Firebase in widget tests: the initial _sendOTP fails inside
        // OtpService's catch and surfaces as a snackbar, which leaves
        // verificationId null — entering 6 digits then exercises the real
        // inline-error path (session expired) end to end.
        await tester.pumpWidget(
          harness(OtpWidget(phoneNumber: '+919876543210', onSuccess: () {})),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 600));

        await tester.enterText(find.byType(EditableText), '123456');
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 600));
        expect(
          find.text('Verification session expired. Please resend the OTP.'),
          findsOneWidget,
        );

        // Editing the code clears the inline error.
        await tester.enterText(find.byType(EditableText), '12345');
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 600));
        expect(
          find.text('Verification session expired. Please resend the OTP.'),
          findsNothing,
        );
        // Drain the 4s snackbar timer from the failed _sendOTP.
        await tester.pump(const Duration(seconds: 5));
      },
    );
  });

  group('Verifying announcement (audit H10)', () {
    testWidgets('verifying state swaps in a live-region "Verifying..."', (
      tester,
    ) async {
      final semanticsHandle = tester.ensureSemantics();
      await tester.pumpWidget(otpForm());
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.text('Verifying...'), findsNothing);

      // Auto-submit on the 6th digit flips isVerifying — the button content
      // swap must announce so the user knows why the context changed.
      await tester.pumpWidget(otpForm(isVerifying: true));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));

      final verifyingFinder = find.text('Verifying...');
      expect(verifyingFinder, findsOneWidget);
      final node = tester.getSemantics(verifyingFinder);
      final data = node.getSemanticsData();
      expect(data.flagsCollection.isLiveRegion, isTrue);
      expect(data.label, contains('Verifying...'));
      semanticsHandle.dispose();
    });
  });

  group('OTP step transition (audit M18)', () {
    testWidgets('header is a merged live region including the masked phone', (
      tester,
    ) async {
      final semanticsHandle = tester.ensureSemantics();
      await tester.pumpWidget(otpForm());
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));

      final headerFinder = find.text('Verify Your Phone Number');
      expect(headerFinder, findsOneWidget);
      final node = tester.getSemantics(headerFinder);
      final data = node.getSemanticsData();
      expect(data.flagsCollection.isLiveRegion, isTrue);
      expect(data.label, contains('Verify Your Phone Number'));
      expect(data.label, contains('+91 ********10'));
      semanticsHandle.dispose();
    });
  });

  group('Phone field autofill (audit L5)', () {
    testWidgets('phone input declares telephoneNumber autofill', (
      tester,
    ) async {
      await tester.pumpWidget(
        harness(
          PhoneInputField(controller: TextEditingController(), readOnly: false),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));

      final editable = tester.widget<EditableText>(find.byType(EditableText));
      expect(editable.autofillHints, contains(AutofillHints.telephoneNumber));
    });
  });
}
