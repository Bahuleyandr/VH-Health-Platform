// Accessibility regression guard — phone/OTP login step (audit PR 4).
//
// Audit blocker 3: the OTP pin field shipped without `oneTimeCode` autofill
// and relied on the pin package's implicit semantics. The autofill guards
// are grouped under `skip:` until PR #792 (which also makes the field's
// label/role explicit and localised) merges. The label/role and tap-target
// guards already hold on main and run un-skipped — they keep the current
// baseline from regressing.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/widgets/phone_input_field.dart';
import 'package:vhhealth/features/auth/widgets/otp_ui_components.dart';

import 'a11y_guards.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Widget otpForm() {
    return SingleChildScrollView(
      child: OtpForm(
        phoneNumber: '+919876543210',
        controller: TextEditingController(),
        otpSent: true,
        isVerifying: false,
        isResending: false,
        onVerifyPressed: () {},
        onResendPressed: () {},
        onOtpChanged: (_) {},
        onOtpCompleted: (_) {},
      ),
    );
  }

  Future<void> settlePinField(WidgetTester tester) async {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 600));
  }

  for (final themeCase in themeCases) {
    testWidgets('[${themeCase.name}] OTP form buttons meet tap-target '
        'guidelines', (tester) async {
      await withSemantics(tester, () async {
        await pumpGuarded(tester, otpForm(), theme: themeCase.theme);
        await settlePinField(tester);
        await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
        await expectLater(tester, meetsGuideline(iOSTapTargetGuideline));
      });
    });
  }

  testWidgets('pin field exposes a labeled text-field semantics node '
      '(green on main)', (tester) async {
    await withSemantics(tester, () async {
      await pumpGuarded(tester, otpForm(), theme: themeCases.first.theme);
      await settlePinField(tester);

      final matches = find.byWidgetPredicate(
        (widget) =>
            widget is Semantics &&
            widget.properties.textField == true &&
            (widget.properties.label ?? '').isNotEmpty,
      );
      expect(matches, findsWidgets);
    });
  });

  testWidgets('every tappable node in the OTP form carries a label '
      '(green on main)', (tester) async {
    await withSemantics(tester, () async {
      await pumpGuarded(tester, otpForm(), theme: themeCases.first.theme);
      await settlePinField(tester);
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    });
  });

  group('OTP autofill (fixed by PR #792)', () {
    testWidgets('pin field declares oneTimeCode autofill', (tester) async {
      await pumpGuarded(tester, otpForm(), theme: themeCases.first.theme);
      await settlePinField(tester);

      expect(find.byType(AutofillGroup), findsOneWidget);
      final editable = tester.widget<EditableText>(find.byType(EditableText));
      expect(editable.autofillHints, contains(AutofillHints.oneTimeCode));
    });
  }, skip: kBlockedOnPr792);

  group('phone field autofill (fixed by PR #792)', () {
    testWidgets('phone number field declares telephoneNumber autofill', (
      tester,
    ) async {
      await pumpGuarded(
        tester,
        PhoneInputField(controller: TextEditingController(), readOnly: false),
        theme: themeCases.first.theme,
      );
      await tester.pump();

      final editable = tester.widget<EditableText>(find.byType(EditableText));
      expect(editable.autofillHints, contains(AutofillHints.telephoneNumber));
    });
  }, skip: kBlockedOnPr792);

  testWidgets('phone number field is labeled (green on main)', (tester) async {
    await withSemantics(tester, () async {
      await pumpGuarded(
        tester,
        PhoneInputField(controller: TextEditingController(), readOnly: false),
        theme: themeCases.first.theme,
      );
      await tester.pump();
      expect(find.text('Phone number'), findsOneWidget);
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    });
  });
}
