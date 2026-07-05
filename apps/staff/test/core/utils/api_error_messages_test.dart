import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/models/api_response.dart';
import 'package:vhhealth_staff/core/utils/api_error_messages.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  test('stripExceptionPrefix removes repeated Exception prefixes', () {
    expect(
      stripExceptionPrefix('Exception: Exception: Failed to load'),
      'Failed to load',
    );
  });

  test('localizedApiErrorFromRaw maps transport failures to offline copy', () {
    final strings = AppStrings.forLocale(const Locale('en'));

    expect(
      localizedApiErrorFromRaw(
        strings,
        "Exception: SocketException: Failed host lookup: 'api.local'",
      ),
      "You're offline — will retry.",
    );
    expect(
      localizedApiErrorFromRaw(
        strings,
        "Exception: ClientException: Failed to fetch",
        queued: true,
      ),
      "You're offline — queued for sync.",
    );
  });

  test('localizedApiErrorFromRaw maps generic 403s with request refs', () {
    final strings = AppStrings.forLocale(const Locale('en'));

    expect(
      localizedApiErrorFromRaw(
        strings,
        const ApiResponse(
          statusCode: 403,
          isSuccess: false,
          message: 'Forbidden',
          requestId: 'req-9000123',
        ),
      ),
      "You don't have permission for this action. · ref req-9000",
    );
    expect(
      localizedApiErrorFromRaw(
        strings,
        'Exception: 403 Forbidden · ref abc123',
      ),
      "You don't have permission for this action. · ref abc123",
    );
  });

  test('localizedApiErrorFromRaw maps legacy thrown device gate codes', () {
    final strings = AppStrings.forLocale(const Locale('en'));

    expect(
      localizedApiErrorFromRaw(
        strings,
        'Exception: $clinicalWriteDesktopOnlyCode · ref gate-1234',
      ),
      'Clinical write actions must be completed from the desktop/tablet Staff app. · ref gate-123',
    );
  });

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
