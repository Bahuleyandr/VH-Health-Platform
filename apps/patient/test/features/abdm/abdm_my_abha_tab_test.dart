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
