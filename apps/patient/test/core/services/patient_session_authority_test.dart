import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/services/patient_session_authority.dart';
import 'package:vhhealth_core/config/tenant_config.dart';

void main() {
  late Map<String, String> storage;
  late DateTime now;
  late PatientSessionAuthority authority;

  setUp(() {
    storage = <String, String>{};
    now = DateTime.utc(2026, 8, 13, 12);
    authority = PatientSessionAuthority.forTesting(
      read: (key) async => storage[key],
      write: (key, value) async => storage[key] = value,
      clock: () => now,
    );
  });

  test('accepts only a current, bounded Patient JWT claim set', () async {
    final current = _jwt(
      subject: 'patient-1',
      tokenId: 'token-1',
      expiresAt: now.add(const Duration(minutes: 5)),
    );

    expect(await authority.allowsProtectedAccess(current), isTrue);
    expect(await authority.allowsProtectedAccess(null), isFalse);
    expect(await authority.allowsProtectedAccess('a.b.c'), isFalse);
    expect(
      await authority.allowsProtectedAccess(
        _jwt(
          subject: 'patient-1',
          tokenId: 'token-1',
          expiresAt: now.add(const Duration(minutes: 5)),
          role: 'STAFF',
        ),
      ),
      isFalse,
    );
    expect(
      await authority.allowsProtectedAccess(
        _jwt(
          subject: 'patient-1',
          tokenId: 'token-1',
          expiresAt: now.add(const Duration(minutes: 5)),
          notBefore: now.add(const Duration(minutes: 1)),
        ),
      ),
      isFalse,
    );
  });

  test('expired JWT is rejected without a server-confirmed lease', () async {
    final expired = _jwt(
      subject: 'patient-1',
      tokenId: 'token-1',
      expiresAt: now.subtract(const Duration(seconds: 1)),
    );

    expect(await authority.allowsProtectedAccess(expired), isFalse);
  });

  test(
    'server confirmation creates a bounded token-specific offline lease',
    () async {
      final jwt = _jwt(
        subject: 'patient-1',
        tokenId: 'token-1',
        expiresAt: now.add(const Duration(minutes: 5)),
      );

      expect(
        await authority.confirmServerSession(
          jwt: jwt,
          tenantId: TenantConfig.id,
          confirmedAt: now,
        ),
        isTrue,
      );

      now = now.add(const Duration(minutes: 10));
      expect(await authority.allowsProtectedAccess(jwt), isTrue);
      expect(
        await authority.allowsProtectedAccess(
          _jwt(
            subject: 'patient-1',
            tokenId: 'another-token',
            expiresAt: now.subtract(const Duration(minutes: 1)),
          ),
        ),
        isFalse,
      );

      now = DateTime.utc(2026, 8, 14, 12);
      expect(await authority.allowsProtectedAccess(jwt), isFalse);
    },
  );

  test('lease rejects clock rollback and tampered duration', () async {
    final confirmedAt = now;
    final jwt = _jwt(
      subject: 'patient-1',
      tokenId: 'token-1',
      expiresAt: now.add(const Duration(minutes: 5)),
    );
    await authority.confirmServerSession(
      jwt: jwt,
      tenantId: TenantConfig.id,
      confirmedAt: confirmedAt,
    );

    now = confirmedAt.subtract(const Duration(minutes: 6));
    expect(await authority.allowsProtectedAccess(jwt), isFalse);

    now = confirmedAt.add(const Duration(minutes: 10));
    final leaseKey = storage.keys.singleWhere((key) => key != 'jwt');
    final lease = jsonDecode(storage[leaseKey]!) as Map<String, dynamic>;
    lease['expiresAt'] = confirmedAt
        .add(const Duration(hours: 25))
        .toIso8601String();
    storage[leaseKey] = jsonEncode(lease);
    expect(await authority.allowsProtectedAccess(jwt), isFalse);
  });

  test('server confirmation rejects expired JWT and wrong tenant', () async {
    final expired = _jwt(
      subject: 'patient-1',
      tokenId: 'token-1',
      expiresAt: now.subtract(const Duration(seconds: 1)),
    );
    final current = _jwt(
      subject: 'patient-1',
      tokenId: 'token-2',
      expiresAt: now.add(const Duration(minutes: 5)),
    );

    expect(
      await authority.confirmServerSession(
        jwt: expired,
        tenantId: TenantConfig.id,
        confirmedAt: now,
      ),
      isFalse,
    );
    expect(
      await authority.confirmServerSession(
        jwt: current,
        tenantId: '00000000-0000-4000-8000-000000000099',
        confirmedAt: now,
      ),
      isFalse,
    );
    expect(storage, isEmpty);
  });

  test('current session lookup uses the same injected secure store', () async {
    storage['jwt'] = _jwt(
      subject: 'patient-1',
      tokenId: 'token-1',
      expiresAt: now.add(const Duration(minutes: 5)),
    );

    expect(await authority.currentSessionAllowsProtectedAccess(), isTrue);
  });
}

String _jwt({
  required String subject,
  required String tokenId,
  required DateTime expiresAt,
  String role = 'PATIENT',
  DateTime? notBefore,
}) {
  final header = _segment({'alg': 'HS256', 'typ': 'JWT'});
  final payload = _segment({
    'sub': subject,
    'jti': tokenId,
    'role': role,
    'exp': expiresAt.millisecondsSinceEpoch ~/ 1000,
    if (notBefore != null) 'nbf': notBefore.millisecondsSinceEpoch ~/ 1000,
  });
  return '$header.$payload.signature';
}

String _segment(Map<String, Object> value) =>
    base64UrlEncode(utf8.encode(jsonEncode(value))).replaceAll('=', '');
