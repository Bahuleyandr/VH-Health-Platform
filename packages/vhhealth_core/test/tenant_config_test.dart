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

    test('parseHexColor handles #RRGGBB, RRGGBB, #AARRGGBB; null on empty/invalid', () {
      expect(AppTheme.parseHexColor('#FF0000'), const Color(0xFFFF0000));
      expect(AppTheme.parseHexColor('00FF00'), const Color(0xFF00FF00));
      expect(AppTheme.parseHexColor('#CC1565C0'), const Color(0xCC1565C0));
      expect(AppTheme.parseHexColor(''), isNull);
      expect(AppTheme.parseHexColor('   '), isNull);
      expect(AppTheme.parseHexColor('nothex'), isNull);
      expect(AppTheme.parseHexColor('#12345'), isNull); // wrong length
    });
  });
}
