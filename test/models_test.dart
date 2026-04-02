import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/models/api_models.dart';
import 'package:vhhealth_core/models/api_response.dart';

void main() {
  group('User', () {
    test('fromJson parses correctly', () {
      final json = {
        'id': 1,
        'uid': 'abc123',
        'phone': '+919876543210',
        'name': 'Test User',
        'gender': 'MALE',
        'is_active': true,
        'registered_at': '2026-01-01T00:00:00Z',
        'updated_at': '2026-01-02T00:00:00Z',
      };
      final user = User.fromJson(json);
      expect(user.id, 1);
      expect(user.uid, 'abc123');
      expect(user.phone, '+919876543210');
      expect(user.name, 'Test User');
      expect(user.gender, 'MALE');
      expect(user.isActive, true);
    });

    test('toJson round-trips', () {
      final json = {
        'id': 1,
        'uid': 'abc123',
        'phone': '+919876543210',
        'name': 'Test User',
        'registered_at': '2026-01-01T00:00:00Z',
        'updated_at': '2026-01-02T00:00:00Z',
      };
      final user = User.fromJson(json);
      final output = user.toJson();
      expect(output['phone'], '+919876543210');
      expect(output['name'], 'Test User');
    });
  });

  group('Appointment', () {
    test('fromJson parses correctly', () {
      final json = {
        'id': 42,
        'uid': 'appt-uid',
        'patient_id': 1,
        'doctor_id': 2,
        'status': 'CONFIRMED',
        'appointment_date': '2026-04-10',
        'appointment_time': '10:00',
      };
      final appt = Appointment.fromJson(json);
      expect(appt.id, 42);
      expect(appt.status, 'CONFIRMED');
      expect(appt.appointmentDate, '2026-04-10');
    });
  });

  group('Staff', () {
    test('fromJson parses correctly', () {
      final json = {
        'id': 10,
        'employee_id': 'EMP001',
        'name': 'Dr. Smith',
        'role': 'DOCTOR',
        'department': 'Cardiology',
        'is_active': true,
      };
      final staff = Staff.fromJson(json);
      expect(staff.employeeId, 'EMP001');
      expect(staff.role, 'DOCTOR');
      expect(staff.department, 'Cardiology');
    });

    test('handles camelCase keys', () {
      final json = {
        'employeeId': 'EMP002',
        'profilePicture': 'pic.jpg',
        'dateOfJoining': '2025-06-01',
        'isActive': false,
      };
      final staff = Staff.fromJson(json);
      expect(staff.employeeId, 'EMP002');
      expect(staff.profilePicture, 'pic.jpg');
      expect(staff.isActive, false);
    });

    test('toJson produces snake_case', () {
      const staff = Staff(employeeId: 'EMP003', role: 'NURSING_STAFF');
      final json = staff.toJson();
      expect(json['employee_id'], 'EMP003');
      expect(json['role'], 'NURSING_STAFF');
    });
  });

  group('Prescription', () {
    test('fromJson with items', () {
      final json = {
        'id': 5,
        'diagnosis': 'Hypertension',
        'status': 'ACTIVE',
        'items': [
          {'medication_name': 'Amlodipine', 'dosage': '5mg', 'frequency': 'Once daily'},
          {'medication_name': 'Aspirin', 'dosage': '75mg'},
        ],
      };
      final rx = Prescription.fromJson(json);
      expect(rx.diagnosis, 'Hypertension');
      expect(rx.items.length, 2);
      expect(rx.items[0].medicationName, 'Amlodipine');
      expect(rx.items[1].dosage, '75mg');
    });

    test('handles empty items', () {
      final json = {'id': 6, 'status': 'CANCELLED'};
      final rx = Prescription.fromJson(json);
      expect(rx.items, isEmpty);
      expect(rx.status, 'CANCELLED');
    });
  });

  group('Admission', () {
    test('fromJson parses correctly', () {
      final json = {
        'id': 1,
        'patient_id': 10,
        'department': 'General Medicine',
        'ward': 'Ward A',
        'bed_number': 'A-12',
        'status': 'ADMITTED',
        'admission_date': '2026-04-01',
      };
      final adm = Admission.fromJson(json);
      expect(adm.bedNumber, 'A-12');
      expect(adm.ward, 'Ward A');
      expect(adm.status, 'ADMITTED');
    });
  });

  group('BillingInvoice', () {
    test('fromJson parses amounts correctly', () {
      final json = {
        'id': 1,
        'total_amount': 5000,
        'paid_amount': 2000,
        'balance_amount': 3000,
        'status': 'PARTIAL',
        'items': [
          {'description': 'Consultation', 'quantity': 1, 'unit_price': 500, 'total_price': 500},
        ],
      };
      final invoice = BillingInvoice.fromJson(json);
      expect(invoice.totalAmount, 5000.0);
      expect(invoice.paidAmount, 2000.0);
      expect(invoice.balanceAmount, 3000.0);
      expect(invoice.items.length, 1);
      expect(invoice.items[0].description, 'Consultation');
    });
  });

  group('ApiResponse', () {
    test('parse success response', () {
      const body = '{"success":true,"data":{"id":1},"message":"OK"}';
      final response = ApiResponse.parse(200, body);
      expect(response.isSuccess, true);
      expect(response.data['id'], 1);
      expect(response.message, 'OK');
    });

    test('parse error response', () {
      const body = '{"success":false,"message":"Not found"}';
      final response = ApiResponse.parse(404, body);
      expect(response.isSuccess, false);
      expect(response.message, 'Not found');
    });

    test('parse list data', () {
      const body = '{"data":[{"id":1},{"id":2}]}';
      final response = ApiResponse.parse(200, body);
      final list = response.dataAsList();
      expect(list.length, 2);
    });

    test('isUnauthorized detects 401', () {
      const body = '{"message":"Unauthorized"}';
      final response = ApiResponse.parse(401, body);
      expect(response.isUnauthorized, true);
    });
  });

  group('PaginationMeta', () {
    test('fromJson parses correctly', () {
      final json = {'page': 1, 'limit': 20, 'total': 100, 'totalPages': 5};
      final meta = PaginationMeta.fromJson(json);
      expect(meta.page, 1);
      expect(meta.totalPages, 5);
    });
  });

  group('Doctor', () {
    test('fromJson parses correctly', () {
      final json = {
        'id': 1,
        'uid': 'doc-uid',
        'name': 'Dr. Sharma',
        'department': 'Cardiology',
        'specialty': 'Interventional Cardiology',
        'is_available': true,
      };
      final doc = Doctor.fromJson(json);
      expect(doc.name, 'Dr. Sharma');
      expect(doc.specialty, 'Interventional Cardiology');
      expect(doc.isAvailable, true);
    });
  });

  group('Medication', () {
    test('fromJson parses correctly', () {
      final json = {
        'id': 1,
        'name': 'Paracetamol',
        'dosage': '500mg',
        'stock': 100,
        'price': 25.50,
        'requires_prescription': true,
      };
      final med = Medication.fromJson(json);
      expect(med.name, 'Paracetamol');
      expect(med.price, 25.50);
      expect(med.requiresPrescription, true);
    });
  });
}
