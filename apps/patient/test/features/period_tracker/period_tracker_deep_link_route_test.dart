import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/features/period_tracker/screens/period_tracker_deep_link_route.dart';
import 'package:vhhealth/features/period_tracker/services/period_tracker_eligibility_loader.dart';
import 'package:vhhealth/generated/app_localizations.dart';

void main() {
  testWidgets('cold route keeps an ineligible profile outside the tracker', (
    tester,
  ) async {
    await tester.pumpWidget(
      _Harness(
        child: PeriodTrackerDeepLinkRoute(
          loader: _EligibilityLoader(const PeriodTrackerIneligible()),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final l = await AppLocalizations.delegate.load(const Locale('en'));
    expect(find.text(l.periodTrackerProfileUnavailable), findsOneWidget);
    expect(find.text(l.commonRetry), findsOneWidget);
  });

  testWidgets('an older profile check cannot overwrite a newer result', (
    tester,
  ) async {
    final older = _CompletingEligibilityLoader();
    await tester.pumpWidget(
      _Harness(child: PeriodTrackerDeepLinkRoute(loader: older)),
    );
    await tester.pumpWidget(
      _Harness(
        child: PeriodTrackerDeepLinkRoute(
          loader: _EligibilityLoader(const PeriodTrackerIneligible()),
        ),
      ),
    );
    await tester.pump();

    older.complete(const PeriodTrackerEligible());
    await tester.pump();

    final l = await AppLocalizations.delegate.load(const Locale('en'));
    expect(find.text(l.periodTrackerProfileUnavailable), findsOneWidget);
  });

  testWidgets('an unexpected eligibility exception remains fail closed', (
    tester,
  ) async {
    await tester.pumpWidget(
      const _Harness(
        child: PeriodTrackerDeepLinkRoute(loader: _ThrowingEligibilityLoader()),
      ),
    );
    await tester.pumpAndSettle();

    final l = await AppLocalizations.delegate.load(const Locale('en'));
    expect(find.text(l.periodTrackerProfileUnavailable), findsOneWidget);
  });
}

class _Harness extends StatelessWidget {
  const _Harness({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: child,
    );
  }
}

class _EligibilityLoader implements PeriodTrackerEligibilityLoader {
  _EligibilityLoader(this.result);

  final PeriodTrackerEligibilityResult result;

  @override
  Future<PeriodTrackerEligibilityResult> load() async => result;
}

class _CompletingEligibilityLoader implements PeriodTrackerEligibilityLoader {
  final _completer = Completer<PeriodTrackerEligibilityResult>();

  @override
  Future<PeriodTrackerEligibilityResult> load() => _completer.future;

  void complete(PeriodTrackerEligibilityResult result) {
    _completer.complete(result);
  }
}

class _ThrowingEligibilityLoader implements PeriodTrackerEligibilityLoader {
  const _ThrowingEligibilityLoader();

  @override
  Future<PeriodTrackerEligibilityResult> load() async =>
      throw StateError('unexpected eligibility failure');
}
