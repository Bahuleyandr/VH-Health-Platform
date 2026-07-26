import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/models/care_pathway_work_models.dart';
import 'package:vhhealth_staff/core/services/care_pathway_api_service.dart';
import 'package:vhhealth_staff/features/appointments/models/staff_appointment.dart';
import 'package:vhhealth_staff/features/opd/op_doctor_workspace_route.dart';
import 'package:vhhealth_staff/features/opd/screens/op_doctor_workspace_screen.dart';

void main() {
  group('opDoctorWorkspaceRoute', () {
    test('builds a patient-specific OP doctor workspace route', () {
      final route = opDoctorWorkspaceRoute(
        patientUid: 'patient-uid-1',
        patientName: 'OP Doctor Flow Test',
        appointmentId: 371,
        patientId: 42,
        patientPhone: '+91 12345 67890',
        doctorId: 1004,
        doctorName: 'Dr Test',
        department: 'General Medicine',
        reason: 'follow up',
        appointmentDate: '2026-06-05',
        appointmentTime: '17:45',
        status: 'CONFIRMED',
      );

      final uri = Uri.parse(route);
      expect(uri.path, '/op/doctor-workspace/patient-uid-1');
      expect(uri.queryParameters['name'], 'OP Doctor Flow Test');
      expect(uri.queryParameters['appointment_id'], '371');
      expect(uri.queryParameters['patient_id'], '42');
      expect(uri.queryParameters['phone'], '+91 12345 67890');
      expect(uri.queryParameters['doctor_id'], '1004');
      expect(uri.queryParameters['department'], 'General Medicine');
      expect(uri.queryParameters['context'], 'op');
    });

    test('preserves nested appointment identity for prescription prefill', () {
      final appointment = StaffAppointment.fromJson({
        'id': 371,
        'patient_name': 'Nested Patient',
        'patient_phone': '1234567890',
        'patient': {'id': 42, 'uid': 'nested-patient-uid'},
        'doctor': {
          'user_id': 1004,
          'name': 'Dr Nested',
          'department': 'Cardiology',
        },
        'appointment_date': '2026-06-05',
        'appointment_time': '17:45',
        'status': 'confirmed',
      });

      expect(appointment.patientId, 42);
      expect(appointment.doctorId, 1004);

      final uri = Uri.parse(opDoctorWorkspaceRouteFromAppointment(appointment));
      expect(uri.path, '/op/doctor-workspace/nested-patient-uid');
      expect(uri.queryParameters['patient_id'], '42');
      expect(uri.queryParameters['phone'], '1234567890');
      expect(uri.queryParameters['doctor_id'], '1004');
      expect(uri.queryParameters['doctor_name'], 'Dr Nested');
      expect(uri.queryParameters['department'], 'Cardiology');
    });

    test('maps dashboard appointment rows into the same workspace route', () {
      final route = opDoctorWorkspaceRouteFromMap({
        'appointment_id': '55',
        'patient': {
          'id': '12',
          'patient_uid': 'dash-uid',
          'phone': '+911234567890',
        },
        'doctor_id': '1004',
        'doctor_display_name': 'Dr Dashboard',
        'appointment_department': 'ENT',
        'reason': 'review',
      }, fallbackPatientName: 'Dashboard Patient');

      final uri = Uri.parse(route);
      expect(uri.path, '/op/doctor-workspace/dash-uid');
      expect(uri.queryParameters['name'], 'Dashboard Patient');
      expect(uri.queryParameters['appointment_id'], '55');
      expect(uri.queryParameters['patient_id'], '12');
      expect(uri.queryParameters['phone'], '+911234567890');
      expect(uri.queryParameters['doctor_id'], '1004');
      expect(uri.queryParameters['department'], 'ENT');
    });
  });

  group('OP active-path completion and recipient guards', () {
    test('known OFF and SHADOW modes tolerate read preflight failure', () {
      for (final mode in ['off', 'shadow']) {
        expect(
          opPathwayPreflightAllowsLegacyCompletion(
            lastKnownWork: _pathwayWork(mode),
            error: Exception('temporary read failure'),
          ),
          isTrue,
        );
      }
    });

    test('ACTIVE mode never bypasses the pathway preflight', () {
      expect(
        opPathwayPreflightAllowsLegacyCompletion(
          lastKnownWork: _pathwayWork('active'),
          error: const CarePathwayApiException(
            message: 'Unavailable',
            statusCode: 404,
          ),
        ),
        isFalse,
      );
    });

    test(
      'distinguishable missing pathway-work surface uses legacy transition',
      () {
        expect(
          opPathwayPreflightAllowsLegacyCompletion(
            lastKnownWork: null,
            error: const CarePathwayApiException(
              message: 'Cannot GET pathway work',
              statusCode: 404,
            ),
          ),
          isTrue,
        );
        expect(
          opPathwayPreflightAllowsLegacyCompletion(
            lastKnownWork: null,
            error: const CarePathwayApiException(
              message: 'Appointment not found',
              statusCode: 404,
              code: 'APPOINTMENT_NOT_FOUND',
            ),
          ),
          isFalse,
        );
      },
    );

    test('recipient options include only active admission physicians', () {
      final options = opInpatientTransferRecipientOptions([
        {
          'uid': 'doctor-1',
          'name': 'Dr One',
          'role': 'DOCTOR',
          'is_active': true,
        },
        {
          'uid': 'nurse-1',
          'name': 'Nurse One',
          'role': 'NURSE',
          'is_active': true,
        },
        {
          'uid': 'doctor-2',
          'name': 'Dr Two',
          'role': 'CONSULTANT',
          'is_active': false,
        },
      ]);

      expect(options.map((row) => row['uid']), ['doctor-1']);
    });
  });

  group('prior-admission pending-result review card', () {
    testWidgets('shows exact doctor disposition and owner-only review action', (
      tester,
    ) async {
      var reviewCalls = 0;
      final item = _pendingResult(canCrossSign: true);

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: OpPriorAdmissionPendingResultCard(
              item: item,
              busy: false,
              actionEnabled: true,
              onReview: () => reviewCalls += 1,
            ),
          ),
        ),
      );

      expect(find.textContaining('ABNORMAL'), findsOneWidget);
      expect(
        find.textContaining('22222222-2222-4222-8222-222222222222'),
        findsOneWidget,
      );
      expect(find.textContaining('referred'), findsOneWidget);
      await tester.tap(find.text('Review discharge result'));
      expect(reviewCalls, 1);
    });

    testWidgets('keeps resolved result read-only with no action button', (
      tester,
    ) async {
      final item = _pendingResult(canCrossSign: false, resolved: true);

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: OpPriorAdmissionPendingResultCard(
              item: item,
              busy: false,
              actionEnabled: true,
              onReview: () => fail('read-only result invoked review'),
            ),
          ),
        ),
      );

      expect(find.text('Resolved — no action available'), findsOneWidget);
      expect(find.byType(FilledButton), findsNothing);
    });
  });
}

