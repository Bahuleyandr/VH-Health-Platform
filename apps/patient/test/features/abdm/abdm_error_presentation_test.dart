import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth/core/outage/patient_outage_controller.dart';
import 'package:vhhealth/core/services/abdm_api_service.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/services/patient_session_authority.dart';
import 'package:vhhealth/features/abdm/screens/abdm_screen.dart';
import 'package:vhhealth/features/abdm/widgets/abha_enrolment_flow.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth_core/services/http_client.dart';

import '../../support/patient_session_test_authority.dart';

const _serverDetail = 'Untranslated server detail: synthetic-only';

Widget _harness(Widget child, String locale) => MaterialApp(
  locale: Locale(locale),
  localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales,
  home: Scaffold(body: child),
);

http.Response _json(Object body, int status) =>
    http.Response(jsonEncode(body), status);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late PatientOutageController outage;

  setUp(() {
    const channel = MethodChannel(
      'plugins.it_nomads.com/flutter_secure_storage',
    );
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          if (call.method == 'read') {
            final key = (call.arguments as Map)['key'];
            return key == 'jwt' ? 'patient-session' : 'patient-1';
          }
          return null;
        });
    installCurrentPatientSessionAuthority();
    outage = PatientOutageController.forTesting(
      request: () => throw StateError('No readiness network allowed'),
      authentication: () async => 'patient-session',
      tenantId: () async => 'tenant-a',
      maxClockSkew: const Duration(seconds: 5),
    )..markAvailableForTesting();
    PatientOutageController.setForTesting(outage);
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
    PatientOutageController.resetAfterTesting();
    PatientSessionAuthority.resetAfterTesting();
    outage.dispose();
  });

  test('a rejected consent-list fetch is not an empty list', () async {
    VHHttpClient.setClientForTesting(
      MockClient((_) async => _json({'message': _serverDetail}, 403)),
    );
    await expectLater(
      AbdmApiService.getConsents(),
      throwsA(isA<AbdmException>()),
    );
  });

  for (final data in <Object?>[
    null,
    {},
    {'consents': null},
    {'consents': 'bad'},
    {
      'consents': [null],
    },
  ]) {
    test('a malformed consent-list response is not empty: $data', () async {
      VHHttpClient.setClientForTesting(
        MockClient((_) async => _json({'data': data}, 200)),
      );
      await expectLater(AbdmApiService.getConsents(), throwsFormatException);
    });
  }

  test('an authoritative empty consent list remains empty', () async {
    VHHttpClient.setClientForTesting(
      MockClient(
        (_) async => _json({
          'data': {'consents': []},
        }, 200),
      ),
    );
    expect(await AbdmApiService.getConsents(), isEmpty);
  });

  test('the current backend array envelope remains supported', () async {
    final consent = {
      'id': 8,
      'status': 'REQUESTED',
      'purpose': 'Synthetic test',
    };
    VHHttpClient.setClientForTesting(
      MockClient(
        (_) async => _json({
          'data': [consent],
        }, 200),
      ),
    );
    expect(await AbdmApiService.getConsents(), [consent]);
  });

  for (final locale in ['en', 'hi', 'ta', 'te', 'ml']) {
    for (final stage in ['start', 'otp', 'resend']) {
      testWidgets('enrolment $stage transport error is safe in $locale', (
        tester,
      ) async {
        final l = await AppLocalizations.delegate.load(Locale(locale));
        VHHttpClient.setClientForTesting(
          MockClient((request) async {
            if (request.url.path.endsWith('/enrolment/$stage')) {
              throw StateError(_serverDetail);
            }
            expect(request.url.path, endsWith('/enrolment/start'));
            return _json({
              'data': {
                'session': {'id': 99, 'status': 'otp_sent'},
              },
            }, 201);
          }),
        );
        await tester.pumpWidget(
          _harness(
            AbhaEnrolmentFlow(onEnrolled: () {}, onCancelled: () {}),
            locale,
          ),
        );
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const ValueKey('enrolment_aadhaar')),
          '234567890123',
        );
        await tester.tap(find.byKey(const ValueKey('enrolment_start')));
        await tester.pumpAndSettle();
        if (stage == 'otp') {
          await tester.enterText(
            find.byKey(const ValueKey('enrolment_otp')),
            '123456',
          );
          await tester.tap(find.byKey(const ValueKey('enrolment_verify')));
          await tester.pumpAndSettle();
        } else if (stage == 'resend') {
          await tester.pump(const Duration(seconds: 31));
          await tester.tap(find.text(l.abhaEnrolResendOtp));
          await tester.pumpAndSettle();
        }
        expect(find.text(l.networkError), findsOneWidget);
        expect(find.textContaining(_serverDetail), findsNothing);
        expect(find.byKey(const ValueKey('enrolment_done')), findsNothing);
        outage.markAvailableForTesting();
        await tester.pumpWidget(const SizedBox.shrink());
      });
    }

    for (final action in ['grant', 'deny', 'revoke']) {
      for (final outcome in ['rejected', 'exception', 'accepted']) {
        testWidgets(
          '$action uses canonical identity and $locale $outcome state',
          (tester) async {
            final l = await AppLocalizations.delegate.load(Locale(locale));
            final actionLabel = switch (action) {
              'grant' => l.abdmConsentGrantAction,
              'deny' => l.abdmConsentDenyAction,
              _ => l.abdmConsentRevokeAction,
            };
            final failureLabel = switch (action) {
              'grant' => l.abdmConsentGrantFailed,
              'deny' => l.abdmConsentDenyFailed,
              _ => l.abdmConsentRevokeFailed,
            };
            final successLabel = switch (action) {
              'grant' => l.abdmConsentGrantSuccess,
              'deny' => l.abdmConsentDenySuccess,
              _ => l.abdmConsentRevokeSuccess,
            };
            final posts = <String>[];
            var reads = 0;
            VHHttpClient.setClientForTesting(
              MockClient((request) async {
                if (request.method == 'GET') {
                  reads++;
                  if (reads > 1) return _json({'message': _serverDetail}, 403);
                  return _json({
                    'data': [
                      {
                        'id': 41,
                        'consent_id': 'consent-wire-1',
                        'status': action == 'revoke' ? 'GRANTED' : 'REQUESTED',
                        'requester_name': 'Synthetic requester',
                        'date_range_from': '2026-09-01',
                        'date_range_to': '2026-09-30',
                        'purpose': 'Synthetic purpose',
                      },
                    ],
                  }, 200);
                }
                posts.add(request.url.path);
                if (outcome == 'exception') throw StateError(_serverDetail);
                return outcome == 'accepted'
                    ? _json({'success': true}, 200)
                    : _json({'message': _serverDetail}, 403);
              }),
            );
            await tester.pumpWidget(
              _harness(
                AbdmScreen(
                  loadLinkage: () async => const AbhaLinkage(linked: false),
                ),
                locale,
              ),
            );
            await tester.pumpAndSettle();
            await tester.tap(find.text(l.abdmConsentRequestsTab));
            await tester.pumpAndSettle();
            expect(
              find.text(l.abdmConsentRequestedBy('Synthetic requester')),
              findsOneWidget,
            );
            expect(
              find.text(l.abdmConsentPeriod('2026-09-01', '2026-09-30')),
              findsOneWidget,
            );
            await tester.tap(find.text(actionLabel));
            await tester.pumpAndSettle();
            await tester.tap(
              find.descendant(
                of: find.byType(AlertDialog),
                matching: find.text(actionLabel),
              ),
            );
            await tester.pumpAndSettle();
            expect(posts, ['/api/v1/abdm/consents/consent-wire-1/$action']);
            expect(find.text(_serverDetail), findsNothing);
            if (outcome == 'accepted') {
              expect(find.text(successLabel), findsOneWidget);
              expect(find.text(l.abdmConsentLoadFailed), findsOneWidget);
              expect(find.text(l.abdmNoConsents), findsNothing);
              expect(find.text('Synthetic purpose'), findsNothing);
              expect(reads, 2);
            } else {
              expect(find.text(failureLabel), findsOneWidget);
              expect(find.text(successLabel), findsNothing);
              expect(reads, 1);
            }
            expect(tester.takeException(), isNull);
            outage.markAvailableForTesting();
          },
        );
      }
    }

    for (final stage in ['start', 'otp', 'resend']) {
      testWidgets('enrolment $stage failure uses $locale without server text', (
        tester,
      ) async {
        final l = await AppLocalizations.delegate.load(Locale(locale));
        final expected = switch (stage) {
          'start' => l.abhaEnrolStartFailed,
          'otp' => l.abhaEnrolOtpFailed,
          _ => l.abhaEnrolResendFailed,
        };
        VHHttpClient.setClientForTesting(
          MockClient((request) async {
            if (request.url.path.endsWith('/enrolment/$stage')) {
              return _json({'code': 'UNKNOWN', 'message': _serverDetail}, 400);
            }
            expect(request.url.path, endsWith('/enrolment/start'));
            return _json({
              'data': {
                'session': {'id': 99, 'status': 'otp_sent'},
              },
            }, 201);
          }),
        );
        await tester.pumpWidget(
          _harness(
            AbhaEnrolmentFlow(onEnrolled: () {}, onCancelled: () {}),
            locale,
          ),
        );
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const ValueKey('enrolment_aadhaar')),
          '234567890123',
        );
        await tester.tap(find.byKey(const ValueKey('enrolment_start')));
        await tester.pumpAndSettle();
        if (stage == 'otp') {
          await tester.enterText(
            find.byKey(const ValueKey('enrolment_otp')),
            '123456',
          );
          await tester.tap(find.byKey(const ValueKey('enrolment_verify')));
          await tester.pumpAndSettle();
        } else if (stage == 'resend') {
          await tester.pump(const Duration(seconds: 31));
          await tester.tap(find.text(l.abhaEnrolResendOtp));
          await tester.pumpAndSettle();
        }
        expect(find.text(expected), findsOneWidget);
        expect(find.text(_serverDetail), findsNothing);
        expect(find.byKey(const ValueKey('enrolment_done')), findsNothing);
        await tester.pumpWidget(const SizedBox.shrink());
      });
    }

    testWidgets('status failure uses $locale, never server text', (
      tester,
    ) async {
      final l = await AppLocalizations.delegate.load(Locale(locale));
      await tester.pumpWidget(
        _harness(
          MyAbhaTab(
            loadLinkage: () async => throw AbdmException.fromResponse(
              const ApiResponse(
                statusCode: 403,
                isSuccess: false,
                message: _serverDetail,
              ),
            ),
          ),
          locale,
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text(l.abdmStatusCheckFailedDetail), findsOneWidget);
      expect(find.text(_serverDetail), findsNothing);
      expect(find.byKey(const ValueKey('abha_retry')), findsOneWidget);
      expect(find.byKey(const ValueKey('abha_info')), findsNothing);
    });

    testWidgets('unknown link failure uses $locale without erasing input', (
      tester,
    ) async {
      final l = await AppLocalizations.delegate.load(Locale(locale));
      await tester.pumpWidget(
        _harness(
          MyAbhaTab(
            loadLinkage: () async => const AbhaLinkage(linked: false),
            linkAbha: ({required abhaNumber, abhaAddress}) async =>
                throw AbdmException.fromResponse(
                  const ApiResponse(
                    statusCode: 400,
                    isSuccess: false,
                    message: _serverDetail,
                  ),
                ),
          ),
          locale,
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text(l.abdmRegister));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.widgetWithText(TextFormField, l.abdmNumberRequiredLabel),
        '12345678901234',
      );
      await tester.tap(find.byKey(const ValueKey('abha_link_submit')));
      await tester.pumpAndSettle();
      expect(find.text(l.abdmLinkFailed), findsOneWidget);
      expect(find.text(_serverDetail), findsNothing);
      expect(find.text('12345678901234'), findsOneWidget);
      expect(find.byKey(const ValueKey('abha_link_form')), findsOneWidget);
      expect(find.byKey(const ValueKey('abha_card')), findsNothing);
    });

    testWidgets(
      'failed consent load in $locale offers retry, not empty state',
      (tester) async {
        final l = await AppLocalizations.delegate.load(Locale(locale));
        var fail = true;
        VHHttpClient.setClientForTesting(
          MockClient((request) async {
            expect(request.url.path, endsWith('/abdm/consents'));
            return fail
                ? _json({'message': _serverDetail}, 403)
                : _json({
                    'data': {'consents': []},
                  }, 200);
          }),
        );
        await tester.pumpWidget(
          _harness(
            AbdmScreen(
              loadLinkage: () async => const AbhaLinkage(linked: false),
            ),
            locale,
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text(l.abdmConsentRequestsTab));
        await tester.pumpAndSettle();
        expect(find.text(l.abdmNoConsents), findsNothing);
        expect(find.text(_serverDetail), findsNothing);
        expect(
          find.byKey(const ValueKey('abdm_consents_error')),
          findsOneWidget,
        );
        fail = false;
        await tester.tap(find.byKey(const ValueKey('abdm_consents_retry')));
        await tester.pumpAndSettle();
        expect(find.text(l.abdmNoConsents), findsOneWidget);
        expect(find.byKey(const ValueKey('abdm_consents_error')), findsNothing);
      },
    );
  }

  for (final status in ['REQUESTED', 'GRANTED']) {
    for (final identity in <String?>[null, '', '   ']) {
      testWidgets(
        'missing canonical identity $identity disables $status actions',
        (tester) async {
          final l = await AppLocalizations.delegate.load(const Locale('en'));
          var posts = 0;
          VHHttpClient.setClientForTesting(
            MockClient((request) async {
              if (request.method == 'POST') posts++;
              return _json({
                'data': [
                  {'id': 41, 'consent_id': identity, 'status': status},
                ],
              }, 200);
            }),
          );
          await tester.pumpWidget(
            _harness(
              AbdmScreen(
                loadLinkage: () async => const AbhaLinkage(linked: false),
              ),
              'en',
            ),
          );
          await tester.pumpAndSettle();
          await tester.tap(find.text(l.abdmConsentRequestsTab));
          await tester.pumpAndSettle();
          expect(find.text(l.abdmConsentRequesterUnknown), findsNothing);
          expect(
            find.text(l.abdmConsentRequestedBy(l.abdmConsentRequesterUnknown)),
            findsOneWidget,
          );
          expect(find.text(l.abdmConsentPurposeFallback), findsOneWidget);
          final actions = status == 'REQUESTED'
              ? [l.abdmConsentGrantAction, l.abdmConsentDenyAction]
              : [l.abdmConsentRevokeAction];
          for (final label in actions) {
            final button = tester.widget<ButtonStyleButton>(
              find.ancestor(
                of: find.text(label),
                matching: find.byWidgetPredicate(
                  (widget) => widget is ButtonStyleButton,
                ),
              ),
            );
            expect(button.onPressed, isNull);
            await tester.tap(find.text(label));
          }
          await tester.pumpAndSettle();
          expect(posts, 0);
          expect(find.byType(AlertDialog), findsNothing);
        },
      );
    }
  }

  test('consent identities are a single encoded path component', () async {
    const identity = 'consent/with ?#%';
    final urls = <Uri>[];
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        urls.add(request.url);
        return _json({'success': true}, 200);
      }),
    );
    await AbdmApiService.grantConsent(identity);
    await AbdmApiService.denyConsent(identity);
    await AbdmApiService.revokeConsent(identity);
    expect(urls, hasLength(3));
    for (final url in urls) {
      expect(url.pathSegments[url.pathSegments.length - 2], identity);
      expect(url.query, isEmpty);
      expect(url.fragment, isEmpty);
    }
    await expectLater(AbdmApiService.grantConsent(' '), throwsArgumentError);
    expect(urls, hasLength(3));
  });

  testWidgets('a pending consent read can finish after disposal', (
    tester,
  ) async {
    final pending = Completer<http.Response>();
    var reads = 0;
    VHHttpClient.setClientForTesting(
      MockClient((_) {
        reads++;
        return pending.future;
      }),
    );
    final l = await AppLocalizations.delegate.load(const Locale('en'));
    await tester.pumpWidget(
      _harness(
        AbdmScreen(loadLinkage: () async => const AbhaLinkage(linked: false)),
        'en',
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text(l.abdmConsentRequestsTab));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump();
    expect(reads, 1);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
    pending.complete(_json({'data': []}, 200));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
