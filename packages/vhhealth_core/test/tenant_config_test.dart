import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/config/tenant_config.dart';
import 'package:vhhealth_core/services/offline_queue.dart';
import 'package:vhhealth_core/theme/app_theme.dart';

void main() {
  group('TenantConfig (W6 T1)', () {
    // This test run has no --dart-define, so it exercises the UNSTAMPED (default
    // single-tenant) build — the NO-OP invariant. The stamped path is verified
    // by a build with `--dart-define=VH_TENANT_SLUG=<slug>` (the const resolves
    // at compile time), which a per-tenant build matrix supplies (W7).
    test('an unstamped build is the default tenant (NO-OP)', () {
      expect(TenantConfig.slug, '');
      expect(TenantConfig.isDefaultTenant, isTrue);
      expect(TenantConfig.cacheNamespace, 'default');
      expect(TenantConfig.primaryColorHex, '');
    });

    test('defaults to the platform default tenant id', () {
      expect(TenantConfig.id, '00000000-0000-4000-8000-000000000001');
    });
  });

  // The readiness adapters compare the server's tenant against TenantConfig.id
  // with a strict `==` (client_readiness.dart isReadyForTenant). A build whose
  // stamp disagrees with the backend it points at therefore never reaches
  // `available`, and because only two matching readiness successes reopen the
  // client (C-D12 5.3) that outage is permanent — the app refuses every
  // hospital mutation including SOS while the backend is healthy. These cases
  // make the two unambiguous mis-stamps fail loudly at startup instead.
  //
  // The parameters are injectable because `String.fromEnvironment` resolves at
  // compile time and cannot be varied within one test process.
  group('TenantConfig.verifyOrThrow', () {
    const defaultTenant = '00000000-0000-4000-8000-000000000001';
    const otherTenant = '11111111-1111-4111-8111-111111111111';

    test('an unstamped default build passes', () {
      expect(
        () => TenantConfig.verifyOrThrow(slug: '', id: defaultTenant),
        returnsNormally,
      );
    });

    test('a correctly stamped per-tenant build passes', () {
      expect(
        () => TenantConfig.verifyOrThrow(slug: 'acme', id: otherTenant),
        returnsNormally,
      );
    });

    // `--dart-define=VH_TENANT_ID=` with an unset CI variable yields '' rather
    // than the default, so this is the trap an unconditional stamp would set.
    test('an empty tenant id fails closed', () {
      expect(
        () => TenantConfig.verifyOrThrow(slug: '', id: ''),
        throwsStateError,
      );
      expect(
        () => TenantConfig.verifyOrThrow(slug: 'acme', id: ''),
        throwsStateError,
      );
    });

    test('a malformed tenant id fails closed', () {
      for (final id in [
        'not-a-uuid',
        '00000000-0000-4000-8000',
        '00000000_0000_4000_8000_000000000001',
        ' 00000000-0000-4000-8000-000000000001',
      ]) {
        expect(
          () => TenantConfig.verifyOrThrow(slug: '', id: id),
          throwsStateError,
          reason: 'expected StateError for id "$id"',
        );
      }
    });

    // isDefaultTenant is defined as slug.isEmpty, so a stamped slug carrying
    // the default tenant id is a contradiction, and is exactly the shape of
    // "repointed the build but forgot VH_TENANT_ID".
    test('a stamped slug carrying the default tenant id fails closed', () {
      expect(
        () => TenantConfig.verifyOrThrow(slug: 'acme', id: defaultTenant),
        throwsStateError,
      );
    });

    test('is wired to the real build constants by default', () {
      // This process is unstamped, so the live constants must be coherent.
      expect(TenantConfig.verifyOrThrow, returnsNormally);
    });
  });

  group('OfflineQueue tenant namespacing (W6 T2)', () {
    test('default (unstamped) build keeps the original DB filename — NO-OP', () {
      // A stamped build would namespace this to offline_queue_<slug>.db; the
      // default build MUST stay 'offline_queue.db' so an existing install never
      // orphans its queued (encrypted) PHI.
      expect(OfflineQueue.dbFileName, 'offline_queue.db');
    });
  });

  group('AppTheme tenant seed (W6 T3)', () {
    test('default (unstamped) build seeds with the brand colour — NO-OP', () {
      expect(AppTheme.seedColor, AppTheme.primaryColor);
    });

    test(
      'parseHexColor handles #RRGGBB, RRGGBB, #AARRGGBB; null on empty/invalid',
      () {
        expect(AppTheme.parseHexColor('#FF0000'), const Color(0xFFFF0000));
        expect(AppTheme.parseHexColor('00FF00'), const Color(0xFF00FF00));
        expect(AppTheme.parseHexColor('#CC1565C0'), const Color(0xCC1565C0));
        expect(AppTheme.parseHexColor(''), isNull);
        expect(AppTheme.parseHexColor('   '), isNull);
        expect(AppTheme.parseHexColor('nothex'), isNull);
        expect(AppTheme.parseHexColor('#12345'), isNull); // wrong length
      },
    );
  });
}