AppointmentPathwayWork _pathwayWork(String mode) {
  return AppointmentPathwayWork(
    mode: mode,
    visitCompletion: const CarePathwayGate(allowed: true, blockers: []),
    pathwayClosure: const CarePathwayGate(allowed: true, blockers: []),
    items: const [],
    priorAdmissionPendingResults: const [],
  );
}

OpFollowUpPendingResult _pendingResult({
  required bool canCrossSign,
  bool resolved = false,
}) {
  return OpFollowUpPendingResult.fromJson({
    'admission_id': 44,
    'handoff_id': '11111111-1111-4111-8111-111111111111',
    'source_type': 'lab_result',
    'patient_safe_label': 'Complete blood count',
    'result_status': resolved ? 'reviewed' : 'available',
    'handoff_state': resolved ? 'resolved' : 'result_available',
    'requires_action': !resolved,
    'can_cross_sign': canCrossSign,
    'named_owner': {
      'uid': 'doctor-9',
      'display_name': 'Dr Nikhil Rao',
      'role': 'DOCTOR',
    },
    'generation_id': '22222222-2222-4222-8222-222222222222',
    'generation_snapshot_sha256':
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'diagnostic_classification': 'abnormal',
    'diagnostic_action_id': '33333333-3333-4333-8333-333333333333',
    'diagnostic_action_kind': 'doctor_disposition',
    'diagnostic_disposition': 'referred',
    'diagnostic_action_occurred_at': '2026-07-23T12:00:00Z',
    if (resolved)
      'resolution_action_id': '44444444-4444-4444-8444-444444444444',
    'tracking_task': {'id': 91, 'status': resolved ? 'completed' : 'open'},
    'action_task': {'id': 92, 'status': resolved ? 'completed' : 'open'},
    'task': {'id': 92, 'status': resolved ? 'completed' : 'open'},
    'route': 'investigations',
  });
}
