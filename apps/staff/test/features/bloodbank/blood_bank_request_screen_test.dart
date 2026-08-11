import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/api_client.dart';
import 'package:vhhealth_staff/features/bloodbank/models/blood_request.dart';
import 'package:vhhealth_staff/features/bloodbank/screens/blood_bank_screen.dart';
import 'package:vhhealth_staff/features/bloodbank/services/blood_bank_gateway.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  testWidgets('submits a selected patient using the backend 201 contract', (
    tester,
  ) async {
    final transport = _FakeBloodBankTransport();
    final gateway = ApiBloodBankGateway(transport);
    const patient = BloodRequestPatient(
      uid: 'a9999999-9999-4999-8999-999999999a03',
      name: 'Blood Test Patient',
      hospitalNumber: 'VH-000018',
    );

    await tester.pumpWidget(
      MaterialApp(
        locale: const Locale('en'),
        supportedLocales: AppStrings.supportedLocales,
        localizationsDelegates: const [
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: BloodBankScreen(
          gateway: gateway,
          patientPicker: (_) async => patient,
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Requests'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('blood_request_patient_picker')));
    await tester.pumpAndSettle();
    expect(find.text('Blood Test Patient'), findsOneWidget);
    expect(find.text('VH-000018'), findsOneWidget);

    await tester.tap(find.byKey(const Key('blood_request_group')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('O+').last);
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('blood_request_component')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Packed red blood cells').last);
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const Key('blood_request_units')), '2');
    await tester.enterText(
      find.byKey(const Key('blood_request_indication')),
      'Elective surgery, Hb 7.1',
    );

    final urgency = find.byKey(const Key('blood_request_urgency'));
    await tester.ensureVisible(urgency);
    await tester.pumpAndSettle();
    await tester.tap(urgency);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Urgent').last);
    await tester.pumpAndSettle();

    final submit = find.byKey(const Key('blood_request_submit'));
    await tester.ensureVisible(submit);
    await tester.pumpAndSettle();
    await tester.tap(submit);
    await tester.pumpAndSettle();

    expect(transport.posts, hasLength(1));
    expect(transport.posts.single.path, '/blood-bank/request');
    expect(transport.posts.single.body, {
      'patient_uid': 'a9999999-9999-4999-8999-999999999a03',
      'blood_group': 'O+',
      'units': 2,
      'component': 'prbc',
      'clinical_indication': 'Elective surgery, Hb 7.1',
      'urgency': 'urgent',
    });
    expect(transport.posts.single.idempotencyKey, isNotEmpty);
    expect(find.text('Blood request submitted successfully'), findsOneWidget);
  });

  testWidgets(
    'reuses the request key when an uncertain submission is retried',
    (tester) async {
      final transport = _FakeBloodBankTransport(
        responses: const [
          ApiResponse(
            statusCode: 503,
            isSuccess: false,
            message: 'Delivery outcome unknown',
          ),
          ApiResponse(statusCode: 201, isSuccess: true, data: {}),
        ],
      );
      final gateway = ApiBloodBankGateway(transport);
      const patient = BloodRequestPatient(
        uid: 'a9999999-9999-4999-8999-999999999a03',
        name: 'Blood Test Patient',
        hospitalNumber: 'VH-000018',
      );

      await tester.pumpWidget(
        MaterialApp(
          locale: const Locale('en'),
          supportedLocales: AppStrings.supportedLocales,
          localizationsDelegates: const [
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          home: BloodBankScreen(
            gateway: gateway,
            patientPicker: (_) async => patient,
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Requests'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('blood_request_patient_picker')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('blood_request_group')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('O+').last);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('blood_request_component')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Packed red blood cells').last);
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('blood_request_units')), '2');
      await tester.enterText(
        find.byKey(const Key('blood_request_indication')),
        'Elective surgery, Hb 7.1',
      );

      final submit = find.byKey(const Key('blood_request_submit'));
      await tester.ensureVisible(submit);
      await tester.pumpAndSettle();
      await tester.tap(submit);
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();
      await tester.ensureVisible(submit);
      await tester.tap(submit);
      await tester.pumpAndSettle();

      expect(transport.posts, hasLength(2));
      expect(transport.posts[0].idempotencyKey, isNotEmpty);
      expect(
        transport.posts[1].idempotencyKey,
        transport.posts[0].idempotencyKey,
      );
    },
  );
}

class _FakeBloodBankTransport implements BloodBankTransport {
  _FakeBloodBankTransport({List<ApiResponse>? responses})
    : _responses = List<ApiResponse>.of(
        responses ??
            const [ApiResponse(statusCode: 201, isSuccess: true, data: {})],
      );

  final List<ApiResponse> _responses;
  final posts =
      <({String path, Map<String, dynamic>? body, String? idempotencyKey})>[];

  @override
  Future<ApiResponse> post(
    String path, {
    Map<String, dynamic>? body,
    String? idempotencyKey,
  }) async {
    posts.add((path: path, body: body, idempotencyKey: idempotencyKey));
    if (_responses.length == 1) return _responses.single;
    return _responses.removeAt(0);
  }

  @override
  Future<ApiResponse> get(
    String path, {
    Map<String, String>? queryParameters,
  }) async => const ApiResponse(statusCode: 200, isSuccess: true, data: []);
}
