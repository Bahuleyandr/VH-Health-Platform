import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/models/api_response.dart';
import 'package:vhhealth_staff/core/utils/api_error_messages.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  testWidgets('localizedApiFailureMessage maps clinical device gates', (
    tester,
  ) async {
    late String message;
    await tester.pumpWidget(
      MaterialApp(
        locale: const Locale('en'),
        supportedLocales: AppStrings.supportedLocales,
        localizationsDelegates: const [
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: Builder(
          builder: (context) {
            message = localizedApiFailureMessage(
              context,
              const ApiResponse(
                statusCode: 403,
                isSuccess: false,
                code: clinicalWriteDesktopOnlyCode,
                requestId: 'req-123456',
              ),
            );
            return const SizedBox.shrink();
          },
        ),
      ),
    );

    expect(
      message,
      'Clinical write actions must be completed from the desktop/tablet Staff app. · ref req-1234',
    );
  });

  testWidgets('localizedApiErrorFromRaw maps legacy error_code envelopes', (
    tester,
  ) async {
    late String message;
    await tester.pumpWidget(
      MaterialApp(
        locale: const Locale('hi'),
        supportedLocales: AppStrings.supportedLocales,
        localizationsDelegates: const [
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: Builder(
          builder: (context) {
            message = localizedApiErrorFromRaw(AppStrings.of(context), const {
              'error_code': deviceTypeMissingCode,
              'message': 'backend raw message',
            });
            return const SizedBox.shrink();
          },
        ),
      ),
    );

    expect(
      message,
      'कृपया फिर से साइन इन करें ताकि ऐप इस डिवाइस की पुष्टि कर सके।',
    );
  });
}
