import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/config/role_config.dart';
import 'package:vhhealth_staff/core/platform_info.dart';
import 'package:vhhealth_staff/features/reception/screens/front_office_workbench_screen.dart';

void main() {
  group('frontOfficeQueueDateLabel', () {
    final today = DateTime(2026, 6, 2);

    test('labels today, tomorrow, and following day queues', () {
      expect(frontOfficeQueueDateLabel(today, now: today), 'Today Queue');
      expect(
        frontOfficeQueueDateLabel(
          today.add(const Duration(days: 1)),
          now: today,
        ),
        'Tomorrow Queue',
      );
      expect(
        frontOfficeQueueDateLabel(
          today.add(const Duration(days: 2)),
          now: today,
        ),
        'Following Day Queue',
      );
    });

    test('falls back to a compact date label outside quick queue days', () {
      expect(
        frontOfficeQueueDateLabel(DateTime(2026, 6, 8), now: today),
        'Mon, 8 Jun Queue',
      );
    });
  });

  group('frontOfficeWorkbenchCanLoad', () {
    test(
      'allows front-office roles only on tablet or desktop workbench modes',
      () {
        expect(
          frontOfficeWorkbenchCanLoad(
            role: StaffRole.receptionist,
            mode: AppDeviceMode.desktop,
          ),
          isTrue,
        );
        expect(
          frontOfficeWorkbenchCanLoad(
            role: StaffRole.billingStaff,
            mode: AppDeviceMode.tablet,
          ),
          isTrue,
        );
        expect(
          frontOfficeWorkbenchCanLoad(
            role: StaffRole.receptionist,
            mode: AppDeviceMode.mobile,
          ),
          isFalse,
        );
        expect(
          frontOfficeWorkbenchCanLoad(
            role: StaffRole.housekeeping,
            mode: AppDeviceMode.desktop,
          ),
          isFalse,
        );
      },
    );
  });

  group('frontOfficeWorkbenchShouldRequestWorklists', () {
    test('loads tablet workbench data from the resolved screen mode', () {
      expect(
        frontOfficeWorkbenchShouldRequestWorklists(
          roleLoaded: true,
          role: StaffRole.receptionist,
          mode: AppDeviceMode.tablet,
          loadedForMode: null,
          loadInFlight: false,
        ),
        isTrue,
      );
    });

    test('does not load for phone mode or unsupported roles', () {
      expect(
        frontOfficeWorkbenchShouldRequestWorklists(
          roleLoaded: true,
          role: StaffRole.receptionist,
          mode: AppDeviceMode.mobile,
          loadedForMode: null,
          loadInFlight: false,
        ),
        isFalse,
      );
      expect(
        frontOfficeWorkbenchShouldRequestWorklists(
          roleLoaded: true,
          role: StaffRole.housekeeping,
          mode: AppDeviceMode.desktop,
          loadedForMode: null,
          loadInFlight: false,
        ),
        isFalse,
      );
    });

    test('avoids duplicate loads unless the user refreshes', () {
      expect(
        frontOfficeWorkbenchShouldRequestWorklists(
          roleLoaded: true,
          role: StaffRole.receptionist,
          mode: AppDeviceMode.desktop,
          loadedForMode: AppDeviceMode.desktop,
          loadInFlight: false,
        ),
        isFalse,
      );
      expect(
        frontOfficeWorkbenchShouldRequestWorklists(
          roleLoaded: true,
          role: StaffRole.receptionist,
          mode: AppDeviceMode.desktop,
          loadedForMode: AppDeviceMode.desktop,
          loadInFlight: false,
          force: true,
        ),
        isTrue,
      );
      expect(
        frontOfficeWorkbenchShouldRequestWorklists(
          roleLoaded: true,
          role: StaffRole.receptionist,
          mode: AppDeviceMode.desktop,
          loadedForMode: null,
          loadInFlight: true,
        ),
        isFalse,
      );
    });
  });

  group('frontOfficeAdmissionTotalFrom', () {
    test('uses backend pagination total instead of loaded preview length', () {
      final total = frontOfficeAdmissionTotalFrom({
        'admissions': List.generate(12, (index) => {'id': index + 1}),
        'pagination': {'total': 46, 'limit': 12},
      }, fallbackCount: 12);

      expect(total, 46);
    });

    test('accepts legacy totalItems and string totals', () {
      expect(
        frontOfficeAdmissionTotalFrom({
          'admissions': const [],
          'pagination': {'totalItems': '31'},
        }, fallbackCount: 0),
        31,
      );
    });

    test('falls back to loaded count when no total is present', () {
      expect(
        frontOfficeAdmissionTotalFrom({
          'admissions': const [],
        }, fallbackCount: 5),
        5,
      );
    });
  });

  group('front-office OPD to IPD admission advice mapping', () {
    test('uses the advised appointment id as the admission advice id', () {
      expect(
        frontOfficeAdmissionAdviceIdFrom({
          'id': 410,
          'patient_id': 22,
          'advised_for_admission_at': '2026-06-01T09:30:00.000Z',
        }),
        410,
      );
      expect(frontOfficeAdmissionAdviceIdFrom({'appointment_id': '411'}), 411);
      expect(
        frontOfficeAdmissionAdviceIdFrom({'admission_advice_id': '412'}),
        412,
      );
    });

    test('maps flat appointment rows into patient selection data', () {
      final patient = frontOfficeAdmissionAdvicePatientFrom({
        'id': 410,
        'patient_id': 22,
        'patient_uid': '8d4605e0-4bdb-4df5-9ac8-9a2c2db6065c',
        'patient_name': 'Asha Menon',
        'patient_phone': '9876543210',
      });

      expect(patient, isNotNull);
      expect(patient!['id'], 22);
      expect(patient['uid'], '8d4605e0-4bdb-4df5-9ac8-9a2c2db6065c');
      expect(patient['name'], 'Asha Menon');
      expect(patient['phone'], '9876543210');
    });

    test('maps nested patient details from advice rows', () {
      final patient = frontOfficeAdmissionAdvicePatientFrom({
        'appointment_id': 411,
        'patient': {
          'id': 25,
          'uid': 'd0ad03ab-30eb-4423-a3f4-25895bf1f0a1',
          'name': 'Ravi Kumar',
          'phone': '9123456780',
          'hospital_number': 'VH-25',
        },
      });

      expect(patient, isNotNull);
      expect(patient!['id'], 25);
      expect(patient['hospital_number'], 'VH-25');
      expect(patient['name'], 'Ravi Kumar');
    });
  });

  group('frontOfficeFilterDoctors', () {
    final doctors = [
      {
        'id': 11,
        'uid': 'doctor-11',
        'name': 'Dr Asha Rao',
        'department': 'Cardiology',
        'employee_id': 'EMP-11',
      },
      {
        'user_id': '12',
        'uid': 'doctor-12',
        'name': 'Dr Imran Shah',
        'specialization': 'Emergency Medicine',
      },
      {
        'id': 'not-a-number',
        'uid': 'doctor-13',
        'name': 'Dr Mira Das',
        'department': 'Oncology',
      },
      {'id': 14, 'name': 'Dr Neel Patil', 'specialty': 'Neurology'},
    ];

    test('matches by name, department, specialty, and employee id', () {
      expect(
        frontOfficeFilterDoctors(
          doctors,
          'cardio',
          requireNumericId: true,
        ).map((doctor) => doctor['name']),
        ['Dr Asha Rao'],
      );
      expect(
        frontOfficeFilterDoctors(
          doctors,
          'emergency',
          requireNumericId: true,
        ).map((doctor) => doctor['name']),
        ['Dr Imran Shah'],
      );
      expect(
        frontOfficeFilterDoctors(
          doctors,
          'emp-11',
          requireNumericId: true,
        ).map((doctor) => doctor['name']),
        ['Dr Asha Rao'],
      );
    });

    test('enforces id requirements and caps large result sets', () {
      expect(
        frontOfficeFilterDoctors(
          doctors,
          '',
          requireNumericId: true,
        ).map((doctor) => doctor['name']),
        ['Dr Asha Rao', 'Dr Imran Shah', 'Dr Neel Patil'],
      );
      expect(
        frontOfficeFilterDoctors(
          doctors,
          '',
          requireUid: true,
        ).map((doctor) => doctor['name']),
        ['Dr Asha Rao', 'Dr Imran Shah', 'Dr Mira Das'],
      );
      expect(frontOfficeFilterDoctors(doctors, '', limit: 2), hasLength(2));
    });

    test('supports department-routed booking filters', () {
      expect(frontOfficeDepartmentOptionsFromDoctors(doctors), [
        'Cardiology',
        'Oncology',
      ]);
      expect(
        frontOfficeFilterDoctors(
          doctors,
          '',
          department: 'cardio',
          requireNumericId: true,
        ).map((doctor) => doctor['name']),
        ['Dr Asha Rao'],
      );
      expect(
        frontOfficeSameDepartment(
          frontOfficeDoctorDepartment(doctors.first),
          'Cardiology',
        ),
        isTrue,
      );
    });
  });

  group('frontOfficeAdmissionPriorityAfterWardSelection', () {
    test('promotes emergency-capable wards to emergency priority', () {
      expect(
        frontOfficeAdmissionPriorityAfterWardSelection(
          wardLabel: 'ER - Ground Floor',
          currentPriority: 'Routine',
        ),
        'Emergency',
      );
      expect(
        frontOfficeAdmissionPriorityAfterWardSelection(
          wardLabel: 'Intensive Care Unit',
          currentPriority: 'Urgent',
        ),
        'Emergency',
      );
      expect(frontOfficeWardImpliesEmergencyPriority('Casualty ward'), isTrue);
    });

    test('keeps the current priority for non-emergency wards', () {
      expect(
        frontOfficeWardImpliesEmergencyPriority('Geriatric Ward'),
        isFalse,
      );
      expect(
        frontOfficeAdmissionPriorityAfterWardSelection(
          wardLabel: 'General Medicine 2',
          currentPriority: 'Urgent',
        ),
        'Urgent',
      );
    });
  });

  group('frontOfficePatientMatchesLookupQuery', () {
    test('does not treat adjacent country-code digits as the same phone', () {
      expect(
        frontOfficePatientMatchesLookupQuery({
          'phone': '+911234567890',
        }, '1123456789'),
        isFalse,
      );
      expect(
        frontOfficePatientMatchesLookupQuery({
          'phone': '+911123456789',
        }, '1123456789'),
        isTrue,
      );
      expect(
        frontOfficePatientMatchesLookupQuery({
          'phone': '123456789',
        }, '1234566789'),
        isFalse,
      );
    });

    test('requires 10 digits for phone-like searches', () {
      expect(
        frontOfficePatientMatchesLookupQuery({
          'phone': '+911234567890',
        }, '123456789'),
        isFalse,
      );
      expect(frontOfficePhoneMeetsMinimum('123456789'), isFalse);
      expect(frontOfficePhoneMeetsMinimum('1234567890'), isTrue);
    });

    test('leaves name and short identifier searches unfiltered', () {
      expect(
        frontOfficePatientMatchesLookupQuery({
          'phone': '+911234567890',
        }, 'test'),
        isTrue,
      );
      expect(
        frontOfficePatientMatchesLookupQuery({
          'phone': '+911234567890',
        }, 'VH-97'),
        isTrue,
      );
    });
  });

  group('frontOfficeLookupQueryReady', () {
    test('keeps name search dynamic but waits for 10 phone digits', () {
      expect(frontOfficeLookupQueryReady('pr'), isTrue);
      expect(frontOfficeLookupQueryReady('123456789'), isFalse);
      expect(frontOfficeLookupQueryReady('1234567890'), isTrue);
      expect(frontOfficeLookupQueryReady('+91 12345 67890'), isTrue);
    });

    test('offers create only for registry-write roles and ready searches', () {
      expect(RoleFeatures.hasPatientRegistryCreate(StaffRole.nurse), isFalse);
      expect(RoleFeatures.hasPatientRegistryWrite(StaffRole.nurse), isFalse);
      expect(
        frontOfficeShouldOfferPatientCreate(
          role: StaffRole.receptionist,
          query: '1234567890',
          lookupBusy: false,
          hasSelectedPatient: false,
          matchCount: 0,
        ),
        isTrue,
      );
      expect(
        frontOfficeShouldOfferPatientCreate(
          role: StaffRole.receptionist,
          query: '123456789',
          lookupBusy: false,
          hasSelectedPatient: false,
          matchCount: 0,
        ),
        isFalse,
      );
      expect(
        frontOfficeShouldOfferPatientCreate(
          role: StaffRole.receptionist,
          query: 'Priya',
          lookupBusy: false,
          hasSelectedPatient: true,
          matchCount: 0,
        ),
        isFalse,
      );
      expect(
        frontOfficeShouldOfferPatientCreate(
          role: StaffRole.doctor,
          query: 'Priya',
          lookupBusy: false,
          hasSelectedPatient: false,
          matchCount: 0,
        ),
        isFalse,
      );
    });
  });

  group('frontOfficePatientScopedRoute', () {
    test('carries selected patient context into Patient Records', () {
      final route = frontOfficePatientScopedRoute(
        '/patient-records',
        queryParameters: const {'context': 'front-office'},
        patient: {
          'id': 18,
          'uid': 'patient-18',
          'hospital_number': 'VH-000018',
          'name': 'Test Patient',
          'phone': '+911234567890',
        },
      );

      final uri = Uri.parse(route);
      expect(uri.path, '/patient-records');
      expect(uri.queryParameters['context'], 'front-office');
      expect(uri.queryParameters['patient_id'], '18');
      expect(uri.queryParameters['patient_uid'], 'patient-18');
      expect(uri.queryParameters['hospital_number'], 'VH-000018');
      expect(uri.queryParameters['name'], 'Test Patient');
      expect(uri.queryParameters['phone'], '+911234567890');
    });
  });

  group('front-office OP queue gates', () {
    test('doctors use their assigned OP queue instead of the broad queue', () {
      expect(
        frontOfficeQueueScopeForRole(StaffRole.doctor),
        FrontOfficeQueueScope.mine,
      );
      expect(
        frontOfficeQueueScopeForRole(StaffRole.dutyDoctor),
        FrontOfficeQueueScope.mine,
      );
    });

    test('front-office counter roles can view and manage the broad queue', () {
      expect(
        frontOfficeQueueScopeForRole(StaffRole.receptionist),
        FrontOfficeQueueScope.full,
      );
      expect(frontOfficeCanBookOp(StaffRole.receptionist), isTrue);
      expect(
        frontOfficeCanManageAppointmentQueue(StaffRole.receptionist),
        isTrue,
      );
    });

    test('billing can see queue context but cannot manage OP status', () {
      expect(
        frontOfficeQueueScopeForRole(StaffRole.billingStaff),
        FrontOfficeQueueScope.full,
      );
      expect(frontOfficeCanBookOp(StaffRole.billingStaff), isFalse);
      expect(
        frontOfficeCanManageAppointmentQueue(StaffRole.billingStaff),
        isFalse,
      );
    });

    test(
      'ward nurses do not receive the broad OP queue from the workbench',
      () {
        expect(
          frontOfficeQueueScopeForRole(StaffRole.nurse),
          FrontOfficeQueueScope.none,
        );
        expect(frontOfficeCanCompleteAppointment(StaffRole.nurse), isTrue);
        expect(frontOfficeCanBookOp(StaffRole.nurse), isFalse);
      },
    );
  });

  group('frontOfficeWalkInRegistrationPayload', () {
    test(
      'carries selected patient, doctor, intake, payer, and MLC context',
      () {
        final payload = frontOfficeWalkInRegistrationPayload(
          patient: {
            'id': 22,
            'name': 'Asha Menon',
            'phone': '9876543210',
            'birthday': '1990-02-03T00:00:00.000Z',
            'gender': 'female',
          },
          doctor: {
            'id': 77,
            'name': 'Dr Kumar',
            'department': 'General Medicine',
          },
          reason: ' Fever and cough ',
          notes: 'Vitals pending',
          visitType: 'emergency',
          patientCategory: 'tpa',
          payerType: 'tpa',
          insurerName: 'Demo TPA',
          policyNumber: 'POL-123',
          allergies: 'Penicillin',
          chronicMedications: 'Metformin, Atorvastatin',
          mlc: true,
          mlcNumber: 'MLC-9',
          mlcNotes: 'Police intimation pending',
        );

        expect(payload, {
          'patient_id': 22,
          'patient_phone': '9876543210',
          'patient_name': 'Asha Menon',
          'patient_birthday': '1990-02-03',
          'patient_gender': 'female',
          'doctor_id': 77,
          'department': 'General Medicine',
          'reason': 'Fever and cough',
          'chief_complaint': 'Fever and cough',
          'notes': 'Vitals pending',
          'appointment_time': 'Walk-in',
          'visit_type': 'EMERGENCY',
          'patient_category': 'tpa',
          'payer_type': 'tpa',
          'insurer_name': 'Demo TPA',
          'policy_number': 'POL-123',
          'allergies': 'Penicillin',
          'chronic_medications': 'Metformin, Atorvastatin',
          'mlc': true,
          'mlc_number': 'MLC-9',
          'mlc_notes': 'Police intimation pending',
        });
      },
    );

    test('supports lab-only walk-ins without a doctor and strips blanks', () {
      final payload = frontOfficeWalkInRegistrationPayload(
        patient: {'phone': '9123456780', 'name': 'Lab Patient'},
        reason: ' CBC ',
        visitType: 'lab_only',
        department: 'Laboratory',
        notes: '   ',
        insurerName: '   ',
      );

      expect(payload['doctor_id'], isNull);
      expect(payload['department'], 'Laboratory');
      expect(payload['visit_type'], 'LAB_ONLY');
      expect(payload['reason'], 'CBC');
      expect(payload.containsKey('notes'), isFalse);
      expect(payload.containsKey('insurer_name'), isFalse);
    });
  });
}
