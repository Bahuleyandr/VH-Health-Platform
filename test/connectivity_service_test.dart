import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/connectivity_service.dart';

void main() {
  group('ConnectivityService', () {
    test('isOnline defaults to true', () {
      expect(ConnectivityService.isOnline, isTrue);
    });

    test('onChange returns a broadcast stream', () {
      final stream = ConnectivityService.onChange;
      expect(stream, isNotNull);
      expect(stream.isBroadcast, isTrue);
    });

    test('stopMonitoring does not throw when not started', () {
      expect(() => ConnectivityService.stopMonitoring(), returnsNormally);
    });

    test('startMonitoring then stopMonitoring is idempotent', () {
      // Should not throw or leak timers
      ConnectivityService.startMonitoring();
      ConnectivityService.stopMonitoring();
      ConnectivityService.stopMonitoring(); // double-stop is safe
    });
  });
}
