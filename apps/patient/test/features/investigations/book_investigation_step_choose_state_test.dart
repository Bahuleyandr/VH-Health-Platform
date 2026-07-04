import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/features/investigations/widgets/book_investigation_step_choose.dart';
import 'package:vhhealth/generated/app_localizations.dart';

void main() {
  testWidgets(
    'catalog step shows retryable error state without hiding manual paths',
    (tester) async {
      var retries = 0;
      final controller = TextEditingController();
      addTearDown(controller.dispose);

      await tester.pumpWidget(
        _Harness(
          child: BookInvestigationStepChoose(
            loadingCatalog: false,
            catalogError: 'Unable to load the investigation catalog.',
            groupedCatalog: const {},
            selectedTestIds: const {},
            customTestController: controller,
            slipPhoto: null,
            slipPhotoName: null,
            estimatedCost: 0,
            onSearchChanged: (_) {},
            onCatalogRetry: () => retries += 1,
            onTestToggle: (_, _) {},
            onCustomTestChanged: () {},
            onPickCamera: () {},
            onPickGallery: () {},
            onRemoveSlip: () {},
          ),
        ),
      );

      expect(
        find.text('Something went wrong. Please try again.'),
        findsOneWidget,
      );
      expect(
        find.text('Unable to load the investigation catalog.'),
        findsOneWidget,
      );
      expect(find.text('Or type test names:'), findsOneWidget);
      expect(find.text('Or upload prescription slip:'), findsOneWidget);

      await tester.tap(find.text('Retry'));
      await tester.pump();
      expect(retries, 1);
    },
  );

  testWidgets('catalog step shows friendly empty state for no matching tests', (
    tester,
  ) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);

    await tester.pumpWidget(
      _Harness(
        child: BookInvestigationStepChoose(
          loadingCatalog: false,
          catalogError: null,
          groupedCatalog: const {},
          selectedTestIds: const {},
          customTestController: controller,
          slipPhoto: null,
          slipPhotoName: null,
          estimatedCost: 0,
          onSearchChanged: (_) {},
          onCatalogRetry: () {},
          onTestToggle: (_, _) {},
          onCustomTestChanged: () {},
          onPickCamera: () {},
          onPickGallery: () {},
          onRemoveSlip: () {},
        ),
      ),
    );

    expect(find.text('No tests found'), findsOneWidget);
    expect(find.textContaining('Try another search'), findsOneWidget);
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
      home: Scaffold(body: SingleChildScrollView(child: child)),
    );
  }
}
