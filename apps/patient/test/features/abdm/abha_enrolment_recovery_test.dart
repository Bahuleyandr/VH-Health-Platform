// ABHA self-enrolment: recovering from a blocked start (re-audit lane L).
//
// The backend keeps ONE live enrolment session per patient. A patient who
// backgrounded or killed the app mid-flow lost the session id, came back to a
// blank Aadhaar form, pressed Send OTP, and got a 409
// ABHA_ENROLMENT_IN_PROGRESS shown as "could not start, please retry" —
// retrying could not work, and nothing in the app could cancel the session
// either.
//
// The way out is to CANCEL the blocking session and start a new one. It is
// deliberately not "resume the old session at the OTP step": that session was
// created from whatever Aadhaar the abandoned attempt used, the backend
// stores no Aadhaar and exposes no identifier for one, and
// `resendEnrolmentOtp` checks only the FORMAT of what it is sent — so a
// resumed session could have verified or re-sent an OTP for a DIFFERENT
// number than the one on screen, with nothing anywhere able to notice. These
// tests pin the recovery, and pin that the session the flow ends up verifying
// is always one it started itself.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth/core/outage/patient_outage_controller.dart';
import 'package:vhhealth/core/services/patient_session_authority.dart';
import 'package:vhhealth/features/abdm/widgets/abha_enrolment_flow.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth_core/services/http_client.dart';

import '../../support/patient_session_test_authority.dart';

/// Any 12 digits: the widget's own validator is a length check, and the
/// Verhoeff check lives server-side.
const _aadhaar = '234567890123';

/// The session that is holding the one-live-session slot. It was started by
/// an attempt this widget knows nothing about, so its Aadhaar is unknown —
/// which is the whole reason it must not be adopted.
const _blockingSessionId = 77;

/// The session THIS flow starts, from the digits in the form.
const _ownSessionId = 99;

Widget _harness() => MaterialApp(
  localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales,
  home: Scaffold(
    body: AbhaEnrolmentFlow(onEnrolled: () {}, onCancelled: () {}),
  ),
);

Future<void> _sendOtp(WidgetTester tester) async {
  await tester.enterText(
    find.byKey(const ValueKey('enrolment_aadhaar')),
    _aadhaar,
  );
  await tester.tap(find.byKey(const ValueKey('enrolment_start')));
  await tester.pumpAndSettle();
}

http.Response _json(Object body, int status) =>
    http.Response(jsonEncode(body), status);

http.Response _inProgress() =>
    _json({'code': 'ABHA_ENROLMENT_IN_PROGRESS'}, 409);

