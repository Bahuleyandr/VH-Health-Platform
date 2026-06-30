import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';

void main() {
  group('dispositionForStatus', () {
    test('2xx → success', () {
      for (final s in [200, 201, 202, 204, 299]) {
        expect(
          dispositionForStatus(s),
          SyncDisposition.success,
          reason: 'status $s',
        );
      }
    });

    test('definitive client rejections → conflict (400/403/409/422)', () {
      for (final s in [400, 403, 409, 422]) {
        expect(
          dispositionForStatus(s),
          SyncDisposition.conflict,
          reason: 'status $s',
        );
      }
    });

    test('transient / auth / server errors → retry (401/404/408/429/5xx)', () {
      for (final s in [401, 404, 408, 429, 500, 502, 503]) {
        expect(
          dispositionForStatus(s),
          SyncDisposition.retry,
          reason: 'status $s',
        );
      }
    });
  });
}
