import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/widgets/live_region_snack_bar.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('LiveRegionSnackBar', () {
    testWidgets(
      'a representative migrated call site announces via a live region',
      (tester) async {
        final semantics = tester.ensureSemantics();
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: Builder(
                builder: (context) => ElevatedButton(
                  onPressed: () {
                    // Shape of a typical migrated call site (was a raw
                    // ScaffoldMessenger...showSnackBar(SnackBar(...))).
                    ScaffoldMessenger.of(context).showSnackBar(
                      LiveRegionSnackBar.build(
                        message: 'Request refill submitted',
                        backgroundColor: Colors.green,
                        behavior: SnackBarBehavior.floating,
                      ),
                    );
                  },
                  child: const Text('submit'),
                ),
              ),
            ),
          ),
        );

        await tester.tap(find.text('submit'));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 750));

        expect(find.text('Request refill submitted'), findsOneWidget);
        expect(
          tester.getSemantics(
            find.bySemanticsLabel(RegExp('Request refill submitted')),
          ),
          isSemantics(isLiveRegion: true),
        );

        final snackBar = tester.widget<SnackBar>(find.byType(SnackBar));
        expect(snackBar.backgroundColor, Colors.green);
        expect(snackBar.behavior, SnackBarBehavior.floating);
        semantics.dispose();
      },
    );

    testWidgets('supports margin and shape for styled call sites', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      final shape = RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(8),
      );
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: Container())));

      final context = tester.element(find.byType(Scaffold));
      ScaffoldMessenger.of(context).showSnackBar(
        LiveRegionSnackBar.build(
          message: 'Thank you for your feedback!',
          behavior: SnackBarBehavior.floating,
          margin: const EdgeInsets.all(16),
          shape: shape,
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 750));

      final snackBar = tester.widget<SnackBar>(find.byType(SnackBar));
      expect(snackBar.margin, const EdgeInsets.all(16));
      expect(snackBar.shape, shape);
      expect(
        tester.getSemantics(
          find.bySemanticsLabel(RegExp('Thank you for your feedback!')),
        ),
        isSemantics(isLiveRegion: true),
      );
      semantics.dispose();
    });
  });
}