http.Response _statusOf(Map<String, dynamic>? session) => _json({
  'data': {'session': session},
}, 200);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late PatientOutageController outage;

  setUp(() {
    _installSecureStorageFake();
    installCurrentPatientSessionAuthority();
    outage = PatientOutageController.forTesting(
      request: () => throw StateError('readiness network must not be needed'),
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

  testWidgets('a blocked start cancels the live session and starts a new one '
      'from the Aadhaar in the form', (tester) async {
    final calls = <String>[];
    final startBodies = <String>[];
    String? cancelBody;
    String? resendBody;

    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        calls.add('${request.method} ${request.url.path}');
        if (request.url.path.endsWith('/enrolment/start')) {
          startBodies.add(request.body);
          if (startBodies.length == 1) return _inProgress();
          return _json({
            'success': true,
            'data': {
              'session': {
                'id': _ownSessionId,
                'status': 'otp_sent',
                'mobile_last4': '4321',
              },
            },
          }, 201);
        }
        if (request.url.path.endsWith('/enrolment/status')) {
          return _statusOf({
            'id': _blockingSessionId,
            'status': 'otp_sent',
            // A different mobile: this session is NOT the patient's current
            // attempt, and nothing in the payload says which Aadhaar it holds.
            'mobile_last4': '1111',
          });
        }
        if (request.url.path.endsWith('/enrolment/cancel')) {
          cancelBody = request.body;
          return _json({'success': true}, 200);
        }
        if (request.url.path.endsWith('/enrolment/resend')) {
          resendBody = request.body;
          return _json({'success': true}, 200);
        }
        return _json({}, 404);
      }),
    );

    await tester.pumpWidget(_harness());
    await tester.pumpAndSettle();
    await _sendOtp(tester);

    expect(calls, [
      'POST /api/v1/portal/abdm/enrolment/start',
      'GET /api/v1/portal/abdm/enrolment/status',
      'POST /api/v1/portal/abdm/enrolment/cancel',
      'POST /api/v1/portal/abdm/enrolment/start',
    ]);
    expect(
      jsonDecode(cancelBody!) as Map<String, dynamic>,
      containsPair('session_id', _blockingSessionId),
    );

    // Both starts carried the number the patient actually typed.
    for (final body in startBodies) {
      expect(
        (jsonDecode(body) as Map<String, dynamic>)['aadhaar_number'],
        _aadhaar,
      );
    }

    // The OTP step describes the session this flow started — not the one it
    // cancelled, whose masked mobile was '1111'.
    final en = await AppLocalizations.delegate.load(const Locale('en'));
    expect(find.byKey(const ValueKey('enrolment_otp')), findsOneWidget);
    expect(find.text(en.abhaEnrolOtpIntroMasked('4321')), findsOneWidget);
    expect(find.text(en.abhaEnrolOtpIntroMasked('1111')), findsNothing);

    // ...and so does Resend, which posts a freshly typed Aadhaar the backend
    // can only format-check. Bound to session 99, that number is by
    // construction the one the session was created from.
    // (A fresh start arms the 30s resend cooldown; run it out so the button
    // is enabled. pumpAndSettle alone stops between the timer's ticks.)
    await tester.pump(const Duration(seconds: 31));
    await tester.pumpAndSettle();
    await tester.tap(find.text(en.abhaEnrolResendOtp));
    await tester.pumpAndSettle();
    final resend = jsonDecode(resendBody!) as Map<String, dynamic>;
    expect(resend['session_id'], _ownSessionId);
    expect(resend['aadhaar_number'], _aadhaar);
  });

  testWidgets('an in-flight OTP verification is not cancelled under, and the '
      'patient is told why', (tester) async {
    final calls = <String>[];
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        calls.add('${request.method} ${request.url.path}');
        if (request.url.path.endsWith('/enrolment/start')) {
          return _inProgress();
        }
        if (request.url.path.endsWith('/enrolment/status')) {
          return _statusOf({
            'id': _blockingSessionId,
            'status': 'otp_verifying',
          });
        }
        if (request.url.path.endsWith('/enrolment/cancel')) {
          // The backend refuses while a verifier may still be inside the
          // gateway call — cancelling under it could strand an ABHA the
          // gateway has already minted.
          return _json({'code': 'ABHA_ENROLMENT_VERIFY_IN_PROGRESS'}, 409);
        }
        return _json({}, 404);
      }),
    );

    await tester.pumpWidget(_harness());
    await tester.pumpAndSettle();
    await _sendOtp(tester);

    // No second start: the slot is genuinely still taken.
    expect(calls, [
      'POST /api/v1/portal/abdm/enrolment/start',
      'GET /api/v1/portal/abdm/enrolment/status',
      'POST /api/v1/portal/abdm/enrolment/cancel',
    ]);

    final en = await AppLocalizations.delegate.load(const Locale('en'));
    expect(find.text(en.abhaEnrolVerifyInProgress), findsOneWidget);
    expect(find.textContaining(en.abhaEnrolStartFailed), findsNothing);
    expect(find.byKey(const ValueKey('enrolment_otp')), findsNothing);
    expect(find.byKey(const ValueKey('enrolment_start')), findsOneWidget);
  });

  testWidgets('a session that completed elsewhere lands on the done step', (
    tester,
  ) async {
    final calls = <String>[];
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        calls.add('${request.method} ${request.url.path}');
        if (request.url.path.endsWith('/enrolment/start')) {
          return _inProgress();
        }
        if (request.url.path.endsWith('/enrolment/status')) {
          return _statusOf({
            'id': 12,
            'status': 'linked',
            'abha_number': '12345678901234',
            'abha_address': 'patient@abdm',
          });
        }
        return _json({}, 404);
      }),
    );

    await tester.pumpWidget(_harness());
    await tester.pumpAndSettle();
    await _sendOtp(tester);

    // Nothing is cancelled and nothing is re-started: the enrolment the 409
    // was protecting has already produced an ABHA.
    expect(calls, [
      'POST /api/v1/portal/abdm/enrolment/start',
      'GET /api/v1/portal/abdm/enrolment/status',
    ]);
    expect(find.byKey(const ValueKey('enrolment_done')), findsOneWidget);
    expect(find.text('12345678901234'), findsOneWidget);
    expect(find.text('patient@abdm'), findsOneWidget);
  });

  testWidgets('an unanswerable status probe leaves the ordinary failure '
      'message and cancels nothing', (tester) async {
    final calls = <String>[];
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        calls.add('${request.method} ${request.url.path}');
        if (request.url.path.endsWith('/enrolment/start')) {
          return _inProgress();
        }
        // The probe itself fails, so the flow knows nothing about the slot and
        // must not cancel a session it cannot see.
        return _json({'message': 'nope'}, 500);
      }),
    );

    await tester.pumpWidget(_harness());
    await tester.pumpAndSettle();
    await _sendOtp(tester);

    // The shared HTTP client retries a 5xx GET, so the probe itself shows up
    // more than once; what matters is that it never became an action.
    expect(calls.where((c) => c.endsWith('/enrolment/status')), isNotEmpty);
    expect(calls.where((c) => c.endsWith('/enrolment/cancel')), isEmpty);
    expect(calls.where((c) => c.endsWith('/enrolment/start')), hasLength(1));

    final en = await AppLocalizations.delegate.load(const Locale('en'));
    expect(find.textContaining(en.abhaEnrolStartFailed), findsOneWidget);
  });

  testWidgets('the recovery is attempted once, not looped', (tester) async {
    var statusCalls = 0;
    var startCalls = 0;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        if (request.url.path.endsWith('/enrolment/status')) {
          statusCalls += 1;
          return _statusOf({'id': _blockingSessionId, 'status': 'otp_sent'});
        }
        if (request.url.path.endsWith('/enrolment/cancel')) {
          return _json({'success': true}, 200);
        }
        // Every start is refused, including the one the recovery makes.
        startCalls += 1;
        return _inProgress();
      }),
    );

    await tester.pumpWidget(_harness());
    await tester.pumpAndSettle();
    await _sendOtp(tester);
    await _sendOtp(tester);

    // Two presses, one recovery: the restart the recovery performs cannot
    // recover again, and neither can any later press.
    expect(statusCalls, 1);
    expect(startCalls, 3); // press 1, its recovery restart, press 2
    final en = await AppLocalizations.delegate.load(const Locale('en'));
    expect(find.textContaining(en.abhaEnrolStartFailed), findsOneWidget);
  });
}

void _installSecureStorageFake() {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  final store = <String, String>{
    'jwt': 'patient-session',
    'user_id': 'patient-1',
  };

  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        final args = Map<String, dynamic>.from(call.arguments as Map);
        switch (call.method) {
          case 'read':
            return store[args['key']];
          case 'write':
            store[args['key']] = args['value'] as String;
            return null;
          case 'delete':
            store.remove(args['key']);
            return null;
          case 'readAll':
            return Map<String, String>.from(store);
          case 'deleteAll':
            store.clear();
            return null;
          case 'containsKey':
            return store.containsKey(args['key']);
          default:
            return null;
        }
      });
}
