import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/features/your_health/models/whats_next_item.dart';
import 'package:vhhealth/features/your_health/services/whats_next_repository.dart';
import 'package:vhhealth/features/your_health/widgets/whats_next_section.dart';
import 'package:vhhealth/generated/app_localizations.dart';

void main() {
  testWidgets('shows care-plan goals and follow-ups', (tester) async {
    await tester.pumpWidget(
      _LocalizedHarness(
        child: WhatsNextSection(
          repository: _FakeWhatsNextRepository(
            const WhatsNextBundle(
              goals: [
                WhatsNextGoal(
                  id: 1,
                  carePlanId: 10,
                  carePlanName: 'Diabetes care plan',
                  description: 'Keep fasting sugar under 110',
                  priority: 'high',
                  status: 'in_progress',
                  targetValue: '110',
                  currentValue: '128',
                ),
              ],
              followUps: [
                WhatsNextFollowUp(
                  id: 2,
                  carePlanId: 10,
                  carePlanName: 'Diabetes care plan',
                  reason: 'Diabetes review',
                  status: 'open',
                  appointmentStatus: 'pending',
                ),
              ],
            ),
          ),
        ),
      ),
    );

    await tester.pumpAndSettle();

    expect(find.text("What's next"), findsOneWidget);
    expect(find.text('Goals'), findsOneWidget);
    expect(find.text('Keep fasting sugar under 110'), findsOneWidget);
    expect(find.text('Follow-ups'), findsOneWidget);
    expect(find.text('Diabetes review'), findsOneWidget);
    expect(find.textContaining('Diabetes care plan'), findsWidgets);
  });

  testWidgets('hides section when no active care-plan content is returned', (
    tester,
  ) async {
    await tester.pumpWidget(
      _LocalizedHarness(
        child: WhatsNextSection(
          repository: _FakeWhatsNextRepository(
            const WhatsNextBundle(goals: [], followUps: []),
          ),
        ),
      ),
    );

    await tester.pumpAndSettle();

    expect(find.text("What's next"), findsNothing);
  });
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

class _FakeWhatsNextRepository implements WhatsNextRepository {
  const _FakeWhatsNextRepository(this.bundle);

  final WhatsNextBundle bundle;

  @override
  Future<WhatsNextBundle> getWhatsNext() async => bundle;
}
