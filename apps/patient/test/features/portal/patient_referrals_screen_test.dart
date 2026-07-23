import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/features/portal/models/patient_referral.dart';
import 'package:vhhealth/features/portal/screens/patient_referrals_screen.dart';
import 'package:vhhealth/features/portal/services/patient_referrals_repository.dart';
import 'package:vhhealth/generated/app_localizations.dart';

void main() {
  testWidgets('shows only the signed patient-safe referral update', (
    tester,
  ) async {
    final referral = PatientReferral(
      id: 42,
      number: 'REF-42',
      department: 'Cardiology',
      status: 'completed',
      closureStatus: 'closed',
      summary: 'Your specialist has reviewed this referral.',
      instructions: 'Follow the plan discussed with your care team.',
      followUpPlan: 'See your primary doctor at follow-up.',
      signedAt: DateTime.utc(2026, 7, 23, 8),
    );

    await tester.pumpWidget(_Harness(_FakeRepository([referral])));
    await tester.pumpAndSettle();

    expect(find.text('Cardiology'), findsOneWidget);
    expect(find.text(referral.summary), findsOneWidget);
    await tester.tap(find.text('Cardiology'));
    await tester.pumpAndSettle();

    expect(find.text(referral.instructions), findsOneWidget);
    expect(find.text(referral.followUpPlan!), findsOneWidget);
  });

  testWidgets('shows a patient-safe empty state', (tester) async {
    await tester.pumpWidget(_Harness(_FakeRepository(const [])));
    await tester.pumpAndSettle();

    expect(find.text('No referral updates yet'), findsOneWidget);
    expect(find.textContaining('Signed specialist'), findsOneWidget);
  });
}

class _Harness extends StatelessWidget {
  const _Harness(this.repository);

  final PatientReferralsRepository repository;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: PatientReferralsScreen(repository: repository),
    );
  }
}

class _FakeRepository implements PatientReferralsRepository {
  const _FakeRepository(this.referrals);

  final List<PatientReferral> referrals;

  @override
  Future<PatientReferralsPage> listReferrals() async =>
      PatientReferralsPage(referrals: referrals);
}
