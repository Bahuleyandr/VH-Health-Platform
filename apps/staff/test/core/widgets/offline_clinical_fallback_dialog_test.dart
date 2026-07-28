import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/widgets/offline_clinical_fallback_dialog.dart';
import 'package:vhhealth_staff/features/doctor/prescription_offline_rx.dart';
import 'package:vhhealth_staff/features/ipd/drug_chart_offline_order.dart';

void main() {
  testWidgets(
    'prescription fallback performs zero enqueue or reset and keeps form data',
    (tester) async {
      final controller = TextEditingController(text: 'Paracetamol 500 mg');
      addTearDown(controller.dispose);
      var enqueueCalls = 0;
      var resetCalls = 0;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => Column(
                children: [
                  TextField(controller: controller),
                  FilledButton(
                    onPressed: () async {
                      final disposition = prescriptionSubmissionDisposition(
                        isOnline: false,
                      );
                      if (disposition ==
                          PrescriptionSubmissionDisposition.usePaperFallback) {
                        await showOfflineClinicalFallbackDialog(
                          context,
                          paperFormSet: 'OPD prescription pads',
                        );
                        return;
                      }
                      enqueueCalls++;
                      controller.clear();
                      resetCalls++;
                    },
                    child: const Text('Submit prescription'),
                  ),
                ],
              ),
            ),
          ),
        ),
      );

      await tester.tap(find.text('Submit prescription'));
      await tester.pumpAndSettle();

      expect(
        find.text(
          'This action was not saved for automatic sync. Use the '
          "department's OPD prescription pads and follow the downtime "
          'reconciliation procedure. Keep the entered information open until '
          'it has been transferred to paper.',
        ),
        findsOneWidget,
      );
      expect(enqueueCalls, 0);
      expect(resetCalls, 0);
      expect(controller.text, 'Paracetamol 500 mg');

      await tester.tap(find.text('Keep form open'));
      await tester.pumpAndSettle();

      expect(controller.text, 'Paracetamol 500 mg');
    },
  );

  testWidgets(
    'drug-chart fallback performs zero enqueue or removal and keeps draft row',
    (tester) async {
      final controller = TextEditingController(text: 'Ceftriaxone 1 g');
      addTearDown(controller.dispose);
      var enqueueCalls = 0;
      var removalCalls = 0;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => Column(
                children: [
                  TextField(controller: controller),
                  FilledButton(
                    onPressed: () async {
                      final disposition = drugChartSubmissionDisposition(
                        isOnline: false,
                      );
                      if (disposition ==
                          DrugChartSubmissionDisposition.usePaperFallback) {
                        await showOfflineClinicalFallbackDialog(
                          context,
                          paperFormSet: 'inpatient drug charts',
                        );
                        return;
                      }
                      enqueueCalls++;
                      controller.clear();
                      removalCalls++;
                    },
                    child: const Text('Save drug-chart row'),
                  ),
                ],
              ),
            ),
          ),
        ),
      );

      await tester.tap(find.text('Save drug-chart row'));
      await tester.pumpAndSettle();

      expect(
        find.text(
          'This action was not saved for automatic sync. Use the '
          "department's inpatient drug charts and follow the downtime "
          'reconciliation procedure. Keep the entered information open until '
          'it has been transferred to paper.',
        ),
        findsOneWidget,
      );
      expect(enqueueCalls, 0);
      expect(removalCalls, 0);
      expect(controller.text, 'Ceftriaxone 1 g');

      await tester.tap(find.text('Keep form open'));
      await tester.pumpAndSettle();

      expect(controller.text, 'Ceftriaxone 1 g');
    },
  );
}
