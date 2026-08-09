// "My ABHA" tab state machine (audit F12).
//
// The tab used to ask a staff/admin-only endpoint for the patient's linkage,
// passing the patient's phone where an ABHA number belonged. The 403 was
// swallowed, so every patient — including already-linked ones — was shown the
// registration form. These tests pin the states that replaced that: loading,
// linked, unlinked, and a visible error with retry (never a silent fallback to
// "register").

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/services/abdm_api_service.dart';
import 'package:vhhealth/features/abdm/screens/abdm_screen.dart';
import 'package:vhhealth/generated/app_localizations.dart';

void main() {
  testWidgets('shows a spinner while the linkage status is in flight', (
    tester,
  ) async {
    final pending = Completer<AbhaLinkage>();

    await tester.pumpWidget(
      _LocalizedHarness(child: MyAbhaTab(loadLinkage: () => pending.future)),
    );
    await tester.pump();

    expect(find.byKey(const ValueKey('abha_loading')), findsOneWidget);
    expect(find.byKey(const ValueKey('abha_info')), findsNothing);
    expect(find.byKey(const ValueKey('abha_error')), findsNothing);

    pending.complete(const AbhaLinkage(linked: false));
    await tester.pumpAndSettle();
  });

  testWidgets('a linked patient sees their ABHA, not the registration prompt', (
    tester,
  ) async {
    await tester.pumpWidget(
      _LocalizedHarness(
        child: MyAbhaTab(
          loadLinkage: () async => const AbhaLinkage(
            linked: true,
            abhaNumber: '12345678901234',
            abhaAddress: 'patient@abdm',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('abha_card')), findsOneWidget);
    expect(find.text('12345678901234'), findsOneWidget);
    expect(find.text('patient@abdm'), findsOneWidget);
    // The regression this fix exists to prevent: never offer registration to
    // someone who already has an ABHA linked.
    expect(find.byKey(const ValueKey('abha_info')), findsNothing);
    expect(find.text('Register ABHA'), findsNothing);
  });

  testWidgets('a patient linked by ABHA address alone still renders', (
    tester,
  ) async {
    await tester.pumpWidget(
      _LocalizedHarness(
        child: MyAbhaTab(
          loadLinkage: () async =>
              const AbhaLinkage(linked: true, abhaAddress: 'address-only@abdm'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('abha_card')), findsOneWidget);
    expect(find.text('address-only@abdm'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('an unlinked patient is offered registration', (tester) async {
    await tester.pumpWidget(
      _LocalizedHarness(
        child: MyAbhaTab(
          loadLinkage: () async => const AbhaLinkage(linked: false),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('abha_info')), findsOneWidget);
    expect(find.text('Register ABHA'), findsOneWidget);
    expect(find.byKey(const ValueKey('abha_card')), findsNothing);
  });

  group('linking an existing ABHA', () {
    testWidgets('posts the normalised 14-digit number and re-reads linkage', (
      tester,
    ) async {
      String? sentNumber;
      String? sentAddress;
      var loads = 0;

      await tester.pumpWidget(
        _LocalizedHarness(
          child: MyAbhaTab(
            loadLinkage: () async {
              loads++;
              return loads == 1
                  ? const AbhaLinkage(linked: false)
                  : const AbhaLinkage(
                      linked: true,
                      abhaNumber: '12345678901234',
                      abhaAddress: 'ravi@abdm',
                    );
            },
            linkAbha: ({required abhaNumber, abhaAddress}) async {
              sentNumber = abhaNumber;
              sentAddress = abhaAddress;
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Register ABHA'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('abha_link_form')), findsOneWidget);

      // Typed the way the number is printed on an ABHA card.
      await tester.enterText(
        find.widgetWithText(TextFormField, 'ABHA Number *'),
        '12-3456-7890-1234',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'ABHA Address (optional)'),
        'ravi@abdm',
      );
      await tester.tap(find.byKey(const ValueKey('abha_link_submit')));
      await tester.pumpAndSettle();

      // Hyphens stripped — the backend stores and validates 14 bare digits.
      expect(sentNumber, '12345678901234');
      expect(sentAddress, 'ravi@abdm');
      // Canonical state re-read rather than trusting what we posted.
      expect(loads, 2);
      expect(find.byKey(const ValueKey('abha_card')), findsOneWidget);
      expect(find.text('12345678901234'), findsOneWidget);
    });

    testWidgets('rejects a malformed ABHA number without calling the API', (
      tester,
    ) async {
      var linkCalls = 0;

      await tester.pumpWidget(
        _LocalizedHarness(
          child: MyAbhaTab(
            loadLinkage: () async => const AbhaLinkage(linked: false),
            linkAbha: ({required abhaNumber, abhaAddress}) async {
              linkCalls++;
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Register ABHA'));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.widgetWithText(TextFormField, 'ABHA Number *'),
        '1234',
      );
      await tester.tap(find.byKey(const ValueKey('abha_link_submit')));
      await tester.pumpAndSettle();

      expect(find.text('ABHA number must be 14 digits'), findsOneWidget);
      expect(linkCalls, 0);
      expect(find.byKey(const ValueKey('abha_link_form')), findsOneWidget);
    });

    testWidgets('a rejected link surfaces the backend message and stays put', (
      tester,
    ) async {
      await tester.pumpWidget(
        _LocalizedHarness(
          child: MyAbhaTab(
            loadLinkage: () async => const AbhaLinkage(linked: false),
            linkAbha: ({required abhaNumber, abhaAddress}) async =>
                throw const AbdmException(
                  'This ABHA number is already linked to another patient',
                ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Register ABHA'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.widgetWithText(TextFormField, 'ABHA Number *'),
        '99998888777766',
      );
      await tester.tap(find.byKey(const ValueKey('abha_link_submit')));
      await tester.pumpAndSettle();

      expect(
        find.text('This ABHA number is already linked to another patient'),
        findsOneWidget,
      );
      // Still on the form with the input intact, not silently "linked".
      expect(find.byKey(const ValueKey('abha_link_form')), findsOneWidget);
      expect(find.byKey(const ValueKey('abha_card')), findsNothing);
    });

    testWidgets('offers the official portal for patients with no ABHA', (
      tester,
    ) async {
      await tester.pumpWidget(
        _LocalizedHarness(
          child: MyAbhaTab(
            loadLinkage: () async => const AbhaLinkage(linked: false),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Register ABHA'));
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('abha_create_portal')), findsOneWidget);
      expect(find.text('Create one at abha.abdm.gov.in'), findsOneWidget);
      // The app must not pretend it can enrol an ABHA itself.
      expect(find.textContaining('Year of Birth'), findsNothing);
      expect(find.textContaining('OTP'), findsNothing);
    });
  });

  testWidgets('a failure shows the error state and hides registration', (
    tester,
  ) async {
    await tester.pumpWidget(
      _LocalizedHarness(
        child: MyAbhaTab(
          loadLinkage: () async =>
              throw const AbdmException('Could not check your ABHA status'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('abha_error')), findsOneWidget);
    expect(find.text('Could not check your ABHA status'), findsWidgets);
    expect(find.byKey(const ValueKey('abha_retry')), findsOneWidget);
    // Must not fall back to the registration prompt — that is the F12 bug.
    expect(find.byKey(const ValueKey('abha_info')), findsNothing);
    expect(find.text('Register ABHA'), findsNothing);
  });

  testWidgets('retry re-fetches and recovers to the linked state', (
    tester,
  ) async {
    var attempts = 0;
    Future<AbhaLinkage> load() async {
      attempts++;
      if (attempts == 1) {
        throw const AbdmException('Network unreachable');
      }
      return const AbhaLinkage(linked: true, abhaNumber: '99998888777766');
    }

    await tester.pumpWidget(
      _LocalizedHarness(child: MyAbhaTab(loadLinkage: load)),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('abha_error')), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('abha_retry')));
    await tester.pumpAndSettle();

    expect(attempts, 2);
    expect(find.byKey(const ValueKey('abha_error')), findsNothing);
    expect(find.byKey(const ValueKey('abha_card')), findsOneWidget);
    expect(find.text('99998888777766'), findsOneWidget);
  });

  testWidgets(
    'an unexpected error is reported without leaking the raw object',
    (tester) async {
      await tester.pumpWidget(
        _LocalizedHarness(
          child: MyAbhaTab(
            loadLinkage: () async => throw StateError('boom internal detail'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('abha_error')), findsOneWidget);
      expect(find.textContaining('boom internal detail'), findsNothing);
      expect(find.textContaining('Bad state'), findsNothing);
    },
  );
}

class _LocalizedHarness extends StatelessWidget {
  const _LocalizedHarness({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: Scaffold(body: child),
    );
  }
}
