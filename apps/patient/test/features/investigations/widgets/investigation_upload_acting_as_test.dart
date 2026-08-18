// Investigation upload under acting-as (P9, 2026-08-18).
//
// The backend files an upload against the BODY phone and (fail-closed)
// requires it to match the caller's own record; a dependent's synthetic
// phone is never typeable, so the flow is guardian-only. Instead of letting
// the request 403 with a misleading "own record" error, the tab explains
// itself and disables submission while a dependent profile is active.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth/core/providers/dependents_provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/features/investigations/widgets/investigation_upload_tab.dart';
import 'package:vhhealth/generated/app_localizations.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'viewing a dependent shows the switch-back notice and disables submit',
    (tester) async {
      await tester.pumpWidget(
        _Harness(
          dependents: _FakeDependentsProvider(
            const Dependent(
              id: 55,
              uid: 'dep-uid-55',
              name: 'Anu',
              isMinor: true,
            ),
          ),
          child: InvestigationUploadTab(onUploaded: () {}),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.textContaining("aren't available while viewing Anu's profile"),
        findsOneWidget,
      );

      final submit = tester.widget<ElevatedButton>(
        find.widgetWithText(ElevatedButton, 'Submit request'),
      );
      expect(submit.onPressed, isNull);
    },
  );

  testWidgets('own profile keeps the submit flow enabled with no notice', (
    tester,
  ) async {
    await tester.pumpWidget(
      _Harness(
        dependents: _FakeDependentsProvider(null),
        child: InvestigationUploadTab(onUploaded: () {}),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining("aren't available while viewing"), findsNothing);

    final submit = tester.widget<ElevatedButton>(
      find.widgetWithText(ElevatedButton, 'Submit request'),
    );
    expect(submit.onPressed, isNotNull);
  });
}

class _FakeUserProvider extends UserProvider {
  @override
  String get phone => '9876543210';

  @override
  String get name => 'Guardian';
}

class _FakeDependentsProvider extends DependentsProvider {
  _FakeDependentsProvider(this._dep);

  final Dependent? _dep;

  @override
  Dependent? get activeDependent => _dep;

  @override
  bool get isViewingDependent => _dep != null;
}

class _Harness extends StatelessWidget {
  const _Harness({required this.dependents, required this.child});

  final DependentsProvider dependents;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider<UserProvider>.value(value: _FakeUserProvider()),
        ChangeNotifierProvider<DependentsProvider>.value(value: dependents),
      ],
      child: MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: Scaffold(body: child),
      ),
    );
  }
}
