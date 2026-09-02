import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/models/api_response.dart';
import 'package:vhhealth_staff/features/dietary/screens/dietary_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  testWidgets(
    'initial dietary failure resolves Malayalam after dependencies exist',
    (tester) async {
      final strings = AppStrings.forLocale(const Locale('ml'));

      await tester.pumpWidget(
        MaterialApp(
          locale: const Locale('ml'),
          supportedLocales: AppStrings.supportedLocales,
          localizationsDelegates: const [
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          home: DietaryScreen(
            loadOrders: () async => const ApiResponse(
              statusCode: 400,
              isSuccess: false,
              raw: <String, dynamic>{},
            ),
          ),
        ),
      );
      for (var attempt = 0; attempt < 30; attempt += 1) {
        await tester.pump(const Duration(milliseconds: 100));
        if (find.text(strings.dietaryLoadFailed).evaluate().isNotEmpty) break;
      }

      expect(find.text(strings.dietaryLoadFailed), findsOneWidget);
      expect(find.text('Failed to load dietary orders'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );
}
