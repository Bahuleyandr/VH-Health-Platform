// test/features/auth/services/login_service_test.dart
//
// Unit tests for LoginService validation methods — validateEmployeeId and
// validatePassword. These are pure static validators with no backend calls.

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/auth/services/login_service.dart';

void main() {
  group('LoginService.validateEmployeeId — valid formats', () {
    test('accepts EMP-001', () {
      expect(LoginService.validateEmployeeId('EMP-001'), isNull);
    });

    test('accepts EMP-1234', () {
      expect(LoginService.validateEmployeeId('EMP-1234'), isNull);
    });

    test('accepts STAFF-01', () {
      expect(LoginService.validateEmployeeId('STAFF-01'), isNull);
    });

    test('accepts DR-001', () {
      expect(LoginService.validateEmployeeId('DR-001'), isNull);
    });

    test('accepts lowercase input (auto-uppercased)', () {
      // validateEmployeeId trims and uppercases before matching.
      expect(LoginService.validateEmployeeId('emp-001'), isNull);
    });

    test('accepts mixed case input', () {
      expect(LoginService.validateEmployeeId('Staff-12'), isNull);
    });

    test('accepts ID with leading/trailing spaces (trimmed)', () {
      expect(LoginService.validateEmployeeId('  EMP-001  '), isNull);
    });

    test('accepts 2-letter prefix (minimum)', () {
      expect(LoginService.validateEmployeeId('AB-1'), isNull);
    });

    test('accepts 6-letter prefix (maximum)', () {
      expect(LoginService.validateEmployeeId('ABCDEF-123456'), isNull);
    });

    test('accepts single digit number', () {
      expect(LoginService.validateEmployeeId('EMP-1'), isNull);
    });

    test('accepts 6-digit number (maximum)', () {
      expect(LoginService.validateEmployeeId('EMP-123456'), isNull);
    });
  });

  group('LoginService.validateEmployeeId — invalid formats', () {
    test('rejects null', () {
      final result = LoginService.validateEmployeeId(null);
      expect(result, isNotNull);
      expect(result, 'Employee ID is required');
    });

    test('rejects empty string', () {
      final result = LoginService.validateEmployeeId('');
      expect(result, 'Employee ID is required');
    });

    test('rejects whitespace only', () {
      final result = LoginService.validateEmployeeId('   ');
      expect(result, 'Employee ID is required');
    });

    test('rejects ID without hyphen', () {
      final result = LoginService.validateEmployeeId('EMP001');
      expect(result, contains('Invalid'));
    });

    test('rejects ID with only letters', () {
      final result = LoginService.validateEmployeeId('EMPLOYEE');
      expect(result, contains('Invalid'));
    });

    test('rejects ID with only numbers', () {
      final result = LoginService.validateEmployeeId('12345');
      expect(result, contains('Invalid'));
    });

    test('rejects single letter prefix', () {
      // Pattern requires 2-6 uppercase letters before the hyphen.
      final result = LoginService.validateEmployeeId('E-001');
      expect(result, contains('Invalid'));
    });

    test('rejects 7-letter prefix (too long)', () {
      final result = LoginService.validateEmployeeId('ABCDEFG-001');
      expect(result, contains('Invalid'));
    });

    test('rejects 7-digit number (too long)', () {
      final result = LoginService.validateEmployeeId('EMP-1234567');
      expect(result, contains('Invalid'));
    });

    test('rejects special characters in prefix', () {
      final result = LoginService.validateEmployeeId('EM@-001');
      expect(result, contains('Invalid'));
    });

    test('rejects letters after hyphen', () {
      final result = LoginService.validateEmployeeId('EMP-ABC');
      expect(result, contains('Invalid'));
    });

    test('rejects double hyphen', () {
      final result = LoginService.validateEmployeeId('EMP--001');
      expect(result, contains('Invalid'));
    });

    test('rejects leading hyphen', () {
      final result = LoginService.validateEmployeeId('-001');
      expect(result, contains('Invalid'));
    });
  });

  group('LoginService.validatePassword — valid passwords', () {
    test('accepts 8-character password (minimum)', () {
      expect(LoginService.validatePassword('abcd1234'), isNull);
    });

    test('accepts long password', () {
      expect(LoginService.validatePassword('a' * 100), isNull);
    });

    test('accepts password with special characters', () {
      expect(LoginService.validatePassword('P@ssw0rd!'), isNull);
    });

    test('accepts password with spaces', () {
      expect(LoginService.validatePassword('my secre'), isNull);
    });
  });

  group('LoginService.validatePassword — invalid passwords', () {
    test('rejects null', () {
      final result = LoginService.validatePassword(null);
      expect(result, 'Password is required');
    });

    test('rejects empty string', () {
      final result = LoginService.validatePassword('');
      expect(result, 'Password is required');
    });

    test('rejects 7-character password (below minimum)', () {
      final result = LoginService.validatePassword('abcdefg');
      expect(result, contains('at least 8'));
    });

    test('rejects 1-character password', () {
      final result = LoginService.validatePassword('x');
      expect(result, contains('at least 8'));
    });
  });
}
